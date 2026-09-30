// Browser checks for inventory, driven through the Chrome DevTools protocol (no extra dependencies).
// Requires a freshly seeded QA API and web server; see context/features/inventory-verification.md.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.INVENTORY_BROWSER_URL ?? "http://localhost:5175";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EVIDENCE = process.env.INVENTORY_CHECK_EVIDENCE ?? join(tmpdir(), "pandora-inventory-evidence");
const PASSWORD = process.env.SEED_USER_PASSWORD;
const PORT = Number(process.env.INVENTORY_CDP_PORT ?? 9334);
assert.ok(PASSWORD, "SEED_USER_PASSWORD must be set (run with --env-file=.env).");
mkdirSync(EVIDENCE, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "pandora-inventory-cdp-"))}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let target;
for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
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
async function waitFor(expression, label, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const text = (selector) => evaluate(`${q(selector)}?.textContent?.trim() ?? null`);
const count = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
async function fill(selector, value) {
  await evaluate(`(() => {
    const el = ${q(selector)};
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  })()`);
}
const click = (selector) => evaluate(`${q(selector)}.click()`);
async function navigate(path) {
  await evaluate("window.__oldDocument = true");
  await send("Page.navigate", { url: `${BASE}${path}` });
  await waitFor("!window.__oldDocument && document.readyState === 'complete'", `navigation to ${path}`);
}
async function screenshot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(EVIDENCE, `${name}.png`), Buffer.from(data, "base64"));
}
async function setWidth(width) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
}
async function login(email) {
  await navigate("/login");
  await waitFor(`!!${q("[data-test=login-email]")}`, "login form");
  await fill("[data-test=login-email]", email);
  await fill("[data-test=login-password]", PASSWORD);
  await click("[data-test=login-submit]");
  await waitFor(`location.pathname !== "/login" && !!${q("[data-test=logout-button]")}`, `signed in as ${email}`);
}
async function logout() {
  await click("[data-test=logout-button]");
  await waitFor(`location.pathname === "/login" && !!${q("[data-test=login-email]")}`, "signed out");
}
const noHorizontalOverflow = () => evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth");

