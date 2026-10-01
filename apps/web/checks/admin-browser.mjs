// Browser checks for organization and user administration, using the shared CDP driver.
// Requires a freshly seeded QA API and web server; see context/features/admin-management-verification.md.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunner, startBrowser } from "./cdp.mjs";

const BASE = process.env.ADMIN_BROWSER_URL ?? "http://localhost:5175";
const EVIDENCE = process.env.ADMIN_CHECK_EVIDENCE ?? join(tmpdir(), "pandora-admin-evidence");
const PASSWORD = process.env.SEED_USER_PASSWORD;
assert.ok(PASSWORD, "SEED_USER_PASSWORD must be set (run with --env-file=.env).");
const FIRST_PASSWORD = "Meeple-first-password-1";
const SECOND_PASSWORD = "Meeple-second-password-2";

const page = await startBrowser({ base: BASE, evidence: EVIDENCE, port: Number(process.env.ADMIN_CDP_PORT ?? 9338) });
const { q, evaluate, waitFor, text, count, fill, click, navigate, screenshot, setWidth, noHorizontalOverflow, logout, pageErrors } = page;
const login = (email, password = PASSWORD) => page.login(email, password);
const runner = checkRunner();
const check = runner.check;

/** A second, API-only administrator session, used to change the account the browser is signed in with. */
async function apiAdmin() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@pandora.test", password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await response.json();
  return (method, path, body) =>
    fetch(`${BASE}/api${path}`, {
      method,
      headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
}

try {
  await setWidth(1280);
  let userPath;

  await check("administrators reach Organizations and Users from the navigation; filters live in the URL", async () => {
    await login("admin@pandora.test");
    await click("[data-test=organizations-nav]");
    await waitFor(`!!${q('[data-test=organization-row][data-organization-name="Pandora Distribution"]')}`, "organization list");
    assert.equal(await text("[data-test=organization-total]"), "4 organizations");
    await fill("[data-test=organization-status-filter]", "inactive");
    await waitFor(`${q("[data-test=organization-total]")}?.textContent === "1 organization"`, "inactive filter");
    assert.match(await evaluate("location.search"), /status=inactive/);
    assert.equal(await text('[data-test=organization-row][data-organization-name="Closed Shelf Games"] [data-test=organization-status]'), "Inactive");
    await click("[data-test=users-nav]");
    await waitFor(`!!${q('[data-test=user-row][data-email="admin@pandora.test"]')}`, "user list");
    await fill("[data-test=user-role-filter]", "administrator");
    await waitFor(`${q("[data-test=user-total]")}?.textContent === "1 user"`, "role filter");
    await screenshot("users-list");
  });

  await check("create an organization; a duplicate name in another case is reported on the field", async () => {
    await navigate("/admin/organizations");
    await waitFor(`!!${q("[data-test=organization-create]")}`, "create link");
    await click("[data-test=organization-create]");
    await waitFor(`!!${q("[data-test=organization-form]")}`, "organization form");
    await click("[data-test=organization-save]");
    await waitFor(`${q("[data-test=field-organization-name]")}.getAttribute("aria-invalid") === "true"`, "empty name flagged");
    await fill("[data-test=field-organization-name]", "Meeple Market");
    await click("[data-test=organization-save]");
    await waitFor(`${q("[data-test=organization-heading]")}?.textContent === "Meeple Market"`, "organization page");
    assert.equal(await count("[data-test=organization-member]"), 0);

    await navigate("/admin/organizations/new");
    await waitFor(`!!${q("[data-test=organization-form]")}`, "organization form");
    await fill("[data-test=field-organization-name]", "meeple MARKET");
    await click("[data-test=organization-save]");
    await waitFor(`!!${q("[data-test=organization-error]")}`, "duplicate error");
    assert.match(await text("[data-test=organization-error]"), /already exists/);
    assert.equal(await evaluate(`${q("[data-test=field-organization-name]")}.value`), "meeple MARKET", "input is kept");
    assert.equal(await evaluate(`${q("[data-test=field-organization-name]")}.getAttribute("aria-invalid")`), "true");
  });

  await check("add a user from the organization page; the role follows the organization; the new user signs in", async () => {
    await navigate("/admin/organizations?q=Meeple");
    await waitFor(`!!${q('[data-test=organization-row][data-organization-name="Meeple Market"]')}`, "Meeple listed");
    await click('[data-test=organization-row][data-organization-name="Meeple Market"] [data-test=organization-link]');
    await waitFor(`!!${q("[data-test=organization-add-user]")}`, "add user link");
    await click("[data-test=organization-add-user]");
    await waitFor(`${q("[data-test=field-user-organization]")}?.selectedOptions[0]?.textContent === "Meeple Market"`, "organization prefilled");
    assert.equal(await evaluate(`${q("[data-test=field-user-role]")}.value`), "retailer");
    assert.equal(await evaluate(`${q("[data-test=field-user-role]")}.disabled`), true, "retailer stores have one role");
    await fill("[data-test=field-user-email]", "Mia@Meeple-Market.test");
    await fill("[data-test=field-user-display-name]", "Mia Meeple");
    await fill("[data-test=field-user-password]", "short");
    await click("[data-test=user-save]");
    await waitFor(`${q("[data-test=field-user-password]")}.getAttribute("aria-invalid") === "true"`, "short password flagged");
    await fill("[data-test=field-user-password]", FIRST_PASSWORD);
    await click("[data-test=user-save]");
    await waitFor(`!!${q("[data-test=user-created]")}`, "user created");
    await waitFor(`!!${q("[data-test=user-email]")}`, "created user details loaded");
    assert.equal(await text("[data-test=user-email]"), "mia@meeple-market.test");
    userPath = await evaluate("location.pathname");

    await navigate("/admin/users/new");
    await waitFor(`(${q("[data-test=field-user-organization]")}?.options.length ?? 0) > 1`, "organizations loaded");
    const distributor = await evaluate(`[...${q("[data-test=field-user-organization]")}.options].find((o) => o.textContent === "Pandora Distribution").value`);
    await fill("[data-test=field-user-organization]", distributor);
    await waitFor(`${q("[data-test=field-user-role]")}.value === "operator" && !${q("[data-test=field-user-role]")}.disabled`, "staff roles offered");
    assert.deepEqual(await evaluate(`[...${q("[data-test=field-user-role]")}.options].map((o) => o.value)`), ["operator", "administrator"]);

    await logout();
    await login("mia@meeple-market.test", FIRST_PASSWORD);
    assert.equal(await evaluate("location.pathname"), "/catalog");
    assert.equal(await count("[data-test=organizations-nav]"), 0);
  });

  await check("deactivating a signed-in user returns them to the sign-in page on their next request", async () => {
    const admin = await apiAdmin();
    const users = await (await admin("GET", "/admin/users?q=mia%40meeple")).json();
    const mia = users.items[0];
    assert.equal((await admin("PATCH", `/admin/users/${mia.id}`, { isActive: false })).status, 200);
    await navigate("/orders");
    await waitFor(`location.pathname === "/login" && !!${q("[data-test=login-email]")}`, "sent to sign-in");
    assert.equal((await admin("PATCH", `/admin/users/${mia.id}`, { isActive: true })).status, 200);
  });

  await check("password reset: mismatched confirmation is flagged; the user signs in with the new password only", async () => {
    await login("admin@pandora.test");
    await navigate(userPath);
    await waitFor(`!!${q("[data-test=password-form]")}`, "password form");
    await fill("[data-test=field-new-password]", SECOND_PASSWORD);
    await fill("[data-test=field-confirm-password]", "something-else-entirely");
    await click("[data-test=password-save]");
    await waitFor(`${q("[data-test=field-confirm-password]")}.getAttribute("aria-invalid") === "true"`, "mismatch flagged");
    await fill("[data-test=field-confirm-password]", SECOND_PASSWORD);
    await click("[data-test=password-save]");
    await waitFor(`!!${q("[data-test=password-saved]")}`, "reset confirmed");
    assert.equal(await evaluate(`${q("[data-test=field-new-password]")}.value`), "", "password fields are cleared");
    await screenshot("user-page");
    await logout();
    await page.navigate("/login");
    await waitFor(`!!${q("[data-test=login-email]")}`, "login form");
    await fill("[data-test=login-email]", "mia@meeple-market.test");
    await fill("[data-test=login-password]", FIRST_PASSWORD);
    await click("[data-test=login-submit]");
    await waitFor(`!!document.querySelector("[role=alert]")`, "old password rejected");
    await login("mia@meeple-market.test", SECOND_PASSWORD);
    await logout();
  });

  await check("the last administrator cannot deactivate their own account; the reason is shown", async () => {
    await login("admin@pandora.test");
    await navigate("/admin/users?q=admin%40pandora");
    await waitFor(`!!${q('[data-test=user-row][data-email="admin@pandora.test"]')}`, "admin listed");
    await click('[data-test=user-row][data-email="admin@pandora.test"] [data-test=user-link]');
    await waitFor(`!!${q("[data-test=user-active]")}`, "user form");
    await click("[data-test=user-active]");
    await waitFor(`!!${q("[data-test=user-sessions-notice]")}`, "own-account notice");
    assert.match(await text("[data-test=user-sessions-notice]"), /your own account/);
    await click("[data-test=user-save]");
    await waitFor(`!!${q("[data-test=user-error]")}`, "last administrator error");
    assert.match(await text("[data-test=user-error]"), /last active administrator/);
    assert.equal(await text("[data-test=user-status]"), "Active");
    assert.equal(await evaluate(`${q("[data-test=user-active]")}.checked`), false, "unsaved input is kept");
  });

  await check("organization deactivation explains its effect; the distributor cannot be deactivated", async () => {
    await navigate("/admin/organizations?q=Meeple");
    await waitFor(`!!${q('[data-test=organization-row][data-organization-name="Meeple Market"]')}`, "Meeple listed");
    await click('[data-test=organization-row][data-organization-name="Meeple Market"] [data-test=organization-link]');
    await waitFor(`!!${q("[data-test=organization-active]")}`, "organization form");
    await click("[data-test=organization-active]");
    await waitFor(`!!${q("[data-test=organization-deactivation-notice]")}`, "deactivation notice");
    assert.match(await text("[data-test=organization-deactivation-notice]"), /signs out all 1 active user/);
    await click("[data-test=organization-save]");
    await waitFor(`!!${q("[data-test=organization-saved]")}`, "saved");
    await waitFor(`${q("[data-test=organization-status]")}?.textContent === "Inactive"`, "inactive badge");

    await navigate("/admin/organizations?type=distributor");
    await waitFor(`!!${q('[data-test=organization-row][data-organization-name="Pandora Distribution"]')}`, "distributor listed");
    await click('[data-test=organization-row][data-organization-name="Pandora Distribution"] [data-test=organization-link]');
    await waitFor(`!!${q("[data-test=organization-active]")}`, "distributor form");
    assert.equal(await evaluate(`${q("[data-test=organization-active]")}.disabled`), true);
    assert.equal(await count("[data-test=organization-member]"), 2);
  });

  await check("keyboard and narrow layout: fields are reachable with Tab and show focus; no horizontal overflow at 390px", async () => {
    await navigate(userPath);
    await waitFor(`!!${q("[data-test=field-user-display-name]")}`, "user form");
    await evaluate(`${q("[data-test=field-user-display-name]")}.focus()`);
    await page.pressTab();
    assert.equal(await evaluate("document.activeElement?.dataset.test"), "user-active");
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none");
    await setWidth(390);
    assert.ok(await noHorizontalOverflow(), "user page overflows at 390px");
    await screenshot("user-narrow");
    await navigate("/admin/users");
    await waitFor(`!!${q("[data-test=user-row]")}`, "user list");
    assert.ok(await noHorizontalOverflow(), "user list overflows at 390px");
    await navigate("/admin/organizations");
    await waitFor(`!!${q("[data-test=organization-row]")}`, "organization list");
    assert.ok(await noHorizontalOverflow(), "organization list overflows at 390px");
    await setWidth(1280);
    await logout();
  });

  await check("operators see no administration navigation and are refused on direct links; no page errors", async () => {
    await login("operator@pandora.test");
    assert.equal(await count("[data-test=organizations-nav]"), 0);
    assert.equal(await count("[data-test=users-nav]"), 0);
    await navigate("/admin/users");
    await waitFor(`document.querySelector("h1")?.textContent === "Access restricted"`, "restricted");
    assert.equal(await count("[data-test=user-row]"), 0);
    await logout();
    assert.deepEqual(pageErrors, []);
  });

  console.log(`\n${runner.passed} administration browser check groups passed. Screenshots: ${EVIDENCE}`);
} finally {
  page.close();
}
