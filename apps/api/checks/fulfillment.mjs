// Shipment and cancellation-request checks against an isolated, empty QA database.
// Usage: see context/features/fulfillment-verification.md.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { orderSchema } from "@pandora/contracts";
import { assertError, startQaApi } from "./harness.mjs";

const qa = await startQaApi({
  databaseEnv: "FULFILLMENT_CHECK_DATABASE",
  databasePattern: /^pandora_fulfillment_check_[a-z0-9_]+$/,
  portEnv: "FULFILLMENT_CHECK_PORT",
  defaultPort: "3016",
});
const { db, call, login, check } = qa;

const itemBySku = (sku) =>
  db.inventoryItem.findFirstOrThrow({ where: { variant: { sku } }, select: { variantId: true, sellable: true, reserved: true, damaged: true } });
const available = (item) => item.sellable - item.reserved;
const orderById = (id) => db.order.findUniqueOrThrow({ where: { id }, include: { lines: { include: { reservation: true } } } });
const post = (actor, path, body, key = randomUUID()) => call(path, { actor, method: "POST", body, key });
const stockState = async () => ({
  items: await db.inventoryItem.findMany({ select: { variantId: true, sellable: true, reserved: true }, orderBy: { variantId: "asc" } }),
  movements: await db.inventoryMovement.count(),
  shipments: await db.shipment.count(),
  requests: await db.cancellationRequest.findMany({ select: { id: true, status: true }, orderBy: { id: "asc" } }),
});

async function invariantsHold() {
  const stock = await db.$queryRaw`
    SELECT bool_and(
      i.sellable = COALESCE((SELECT SUM(delta) FROM inventory_movements m WHERE m.variant_id = i.variant_id AND m.bucket = 'SELLABLE'), 0)
      AND i.reserved = COALESCE((SELECT SUM(delta) FROM inventory_movements m WHERE m.variant_id = i.variant_id AND m.bucket = 'RESERVED'), 0)
      AND i.reserved = COALESCE((SELECT SUM(r.quantity_reserved - r.quantity_consumed - r.quantity_released)
        FROM stock_reservations r WHERE r.variant_id = i.variant_id), 0)
      AND i.reserved <= i.sellable) AS ok
    FROM inventory_items i`;
  assert.equal(stock[0].ok, true, "stock invariants");
  const lines = await db.$queryRaw`
    SELECT bool_and(r.quantity_consumed = l.shipped_quantity AND r.quantity_released = l.cancelled_quantity
      AND l.shipped_quantity = COALESCE((SELECT SUM(si.quantity) FROM shipment_items si WHERE si.order_line_id = l.id), 0)) AS ok
    FROM order_lines l JOIN stock_reservations r ON r.order_line_id = l.id`;
  assert.equal(lines[0].ok, true, "line, reservation, and shipment totals agree");
}

