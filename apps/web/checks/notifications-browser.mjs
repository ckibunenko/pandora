// Browser checks for notification diagnostics, using the shared CDP driver.
// Requires a freshly seeded QA API, web server, and a notification worker with NOTIFICATION_FAILURE_MODE=permanent;
// see context/features/notifications-verification.md.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunner, startBrowser } from "./cdp.mjs";

const BASE = process.env.NOTIFICATIONS_BROWSER_URL ?? "http://localhost:5175";
const EVIDENCE = process.env.NOTIFICATIONS_CHECK_EVIDENCE ?? join(tmpdir(), "pandora-notifications-evidence");
const PASSWORD = process.env.SEED_USER_PASSWORD;
assert.ok(PASSWORD, "SEED_USER_PASSWORD must be set (run with --env-file=.env).");

const page = await startBrowser({ base: BASE, evidence: EVIDENCE, port: Number(process.env.NOTIFICATIONS_CDP_PORT ?? 9342) });
const { q, evaluate, waitFor, text, count, fill, click, navigate, screenshot, setWidth, noHorizontalOverflow, logout, pageErrors } = page;
const login = (email) => page.login(email, PASSWORD);
const runner = checkRunner();
const check = runner.check;
const rowsText = () => evaluate(`[...document.querySelectorAll("[data-test=notification-row]")].map((row) => row.textContent).join(" | ")`);

try {
  await setWidth(1280);

  await check("a retailer submission queues staff notifications; retailers have no diagnostics", async () => {
    await login("retailer@tabletop-lantern.test");
    assert.equal(await count("[data-test=notifications-nav]"), 0);
    await navigate("/orders?status=draft");
    await waitFor(`!!${q('[data-test=order-row][data-order-number="PO-000001"]')}`, "draft listed");
    await click('[data-test=order-row][data-order-number="PO-000001"] [data-test=order-link]');
    await waitFor(`!!${q("[data-test=order-submit]")}`, "draft editor");
    await click("[data-test=order-submit]");
    await waitFor(`!!${q("[data-test=order-submit-confirm]")}`, "submit confirmation");
    await click("[data-test=order-submit-confirm]");
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Submitted"`, "submitted");
    await navigate("/notifications");
    await waitFor(`document.querySelector("h1")?.textContent === "Access restricted"`, "restricted for retailers");
    assert.equal(await count("[data-test=notification-row]"), 0);
    await logout();
  });

  await check("operators see failed deliveries with status text, attempts, and errors, but no addresses", async () => {
    await login("operator@pandora.test");
    await click("[data-test=notifications-nav]");
    await waitFor(`location.pathname === "/notifications" && document.querySelectorAll("[data-test=notification-row]").length === 2`, "two jobs");
    await waitFor(
      `[...document.querySelectorAll("[data-test=notification-row]")].every((row) => row.dataset.status === "failed")`,
      "the controlled failure settles both jobs",
    );
    await fill("[data-test=notifications-status-filter]", "failed");
    await waitFor(`new URLSearchParams(location.search).get("status") === "failed"`, "status filter in URL");
    await waitFor(`${q("[data-test=notifications-total]")}?.textContent === "2 notifications"`, "filtered total");
    const rows = await rowsText();
    assert.match(rows, /Order submitted.*PO-000001/);
    assert.match(rows, /Failed.*1 of 5.*Controlled permanent delivery failure/);
    assert.doesNotMatch(rows, /@/, "operators do not see recipient addresses");
    await fill("[data-test=notifications-event-filter]", "return.received");
    await waitFor(`!!${q("[data-test=notifications-empty]")}`, "empty state");
    await fill("[data-test=notifications-event-filter]", "order.submitted");
    await waitFor(`document.querySelectorAll("[data-test=notification-row]").length === 2`, "event filter");
    await screenshot("operator-list");
    await setWidth(390);
    assert.ok(await noHorizontalOverflow(), "notification list overflows at 390px");
    await screenshot("operator-list-narrow");
    await setWidth(1280);
  });

  await check("detail shows attempts without the message; retry grants one more attempt and keyboard focus is visible", async () => {
    await click("[data-test=notification-row] [data-test=notification-link]");
    await waitFor(`!!${q("[data-test=notification-detail]")}`, "detail");
    assert.equal(await text("[data-test=notification-status]"), "Failed");
    assert.equal(await count("[data-test=notification-body]"), 0, "operators do not see the body");
    assert.equal(await count("[data-test=notification-recipient-email]"), 0);
    assert.match(await text('[data-test=notification-attempt-row][data-outcome="failed"]'), /Controlled permanent delivery failure/);
    assert.match(await text("[data-test=notification-correlation-id]"), /^[A-Za-z0-9-]+$/);
    await evaluate(`${q("[data-test=notification-detail] a")}.focus()`);
    await page.pressTab();
    assert.equal(await evaluate("document.activeElement?.dataset.test"), "notification-retry");
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none");
    await click("[data-test=notification-retry]");
    await waitFor(`document.querySelectorAll("[data-test=notification-attempt-row]").length === 2`, "second attempt recorded", 15_000);
    await waitFor(`${q("[data-test=notification-status]")}?.textContent === "Failed"`, "failed again under the controlled failure");
    assert.match(await text("[data-test=notification-detail]"), /2 of 2/);
    await setWidth(390);
    assert.ok(await noHorizontalOverflow(), "notification detail overflows at 390px");
    await screenshot("operator-detail-narrow");
    await setWidth(1280);
    await logout();
  });

  await check("administrators also see recipient addresses and the message; the audit trail records the retry; no page errors", async () => {
    await login("admin@pandora.test");
    await navigate("/notifications?eventType=order.submitted");
    await waitFor(`document.querySelectorAll("[data-test=notification-row]").length === 2`, "rows");
    assert.match(await rowsText(), /admin@pandora\.test/);
    await click("[data-test=notification-row] [data-test=notification-link]");
    await waitFor(`!!${q("[data-test=notification-body]")}`, "message body");
    assert.match(await text("[data-test=notification-body]"), /^Hello [\s\S]*PO-000001/);
    assert.match(await text("[data-test=notification-recipient-email]"), /@pandora\.test/);
    await screenshot("admin-detail");
    await navigate("/audit?entityType=notification");
    await waitFor(`document.querySelectorAll("[data-test=audit-row]").length === 1`, "retry audited");
    assert.match(await text("[data-test=audit-row]"), /notification · retry requested/);
    await logout();
    assert.deepEqual(pageErrors, []);
  });

  console.log(`\n${runner.passed} notification browser check groups passed. Screenshots: ${EVIDENCE}`);
} finally {
  page.close();
}
