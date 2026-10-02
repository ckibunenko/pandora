// Audit and operational pagination through Chrome, using a fresh seeded QA stack.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunner, startBrowser } from "./cdp.mjs";

const BASE = process.env.OPERATIONS_BROWSER_URL ?? "http://localhost:5175";
const EVIDENCE = process.env.OPERATIONS_CHECK_EVIDENCE ?? join(tmpdir(), "pandora-operations-evidence");
const PASSWORD = process.env.SEED_USER_PASSWORD;
assert.ok(PASSWORD);
const page = await startBrowser({ base: BASE, evidence: EVIDENCE, port: Number(process.env.OPERATIONS_CDP_PORT ?? 9340) });
const { q, evaluate, waitFor, text, count, fill, click, navigate, screenshot, setWidth, noHorizontalOverflow, logout, pageErrors, send, pausedHandlers } = page;
const runner = checkRunner();
const check = runner.check;
const login = (email) => page.login(email, PASSWORD);

async function apiLogin(email) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await response.json();
  return async (path, method = "GET", body, status = method === "POST" ? 201 : 200) => {
    const result = await fetch(`${BASE}/api${path}`, {
      method, headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await result.json();
    assert.equal(result.status, status, JSON.stringify(json));
    return json;
  };
}
const rowIds = (selector, attribute) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((row) => row.getAttribute(${JSON.stringify(attribute)}))`);

try {
  const admin = await apiLogin("admin@pandora.test");
  const retailer = await apiLogin("retailer@tabletop-lantern.test");
  const products = await admin("/admin/catalog/products");
  const product = products.items.find((item) => item.variants.some((variant) => variant.sku === "TKC-EN-STD"));
  const variant = product.variants.find((item) => item.sku === "TKC-EN-STD");
  for (let i = 0; i < 41; i++) await retailer("/orders", "POST", { lines: [] });
  for (let i = 0; i < 21; i++) {
    await admin(`/admin/catalog/products/${product.id}/variants`, "POST", { sku: `OPS-${String(i).padStart(3, "0")}`, language: "en", edition: `Operations ${i}`, unitPriceMinor: 100 });
    await admin(`/inventory/${variant.id}/receipts`, "POST", { quantity: 1, reference: `OPS-${i}` });
    const organization = await admin("/admin/organizations", "POST", { name: `Operations Store ${String(i).padStart(2, "0")}` });
    await admin("/admin/users", "POST", { organizationId: organization.id, role: "retailer", email: `operations-${String(i).padStart(2, "0")}@example.test`, displayName: `Operations ${i}`, password: "Operations-fixture-password-2026" });
  }
  const expectedPage1 = await admin("/audit-events");
  const expectedPage2 = await admin("/audit-events?page=2");
  const restricted = (await admin("/audit-events?entityType=user")).items[0];

  await setWidth(1280);
  await check("audit pages: staff navigation, exact page boundaries and page-size reset in URL", async () => {
    await login("admin@pandora.test");
    await click("[data-test=audit-nav]");
    await waitFor(`!!${q("[data-test=audit-row]")}`, "audit list");
    assert.equal(await evaluate(`getComputedStyle(${q("[data-test=audit-filters]")}).display`), "grid");
    assert.equal(await text("[data-test=audit-total]"), `${expectedPage1.total} events`);
    assert.deepEqual(await rowIds("[data-test=audit-row]", "data-event-id"), expectedPage1.items.map((event) => event.id));
    assert.equal(await evaluate(`${q("[data-test=audit-previous]")}.disabled`), true);
    await click("[data-test=audit-next]");
    await waitFor(`${q("[data-test=audit-page]")}?.textContent.includes("Page 2")`, "second audit page");
    assert.deepEqual(await rowIds("[data-test=audit-row]", "data-event-id"), expectedPage2.items.map((event) => event.id));
    assert.match(await evaluate("location.search"), /page=2/);
    await fill("[data-test=audit-page-size]", "50");
    await waitFor(`${q("[data-test=audit-page-size]")}?.value === "50" && ${q("[data-test=audit-page]")}?.textContent.includes("Page 1")`, "50 per page resets page");
    assert.equal(await count("[data-test=audit-row]"), 50);
    assert.ok(!(await evaluate("location.search")).includes("page="));
    await screenshot("audit-list");
  });

  await check("audit search: intersect filters, validate dates/UUIDs, inspect snapshots and return with filters", async () => {
    await fill("[data-test=audit-entity-type]", "inventory_item");
    await fill("[data-test=audit-entityId]", "bad");
    await click("[data-test=audit-search]");
    await waitFor(`${q("[data-test=audit-entityId]")}?.getAttribute("aria-invalid") === "true"`, "bad UUID flagged");
    await fill("[data-test=audit-entityId]", variant.id);
    await fill("[data-test=audit-action]", "received");
    await fill("[data-test=audit-from]", "2026-10-02T00:00:00Z");
    await fill("[data-test=audit-to]", "2026-10-01T00:00:00Z");
    await click("[data-test=audit-search]");
    await waitFor(`${q("[data-test=audit-to]")}?.getAttribute("aria-invalid") === "true"`, "reverse date range flagged");
    await fill("[data-test=audit-from]", "");
    await fill("[data-test=audit-to]", "");
    await click("[data-test=audit-search]");
    await waitFor(`${q("[data-test=audit-total]")}?.textContent === "21 events"`, "filtered receipts");
    const search = await evaluate("location.search");
    assert.match(search, /entityType=inventory_item/);
    assert.equal(await count("[data-test=audit-row]"), 21);
    await click("[data-test=audit-link]");
    await waitFor(`!!${q("[data-test=audit-after]")}`, "audit detail");
    const before = JSON.parse(await text("[data-test=audit-before]"));
    const after = JSON.parse(await text("[data-test=audit-after]"));
    assert.equal(after.sellable - before.sellable, 1);
    assert.ok(await text("[data-test=audit-correlation-id]"));
    await screenshot("audit-detail");
    await click("[data-test=audit-back]");
    await waitFor(`${q("[data-test=audit-total]")}?.textContent === "21 events"`, "return to filtered list");
    assert.equal(await evaluate("location.search"), search);
    assert.equal(await evaluate(`${q("[data-test=audit-entityId]")}.value`), variant.id);
  });

  await check("audit empty and error states: clear filters and retry a failed read", async () => {
    await fill("[data-test=audit-correlationId]", "no-such-event");
    await click("[data-test=audit-search]");
    await waitFor(`!!${q("[data-test=audit-empty]")}`, "empty state");
    assert.equal(await text("[data-test=audit-total]"), "0 events");
    assert.equal(await evaluate(`${q("[data-test=audit-next]")}.disabled`), true);
    await click("[data-test=audit-clear-filters]");
    await waitFor(`document.querySelectorAll("[data-test=audit-row]").length === 20`, "cleared filters");
    await navigate("/audit?page=999");
    await waitFor(`!!${q("[data-test=audit-empty]")}`, "beyond-end page");
    assert.equal(await text("[data-test=audit-total]"), `${expectedPage1.total} events`);
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/audit-events*", requestStage: "Request" }] });
    let dropped = false;
    pausedHandlers.push((request) => {
      if (!dropped) {
        dropped = true;
        void send("Fetch.failRequest", { requestId: request.requestId, errorReason: "ConnectionReset" });
      } else void send("Fetch.continueRequest", { requestId: request.requestId });
    });
    await navigate("/audit");
    await waitFor(`!!${q("[data-test=audit-error]")}`, "failed read");
    await click("[data-test=audit-retry]");
    await waitFor(`!!${q("[data-test=audit-row]")}`, "successful retry");
    await send("Fetch.disable");
    pausedHandlers.length = 0;
  });

  await check("operational lists: next pages preserve boundaries and filters; 50 rows resets to first page", async () => {
    const tests = [
      { path: "/orders?status=draft", prefix: "orders", row: "order-row", attribute: "data-order-number", api: "/orders?status=draft", getId: (item) => item.number },
      { path: "/inventory?q=OPS-", prefix: "inventory", row: "inventory-row", attribute: "data-sku", api: "/inventory?q=OPS-", getId: (item) => item.sku },
      { path: `/inventory/${variant.id}`, prefix: "movement", row: "movement-row", attribute: "data-movement-id", api: `/inventory/${variant.id}/movements?`, getId: (item) => item.id },
      { path: "/admin/organizations?q=Operations", prefix: "organization", row: "organization-row", attribute: "data-organization-name", api: "/admin/organizations?q=Operations", getId: (item) => item.name },
      { path: "/admin/users?q=operations-", prefix: "user", row: "user-row", attribute: "data-email", api: "/admin/users?q=operations-", getId: (item) => item.email },
    ];
    for (const test of tests) {
      await navigate(test.path);
      await waitFor(`!!${q(`[data-test=${test.row}]`)}`, `${test.prefix} list`);
      const first = await admin(test.api);
      assert.deepEqual(await rowIds(`[data-test=${test.row}]`, test.attribute), first.items.map(test.getId));
      await click(`[data-test=${test.prefix}-next]`);
      await waitFor(`${q(`[data-test=${test.prefix}-page]`)}?.textContent.includes("Page 2")`, `${test.prefix} second page`);
      const second = await admin(`${test.api}&page=2`);
      assert.deepEqual(await rowIds(`[data-test=${test.row}]`, test.attribute), second.items.map(test.getId));
      assert.match(await evaluate("location.search"), /page=2/);
      await navigate(await evaluate("location.pathname + location.search"));
      await waitFor(`${q(`[data-test=${test.prefix}-page]`)}?.textContent.includes("Page 2")`, `${test.prefix} reload retains page`);
      await fill(`[data-test=${test.prefix}-page-size]`, "50");
      await waitFor(`${q(`[data-test=${test.prefix}-page]`)}?.textContent.includes("Page 1") && ${q(`[data-test=${test.prefix}-page-size]`)}?.value === "50"`, `${test.prefix} size reset`);
      const fifty = await admin(`${test.api}&pageSize=50`);
      assert.deepEqual(await rowIds(`[data-test=${test.row}]`, test.attribute), fifty.items.map(test.getId));
    }
  });

  await check("order empty states preserve useful context and recover without losing list settings", async () => {
    await navigate("/orders?status=rejected&returns=open&pageSize=50&sort=submitted_asc");
    await waitFor(`${q("[data-test=orders-total]")}?.textContent === "0 orders"`, "no matching orders");
    assert.equal(await text("main h2"), "No orders match these filters");
    assert.match(await text("main"), /Try a different status or return filter/);
    assert.ok(!(await text("main")).includes("No retailer has created an order."));
    await evaluate(`[...document.querySelectorAll("main button")].find((button) => button.textContent.trim() === "Clear filters").click()`);
    await waitFor(`!!${q("[data-test=order-row]")}`, "orders after clearing filters");
    assert.equal(await evaluate('new URLSearchParams(location.search).get("pageSize")'), "50");
    assert.equal(await evaluate('new URLSearchParams(location.search).get("sort")'), "submitted_asc");
    assert.equal(await evaluate('new URLSearchParams(location.search).has("status") || new URLSearchParams(location.search).has("returns")'), false);

    await navigate("/orders?status=draft&page=999&pageSize=50");
    await waitFor(`${q("[data-test=orders-page]")}?.textContent.includes("Page 999")`, "empty page");
    assert.equal(await text("main h2"), "No orders on this page");
    await evaluate(`[...document.querySelectorAll("main button")].find((button) => button.textContent.trim() === "Return to first page").click()`);
    await waitFor(`!!${q("[data-test=order-row]")} && ${q("[data-test=orders-page]")}?.textContent.includes("Page 1")`, "first page recovery");
    assert.equal(await evaluate('new URLSearchParams(location.search).get("status")'), "draft");
    assert.equal(await evaluate('new URLSearchParams(location.search).get("pageSize")'), "50");
  });

  await check("skip link moves keyboard focus to content; narrow tables scroll from a named region", async () => {
    await navigate("/inventory");
    await waitFor(`!!${q("[data-test=inventory-row]")}`, "inventory list");
    await page.pressTab();
    assert.equal(await evaluate("document.activeElement?.textContent.trim()"), "Skip to content");
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate("document.activeElement?.id"), "main-content");
    await setWidth(390);
    await evaluate('document.querySelector("main [role=region]").focus()');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), "Inventory by SKU");
    assert.ok(await evaluate("document.activeElement.scrollWidth > document.activeElement.clientWidth"));
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await waitFor("document.activeElement.scrollLeft > 0", "keyboard scroll");
    assert.ok(await noHorizontalOverflow());
    await navigate("/admin/catalog");
    await waitFor(`!!${q("[data-test=product-row]")}`, "narrow catalog management");
    assert.ok(await noHorizontalOverflow(), "catalog table caption must not extend the page");
    await setWidth(1280);
  });

  await check("keyboard and 390px: audit filters, detail and pagination remain usable without page overflow", async () => {
    await navigate("/audit");
    await waitFor(`!!${q("[data-test=audit-row]")}`, "audit list");
    await evaluate(`${q("[data-test=audit-entity-type]")}.focus()`);
    await page.pressTab();
    assert.equal(await evaluate("document.activeElement?.dataset.test"), "audit-entityId");
    assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "none");
    for (const width of [1100, 1024]) {
      await setWidth(width);
      assert.ok(await noHorizontalOverflow(), `audit list overflow at ${width}px`);
    }
    await setWidth(390);
    assert.ok(await noHorizontalOverflow(), "audit list overflow");
    await screenshot("audit-list-narrow");
    await evaluate(`window.scrollTo(0, ${q("[data-test=audit-total]")}.getBoundingClientRect().top + window.scrollY - 20)`);
    await screenshot("audit-list-narrow-results");
    await click("[data-test=audit-link]");
    await waitFor(`!!${q("[data-test=audit-after]")}`, "narrow detail");
    assert.ok(await noHorizontalOverflow(), "audit detail overflow");
    await screenshot("audit-detail-narrow");
    await evaluate(`window.scrollTo(0, ${q("[data-test=audit-before]")}.getBoundingClientRect().top + window.scrollY - 70)`);
    await screenshot("audit-detail-narrow-values");
    for (const path of ["/orders?status=draft", `/inventory/${variant.id}?page=2`, "/admin/users?q=operations-", "/admin/organizations?q=Operations"]) {
      await navigate(path);
      await waitFor(`!!document.querySelector("nav[aria-label$='pages']")`, "pagination loaded");
      assert.ok(await noHorizontalOverflow(), `${path} overflow`);
    }
    await setWidth(1280);
    await logout();
  });

  await check("operator scope: operational events only, direct restricted details unavailable", async () => {
    await login("operator@pandora.test");
    await click("[data-test=audit-nav]");
    await waitFor(`!!${q("[data-test=audit-row]")}`, "operator audit");
    assert.deepEqual(await evaluate(`[...${q("[data-test=audit-entity-type]")}.options].map((option) => option.value)`), ["", "inventory_item", "order", "notification"]);
    assert.ok((await rowIds("[data-test=audit-row]", "data-entity-type")).every((type) => ["order", "inventory_item"].includes(type)));
    await navigate(`/audit/${restricted.id}`);
    await waitFor(`!!${q("[data-test=audit-detail-error]")}`, "restricted detail");
    assert.equal(await count("[data-test=audit-after]"), 0);
    await logout();
  });

  await check("retailer has no audit navigation or data on direct links; no page exceptions", async () => {
    await login("retailer@tabletop-lantern.test");
    assert.equal(await count("[data-test=audit-nav]"), 0);
    await navigate("/audit");
    await waitFor(`document.querySelector("h1")?.textContent === "Access restricted"`, "retailer refused");
    assert.equal(await count("[data-test=audit-row]"), 0);
    await navigate(`/audit/${restricted.id}`);
    await waitFor(`document.querySelector("h1")?.textContent === "Access restricted"`, "retailer detail refused");
    assert.equal(await count("[data-test=audit-after]"), 0);
    assert.deepEqual(pageErrors, []);
    await logout();
  });

  console.log(`\n${runner.passed} operations browser check groups passed. Screenshots: ${EVIDENCE}`);
} finally {
  page.close();
}
