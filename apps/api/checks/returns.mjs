// Return request, decision, and receipt checks against an isolated, empty QA database.
// Usage: see context/features/returns-verification.md.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { orderListResponseSchema, orderSchema } from "@pandora/contracts";
import { assertError, startQaApi } from "./harness.mjs";

const qa = await startQaApi({
  databaseEnv: "RETURNS_CHECK_DATABASE",
  databasePattern: /^pandora_returns_check_[a-z0-9_]+$/,
  portEnv: "RETURNS_CHECK_PORT",
  defaultPort: "3019",
});
const { db, call, login, check } = qa;

const itemBySku = (sku) =>
  db.inventoryItem.findFirstOrThrow({ where: { variant: { sku } }, select: { variantId: true, sellable: true, reserved: true, damaged: true } });
const post = (actor, path, body, key = randomUUID()) => call(path, { actor, method: "POST", body, key });
const outcome = (result) => (result.status === 200 ? "200" : result.body.code);
const stockState = async () => ({
  items: await db.inventoryItem.findMany({ select: { variantId: true, sellable: true, reserved: true, damaged: true }, orderBy: { variantId: "asc" } }),
  movements: await db.inventoryMovement.count(),
  returns: await db.returnRequest.findMany({ select: { id: true, status: true }, orderBy: { id: "asc" } }),
  received: await db.returnRequestItem.findMany({ select: { id: true, receivedSellable: true, receivedDamaged: true }, orderBy: { id: "asc" } }),
  audit: await db.auditEvent.count(),
});
const orderRow = (id) => db.order.findUniqueOrThrow({ where: { id }, select: { status: true, version: true } });
const shipmentItem = (order, sku, shipmentIndex = 0) => order.shipments[shipmentIndex].items.find((item) => item.sku === sku);
const returnByNumber = (order, number) => order.returns.find((entry) => entry.number === number);

async function invariantsHold() {
  const stock = await db.$queryRaw`
    SELECT bool_and(
      i.sellable = COALESCE((SELECT SUM(delta) FROM inventory_movements m WHERE m.variant_id = i.variant_id AND m.bucket = 'SELLABLE'), 0)
      AND i.damaged = COALESCE((SELECT SUM(delta) FROM inventory_movements m WHERE m.variant_id = i.variant_id AND m.bucket = 'DAMAGED'), 0)
      AND i.reserved = COALESCE((SELECT SUM(delta) FROM inventory_movements m WHERE m.variant_id = i.variant_id AND m.bucket = 'RESERVED'), 0)
      AND i.reserved <= i.sellable) AS ok
    FROM inventory_items i`;
  assert.equal(stock[0].ok, true, "stock equals movement sums");
  const returned = await db.$queryRaw`
    SELECT bool_and(
      (SELECT COALESCE(SUM(m.delta), 0) FROM inventory_movements m WHERE m.type = 'RETURN' AND m.reference = r.number)
        = (SELECT COALESCE(SUM(i.received_sellable + i.received_damaged), 0) FROM return_request_items i WHERE i.request_id = r.id)) AS ok
    FROM return_requests r`;
  assert.equal(returned[0].ok ?? true, true, "return movements equal received units");
  const entitlement = await db.$queryRaw`
    SELECT bool_and(si.quantity >= COALESCE((
      SELECT SUM(CASE WHEN r.status = 'COMPLETED' THEN i.received_sellable + i.received_damaged ELSE i.quantity END)
      FROM return_request_items i JOIN return_requests r ON r.id = i.request_id
      WHERE i.shipment_item_id = si.id AND r.status <> 'REJECTED'), 0)) AS ok
    FROM shipment_items si`;
  assert.equal(entitlement[0].ok, true, "no shipment item is over-returned");
}

