// Runs against an explicitly selected disposable demo Compose project. Never the user demo.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBrowser, checkRunner } from "./cdp.mjs";

const project = process.env.DEMO_COMPOSE_PROJECT;
assert.match(project ?? "", /^pandora-demo-qa-[a-z0-9-]+$/);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const httpPort = process.env.DEMO_PORT ?? "5180";
const httpsPort = process.env.DEMO_HTTPS_PORT ?? "5443";
const base = `https://localhost:${httpsPort}`;
const inbox = `${base}/mail/api/v1`;
// The QA stack serves HTTPS with Caddy's internal (private) CA; trust it only inside this check process and browser.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
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
const page = await startBrowser({ base, evidence, port: 9346, ignoreCertificateErrors: true });

const inboxMessages = async () => (await (await fetch(`${inbox}/messages`)).json()).messages;
async function waitForInbox(count) {
  let messages = [];
  for (let i = 0; i < 60 && messages.length < count; i += 1) {
    messages = await inboxMessages();
    if (messages.length < count) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return messages;
}
/** The retailer submits the seeded draft PO-000001, which notifies both staff members. */
async function submitSeedDraft() {
  const signIn = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "retailer@tabletop-lantern.test", password: process.env.DEMO_USER_PASSWORD }),
  });
  assert.equal(signIn.status, 200);
  const retailer = { cookie: signIn.headers.get("set-cookie").split(";")[0], csrf: (await signIn.json()).csrfToken };
  const headers = { Cookie: retailer.cookie, "X-CSRF-Token": retailer.csrf, "Content-Type": "application/json" };
  const draftId = await sql("SELECT id FROM orders WHERE number = 'PO-000001'");
  const draft = await (await fetch(`${base}/api/orders/${draftId}`, { headers })).json();
  const submitted = await fetch(`${base}/api/orders/${draftId}/submit`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ version: draft.version, reviewedPrices: draft.lines.map((l) => ({ variantId: l.variantId, unitPriceMinor: l.unitPriceMinor })) }),
  });
  assert.equal(submitted.status, 200);
}
let actor;
let injected = false;
try {
  await runner.check("only Caddy is published on loopback; HTTP redirects to HTTPS; security headers; the worker runs; retailer can sign in", async () => {
    const result = await compose("ps", "--format", "json");
    assert.equal(result.code, 0);
    const services = result.output.trim().split("\n").map((line) => JSON.parse(line));
    for (const service of services.filter((item) => item.Service !== "caddy")) {
      assert.ok((service.Publishers ?? []).every((port) => !port.PublishedPort), `${service.Service} must not be published`);
    }
    const published = services.find((item) => item.Service === "caddy").Publishers.filter((port) => port.PublishedPort);
    assert.ok(published.every((port) => port.URL === "127.0.0.1"));
    assert.deepEqual([...new Set(published.map((port) => String(port.PublishedPort)))].sort(), [httpPort, httpsPort].sort());
    assert.equal(services.find((item) => item.Service === "worker")?.State, "running");
    const redirect = await fetch(`http://localhost:${httpPort}/catalog`, { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), `https://localhost:${httpsPort}/catalog`);
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.deepEqual(
      ["x-content-type-options", "referrer-policy", "x-frame-options", "strict-transport-security", "server"].map((name) => home.headers.get(name)),
      ["nosniff", "no-referrer", "DENY", "max-age=0", null],
    );
    await page.login("retailer@tabletop-lantern.test", process.env.DEMO_USER_PASSWORD);
    await page.screenshot("catalog-before-reset");
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@pandora.test", password: process.env.DEMO_USER_PASSWORD }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /; Secure/);
    assert.match(response.headers.get("set-cookie"), /; HttpOnly/);
    assert.match(response.headers.get("set-cookie"), /; SameSite=Lax/);
    actor = { cookie: response.headers.get("set-cookie").split(";")[0], csrf: (await response.json()).csrfToken };
    const created = await fetch(`${base}/api/admin/organizations`, { method: "POST", headers: { Cookie: actor.cookie, "X-CSRF-Token": actor.csrf, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Reset Browser Temporary Store" }) });
    assert.equal(created.status, 201);
  });
  await runner.check("the public inbox at /mail/ shows delivered emails and refuses every change", async () => {
    await submitSeedDraft();
    const messages = await waitForInbox(2);
    assert.deepEqual(messages.map((message) => message.To[0].Address).sort(), ["admin@pandora.test", "operator@pandora.test"]);
    assert.equal((await fetch(`${base}/mail/`)).status, 200);
    for (const [method, path] of [["DELETE", "/messages"], ["PUT", "/messages"], ["POST", "/send"], ["DELETE", `/message/${messages[0].ID}`]]) {
      const refused = await fetch(`${inbox}${path}`, { method, headers: { "Content-Type": "application/json" }, body: method === "DELETE" ? undefined : "{}" });
      assert.equal(refused.status, 405, `${method} ${path}`);
      assert.equal(await refused.text(), "The demo inbox is read-only.");
    }
    assert.equal((await inboxMessages()).length, 2, "nothing was deleted");
    await page.navigate("/mail/");
    await page.waitFor(`document.body.innerText.includes("PO-000001 submitted by Tabletop Lantern")`, "inbox UI lists the email");
    await page.screenshot("public-inbox");
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
    // The reset empties the inbox too; a business event afterwards reaches it through the restarted worker.
    assert.equal((await inboxMessages()).length, 0, "emails about removed orders are gone");
    await submitSeedDraft();
    const delivered = await waitForInbox(2);
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
