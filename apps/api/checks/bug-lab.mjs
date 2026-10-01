// Bug Lab checks (overview §9): configuration isolation, and for each defect the same business assertion
// passing on a Standard database and failing for the intended reason on that defect's Bug Lab database.
// Prepares its own databases with `pnpm bug-lab setup`; see context/features/bug-lab-verification.md.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { errorEnvelopeSchema, orderListResponseSchema, orderSchema } from "@pandora/contracts";
import { PrismaClient } from "../dist/generated/prisma/client.js";

const apiDir = fileURLToPath(new URL("../", import.meta.url));
const root = join(apiDir, "../..");
const runId = process.env.BUG_LAB_CHECK_RUN ?? new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
const PASSWORD = process.env.SEED_USER_PASSWORD;
assert.ok(PASSWORD && process.env.DATABASE_URL, "DATABASE_URL and SEED_USER_PASSWORD must be set.");
const urlFor = (database) => {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
};

let passed = 0;
async function check(label, work) {
  await work();
  passed += 1;
  console.log(`PASS ${label}`);
}

function setup(defect) {
  const output = execFileSync(process.execPath, [join(root, "scripts/bug-lab.mjs"), "setup", "--defect", defect, "--suffix", `check_${runId}`], {
    cwd: root,
    encoding: "utf8",
  });
  const line = output.split("\n").find((l) => l.startsWith("BUG_LAB_SETUP "));
  assert.ok(line, output);
  return JSON.parse(line.slice("BUG_LAB_SETUP ".length));
}

