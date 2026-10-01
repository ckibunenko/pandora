// Runs against an explicitly selected disposable demo Compose project. Never the user demo.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBrowser, checkRunner } from "./cdp.mjs";

const project = process.env.DEMO_COMPOSE_PROJECT;
assert.match(project ?? "", /^pandora-demo-qa-[a-z0-9-]+$/);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const base = `http://127.0.0.1:${process.env.DEMO_PORT}`;
const evidence = process.env.DEMO_CHECK_EVIDENCE ?? "/tmp/pandora-demo-reset-evidence";
const runner = checkRunner();

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}
const compose = (...args) => run("docker", ["compose", "--env-file", ".env.demo", "-f", "compose.demo.yml", "-p", project, ...args]);
async function sql(statement) {
  const result = await compose("exec", "-T", "postgres", "psql", "-U", "pandora_demo", "-d", "pandora_demo", "-v", "ON_ERROR_STOP=1", "-At", "-c", statement);
  assert.equal(result.code, 0, result.output);
  return result.output.trim();
}
const reset = () => run(process.execPath, ["--env-file=.env.demo", "scripts/demo-reset.mjs"]);
const page = await startBrowser({ base, evidence, port: 9346 });
let actor;
let injected = false;
try {
  await runner.check("isolated stack exposes only the web port and the loopback inbox UI; the worker runs; retailer can sign in", async () => {
    const result = await compose("ps", "--format", "json");
    assert.equal(result.code, 0);
    const services = result.output.trim().split("\n").map((line) => JSON.parse(line));
    for (const service of services.filter((item) => item.Service !== "web" && item.Service !== "mailpit")) {
      assert.ok((service.Publishers ?? []).every((port) => !port.PublishedPort));
    }
    const inbox = services.find((item) => item.Service === "mailpit");
    assert.ok(inbox?.Publishers.filter((port) => port.PublishedPort).every((port) => port.URL === "127.0.0.1" && port.TargetPort === 8025));
    assert.equal(services.find((item) => item.Service === "worker")?.State, "running");
    await page.login("retailer@tabletop-lantern.test", process.env.DEMO_USER_PASSWORD);
    await page.screenshot("catalog-before-reset");
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@pandora.test", password: process.env.DEMO_USER_PASSWORD }),
    });
    assert.equal(response.status, 200);
    actor = { cookie: response.headers.get("set-cookie").split(";")[0], csrf: (await response.json()).csrfToken };
    const created = await fetch(`${base}/api/admin/organizations`, { method: "POST", headers: { Cookie: actor.cookie, "X-CSRF-Token": actor.csrf, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Reset Browser Temporary Store" }) });
    assert.equal(created.status, 201);
  });
  await runner.check("an existing operator lock rejects another reset without interrupting the API", async () => {
    assert.equal((await compose("exec", "-T", "web", "mkdir", "/maintenance/reset-lock")).code, 0);
    try {
      const result = await reset();
      assert.notEqual(result.code, 0);
      assert.match(result.output, /Could not acquire/);
      assert.equal((await fetch(`${base}/api/health/ready`)).status, 200);
    } finally { assert.equal((await compose("exec", "-T", "web", "rmdir", "/maintenance/reset-lock")).code, 0); }
  });
  await runner.check("failed restoration preserves data and keeps maintenance active with the API stopped", async () => {
    await sql("CREATE FUNCTION qa_fail_demo_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA seed failure'; END $$; CREATE TRIGGER qa_fail_demo_seed BEFORE INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION qa_fail_demo_seed();");
    injected = true;
    const result = await reset();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /maintenance remains enabled/);
    const stopped = await compose("ps", "--status", "running", "-q", "api", "worker");
    assert.equal(stopped.output.trim(), "", "API and notification worker stay stopped");
    assert.equal(await sql("SELECT count(*) FROM organizations WHERE name = 'Reset Browser Temporary Store'"), "1");
    const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, "MAINTENANCE");
    assert.equal(body.correlation_id, response.headers.get("x-correlation-id"));
    assert.equal(response.headers.get("retry-after"), "30");
  });
  await runner.check("maintenance page is readable at desktop/mobile widths and survives proxy restart", async () => {
    assert.equal((await fetch(base)).status, 503);
    await page.navigate("/");
    assert.equal(await page.text("h1"), "The demo is being restored.");
    await page.screenshot("maintenance-desktop");
    await page.setWidth(390);
    assert.ok(await page.noHorizontalOverflow());
    await page.pressTab();
    assert.equal(await page.evaluate("document.activeElement.textContent"), "Try again");
    await page.screenshot("maintenance-mobile");
    assert.equal((await compose("restart", "web")).code, 0);
    assert.equal((await fetch(`${base}/api/health/ready`)).status, 503);
  });
  await runner.check("retry restores fixtures, revokes old cookies, and allows a fresh browser login", async () => {
    await sql("DROP TRIGGER qa_fail_demo_seed ON organizations; DROP FUNCTION qa_fail_demo_seed();");
    injected = false;
    const result = await reset();
    assert.equal(result.code, 0, result.output);
    assert.equal((await fetch(`${base}/api/auth/session`, { headers: { Cookie: actor.cookie } })).status, 401);
    assert.equal(await sql("SELECT count(*) FROM organizations WHERE name = 'Reset Browser Temporary Store'"), "0");
    assert.equal(await sql("SELECT count(*) FROM orders"), "9");
    assert.equal(await sql("SELECT count(*) FROM notification_jobs"), "0");
    assert.equal((await compose("ps", "--status", "running", "-q", "worker")).output.trim() !== "", true, "worker restarted");
    // A business event after the reset reaches the demo's own captured inbox through the restarted worker.
    const inbox = `http://127.0.0.1:${process.env.DEMO_MAIL_PORT}/api/v1`;
    await fetch(`${inbox}/messages`, { method: "DELETE" });
    const signIn = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "retailer@tabletop-lantern.test", password: process.env.DEMO_USER_PASSWORD }),
    });
    const retailer = { cookie: signIn.headers.get("set-cookie").split(";")[0], csrf: (await signIn.json()).csrfToken };
    const headers = { Cookie: retailer.cookie, "X-CSRF-Token": retailer.csrf, "Content-Type": "application/json" };
    const draftId = await sql("SELECT id FROM orders WHERE number = 'PO-000001'");
    const draft = await (await fetch(`${base}/api/orders/${draftId}`, { headers })).json();
    const submitted = await fetch(`${base}/api/orders/${draftId}/submit`, {
      method: "POST", headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ version: draft.version, reviewedPrices: draft.lines.map((l) => ({ variantId: l.variantId, unitPriceMinor: l.unitPriceMinor })) }),
    });
    assert.equal(submitted.status, 200);
    let delivered = [];
    for (let i = 0; i < 60 && delivered.length < 2; i += 1) {
      delivered = (await (await fetch(`${inbox}/messages`)).json()).messages;
      if (delivered.length < 2) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.deepEqual(delivered.map((message) => message.To[0].Address).sort(), ["admin@pandora.test", "operator@pandora.test"]);
    assert.ok(delivered.every((message) => message.Subject === "PO-000001 submitted by Tabletop Lantern"));
    await page.setWidth(1280);
    await page.login("retailer@tabletop-lantern.test", process.env.DEMO_USER_PASSWORD);
    assert.ok(await page.noHorizontalOverflow());
    await page.screenshot("catalog-after-reset");
    assert.deepEqual(page.pageErrors, []);
  });
  console.log(`${runner.passed} demo lifecycle/browser check groups passed. Evidence: ${evidence}`);
} finally {
  if (injected) await sql("DROP TRIGGER qa_fail_demo_seed ON organizations; DROP FUNCTION qa_fail_demo_seed();");
  page.close();
}
