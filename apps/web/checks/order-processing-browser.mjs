// Browser checks for staff order processing (confirm with reservation, reject), using the shared CDP driver.
// Requires a freshly seeded QA API and web server; see context/features/order-processing-verification.md.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunner, startBrowser } from "./cdp.mjs";

const BASE = process.env.PROCESSING_BROWSER_URL ?? "http://localhost:5175";
const EVIDENCE = process.env.PROCESSING_CHECK_EVIDENCE ?? join(tmpdir(), "pandora-processing-evidence");
const PASSWORD = process.env.SEED_USER_PASSWORD;
assert.ok(PASSWORD, "SEED_USER_PASSWORD must be set (run with --env-file=.env).");

const page = await startBrowser({ base: BASE, evidence: EVIDENCE, port: Number(process.env.PROCESSING_CDP_PORT ?? 9336) });
const { q, evaluate, waitFor, text, count, fill, click, navigate, screenshot, setWidth, noHorizontalOverflow, logout, pageErrors } = page;
const login = (email) => page.login(email, PASSWORD);
const runner = checkRunner();
const check = runner.check;
const rowSelector = (number) => `[data-test=order-row][data-order-number="${number}"]`;
const lineSelector = (sku) => `[data-test=order-line][data-sku="${sku}"]`;

async function openFromList(number) {
  await waitFor(`!!${q(rowSelector(number))}`, `${number} in list`);
  await click(`${rowSelector(number)} [data-test=order-link]`);
  await waitFor(`${q("[data-test=order-number]")}?.textContent === "${number}"`, `${number} page`);
}

