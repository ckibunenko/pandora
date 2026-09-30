// Order draft and submission checks against the real API and an isolated, empty QA database.
// Usage: see context/features/order-drafts-verification.md.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { errorEnvelopeSchema, orderListResponseSchema, orderSchema } from "@pandora/contracts";
import { PrismaClient } from "../dist/generated/prisma/client.js";

const databaseName = process.env.ORDERS_CHECK_DATABASE;
assert.match(
  databaseName ?? "",
  /^pandora_orders_check_[a-z0-9_]+$/,
  "Set ORDERS_CHECK_DATABASE to a separate, empty QA database created for this run.",
);
const url = new URL(process.env.DATABASE_URL);
assert.notEqual(url.pathname.slice(1), databaseName, "QA database must differ from the development database.");
url.pathname = `/${databaseName}`;
const port = process.env.ORDERS_CHECK_PORT ?? "3014";
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
function assertError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  errorEnvelopeSchema.parse(result.body);
  assert.equal(result.body.code, code, JSON.stringify(result.body));
}
const variant = (sku) => db.productVariant.findFirstOrThrow({ where: { sku }, select: { id: true, unitPriceMinor: true, productId: true } });
const orderByNumber = (number) => db.order.findUniqueOrThrow({ where: { number }, include: { lines: true } });
const stockSnapshot = async () => ({
  movements: await db.inventoryMovement.count(),
  items: await db.inventoryItem.findMany({ select: { variantId: true, sellable: true, reserved: true, damaged: true }, orderBy: { variantId: "asc" } }),
});
const reviewed = (order) => order.lines.map((line) => ({ variantId: line.variantId, unitPriceMinor: line.unitPriceMinor }));

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
  const lantern = await login("retailer@tabletop-lantern.test");
  const keep = await login("retailer@cardboard-keep.test");
  const operator = await login("operator@pandora.test");
  const admin = await login("admin@pandora.test");
  const stockBefore = await stockSnapshot();
  const po1 = await orderByNumber("PO-000001");
  const po2 = await orderByNumber("PO-000002");
  const po4 = await orderByNumber("PO-000004");
  const lov = await variant("LOV-EN-STD");
  const swaGi = await variant("SWA-GI-EN");
  const cwo = await variant("CWO-EN-STD");
  const tkc = await variant("TKC-EN-STD");

  await check("seed: four demo orders with correct states; submitted order frozen; reseed creates nothing", async () => {
    assert.deepEqual(
      (await db.order.findMany({ orderBy: { number: "asc" }, select: { number: true, status: true } })).map((o) => `${o.number}:${o.status}`),
      ["PO-000001:DRAFT", "PO-000002:SUBMITTED", "PO-000003:CANCELLED", "PO-000004:DRAFT"],
    );
    assert.equal(po2.totalMinor, 10500n);
    assert.ok(po2.lines.every((line) => line.sku !== null && line.lineTotalMinor === BigInt(line.unitPriceMinor) * BigInt(line.quantity)));
    assert.ok(po1.lines.every((line) => line.sku === null));
    execFileSync(process.execPath, ["dist/seed/seed.js"], { env, stdio: "pipe" });
    assert.equal(await db.order.count(), 4);
    assert.equal(await db.auditEvent.count(), 0);
  });

  await check("isolation: retailers see only their organization (404 elsewhere); staff read all but cannot mutate", async () => {
    const own = await call("/orders", { actor: lantern });
    orderListResponseSchema.parse(own.body);
    assert.deepEqual(own.body.items.map((o) => o.number), ["PO-000003", "PO-000002", "PO-000001"]);
    assert.deepEqual((await call("/orders", { actor: keep })).body.items.map((o) => o.number), ["PO-000004"]);
    assert.equal((await call("/orders", { actor: operator })).body.total, 4);
    assert.equal((await call("/orders", { actor: admin })).body.total, 4);
    assert.equal((await call(`/orders/${po1.id}`, { actor: operator })).status, 200);
    assertError(await call(`/orders/${po1.id}`, { actor: keep }), 404, "NOT_FOUND");
    assertError(await call(`/orders/${po1.id}/lines`, { actor: keep, method: "PUT", body: { version: 1, lines: [] } }), 404, "NOT_FOUND");
    assertError(await call(`/orders/${po1.id}/submit`, { actor: keep, method: "POST", body: { version: 1, reviewedPrices: [] }, key: randomUUID() }), 404, "NOT_FOUND");
    assertError(await call(`/orders/${po1.id}/cancel`, { actor: keep, method: "POST", body: { version: 1 }, key: randomUUID() }), 404, "NOT_FOUND");
    assertError(await call("/orders", { actor: operator, method: "POST", body: {}, key: randomUUID() }), 403, "FORBIDDEN");
    assertError(await call(`/orders/${po1.id}/lines`, { actor: admin, method: "PUT", body: { version: 1, lines: [] } }), 403, "FORBIDDEN");
    assertError(await call(`/orders/${po1.id}/lines`, { actor: lantern, method: "PUT", body: { version: 1, lines: [] }, csrf: false }), 403, "CSRF_TOKEN_INVALID");
    for (const path of ["/orders", `/orders/${po1.id}`]) assertError(await call(path), 401, "UNAUTHENTICATED");
    assert.equal((await orderByNumber("PO-000001")).version, 1, "no side effects");
  });

  await check("create: key required, idempotent replay, reused key conflict, numbering from PO-001001, audit", async () => {
    assertError(await call("/orders", { actor: lantern, method: "POST", body: {} }), 400, "IDEMPOTENCY_KEY_REQUIRED");
    const key = randomUUID();
    const body = { lines: [{ variantId: lov.id, quantity: 2 }] };
    const first = await call("/orders", { actor: lantern, method: "POST", body, key });
    assert.equal(first.status, 201);
    orderSchema.parse(first.body);
    assert.equal(first.body.number, "PO-001001");
    assert.deepEqual([first.body.status, first.body.version, first.body.priceStatus, first.body.totalMinor], ["draft", 1, "provisional", 2 * lov.unitPriceMinor]);
    const replay = await call("/orders", { actor: lantern, method: "POST", body, key });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, first.body.id);
    assert.equal(await db.order.count(), 5);
    assertError(await call("/orders", { actor: lantern, method: "POST", body: { lines: [] }, key }), 409, "IDEMPOTENCY_KEY_REUSED");
    const empty = await call("/orders", { actor: lantern, method: "POST", body: {}, key: randomUUID() });
    assert.deepEqual([empty.status, empty.body.number, empty.body.lines.length], [201, "PO-001002", 0]);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: first.body.id, action: "created" } });
    assert.equal(audit.entityType, "order");
  });

  await check("line validation: duplicates, limits, quantities, unknown and hidden variants → 422 without changes", async () => {
    const hiddenVariant = await variant("MBM-EN-STD");
    const hiddenProduct = await variant("EBW-EN-STD");
    const count = await db.order.count();
    const manyLines = Array.from({ length: 101 }, () => ({ variantId: randomUUID(), quantity: 1 }));
    for (const lines of [
      [{ variantId: lov.id, quantity: 1 }, { variantId: lov.id, quantity: 2 }],
      manyLines,
      [{ variantId: lov.id, quantity: 0 }],
      [{ variantId: lov.id, quantity: 10_001 }],
      [{ variantId: lov.id, quantity: 1.5 }],
      [{ variantId: randomUUID(), quantity: 1 }],
      [{ variantId: hiddenVariant.id, quantity: 1 }],
      [{ variantId: hiddenProduct.id, quantity: 1 }],
      [{ variantId: lov.id, quantity: 1, price: 1 }],
    ]) {
      assertError(await call("/orders", { actor: lantern, method: "POST", body: { lines }, key: randomUUID() }), 422, "VALIDATION_FAILED");
    }
    assert.equal(await db.order.count(), count);
    assertError(await call(`/orders/${po1.id}/lines`, { actor: lantern, method: "PUT", body: { lines: [] } }), 422, "VALIDATION_FAILED");
  });

  await check("save lines: replace/add/remove, version increments, stale version conflicts without changes", async () => {
    assertError(
      await call(`/orders/${po1.id}/lines`, { actor: lantern, method: "PUT", body: { version: 2, lines: [] } }),
      409,
      "VERSION_CONFLICT",
    );
    const saved = await call(`/orders/${po1.id}/lines`, {
      actor: lantern,
      method: "PUT",
      body: { version: 1, lines: [{ variantId: lov.id, quantity: 5 }, { variantId: cwo.id, quantity: 1 }] },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.lines.map((l) => `${l.sku}x${l.quantity}`), ["CWO-EN-STDx1", "LOV-EN-STDx5"]);
    assert.equal(saved.body.version, 2);
    assert.equal(saved.body.totalMinor, 5 * lov.unitPriceMinor + cwo.unitPriceMinor);
    assertError(
      await call(`/orders/${po1.id}/lines`, { actor: lantern, method: "PUT", body: { version: 1, lines: [] } }),
      409,
      "VERSION_CONFLICT",
    );
    assert.equal((await orderByNumber("PO-000001")).lines.length, 2);
    assert.equal(await db.auditEvent.count({ where: { entityId: po1.id, action: "lines_updated" } }), 1);
  });

  await check("hidden variant already in a draft stays, is flagged, and blocks submission with VARIANT_UNAVAILABLE", async () => {
    await db.$executeRaw`UPDATE product_variants SET is_active = false WHERE id = ${cwo.id}::uuid`;
    try {
      const detail = await call(`/orders/${po1.id}`, { actor: lantern });
      assert.equal(detail.body.lines.find((l) => l.sku === "CWO-EN-STD").isAvailable, false);
      const kept = await call(`/orders/${po1.id}/lines`, {
        actor: lantern,
        method: "PUT",
        body: { version: 2, lines: [{ variantId: lov.id, quantity: 6 }, { variantId: cwo.id, quantity: 1 }] },
      });
      assert.equal(kept.status, 200, JSON.stringify(kept.body));
      const blocked = await call(`/orders/${po1.id}/submit`, {
        actor: lantern,
        method: "POST",
        body: { version: 3, reviewedPrices: reviewed(kept.body) },
        key: randomUUID(),
      });
      assertError(blocked, 409, "VARIANT_UNAVAILABLE");
      assert.equal(blocked.body.details[0].field, "lines.CWO-EN-STD");
      assert.equal((await orderByNumber("PO-000001")).status, "DRAFT");
    } finally {
      await db.$executeRaw`UPDATE product_variants SET is_active = true WHERE id = ${cwo.id}::uuid`;
    }
  });

  await check("submit: validation, price drift, then frozen snapshot; replay; no further edits", async () => {
    const draft = (await call(`/orders/${po1.id}`, { actor: lantern })).body;
    assert.equal(draft.version, 3);
    assertError(
      await call(`/orders/${po1.id}/submit`, { actor: lantern, method: "POST", body: { version: 3, reviewedPrices: [] }, key: randomUUID() }),
      422,
      "VALIDATION_FAILED",
    );
    const emptyDraft = (await call("/orders", { actor: keep, method: "POST", body: {}, key: randomUUID() })).body;
    assertError(
      await call(`/orders/${emptyDraft.id}/submit`, { actor: keep, method: "POST", body: { version: 1, reviewedPrices: [] }, key: randomUUID() }),
      422,
      "VALIDATION_FAILED",
    );
    await db.$executeRaw`UPDATE product_variants SET unit_price_minor = unit_price_minor + 100 WHERE id = ${lov.id}::uuid`;
    const drift = await call(`/orders/${po1.id}/submit`, { actor: lantern, method: "POST", body: { version: 3, reviewedPrices: reviewed(draft) }, key: randomUUID() });
    assertError(drift, 409, "PRICE_CHANGED");
    assert.deepEqual(drift.body.details.map((d) => d.field), ["lines.LOV-EN-STD"]);
    assert.equal((await orderByNumber("PO-000001")).status, "DRAFT");
    const refreshed = (await call(`/orders/${po1.id}`, { actor: lantern })).body;
    const key = randomUUID();
    const body = { version: 3, reviewedPrices: reviewed(refreshed) };
    const submitted = await call(`/orders/${po1.id}/submit`, { actor: lantern, method: "POST", body, key });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    orderSchema.parse(submitted.body);
    assert.deepEqual([submitted.body.status, submitted.body.version, submitted.body.priceStatus], ["submitted", 4, "frozen"]);
    const expectedTotal = 6 * (lov.unitPriceMinor + 100) + cwo.unitPriceMinor;
    assert.equal(submitted.body.totalMinor, expectedTotal);
    const stored = await orderByNumber("PO-000001");
    assert.equal(stored.totalMinor, BigInt(expectedTotal));
    assert.ok(stored.lines.every((line) => line.sku && line.productName && line.unitPriceMinor !== null));
    const replay = await call(`/orders/${po1.id}/submit`, { actor: lantern, method: "POST", body, key });
    assert.deepEqual(replay.body, submitted.body);
    assertError(await call(`/orders/${po1.id}/lines`, { actor: lantern, method: "PUT", body: { version: 4, lines: [] } }), 409, "INVALID_ORDER_TRANSITION");
    assertError(await call(`/orders/${po1.id}/submit`, { actor: lantern, method: "POST", body, key: randomUUID() }), 409, "INVALID_ORDER_TRANSITION");
  });

  await check("catalog edits after submission never change the frozen order", async () => {
    const before = (await call(`/orders/${po1.id}`, { actor: lantern })).body;
    await db.$executeRaw`UPDATE product_variants SET unit_price_minor = 99999, edition = 'Renamed' WHERE id = ${lov.id}::uuid`;
    await db.$executeRaw`UPDATE products SET name = 'Renamed product' WHERE id = ${lov.productId}::uuid`;
    try {
      const after = (await call(`/orders/${po1.id}`, { actor: lantern })).body;
      assert.deepEqual(after.lines, before.lines);
      assert.equal(after.totalMinor, before.totalMinor);
    } finally {
      await db.$executeRaw`UPDATE product_variants SET unit_price_minor = ${lov.unitPriceMinor}, edition = 'Standard' WHERE id = ${lov.id}::uuid`;
      await db.$executeRaw`UPDATE products SET name = 'Lanterns of Velora' WHERE id = ${lov.productId}::uuid`;
    }
  });

  await check("cancel: from draft and from submitted, attributed; repeated or stale cancels rejected", async () => {
    assertError(await call(`/orders/${po4.id}/cancel`, { actor: keep, method: "POST", body: { version: 5 }, key: randomUUID() }), 409, "VERSION_CONFLICT");
    const draftCancel = await call(`/orders/${po4.id}/cancel`, { actor: keep, method: "POST", body: { version: 1, reason: "  Changed plans  " }, key: randomUUID() });
    assert.equal(draftCancel.status, 200);
    assert.deepEqual([draftCancel.body.status, draftCancel.body.cancelledBy.displayName, draftCancel.body.cancellationReason], ["cancelled", "Kira Keep", "Changed plans"]);
    assertError(await call(`/orders/${po4.id}/cancel`, { actor: keep, method: "POST", body: { version: 2 }, key: randomUUID() }), 409, "INVALID_ORDER_TRANSITION");
    const submittedCancel = await call(`/orders/${po2.id}/cancel`, { actor: lantern, method: "POST", body: { version: 2 }, key: randomUUID() });
    assert.equal(submittedCancel.status, 200);
    assert.deepEqual([submittedCancel.body.status, submittedCancel.body.priceStatus, submittedCancel.body.totalMinor], ["cancelled", "frozen", 10500]);
    assert.equal(await db.auditEvent.count({ where: { action: "cancelled" } }), 2);
  });

  await check("concurrency: parallel saves with one version → one success, one VERSION_CONFLICT", async () => {
    const draft = (await call("/orders", { actor: lantern, method: "POST", body: {}, key: randomUUID() })).body;
    const results = await Promise.all(
      [lov, swaGi].map((v) =>
        call(`/orders/${draft.id}/lines`, { actor: lantern, method: "PUT", body: { version: 1, lines: [{ variantId: v.id, quantity: 1 }] } }),
      ),
    );
    const statuses = results.map((r) => (r.status === 200 ? "200" : r.body.code)).sort();
    assert.deepEqual(statuses, ["200", "VERSION_CONFLICT"], statuses.join(","));
    const stored = await db.order.findUniqueOrThrow({ where: { id: draft.id }, include: { lines: true } });
    assert.deepEqual([stored.version, stored.lines.length], [2, 1]);
  });

  await check("concurrency: parallel identical submissions with one key submit once", async () => {
    const draft = (await call("/orders", { actor: keep, method: "POST", body: { lines: [{ variantId: tkc.id, quantity: 3 }] }, key: randomUUID() })).body;
    const key = randomUUID();
    const body = { version: 1, reviewedPrices: reviewed(draft) };
    const results = await Promise.all(Array.from({ length: 5 }, () => call(`/orders/${draft.id}/submit`, { actor: keep, method: "POST", body, key })));
    assert.ok(results.some((r) => r.status === 200));
    assert.ok(results.every((r) => r.status === 200 || r.body.code === "REQUEST_IN_PROGRESS"), results.map((r) => r.status).join(","));
    const stored = await db.order.findUniqueOrThrow({ where: { id: draft.id } });
    assert.deepEqual([stored.status, stored.version], ["SUBMITTED", 2]);
    assert.equal(await db.auditEvent.count({ where: { entityId: draft.id, action: "submitted" } }), 1);
  });

  await check("rollback: an audit failure leaves the draft unsubmitted, unfrozen, and the key reusable", async () => {
    const draft = (await call("/orders", { actor: lantern, method: "POST", body: { lines: [{ variantId: swaGi.id, quantity: 1 }] }, key: randomUUID() })).body;
    const key = randomUUID();
    const body = { version: 1, reviewedPrices: reviewed(draft) };
    await db.$executeRaw`CREATE FUNCTION reject_orders_check_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected QA audit failure'; END; $$`;
    await db.$executeRaw`CREATE TRIGGER reject_orders_check_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_orders_check_audit()`;
    try {
      assertError(await call(`/orders/${draft.id}/submit`, { actor: lantern, method: "POST", body, key }), 500, "INTERNAL_ERROR");
      const stored = await db.order.findUniqueOrThrow({ where: { id: draft.id }, include: { lines: true } });
      assert.deepEqual([stored.status, stored.version, stored.totalMinor], ["DRAFT", 1, null]);
      assert.ok(stored.lines.every((line) => line.sku === null));
      assert.equal(await db.idempotencyRecord.count({ where: { key } }), 0);
    } finally {
      await db.$executeRaw`DROP TRIGGER reject_orders_check_audit ON audit_events`;
      await db.$executeRaw`DROP FUNCTION reject_orders_check_audit()`;
    }
    assert.equal((await call(`/orders/${draft.id}/submit`, { actor: lantern, method: "POST", body, key })).status, 200);
  });

  await check("database rejects edits to frozen orders, non-retailer orders, and invalid lifecycle data", async () => {
    const submitted = await orderByNumber("PO-000001");
    const frozenLine = submitted.lines[0];
    await assert.rejects(db.$executeRaw`UPDATE order_lines SET quantity = 99 WHERE id = ${frozenLine.id}::uuid`);
    await assert.rejects(db.$executeRaw`DELETE FROM order_lines WHERE id = ${frozenLine.id}::uuid`);
    await assert.rejects(db.$executeRaw`INSERT INTO order_lines (order_id, variant_id, quantity) VALUES (${submitted.id}::uuid, ${swaGi.id}::uuid, 1)`);
    await assert.rejects(db.$executeRaw`UPDATE orders SET total_minor = 1 WHERE id = ${submitted.id}::uuid`);
    const distributor = await db.organization.findFirstOrThrow({ where: { type: "DISTRIBUTOR" } });
    const user = await db.user.findFirstOrThrow({ where: { email: "operator@pandora.test" } });
    await assert.rejects(
      db.$executeRaw`INSERT INTO orders (organization_id, status, currency, created_by_id, created_at, updated_at) VALUES (${distributor.id}::uuid, 'DRAFT', 'EUR', ${user.id}::uuid, now(), now())`,
    );
    const empty = (await call("/orders", { actor: lantern, method: "POST", body: {}, key: randomUUID() })).body;
    await assert.rejects(
      db.$executeRaw`UPDATE orders SET status = 'SUBMITTED', submitted_at = now(), submitted_by_id = created_by_id, total_minor = 0 WHERE id = ${empty.id}::uuid`,
    );
    const cancelled = await orderByNumber("PO-000003");
    await assert.rejects(db.$executeRaw`UPDATE orders SET cancellation_reason = 'edited' WHERE id = ${cancelled.id}::uuid`);
  });

  await check("orders never create reservations or inventory movements", async () => {
    assert.deepEqual(await stockSnapshot(), stockBefore);
  });

  await check("list: status filter, pagination, newest first; invalid filters 422", async () => {
    const drafts = await call("/orders?status=draft", { actor: lantern });
    assert.ok(drafts.body.items.every((o) => o.status === "draft"));
    const all = await call("/orders?pageSize=20", { actor: operator });
    const created = all.body.items.map((o) => o.createdAt);
    assert.deepEqual(created, [...created].sort().reverse());
    const page2 = await call("/orders?page=2&pageSize=20", { actor: operator });
    assert.deepEqual([page2.body.items.length, page2.body.total], [Math.max(0, all.body.total - 20), all.body.total]);
    for (const query of ["status=confirmed", "pageSize=10", "page=0", "other=1"]) {
      assertError(await call(`/orders?${query}`, { actor: lantern }), 422, "VALIDATION_FAILED");
    }
    assertError(await call("/orders/not-a-uuid", { actor: lantern }), 422, "VALIDATION_FAILED");
    assertError(await call(`/orders/${randomUUID()}`, { actor: lantern }), 404, "NOT_FOUND");
  });

  await check("OpenAPI documents order routes, Idempotency-Key on create/submit/cancel", async () => {
    const document = await (await fetch(`${origin}/openapi.json`)).json();
    assert.ok(document.paths["/api/orders"].get && document.paths["/api/orders"].post);
    assert.ok(document.paths["/api/orders/{orderId}"].get);
    assert.ok(document.paths["/api/orders/{orderId}/lines"].put);
    for (const [route, method] of [["/api/orders", "post"], ["/api/orders/{orderId}/submit", "post"], ["/api/orders/{orderId}/cancel", "post"]]) {
      assert.ok(document.paths[route][method].parameters.some((p) => p.in === "header" && p.name === "Idempotency-Key"), route);
    }
  });

  assert.ok(!/pandora-demo|argon2|pandora_session=/.test(logs), "logs must not contain credentials or tokens");
  console.log(`\n${passed} order check groups passed.`);
} catch (error) {
  console.error(logs.slice(-4000));
  throw error;
} finally {
  server.kill("SIGTERM");
  await db.$disconnect();
}