let operator;
let lantern;
async function confirmedOrder(actor, lines) {
  const draft = await post(actor, "/orders", { lines });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const submitted = await post(actor, `/orders/${draft.body.id}/submit`, {
    version: 1,
    reviewedPrices: draft.body.lines.map((l) => ({ variantId: l.variantId, unitPriceMinor: l.unitPriceMinor })),
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const confirmed = await post(operator, `/orders/${draft.body.id}/confirm`, { version: 2 });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return confirmed.body;
}
const allOutstanding = (order) => order.lines.map((l) => ({ orderLineId: l.id, quantity: l.outstandingQuantity }));

try {
  operator = await login("operator@pandora.test");
  const admin = await login("admin@pandora.test");
  lantern = await login("retailer@tabletop-lantern.test");
  const keep = await login("retailer@cardboard-keep.test");
  const po8 = await db.order.findUniqueOrThrow({ where: { number: "PO-000008" } });
  const po9 = await db.order.findUniqueOrThrow({ where: { number: "PO-000009" } });
  const lov = await itemBySku("LOV-EN-STD");
  const cwo = await itemBySku("CWO-EN-STD");
  const tkc = await itemBySku("TKC-EN-STD");

  await check("seed: partially shipped PO-000008 (SH-000001) and PO-000009 with a pending request; invariants hold", async () => {
    const detail = (await call(`/orders/${po8.id}`, { actor: lantern })).body;
    orderSchema.parse(detail);
    assert.deepEqual([detail.status, detail.lines[0].shippedQuantity, detail.lines[0].outstandingQuantity], ["partially_shipped", 2, 3]);
    assert.deepEqual(detail.shipments.map((s) => s.number), ["SH-000001"]);
    const pending = (await call(`/orders/${po9.id}`, { actor: keep })).body;
    assert.deepEqual([pending.status, pending.cancellationRequests.map((r) => r.status)], ["confirmed", ["pending"]]);
    await invariantsHold();
  });

  await check("access: only staff ship and decide, only the owning retailer requests; CSRF and keys required", async () => {
    const line = (await orderById(po8.id)).lines[0];
    const before = await stockState();
    const shipBody = { version: 4, items: [{ orderLineId: line.id, quantity: 1 }] };
    assertError(await post(lantern, `/orders/${po8.id}/shipments`, shipBody), 403, "FORBIDDEN");
    assertError(await call(`/orders/${po8.id}/shipments`, { method: "POST", body: shipBody, key: randomUUID() }), 401, "UNAUTHENTICATED");
    assertError(await call(`/orders/${po8.id}/shipments`, { actor: operator, method: "POST", body: shipBody, key: randomUUID(), csrf: false }), 403, "CSRF_TOKEN_INVALID");
    assertError(await call(`/orders/${po8.id}/shipments`, { actor: operator, method: "POST", body: shipBody }), 400, "IDEMPOTENCY_KEY_REQUIRED");
    assertError(await post(operator, `/orders/${po8.id}/cancellation-requests`, { version: 4 }), 403, "FORBIDDEN");
    assertError(await post(keep, `/orders/${po8.id}/cancellation-requests`, { version: 4 }), 404, "NOT_FOUND");
    const request = (await db.cancellationRequest.findFirstOrThrow({ where: { orderId: po9.id } })).id;
    assertError(await post(keep, `/orders/${po9.id}/cancellation-requests/${request}/approve`, { version: 4 }), 403, "FORBIDDEN");
    assertError(await post(operator, `/orders/${po9.id}/cancellation-requests/${randomUUID()}/approve`, { version: 4 }), 404, "NOT_FOUND");
    assert.deepEqual(await stockState(), before);
  });

  await check("shipment validation: unknown or foreign lines, bad quantities, duplicates, and over-shipping have no effect", async () => {
    const own = await orderById(po8.id);
    const foreignLine = (await orderById(po9.id)).lines[0];
    const before = await stockState();
    for (const items of [
      [],
      [{ orderLineId: randomUUID(), quantity: 1 }],
      [{ orderLineId: foreignLine.id, quantity: 1 }],
      [{ orderLineId: own.lines[0].id, quantity: 0 }],
      [{ orderLineId: own.lines[0].id, quantity: -1 }],
      [{ orderLineId: own.lines[0].id, quantity: 1.5 }],
      [{ orderLineId: own.lines[0].id, quantity: 1 }, { orderLineId: own.lines[0].id, quantity: 1 }],
    ]) {
      assertError(await post(operator, `/orders/${po8.id}/shipments`, { version: 4, items }), 422, "VALIDATION_FAILED");
    }
    const over = await post(operator, `/orders/${po8.id}/shipments`, { version: 4, items: [{ orderLineId: own.lines[0].id, quantity: 4 }] });
    assertError(over, 409, "SHIPMENT_QUANTITY_EXCEEDED");
    assert.deepEqual(over.body.details, [{ field: "lines.LOV-EN-STD", message: "Only 3 left to ship." }]);
    assertError(await post(operator, `/orders/${po8.id}/shipments`, { version: 3, items: [{ orderLineId: own.lines[0].id, quantity: 1 }] }), 409, "VERSION_CONFLICT");
    assert.deepEqual(await stockState(), before);
  });

  await check("partial then full shipment: stock and reservations consumed, availability unchanged, status derived, replay no-op", async () => {
    const order = await confirmedOrder(lantern, [
      { variantId: cwo.variantId, quantity: 4 },
      { variantId: tkc.variantId, quantity: 3 },
    ]);
    const cwoLine = order.lines.find((l) => l.sku === "CWO-EN-STD");
    const tkcLine = order.lines.find((l) => l.sku === "TKC-EN-STD");
    const cwoBefore = await itemBySku("CWO-EN-STD");
    const key = randomUUID();
    const body = { version: 3, items: [{ orderLineId: cwoLine.id, quantity: 1 }] };
    const partial = await post(operator, `/orders/${order.id}/shipments`, body, key);
    assert.equal(partial.status, 200, JSON.stringify(partial.body));
    assert.equal(partial.body.status, "partially_shipped");
    assert.match(partial.body.shipments[0].number, /^SH-00\d{4}$/);
    const cwoAfter = await itemBySku("CWO-EN-STD");
    assert.deepEqual([cwoAfter.sellable, cwoAfter.reserved, available(cwoAfter)], [cwoBefore.sellable - 1, cwoBefore.reserved - 1, available(cwoBefore)]);
    const movements = await db.inventoryMovement.findMany({ where: { reference: partial.body.shipments[0].number } });
    assert.deepEqual(movements.map((m) => `${m.type}/${m.bucket}/${m.delta}`).sort(), ["SHIPMENT/RESERVED/-1", "SHIPMENT/SELLABLE/-1"]);
    const replay = await post(operator, `/orders/${order.id}/shipments`, body, key);
    assert.deepEqual(replay.body, partial.body);
    assert.equal(await db.shipment.count({ where: { orderId: order.id } }), 1);
    const full = await post(operator, `/orders/${order.id}/shipments`, { version: 4, items: allOutstanding(partial.body).filter((i) => i.quantity > 0) });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    assert.equal(full.body.status, "shipped");
    assert.ok(full.body.lines.every((l) => l.outstandingQuantity === 0 && l.reservedQuantity === 0));
    assert.equal(full.body.lines.find((l) => l.id === tkcLine.id).shippedQuantity, 3);
    assert.equal(await db.auditEvent.count({ where: { entityId: order.id, action: "shipped" } }), 2);
    assertError(await post(operator, `/orders/${order.id}/shipments`, { version: 5, items: [{ orderLineId: cwoLine.id, quantity: 1 }] }), 409, "INVALID_ORDER_TRANSITION");
    assertError(await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 5 }), 409, "INVALID_ORDER_TRANSITION");
    await invariantsHold();
  });

  await check("request then approve with nothing shipped: order cancelled, reservations released, availability restored", async () => {
    const tkcBefore = await itemBySku("TKC-EN-STD");
    const order = await confirmedOrder(lantern, [{ variantId: tkc.variantId, quantity: 4 }]);
    assert.equal(available(await itemBySku("TKC-EN-STD")), available(tkcBefore) - 4);
    const requested = await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 3, reason: "  Event cancelled  " });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    assert.deepEqual([requested.body.status, requested.body.cancellationRequests[0].reason], ["confirmed", "Event cancelled"]);
    assert.equal(available(await itemBySku("TKC-EN-STD")), available(tkcBefore) - 4, "pending request releases nothing");
    const requestId = requested.body.cancellationRequests[0].id;
    const approved = await post(admin, `/orders/${order.id}/cancellation-requests/${requestId}/approve`, { version: 4 });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(
      [approved.body.status, approved.body.cancelledBy.displayName, approved.body.cancellationReason, approved.body.lines[0].cancelledQuantity],
      ["cancelled", "Ada Administrator", "Event cancelled", 4],
    );
    assert.equal(available(await itemBySku("TKC-EN-STD")), available(tkcBefore));
    const release = await db.inventoryMovement.findFirstOrThrow({ where: { type: "RELEASE", reference: order.number } });
    assert.deepEqual([release.bucket, release.delta], ["RESERVED", -4]);
    assertError(await post(admin, `/orders/${order.id}/cancellation-requests/${requestId}/approve`, { version: 5 }), 409, "INVALID_ORDER_TRANSITION");
    await invariantsHold();
  });

  await check("shipment after a request makes approval conflict; reject, re-request, approve → closed_partial", async () => {
    const order = await confirmedOrder(lantern, [{ variantId: lov.variantId, quantity: 3 }]);
    const line = order.lines[0];
    await post(operator, `/orders/${order.id}/shipments`, { version: 3, items: [{ orderLineId: line.id, quantity: 1 }] });
    const requested = await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 4 });
    assert.deepEqual(requested.body.cancellationRequests[0].items.map((i) => i.quantity), [2]);
    assertError(await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 5 }), 409, "CANCELLATION_REQUEST_PENDING");
    const shippedMeanwhile = await post(operator, `/orders/${order.id}/shipments`, { version: 5, items: [{ orderLineId: line.id, quantity: 1 }] });
    assert.equal(shippedMeanwhile.status, 200, "shipping continues while a request is pending");
    const before = await stockState();
    const requestId = requested.body.cancellationRequests[0].id;
    const conflict = await post(operator, `/orders/${order.id}/cancellation-requests/${requestId}/approve`, { version: 6 });
    assertError(conflict, 409, "CANCELLATION_CONFLICT");
    assert.deepEqual(await stockState(), before);
    assertError(await post(operator, `/orders/${order.id}/cancellation-requests/${requestId}/reject`, { version: 6, reason: "no" }), 422, "VALIDATION_FAILED");
    const rejected = await post(operator, `/orders/${order.id}/cancellation-requests/${requestId}/reject`, { version: 6, reason: "Already shipped partly" });
    assert.deepEqual([rejected.body.status, rejected.body.cancellationRequests[0].status], ["partially_shipped", "rejected"]);
    assert.deepEqual(await stockState(), { ...before, requests: (await stockState()).requests });
    const again = await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 7 });
    const approved = await post(operator, `/orders/${order.id}/cancellation-requests/${again.body.cancellationRequests.at(-1).id}/approve`, { version: 8 });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(
      [approved.body.status, approved.body.lines[0].shippedQuantity, approved.body.lines[0].cancelledQuantity, approved.body.lines[0].outstandingQuantity],
      ["closed_partial", 2, 1, 0],
    );
    assertError(await post(operator, `/orders/${order.id}/shipments`, { version: 9, items: [{ orderLineId: line.id, quantity: 1 }] }), 409, "INVALID_ORDER_TRANSITION");
    await invariantsHold();
  });

  await check("selected cancellation validation: bad items return 422, over-quantity 409, nothing changes", async () => {
    const order = await confirmedOrder(lantern, [
      { variantId: cwo.variantId, quantity: 2 },
      { variantId: tkc.variantId, quantity: 3 },
    ]);
    const cwoLine = order.lines.find((l) => l.sku === "CWO-EN-STD");
    const foreignLine = (await orderById(po9.id)).lines[0];
    const before = await stockState();
    for (const items of [
      [],
      [{ orderLineId: randomUUID(), quantity: 1 }],
      [{ orderLineId: foreignLine.id, quantity: 1 }],
      [{ orderLineId: cwoLine.id, quantity: 0 }],
      [{ orderLineId: cwoLine.id, quantity: -1 }],
      [{ orderLineId: cwoLine.id, quantity: 1.5 }],
      [{ orderLineId: cwoLine.id, quantity: 1, sku: "CWO-EN-STD" }],
      [{ orderLineId: cwoLine.id, quantity: 1 }, { orderLineId: cwoLine.id, quantity: 1 }],
    ]) {
      assertError(await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 3, items }), 422, "VALIDATION_FAILED");
    }
    const over = await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 3, items: [{ orderLineId: cwoLine.id, quantity: 3 }] });
    assertError(over, 409, "CANCELLATION_QUANTITY_EXCEEDED");
    assert.deepEqual(over.body.details, [{ field: "lines.CWO-EN-STD", message: "Only 2 left to cancel." }]);
    assertError(await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 2, items: [{ orderLineId: cwoLine.id, quantity: 1 }] }), 409, "VERSION_CONFLICT");
    assert.deepEqual(await stockState(), before);
    assert.equal((await orderById(order.id)).version, 3);
  });

  await check("selected cancellation: approval releases only the requested units; the rest ships and closes partial", async () => {
    const order = await confirmedOrder(lantern, [
      { variantId: cwo.variantId, quantity: 2 },
      { variantId: tkc.variantId, quantity: 3 },
    ]);
    const tkcLine = order.lines.find((l) => l.sku === "TKC-EN-STD");
    const tkcBefore = await itemBySku("TKC-EN-STD");
    const key = randomUUID();
    const body = { version: 3, reason: "Two copies are enough", items: [{ orderLineId: tkcLine.id, quantity: 1 }] };
    const requested = await post(lantern, `/orders/${order.id}/cancellation-requests`, body, key);
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    assert.deepEqual(requested.body.cancellationRequests[0].items.map((i) => [i.sku, i.quantity]), [["TKC-EN-STD", 1]]);
    assert.deepEqual((await post(lantern, `/orders/${order.id}/cancellation-requests`, body, key)).body, requested.body, "replay");
    assert.equal(await db.cancellationRequest.count({ where: { orderId: order.id } }), 1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: order.id, action: "cancellation_requested" } });
    assert.deepEqual([audit.after.scope, audit.after.requested], ["selected", { "TKC-EN-STD": 1 }]);

    const approved = await post(operator, `/orders/${order.id}/cancellation-requests/${requested.body.cancellationRequests[0].id}/approve`, { version: 4 });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const bySku = Object.fromEntries(approved.body.lines.map((l) => [l.sku, [l.cancelledQuantity, l.outstandingQuantity, l.reservedQuantity]]));
    assert.deepEqual(bySku, { "CWO-EN-STD": [0, 2, 2], "TKC-EN-STD": [1, 2, 2] });
    assert.deepEqual([approved.body.status, approved.body.cancelledBy, approved.body.cancellationReason], ["confirmed", null, null]);
    assert.equal(available(await itemBySku("TKC-EN-STD")), available(tkcBefore) + 1);
    const releases = await db.inventoryMovement.findMany({ where: { type: "RELEASE", reference: order.number } });
    assert.deepEqual(releases.map((m) => m.delta), [-1]);

    const shipped = await post(operator, `/orders/${order.id}/shipments`, { version: 5, items: allOutstanding(approved.body) });
    assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
    assert.equal(shipped.body.status, "closed_partial");
    await invariantsHold();
  });

  await check("partially shipped: a partial approval keeps the order open; an overtaken request conflicts; omitting items cancels the rest", async () => {
    const order = await confirmedOrder(lantern, [{ variantId: lov.variantId, quantity: 5 }]);
    const line = order.lines[0];
    const only = (quantity) => [{ orderLineId: line.id, quantity }];
    assert.equal((await post(operator, `/orders/${order.id}/shipments`, { version: 3, items: only(1) })).status, 200);
    const first = await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 4, items: only(2) });
    const approved = await post(operator, `/orders/${order.id}/cancellation-requests/${first.body.cancellationRequests[0].id}/approve`, { version: 5 });
    assert.deepEqual(
      [approved.body.status, approved.body.lines[0].shippedQuantity, approved.body.lines[0].cancelledQuantity, approved.body.lines[0].outstandingQuantity],
      ["partially_shipped", 1, 2, 2],
    );

    const second = await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 6, items: only(2) });
    assert.equal(second.status, 200, "a new request is possible after a decision");
    assert.equal((await post(operator, `/orders/${order.id}/shipments`, { version: 7, items: only(1) })).status, 200);
    const before = await stockState();
    const secondId = second.body.cancellationRequests.at(-1).id;
    const conflict = await post(operator, `/orders/${order.id}/cancellation-requests/${secondId}/approve`, { version: 8 });
    assertError(conflict, 409, "CANCELLATION_CONFLICT");
    assert.deepEqual(conflict.body.details, [{ field: "lines.LOV-EN-STD", message: "Requested 2, only 1 still outstanding." }]);
    assert.deepEqual(await stockState(), before);
    await post(operator, `/orders/${order.id}/cancellation-requests/${secondId}/reject`, { version: 8, reason: "One more unit already shipped" });

    const rest = await post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 9 });
    assert.deepEqual(rest.body.cancellationRequests.at(-1).items.map((i) => i.quantity), [1]);
    const restAudit = await db.auditEvent.findMany({ where: { entityId: order.id, action: "cancellation_requested" } });
    assert.deepEqual(restAudit.map((event) => event.after.scope).sort(), ["all_remaining", "selected", "selected"]);
    const closed = await post(operator, `/orders/${order.id}/cancellation-requests/${rest.body.cancellationRequests.at(-1).id}/approve`, { version: 10 });
    assert.deepEqual(
      [closed.body.status, closed.body.lines[0].shippedQuantity, closed.body.lines[0].cancelledQuantity, closed.body.lines[0].outstandingQuantity],
      ["closed_partial", 2, 3, 0],
    );
    await invariantsHold();
  });

  await check("concurrency: parallel shipments of the last units never over-ship", async () => {
    const order = await confirmedOrder(lantern, [{ variantId: cwo.variantId, quantity: 2 }]);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => post(operator, `/orders/${order.id}/shipments`, { version: 3, items: allOutstanding(order) })),
    );
    const outcomes = results.map((r) => (r.status === 200 ? "200" : r.body.code));
    assert.equal(outcomes.filter((o) => o === "200").length, 1, outcomes.join(","));
    assert.ok(outcomes.every((o) => ["200", "VERSION_CONFLICT", "INVALID_ORDER_TRANSITION", "SHIPMENT_QUANTITY_EXCEEDED", "CONCURRENT_MODIFICATION"].includes(o)), outcomes.join(","));
    const stored = await orderById(order.id);
    assert.deepEqual([stored.status, stored.lines[0].shippedQuantity], ["SHIPPED", 2]);
    await invariantsHold();
  });

  await check("concurrency: parallel duplicate requests leave exactly one pending; a shipment racing approval never double-counts", async () => {
    const order = await confirmedOrder(lantern, [{ variantId: tkc.variantId, quantity: 2 }]);
    const requests = await Promise.all(Array.from({ length: 3 }, () => post(lantern, `/orders/${order.id}/cancellation-requests`, { version: 3 })));
    const outcomes = requests.map((r) => (r.status === 200 ? "200" : r.body.code));
    assert.equal(outcomes.filter((o) => o === "200").length, 1, outcomes.join(","));
    assert.equal(await db.cancellationRequest.count({ where: { orderId: order.id, status: "PENDING" } }), 1);
    const requestId = (await db.cancellationRequest.findFirstOrThrow({ where: { orderId: order.id } })).id;
    const line = (await orderById(order.id)).lines[0];
    const [approval, shipment] = await Promise.all([
      post(operator, `/orders/${order.id}/cancellation-requests/${requestId}/approve`, { version: 4 }),
      post(admin, `/orders/${order.id}/shipments`, { version: 4, items: [{ orderLineId: line.id, quantity: 2 }] }),
    ]);
    assert.equal([approval, shipment].filter((r) => r.status === 200).length, 1, `${approval.status}/${shipment.status}`);
    const stored = await orderById(order.id);
    assert.equal(stored.lines[0].shippedQuantity + stored.lines[0].cancelledQuantity, 2);
    assert.ok(["CANCELLED", "SHIPPED"].includes(stored.status));
    await invariantsHold();
  });

  await check("rollback: an audit failure leaves no shipment, movement, or stock change; the key stays usable", async () => {
    const order = await confirmedOrder(lantern, [{ variantId: lov.variantId, quantity: 1 }]);
    const key = randomUUID();
    const body = { version: 3, items: allOutstanding(order) };
    const before = await stockState();
    await db.$executeRaw`CREATE FUNCTION reject_fulfillment_check_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected QA audit failure'; END; $$`;
    await db.$executeRaw`CREATE TRIGGER reject_fulfillment_check_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_fulfillment_check_audit()`;
    try {
      assertError(await post(operator, `/orders/${order.id}/shipments`, body, key), 500, "INTERNAL_ERROR");
      assert.deepEqual(await stockState(), before);
      assert.equal((await orderById(order.id)).status, "CONFIRMED");
      assert.equal(await db.idempotencyRecord.count({ where: { key } }), 0);
    } finally {
      await db.$executeRaw`DROP TRIGGER reject_fulfillment_check_audit ON audit_events`;
      await db.$executeRaw`DROP FUNCTION reject_fulfillment_check_audit()`;
    }
    assert.equal((await post(operator, `/orders/${order.id}/shipments`, body, key)).status, 200);
    await invariantsHold();
  });

  await check("database rejects over-shipping, shrinking totals, edited shipments, mismatched statuses, and cross-order items", async () => {
    const order = await confirmedOrder(lantern, [{ variantId: cwo.variantId, quantity: 2 }]);
    const line = (await orderById(order.id)).lines[0];
    await assert.rejects(db.$executeRaw`UPDATE order_lines SET shipped_quantity = 3 WHERE id = ${line.id}::uuid`);
    await assert.rejects(db.$executeRaw`UPDATE orders SET status = 'SHIPPED' WHERE id = ${order.id}::uuid`, /does not match its quantities/);
    const shipped = await post(operator, `/orders/${order.id}/shipments`, { version: 3, items: [{ orderLineId: line.id, quantity: 1 }] });
    assert.equal(shipped.status, 200);
    await assert.rejects(db.$executeRaw`UPDATE order_lines SET shipped_quantity = 0 WHERE id = ${line.id}::uuid`);
    const shipment = await db.shipment.findFirstOrThrow({ where: { orderId: order.id } });
    await assert.rejects(db.$executeRaw`UPDATE shipment_items SET quantity = 2 WHERE shipment_id = ${shipment.id}::uuid`);
    await assert.rejects(db.$executeRaw`DELETE FROM shipments WHERE id = ${shipment.id}::uuid`);
    const foreignLine = (await orderById(po9.id)).lines[0];
    await assert.rejects(db.$executeRaw`INSERT INTO shipment_items (shipment_id, order_line_id, quantity) VALUES (${shipment.id}::uuid, ${foreignLine.id}::uuid, 1)`);
    const pending = await db.cancellationRequest.findFirstOrThrow({ where: { orderId: po9.id } });
    await assert.rejects(
      db.$executeRaw`INSERT INTO cancellation_requests (order_id, status, requested_by_id, requested_at) SELECT ${po9.id}::uuid, 'PENDING', requested_by_id, now() FROM cancellation_requests WHERE id = ${pending.id}::uuid`,
      "only one pending request per order",
    );
    await assert.rejects(db.$executeRaw`UPDATE cancellation_requests SET status = 'APPROVED' WHERE id = ${pending.id}::uuid`, "decision data required");
    await assert.rejects(db.$executeRaw`DELETE FROM stock_reservations WHERE order_line_id = ${line.id}::uuid`, /append-only/);
    await invariantsHold();
  });

  await check("OpenAPI documents shipments and cancellation requests with the Idempotency-Key header", async () => {
    const document = await (await fetch(`${qa.origin}/openapi.json`)).json();
    for (const route of [
      "/api/orders/{orderId}/shipments",
      "/api/orders/{orderId}/cancellation-requests",
      "/api/orders/{orderId}/cancellation-requests/{requestId}/approve",
      "/api/orders/{orderId}/cancellation-requests/{requestId}/reject",
    ]) {
      const operation = document.paths[route]?.post;
      assert.ok(operation, route);
      assert.ok(operation.parameters.some((p) => p.in === "header" && p.name === "Idempotency-Key"), route);
    }
  });

  assert.ok(!/pandora-demo|argon2|pandora_session=/.test(qa.logs()), "logs must not contain credentials or tokens");
  console.log(`\n${qa.passed} fulfillment check groups passed.`);
} catch (error) {
  console.error(qa.logs().slice(-4000));
  throw error;
} finally {
  await qa.stop();
}
