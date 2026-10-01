// Browser checks for return requests, decisions, and receipts, using the shared CDP driver.
// Requires a freshly seeded QA API and web server; see context/features/returns-verification.md.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunner, startBrowser } from "./cdp.mjs";

const BASE = process.env.RETURNS_BROWSER_URL ?? "http://localhost:5175";
const EVIDENCE = process.env.RETURNS_CHECK_EVIDENCE ?? join(tmpdir(), "pandora-returns-evidence");
const PASSWORD = process.env.SEED_USER_PASSWORD;
assert.ok(PASSWORD, "SEED_USER_PASSWORD must be set (run with --env-file=.env).");

const page = await startBrowser({ base: BASE, evidence: EVIDENCE, port: Number(process.env.RETURNS_CDP_PORT ?? 9341) });
const { q, evaluate, waitFor, text, count, fill, click, navigate, screenshot, setWidth, noHorizontalOverflow, logout, pageErrors } = page;
const login = (email) => page.login(email, PASSWORD);
const runner = checkRunner();
const check = runner.check;
const row = (number) => `[data-test=return-row][data-return-number="${number}"]`;
const review = (number) => `[data-test=return-review][data-return-number="${number}"]`;
const requestLine = (sku) => `[data-test=return-request-line][data-sku="${sku}"] [data-test=return-request-quantity]`;
const receiptLine = (sku, bucket) => `[data-test=return-receipt-line][data-sku="${sku}"] [data-test=return-receipt-${bucket}]`;

async function openOrder(number, query) {
  await navigate(`/orders?${query}`);
  await waitFor(`!!${q(`[data-test=order-row][data-order-number="${number}"]`)}`, `${number} listed`);
  await click(`[data-test=order-row][data-order-number="${number}"] [data-test=order-link]`);
  await waitFor(`${q("[data-test=order-number]")}?.textContent === "${number}"`, `${number} page`);
}

