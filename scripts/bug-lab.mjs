// Bug Lab tooling (overview §9). Prepares an isolated database with one defect, or none for Standard comparison,
// and starts the app against it. It never touches the development or demo database.
//
//   pnpm bug-lab setup --defect BUG-001|BUG-002|BUG-003|none [--suffix <name>]
//   pnpm bug-lab start --run <run id> [--api-port 3020] [--web-port 5176] [--smtp-url smtp://127.0.0.1:1026]
//   The notification worker delivers to the separate Bug Lab inbox: docker compose --profile bug-lab up -d mailpit-buglab
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openServer } from "./lib/databases.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const apiDir = join(root, "apps/api");
const runsDir = join(root, "bug-lab/runs");
const DEFECTS = ["BUG-001", "BUG-002", "BUG-003"];

const [command, ...rest] = process.argv.slice(2);
const { values: options } = parseArgs({
  args: rest,
  options: {
    defect: { type: "string" },
    suffix: { type: "string" },
    run: { type: "string" },
    "api-port": { type: "string", default: "3020" },
    "web-port": { type: "string", default: "5176" },
    "smtp-url": { type: "string", default: "smtp://127.0.0.1:1026" },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}
for (const name of ["DATABASE_URL", "SEED_USER_PASSWORD"]) {
  if (!process.env[name]) fail(`${name} must be set (copy .env.example to .env).`);
}

function step(label, file, args, env, cwd = apiDir) {
  try {
    execFileSync(file, args, { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
  } catch (error) {
    fail(`${label} failed:\n${String(error.stderr ?? error.message).slice(-2000)}`);
  }
}

/** Hash of the seed and scenario sources, so a run can be tied to the exact fixture data. */
function seedVersion() {
  const dir = join(apiDir, "src/seed");
  const hash = createHash("sha256");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) hash.update(file).update(readFileSync(join(dir, file)));
  return hash.digest("hex").slice(0, 16);
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

async function setup() {
  const defect = options.defect;
  if (defect !== "none" && !DEFECTS.includes(defect)) fail(`--defect must be exactly one of ${DEFECTS.join(", ")} or none.`);
  if (options.suffix && !/^[a-z0-9_]{1,40}$/.test(options.suffix)) fail("--suffix may contain only a-z, 0-9, and _.");
  const runId = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  const label = defect === "none" ? "standard" : defect.toLowerCase().replace("-", "");
  const database = `pandora_buglab_${label}_${options.suffix ?? runId}`;

  const server = await openServer(process.env.DATABASE_URL);
  try {
    const url = await server.create(database);
    const env = { DATABASE_URL: url, NODE_ENV: "development" };
    step("Migration", "pnpm", ["exec", "prisma", "migrate", "deploy"], env);
    step("Seed", process.execPath, ["dist/seed/seed.js"], env);
    step("Scenario fixtures", process.execPath, ["dist/seed/bug-lab-scenario.js"], env);
    if (defect !== "none") await server.markDefect(database, defect);
  } finally {
    await server.close();
  }

  const manifest = {
    runId: `${runId}_${label}`,
    defect: defect === "none" ? null : defect,
    mode: defect === "none" ? "standard" : "bug_lab",
    database,
    appVersion: { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--untracked-files=no") !== "" },
    seedVersion: seedVersion(),
    latestMigration: readdirSync(join(root, "prisma/migrations")).filter((f) => /^\d/.test(f)).sort().at(-1),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(runsDir, { recursive: true });
  const file = join(runsDir, `${manifest.runId}.json`);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared ${manifest.mode === "standard" ? "a Standard comparison" : defect} database ${database}.`);
  console.log(`Manifest: bug-lab/runs/${manifest.runId}.json`);
  console.log(`Start it with: pnpm bug-lab start --run ${manifest.runId}`);
  // Machine-readable line for checks.
  console.log(`BUG_LAB_SETUP ${JSON.stringify(manifest)}`);
}

function start() {
  if (!options.run || !/^[a-z0-9_]+$/.test(options.run)) fail("--run <run id> is required (see bug-lab/runs/).");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(runsDir, `${options.run}.json`), "utf8"));
  } catch {
    fail(`No manifest bug-lab/runs/${options.run}.json; run pnpm bug-lab setup first.`);
  }
  const server = new URL(process.env.DATABASE_URL);
  server.pathname = `/${manifest.database}`;
  const apiEnv = {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: server.toString(),
    API_PORT: options["api-port"],
    ...(manifest.defect ? { BUG_LAB_DEFECT: manifest.defect } : {}),
  };
  if (!manifest.defect) delete apiEnv.BUG_LAB_DEFECT;
  const api = spawn(process.execPath, ["dist/main.js"], { cwd: apiDir, env: apiEnv, stdio: "inherit" });
  // Same defect selection and database as the API, so it refuses the same configurations; its own inbox (overview §9).
  const worker = spawn(process.execPath, ["dist/worker.js"], {
    cwd: apiDir,
    env: { ...apiEnv, NOTIFICATION_SMTP_URL: options["smtp-url"] },
    stdio: "inherit",
  });
  // pnpm starts vite as its own child, so the web server runs in its own process group and is stopped as a group.
  const web = spawn("pnpm", ["--filter", "@pandora/web", "dev", "--port", options["web-port"], "--strictPort"], {
    cwd: root,
    env: { ...process.env, API_PORT: options["api-port"] },
    stdio: "inherit",
    detached: true,
  });
  const stopWeb = () => {
    try {
      process.kill(-web.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  };
  console.log(`${manifest.mode === "standard" ? "Standard comparison" : "Bug Lab"} run ${manifest.runId}: http://localhost:${options["web-port"]}`);
  console.log(`Notifications go to ${options["smtp-url"]} (Bug Lab inbox UI: http://localhost:8026 when mailpit-buglab runs).`);
  const stop = () => {
    api.kill("SIGTERM");
    worker.kill("SIGTERM");
    stopWeb();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  api.on("exit", (code) => {
    if (code) console.error(`The API exited with code ${code}.`);
    worker.kill("SIGTERM");
    stopWeb();
  });
  worker.on("exit", (code) => {
    if (code) console.error(`The notification worker exited with code ${code}.`);
  });
}

if (command === "setup") await setup();
else if (command === "start") start();
else fail("Usage: pnpm bug-lab setup --defect BUG-001|BUG-002|BUG-003|none [--suffix <name>]\n       pnpm bug-lab start --run <run id>");