const running = [];
function spawnApi({ database, defect, port, nodeEnv = "test" }) {
  const env = { ...process.env, DATABASE_URL: urlFor(database), API_PORT: String(port), NODE_ENV: nodeEnv, CATALOG_CURRENCY: "EUR" };
  delete env.BUG_LAB_DEFECT;
  if (defect) env.BUG_LAB_DEFECT = defect;
  const child = spawn(process.execPath, ["dist/main.js"], { cwd: apiDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  running.push(child);
  return { child, logs: () => logs };
}
/** Starts an API that must refuse to start; returns its output. */
async function refusedStart(options, pattern) {
  const api = spawnApi(options);
  const code = await new Promise((resolve) => api.child.once("exit", resolve));
  assert.notEqual(code, 0, `API started although it should refuse: ${JSON.stringify(options)}`);
  assert.match(api.logs(), pattern);
}
async function startApi(options) {
  const api = spawnApi(options);
  const origin = `http://127.0.0.1:${options.port}/api`;
  for (let i = 0; i < 150; i += 1) {
    if (api.child.exitCode !== null) throw new Error(`API exited: ${api.logs().slice(-2000)}`);
    try {
      if ((await fetch(`${origin}/health/ready`)).ok) break;
    } catch {
      /* polling */
    }
    await delay(100);
  }
  return { origin, logs: api.logs };
}

async function login(origin, email) {
  const response = await fetch(`${origin}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(response.status, 200, `login ${email}`);
  return { cookie: response.headers.get("set-cookie").split(";")[0], csrf: (await response.json()).csrfToken };
}
async function call(origin, path, { actor, method = "GET", body, csrf = true, key } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(actor ? { Cookie: actor.cookie } : {}),
      ...(actor && csrf ? { "X-CSRF-Token": actor.csrf } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}
async function orderByNumber(origin, actor, number) {
  const list = orderListResponseSchema.parse((await call(origin, "/orders?pageSize=100", { actor })).body);
  const summary = list.items.find((order) => order.number === number);
  assert.ok(summary, `${number} visible`);
  return orderSchema.parse((await call(origin, `/orders/${summary.id}`, { actor })).body);
}

// The same business assertions for Standard and Bug Lab. Each returns what it observed; `holds` is the correct rule.
const ASSERTIONS = {
  /** BUG-001: shipping everything left on a partially shipped order (no cancellations) makes it shipped. */
  async "BUG-001"(origin) {
    const operator = await login(origin, "operator@pandora.test");
    const order = await orderByNumber(origin, operator, "PO-000008");
    assert.equal(order.status, "partially_shipped");
    const items = order.lines.map((line) => ({ orderLineId: line.id, quantity: line.outstandingQuantity }));
    const shipped = await call(origin, `/orders/${order.id}/shipments`, { actor: operator, method: "POST", body: { version: order.version, items }, key: randomUUID() });
    assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
    const after = orderSchema.parse((await call(origin, `/orders/${order.id}`, { actor: operator })).body);
    const outstanding = after.lines.reduce((sum, line) => sum + line.outstandingQuantity, 0);
    return { holds: after.status === "shipped", observed: { status: after.status, outstanding, shipments: after.shipments.length } };
  },
  /** BUG-002: pages of 20 in the default order partition the list exactly (page 2 = rows 21–40). */
  async "BUG-002"(origin) {
    const retailer = await login(origin, "retailer@tabletop-lantern.test");
    const page = async (p, size) => orderListResponseSchema.parse((await call(origin, `/orders?page=${p}&pageSize=${size}`, { actor: retailer })).body);
    const [first, second, all] = [await page(1, 20), await page(2, 20), await page(1, 100)];
    assert.ok(all.total >= 41, `scenario needs at least 41 orders, has ${all.total}`);
    const expected = all.items.slice(20, 40).map((o) => o.number);
    const actual = second.items.map((o) => o.number);
    return {
      holds: JSON.stringify(actual) === JSON.stringify(expected),
      observed: { repeated: actual.filter((n) => first.items.some((o) => o.number === n)), missing: expected.filter((n) => !actual.includes(n)) },
    };
  },
  /** BUG-003: after submission, a later catalog price change does not alter the order's unit prices. */
  async "BUG-003"(origin) {
    const retailer = await login(origin, "retailer@tabletop-lantern.test");
    const admin = await login(origin, "admin@pandora.test");
    const order = await orderByNumber(origin, retailer, "PO-000002");
    const line = order.lines.find((l) => l.sku === "CWO-EN-STD");
    const catalog = (await call(origin, "/catalog/products?q=CWO-EN-STD", { actor: admin })).body;
    const product = catalog.items.find((p) => p.variants.some((v) => v.sku === "CWO-EN-STD"));
    const newPrice = line.unitPriceMinor + 500;
    const patched = await call(origin, `/admin/catalog/products/${product.id}/variants/${line.variantId}`, { actor: admin, method: "PATCH", body: { unitPriceMinor: newPrice } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const reopened = orderSchema.parse((await call(origin, `/orders/${order.id}`, { actor: retailer })).body);
    const after = reopened.lines.find((l) => l.sku === "CWO-EN-STD");
    return {
      holds: after.unitPriceMinor === line.unitPriceMinor && after.lineTotalMinor === line.lineTotalMinor && reopened.totalMinor === order.totalMinor,
      observed: { submitted: line.unitPriceMinor, shown: after.unitPriceMinor, catalog: newPrice, lineTotal: after.lineTotalMinor, orderTotal: reopened.totalMinor },
    };
  },
};

/** Authentication, CSRF, RBAC, and retailer isolation stay correct in every mode. */
async function securityHolds(origin) {
  const expectError = (result, status, code) => {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(errorEnvelopeSchema.parse(result.body).code, code);
  };
  expectError(await call(origin, "/orders"), 401, "UNAUTHENTICATED");
  const lantern = await login(origin, "retailer@tabletop-lantern.test");
  const keep = await login(origin, "retailer@cardboard-keep.test");
  const po2 = await orderByNumber(origin, lantern, "PO-000002");
  expectError(await call(origin, `/orders/${po2.id}`, { actor: keep }), 404, "NOT_FOUND");
  expectError(await call(origin, `/orders/${po2.id}/confirm`, { actor: lantern, method: "POST", body: { version: po2.version }, key: randomUUID() }), 403, "FORBIDDEN");
  const operator = await login(origin, "operator@pandora.test");
  expectError(await call(origin, `/orders/${po2.id}/confirm`, { actor: operator, method: "POST", body: { version: po2.version }, key: randomUUID(), csrf: false }), 403, "CSRF_TOKEN_INVALID");
}

try {
  const standard = setup("none");
  const labs = { "BUG-001": setup("BUG-001"), "BUG-002": setup("BUG-002"), "BUG-003": setup("BUG-003") };

  await check("setup writes a complete manifest without credentials and marks only defect databases", async () => {
    for (const manifest of [standard, ...Object.values(labs)]) {
      assert.match(manifest.database, /^pandora_buglab_(standard|bug00[123])_check_/);
      assert.match(manifest.appVersion.commit, /^[0-9a-f]{40}$/);
      assert.equal(typeof manifest.appVersion.dirty, "boolean");
      assert.match(manifest.seedVersion, /^[0-9a-f]{16}$/);
      const latestMigration = readdirSync(join(root, "prisma/migrations"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1);
      assert.equal(manifest.latestMigration, latestMigration, "manifest identifies the current migration history");
      const stored = readFileSync(join(root, "bug-lab/runs", `${manifest.runId}.json`), "utf8");
      assert.ok(!/postgres(ql)?:\/\/|password/i.test(stored), "no credentials in the manifest");
      const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlFor(manifest.database) }) });
      const [applied] = await db.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`;
      assert.equal(applied.migration_name, manifest.latestMigration, "manifest matches the applied database migration");
      const [row] = await db.$queryRaw`SELECT current_setting('pandora.defect', true) AS marker`;
      assert.equal(row.marker || null, manifest.defect);
      assert.equal(await db.order.count({ where: { organizationId: "01920000-0000-7000-8000-000000000002" } }), 45);
      await db.$disconnect();
    }
    assert.equal(standard.mode, "standard");
    const refused = (() => {
      try {
        execFileSync(process.execPath, [join(root, "scripts/bug-lab.mjs"), "setup", "--defect", "BUG-004"], { cwd: root, stdio: "pipe" });
        return false;
      } catch {
        return true;
      }
    })();
    assert.ok(refused, "an unknown defect is refused by the setup tool");
  });

  await check("the API refuses unknown or multiple IDs, production, non-Bug-Lab databases, and marker mismatches", async () => {
    const lab1 = labs["BUG-001"].database;
    await refusedStart({ database: standard.database, defect: "BUG-999", port: 3025 }, /BUG_LAB_DEFECT: must be exactly one of BUG-001, BUG-002, BUG-003/);
    await refusedStart({ database: standard.database, defect: "BUG-001,BUG-002", port: 3025 }, /BUG_LAB_DEFECT: must be exactly one of/);
    await refusedStart({ database: lab1, defect: "BUG-001", port: 3025, nodeEnv: "production" }, /refused when NODE_ENV is production/);
    await refusedStart({ database: "pandora_demo", defect: "BUG-001", port: 3025 }, /needs a dedicated pandora_buglab/);
    await refusedStart({ database: "pandora_admin_check_elsewhere", defect: "BUG-001", port: 3025 }, /needs a dedicated pandora_buglab/);
    await refusedStart({ database: lab1, defect: "BUG-002", port: 3025 }, /marked BUG-001, not BUG-002/);
    await refusedStart({ database: lab1, port: 3025 }, /marked for BUG-001; start the API with BUG_LAB_DEFECT=BUG-001/);
    await refusedStart({ database: standard.database, defect: "BUG-003", port: 3025 }, /marked for Standard mode, not BUG-003/);
  });

  const standardApi = await startApi({ database: standard.database, port: 3021 });
  const labApis = {
    "BUG-001": await startApi({ database: labs["BUG-001"].database, defect: "BUG-001", port: 3022 }),
    "BUG-002": await startApi({ database: labs["BUG-002"].database, defect: "BUG-002", port: 3023 }),
    "BUG-003": await startApi({ database: labs["BUG-003"].database, defect: "BUG-003", port: 3024 }),
  };

  await check("BUG-001: the final shipment of a partially shipped order leaves it partially_shipped only in Bug Lab", async () => {
    const good = await ASSERTIONS["BUG-001"](standardApi.origin);
    assert.ok(good.holds, `Standard: ${JSON.stringify(good.observed)}`);
    const bad = await ASSERTIONS["BUG-001"](labApis["BUG-001"].origin);
    assert.equal(bad.holds, false);
    assert.deepEqual(bad.observed, { status: "partially_shipped", outstanding: 0, shipments: 2 }, "fails for the intended reason");
    // The wrong state is really persisted, and the database exemption covers nothing else.
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlFor(labs["BUG-001"].database) }) });
    assert.equal((await db.order.findUniqueOrThrow({ where: { number: "PO-000008" } })).status, "PARTIALLY_SHIPPED");
    const po6 = await db.order.findUniqueOrThrow({ where: { number: "PO-000006" } });
    await assert.rejects(db.$executeRaw`UPDATE orders SET status = 'PARTIALLY_SHIPPED' WHERE id = ${po6.id}::uuid`, /does not match its quantities/);
    await db.$disconnect();
  });

  await check("BUG-002: page 2 repeats page 1's last order and pushes its own last order to page 3, only in Bug Lab", async () => {
    const good = await ASSERTIONS["BUG-002"](standardApi.origin);
    assert.ok(good.holds, `Standard: ${JSON.stringify(good.observed)}`);
    assert.deepEqual(good.observed, { repeated: [], missing: [] });
    const bad = await ASSERTIONS["BUG-002"](labApis["BUG-002"].origin);
    assert.equal(bad.holds, false);
    assert.equal(bad.observed.repeated.length, 1, JSON.stringify(bad.observed));
    assert.equal(bad.observed.missing.length, 1, JSON.stringify(bad.observed));
  });

  await check("BUG-003: a submitted order shows the new catalog price only in Bug Lab; the stored snapshot stays correct", async () => {
    const good = await ASSERTIONS["BUG-003"](standardApi.origin);
    assert.ok(good.holds, `Standard: ${JSON.stringify(good.observed)}`);
    const bad = await ASSERTIONS["BUG-003"](labApis["BUG-003"].origin);
    assert.equal(bad.holds, false);
    assert.equal(bad.observed.shown, bad.observed.catalog, "shows the current catalog price");
    assert.notEqual(bad.observed.shown, bad.observed.submitted);
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlFor(labs["BUG-003"].database) }) });
    const line = await db.orderLine.findFirstOrThrow({ where: { order: { number: "PO-000002" }, sku: "CWO-EN-STD" } });
    assert.equal(line.unitPriceMinor, bad.observed.submitted, "the frozen snapshot is unchanged in the database");
    await db.$disconnect();
  });

  await check("each defect breaks only its own rule: the other two assertions still hold on every Bug Lab database", async () => {
    for (const [defect, api] of Object.entries(labApis)) {
      for (const other of Object.keys(ASSERTIONS).filter((id) => id !== defect)) {
        const result = await ASSERTIONS[other](api.origin);
        assert.ok(result.holds, `${other} on ${defect}: ${JSON.stringify(result.observed)}`);
      }
    }
  });

  await check("authentication, CSRF, RBAC, and retailer isolation hold in every mode; logs contain no secrets", async () => {
    for (const api of [standardApi, ...Object.values(labApis)]) {
      await securityHolds(api.origin);
      for (const secret of [PASSWORD, "$argon2", "pandora_session="]) assert.ok(!api.logs().includes(secret), "no secrets in logs");
    }
  });

  console.log(`\n${passed} bug lab check groups passed.`);
} finally {
  for (const child of running) if (child.exitCode === null) child.kill("SIGTERM");
}