let requested;
try {
  await setWidth(1280);

  await check("staff find the seeded return through the open-returns filter and badge", async () => {
    await login("operator@pandora.test");
    await navigate("/orders");
    await waitFor(`!!${q("[data-test=orders-returns-filter]")}`, "returns filter");
    await fill("[data-test=orders-returns-filter]", "open");
    await waitFor(`new URLSearchParams(location.search).get("returns") === "open" && ${q("[data-test=orders-total]")}?.textContent === "1 order"`, "filtered list");
    assert.equal(await text('[data-test=order-row][data-order-number="PO-000008"] [data-test=order-open-returns]'), "1 open return");
    await click('[data-test=order-row][data-order-number="PO-000008"] [data-test=order-link]');
    await waitFor(`!!${q(review("RT-000001"))}`, "review panel");
    assert.match(await text(review("RT-000001")), /LOV-EN-STD × 1 \(SH-000001\).*One box arrived with a crushed corner/);
    assert.equal(await text(`${row("RT-000001")} strong`), "RT-000001");
    await screenshot("staff-review");
  });

  await check("rejecting needs a reason; the rejected return stays in the list and the order status is unchanged", async () => {
    await click(`${review("RT-000001")} [data-test=return-reject]`);
    await waitFor(`${q(`${review("RT-000001")} [data-test=return-reject-reason]`)}.getAttribute("aria-invalid") === "true"`, "reason required");
    await fill(`${review("RT-000001")} [data-test=return-reject-reason]`, "Crushed corners are cosmetic only");
    await click(`${review("RT-000001")} [data-test=return-reject]`);
    await waitFor(`${q(row("RT-000001"))}?.dataset.status === "rejected"`, "rejected");
    assert.equal(await count(review("RT-000001")), 0);
    assert.match(await text(row("RT-000001")), /Rejected.*Crushed corners are cosmetic only/);
    assert.equal(await text("[data-test=order-status]"), "Partially shipped");
  });

  await check("staff ship a confirmed order completely so it can be returned", async () => {
    await openOrder("PO-000006", "status=confirmed");
    await click("[data-test=shipment-submit]");
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Shipped"`, "shipped");
    assert.equal(await count("[data-test=return-request]"), 0, "staff cannot request returns");
    await logout();
  });

  await check("retailer request form: per-item limits, a required reason, keyboard order, and 390px layout", async () => {
    await login("retailer@tabletop-lantern.test");
    await openOrder("PO-000006", "status=shipped");
    await click("[data-test=return-request]");
    await waitFor(`!!${q("[data-test=return-request-panel]")}`, "request form");
    assert.match(await text("[data-test=return-request-line]"), /SH-\d{6} · LOV-SR-STD \(2 shipped, 2 returnable\)/);
    assert.equal(await evaluate(`${q(requestLine("LOV-SR-STD"))}.value`), "0");
    await click("[data-test=return-request-submit]");
    await waitFor(`/at least one item/.test(${q("[data-test=return-request-panel] [role=alert]")}?.textContent ?? "")`, "empty request refused");
    assert.equal(await evaluate(`${q("[data-test=return-request-reason]")}.getAttribute("aria-invalid")`), "true");
    await fill(requestLine("LOV-SR-STD"), "3");
    await click("[data-test=return-request-submit]");
    await waitFor(`${q(requestLine("LOV-SR-STD"))}.getAttribute("aria-invalid") === "true"`, "over-quantity flagged");
    await fill(requestLine("LOV-SR-STD"), "2");
    assert.equal(await text("[data-test=return-request-submit]"), "Send return request for 2 units");
    await evaluate(`${q(requestLine("LOV-SR-STD"))}.focus()`);
    await page.pressTab();
    assert.equal(await evaluate("document.activeElement?.dataset.test"), "return-request-reason");
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none");
    await setWidth(390);
    assert.ok(await noHorizontalOverflow(), "return request form overflows at 390px");
    await screenshot("return-request-narrow");
    await setWidth(1280);
  });

  await check("retailer sends the request; it is listed as pending and nothing is left to request", async () => {
    await fill("[data-test=return-request-reason]", "Wrong language edition delivered");
    await click("[data-test=return-request-submit]");
    await waitFor(`${q("[data-test=return-row]")}?.dataset.status === "pending"`, "pending return listed");
    requested = await evaluate(`${q("[data-test=return-row]")}.dataset.returnNumber`);
    assert.match(requested, /^RT-00[1-9]\d{3}$/);
    assert.match(await text(row(requested)), /Pending.*LOV-SR-STD × 2.*Wrong language edition delivered/);
    assert.equal(await count("[data-test=return-request]"), 0, "no returnable units left");
    assert.equal(await count("[data-test=return-review]"), 0, "retailers cannot decide");
    await logout();
  });

  await check("staff approve, then a short receipt needs a discrepancy reason; stock and status are reported", async () => {
    await login("operator@pandora.test");
    await openOrder("PO-000006", "returns=open");
    await waitFor(`!!${q(review(requested))}`, "review panel");
    await click(`${review(requested)} [data-test=return-approve]`);
    await waitFor(`!!${q(`[data-test=return-receipt][data-return-number="${requested}"]`)}`, "receipt form");
    assert.equal(await evaluate(`${q(receiptLine("LOV-SR-STD", "sellable"))}.value`), "2");
    await fill(receiptLine("LOV-SR-STD", "sellable"), "1");
    await fill(receiptLine("LOV-SR-STD", "damaged"), "2");
    await click("[data-test=return-receipt-submit]");
    await waitFor(`${q(receiptLine("LOV-SR-STD", "sellable"))}.getAttribute("aria-invalid") === "true"`, "over-receipt flagged");
    await fill(receiptLine("LOV-SR-STD", "damaged"), "0");
    assert.equal(await text("[data-test=return-receipt-submit]"), "Record receipt of 1 unit");
    await click("[data-test=return-receipt-submit]");
    await waitFor(`${q("[data-test=return-receipt-discrepancy]")}.getAttribute("aria-invalid") === "true"`, "discrepancy required");
    await setWidth(390);
    assert.ok(await noHorizontalOverflow(), "receipt form overflows at 390px");
    await screenshot("return-receipt-narrow");
    await setWidth(1280);
    await fill("[data-test=return-receipt-discrepancy]", "One copy missing from the parcel");
    await click("[data-test=return-receipt-submit]");
    await waitFor(`${q(row(requested))}?.dataset.status === "completed"`, "received");
    assert.match(await text(row(requested)), /Received.*1 sellable, 0 damaged.*One copy missing from the parcel/);
    assert.equal(await count("[data-test=return-receipt]"), 0);
    assert.equal(await text("[data-test=order-status]"), "Shipped");
    await screenshot("return-received");
  });

  await check("inventory lists the return movement; the open-returns filter is empty again", async () => {
    await navigate("/inventory?q=LOV-SR-STD");
    await waitFor(`!!${q('[data-test=inventory-row][data-sku="LOV-SR-STD"]')}`, "inventory row");
    await click('[data-test=inventory-row][data-sku="LOV-SR-STD"] [data-test=inventory-detail-link]');
    await waitFor(`!!${q("[data-test=movement-row]")}`, "movements");
    const latest = await text("[data-test=movement-row]");
    assert.ok(/Return/.test(latest) && latest.includes(requested), latest);
    await navigate("/orders?returns=open");
    await waitFor(`${q("[data-test=orders-total]")}?.textContent === "0 orders"`, "no open returns");
    assert.match(await text("h2"), /No orders match these filters/);
    await logout();
  });

  await check("the retailer sees the completed return read-only; the unit that never arrived can be requested again; no page errors", async () => {
    await login("retailer@tabletop-lantern.test");
    await openOrder("PO-000006", "status=shipped");
    await waitFor(`${q(row(requested))}?.dataset.status === "completed"`, "completed return listed");
    assert.equal(await count("[data-test=return-receipt]"), 0);
    await click("[data-test=return-request]");
    await waitFor(`!!${q("[data-test=return-request-panel]")}`, "request form");
    assert.match(await text("[data-test=return-request-line]"), /\(2 shipped, 1 returnable\)/);
    await logout();
    assert.deepEqual(pageErrors, []);
  });

  console.log(`\n${runner.passed} return browser check groups passed. Screenshots: ${EVIDENCE}`);
} finally {
  page.close();
}