let operator;
async function shippedOrder(actor, lines) {
  const draft = await post(actor, "/orders", { lines });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const submitted = await post(actor, `/orders/${draft.body.id}/submit`, {
    version: 1,
    reviewedPrices: draft.body.lines.map((l) => ({ variantId: l.variantId, unitPriceMinor: l.unitPriceMinor })),
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const confirmed = await post(operator, `/orders/${draft.body.id}/confirm`, { version: 2 });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const shipped = await post(operator, `/orders/${draft.body.id}/shipments`, {
    version: 3,
    items: confirmed.body.lines.map((l) => ({ orderLineId: l.id, quantity: l.quantity })),
  });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
  return shipped.body;
}
const requestReturn = (actor, order, items, reason = "Damaged in transit", key) =>
  post(actor, `/orders/${order.id}/returns`, { reason, items }, key);
const decide = (actor, order, entry, action, body = {}, key) => post(actor, `/orders/${order.id}/returns/${entry.id}/${action}`, body, key);
const fullReceipt = (entry) => ({ items: entry.items.map((item) => ({ returnItemId: item.id, sellableQuantity: item.quantity, damagedQuantity: 0 })) });

try {
  operator = await login("operator@pandora.test");
  const admin = await login("admin@pandora.test");
  const lantern = await login("retailer@tabletop-lantern.test");
  const keep = await login("retailer@cardboard-keep.test");
  const po8 = orderSchema.parse((await call(`/orders/${(await db.order.findUniqueOrThrow({ where: { number: "PO-000008" } })).id}`, { actor: lantern })).body);
  const po9 = await db.order.findUniqueOrThrow({ where: { number: "PO-000009" } });
  const lov = await itemBySku("LOV-EN-STD");
  const tkc = await itemBySku("TKC-EN-STD");
  const cwo = await itemBySku("CWO-EN-STD");

  await check("seed: PO-000008 has pending RT-000001; returnable quantities; the open-returns filter and count", async () => {
    const seeded = returnByNumber(po8, "RT-000001");
    assert.equal(seeded.status, "pending");
    assert.deepEqual(seeded.items.map((i) => [i.shipmentNumber, i.sku, i.quantity]), [["SH-000001", "LOV-EN-STD", 1]]);
    assert.equal(seeded.reason, "One box arrived with a crushed corner");
    assert.equal(shipmentItem(po8, "LOV-EN-STD").returnableQuantity, 1);
    const staffOpen = orderListResponseSchema.parse((await call("/orders?returns=open", { actor: operator })).body);
    assert.deepEqual(staffOpen.items.map((o) => [o.number, o.openReturnCount]), [["PO-000008", 1]]);
    assert.equal((await call("/orders?returns=open", { actor: lantern })).body.total, 1);
    assert.equal((await call("/orders?returns=open", { actor: keep })).body.total, 0);
    assertError(await call("/orders?returns=closed", { actor: operator }), 422, "VALIDATION_FAILED");
    await invariantsHold();
  });

  await check("access: only the owning retailer requests; only staff decide and receive; CSRF and keys required", async () => {
    const before = await stockState();
    const seeded = returnByNumber(po8, "RT-000001");
    const body = { reason: "Damaged in transit", items: [{ shipmentItemId: shipmentItem(po8, "LOV-EN-STD").id, quantity: 1 }] };
    assertError(await post(operator, `/orders/${po8.id}/returns`, body), 403, "FORBIDDEN");
    assertError(await post(keep, `/orders/${po8.id}/returns`, body), 404, "NOT_FOUND");
    assertError(await call(`/orders/${po8.id}`, { actor: keep }), 404, "NOT_FOUND");
    assertError(await call(`/orders/${po8.id}/returns`, { method: "POST", body, key: randomUUID() }), 401, "UNAUTHENTICATED");
    assertError(await call(`/orders/${po8.id}/returns`, { actor: lantern, method: "POST", body, key: randomUUID(), csrf: false }), 403, "CSRF_TOKEN_INVALID");
    assertError(await call(`/orders/${po8.id}/returns`, { actor: lantern, method: "POST", body }), 400, "IDEMPOTENCY_KEY_REQUIRED");
    for (const action of ["approve", "reject", "receive"]) {
      const actionBody = action === "reject" ? { reason: "Not eligible" } : action === "receive" ? fullReceipt(seeded) : {};
      assertError(await decide(lantern, po8, seeded, action, actionBody), 403, "FORBIDDEN");
    }
    assertError(await post(operator, `/orders/${po8.id}/returns/${randomUUID()}/approve`, {}), 404, "NOT_FOUND");
    assertError(await post(operator, `/orders/${po9.id}/returns/${seeded.id}/approve`, {}), 404, "NOT_FOUND");
    assert.deepEqual(await stockState(), before);
  });

  const shipped = await shippedOrder(lantern, [
    { variantId: lov.variantId, quantity: 3 },
    { variantId: tkc.variantId, quantity: 2 },
  ]);

  await check("request validation: ineligible orders, unknown or foreign items, bad input, and over-entitlement change nothing", async () => {
    const before = await stockState();
    assertError(await post(keep, `/orders/${po9.id}/returns`, { reason: "Not needed", items: [{ shipmentItemId: randomUUID(), quantity: 1 }] }), 409, "INVALID_ORDER_TRANSITION");
    const own = shipmentItem(po8, "LOV-EN-STD").id;
    const foreign = shipmentItem(shipped, "LOV-EN-STD").id;
    for (const body of [
      { reason: "Damaged in transit", items: [] },
      { reason: "Damaged in transit", items: [{ shipmentItemId: randomUUID(), quantity: 1 }] },
      { reason: "Damaged in transit", items: [{ shipmentItemId: foreign, quantity: 1 }] },
      { reason: "Damaged in transit", items: [{ shipmentItemId: own, quantity: 0 }] },
      { reason: "Damaged in transit", items: [{ shipmentItemId: own, quantity: -1 }] },
      { reason: "Damaged in transit", items: [{ shipmentItemId: own, quantity: 1.5 }] },
      { reason: "Damaged in transit", items: [{ shipmentItemId: own, quantity: 1 }, { shipmentItemId: own, quantity: 1 }] },
      { reason: "Damaged in transit", items: [{ shipmentItemId: own, quantity: 1, sku: "LOV-EN-STD" }] },
      { items: [{ shipmentItemId: own, quantity: 1 }] },
      { reason: "  ab  ", items: [{ shipmentItemId: own, quantity: 1 }] },
    ]) {
      assertError(await post(lantern, `/orders/${po8.id}/returns`, body), 422, "VALIDATION_FAILED");
    }
    const over = await post(lantern, `/orders/${po8.id}/returns`, { reason: "Damaged in transit", items: [{ shipmentItemId: own, quantity: 2 }] });
    assertError(over, 409, "RETURN_QUANTITY_EXCEEDED");
    assert.deepEqual(over.body.details, [{ field: "shipments.SH-000001.LOV-EN-STD", message: "Only 1 left to return." }]);
    assert.deepEqual(await stockState(), before);
  });

  let completed;
  await check("full flow: request, approve, and a full sellable receipt; stock, movements, audit; the order is untouched; replays", async () => {
    const lovBefore = await itemBySku("LOV-EN-STD");
    const orderBefore = await orderRow(shipped.id);
    assert.deepEqual(orderBefore, { status: "SHIPPED", version: 4 });
    const key = randomUUID();
    const items = [{ shipmentItemId: shipmentItem(shipped, "LOV-EN-STD").id, quantity: 2 }];
    const requested = await requestReturn(lantern, shipped, items, "  Customer changed their mind  ", key);
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    orderSchema.parse(requested.body);
    const entry = requested.body.returns.at(-1);
    assert.match(entry.number, /^RT-00[1-9]\d{3}$/);
    assert.deepEqual([entry.status, entry.reason, entry.requestedBy.displayName], ["pending", "Customer changed their mind", "Tara Lantern"]);
    assert.equal(shipmentItem(requested.body, "LOV-EN-STD").returnableQuantity, 1);
    assert.deepEqual((await requestReturn(lantern, shipped, items, "  Customer changed their mind  ", key)).body, requested.body, "replay");
    assert.equal(await db.returnRequest.count({ where: { orderId: shipped.id } }), 1);
    assert.deepEqual(await itemBySku("LOV-EN-STD"), lovBefore, "a pending return changes no stock");

    const approveKey = randomUUID();
    const approved = await decide(operator, shipped, entry, "approve", {}, approveKey);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual([returnByNumber(approved.body, entry.number).status, returnByNumber(approved.body, entry.number).decidedBy.displayName], ["approved", "Oskar Operator"]);
    assert.deepEqual((await decide(operator, shipped, entry, "approve", {}, approveKey)).body, approved.body, "replay");
    assert.deepEqual(await itemBySku("LOV-EN-STD"), lovBefore, "approval changes no stock");

    const received = await decide(admin, shipped, entry, "receive", fullReceipt(returnByNumber(approved.body, entry.number)));
    assert.equal(received.status, 200, JSON.stringify(received.body));
    completed = returnByNumber(received.body, entry.number);
    assert.deepEqual(
      [completed.status, completed.receivedBy.displayName, completed.discrepancyReason, completed.items[0].receivedSellable, completed.items[0].receivedDamaged],
      ["completed", "Ada Administrator", null, 2, 0],
    );
    const lovAfter = await itemBySku("LOV-EN-STD");
    assert.deepEqual([lovAfter.sellable, lovAfter.reserved, lovAfter.damaged], [lovBefore.sellable + 2, lovBefore.reserved, lovBefore.damaged]);
    const movements = await db.inventoryMovement.findMany({ where: { reference: entry.number } });
    assert.deepEqual(movements.map((m) => `${m.type}/${m.bucket}/${m.delta}`), ["RETURN/SELLABLE/2"]);
    assert.equal(shipmentItem(received.body, "LOV-EN-STD").returnableQuantity, 1);
    assert.deepEqual(await orderRow(shipped.id), orderBefore, "returns never change the order status or version");
    assert.equal(received.body.status, "shipped");
    const actions = (await db.auditEvent.findMany({ where: { entityId: shipped.id, action: { startsWith: "return_" } } })).map((e) => e.action).sort();
    assert.deepEqual(actions, ["return_approved", "return_received", "return_requested"]);
    const receivedAudit = await db.auditEvent.findFirstOrThrow({ where: { entityId: shipped.id, action: "return_received" } });
    assert.deepEqual([receivedAudit.after.return, receivedAudit.after.sellable, receivedAudit.after.damaged], [entry.number, { "LOV-EN-STD": 2 }, { "LOV-EN-STD": 0 }]);
    await invariantsHold();
  });

  await check("short receipt: damaged units, a required discrepancy reason, and entitlement counting only received units", async () => {
    const tkcBefore = await itemBySku("TKC-EN-STD");
    const item = shipmentItem(shipped, "TKC-EN-STD");
    const requested = await requestReturn(lantern, shipped, [{ shipmentItemId: item.id, quantity: 2 }]);
    const entry = requested.body.returns.at(-1);
    await decide(operator, shipped, entry, "approve");
    const before = await stockState();
    const returnItem = entry.items[0].id;
    const receipt = (sellableQuantity, damagedQuantity, extra = {}) => ({ items: [{ returnItemId: returnItem, sellableQuantity, damagedQuantity }], ...extra });
    const missingReason = await decide(operator, shipped, entry, "receive", receipt(0, 1));
    assertError(missingReason, 422, "VALIDATION_FAILED");
    assert.deepEqual(missingReason.body.details, [{ field: "discrepancyReason", message: "Explain why fewer units arrived than were approved." }]);
    const over = await decide(operator, shipped, entry, "receive", receipt(2, 1));
    assertError(over, 409, "RETURN_QUANTITY_EXCEEDED");
    assert.match(over.body.details[0].field, /^shipments\.SH-\d{6}\.TKC-EN-STD$/);
    assertError(await decide(operator, shipped, entry, "receive", { items: [{ returnItemId: randomUUID(), sellableQuantity: 1, damagedQuantity: 0 }] }), 422, "VALIDATION_FAILED");
    assertError(await decide(operator, shipped, entry, "receive", receipt(-1, 0)), 422, "VALIDATION_FAILED");
    assert.deepEqual(await stockState(), before);

    const received = await decide(operator, shipped, entry, "receive", receipt(0, 1, { discrepancyReason: "One box lost by the carrier" }));
    assert.equal(received.status, 200, JSON.stringify(received.body));
    const done = returnByNumber(received.body, entry.number);
    assert.deepEqual([done.status, done.discrepancyReason, done.items[0].receivedSellable, done.items[0].receivedDamaged], ["completed", "One box lost by the carrier", 0, 1]);
    const tkcAfter = await itemBySku("TKC-EN-STD");
    assert.deepEqual([tkcAfter.sellable, tkcAfter.damaged], [tkcBefore.sellable, tkcBefore.damaged + 1]);
    const movements = await db.inventoryMovement.findMany({ where: { reference: entry.number } });
    assert.deepEqual(movements.map((m) => `${m.type}/${m.bucket}/${m.delta}`), ["RETURN/DAMAGED/1"]);
    assert.equal(shipmentItem(received.body, "TKC-EN-STD").returnableQuantity, 1, "only the received unit counts");
    await invariantsHold();
  });

  await check("transitions: decided, rejected, and completed returns refuse further steps; rejection frees entitlement; every item must be inspected", async () => {
    const tkcItem = shipmentItem(shipped, "TKC-EN-STD").id;
    const pending = (await requestReturn(lantern, shipped, [{ shipmentItemId: tkcItem, quantity: 1 }])).body.returns.at(-1);
    assertError(await requestReturn(lantern, shipped, [{ shipmentItemId: tkcItem, quantity: 1 }]), 409, "RETURN_QUANTITY_EXCEEDED");
    assertError(await decide(operator, shipped, pending, "receive", fullReceipt(pending)), 409, "INVALID_RETURN_TRANSITION");
    assertError(await decide(operator, shipped, pending, "reject", { reason: "ab" }), 422, "VALIDATION_FAILED");
    const rejected = await decide(operator, shipped, pending, "reject", { reason: "Outside the agreed window" });
    assert.deepEqual(
      [returnByNumber(rejected.body, pending.number).status, returnByNumber(rejected.body, pending.number).decisionReason],
      ["rejected", "Outside the agreed window"],
    );
    for (const [action, body] of [["approve", {}], ["reject", { reason: "Second decision" }], ["receive", fullReceipt(pending)]]) {
      assertError(await decide(operator, shipped, pending, action, body), 409, "INVALID_RETURN_TRANSITION");
    }
    assertError(await decide(operator, shipped, completed, "approve"), 409, "INVALID_RETURN_TRANSITION");
    const twice = await decide(operator, shipped, completed, "receive", fullReceipt(completed));
    assertError(twice, 409, "INVALID_RETURN_TRANSITION");
    assert.equal(twice.body.message, "This return was already received.");
    assert.equal(shipmentItem(rejected.body, "TKC-EN-STD").returnableQuantity, 1, "rejection frees entitlement");

    const both = (await requestReturn(lantern, shipped, [
      { shipmentItemId: shipmentItem(shipped, "LOV-EN-STD").id, quantity: 1 },
      { shipmentItemId: tkcItem, quantity: 1 },
    ])).body.returns.at(-1);
    await decide(operator, shipped, both, "approve");
    const partial = await decide(operator, shipped, both, "receive", { items: [{ returnItemId: both.items[0].id, sellableQuantity: 1, damagedQuantity: 0 }] });
    assertError(partial, 422, "VALIDATION_FAILED");
    assert.equal(partial.body.details[0].field, "items");
    const done = await decide(operator, shipped, both, "receive", fullReceipt(both));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.shipments[0].items.every((i) => i.returnableQuantity === 0));
    assertError(await requestReturn(lantern, shipped, [{ shipmentItemId: tkcItem, quantity: 1 }]), 409, "RETURN_QUANTITY_EXCEEDED");
    assert.deepEqual(await orderRow(shipped.id), { status: "SHIPPED", version: 4 });
    await invariantsHold();
  });

  await check("partially shipped and closed_partial orders accept returns; shipping continues and no status changes", async () => {
    const seeded = returnByNumber(po8, "RT-000001");
    await decide(operator, po8, seeded, "approve");
    const received = await decide(operator, po8, seeded, "receive", fullReceipt(seeded));
    assert.deepEqual([received.body.status, received.body.version, returnByNumber(received.body, "RT-000001").status], ["partially_shipped", 4, "completed"]);
    const more = await post(operator, `/orders/${po8.id}/shipments`, { version: 4, items: [{ orderLineId: po8.lines[0].id, quantity: 1 }] });
    assert.equal(more.status, 200, "returns never block or bump shipping");
    assert.equal(more.body.shipments.length, 2);

    const partly = await shippedOrder(lantern, [{ variantId: cwo.variantId, quantity: 2 }]);
    assert.equal(partly.status, "shipped");
    const draft = await post(lantern, "/orders", { lines: [{ variantId: cwo.variantId, quantity: 2 }] });
    await post(lantern, `/orders/${draft.body.id}/submit`, { version: 1, reviewedPrices: draft.body.lines.map((l) => ({ variantId: l.variantId, unitPriceMinor: l.unitPriceMinor })) });
    const confirmed = await post(operator, `/orders/${draft.body.id}/confirm`, { version: 2 });
    await post(operator, `/orders/${draft.body.id}/shipments`, { version: 3, items: [{ orderLineId: confirmed.body.lines[0].id, quantity: 1 }] });
    const cancel = await post(lantern, `/orders/${draft.body.id}/cancellation-requests`, { version: 4 });
    const closed = await post(operator, `/orders/${draft.body.id}/cancellation-requests/${cancel.body.cancellationRequests[0].id}/approve`, { version: 5 });
    assert.equal(closed.body.status, "closed_partial");
    const returned = await requestReturn(lantern, closed.body, [{ shipmentItemId: shipmentItem(closed.body, "CWO-EN-STD").id, quantity: 1 }]);
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.deepEqual([returned.body.status, returned.body.version], ["closed_partial", 6]);
    await invariantsHold();
  });

  await check("concurrency: parallel requests for the last units leave one; parallel receipts add stock once", async () => {
    const order = await shippedOrder(lantern, [{ variantId: lov.variantId, quantity: 2 }]);
    const items = [{ shipmentItemId: shipmentItem(order, "LOV-EN-STD").id, quantity: 2 }];
    const requests = await Promise.all(Array.from({ length: 4 }, () => requestReturn(lantern, order, items)));
    const outcomes = requests.map(outcome);
    assert.equal(outcomes.filter((o) => o === "200").length, 1, outcomes.join(","));
    assert.ok(outcomes.every((o) => ["200", "RETURN_QUANTITY_EXCEEDED", "CONCURRENT_MODIFICATION"].includes(o)), outcomes.join(","));
    const entry = (await db.returnRequest.findFirstOrThrow({ where: { orderId: order.id }, include: { items: true } }));
    assert.equal(await db.returnRequest.count({ where: { orderId: order.id } }), 1);
    await post(operator, `/orders/${order.id}/returns/${entry.id}/approve`, {});
    const lovBefore = await itemBySku("LOV-EN-STD");
    const receipt = { items: [{ returnItemId: entry.items[0].id, sellableQuantity: 2, damagedQuantity: 0 }] };
    const receipts = await Promise.all([operator, admin, operator].map((actor) => post(actor, `/orders/${order.id}/returns/${entry.id}/receive`, receipt)));
    const receiptOutcomes = receipts.map(outcome);
    assert.equal(receiptOutcomes.filter((o) => o === "200").length, 1, receiptOutcomes.join(","));
    assert.ok(receiptOutcomes.every((o) => ["200", "INVALID_RETURN_TRANSITION", "CONCURRENT_MODIFICATION"].includes(o)), receiptOutcomes.join(","));
    assert.equal((await itemBySku("LOV-EN-STD")).sellable, lovBefore.sellable + 2);
    assert.equal(await db.inventoryMovement.count({ where: { reference: entry.number } }), 1);
    await invariantsHold();
  });

  await check("rollback: an audit failure on receipt leaves no movement, stock, or status change; the key stays usable", async () => {
    const order = await shippedOrder(lantern, [{ variantId: tkc.variantId, quantity: 1 }]);
    const entry = (await requestReturn(lantern, order, [{ shipmentItemId: shipmentItem(order, "TKC-EN-STD").id, quantity: 1 }])).body.returns.at(-1);
    await decide(operator, order, entry, "approve");
    const key = randomUUID();
    const before = await stockState();
    await db.$executeRaw`CREATE FUNCTION reject_returns_check_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected QA audit failure'; END; $$`;
    await db.$executeRaw`CREATE TRIGGER reject_returns_check_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_returns_check_audit()`;
    try {
      assertError(await decide(operator, order, entry, "receive", fullReceipt(entry), key), 500, "INTERNAL_ERROR");
      assert.deepEqual(await stockState(), before);
      assert.equal(await db.idempotencyRecord.count({ where: { key } }), 0);
    } finally {
      await db.$executeRaw`DROP TRIGGER reject_returns_check_audit ON audit_events`;
      await db.$executeRaw`DROP FUNCTION reject_returns_check_audit()`;
    }
    const retried = await decide(operator, order, entry, "receive", fullReceipt(entry), key);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(returnByNumber(retried.body, entry.number).status, "completed");
    await invariantsHold();
  });

  await check("database rejects over-entitlement, cross-order items, a second receipt, deletions, skipped steps, and invalid return movements", async () => {
    const order = await shippedOrder(lantern, [{ variantId: cwo.variantId, quantity: 1 }]);
    const item = shipmentItem(order, "CWO-EN-STD");
    const retailerId = (await db.user.findUniqueOrThrow({ where: { email: "retailer@tabletop-lantern.test" } })).id;
    const [raw] = await db.$queryRaw`
      INSERT INTO return_requests (order_id, status, reason, requested_by_id, requested_at)
      VALUES (${order.id}::uuid, 'PENDING', 'Direct SQL', ${retailerId}::uuid, now()) RETURNING id`;
    await assert.rejects(
      db.$executeRaw`INSERT INTO return_request_items (request_id, shipment_item_id, quantity) VALUES (${raw.id}::uuid, ${item.id}::uuid, 2)`,
      /exceed the shipped quantity/,
    );
    await assert.rejects(
      db.$executeRaw`INSERT INTO return_request_items (request_id, shipment_item_id, quantity) VALUES (${raw.id}::uuid, ${shipmentItem(shipped, "LOV-EN-STD").id}::uuid, 1)`,
      /same order/,
    );
    await assert.rejects(db.$executeRaw`UPDATE return_requests SET status = 'COMPLETED' WHERE id = ${raw.id}::uuid`, "pending cannot skip to completed");
    await assert.rejects(db.$executeRaw`DELETE FROM return_requests WHERE id = ${raw.id}::uuid`, /never deleted/);
    const done = await db.returnRequestItem.findFirstOrThrow({ where: { request: { status: "COMPLETED" } } });
    await assert.rejects(db.$executeRaw`UPDATE return_request_items SET received_sellable = 0, received_damaged = 0 WHERE id = ${done.id}::uuid`, /once/);
    await assert.rejects(db.$executeRaw`DELETE FROM return_request_items WHERE id = ${done.id}::uuid`, /never deleted/);
    await assert.rejects(db.$executeRaw`UPDATE return_requests SET status = 'PENDING' WHERE id = ${done.requestId}::uuid`);
    const pending = await db.returnRequest.findFirstOrThrow({ where: { status: "PENDING", items: { some: {} } } });
    await assert.rejects(
      db.$executeRaw`UPDATE return_requests SET status = 'REJECTED', decided_at = now(), decided_by_id = requested_by_id WHERE id = ${pending.id}::uuid`,
      "rejection needs a reason",
    );
    const staffId = (await db.user.findUniqueOrThrow({ where: { email: "operator@pandora.test" } })).id;
    const distributor = (await db.user.findUniqueOrThrow({ where: { id: staffId } })).organizationId;
    for (const [bucket, delta] of [["SELLABLE", -1], ["RESERVED", 1]]) {
      await assert.rejects(db.$executeRawUnsafe(
        `INSERT INTO inventory_movements (variant_id, type, bucket, delta, sellable_after, reserved_after, damaged_after, actor_id, organization_id, correlation_id, occurred_at)
         SELECT variant_id, 'RETURN', '${bucket}', ${delta}, sellable, reserved, damaged, $1::uuid, $2::uuid, 'qa', now() FROM inventory_items WHERE variant_id = $3::uuid`,
        staffId, distributor, cwo.variantId,
      ), `RETURN ${bucket} ${delta}`);
    }
    await invariantsHold();
  });

  await check("OpenAPI documents the return routes with the Idempotency-Key header", async () => {
    const document = await (await fetch(`${qa.origin}/openapi.json`)).json();
    for (const route of [
      "/api/orders/{orderId}/returns",
      "/api/orders/{orderId}/returns/{returnId}/approve",
      "/api/orders/{orderId}/returns/{returnId}/reject",
      "/api/orders/{orderId}/returns/{returnId}/receive",
    ]) {
      const operation = document.paths[route]?.post;
      assert.ok(operation, route);
      assert.ok(operation.parameters.some((p) => p.in === "header" && p.name === "Idempotency-Key"), route);
    }
  });

  assert.ok(!/pandora-demo|argon2|pandora_session=/.test(qa.logs()), "logs must not contain credentials or tokens");
  console.log(`\n${qa.passed} return check groups passed.`);
} catch (error) {
  console.error(qa.logs().slice(-4000));
  throw error;
} finally {
  await qa.stop();
}