let passed = 0;
async function check(label, operation) {
  await operation();
  passed += 1;
  console.log(`PASS ${label}`);
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await setWidth(1280);

  await check("operator reaches inventory from navigation; list shows seeded stock", async () => {
    await login("operator@pandora.test");
    await waitFor(`!!${q("[data-test=inventory-nav]")}`, "inventory nav");
    await click("[data-test=inventory-nav]");
    await waitFor(`location.pathname === "/inventory" && document.querySelectorAll("[data-test=inventory-row]").length === 11`, "11 rows");
    assert.equal(await text("[data-test=inventory-total]"), "11 items");
    const cells = (sku) => evaluate(`[...${q(`[data-test=inventory-row][data-sku="${sku}"]`)}.querySelectorAll("td")].map((td) => td.textContent)`);
    const zero = await cells("CWO-EN-DLX");
    assert.equal(zero[6], "0", "available column");
    const swaGi = await cells("SWA-GI-EN");
    assert.deepEqual(swaGi.slice(3, 7), ["1", "0", "0", "1"], "SWA-GI-EN seed stock");
    await screenshot("inventory-list");
  });

  await check("search and stock filter narrow the list and reset paging", async () => {
    await fill("[data-test=inventory-search]", "saltwind");
    await click("[data-test=inventory-search-submit]");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 2`, "2 Saltwind rows");
    await fill("[data-test=inventory-search]", "");
    await click("[data-test=inventory-search-submit]");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 11`, "search cleared");
    await fill("[data-test=inventory-stock-filter]", "unavailable");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 1 && !!${q('[data-test=inventory-row][data-sku="CWO-EN-DLX"]')}`, "unavailable filter");
    assert.match(await evaluate("location.search"), /stock=unavailable/);
    await fill("[data-test=inventory-stock-filter]", "all");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 11`, "all rows again");
  });

  await check("receipt: client validation, then success updates stock and history", async () => {
    await click('[data-test=inventory-row][data-sku="SWA-GI-EN"] [data-test=inventory-detail-link]');
    await waitFor(`${q("[data-test=inventory-sku]")}?.textContent === "SWA-GI-EN" && !!${q("[data-test=movement-row]")}`, "detail page");
    assert.equal(await text("[data-test=stock-sellable]"), "1");
    const historyBefore = await count("[data-test=movement-row]");
    await fill("[data-test=field-quantity]", "abc");
    await click("[data-test=receipt-submit]");
    await waitFor(`${q("[data-test=field-quantity]")}.getAttribute("aria-invalid") === "true"`, "quantity marked invalid");
    await fill("[data-test=field-quantity]", "4");
    await fill("[data-test=field-reference]", "DN-QA-1");
    await click("[data-test=receipt-submit]");
    await waitFor(`!!${q("[data-test=receipt-success]")}`, "receipt success");
    await waitFor(`${q("[data-test=stock-sellable]")}.textContent === "5"`, "sellable 5");
    await waitFor(`document.querySelectorAll("[data-test=movement-row]").length === ${historyBefore + 1}`, "history row added");
    assert.equal(await evaluate(`${q("[data-test=field-quantity]")}.value`), "", "form cleared after success");
  });

  await check("adjustment: server rejection keeps input and links the error to the field", async () => {
    await fill("[data-test=field-delta]", "-10");
    await fill("[data-test=field-reason]", "Shelf recount");
    await click("[data-test=adjustment-submit]");
    await waitFor(`!!${q("[data-test=adjustment-error]")}`, "adjustment error");
    assert.match(await text("[data-test=adjustment-error]"), /Not enough stock/);
    assert.equal(await evaluate(`${q("[data-test=field-delta]")}.getAttribute("aria-invalid")`), "true");
    assert.equal(await evaluate(`${q("[data-test=field-delta]")}.value`), "-10", "input preserved");
    assert.equal(await evaluate(`${q("[data-test=field-reason]")}.value`), "Shelf recount", "input preserved");
    await fill("[data-test=field-delta]", "-1");
    await click("[data-test=adjustment-submit]");
    await waitFor(`!!${q("[data-test=adjustment-success]")}`, "adjustment success");
    await waitFor(`${q("[data-test=stock-sellable]")}.textContent === "4"`, "sellable 4");
    await screenshot("inventory-detail");
  });

  await check("a lost response is retried with the same key and applied only once", async () => {
    const historyBefore = await count("[data-test=movement-row]");
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/inventory/*/receipts", requestStage: "Response" }] });
    let dropped = false;
    pausedHandlers.push((params) => {
      // The server has already committed this receipt; the browser only loses the response.
      if (!dropped) {
        dropped = true;
        void send("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionReset" });
      } else {
        void send("Fetch.continueRequest", { requestId: params.requestId });
      }
    });
    await fill("[data-test=field-quantity]", "3");
    await click("[data-test=receipt-submit]");
    await waitFor(`!!${q("[data-test=receipt-error]")}`, "lost-response error");
    assert.match(await text("[data-test=receipt-error]"), /retry safely/);
    assert.equal(await evaluate(`${q("[data-test=field-quantity]")}.value`), "3", "input preserved for retry");
    await click("[data-test=receipt-submit]");
    await waitFor(`!!${q("[data-test=receipt-success]")}`, "retry success");
    await send("Fetch.disable");
    pausedHandlers.length = 0;
    await waitFor(`${q("[data-test=stock-sellable]")}.textContent === "7"`, "sellable 4 + 3, applied once");
    await waitFor(`document.querySelectorAll("[data-test=movement-row]").length === ${historyBefore + 1}`, "exactly one new movement");
  });

  await check("keyboard: stock forms are reachable with Tab and show visible focus", async () => {
    await evaluate(`${q("[data-test=field-quantity]")}.focus()`);
    const order = [];
    for (let step = 0; step < 3; step += 1) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      order.push(await evaluate("document.activeElement?.dataset.test ?? document.activeElement?.tagName"));
    }
    assert.deepEqual(order, ["field-reference", "field-note", "receipt-submit"]);
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none");
  });

  await check("narrow layout: list and detail have no horizontal page overflow", async () => {
    await setWidth(390);
    await waitFor(`!!${q("[data-test=stock-available]")}`, "detail at 390px");
    assert.ok(await noHorizontalOverflow(), "detail overflows at 390px");
    await screenshot("inventory-detail-narrow");
    await navigate("/inventory");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 11`, "list at 390px");
    assert.ok(await noHorizontalOverflow(), "list overflows at 390px");
    await setWidth(1280);
    await logout();
  });

  await check("retailer: no inventory access, catalog shows available quantity with the note", async () => {
    await login("retailer@tabletop-lantern.test");
    assert.equal(await count("[data-test=inventory-nav]"), 0);
    await navigate("/inventory");
    await waitFor(`document.body.textContent.includes("Access restricted")`, "restricted message");
    assert.equal(await count("[data-test=inventory-row]"), 0);
    await navigate("/catalog?q=SWA-GI-EN");
    await waitFor(`!!${q("[data-test=product-detail-link]")}`, "catalog result");
    await click("[data-test=product-detail-link]");
    await waitFor(`!!${q("[data-test=variant-select]")}`, "product detail");
    const variantId = await evaluate(`[...${q("[data-test=variant-select]")}.options].find((o) => o.textContent.includes("SWA-GI-EN")).value`);
    await fill("[data-test=variant-select]", variantId);
    await waitFor(`${q("[data-test=variant-available]")}?.textContent === "7"`, "availability 7");
    assert.match(await text("[data-test=availability-note]"), /not reserved until your order is confirmed/);
    await screenshot("catalog-availability");
    await logout();
  });

  await check("administrator also manages inventory; no page errors were thrown", async () => {
    await login("admin@pandora.test");
    await click("[data-test=inventory-nav]");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 11`, "admin list");
    await logout();
    assert.deepEqual(pageErrors, []);
  });

  console.log(`\n${passed} inventory browser check groups passed. Screenshots: ${EVIDENCE}`);
} finally {
  ws.close();
  chrome.kill();
}
