// Runs every application check against fresh, disposable QA databases: API/PostgreSQL suites and CDP browser suites.
// Usage: pnpm check:all [--api] [--browser] [--skip-build] [--only <name>] [--evidence <dir>]
// Databases are created on the DATABASE_URL server, kept as evidence, and never dropped.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openServer } from "./lib/databases.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const apiDir = join(root, "apps/api");

const { values: options } = parseArgs({
  options: {
    api: { type: "boolean", default: false },
    browser: { type: "boolean", default: false },
    "skip-build": { type: "boolean", default: false },
    only: { type: "string", multiple: true },
    evidence: { type: "string" },
  },
});
const runApi = options.api || !options.browser;
const runBrowser = options.browser || !options.api;
const runId = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
const evidence = options.evidence ?? join(tmpdir(), `pandora-check-evidence-${runId}`);
const selected = (name) => !options.only || options.only.includes(name);

const API_SUITES = [
  { name: "catalog", script: "check:catalog", databaseEnv: "CATALOG_CHECK_DATABASE", prefix: "pandora_catalog_check" },
  { name: "inventory", script: "check:inventory", databaseEnv: "INVENTORY_CHECK_DATABASE", prefix: "pandora_inventory_check" },
  { name: "orders", script: "check:orders", databaseEnv: "ORDERS_CHECK_DATABASE", prefix: "pandora_orders_check" },
  { name: "processing", script: "check:processing", databaseEnv: "PROCESSING_CHECK_DATABASE", prefix: "pandora_processing_check" },
  { name: "fulfillment", script: "check:fulfillment", databaseEnv: "FULFILLMENT_CHECK_DATABASE", prefix: "pandora_fulfillment_check" },
  { name: "admin", script: "check:admin", databaseEnv: "ADMIN_CHECK_DATABASE", prefix: "pandora_admin_check" },
  { name: "demo-reset", script: "check:demo-reset", databaseEnv: "DEMO_CHECK_DATABASE", prefix: "pandora_demo_check" },
  { name: "auth", script: "check:auth", databaseEnv: "AUTH_CHECK_DATABASE", prefix: "pandora_auth_check" },
  { name: "bug-lab", script: "check:bug-lab", runEnv: "BUG_LAB_CHECK_RUN", prefix: "pandora_buglab_check" },
];
// Suites in one group share a seeded database; suites that change the same seed orders are in separate groups.
const BROWSER_GROUPS = [
  { name: "fulfillment", suites: [{ file: "fulfillment-browser", evidenceEnv: "FULFILLMENT_CHECK_EVIDENCE" }] },
  {
    name: "processing",
    suites: [
      { file: "order-processing-browser", evidenceEnv: "PROCESSING_CHECK_EVIDENCE" },
      { file: "inventory-browser", evidenceEnv: "INVENTORY_CHECK_EVIDENCE" },
    ],
  },
  { name: "orders", suites: [{ file: "orders-browser", evidenceEnv: "ORDERS_CHECK_EVIDENCE" }] },
  { name: "admin", suites: [{ file: "admin-browser", evidenceEnv: "ADMIN_CHECK_EVIDENCE" }] },
  // Locks a seeded account for 15 minutes, so it gets its own database.
  { name: "auth", suites: [{ file: "auth-browser", evidenceEnv: "AUTH_CHECK_EVIDENCE" }] },
];
const NOT_RUN = [
  "catalog-browser: needs an external Playwright install (not a project dependency)",
  "demo-reset-browser: needs the Docker demo stack (see context/features/demo-reset-verification.md)",
];
const QA_API_PORT = 3013;
const QA_WEB_PORT = 5175;

for (const name of ["DATABASE_URL", "SEED_USER_PASSWORD"]) {
  if (!process.env[name]) throw new Error(`${name} must be set (copy .env.example to .env, or set it in CI).`);
}

const SUITE_TIMEOUT_MS = Number(process.env.CHECK_SUITE_TIMEOUT_SECONDS ?? 300) * 1000;
const activeGroups = new Set();
const killGroup = (pid) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
};
// Suites run in their own process group (they start Chrome and API servers); stop them all on Ctrl-C.
process.on("SIGINT", () => {
  for (const pid of activeGroups) killGroup(pid);
  process.exit(130);
});

/** A suite that hangs is killed together with its children after `timeoutMs` and counts as failed. */
function run(command, args, { cwd = root, env = {}, quiet = false, timeoutMs = SUITE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: quiet ? "ignore" : "inherit", detached: true });
    activeGroups.add(child.pid);
    const timer = setTimeout(() => {
      console.error(`Timed out after ${timeoutMs / 1000}s: ${command} ${args.join(" ")}`);
      killGroup(child.pid);
    }, timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      activeGroups.delete(child.pid);
      resolve(code);
    };
    child.on("exit", (code) => finish(code ?? 1));
    child.on("error", () => finish(1));
  });
}

