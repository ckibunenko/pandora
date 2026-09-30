// Organization and user administration checks against an isolated, empty QA database.
// Usage: see context/features/admin-management-verification.md.
import assert from "node:assert/strict";
import { adminOrganizationSchema, adminUserSchema, organizationListResponseSchema, userListResponseSchema } from "@pandora/contracts";
import { assertError, startQaApi } from "./harness.mjs";

const qa = await startQaApi({
  databaseEnv: "ADMIN_CHECK_DATABASE",
  databasePattern: /^pandora_admin_check_[a-z0-9_]+$/,
  portEnv: "ADMIN_CHECK_PORT",
  defaultPort: "3017",
});
const { db, call, login, check } = qa;

const NEW_PASSWORD = "Fresh-QA-password-2026";
const RESET_PASSWORD = "Reset-QA-password-2026";
const DISTRIBUTOR_ID = "01920000-0000-7000-8000-000000000001";
const LANTERN_ID = "01920000-0000-7000-8000-000000000002";
const ADMIN_ID = "01920000-0000-7000-8000-000000000101";
const OPERATOR_ID = "01920000-0000-7000-8000-000000000102";

const send = (actor, method, path, body) => call(path, { actor, method, body });
async function loginWith(email, password) {
  const response = await fetch(`${qa.origin}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) return { status: response.status };
  return { status: 200, cookie: response.headers.get("set-cookie").split(";")[0], csrf: (await response.json()).csrfToken };
}
const sessionStatus = async (actor) => (await call("/auth/session", { actor })).status;
const auditCount = () => db.auditEvent.count();
const state = async () => ({
  organizations: await db.organization.findMany({ select: { id: true, name: true, isActive: true }, orderBy: { id: "asc" } }),
  users: await db.user.findMany({ select: { id: true, role: true, isActive: true, displayName: true, passwordHash: true }, orderBy: { id: "asc" } }),
  revoked: await db.session.count({ where: { revokedAt: { not: null } } }),
  audit: await auditCount(),
});
/**
 * Two requests race to remove the last two administrators. At most one may succeed, never with a 500. Each loser is refused by:
 * - the rule (LAST_ACTIVE_ADMINISTRATOR);
 * - the session guard, when the winner demoted its caller first (UNAUTHENTICATED);
 * - the bounded retry, when it kept losing serialization conflicts (CONCURRENT_MODIFICATION, overview §7).
 * Returns the number of successes.
 */
function assertSafeRace(results) {
  const successes = results.filter((r) => r.status === 200).length;
  assert.ok(successes <= 1, JSON.stringify(results.map((r) => r.body)));
  for (const result of results.filter((r) => r.status !== 200)) {
    assert.ok(["LAST_ACTIVE_ADMINISTRATOR", "UNAUTHENTICATED", "CONCURRENT_MODIFICATION"].includes(result.body.code), JSON.stringify(result.body));
  }
  return successes;
}
const activeAdministrators = () =>
  db.user.count({ where: { role: "ADMINISTRATOR", isActive: true, organization: { type: "DISTRIBUTOR", isActive: true } } });

try {
  let admin = await login("admin@pandora.test");
  const operator = await login("operator@pandora.test");
  const lantern = await login("retailer@tabletop-lantern.test");
  let boardRoom;
  let staffUser;
  let storeUser;

  await check("access: operators and retailers get 403, anonymous callers 401, and mutations need CSRF; nothing changes", async () => {
    const before = await state();
    for (const actor of [operator, lantern]) {
      assertError(await call("/admin/organizations", { actor }), 403, "FORBIDDEN");
      assertError(await call(`/admin/users/${ADMIN_ID}`, { actor }), 403, "FORBIDDEN");
      assertError(await send(actor, "POST", "/admin/organizations", { name: "Sneaky Games" }), 403, "FORBIDDEN");
      assertError(await send(actor, "PATCH", `/admin/users/${ADMIN_ID}`, { isActive: false }), 403, "FORBIDDEN");
      assertError(await send(actor, "POST", `/admin/users/${ADMIN_ID}/password`, { password: NEW_PASSWORD }), 403, "FORBIDDEN");
    }
    assertError(await call("/admin/users"), 401, "UNAUTHENTICATED");
    assertError(await call("/admin/organizations", { actor: admin, method: "POST", body: { name: "No Token Games" }, csrf: false }), 403, "CSRF_TOKEN_INVALID");
    assert.deepEqual(await state(), before);
  });

  await check("organizations: create a retailer, list with filters and pagination, rename; duplicates, bad input, and unknown ids fail", async () => {
    const created = await send(admin, "POST", "/admin/organizations", { name: "  Board Room Games  " });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    boardRoom = adminOrganizationSchema.parse(created.body);
    assert.deepEqual([boardRoom.name, boardRoom.type, boardRoom.isActive, boardRoom.userCount], ["Board Room Games", "retailer", true, 0]);

    const listed = organizationListResponseSchema.parse((await call("/admin/organizations?q=ROOM&status=active", { actor: admin })).body);
    assert.deepEqual(listed.items.map((o) => o.name), ["Board Room Games"]);
    const distributors = (await call("/admin/organizations?type=distributor", { actor: admin })).body;
    assert.deepEqual(distributors.items.map((o) => o.id), [DISTRIBUTOR_ID]);
    const inactive = (await call("/admin/organizations?status=inactive", { actor: admin })).body;
    assert.deepEqual(inactive.items.map((o) => o.name), ["Closed Shelf Games"]);
    const all = (await call("/admin/organizations", { actor: admin })).body;
    assert.deepEqual(all.items.map((o) => o.name), [...all.items.map((o) => o.name)].sort((a, b) => a.localeCompare(b, "en")));
    assert.equal(all.total, 5);
    assert.equal(all.items.find((o) => o.id === LANTERN_ID).activeUserCount, 1);
    assert.equal(all.items.find((o) => o.id === LANTERN_ID).userCount, 2);
    assert.equal((await call("/admin/organizations?q=%25", { actor: admin })).body.total, 0, "LIKE wildcards are literal");

    const auditBefore = await auditCount();
    assertError(await send(admin, "POST", "/admin/organizations", { name: "board room GAMES" }), 409, "ORGANIZATION_NAME_EXISTS");
    assertError(await send(admin, "POST", "/admin/organizations", { name: "   " }), 422, "VALIDATION_FAILED");
    assertError(await send(admin, "POST", "/admin/organizations", { name: "x".repeat(121) }), 422, "VALIDATION_FAILED");
    assertError(await send(admin, "POST", "/admin/organizations", { name: "Typed Games", type: "distributor" }), 422, "VALIDATION_FAILED");
    assertError(await send(admin, "PATCH", `/admin/organizations/${boardRoom.id}`, {}), 422, "VALIDATION_FAILED");
    assertError(await send(admin, "PATCH", `/admin/organizations/${boardRoom.id}`, { name: "Tabletop LANTERN" }), 409, "ORGANIZATION_NAME_EXISTS");
    assertError(await call("/admin/organizations/01920000-0000-7000-8000-00000000ffff", { actor: admin }), 404, "NOT_FOUND");
    assertError(await call("/admin/organizations/not-a-uuid", { actor: admin }), 422, "VALIDATION_FAILED");
    assertError(await call("/admin/organizations?pageSize=30", { actor: admin }), 422, "VALIDATION_FAILED");
    assert.equal(await auditCount(), auditBefore, "failed mutations write no audit");

    const renamed = await send(admin, "PATCH", `/admin/organizations/${boardRoom.id}`, { name: "Board Room Games & Co" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Board Room Games & Co");
    const noop = await send(admin, "PATCH", `/admin/organizations/${boardRoom.id}`, { name: "Board Room Games & Co" });
    assert.equal(noop.status, 200);
    const events = await db.auditEvent.findMany({ where: { entityId: boardRoom.id }, orderBy: { occurredAt: "asc" } });
    assert.deepEqual(events.map((e) => e.action), ["created", "updated"], "a no-op update writes no audit");
    assert.equal(events[1].before.name, "Board Room Games");
  });

  await check("distributor organization cannot be deactivated", async () => {
    const before = await state();
    assertError(await send(admin, "PATCH", `/admin/organizations/${DISTRIBUTOR_ID}`, { isActive: false }), 409, "DISTRIBUTOR_ORGANIZATION_PROTECTED");
    assert.deepEqual(await state(), before);
  });

  await check("users: create with a normalized email; the user signs in; duplicates, role mismatches, and weak passwords fail", async () => {
    const created = await send(admin, "POST", "/admin/users", {
      email: "Owner@Board-Room.TEST",
      displayName: "Bea Board",
      organizationId: boardRoom.id,
      role: "retailer",
      password: NEW_PASSWORD,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    storeUser = adminUserSchema.parse(created.body);
    assert.equal(storeUser.email, "owner@board-room.test");
    assert.ok(!JSON.stringify(created.body).includes("assword"), "no password fields in responses");
    assert.equal((await loginWith("owner@board-room.test", NEW_PASSWORD)).status, 200);

    const auditBefore = await auditCount();
    const base = { displayName: "Someone", organizationId: boardRoom.id, role: "retailer", password: NEW_PASSWORD };
    assertError(await send(admin, "POST", "/admin/users", { ...base, email: "OWNER@board-room.test" }), 409, "EMAIL_ALREADY_EXISTS");
    const mismatch = await send(admin, "POST", "/admin/users", { ...base, email: "op@board-room.test", role: "operator" });
    assertError(mismatch, 422, "VALIDATION_FAILED");
    assert.deepEqual(mismatch.body.details.map((d) => d.field), ["role"]);
    assertError(await send(admin, "POST", "/admin/users", { ...base, email: "r@pandora.test", organizationId: DISTRIBUTOR_ID }), 422, "VALIDATION_FAILED");
    assertError(await send(admin, "POST", "/admin/users", { ...base, email: "short@board-room.test", password: "too-short" }), 422, "VALIDATION_FAILED");
    assertError(await send(admin, "POST", "/admin/users", { ...base, email: "not-an-email" }), 422, "VALIDATION_FAILED");
    const unknownOrg = await send(admin, "POST", "/admin/users", { ...base, email: "ghost@board-room.test", organizationId: "01920000-0000-7000-8000-00000000ffff" });
    assertError(unknownOrg, 422, "VALIDATION_FAILED");
    assert.deepEqual(unknownOrg.body.details.map((d) => d.field), ["organizationId"]);
    assertError(await send(admin, "POST", "/admin/users", { ...base, email: "x@board-room.test", isActive: false }), 422, "VALIDATION_FAILED");
    assert.equal(await auditCount(), auditBefore);

    const staff = await send(admin, "POST", "/admin/users", {
      email: "packer@pandora.test",
      displayName: "Pia Packer",
      organizationId: DISTRIBUTOR_ID,
      role: "operator",
      password: NEW_PASSWORD,
    });
    assert.equal(staff.status, 201);
    staffUser = staff.body;
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: staffUser.id, action: "created" } });
    assert.ok(!JSON.stringify(audit).includes("assword") && !JSON.stringify(audit).includes("argon2"), "audit holds no password data");

    const filtered = userListResponseSchema.parse((await call(`/admin/users?organizationId=${boardRoom.id}`, { actor: admin })).body);
    assert.deepEqual(filtered.items.map((u) => u.email), ["owner@board-room.test"]);
    assert.deepEqual((await call("/admin/users?role=operator&q=PACK", { actor: admin })).body.items.map((u) => u.email), ["packer@pandora.test"]);
    assert.deepEqual((await call("/admin/users?status=inactive", { actor: admin })).body.items.map((u) => u.email), ["former@tabletop-lantern.test"]);
    const everyone = (await call("/admin/users?pageSize=20", { actor: admin })).body;
    assert.equal(everyone.total, 8);
    assert.deepEqual(everyone.items.map((u) => u.email), [...everyone.items.map((u) => u.email)].sort());
  });

  await check("revocation: a name change keeps sessions; a role change and deactivation end them; reactivation restores sign-in", async () => {
    const session = await loginWith("packer@pandora.test", NEW_PASSWORD);
    const renamed = await send(admin, "PATCH", `/admin/users/${staffUser.id}`, { displayName: "Pia P. Packer" });
    assert.equal(renamed.status, 200);
    assert.equal(await sessionStatus(session), 200, "display-name changes keep the session");

    assertError(await send(admin, "PATCH", `/admin/users/${staffUser.id}`, { role: "retailer" }), 422, "VALIDATION_FAILED");
    assert.equal(await sessionStatus(session), 200);

    const promoted = await send(admin, "PATCH", `/admin/users/${staffUser.id}`, { role: "administrator" });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.role, "administrator");
    assertError(await call("/auth/session", { actor: session }), 401, "UNAUTHENTICATED");
    const revoked = await db.session.findMany({ where: { userId: staffUser.id }, select: { revokedReason: true } });
    assert.deepEqual(revoked.map((s) => s.revokedReason), ["role_changed"]);
    const roleAudit = await db.auditEvent.findFirstOrThrow({ where: { entityId: staffUser.id, action: "updated", after: { path: ["role"], equals: "administrator" } } });
    assert.equal(roleAudit.after.revokedSessions, 1);

    const again = await loginWith("packer@pandora.test", NEW_PASSWORD);
    const demoted = await send(admin, "PATCH", `/admin/users/${staffUser.id}`, { role: "operator", isActive: false });
    assert.equal(demoted.status, 200);
    assert.equal(await sessionStatus(again), 401);
    assert.equal((await db.session.findFirstOrThrow({ where: { userId: staffUser.id, revokedReason: { not: "role_changed" } } })).revokedReason, "user_deactivated");
    assert.equal((await loginWith("packer@pandora.test", NEW_PASSWORD)).status, 401, "inactive users cannot sign in");

    assert.equal((await send(admin, "PATCH", `/admin/users/${staffUser.id}`, { isActive: true })).status, 200);
    assert.equal(await sessionStatus(again), 401, "reactivation does not restore revoked sessions");
    assert.equal((await loginWith("packer@pandora.test", NEW_PASSWORD)).status, 200);
  });

  await check("password reset: old sessions end, the old password fails, the new one works; nothing secret is audited", async () => {
    const session = await loginWith("owner@board-room.test", NEW_PASSWORD);
    const hashBefore = (await db.user.findUniqueOrThrow({ where: { id: storeUser.id } })).passwordHash;
    assertError(await send(admin, "POST", `/admin/users/${storeUser.id}/password`, { password: "short" }), 422, "VALIDATION_FAILED");
    assert.equal(await sessionStatus(session), 200);
    const reset = await send(admin, "POST", `/admin/users/${storeUser.id}/password`, { password: RESET_PASSWORD });
    assert.equal(reset.status, 200);
    adminUserSchema.parse(reset.body);
    assert.equal(await sessionStatus(session), 401);
    assert.equal((await loginWith("owner@board-room.test", NEW_PASSWORD)).status, 401);
    assert.equal((await loginWith("owner@board-room.test", RESET_PASSWORD)).status, 200);
    assert.notEqual((await db.user.findUniqueOrThrow({ where: { id: storeUser.id } })).passwordHash, hashBefore);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: storeUser.id, action: "password_reset" } });
    // Both the sign-in from the user-creation check and this one ended.
    assert.deepEqual(audit.after, { id: storeUser.id, revokedSessions: 2 });
    assert.equal(await db.session.count({ where: { userId: storeUser.id, revokedReason: "password_reset" } }), 2);
    assertError(await send(admin, "POST", "/admin/users/01920000-0000-7000-8000-00000000ffff/password", { password: RESET_PASSWORD }), 404, "NOT_FOUND");
  });

  await check("organization deactivation ends member sessions and blocks sign-in without touching orders, reservations, or stock", async () => {
    const member = await login("retailer@tabletop-lantern.test");
    const business = async () => ({
      orders: await db.order.findMany({ where: { organizationId: LANTERN_ID }, select: { id: true, status: true, version: true }, orderBy: { id: "asc" } }),
      reservations: await db.stockReservation.findMany({ orderBy: { id: "asc" } }),
      stock: await db.inventoryItem.findMany({ select: { variantId: true, sellable: true, reserved: true }, orderBy: { variantId: "asc" } }),
      movements: await db.inventoryMovement.count(),
    });
    const before = await business();
    const deactivated = await send(admin, "PATCH", `/admin/organizations/${LANTERN_ID}`, { isActive: false });
    assert.equal(deactivated.status, 200);
    assert.deepEqual([deactivated.body.isActive, deactivated.body.activeUserCount], [false, 1], "user flags are unchanged");
    assert.equal(await sessionStatus(member), 401);
    assert.equal(await sessionStatus(lantern), 401);
    assert.equal((await loginWith("retailer@tabletop-lantern.test", process.env.SEED_USER_PASSWORD)).status, 401);
    const reasons = await db.session.findMany({ where: { user: { organizationId: LANTERN_ID } }, select: { revokedReason: true } });
    assert.ok(reasons.length >= 2 && reasons.every((s) => s.revokedReason === "organization_deactivated"));
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: LANTERN_ID, action: "updated" } });
    assert.equal(audit.after.revokedSessions, reasons.length);
    assert.deepEqual(await business(), before, "history and stock are preserved");
    const po8 = await db.order.findUniqueOrThrow({ where: { number: "PO-000008" } });
    assert.equal((await call(`/orders/${po8.id}`, { actor: operator })).status, 200, "staff still see the order");

    assert.equal((await send(admin, "PATCH", `/admin/organizations/${LANTERN_ID}`, { isActive: true })).status, 200);
    assert.equal((await loginWith("retailer@tabletop-lantern.test", process.env.SEED_USER_PASSWORD)).status, 200);
  });

  await check("last administrator: cannot be deactivated or demoted; parallel demotions of two administrators never remove both", async () => {
    // The packer account is an operator again; the seeded admin is the only administrator.
    assert.equal(await activeAdministrators(), 1);
    const before = await state();
    assertError(await send(admin, "PATCH", `/admin/users/${ADMIN_ID}`, { isActive: false }), 409, "LAST_ACTIVE_ADMINISTRATOR");
    assertError(await send(admin, "PATCH", `/admin/users/${ADMIN_ID}`, { role: "operator" }), 409, "LAST_ACTIVE_ADMINISTRATOR");
    assert.deepEqual(await state(), before);
    assert.equal(await sessionStatus(admin), 200);

    assert.equal((await send(admin, "PATCH", `/admin/users/${staffUser.id}`, { role: "administrator" })).status, 200);
    assert.equal(await activeAdministrators(), 2);
    const results = await Promise.all([
      send(admin, "PATCH", `/admin/users/${ADMIN_ID}`, { role: "operator" }),
      send(admin, "PATCH", `/admin/users/${staffUser.id}`, { isActive: false }),
    ]);
    const successes = assertSafeRace(results);
    assert.equal(await activeAdministrators(), 2 - successes);

    // Restore the seeded administrator for later checks.
    if (results[0].status === 200) {
      const packer = await loginWith("packer@pandora.test", NEW_PASSWORD);
      assert.equal((await send(packer, "PATCH", `/admin/users/${ADMIN_ID}`, { role: "administrator" })).status, 200);
      admin = await login("admin@pandora.test");
      assert.equal((await send(admin, "PATCH", `/admin/users/${staffUser.id}`, { role: "operator" })).status, 200);
    } else {
      assert.equal((await send(admin, "PATCH", `/admin/users/${staffUser.id}`, { isActive: true, role: "operator" })).status, 200);
    }
    assert.equal(await activeAdministrators(), 1);
  });

  await check("regression: serialization conflicts detected at COMMIT are retried (10 rounds, never a 500, never zero administrators)", async () => {
    // PostgreSQL reports this write skew at COMMIT; before the fix, runSerializable returned 500 instead of retrying.
    for (let round = 0; round < 10; round += 1) {
      await db.$executeRaw`UPDATE users SET role = 'ADMINISTRATOR' WHERE id = ${OPERATOR_ID}::uuid`;
      const results = await Promise.all([
        send(admin, "PATCH", `/admin/users/${ADMIN_ID}`, { role: "operator" }),
        send(admin, "PATCH", `/admin/users/${OPERATOR_ID}`, { isActive: false }),
      ]);
      const successes = assertSafeRace(results);
      assert.equal(await activeAdministrators(), 2 - successes);
      await db.$transaction([
        db.$executeRaw`UPDATE users SET role = 'ADMINISTRATOR', is_active = true WHERE id = ${ADMIN_ID}::uuid`,
        db.$executeRaw`UPDATE users SET role = 'OPERATOR', is_active = true WHERE id = ${OPERATOR_ID}::uuid`,
      ]);
      admin = await login("admin@pandora.test");
    }
  });

  await check("database rejects type changes, an inactive distributor, moved users, email changes, role mismatches, and losing every administrator", async () => {
    await assert.rejects(db.$executeRaw`UPDATE organizations SET type = 'DISTRIBUTOR' WHERE id = ${boardRoom.id}::uuid`, /identity is immutable|single_distributor/);
    await assert.rejects(db.$executeRaw`UPDATE organizations SET is_active = false WHERE id = ${DISTRIBUTOR_ID}::uuid`, /cannot be deactivated/);
    await assert.rejects(db.$executeRaw`INSERT INTO organizations (name, type, updated_at) VALUES ('BOARD ROOM GAMES & CO', 'RETAILER', now())`, /organizations_name_lower_key/);
    await assert.rejects(db.$executeRaw`INSERT INTO organizations (name, type, updated_at) VALUES ('   ', 'RETAILER', now())`, /organizations_name_length/);
    await assert.rejects(db.$executeRaw`UPDATE users SET organization_id = ${LANTERN_ID}::uuid WHERE id = ${storeUser.id}::uuid`, /identity is immutable/);
    await assert.rejects(db.$executeRaw`UPDATE users SET email = 'renamed@board-room.test' WHERE id = ${storeUser.id}::uuid`, /identity is immutable/);
    await assert.rejects(db.$executeRaw`UPDATE users SET role = 'OPERATOR' WHERE id = ${storeUser.id}::uuid`, /does not match/);
    await assert.rejects(db.$executeRaw`UPDATE users SET role = 'RETAILER' WHERE id = ${OPERATOR_ID}::uuid`, /does not match/);
    await assert.rejects(db.$executeRaw`UPDATE users SET display_name = '' WHERE id = ${storeUser.id}::uuid`, /users_display_name_length/);
    await assert.rejects(db.$executeRaw`UPDATE users SET is_active = false WHERE id = ${ADMIN_ID}::uuid`, /active administrator must remain/);
    // Swapping administrators inside one transaction is allowed: the check runs at commit.
    await db.$transaction([
      db.$executeRaw`UPDATE users SET role = 'OPERATOR' WHERE id = ${ADMIN_ID}::uuid`,
      db.$executeRaw`UPDATE users SET role = 'ADMINISTRATOR' WHERE id = ${OPERATOR_ID}::uuid`,
    ]);
    await db.$transaction([
      db.$executeRaw`UPDATE users SET role = 'ADMINISTRATOR' WHERE id = ${ADMIN_ID}::uuid`,
      db.$executeRaw`UPDATE users SET role = 'OPERATOR' WHERE id = ${OPERATOR_ID}::uuid`,
    ]);
    assert.equal(await activeAdministrators(), 1);
  });

  await check("rollback: an audit failure leaves the user active and their session valid", async () => {
    const session = await loginWith("owner@board-room.test", RESET_PASSWORD);
    const before = await state();
    await db.$executeRaw`CREATE FUNCTION reject_admin_check_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected QA audit failure'; END; $$`;
    await db.$executeRaw`CREATE TRIGGER reject_admin_check_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_admin_check_audit()`;
    try {
      assertError(await send(admin, "PATCH", `/admin/users/${storeUser.id}`, { isActive: false }), 500, "INTERNAL_ERROR");
      assertError(await send(admin, "PATCH", `/admin/organizations/${boardRoom.id}`, { isActive: false }), 500, "INTERNAL_ERROR");
      assertError(await send(admin, "POST", `/admin/users/${storeUser.id}/password`, { password: NEW_PASSWORD }), 500, "INTERNAL_ERROR");
      assert.deepEqual(await state(), before);
      assert.equal(await sessionStatus(session), 200);
    } finally {
      await db.$executeRaw`DROP TRIGGER reject_admin_check_audit ON audit_events`;
      await db.$executeRaw`DROP FUNCTION reject_admin_check_audit()`;
    }
  });

  await check("OpenAPI documents every administration route", async () => {
    const document = await (await fetch(`${qa.origin}/openapi.json`)).json();
    const expected = {
      "/api/admin/organizations": ["get", "post"],
      "/api/admin/organizations/{organizationId}": ["get", "patch"],
      "/api/admin/users": ["get", "post"],
      "/api/admin/users/{userId}": ["get", "patch"],
      "/api/admin/users/{userId}/password": ["post"],
    };
    for (const [route, methods] of Object.entries(expected)) {
      for (const method of methods) assert.ok(document.paths[route]?.[method], `${method} ${route}`);
    }
  });

  const logs = qa.logs();
  for (const secret of [process.env.SEED_USER_PASSWORD, NEW_PASSWORD, RESET_PASSWORD, "$argon2", "pandora_session="]) {
    assert.ok(!logs.includes(secret), "logs must not contain passwords, hashes, or tokens");
  }
  console.log(`\n${qa.passed} administration check groups passed.`);
} catch (error) {
  console.error(qa.logs().slice(-4000));
  throw error;
} finally {
  await qa.stop();
}
