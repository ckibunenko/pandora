// Order confirmation (with stock reservation) and rejection checks against an isolated, empty QA database.
// Usage: see context/features/order-processing-verification.md.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { orderSchema } from "@pandora/contracts";
import { assertError, startQaApi } from "./harness.mjs";

const qa = await startQaApi({
  databaseEnv: "PROCESSING_CHECK_DATABASE",
  databasePattern: /^pandora_processing_check_[a-z0-9_]+$/,
  portEnv: "PROCESSING_CHECK_PORT",
  defaultPort: "3015",
});
const { db, call, login, check } = qa;

const itemBySku = (sku) =>
  db.inventoryItem.findFirstOrThrow({ where: { variant: { sku } }, select: { variantId: true, sellable: true, reserved: true, damaged: true } });
const orderByNumber = (number) => db.order.findUniqueOrThrow({ where: { number }, include: { lines: { include: { reservation: true } } } });
const stockState = async () => ({
  items: await db.inventoryItem.findMany({ select: { variantId: true, sellable: true, reserved: true, damaged: true }, orderBy: { variantId: "asc" } }),
  movements: await db.inventoryMovement.count(),
  reservations: await db.stockReservation.count(),
});
async function invariantsHold() {
  const rows = await db.$queryRaw`
    SELECT i.variant_id,
      i.reserved = COALESCE((SELECT SUM(delta) FROM inventory_movements m WHERE m.variant_id = i.variant_id AND m.bucket = 'RESERVED'), 0) AS movements_ok,
      i.reserved = COALESCE((SELECT SUM(r.quantity_reserved - r.quantity_consumed - r.quantity_released)
        FROM stock_reservations r WHERE r.variant_id = i.variant_id), 0) AS reservations_ok,
      i.reserved <= i.sellable AS within_sellable
    FROM inventory_items i`;
  assert.ok(rows.length > 0 && rows.every((row) => row.movements_ok && row.reservations_ok && row.within_sellable), "reserved stock invariants");
}

