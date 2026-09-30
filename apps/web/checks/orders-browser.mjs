// Browser checks for order drafts and submission (Chrome DevTools protocol, no extra dependencies).
// Requires a freshly seeded QA API and web server; see context/features/order-drafts-verification.md.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunner, startBrowser } from "./cdp.mjs";

const BASE = process.env.ORDERS_BROWSER_URL ?? "http://localhost:5175";
const EVIDENCE = process.env.ORDERS_CHECK_EVIDENCE ?? join(tmpdir(), "pandora-orders-evidence");
const PASSWORD = process.env.SEED_USER_PASSWORD;
assert.ok(PASSWORD, "SEED_USER_PASSWORD must be set (run with --env-file=.env).");

// A second session acting through the API, to create conflicts and catalog changes the browser must handle.
async function apiSession(email) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await response.json();
  return async (path, { method = "GET", body } = {}) => {
    const result = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(result.ok, `${method} ${path} → ${result.status}`);
    return result.json();
  };
}

const page = await startBrowser({ base: BASE, evidence: EVIDENCE, port: Number(process.env.ORDERS_CDP_PORT ?? 9335) });
const { q, evaluate, waitFor, text, count, fill, click, navigate, screenshot, setWidth, noHorizontalOverflow, logout, pageErrors } = page;
const login = (email) => page.login(email, PASSWORD);
const runner = checkRunner();
const check = runner.check;
const lineQuantity = (sku) => evaluate(`${q(`[data-test=order-line][data-sku="${sku}"] [data-test=order-line-quantity]`)}?.value ?? null`);
const rowSelector = (number) => `[data-test=order-row][data-order-number="${number}"]`;

async function openProduct(sku) {
  await navigate(`/catalog?q=${sku}`);
  await waitFor(`!!${q("[data-test=product-detail-link]")}`, `catalog result for ${sku}`);
  await click("[data-test=product-detail-link]");
  await waitFor(`!!${q("[data-test=variant-select]")}`, "product detail");
  const variantId = await evaluate(`[...${q("[data-test=variant-select]")}.options].find((o) => o.textContent.includes(${JSON.stringify(sku)})).value`);
  await fill("[data-test=variant-select]", variantId);
  // The draft list loads after the panel appears; the controls stay disabled until then.
  await waitFor(`${q("[data-test=add-draft-select]")}?.disabled === false`, "drafts loaded");
}

