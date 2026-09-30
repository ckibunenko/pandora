// Inventory API and PostgreSQL checks against an isolated, empty QA database.
// Usage: see context/features/inventory-verification.md.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  catalogResponseSchema,
  errorEnvelopeSchema,
  inventoryItemSchema,
  inventoryListResponseSchema,
  movementListResponseSchema,
  stockChangeResponseSchema,
} from "@pandora/contracts";
import { PrismaClient } from "../dist/generated/prisma/client.js";

const databaseName = process.env.INVENTORY_CHECK_DATABASE;
assert.match(
  databaseName ?? "",
  /^pandora_inventory_check_[a-z0-9_]+$/,
  "Set INVENTORY_CHECK_DATABASE to a separate, empty QA database created for this run.",
);
const url = new URL(process.env.DATABASE_URL);
assert.notEqual(url.pathname.slice(1), databaseName, "QA database must differ from the development database.");
url.pathname = `/${databaseName}`;
const port = process.env.INVENTORY_CHECK_PORT ?? "3012";
const env = { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: "test", CATALOG_CURRENCY: "EUR", API_PORT: port };
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });

const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
assert.equal(tables.length, 0, "Refusing to modify a nonempty QA database. Create a new database for each run.");
execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { env, stdio: "pipe" });
execFileSync(process.execPath, ["dist/seed/seed.js"], { env, stdio: "pipe" });

