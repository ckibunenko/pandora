// Browser checks for shipments and cancellation requests, using the shared CDP driver.
// Requires a freshly seeded QA API and web server; see context/features/fulfillment-verification.md.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunner, startBrowser } from "./cdp.mjs";

const BASE = process.env.FULFILLMENT_BROWSER_URL ?? "http://localhost:5175";
const EVIDENCE = process.env.FULFILLMENT_CHECK_EVIDENCE ?? join(tmpdir(), "pandora-fulfillment-evidence");
const PASSWORD = process.env.SEED_USER_PASSWORD;
assert.ok(PASSWORD, "SEED_USER_PASSWORD must be set (run with --env-file=.env).");

const page = await startBrowser({ base: BASE, evidence: EVIDENCE, port: Number(process.env.FULFILLMENT_CDP_PORT ?? 9337) });
const { q, evaluate, waitFor, text, count, fill, click, navigate, screenshot, setWidth, noHorizontalOverflow, logout, pageErrors } = page;
const login = (email) => page.login(email, PASSWORD);
const runner = checkRunner();
const check = runner.check;
const line = (sku) => `[data-test=order-line][data-sku="${sku}"]`;
const shipLine = (sku) => `[data-test=shipment-line][data-sku="${sku}"] [data-test=shipment-quantity]`;

async function openOrder(number, status) {
  await navigate(`/orders?status=${status}`);
  await waitFor(`!!${q(`[data-test=order-row][data-order-number="${number}"]`)}`, `${number} listed`);
  await click(`[data-test=order-row][data-order-number="${number}"] [data-test=order-link]`);
  await waitFor(`${q("[data-test=order-number]")}?.textContent === "${number}"`, `${number} page`);
}