try {
  await setWidth(1280);

  await check("operator lands on the processing queue, oldest submission first", async () => {
    await login("operator@pandora.test");
    await waitFor(`location.pathname === "/orders" && location.search.includes("status=submitted")`, "queue URL");
    await waitFor(`document.querySelectorAll("[data-test=order-row]").length === 2`, "two submitted orders");
    assert.equal(await text("h1"), "Orders awaiting processing");
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll("[data-test=order-row]")].map((row) => row.dataset.orderNumber)`),
      ["PO-000002", "PO-000005"],
    );
    await screenshot("queue");
  });

  await check("a short order shows per-line shortages; confirming fails with nothing reserved", async () => {
    await openFromList("PO-000005");
    await waitFor(`!!${q(`${lineSelector("CWO-EN-DLX")} [data-test=order-line-shortage]`)}`, "shortage flag");
    assert.equal(await text(`${lineSelector("CWO-EN-DLX")} [data-test=order-line-shortage]`), "Short by 2");
    assert.equal(await count(`${lineSelector("LOV-SR-STD")} [data-test=order-line-covered]`), 1);
    assert.equal(await count("[data-test=order-shortage-summary]"), 1);
    await setWidth(390);
    assert.ok(await noHorizontalOverflow(), "staff review overflows at 390px");
    await screenshot("review-narrow");
    await setWidth(1280);
    await click("[data-test=order-confirm]");
    await waitFor(`!!${q("[data-test=order-confirm-panel]")}`, "confirm panel");
    await click("[data-test=order-confirm-submit]");
    await waitFor(`!!${q("[data-test=order-confirm-error]")}`, "insufficient stock error");
    assert.match(await text("[data-test=order-confirm-error]"), /Not enough stock to confirm: CWO-EN-DLX.*Nothing was reserved/);
    assert.equal(await text("[data-test=order-status]"), "Submitted");
    await screenshot("review-shortage");
  });

  await check("reject requires a reason and keyboard users can reach it; the rejection is recorded", async () => {
    await click("[data-test=order-reject]");
    await waitFor(`!!${q("[data-test=order-reject-panel]")}`, "reject panel");
    await click("[data-test=order-reject-submit]");
    await waitFor(`${q("[data-test=order-reject-reason]")}.getAttribute("aria-invalid") === "true"`, "reason required");
    await fill("[data-test=order-reject-reason]", "Deluxe edition is out of stock");
    await evaluate(`${q("[data-test=order-reject-reason]")}.focus()`);
    await page.pressTab();
    assert.equal(await evaluate("document.activeElement?.dataset.test"), "order-reject-submit");
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none");
    await click("[data-test=order-reject-submit]");
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Rejected"`, "rejected");
    assert.match(await text("[data-test=order-history]"), /Rejected: Deluxe edition is out of stock by Oskar Operator/);
  });

  await check("confirming a covered order reserves stock and shows reserved quantities", async () => {
    await click("[data-test=orders-nav]");
    await openFromList("PO-000002");
    assert.equal(await count("[data-test=order-line-shortage]"), 0);
    await click("[data-test=order-confirm]");
    await waitFor(`!!${q("[data-test=order-confirm-panel]")}`, "confirm panel");
    assert.match(await text("[data-test=order-confirm-panel]"), /reserves 13 units across 2 lines/);
    await click("[data-test=order-confirm-submit]");
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Confirmed"`, "confirmed");
    assert.equal(await text(`${lineSelector("CWO-EN-STD")} [data-test=order-line-reserved]`), "3");
    assert.equal(await text(`${lineSelector("TKC-EN-STD")} [data-test=order-line-reserved]`), "10");
    assert.match(await text("[data-test=order-history]"), /Confirmed and stock reserved by Oskar Operator/);
    await screenshot("confirmed");
  });

  await check("inventory shows the reservation; the queue is now empty", async () => {
    await navigate("/inventory?q=CWO-EN-STD");
    await waitFor(`!!${q('[data-test=inventory-row][data-sku="CWO-EN-STD"]')}`, "inventory row");
    const cells = await evaluate(`[...${q('[data-test=inventory-row][data-sku="CWO-EN-STD"]')}.querySelectorAll("td")].map((td) => td.textContent)`);
    assert.deepEqual(cells.slice(3, 7), ["25", "3", "0", "22"]);
    await click('[data-test=inventory-row][data-sku="CWO-EN-STD"] [data-test=inventory-detail-link]');
    await waitFor(`!!${q("[data-test=movement-row]")}`, "movement history");
    assert.match(await text("[data-test=movement-row]"), /Reservation.*\+3 reserved.*PO-000002/);
    await click("[data-test=orders-nav]");
    await waitFor(`document.body.textContent.includes("Nothing is waiting for a decision.")`, "empty queue");
    await logout();
  });

  await check("retailers see the decisions: confirmed with reserved quantities, rejected with the reason, lower availability", async () => {
    await login("retailer@tabletop-lantern.test");
    await navigate("/orders");
    await openFromList("PO-000002");
    assert.equal(await text("[data-test=order-status]"), "Confirmed");
    assert.equal(await count("[data-test=order-confirm]"), 0);
    assert.equal(await count("[data-test=order-cancel]"), 0, "confirmed orders cannot be cancelled here yet");
    assert.equal(await text(`${lineSelector("CWO-EN-STD")} [data-test=order-line-reserved]`), "3");
    await navigate("/catalog?q=CWO-EN-STD");
    await waitFor(`!!${q("[data-test=product-detail-link]")}`, "catalog result");
    await click("[data-test=product-detail-link]");
    await waitFor(`!!${q("[data-test=variant-select]")}`, "product detail");
    const variantId = await evaluate(`[...${q("[data-test=variant-select]")}.options].find((o) => o.textContent.includes("CWO-EN-STD")).value`);
    await fill("[data-test=variant-select]", variantId);
    await waitFor(`${q("[data-test=variant-available]")}?.textContent === "22"`, "availability 25 - 3");
    await logout();

    await login("retailer@cardboard-keep.test");
    await navigate("/orders");
    await openFromList("PO-000005");
    assert.equal(await text("[data-test=order-status]"), "Rejected");
    assert.match(await text("[data-test=order-history]"), /Rejected: Deluxe edition is out of stock/);
    await logout();
  });

  await check("administrators reach the queue from navigation; no page errors", async () => {
    await login("admin@pandora.test");
    assert.equal(await evaluate("location.pathname"), "/admin/catalog");
    await click("[data-test=orders-nav]");
    await waitFor(`location.search.includes("status=submitted")`, "queue");
    await logout();
    assert.deepEqual(pageErrors, []);
  });

  console.log(`\n${runner.passed} order processing browser check groups passed. Screenshots: ${EVIDENCE}`);
} finally {
  page.close();
}