/** Starts a long-running process in its own process group so that it and its children can be stopped together. */
function background(command, args, { cwd, env, log }) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  activeGroups.add(child.pid);
  child.once("exit", () => activeGroups.delete(child.pid));
  child.stdout.on("data", (data) => log.push(String(data)));
  child.stderr.on("data", (data) => log.push(String(data)));
  return {
    child,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await Promise.race([exited, sleep(5000)]);
    },
  };
}

async function isUp(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** Any HTTP response, even an error status, means something is listening. */
async function isReachable(url) {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilUp(url, label, child, log) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} exited during startup:\n${log.join("").slice(-3000)}`);
    if (await isUp(url)) return;
    await sleep(200);
  }
  throw new Error(`${label} did not become ready at ${url}.`);
}

let server;
async function createDatabase(name) {
  server ??= await openServer(process.env.DATABASE_URL);
  return server.create(name);
}

const results = [];
async function record(suite, databaseName, work) {
  const started = Date.now();
  console.log(`\n=== ${suite} (${databaseName})`);
  let ok = false;
  try {
    ok = await work();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  results.push({ suite, ok, database: databaseName, seconds: Math.round((Date.now() - started) / 1000) });
}

async function runApiSuites() {
  for (const suite of API_SUITES.filter((s) => selected(s.name))) {
    const name = `${suite.prefix}_${runId}`;
    await record(`api:${suite.name}`, suite.databaseEnv ? name : `${name}_*`, async () => {
      // Suites that prepare several databases themselves (Bug Lab) get only the run ID.
      const env = suite.databaseEnv ? { [suite.databaseEnv]: name } : { [suite.runEnv]: runId };
      if (suite.databaseEnv) await createDatabase(name);
      return (await run("pnpm", ["--filter", "@pandora/api", suite.script], { env })) === 0;
    });
  }
}

async function runBrowserGroups() {
  const groups = BROWSER_GROUPS.filter((g) => selected(g.name));
  if (!groups.length) return;
  // Check IPv4 and IPv6: a leftover dev server may listen on only one of them and silently serve the checks.
  for (const port of [QA_API_PORT, QA_WEB_PORT]) {
    for (const host of ["127.0.0.1", "[::1]"]) {
      if (await isReachable(`http://${host}:${port}/`)) throw new Error(`Port ${port} is already in use; stop the other QA stack first.`);
    }
  }
  const webLog = [];
  const web = background("pnpm", ["--filter", "@pandora/web", "dev", "--port", String(QA_WEB_PORT), "--strictPort"], {
    cwd: root,
    env: { API_PORT: String(QA_API_PORT) },
    log: webLog,
  });
  try {
    await waitUntilUp(`http://localhost:${QA_WEB_PORT}/`, "QA web server", web.child, webLog);
    for (const group of groups) {
      const name = `pandora_browser_check_${group.name}_${runId}`;
      const qaEnv = { NODE_ENV: "test", API_PORT: String(QA_API_PORT) };
      await record(`browser:${group.name}`, name, async () => {
        const url = await createDatabase(name);
        const env = { ...qaEnv, DATABASE_URL: url };
        if ((await run("pnpm", ["exec", "prisma", "migrate", "deploy"], { cwd: apiDir, env, quiet: true })) !== 0) return false;
        if ((await run(process.execPath, ["dist/seed/seed.js"], { cwd: apiDir, env, quiet: true })) !== 0) return false;
        const apiLog = [];
        const api = background(process.execPath, ["dist/main.js"], { cwd: apiDir, env, log: apiLog });
        try {
          await waitUntilUp(`http://127.0.0.1:${QA_API_PORT}/api/health/ready`, "QA API", api.child, apiLog);
          let ok = true;
          for (const suite of group.suites) {
            const env = { [suite.evidenceEnv]: join(evidence, suite.file) };
            const code = await run(process.execPath, [`apps/web/checks/${suite.file}.mjs`], { env });
            if (code !== 0) {
              console.error(`${suite.file} failed.`);
              ok = false;
            }
          }
          return ok;
        } finally {
          await api.stop();
        }
      });
    }
  } finally {
    await web.stop();
  }
}

mkdirSync(evidence, { recursive: true });
let exitCode = 0;
try {
  // A local .env sets NODE_ENV=development; a build always uses production.
  if (!options["skip-build"] && (await run("pnpm", ["build"], { env: { NODE_ENV: "production" }, timeoutMs: 10 * 60 * 1000 })) !== 0) throw new Error("Build failed.");
  if (runApi) await runApiSuites();
  if (runBrowser) await runBrowserGroups();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  await server?.close();
}

console.log("\nSummary");
for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.suite.padEnd(22)} ${String(result.seconds).padStart(4)}s  ${result.database}`);
}
if (runBrowser && !options.only) for (const reason of NOT_RUN) console.log(`SKIP  ${reason}`);
console.log(`Screenshots: ${evidence}`);
if (results.some((result) => !result.ok) || results.length === 0) exitCode = 1;
process.exit(exitCode);
