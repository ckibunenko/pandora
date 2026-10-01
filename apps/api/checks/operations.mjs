// Audit search and operational pagination against a fresh, isolated PostgreSQL database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { auditEventSchema, auditListResponseSchema, inventoryListResponseSchema, movementListResponseSchema, orderListResponseSchema, organizationListResponseSchema, userListResponseSchema } from "@pandora/contracts";
import { assertError, startQaApi } from "./harness.mjs";

const qa = await startQaApi({
  databaseEnv: "OPERATIONS_CHECK_DATABASE", databasePattern: /^pandora_operations_check_[a-z0-9_]+$/,
  portEnv: "OPERATIONS_CHECK_PORT", defaultPort: "3018",
});
const { db, call, login, check } = qa;
const ids = (items) => items.map((item) => item.id ?? item.variantId);
const at = new Date("2026-10-01T08:00:00.000Z");
const snapshot = async () => ({
  audit: await db.auditEvent.findMany({ orderBy: { id: "asc" } }),
  stock: await db.inventoryItem.findMany({ orderBy: { variantId: "asc" } }),
  movements: await db.inventoryMovement.count(), orders: await db.order.count(),
});

try {
  const admin = await login("admin@pandora.test");
  const operator = await login("operator@pandora.test");
  const retailer = await login("retailer@tabletop-lantern.test");
  const other = await login("retailer@cardboard-keep.test");
  const adminUser = await db.user.findUniqueOrThrow({ where: { email: "admin@pandora.test" } });
  const retailerUser = await db.user.findUniqueOrThrow({ where: { email: "retailer@tabletop-lantern.test" } });
  const operatorUser = await db.user.findUniqueOrThrow({ where: { email: "operator@pandora.test" } });
  const variant = await db.productVariant.findUniqueOrThrow({ where: { sku: "TKC-EN-STD" } });
  const order = await db.order.findUniqueOrThrow({ where: { number: "PO-000008" } });
  const records = Array.from({ length: 45 }, (_, i) => ({
    id: randomUUID(), actorId: i % 2 ? operatorUser.id : retailerUser.id,
    organizationId: i % 2 ? operatorUser.organizationId : retailerUser.organizationId,
    entityType: i % 3 ? "order" : "inventory_item", entityId: i % 3 ? order.id : variant.id,
    action: i % 3 ? "confirmed" : "received", occurredAt: at, correlationId: `operations-fixture-${i}`,
    after: { fixture: i },
  }));
  await db.auditEvent.createMany({ data: records });
  const restricted = await db.auditEvent.create({ data: {
    actorId: adminUser.id, organizationId: adminUser.organizationId, entityType: "user", entityId: adminUser.id,
    action: "updated", occurredAt: at, correlationId: "operations-restricted", after: { displayName: "Administrator" },
  } });

  const list = async (query = "", actor = admin) => {
    const response = await call(`/audit-events?${query}`, { actor });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(!/"(before|after|email|role|password|passwordHash|csrfToken|tokenHash)":/.test(JSON.stringify(response.body)), "raw list response omits snapshots, account and credential fields");
    return auditListResponseSchema.parse(response.body);
  };

  await check("audit access: authenticated staff only; operator scope cannot be expanded by filters or detail IDs", async () => {
    const before = await snapshot();
    assertError(await call("/audit-events"), 401, "UNAUTHENTICATED");
    for (const actor of [retailer, other]) {
      assertError(await call("/audit-events", { actor }), 403, "FORBIDDEN");
      assertError(await call(`/audit-events/${records[0].id}`, { actor }), 403, "FORBIDDEN");
    }
    assert.equal((await list("pageSize=100", operator)).total, 45);
    assert.equal((await list("entityType=user", operator)).total, 0);
    assert.equal((await list(`actorId=${adminUser.id}&organizationId=${adminUser.organizationId}`, operator)).total, 0);
    assertError(await call(`/audit-events/${restricted.id}`, { actor: operator }), 404, "NOT_FOUND");
    assertError(await call(`/audit-events/${randomUUID()}`, { actor: admin }), 404, "NOT_FOUND");
    assert.equal((await call(`/audit-events/${records[0].id}`, { actor: operator })).status, 200);
    assert.equal((await call(`/audit-events/${restricted.id}`, { actor: admin })).status, 200);
    assert.deepEqual(await snapshot(), before, "reads and refused access change no business records");
  });

  await check("audit filters: exact matches intersect before count and page; actor organization is historical attribution", async () => {
    const queries = [
      ["entityType=order", records.filter((r) => r.entityType === "order")],
      [`entityId=${variant.id}&action=received`, records.filter((r) => r.entityId === variant.id)],
      [`entityType=order&actorId=${retailerUser.id}&organizationId=${retailerUser.organizationId}`, records.filter((r) => r.entityType === "order" && r.actorId === retailerUser.id)],
      ["correlationId=operations-fixture-4", [records[4]]],
      ["action=confirm", []], ["correlationId=%25", []],
      [`organizationId=${randomUUID()}`, []],
      [`entityId=${order.id}&entityType=inventory_item`, []],
    ];
    for (const [query, expected] of queries) {
      const result = await list(`${query}&pageSize=100`);
      assert.equal(result.total, expected.length, query);
      assert.deepEqual(ids(result.items).sort(), ids(expected).sort(), query);
    }
  });

  await check("audit time range: UTC inclusive boundaries, reversed and invalid dates refused", async () => {
    assert.equal((await list("from=2026-10-01T08:00:00Z&to=2026-10-01T08:00:00Z")).total, 46);
    assert.equal((await list("from=2026-10-01T08:00:00.001Z")).total, 0);
    assert.equal((await list("to=2026-10-01T07:59:59.999Z")).total, 0);
    for (const query of ["from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z", "from=2026-02-30T00:00:00Z", "from=not-a-date", "to=2026-10-01T08:00:00", "from=2026-10-01T10:00:00%2B02:00"]) {
      assertError(await call(`/audit-events?${query}`, { actor: admin }), 422, "VALIDATION_FAILED");
    }
  });

  await check("audit validation: strict bounded filters, UUIDs and pagination; no effects", async () => {
    const before = await snapshot();
    for (const query of ["page=0", "page=-1", "page=1.5", "page=1e2", "page=", "page=2147483648", "pageSize=30", "pageSize=", "entityType=session", "entityId=bad", "actorId=bad", "organizationId=bad", "action=%20", "correlationId=", `action=${"a".repeat(81)}`, `correlationId=${"a".repeat(65)}`, "unexpected=x", "page=1&page=2"]) {
      assertError(await call(`/audit-events?${query}`, { actor: admin }), 422, "VALIDATION_FAILED");
    }
    assertError(await call("/audit-events/bad", { actor: admin }), 422, "VALIDATION_FAILED");
    assert.deepEqual(await snapshot(), before);
  });

  await check("audit pagination: timestamp ties use UUID order, no overlaps/gaps, 20/50/100 and beyond-end pages", async () => {
    const expected = await db.auditEvent.findMany({ orderBy: [{ occurredAt: "desc" }, { id: "desc" }] });
    const seen = [];
    for (let page = 1; page <= 3; page++) {
      const result = await list(`page=${page}`);
      assert.equal(result.total, 46);
      assert.equal(result.pageSize, 20);
      assert.deepEqual(ids(result.items), ids(expected.slice((page - 1) * 20, page * 20)));
      seen.push(...ids(result.items));
    }
    assert.equal(new Set(seen).size, 46);
    for (const pageSize of [50, 100]) {
      const result = await list(`pageSize=${pageSize}`);
      assert.equal(result.pageSize, pageSize);
      assert.deepEqual(ids(result.items), ids(expected));
    }
    const empty = await list("page=2147483647&pageSize=100");
    assert.deepEqual([empty.items.length, empty.page, empty.total], [0, 2147483647, 46]);
  });

  await check("real mutations: receipt snapshots and names, order replay writes one event, reset contains no password/hash", async () => {
    const receipt = await call(`/inventory/${variant.id}/receipts`, { actor: operator, method: "POST", body: { quantity: 3, reference: "OPS-RECEIPT" }, key: randomUUID() });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
    const results = await list(`entityType=inventory_item&entityId=${variant.id}&actorId=${operatorUser.id}&action=received&pageSize=100`);
    const entry = results.items.find((event) => !event.correlationId.startsWith("operations-fixture"));
    assert.ok(entry);
    assert.equal(entry.actor.displayName, operatorUser.displayName);
    assert.equal(entry.organization.name, "Pandora Distribution");
    assert.ok(!("before" in entry) && !("after" in entry), "summary omits snapshots");
    const detail = auditEventSchema.parse((await call(`/audit-events/${entry.id}`, { actor: operator })).body);
    assert.equal(detail.after.sellable - detail.before.sellable, 3);
    const key = randomUUID();
    const draft = await call("/orders", { actor: retailer, method: "POST", body: { lines: [] }, key });
    assert.equal(draft.status, 201);
    await call("/orders", { actor: retailer, method: "POST", body: { lines: [] }, key });
    assert.equal((await list(`entityId=${draft.body.id}&action=created`)).total, 1);
    const password = "Operations-secret-password-2026";
    const reset = await call(`/admin/users/${operatorUser.id}/password`, { actor: admin, method: "POST", body: { password } });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const event = (await list(`entityId=${operatorUser.id}&action=password_reset`)).items[0];
    const safe = (await call(`/audit-events/${event.id}`, { actor: admin })).body;
    const serialized = JSON.stringify(safe);
    assert.ok(!serialized.includes(password) && !serialized.includes(adminUser.passwordHash));
    assert.ok(!/passwordHash|csrfToken|tokenHash/.test(serialized));
  });

  // More than two pages of fixture records with identical sort timestamps exercise real boundaries.
  const organizations = Array.from({ length: 41 }, (_, i) => ({ id: randomUUID(), name: `Operations Store ${String(i).padStart(2, "0")}`, type: "RETAILER" }));
  await db.organization.createMany({ data: organizations });
  await db.user.createMany({ data: organizations.map((org, i) => ({
    id: randomUUID(), organizationId: org.id, email: `operations-${String(i).padStart(2, "0")}@example.test`, displayName: "Operations fixture",
    passwordHash: adminUser.passwordHash, role: "RETAILER",
  })) });
  await db.order.createMany({ data: Array.from({ length: 41 }, () => ({
    organizationId: retailerUser.organizationId, createdById: retailerUser.id, status: "DRAFT", currency: "EUR", createdAt: at, updatedAt: at,
  })) });
  await db.productVariant.createMany({ data: Array.from({ length: 41 }, (_, i) => ({
    productId: variant.productId, sku: `OPS-${String(i).padStart(3, "0")}`, language: "en", edition: `Operations ${i}`, unitPriceMinor: 100,
  })) });
  for (let i = 0; i < 41; i++) {
    const result = await call(`/inventory/${variant.id}/receipts`, { actor: admin, method: "POST", body: { quantity: 1 }, key: randomUUID() });
    assert.equal(result.status, 201);
  }

  await check("operational pagination: all lists traverse exact pages, filtered totals, size variants and invalid input", async () => {
    const cases = [
      { path: "/orders", query: "status=draft", actor: retailer, schema: orderListResponseSchema, expected: await db.order.findMany({ where: { organizationId: retailerUser.organizationId, status: "DRAFT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }) },
      { path: "/inventory", query: "q=OPS-", actor: admin, schema: inventoryListResponseSchema, expected: await db.inventoryItem.findMany({ where: { variant: { sku: { startsWith: "OPS-" } } }, orderBy: [{ variant: { product: { name: "asc" } } }, { variant: { sku: "asc" } }, { variantId: "asc" }] }) },
      { path: `/inventory/${variant.id}/movements`, query: "", actor: admin, schema: movementListResponseSchema, expected: await db.inventoryMovement.findMany({ where: { variantId: variant.id }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }] }) },
      { path: "/admin/organizations", query: "q=Operations", actor: admin, schema: organizationListResponseSchema, expected: await db.organization.findMany({ where: { name: { startsWith: "Operations" } }, orderBy: [{ name: "asc" }, { id: "asc" }] }) },
      { path: "/admin/users", query: "q=operations-", actor: admin, schema: userListResponseSchema, expected: await db.user.findMany({ where: { email: { startsWith: "operations-" } }, orderBy: [{ email: "asc" }, { id: "asc" }] }) },
    ];
    for (const test of cases) {
      const seen = [];
      for (let page = 1; page <= Math.ceil(test.expected.length / 20); page++) {
        const result = await call(`${test.path}?${test.query}&page=${page}`, { actor: test.actor });
        assert.equal(result.status, 200);
        const parsed = test.schema.parse(result.body);
        assert.equal(parsed.total, test.expected.length, test.path);
        assert.deepEqual(ids(parsed.items), ids(test.expected.slice((page - 1) * 20, page * 20)), test.path);
        seen.push(...ids(parsed.items));
      }
      assert.equal(new Set(seen).size, test.expected.length, test.path);
      for (const pageSize of [50, 100]) {
        const result = (await call(`${test.path}?${test.query}&pageSize=${pageSize}`, { actor: test.actor })).body;
        assert.equal(result.pageSize, pageSize);
        assert.deepEqual(ids(result.items), ids(test.expected.slice(0, pageSize)));
      }
      const empty = (await call(`${test.path}?${test.query}&page=999`, { actor: test.actor })).body;
      assert.deepEqual([empty.items.length, empty.total], [0, test.expected.length]);
      assertError(await call(`${test.path}?pageSize=21`, { actor: test.actor }), 422, "VALIDATION_FAILED");
      assertError(await call(`${test.path}?page=0`, { actor: test.actor }), 422, "VALIDATION_FAILED");
    }
  });

  await check("operational access: later pages preserve retailer isolation and administration/inventory role gates", async () => {
    for (const actor of [retailer, other]) {
      const orders = (await call("/orders?page=2", { actor })).body;
      const email = actor === retailer ? "retailer@tabletop-lantern.test" : "retailer@cardboard-keep.test";
      const user = await db.user.findUniqueOrThrow({ where: { email } });
      assert.ok(orders.items.every((item) => item.organization.id === user.organizationId));
      assert.equal(orders.total, await db.order.count({ where: { organizationId: user.organizationId } }));
      for (const path of ["/inventory", `/inventory/${variant.id}/movements`, "/admin/users", "/admin/organizations"]) {
        assertError(await call(`${path}?page=2&pageSize=100`, { actor }), 403, "FORBIDDEN");
      }
    }
    // Password reset revoked the original session; the global guard must still apply on list reads.
    assertError(await call("/audit-events?page=2", { actor: operator }), 401, "UNAUTHENTICATED");
  });

  await check("OpenAPI publishes audit filters and typed summaries/details", async () => {
    const response = await fetch(`${qa.origin}/openapi.json`);
    assert.equal(response.status, 200);
    const api = await response.json();
    const names = api.paths["/api/audit-events"].get.parameters.map((parameter) => parameter.name);
    assert.ok(["page", "pageSize", "entityType", "entityId", "actorId", "organizationId", "action", "correlationId", "from", "to"].every((name) => names.includes(name)));
    assert.ok(api.paths["/api/audit-events/{eventId}"].get.responses["404"]);
  });

  console.log(`\n${qa.passed} operations API/PostgreSQL check groups passed.`);
} finally {
  await qa.stop();
}
