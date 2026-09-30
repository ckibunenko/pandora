// Minimal Chrome DevTools protocol driver shared by the browser checks (no extra dependencies).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export { sleep };

export async function startBrowser({ base, evidence, port }) {
  const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  mkdirSync(evidence, { recursive: true });
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${mkdtempSync(join(tmpdir(), "pandora-cdp-"))}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let target;
  for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = targets.find((entry) => entry.type === "page");
    } catch {
      await sleep(200);
    }
  }
  assert.ok(target, "Chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve));

  let nextId = 1;
  const pending = new Map();
  const pageErrors = [];
  const pausedHandlers = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
    if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.text);
    if (message.method === "Fetch.requestPaused") for (const handler of pausedHandlers) handler(message.params);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
  const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;

  const page = {
    send,
    evaluate,
    q,
    pageErrors,
    pausedHandlers,
    async waitFor(expression, label, timeout = 8000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await evaluate(expression)) return;
        await sleep(100);
      }
      throw new Error(`Timed out waiting for: ${label}`);
    },
    text: (selector) => evaluate(`${q(selector)}?.textContent?.trim() ?? null`),
    count: (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
    click: (selector) => evaluate(`${q(selector)}.click()`),
    async fill(selector, value) {
      await evaluate(`(() => {
        const el = ${q(selector)};
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      })()`);
    },
    async navigate(path) {
      await evaluate("window.__oldDocument = true");
      await send("Page.navigate", { url: `${base}${path}` });
      await page.waitFor("!window.__oldDocument && document.readyState === 'complete'", `navigation to ${path}`);
    },
    async screenshot(name) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidence, `${name}.png`), Buffer.from(data, "base64"));
    },
    async setWidth(width) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    },
    async pressTab() {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    },
    noHorizontalOverflow: () => evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"),
    async login(email, password) {
      await page.navigate("/login");
      await page.waitFor(`!!${q("[data-test=login-email]")}`, "login form");
      await page.fill("[data-test=login-email]", email);
      await page.fill("[data-test=login-password]", password);
      await page.click("[data-test=login-submit]");
      await page.waitFor(`location.pathname !== "/login" && !!${q("[data-test=logout-button]")}`, `signed in as ${email}`);
    },
    async logout() {
      await page.click("[data-test=logout-button]");
      await page.waitFor(`location.pathname === "/login" && !!${q("[data-test=login-email]")}`, "signed out");
    },
    close() {
      ws.close();
      chrome.kill();
    },
  };
  await send("Page.enable");
  await send("Runtime.enable");
  return page;
}

export function checkRunner() {
  let passed = 0;
  return {
    async check(label, operation) {
      await operation();
      passed += 1;
      console.log(`PASS ${label}`);
    },
    get passed() {
      return passed;
    },
  };
}
