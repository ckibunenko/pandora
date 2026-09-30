// Browser checks for inventory, driven through the Chrome DevTools protocol (no extra dependencies).
// Requires a freshly seeded QA API and web server; see context/features/inventory-verification.md.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunner, startBrowser } from "./cdp.mjs";

const BASE = process.env.INVENTORY_BROWSER_URL ?? "http://localhost:5175";
const EVIDENCE = process.env.INVENTORY_CHECK_EVIDENCE ?? join(tmpdir(), "pandora-inventory-evidence");
const PASSWORD = process.env.SEED_USER_PASSWORD;
assert.ok(PASSWORD, "SEED_USER_PASSWORD must be set (run with --env-file=.env).");

const page = await startBrowser({ base: BASE, evidence: EVIDENCE, port: Number(process.env.INVENTORY_CDP_PORT ?? 9334) });
const { send, evaluate, q, waitFor, text, count, fill, click, navigate, screenshot, setWidth, noHorizontalOverflow, logout, pageErrors, pausedHandlers } = page;
const login = (email) => page.login(email, PASSWORD);
const runner = checkRunner();
const check = runner.check;

try {
  await setWidth(1280);

  await check("operator reaches inventory from navigation; list shows seeded stock", async () => {
    await login("operator@pandora.test");
    await waitFor(`!!${q("[data-test=inventory-nav]")}`, "inventory nav");
    await click("[data-test=inventory-nav]");
    await waitFor(`location.pathname === "/inventory" && document.querySelectorAll("[data-test=inventory-row]").length === 11`, "11 rows");
    assert.equal(await text("[data-test=inventory-total]"), "11 items");
    const cells = (sku) => evaluate(`[...${q(`[data-test=inventory-row][data-sku="${sku}"]`)}.querySelectorAll("td")].map((td) => td.textContent)`);
    const zero = await cells("CWO-EN-DLX");
    assert.equal(zero[6], "0", "available column");
    const swaGi = await cells("SWA-GI-EN");
    assert.deepEqual(swaGi.slice(3, 7), ["1", "0", "0", "1"], "SWA-GI-EN seed stock");
    await screenshot("inventory-list");
  });

  await check("search and stock filter narrow the list and reset paging", async () => {
    await fill("[data-test=inventory-search]", "saltwind");
    await click("[data-test=inventory-search-submit]");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 2`, "2 Saltwind rows");
    await fill("[data-test=inventory-search]", "");
    await click("[data-test=inventory-search-submit]");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 11`, "search cleared");
    await fill("[data-test=inventory-stock-filter]", "unavailable");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 1 && !!${q('[data-test=inventory-row][data-sku="CWO-EN-DLX"]')}`, "unavailable filter");
    assert.match(await evaluate("location.search"), /stock=unavailable/);
    await fill("[data-test=inventory-stock-filter]", "all");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 11`, "all rows again");
  });

  await check("receipt: client validation, then success updates stock and history", async () => {
    await click('[data-test=inventory-row][data-sku="SWA-GI-EN"] [data-test=inventory-detail-link]');
    await waitFor(`${q("[data-test=inventory-sku]")}?.textContent === "SWA-GI-EN" && !!${q("[data-test=movement-row]")}`, "detail page");
    assert.equal(await text("[data-test=stock-sellable]"), "1");
    const historyBefore = await count("[data-test=movement-row]");
    await fill("[data-test=field-quantity]", "abc");
    await click("[data-test=receipt-submit]");
    await waitFor(`${q("[data-test=field-quantity]")}.getAttribute("aria-invalid") === "true"`, "quantity marked invalid");
    await fill("[data-test=field-quantity]", "4");
    await fill("[data-test=field-reference]", "DN-QA-1");
    await click("[data-test=receipt-submit]");
    await waitFor(`!!${q("[data-test=receipt-success]")}`, "receipt success");
    await waitFor(`${q("[data-test=stock-sellable]")}.textContent === "5"`, "sellable 5");
    await waitFor(`document.querySelectorAll("[data-test=movement-row]").length === ${historyBefore + 1}`, "history row added");
    assert.equal(await evaluate(`${q("[data-test=field-quantity]")}.value`), "", "form cleared after success");
  });

  await check("adjustment: server rejection keeps input and links the error to the field", async () => {
    await fill("[data-test=field-delta]", "-10");
    await fill("[data-test=field-reason]", "Shelf recount");
    await click("[data-test=adjustment-submit]");
    await waitFor(`!!${q("[data-test=adjustment-error]")}`, "adjustment error");
    assert.match(await text("[data-test=adjustment-error]"), /Not enough stock/);
    assert.equal(await evaluate(`${q("[data-test=field-delta]")}.getAttribute("aria-invalid")`), "true");
    assert.equal(await evaluate(`${q("[data-test=field-delta]")}.value`), "-10", "input preserved");
    assert.equal(await evaluate(`${q("[data-test=field-reason]")}.value`), "Shelf recount", "input preserved");
    await fill("[data-test=field-delta]", "-1");
    await click("[data-test=adjustment-submit]");
    await waitFor(`!!${q("[data-test=adjustment-success]")}`, "adjustment success");
    await waitFor(`${q("[data-test=stock-sellable]")}.textContent === "4"`, "sellable 4");
    await screenshot("inventory-detail");
  });

  await check("a lost response is retried with the same key and applied only once", async () => {
    const historyBefore = await count("[data-test=movement-row]");
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/inventory/*/receipts", requestStage: "Response" }] });
    let dropped = false;
    pausedHandlers.push((params) => {
      // The server has already committed this receipt; the browser only loses the response.
      if (!dropped) {
        dropped = true;
        void send("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionReset" });
      } else {
        void send("Fetch.continueRequest", { requestId: params.requestId });
      }
    });
    await fill("[data-test=field-quantity]", "3");
    await click("[data-test=receipt-submit]");
    await waitFor(`!!${q("[data-test=receipt-error]")}`, "lost-response error");
    assert.match(await text("[data-test=receipt-error]"), /retry safely/);
    assert.equal(await evaluate(`${q("[data-test=field-quantity]")}.value`), "3", "input preserved for retry");
    await click("[data-test=receipt-submit]");
    await waitFor(`!!${q("[data-test=receipt-success]")}`, "retry success");
    await send("Fetch.disable");
    pausedHandlers.length = 0;
    await waitFor(`${q("[data-test=stock-sellable]")}.textContent === "7"`, "sellable 4 + 3, applied once");
    await waitFor(`document.querySelectorAll("[data-test=movement-row]").length === ${historyBefore + 1}`, "exactly one new movement");
  });

  await check("keyboard: stock forms are reachable with Tab and show visible focus", async () => {
    await evaluate(`${q("[data-test=field-quantity]")}.focus()`);
    const order = [];
    for (let step = 0; step < 3; step += 1) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      order.push(await evaluate("document.activeElement?.dataset.test ?? document.activeElement?.tagName"));
    }
    assert.deepEqual(order, ["field-reference", "field-note", "receipt-submit"]);
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none");
  });

  await check("narrow layout: list and detail have no horizontal page overflow", async () => {
    await setWidth(390);
    await waitFor(`!!${q("[data-test=stock-available]")}`, "detail at 390px");
    assert.ok(await noHorizontalOverflow(), "detail overflows at 390px");
    await screenshot("inventory-detail-narrow");
    await navigate("/inventory");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 11`, "list at 390px");
    assert.ok(await noHorizontalOverflow(), "list overflows at 390px");
    await setWidth(1280);
    await logout();
  });

  await check("retailer: no inventory access, catalog shows available quantity with the note", async () => {
    await login("retailer@tabletop-lantern.test");
    assert.equal(await count("[data-test=inventory-nav]"), 0);
    await navigate("/inventory");
    await waitFor(`document.body.textContent.includes("Access restricted")`, "restricted message");
    assert.equal(await count("[data-test=inventory-row]"), 0);
    await navigate("/catalog?q=SWA-GI-EN");
    await waitFor(`!!${q("[data-test=product-detail-link]")}`, "catalog result");
    await click("[data-test=product-detail-link]");
    await waitFor(`!!${q("[data-test=variant-select]")}`, "product detail");
    const variantId = await evaluate(`[...${q("[data-test=variant-select]")}.options].find((o) => o.textContent.includes("SWA-GI-EN")).value`);
    await fill("[data-test=variant-select]", variantId);
    await waitFor(`${q("[data-test=variant-available]")}?.textContent === "7"`, "availability 7");
    assert.match(await text("[data-test=availability-note]"), /not reserved until your order is confirmed/);
    await screenshot("catalog-availability");
    await logout();
  });

  await check("administrator also manages inventory; no page errors were thrown", async () => {
    await login("admin@pandora.test");
    await click("[data-test=inventory-nav]");
    await waitFor(`document.querySelectorAll("[data-test=inventory-row]").length === 11`, "admin list");
    await logout();
    assert.deepEqual(pageErrors, []);
  });

  console.log(`\n${runner.passed} inventory browser check groups passed. Screenshots: ${EVIDENCE}`);
} finally {
  page.close();
}