const server = spawn(process.execPath, ["dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", (data) => (logs += data));
server.stderr.on("data", (data) => (logs += data));
const origin = `http://127.0.0.1:${port}/api`;

let passed = 0;
async function check(label, operation) {
  await operation();
  passed += 1;
  console.log(`PASS ${label}`);
}
async function call(path, { actor, method = "GET", body, csrf = true, key, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(actor ? { Cookie: actor.cookie } : {}),
      ...(actor && csrf ? { "X-CSRF-Token": actor.csrf } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(key !== undefined ? { "Idempotency-Key": key } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}
async function login(email) {
  const result = await call("/auth/login", { method: "POST", body: { email, password: process.env.SEED_USER_PASSWORD } });
  assert.equal(result.status, 200, `login ${email}`);
  return { cookie: result.headers.get("set-cookie").split(";")[0], csrf: result.body.csrfToken };
}
function assertError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  errorEnvelopeSchema.parse(result.body);
  assert.equal(result.body.code, code, JSON.stringify(result.body));
}
const itemBySku = async (sku) =>
  db.inventoryItem.findFirstOrThrow({ where: { variant: { sku } }, select: { variantId: true, sellable: true, reserved: true, damaged: true } });
const counts = async () => ({
  movements: await db.inventoryMovement.count(),
  audits: await db.auditEvent.count(),
  records: await db.idempotencyRecord.count(),
});
// Mirrors the API's canonical request hash so a claim can be staged directly in the QA database.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, entry]) => `${JSON.stringify(k)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const requestHash = (operation, target, payload) =>
  createHash("sha256").update(canonicalJson({ operation, target, payload })).digest("hex");
async function sumsMatch() {
  const rows = await db.$queryRaw`
    SELECT i.variant_id,
      i.sellable = COALESCE(SUM(m.delta) FILTER (WHERE m.bucket = 'SELLABLE'), 0) AS sellable_ok,
      i.damaged = COALESCE(SUM(m.delta) FILTER (WHERE m.bucket = 'DAMAGED'), 0) AS damaged_ok
    FROM inventory_items i LEFT JOIN inventory_movements m ON m.variant_id = i.variant_id
    GROUP BY i.variant_id, i.sellable, i.damaged`;
  assert.ok(rows.length > 0 && rows.every((row) => row.sellable_ok && row.damaged_ok), "movement sums must equal quantities");
}

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`API exited during startup: ${logs}`);
    try {
      if ((await fetch(`${origin}/health/ready`)).ok) break;
    } catch {
      /* readiness polling only */
    }
    await delay(50);
  }
  const operator = await login("operator@pandora.test");
  const admin = await login("admin@pandora.test");
  const retailer = await login("retailer@tabletop-lantern.test");
  const lov = await itemBySku("LOV-EN-STD");

  await check("seed: one item per variant, opening balances, sums, no audit; reseed changes nothing", async () => {
    assert.equal(await db.inventoryItem.count(), await db.productVariant.count());
    assert.deepEqual(await counts(), { movements: 11, audits: 0, records: 0 });
    assert.deepEqual(await itemBySku("SWA-EN-STD"), { ...(await itemBySku("SWA-EN-STD")), sellable: 18, damaged: 2, reserved: 0 });
    assert.equal((await itemBySku("CWO-EN-DLX")).sellable, 0);
    await sumsMatch();
    execFileSync(process.execPath, ["dist/seed/seed.js"], { env, stdio: "pipe" });
    assert.deepEqual(await counts(), { movements: 11, audits: 0, records: 0 });
  });

  await check("access: 401 without session, 403 for retailers, 403 without CSRF, no side effects", async () => {
    const before = await counts();
    const paths = ["/inventory", `/inventory/${lov.variantId}`, `/inventory/${lov.variantId}/movements`];
    for (const path of paths) {
      assertError(await call(path), 401, "UNAUTHENTICATED");
      assertError(await call(path, { actor: retailer }), 403, "FORBIDDEN");
      assert.equal((await call(path, { actor: operator })).status, 200);
      assert.equal((await call(path, { actor: admin })).status, 200);
    }
    for (const [path, body] of [
      [`/inventory/${lov.variantId}/receipts`, { quantity: 1 }],
      [`/inventory/${lov.variantId}/adjustments`, { bucket: "sellable", delta: -1, reason: "Count check" }],
    ]) {
      assertError(await call(path, { method: "POST", body, key: randomUUID() }), 401, "UNAUTHENTICATED");
      assertError(await call(path, { actor: retailer, method: "POST", body, key: randomUUID() }), 403, "FORBIDDEN");
      assertError(await call(path, { actor: operator, method: "POST", body, key: randomUUID(), csrf: false }), 403, "CSRF_TOKEN_INVALID");
    }
    assert.deepEqual(await counts(), before);
  });

  await check("list: schema, sort, search, stock filter, pagination, validation", async () => {
    const all = await call("/inventory?pageSize=50", { actor: operator });
    inventoryListResponseSchema.parse(all.body);
    assert.equal(all.body.total, 11);
    const sorted = [...all.body.items].sort(
      (a, b) => a.product.name.localeCompare(b.product.name, "en") || a.sku.localeCompare(b.sku, "en"),
    );
    assert.deepEqual(all.body.items.map((i) => i.sku), sorted.map((i) => i.sku));
    const bySku = await call("/inventory?q=lov-md", { actor: operator });
    assert.deepEqual(bySku.body.items.map((i) => i.sku), ["LOV-MD-EN"]);
    const byName = await call("/inventory?q=saltwind", { actor: operator });
    assert.deepEqual(byName.body.items.map((i) => i.sku).sort(), ["SWA-EN-STD", "SWA-GI-EN"]);
    assert.equal((await call(`/inventory?q=${encodeURIComponent("%")}`, { actor: operator })).body.total, 0);
    const unavailable = await call("/inventory?stock=unavailable", { actor: operator });
    assert.deepEqual(unavailable.body.items.map((i) => i.sku), ["CWO-EN-DLX"]);
    assert.equal((await call("/inventory?stock=available", { actor: operator })).body.total, 10);
    const inactive = all.body.items.filter((i) => !i.variantIsActive || !i.product.isActive).map((i) => i.sku).sort();
    assert.deepEqual(inactive, ["EBW-EN-STD", "MBM-EN-STD"]);
    const page2 = await call("/inventory?page=2&pageSize=20", { actor: operator });
    assert.deepEqual([page2.body.items.length, page2.body.total], [0, 11]);
    for (const query of ["pageSize=10", "page=0", "stock=low", "unknown=1", `q=${"x".repeat(121)}`]) {
      assertError(await call(`/inventory?${query}`, { actor: operator }), 422, "VALIDATION_FAILED");
    }
    assertError(await call("/inventory/not-a-uuid", { actor: operator }), 422, "VALIDATION_FAILED");
    assertError(await call(`/inventory/${randomUUID()}`, { actor: operator }), 404, "NOT_FOUND");
    assertError(await call(`/inventory/${randomUUID()}/movements`, { actor: operator }), 404, "NOT_FOUND");
  });

  await check("receipt: 201, movement + audit + quantities atomically, correlation and actor recorded", async () => {
    const before = await counts();
    const result = await call(`/inventory/${lov.variantId}/receipts`, {
      actor: operator,
      method: "POST",
      body: { quantity: 10, reference: "  DN-2001  ", note: "Pallet A" },
      key: randomUUID(),
      headers: { "X-Correlation-Id": "qa-receipt-1" },
    });
    assert.equal(result.status, 201);
    stockChangeResponseSchema.parse(result.body);
    assert.equal(result.body.item.sellable, lov.sellable + 10);
    assert.equal(result.body.movement.reference, "DN-2001");
    assert.deepEqual(await counts(), { ...before, movements: before.movements + 1, audits: before.audits + 1, records: before.records + 1 });
    const movement = await db.inventoryMovement.findUniqueOrThrow({ where: { id: result.body.movement.id } });
    assert.equal(movement.correlationId, "qa-receipt-1");
    const audit = await db.auditEvent.findFirstOrThrow({ where: { correlationId: "qa-receipt-1" } });
    assert.deepEqual([audit.entityType, audit.entityId, audit.action], ["inventory_item", lov.variantId, "received"]);
    assert.equal(audit.after.movementId, movement.id);
    assert.equal(audit.before.sellable, lov.sellable);
    await sumsMatch();
  });

  await check("receipt validation: bounds, types, unknown fields, lengths; nothing written", async () => {
    const before = await counts();
    for (const body of [
      { quantity: 0 },
      { quantity: -1 },
      { quantity: 1.5 },
      { quantity: 1_000_001 },
      { quantity: "5" },
      {},
      { quantity: 1, bucket: "damaged" },
      { quantity: 1, reference: "x".repeat(81) },
      { quantity: 1, reference: "   " },
    ]) {
      const result = await call(`/inventory/${lov.variantId}/receipts`, { actor: operator, method: "POST", body, key: randomUUID() });
      assertError(result, 422, "VALIDATION_FAILED");
      assert.ok(result.body.details.length > 0);
    }
    assertError(
      await call(`/inventory/${randomUUID()}/receipts`, { actor: operator, method: "POST", body: { quantity: 1 }, key: randomUUID() }),
      404,
      "NOT_FOUND",
    );
    assert.deepEqual(await counts(), before);
  });

  await check("receipt overflow beyond the integer range returns 422 without changes", async () => {
    const tkc = await itemBySku("TKC-EN-STD");
    await db.$executeRaw`UPDATE inventory_items SET sellable = 2147483000 WHERE variant_id = ${tkc.variantId}::uuid`;
    try {
      const before = await counts();
      const result = await call(`/inventory/${tkc.variantId}/receipts`, { actor: operator, method: "POST", body: { quantity: 1000 }, key: randomUUID() });
      assertError(result, 422, "VALIDATION_FAILED");
      assert.equal(result.body.details[0].field, "quantity");
      assert.deepEqual(await counts(), before);
    } finally {
      await db.$executeRaw`UPDATE inventory_items SET sellable = ${tkc.sellable} WHERE variant_id = ${tkc.variantId}::uuid`;
    }
  });

  await check("adjustments: sellable/damaged changes, below-zero and invalid input rejected without changes", async () => {
    const swa = await itemBySku("SWA-EN-STD");
    const path = `/inventory/${swa.variantId}/adjustments`;
    const before = await counts();
    assertError(await call(path, { actor: admin, method: "POST", body: { bucket: "sellable", delta: -19, reason: "Too many" }, key: randomUUID() }), 409, "INSUFFICIENT_STOCK");
    assertError(await call(path, { actor: admin, method: "POST", body: { bucket: "damaged", delta: -3, reason: "Too many" }, key: randomUUID() }), 409, "INSUFFICIENT_STOCK");
    for (const body of [
      { bucket: "sellable", delta: 0, reason: "Zero" },
      { bucket: "sellable", delta: -1, reason: "ab" },
      { bucket: "reserved", delta: 1, reason: "Not editable" },
      { bucket: "sellable", delta: 1.5, reason: "Fraction" },
      { bucket: "sellable", delta: -1_000_001, reason: "Too large" },
      { bucket: "sellable", delta: -1 },
    ]) {
      assertError(await call(path, { actor: admin, method: "POST", body, key: randomUUID() }), 422, "VALIDATION_FAILED");
    }
    assert.deepEqual(await counts(), before);
    const toDamaged = await call(path, { actor: admin, method: "POST", body: { bucket: "sellable", delta: -3, reason: "Crushed boxes" }, key: randomUUID() });
    assert.equal(toDamaged.status, 201);
    const damaged = await call(path, { actor: admin, method: "POST", body: { bucket: "damaged", delta: 3, reason: "Crushed boxes" }, key: randomUUID() });
    assert.equal(damaged.status, 201);
    assert.deepEqual(
      [damaged.body.item.sellable, damaged.body.item.damaged, damaged.body.item.available],
      [swa.sellable - 3, swa.damaged + 3, swa.sellable - 3],
    );
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: swa.variantId, action: "adjusted" }, orderBy: { occurredAt: "desc" } });
    assert.ok(audit.after.movementId);
    await sumsMatch();
  });

  await check("reserved units cannot be removed by a sellable adjustment", async () => {
    const tkc = await itemBySku("TKC-EN-STD");
    await db.$executeRaw`UPDATE inventory_items SET reserved = 5 WHERE variant_id = ${tkc.variantId}::uuid`;
    try {
      const path = `/inventory/${tkc.variantId}/adjustments`;
      const blocked = await call(path, { actor: operator, method: "POST", body: { bucket: "sellable", delta: -(tkc.sellable - 4), reason: "Would dip below reserved" }, key: randomUUID() });
      assertError(blocked, 409, "INSUFFICIENT_STOCK");
      const allowed = await call(path, { actor: operator, method: "POST", body: { bucket: "sellable", delta: -(tkc.sellable - 5), reason: "Down to reserved" }, key: randomUUID() });
      assert.equal(allowed.status, 201);
      assert.deepEqual([allowed.body.item.sellable, allowed.body.item.reserved, allowed.body.item.available], [5, 5, 0]);
      const catalog = await call("/catalog/products?q=TKC-EN-STD", { actor: retailer });
      assert.equal(catalog.body.items[0].variants[0].availableQuantity, 0);
    } finally {
      await db.$executeRaw`UPDATE inventory_items SET reserved = 0 WHERE variant_id = ${tkc.variantId}::uuid`;
    }
  });

  await check("idempotency: required key, format, replay, reuse with another payload, scope per actor and target", async () => {
    const path = `/inventory/${lov.variantId}/receipts`;
    assertError(await call(path, { actor: operator, method: "POST", body: { quantity: 1 } }), 400, "IDEMPOTENCY_KEY_REQUIRED");
    assertError(await call(path, { actor: operator, method: "POST", body: { quantity: 1 }, key: "has space" }), 422, "VALIDATION_FAILED");
    const key = `qa-replay-${randomUUID()}`;
    const first = await call(path, { actor: operator, method: "POST", body: { quantity: 2, reference: "DN-7" }, key });
    assert.equal(first.status, 201);
    const afterFirst = await counts();
    const replay = await call(path, { actor: operator, method: "POST", body: { quantity: 2, reference: " DN-7 " }, key });
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, first.body, "replay returns the original response");
    assert.deepEqual(await counts(), afterFirst, "replay has no new effects");
    assertError(await call(path, { actor: operator, method: "POST", body: { quantity: 3, reference: "DN-7" }, key }), 409, "IDEMPOTENCY_KEY_REUSED");
    const otherActor = await call(path, { actor: admin, method: "POST", body: { quantity: 2, reference: "DN-7" }, key });
    assert.equal(otherActor.status, 201);
    assert.notEqual(otherActor.body.movement.id, first.body.movement.id);
    const other = await itemBySku("LOV-SR-STD");
    const otherTarget = await call(`/inventory/${other.variantId}/receipts`, { actor: operator, method: "POST", body: { quantity: 2, reference: "DN-7" }, key });
    assert.equal(otherTarget.status, 201);
    assert.equal((await itemBySku("LOV-EN-STD")).sellable, first.body.item.sellable + 2);
  });

  await check("idempotency: failed requests leave no record, so the same key can be retried", async () => {
    const swaGi = await itemBySku("SWA-GI-EN");
    const key = `qa-failed-${randomUUID()}`;
    const path = `/inventory/${swaGi.variantId}/adjustments`;
    const body = { bucket: "sellable", delta: -2, reason: "More than available" };
    const before = await counts();
    assertError(await call(path, { actor: operator, method: "POST", body, key }), 409, "INSUFFICIENT_STOCK");
    assert.equal(await db.idempotencyRecord.count({ where: { key } }), 0);
    assert.deepEqual(await counts(), before);
    assertError(await call(path, { actor: operator, method: "POST", body, key }), 409, "INSUFFICIENT_STOCK");
  });

  await check("idempotency: in-progress claim returns 409; an expired claim is taken over and completed", async () => {
    const operatorUser = await db.user.findUniqueOrThrow({ where: { email: "operator@pandora.test" } });
    const payload = { quantity: 4 };
    const scope = { organizationId: operatorUser.organizationId, actorId: operatorUser.id, operation: "inventory.receipt", target: lov.variantId };
    const stage = async (key, leaseExpiresAt) =>
      db.idempotencyRecord.create({
        data: { ...scope, key, requestHash: requestHash(scope.operation, scope.target, payload), status: "IN_PROGRESS", leaseExpiresAt, createdAt: new Date() },
      });
    const path = `/inventory/${lov.variantId}/receipts`;
    const liveKey = `qa-live-${randomUUID()}`;
    await stage(liveKey, new Date(Date.now() + 60_000));
    const before = await counts();
    assertError(await call(path, { actor: operator, method: "POST", body: payload, key: liveKey }), 409, "REQUEST_IN_PROGRESS");
    assert.deepEqual(await counts(), before);
    const staleKey = `qa-stale-${randomUUID()}`;
    await stage(staleKey, new Date(Date.now() - 1_000));
    const takeover = await call(path, { actor: operator, method: "POST", body: payload, key: staleKey });
    assert.equal(takeover.status, 201);
    const record = await db.idempotencyRecord.findFirstOrThrow({ where: { key: staleKey } });
    assert.equal(record.status, "COMPLETED");
  });

  await check("concurrency: parallel identical requests with one key apply once", async () => {
    const key = `qa-parallel-${randomUUID()}`;
    const before = await counts();
    const item = await itemBySku("MBM-SR-STD");
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(`/inventory/${item.variantId}/receipts`, { actor: operator, method: "POST", body: { quantity: 1 }, key }),
      ),
    );
    const successes = results.filter((r) => r.status === 201);
    assert.ok(successes.length >= 1, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.every((r) => r.status === 201 || (r.status === 409 && r.body.code === "REQUEST_IN_PROGRESS")));
    assert.ok(successes.every((r) => r.body.movement.id === successes[0].body.movement.id));
    assert.equal((await itemBySku("MBM-SR-STD")).sellable, item.sellable + 1);
    assert.equal((await counts()).movements, before.movements + 1);
  });

  await check("concurrency: parallel removals never oversell (exactly the available units succeed)", async () => {
    const item = await itemBySku("LOV-MD-EN");
    assert.equal(item.sellable, 3);
    const before = await counts();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        call(`/inventory/${item.variantId}/adjustments`, {
          actor: operator,
          method: "POST",
          body: { bucket: "sellable", delta: -1, reason: `Parallel removal ${index}` },
          key: randomUUID(),
        }),
      ),
    );
    const statuses = results.map((r) => (r.status === 201 ? "201" : r.body.code));
    assert.equal(statuses.filter((s) => s === "201").length, 3, statuses.join(","));
    assert.ok(statuses.every((s) => ["201", "INSUFFICIENT_STOCK", "CONCURRENT_MODIFICATION"].includes(s)), statuses.join(","));
    assert.equal((await itemBySku("LOV-MD-EN")).sellable, 0);
    assert.equal((await counts()).movements, before.movements + 3);
    await sumsMatch();
  });

  await check("rollback: an audit failure leaves no movement, quantity change, or idempotency record; the key stays usable", async () => {
    const item = await itemBySku("CWO-EN-STD");
    const key = `qa-rollback-${randomUUID()}`;
    const before = await counts();
    await db.$executeRaw`CREATE FUNCTION reject_inventory_check_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected QA audit failure'; END; $$`;
    await db.$executeRaw`CREATE TRIGGER reject_inventory_check_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_inventory_check_audit()`;
    try {
      const failed = await call(`/inventory/${item.variantId}/receipts`, { actor: operator, method: "POST", body: { quantity: 5 }, key });
      assertError(failed, 500, "INTERNAL_ERROR");
      assert.deepEqual(await counts(), before);
      assert.equal((await itemBySku("CWO-EN-STD")).sellable, item.sellable);
    } finally {
      await db.$executeRaw`DROP TRIGGER reject_inventory_check_audit ON audit_events`;
      await db.$executeRaw`DROP FUNCTION reject_inventory_check_audit()`;
    }
    const retried = await call(`/inventory/${item.variantId}/receipts`, { actor: operator, method: "POST", body: { quantity: 5 }, key });
    assert.equal(retried.status, 201);
    assert.equal(retried.body.item.sellable, item.sellable + 5);
  });

  await check("database rejects direct writes that break invariants; movements are append-only", async () => {
    const item = await itemBySku("LOV-EN-STD");
    const movement = await db.inventoryMovement.findFirstOrThrow({ where: { variantId: item.variantId } });
    await assert.rejects(db.$executeRaw`UPDATE inventory_movements SET delta = 999 WHERE id = ${movement.id}::uuid`);
    await assert.rejects(db.$executeRaw`DELETE FROM inventory_movements WHERE id = ${movement.id}::uuid`);
    await assert.rejects(db.$executeRaw`UPDATE inventory_items SET sellable = -1 WHERE variant_id = ${item.variantId}::uuid`);
    await assert.rejects(db.$executeRaw`UPDATE inventory_items SET reserved = sellable + 1 WHERE variant_id = ${item.variantId}::uuid`);
    await assert.rejects(
      db.$executeRaw`INSERT INTO inventory_movements (variant_id, type, bucket, delta, sellable_after, reserved_after, damaged_after, occurred_at)
        VALUES (${item.variantId}::uuid, 'RECEIPT', 'SELLABLE', 1, 1, 0, 0, now())`,
      "receipts require an actor",
    );
    await sumsMatch();
  });

  await check("movements endpoint: newest first, paginated, schema-valid", async () => {
    const result = await call(`/inventory/${lov.variantId}/movements?pageSize=20`, { actor: admin });
    movementListResponseSchema.parse(result.body);
    const times = result.body.items.map((m) => m.occurredAt);
    assert.deepEqual(times, [...times].sort().reverse());
    assert.equal(result.body.items.at(-1).type, "opening_balance");
    assert.equal(result.body.items.at(-1).actor, null);
    assert.equal(result.body.total, await db.inventoryMovement.count({ where: { variantId: lov.variantId } }));
  });

  await check("catalog availability equals sellable minus reserved for every visible variant", async () => {
    const catalog = await call("/catalog/products?pageSize=50", { actor: retailer });
    catalogResponseSchema.parse(catalog.body);
    for (const variant of catalog.body.items.flatMap((p) => p.variants)) {
      const item = await db.inventoryItem.findUniqueOrThrow({ where: { variantId: variant.id } });
      assert.equal(variant.availableQuantity, item.sellable - item.reserved, variant.sku);
    }
    const detail = await call(`/inventory/${lov.variantId}`, { actor: operator });
    inventoryItemSchema.parse(detail.body);
  });

  await check("OpenAPI documents inventory routes and the Idempotency-Key header", async () => {
    const document = await (await fetch(`${origin}/openapi.json`)).json();
    for (const route of ["/api/inventory", "/api/inventory/{variantId}", "/api/inventory/{variantId}/movements"]) {
      assert.ok(document.paths[route]?.get, route);
    }
    for (const route of ["/api/inventory/{variantId}/receipts", "/api/inventory/{variantId}/adjustments"]) {
      const operation = document.paths[route]?.post;
      assert.ok(operation, route);
      assert.ok(operation.parameters.some((p) => p.in === "header" && p.name === "Idempotency-Key"), route);
    }
  });

  assert.ok(!/pandora-demo|argon2|pandora_session=/.test(logs), "logs must not contain credentials or tokens");
  console.log(`\n${passed} inventory check groups passed.`);
} catch (error) {
  console.error(logs.slice(-4000));
  throw error;
} finally {
  server.kill("SIGTERM");
  await db.$disconnect();
}