try {
  await setWidth(1280);
  const lanternApi = await apiSession("retailer@tabletop-lantern.test");
  const seedOrders = (await lanternApi("/orders")).items;
  const po1 = seedOrders.find((o) => o.number === "PO-000001");
  assert.ok(po1, "fresh seed expected (PO-000001 draft)");
  assert.equal(po1.status, "draft", "fresh seed expected (PO-000001 draft)");

  await check("retailer sees the organization's orders with statuses and estimated draft totals", async () => {
    await login("retailer@tabletop-lantern.test");
    await click("[data-test=orders-nav]");
    await waitFor(`location.pathname === "/orders" && document.querySelectorAll("[data-test=order-row]").length === 3`, "3 orders");
    assert.equal(await text(`${rowSelector("PO-000001")} [data-test=order-status]`), "Draft");
    assert.match(await text(rowSelector("PO-000001")), /est\./);
    assert.equal(await text(`${rowSelector("PO-000002")} [data-test=order-status]`), "Submitted");
    await screenshot("orders-list");
  });

  await check("catalog: add a selected variant to an existing draft, merging quantities", async () => {
    await openProduct("LOV-EN-STD");
    await fill("[data-test=add-quantity]", "2");
    assert.match(await evaluate(`${q("[data-test=add-draft-select]")}.selectedOptions[0].textContent`), /PO-000001/);
    await click("[data-test=add-to-draft]");
    await waitFor(`!!${q("[data-test=add-to-draft-success]")}`, "added");
    assert.match(await text("[data-test=add-to-draft-success]"), /Added 2 × LOV-EN-STD to PO-000001.*does not reserve stock/);
    await click("[data-test=add-to-draft-link]");
    await waitFor(`${q("[data-test=order-number]")}?.textContent === "PO-000001"`, "draft page");
    assert.equal(await lineQuantity("LOV-EN-STD"), "6");
  });

  await check("draft editor: invalid quantity is flagged; saving updates the version and total", async () => {
    const before = await text("[data-test=order-total]");
    await fill('[data-test=order-line][data-sku="SWA-GI-EN"] [data-test=order-line-quantity]', "abc");
    await click("[data-test=order-save]");
    await waitFor(`${q('[data-test=order-line][data-sku="SWA-GI-EN"] [data-test=order-line-quantity]')}.getAttribute("aria-invalid") === "true"`, "invalid quantity flagged");
    assert.equal(await evaluate(`${q("[data-test=order-submit]")}.disabled`), true, "cannot submit unsaved changes");
    await fill('[data-test=order-line][data-sku="SWA-GI-EN"] [data-test=order-line-quantity]', "3");
    await click("[data-test=order-save]");
    await waitFor(`!!${q("[data-test=order-save-success]")}`, "saved");
    assert.notEqual(await text("[data-test=order-total]"), before);
    await screenshot("order-draft");
  });

  await check("version conflict: local edits are kept, then Reload shows the other session's changes", async () => {
    const latest = await lanternApi(`/orders/${po1.id}`);
    await lanternApi(`/orders/${po1.id}/lines`, {
      method: "PUT",
      body: { version: latest.version, lines: latest.lines.map((l) => ({ variantId: l.variantId, quantity: l.sku === "LOV-EN-STD" ? 7 : l.quantity })) },
    });
    await fill('[data-test=order-line][data-sku="SWA-GI-EN"] [data-test=order-line-quantity]', "4");
    await click("[data-test=order-save]");
    await waitFor(`!!${q("[data-test=order-conflict]")}`, "conflict shown");
    assert.equal(await lineQuantity("SWA-GI-EN"), "4", "local edit preserved");
    await click("[data-test=order-reload]");
    await waitFor(`${q('[data-test=order-line][data-sku="LOV-EN-STD"] [data-test=order-line-quantity]')}?.value === "7"`, "reloaded");
    assert.equal(await lineQuantity("SWA-GI-EN"), "3");
    assert.equal(await count("[data-test=order-conflict]"), 0);
  });

  await check("submission: price change is reported and refreshed; confirmation explains no reservation; order freezes", async () => {
    const adminApi = await apiSession("admin@pandora.test");
    const product = (await adminApi("/admin/catalog/products?q=LOV-EN-STD")).items[0];
    const variant = product.variants.find((v) => v.sku === "LOV-EN-STD");
    await adminApi(`/admin/catalog/products/${product.id}/variants/${variant.id}`, { method: "PATCH", body: { unitPriceMinor: variant.unitPriceMinor + 100 } });

    await click("[data-test=order-submit]");
    await waitFor(`!!${q("[data-test=order-submit-panel]")}`, "confirmation");
    assert.match(await text("[data-test=order-submit-no-reservation]"), /does not reserve stock/);
    await click("[data-test=order-submit-confirm]");
    await waitFor(`!!${q("[data-test=order-submit-error]")}`, "price change reported");
    assert.match(await text("[data-test=order-submit-error]"), /Prices changed for LOV-EN-STD/);
    const newPrice = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format((variant.unitPriceMinor + 100) / 100);
    await waitFor(`${q('[data-test=order-line][data-sku="LOV-EN-STD"]')}.textContent.includes(${JSON.stringify(newPrice)})`, "new price displayed");

    await click("[data-test=order-submit]");
    await waitFor(`!!${q("[data-test=order-submit-confirm]")}`, "confirmation again");
    await click("[data-test=order-submit-confirm]");
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Submitted"`, "submitted");
    assert.equal(await count("input[data-test=order-line-quantity]"), 0, "frozen lines are read-only");
    assert.match(await text("[data-test=order-history]"), /Submitted by Tara Lantern/);
    await screenshot("order-submitted");
  });

  await check("catalog: add to a new draft, then cancel that draft with a reason", async () => {
    await openProduct("SWA-GI-EN");
    await fill("[data-test=add-draft-select]", "new");
    await click("[data-test=add-to-draft]");
    await waitFor(`!!${q("[data-test=add-to-draft-link]")}`, "new draft created");
    assert.equal(await text("[data-test=add-to-draft-link]"), "PO-001001");
    await click("[data-test=add-to-draft-link]");
    await waitFor(`${q("[data-test=order-number]")}?.textContent === "PO-001001"`, "new draft page");
    await click("[data-test=order-cancel]");
    await fill("[data-test=order-cancel-reason]", "Wrong store");
    await click("[data-test=order-cancel-confirm]");
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Cancelled"`, "cancelled");
    assert.match(await text("[data-test=order-history]"), /Cancelled: Wrong store by Tara Lantern/);
  });

  await check("a submitted order can be cancelled from its page", async () => {
    await navigate("/orders");
    await waitFor(`!!${q(rowSelector("PO-000002"))}`, "orders list");
    await click(`${rowSelector("PO-000002")} [data-test=order-link]`);
    await waitFor(`${q("[data-test=order-number]")}?.textContent === "PO-000002"`, "PO-000002");
    await click("[data-test=order-cancel]");
    await click("[data-test=order-cancel-confirm]");
    await waitFor(`${q("[data-test=order-status]")}?.textContent === "Cancelled"`, "cancelled");
    assert.match(await text("[data-test=order-total]"), /105\.00/, "frozen total kept");
  });

  await check("keyboard: the add-to-draft controls are reachable with Tab and show focus", async () => {
    await openProduct("CWO-EN-STD");
    await evaluate(`${q("[data-test=add-quantity]")}.focus()`);
    const order = [];
    for (let step = 0; step < 2; step += 1) {
      await page.pressTab();
      order.push(await evaluate("document.activeElement?.dataset.test"));
    }
    assert.deepEqual(order, ["add-draft-select", "add-to-draft"]);
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none");
  });

  await check("narrow layout: orders list and order page have no horizontal overflow", async () => {
    await setWidth(390);
    await navigate("/orders");
    await waitFor(`document.querySelectorAll("[data-test=order-row]").length >= 3`, "list at 390px");
    assert.ok(await noHorizontalOverflow(), "orders list overflows");
    await navigate(`/orders/${po1.id}`);
    await waitFor(`!!${q("[data-test=order-line]")}`, "order at 390px");
    assert.ok(await noHorizontalOverflow(), "order page overflows");
    await screenshot("order-narrow");
    await setWidth(1280);
    await logout();
  });

  await check("isolation: another retailer sees only its own orders and cannot open others", async () => {
    await login("retailer@cardboard-keep.test");
    await navigate("/orders");
    await waitFor(`document.querySelectorAll("[data-test=order-row]").length === 1 && !!${q(rowSelector("PO-000004"))}`, "own order only");
    await navigate(`/orders/${po1.id}`);
    await waitFor(`document.body.textContent.includes("This order does not exist.")`, "not found message");
    await logout();
  });

  await check("staff: operator reads all orders without any editing controls", async () => {
    await login("operator@pandora.test");
    await navigate("/orders");
    await waitFor(`document.querySelectorAll("[data-test=order-row]").length >= 5`, "all orders");
    assert.equal(await count("[data-test=order-create]"), 0);
    assert.match(await text("thead"), /Retailer/);
    await navigate(`/orders/${seedOrders.find((o) => o.number === "PO-000003").id}`);
    await waitFor(`!!${q("[data-test=order-line]")}`, "order detail");
    assert.equal(await count("input[data-test=order-line-quantity]"), 0);
    assert.equal(await count("[data-test=order-cancel]"), 0);
    await logout();
    assert.deepEqual(pageErrors, []);
  });

  console.log(`\n${runner.passed} order browser check groups passed. Screenshots: ${EVIDENCE}`);
} finally {
  page.close();
}
