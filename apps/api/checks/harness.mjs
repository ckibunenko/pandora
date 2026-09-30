// Shared setup for API checks: an isolated QA database, a dedicated API process, and HTTP helpers.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { errorEnvelopeSchema } from "@pandora/contracts";
import { PrismaClient } from "../dist/generated/prisma/client.js";

export async function startQaApi({ databaseEnv, databasePattern, portEnv, defaultPort }) {
  const databaseName = process.env[databaseEnv];
  assert.match(databaseName ?? "", databasePattern, `Set ${databaseEnv} to a separate, empty QA database created for this run.`);
  const url = new URL(process.env.DATABASE_URL);
  assert.notEqual(url.pathname.slice(1), databaseName, "QA database must differ from the development database.");
  url.pathname = `/${databaseName}`;
  const port = process.env[portEnv] ?? defaultPort;
  const env = { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: "test", CATALOG_CURRENCY: "EUR", API_PORT: port };
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });

  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  assert.equal(tables.length, 0, "Refusing to modify a nonempty QA database. Create a new database for each run.");
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { env, stdio: "pipe" });
  const seed = () => execFileSync(process.execPath, ["dist/seed/seed.js"], { env, stdio: "pipe" });
  seed();

  const server = spawn(process.execPath, ["dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  server.stdout.on("data", (data) => (logs += data));
  server.stderr.on("data", (data) => (logs += data));
  const origin = `http://127.0.0.1:${port}/api`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`API exited during startup: ${logs}`);
    try {
      if ((await fetch(`${origin}/health/ready`)).ok) break;
    } catch {
      /* readiness polling only */
    }
    await delay(50);
  }

  async function call(path, { actor, method = "GET", body, csrf = true, key } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(actor ? { Cookie: actor.cookie } : {}),
        ...(actor && csrf ? { "X-CSRF-Token": actor.csrf } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(key !== undefined ? { "Idempotency-Key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  async function login(email) {
    const response = await fetch(`${origin}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: process.env.SEED_USER_PASSWORD }),
    });
    assert.equal(response.status, 200, `login ${email}`);
    return { cookie: response.headers.get("set-cookie").split(";")[0], csrf: (await response.json()).csrfToken };
  }

  let passed = 0;
  return {
    db,
    origin,
    seed,
    call,
    login,
    logs: () => logs,
    async check(label, operation) {
      await operation();
      passed += 1;
      console.log(`PASS ${label}`);
    },
    get passed() {
      return passed;
    },
    async stop() {
      server.kill("SIGTERM");
      await db.$disconnect();
    },
  };
}

export function assertError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  errorEnvelopeSchema.parse(result.body);
  assert.equal(result.body.code, code, JSON.stringify(result.body));
}