try {
  await setWidth(1280);

  await check("staff see fulfillment progress and shipment history on a partially shipped order", async () => {
    await login("operator@pandora.test");
    await openOrder("PO-000008", "partially_shipped");
    assert.equal(await text("[data-test=order-status]"), "Partially shipped");
    assert.equal(await text(`${line("LOV-EN-STD")} [data-test=order-line-shipped]`), "2");
    assert.equal(await text(`${line("LOV-EN-STD")} [data-test=order-line-outstanding]`), "3");
    assert.equal(await text(`${line("LOV-EN-STD")} [data-test=order-line-reserved]`), "3");
    assert.match(await text('[data-test=shipment-row][data-shipment-number="SH-000001"]'), /LOV-EN-STD × 2/);
    await screenshot("partially-shipped");
  });

  await check("shipment form: over-quantity is flagged client-side; a partial shipment is recorded", async () => {
    await fill(shipLine("LOV-EN-STD"), "9");
    await click("[data-test=shipment-submit]");
    await waitFor(`${q(shipLine("LOV-EN-STD"))}.getAttribute("aria-invalid") === "true"`, "quantity flagged");
    await fill(shipLine("LOV-EN-STD"), "1");
    assert.equal(await text("[data-test=shipment-submit]"), "Record shipment of 1 unit");
    await click("[data-test=shipment-submit]");
    await waitFor(`document.querySelectorAll("[data-test=shipment-row]").length === 2`, "second shipment listed");
    assert.equal(await text(`${line("LOV-EN-STD")} [data-test=order-line-outstanding]`), "2");
    assert.equal(await text("[data-test=order-status]"), "Partially shipped");
  });

  await check("keyboard: shipment quantity and submit are reachable with Tab and show focus", async () => {
    await evaluate(`${q(shipLine("LOV-EN-STD"))}.focus()`);
    await page.pressTab();
    assert.equal(await evaluate("document.activeElement?.dataset.test"), "shipment-submit");
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none");
    await setWidth(390);
    assert.ok(await noHorizontalOverflow(), "fulfillment page overflows at 390px");
    await screenshot("fulfillment-narrow");
    await setWidth(1280);
  });

  await check("a pending request is reviewed: rejection needs a reason, approval cancels a confirmed order", async () => {
    await openOrder("PO-000009", "confirmed");
    await waitFor(`!!${q("[data-test=cancellation-review]")}`, "request panel");
    assert.match(await text("[data-test=cancellation-review]"), /MBM-SR-STD × 2.*Store event was postponed/);
    await click("[data-test=cancellation-reject]");
    await waitFor(`${q("[data-test=cancellation-reject-reason]")}.getAttribute("aria-invalid") === "true"`, "reason required");
    await click("[data-test=cancellation-approve]");
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Cancelled"`, "cancelled");
    assert.equal(await text(`${line("MBM-SR-STD")} [data-test=order-line-cancelled]`), "2");
    assert.equal(await count('[data-test=cancellation-request-row][data-status="approved"]'), 1);
    assert.equal(await count("[data-test=shipment-form]"), 0);
    await logout();
  });

  await check("retailer requests cancellation of what is left; the pending request is shown instead of the button", async () => {
    await login("retailer@tabletop-lantern.test");
    await openOrder("PO-000008", "partially_shipped");
    assert.equal(await count("[data-test=shipment-form]"), 0, "retailers cannot ship");
    await click("[data-test=cancellation-request]");
    await waitFor(`!!${q("[data-test=cancellation-request-panel]")}`, "request panel");
    assert.match(await text("[data-test=cancellation-request-panel]"), /2 units not yet shipped/);
    await fill("[data-test=cancellation-request-reason]", "Overstocked after the fair");
    await click("[data-test=cancellation-request-submit]");
    await waitFor(`!!${q("[data-test=cancellation-pending]")}`, "pending notice");
    assert.equal(await count("[data-test=cancellation-request]"), 0);
    await screenshot("retailer-pending");
    await logout();
  });

  await check("staff approve the request: the order closes as partly cancelled and stock is released", async () => {
    await login("operator@pandora.test");
    await openOrder("PO-000008", "partially_shipped");
    await waitFor(`!!${q("[data-test=cancellation-review]")}`, "request panel");
    assert.match(await text("[data-test=cancellation-review]"), /Overstocked after the fair/);
    await click("[data-test=cancellation-approve]");
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Closed (partly cancelled)"`, "closed partial");
    assert.equal(await text(`${line("LOV-EN-STD")} [data-test=order-line-shipped]`), "3");
    assert.equal(await text(`${line("LOV-EN-STD")} [data-test=order-line-cancelled]`), "2");
    assert.equal(await text(`${line("LOV-EN-STD")} [data-test=order-line-reserved]`), "0");
    await screenshot("closed-partial");
  });

  await check("shipping everything on a confirmed order marks it shipped; inventory shows the movements", async () => {
    await openOrder("PO-000006", "confirmed");
    assert.equal(await text("[data-test=shipment-submit]"), "Record shipment of 2 units");
    await click("[data-test=shipment-submit]");
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Shipped"`, "shipped");
    assert.equal(await count("[data-test=shipment-form]"), 0);
    await navigate("/inventory?q=LOV-SR-STD");
    await waitFor(`!!${q('[data-test=inventory-row][data-sku="LOV-SR-STD"]')}`, "inventory row");
    await click('[data-test=inventory-row][data-sku="LOV-SR-STD"] [data-test=inventory-detail-link]');
    await waitFor(`document.querySelectorAll("[data-test=movement-row]").length >= 3`, "movements");
    const rows = await evaluate(`[...document.querySelectorAll("[data-test=movement-row]")].slice(0, 2).map((row) => row.textContent)`);
    assert.ok(rows.every((row) => /Shipment/.test(row) && /SH-00\d{4}/.test(row)), rows.join(" | "));
    await logout();
  });

  await check("the retailer sees the final states read-only; no page errors", async () => {
    await login("retailer@cardboard-keep.test");
    await navigate("/orders?status=cancelled");
    await waitFor(`!!${q('[data-test=order-row][data-order-number="PO-000009"]')}`, "cancelled order listed");
    await click('[data-test=order-row][data-order-number="PO-000009"] [data-test=order-link]');
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Cancelled"`, "cancelled");
    assert.equal(await count("[data-test=cancellation-request]"), 0);
    assert.match(await text("[data-test=cancellation-request-list]"), /Approved/);
    await logout();
    assert.deepEqual(pageErrors, []);
  });

  console.log(`\n${runner.passed} fulfillment browser check groups passed. Screenshots: ${EVIDENCE}`);
} finally {
  page.close();
}