// Creates and submits an order as a retailer; returns the submitted order body.
async function submittedOrder(actor, lines) {
  const draft = await call("/orders", { actor, method: "POST", body: { lines }, key: randomUUID() });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const submitted = await call(`/orders/${draft.body.id}/submit`, {
    actor,
    method: "POST",
    body: { version: 1, reviewedPrices: draft.body.lines.map((l) => ({ variantId: l.variantId, unitPriceMinor: l.unitPriceMinor })) },
    key: randomUUID(),
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return submitted.body;
}

try {
  const operator = await login("operator@pandora.test");
  const admin = await login("admin@pandora.test");
  const lantern = await login("retailer@tabletop-lantern.test");
  const keep = await login("retailer@cardboard-keep.test");
  const po2 = await orderByNumber("PO-000002");
  const po5 = await orderByNumber("PO-000005");

  await check("seed: submitted, confirmed (with reservation), and rejected demo orders; invariants hold; reseed adds nothing", async () => {
    const po6 = await orderByNumber("PO-000006");
    assert.equal(po6.status, "CONFIRMED");
    assert.ok(po6.lines.every((line) => line.reservation?.quantityReserved === line.quantity));
    assert.deepEqual(await itemBySku("LOV-SR-STD"), { ...(await itemBySku("LOV-SR-STD")), sellable: 12, reserved: 2 });
    const po7 = await orderByNumber("PO-000007");
    assert.deepEqual([po7.status, po7.rejectionReason], ["REJECTED", "Duplicate of an earlier order"]);
    assert.equal(po5.status, "SUBMITTED");
    await invariantsHold();
    const before = await stockState();
    qa.seed();
    assert.deepEqual(await stockState(), before);
    assert.equal(await db.order.count(), 9);
  });

  await check("access: retailers 403, no session 401, CSRF and Idempotency-Key required; no side effects", async () => {
    const before = await stockState();
    for (const [path, body] of [
      [`/orders/${po2.id}/confirm`, { version: 2 }],
      [`/orders/${po2.id}/reject`, { version: 2, reason: "Not today" }],
    ]) {
      assertError(await call(path, { method: "POST", body, key: randomUUID() }), 401, "UNAUTHENTICATED");
      assertError(await call(path, { actor: lantern, method: "POST", body, key: randomUUID() }), 403, "FORBIDDEN");
      assertError(await call(path, { actor: operator, method: "POST", body, key: randomUUID(), csrf: false }), 403, "CSRF_TOKEN_INVALID");
      assertError(await call(path, { actor: operator, method: "POST", body }), 400, "IDEMPOTENCY_KEY_REQUIRED");
    }
    assert.deepEqual(await stockState(), before);
    assert.equal((await orderByNumber("PO-000002")).status, "SUBMITTED");
  });

  await check("queue: submitted orders oldest first; confirmed and rejected filters", async () => {
    const queue = await call("/orders?status=submitted&sort=submitted_asc", { actor: operator });
    assert.deepEqual(queue.body.items.map((o) => o.number), ["PO-000002", "PO-000005"]);
    const submittedAt = queue.body.items.map((o) => o.submittedAt);
    assert.deepEqual(submittedAt, [...submittedAt].sort());
    assert.deepEqual((await call("/orders?status=confirmed", { actor: admin })).body.items.map((o) => o.number), ["PO-000009", "PO-000006"]);
    assert.deepEqual((await call("/orders?status=rejected", { actor: operator })).body.items.map((o) => o.number), ["PO-000007"]);
    const detail = await call(`/orders/${po5.id}`, { actor: operator });
    assert.deepEqual(
      detail.body.lines.map((l) => `${l.sku}:${l.availableQuantity}:${l.reservedQuantity}`),
      ["CWO-EN-DLX:0:null", "LOV-SR-STD:10:null"],
    );
    assertError(await call("/orders?sort=random", { actor: operator }), 422, "VALIDATION_FAILED");
  });

  await check("insufficient stock: 409 names only the short SKU; nothing is reserved and the order stays submitted", async () => {
    const before = await stockState();
    const result = await call(`/orders/${po5.id}/confirm`, { actor: operator, method: "POST", body: { version: 2 }, key: randomUUID() });
    assertError(result, 409, "INSUFFICIENT_STOCK");
    assert.deepEqual(result.body.details, [{ field: "lines.CWO-EN-DLX", message: "Needs 2, only 0 available." }]);
    assert.deepEqual(await stockState(), before);
    const stored = await orderByNumber("PO-000005");
    assert.deepEqual([stored.status, stored.version], ["SUBMITTED", 2]);
    assert.equal(await db.idempotencyRecord.count({ where: { operation: "order.confirm", target: po5.id } }), 0);
  });

  await check("confirm: reserves every line atomically with movements and audit; availability drops; replay is a no-op", async () => {
    const cwoBefore = await itemBySku("CWO-EN-STD");
    const tkcBefore = await itemBySku("TKC-EN-STD");
    const movementsBefore = await db.inventoryMovement.count();
    const key = randomUUID();
    const result = await call(`/orders/${po2.id}/confirm`, { actor: operator, method: "POST", body: { version: 2 }, key });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    orderSchema.parse(result.body);
    assert.deepEqual([result.body.status, result.body.version, result.body.confirmedBy.displayName], ["confirmed", 3, "Oskar Operator"]);
    assert.deepEqual(result.body.lines.map((l) => `${l.sku}:${l.reservedQuantity}:${l.availableQuantity}`), ["CWO-EN-STD:3:null", "TKC-EN-STD:10:null"]);
    assert.deepEqual(await itemBySku("CWO-EN-STD"), { ...cwoBefore, reserved: cwoBefore.reserved + 3 });
    assert.deepEqual(await itemBySku("TKC-EN-STD"), { ...tkcBefore, reserved: tkcBefore.reserved + 10 });
    const movements = await db.inventoryMovement.findMany({ where: { reference: "PO-000002", type: "RESERVATION" } });
    assert.equal(movements.length, 2);
    assert.ok(movements.every((m) => m.bucket === "RESERVED" && m.reservationId && m.actorId && m.correlationId));
    assert.equal(await db.inventoryMovement.count(), movementsBefore + 2);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: po2.id, action: "confirmed" } });
    assert.deepEqual(audit.after.reserved, { "CWO-EN-STD": 3, "TKC-EN-STD": 10 });
    const catalog = await call("/catalog/products?q=CWO-EN-STD", { actor: lantern });
    assert.equal(catalog.body.items[0].variants.find((v) => v.sku === "CWO-EN-STD").availableQuantity, cwoBefore.sellable - cwoBefore.reserved - 3);
    const replay = await call(`/orders/${po2.id}/confirm`, { actor: operator, method: "POST", body: { version: 2 }, key });
    assert.deepEqual(replay.body, result.body);
    assert.equal(await db.inventoryMovement.count(), movementsBefore + 2);
    await invariantsHold();
  });

  await check("transitions: confirmed and rejected orders are final for these actions; stale versions conflict", async () => {
    assertError(await call(`/orders/${po2.id}/confirm`, { actor: admin, method: "POST", body: { version: 3 }, key: randomUUID() }), 409, "INVALID_ORDER_TRANSITION");
    assertError(await call(`/orders/${po2.id}/reject`, { actor: admin, method: "POST", body: { version: 3, reason: "Too late" }, key: randomUUID() }), 409, "INVALID_ORDER_TRANSITION");
    assertError(await call(`/orders/${po2.id}/cancel`, { actor: lantern, method: "POST", body: { version: 3 }, key: randomUUID() }), 409, "INVALID_ORDER_TRANSITION");
    assertError(await call(`/orders/${po2.id}/lines`, { actor: lantern, method: "PUT", body: { version: 3, lines: [] } }), 409, "INVALID_ORDER_TRANSITION");
    const po1 = await orderByNumber("PO-000001");
    assertError(await call(`/orders/${po1.id}/confirm`, { actor: operator, method: "POST", body: { version: 1 }, key: randomUUID() }), 409, "INVALID_ORDER_TRANSITION");
    assertError(await call(`/orders/${po5.id}/confirm`, { actor: operator, method: "POST", body: { version: 1 }, key: randomUUID() }), 409, "VERSION_CONFLICT");
    const po7 = await orderByNumber("PO-000007");
    assertError(await call(`/orders/${po7.id}/confirm`, { actor: operator, method: "POST", body: { version: 3 }, key: randomUUID() }), 409, "INVALID_ORDER_TRANSITION");
    assertError(await call(`/orders/${po7.id}/cancel`, { actor: keep, method: "POST", body: { version: 3 }, key: randomUUID() }), 409, "INVALID_ORDER_TRANSITION");
  });

  await check("reject: reason validated and trimmed; no stock effect; retailer sees the reason", async () => {
    const before = await stockState();
    for (const body of [{ version: 2 }, { version: 2, reason: "  " }, { version: 2, reason: "no" }, { version: 2, reason: "x".repeat(501) }, { version: 2, reason: "Fine", extra: 1 }]) {
      assertError(await call(`/orders/${po5.id}/reject`, { actor: operator, method: "POST", body, key: randomUUID() }), 422, "VALIDATION_FAILED");
    }
    const rejected = await call(`/orders/${po5.id}/reject`, { actor: admin, method: "POST", body: { version: 2, reason: "  Deluxe edition unavailable  " }, key: randomUUID() });
    assert.equal(rejected.status, 200);
    assert.deepEqual([rejected.body.status, rejected.body.rejectionReason, rejected.body.rejectedBy.displayName], ["rejected", "Deluxe edition unavailable", "Ada Administrator"]);
    assert.deepEqual(await stockState(), before);
    const seenByRetailer = await call(`/orders/${po5.id}`, { actor: keep });
    assert.deepEqual([seenByRetailer.body.status, seenByRetailer.body.rejectionReason], ["rejected", "Deluxe edition unavailable"]);
    assert.equal(await db.auditEvent.count({ where: { entityId: po5.id, action: "rejected" } }), 1);
  });

  await check("concurrency: orders competing for the last unit never oversell (exactly one confirmed)", async () => {
    const item = await itemBySku("SWA-GI-EN");
    const available = item.sellable - item.reserved;
    assert.equal(available, 1);
    const orders = [await submittedOrder(lantern, [{ variantId: item.variantId, quantity: 1 }]), await submittedOrder(keep, [{ variantId: item.variantId, quantity: 1 }])];
    const results = await Promise.all(
      orders.map((order) => call(`/orders/${order.id}/confirm`, { actor: operator, method: "POST", body: { version: 2 }, key: randomUUID() })),
    );
    const outcomes = results.map((r) => (r.status === 200 ? "200" : r.body.code)).sort();
    assert.equal(outcomes.filter((o) => o === "200").length, 1, outcomes.join(","));
    assert.ok(outcomes.every((o) => ["200", "INSUFFICIENT_STOCK", "CONCURRENT_MODIFICATION"].includes(o)), outcomes.join(","));
    const after = await itemBySku("SWA-GI-EN");
    assert.deepEqual([after.sellable, after.reserved], [item.sellable, item.reserved + 1]);
    await invariantsHold();
  });

  await check("concurrency: five orders for three units → exactly three confirmed", async () => {
    const item = await itemBySku("LOV-MD-EN");
    assert.equal(item.sellable - item.reserved, 3);
    const orders = [];
    for (let i = 0; i < 5; i += 1) orders.push(await submittedOrder(i % 2 ? keep : lantern, [{ variantId: item.variantId, quantity: 1 }]));
    const results = await Promise.all(
      orders.map((order) => call(`/orders/${order.id}/confirm`, { actor: operator, method: "POST", body: { version: 2 }, key: randomUUID() })),
    );
    const outcomes = results.map((r) => (r.status === 200 ? "200" : r.body.code));
    assert.equal(outcomes.filter((o) => o === "200").length, 3, outcomes.join(","));
    const after = await itemBySku("LOV-MD-EN");
    assert.deepEqual([after.reserved, after.sellable - after.reserved], [item.reserved + 3, 0]);
    await invariantsHold();
  });

  await check("concurrency: parallel confirmations of one order with different keys apply once", async () => {
    const order = await submittedOrder(lantern, [{ variantId: (await itemBySku("TKC-EN-STD")).variantId, quantity: 2 }]);
    const reservationsBefore = await db.stockReservation.count();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => call(`/orders/${order.id}/confirm`, { actor: operator, method: "POST", body: { version: 2 }, key: randomUUID() })),
    );
    const outcomes = results.map((r) => (r.status === 200 ? "200" : r.body.code));
    assert.equal(outcomes.filter((o) => o === "200").length, 1, outcomes.join(","));
    assert.ok(outcomes.every((o) => ["200", "INVALID_ORDER_TRANSITION", "VERSION_CONFLICT", "CONCURRENT_MODIFICATION"].includes(o)), outcomes.join(","));
    assert.equal(await db.stockReservation.count(), reservationsBefore + 1);
    await invariantsHold();
  });

  await check("rollback: an audit failure leaves no reservation, movement, stock change, or idempotency record", async () => {
    const order = await submittedOrder(keep, [{ variantId: (await itemBySku("CWO-EN-STD")).variantId, quantity: 1 }]);
    const key = randomUUID();
    const before = await stockState();
    await db.$executeRaw`CREATE FUNCTION reject_processing_check_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected QA audit failure'; END; $$`;
    await db.$executeRaw`CREATE TRIGGER reject_processing_check_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_processing_check_audit()`;
    try {
      assertError(await call(`/orders/${order.id}/confirm`, { actor: operator, method: "POST", body: { version: 2 }, key }), 500, "INTERNAL_ERROR");
      assert.deepEqual(await stockState(), before);
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "SUBMITTED");
      assert.equal(await db.idempotencyRecord.count({ where: { key } }), 0);
    } finally {
      await db.$executeRaw`DROP TRIGGER reject_processing_check_audit ON audit_events`;
      await db.$executeRaw`DROP FUNCTION reject_processing_check_audit()`;
    }
    assert.equal((await call(`/orders/${order.id}/confirm`, { actor: operator, method: "POST", body: { version: 2 }, key })).status, 200);
    await invariantsHold();
  });

  await check("database rejects reservations and transitions that break the rules", async () => {
    const draft = (await call("/orders", { actor: lantern, method: "POST", body: { lines: [{ variantId: (await itemBySku("LOV-EN-STD")).variantId, quantity: 1 }] }, key: randomUUID() })).body;
    const draftLine = await db.orderLine.findFirstOrThrow({ where: { orderId: draft.id } });
    await assert.rejects(
      db.$executeRaw`INSERT INTO stock_reservations (order_line_id, variant_id, quantity_reserved, created_at) VALUES (${draftLine.id}::uuid, ${draftLine.variantId}::uuid, 1, now())`,
      "draft lines cannot be reserved",
    );
    const submitted = await submittedOrder(lantern, [{ variantId: (await itemBySku("LOV-EN-STD")).variantId, quantity: 2 }]);
    const line = await db.orderLine.findFirstOrThrow({ where: { orderId: submitted.id } });
    await assert.rejects(
      db.$executeRaw`INSERT INTO stock_reservations (order_line_id, variant_id, quantity_reserved, created_at) VALUES (${line.id}::uuid, ${line.variantId}::uuid, 1, now())`,
      "a reservation must cover the whole line",
    );
    await assert.rejects(
      db.$executeRaw`UPDATE orders SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by_id = submitted_by_id WHERE id = ${submitted.id}::uuid`,
      "confirmation needs reservations",
    );
    const reservation = await db.stockReservation.findFirstOrThrow();
    await assert.rejects(db.$executeRaw`DELETE FROM stock_reservations WHERE id = ${reservation.id}::uuid`);
    await assert.rejects(db.$executeRaw`UPDATE stock_reservations SET quantity_reserved = quantity_reserved + 1 WHERE id = ${reservation.id}::uuid`);
    await assert.rejects(db.$executeRaw`UPDATE stock_reservations SET quantity_consumed = quantity_reserved + 1 WHERE id = ${reservation.id}::uuid`);
    await assert.rejects(db.$executeRaw`UPDATE orders SET status = 'SUBMITTED', confirmed_at = NULL, confirmed_by_id = NULL WHERE id = ${po2.id}::uuid`);
    await assert.rejects(db.$executeRaw`UPDATE orders SET rejection_reason = 'edited' WHERE number = 'PO-000007'`);
    const staff = await db.user.findUniqueOrThrow({ where: { email: "operator@pandora.test" } });
    await assert.rejects(
      db.$executeRaw`INSERT INTO inventory_movements (variant_id, type, bucket, delta, sellable_after, reserved_after, damaged_after, actor_id, organization_id, correlation_id, occurred_at)
        SELECT variant_id, 'RESERVATION', 'RESERVED', 1, sellable, reserved, damaged, ${staff.id}::uuid, ${staff.organizationId}::uuid, 'qa', now()
        FROM inventory_items WHERE sellable > reserved LIMIT 1`,
      /inventory_movements_type_rules/,
    );
    const adjust = await call(`/inventory/${line.variantId}/adjustments`, { actor: operator, method: "POST", body: { bucket: "reserved", delta: 1, reason: "Direct edit" }, key: randomUUID() });
    assertError(adjust, 422, "VALIDATION_FAILED");
    await invariantsHold();
  });

  await check("OpenAPI documents confirm and reject with the Idempotency-Key header", async () => {
    const document = await (await fetch(`${qa.origin}/openapi.json`)).json();
    for (const route of ["/api/orders/{orderId}/confirm", "/api/orders/{orderId}/reject"]) {
      const operation = document.paths[route]?.post;
      assert.ok(operation, route);
      assert.ok(operation.parameters.some((p) => p.in === "header" && p.name === "Idempotency-Key"), route);
    }
  });

  assert.ok(!/pandora-demo|argon2|pandora_session=/.test(qa.logs()), "logs must not contain credentials or tokens");
  console.log(`\n${qa.passed} order processing check groups passed.`);
} catch (error) {
  console.error(qa.logs().slice(-4000));
  throw error;
} finally {
  await qa.stop();
}
