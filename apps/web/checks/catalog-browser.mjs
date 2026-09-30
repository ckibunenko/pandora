import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const modulePath = process.env.PANDORA_PLAYWRIGHT_MODULE ?? "playwright";
const { chromium } = await import(modulePath);
const origin = process.env.CATALOG_CHECK_WEB_URL ?? "http://localhost:5174";
assert.match(origin, /^http:\/\/(localhost|127\.0\.0\.1):[0-9]+$/);
const evidence =
  process.env.CATALOG_CHECK_EVIDENCE ?? "/private/tmp/pandora-catalog-evidence";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const selector = (name) => page.locator(`[data-test="${name}"]`);
let checks = 0;
async function check(label, run) {
  await run();
  checks++;
  console.log(`PASS ${label}`);
}
async function login(email) {
  await page.goto(`${origin}/login`);
  await selector("login-email").fill(email);
  await selector("login-password").fill(process.env.SEED_USER_PASSWORD);
  await selector("login-submit").click();
  await page.waitForURL((url) => url.pathname !== "/login");
}
async function logout() {
  await selector("logout-button").click();
  await page.waitForURL("**/login");
}
async function noOverflow() {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "No horizontal page overflow",
  );
}
try {
  await check("keyboard login and administrator landing", async () => {
    await page.goto(`${origin}/login`);
    await selector("login-email").focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await selector("login-password").evaluate(
        (el) => el === document.activeElement,
      ),
      true,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await selector("login-submit").evaluate(
        (el) => el === document.activeElement,
      ),
      true,
    );
    assert.notEqual(
      await selector("login-submit").evaluate(
        (el) => getComputedStyle(el).outlineStyle,
      ),
      "none",
    );
    await login("admin@pandora.test");
    await page.waitForURL("**/admin/catalog");
    // Browser mutation checks run only against the database populated by catalog.mjs.
    const response = await page.request.get(
      `${origin}/api/admin/catalog/products?q=Boundary%20QA`,
    );
    assert.equal(
      (await response.json()).total,
      41,
      "Expected isolated QA pagination fixtures; do not run browser mutations against development data.",
    );
    await selector("product-create").waitFor();
    await page.screenshot({
      path: `${evidence}/admin-desktop.png`,
      fullPage: true,
    });
  });
  const name = `Browser QA ${Date.now()}`;
  let productPath;
  await check(
    "create product and retain form values after validation",
    async () => {
      await selector("product-create").click();
      await selector("product-save").click();
      await page.getByRole("alert").filter({ hasText: "correct" }).waitFor();
      await selector("field-name").fill(name);
      await selector("field-publisher").fill("Browser QA Studio");
      await selector("field-description").fill(
        "An isolated browser check product.",
      );
      await selector("product-save").click();
      await page.waitForURL((url) =>
        /\/admin\/catalog\/[0-9a-f-]{36}$/.test(url.pathname),
      );
      productPath = new URL(page.url()).pathname;
      await selector("variant-create").waitFor();
      assert.equal(await selector("field-name").inputValue(), name);
    },
  );
  await check(
    "duplicate SKU error preserves inputs, followed by successful variant create",
    async () => {
      await selector("variant-create").click();
      await selector("field-sku").fill("LOV-EN-STD");
      await selector("field-unitPriceMinor").fill("12.50");
      await selector("variant-save").click();
      await page
        .getByRole("alert")
        .filter({ hasText: "already in use" })
        .waitFor();
      assert.equal(
        await selector("field-unitPriceMinor").inputValue(),
        "12.50",
      );
      assert.equal(
        await selector("field-sku").getAttribute("aria-invalid"),
        "true",
      );
      await selector("field-sku").fill(`BROWSER-${Date.now()}`);
      await selector("variant-save").click();
      await page
        .getByRole("status")
        .filter({ hasText: "Variant saved" })
        .waitFor();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await selector("variant-row").waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-test="variant-create"]') ===
          document.activeElement,
      );
    },
  );
  await check(
    "variant editing, integer price parsing, product deactivation and reactivation",
    async () => {
      await selector("variant-edit").click();
      assert.equal(await selector("field-sku").isDisabled(), true);
      await selector("field-unitPriceMinor").fill("0.001");
      await selector("variant-save").click();
      await page
        .getByText(
          "Enter an amount from 0 to 21,474,836.47 with at most two decimals.",
        )
        .waitFor();
      await selector("field-unitPriceMinor").fill("0.00");
      await selector("variant-save").click();
      await page
        .getByRole("status")
        .filter({ hasText: "Variant saved" })
        .waitFor();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await selector("product-active").uncheck();
      await selector("product-save").click();
      await page
        .getByRole("status")
        .filter({ hasText: "Product saved" })
        .waitFor();
      const id = productPath.split("/").at(-1);
      assert.equal(
        (
          await page.request.get(`${origin}/api/catalog/products/${id}`)
        ).status(),
        404,
      );
      await selector("product-active").check();
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/admin/catalog/products/${id}`) &&
            response.request().method() === "PATCH" &&
            response.status() === 200,
        ),
        selector("product-save").click(),
      ]);
      await page.getByRole("link", { name: "View in catalog" }).waitFor();
      assert.equal(
        (
          await page.request.get(`${origin}/api/catalog/products/${id}`)
        ).status(),
        200,
      );
      await page.screenshot({
        path: `${evidence}/admin-product-desktop.png`,
        fullPage: true,
      });
    },
  );
  await check(
    "retailer catalog, filters, pagination, variant selection and reload",
    async () => {
      await logout();
      await login("retailer@tabletop-lantern.test");
      await page.waitForURL("**/catalog");
      await selector("product-card").first().waitFor();
      await selector("catalog-search").fill("Boundary QA");
      await selector("catalog-search-submit").click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-test="catalog-total"]')?.textContent ===
          "41 products",
      );
      await selector("catalog-next").click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-test="catalog-page"]')?.textContent ===
          "Page 2 of 3",
      );
      await selector("catalog-language").selectOption("sr");
      await page.waitForFunction(
        () =>
          document.querySelector('[data-test="catalog-page"]')?.textContent ===
          "Page 1 of 3",
      );
      await page.goto(`${origin}/catalog?q=Lanterns`);
      await selector("product-card").first().waitFor();
      await page.screenshot({
        path: `${evidence}/catalog-desktop.png`,
        fullPage: true,
      });
      await noOverflow();
      await page
        .getByRole("link", { name: "View Lanterns of Velora", exact: true })
        .click();
      await selector("variant-select").waitFor();
      assert.equal(await selector("variant-select").inputValue(), "");
      assert.equal(await selector("selected-variant").count(), 0);
      await selector("variant-select").selectOption({ index: 1 });
      await selector("selected-variant").waitFor();
      assert.match(await selector("selected-variant").textContent(), /42\.00/);
      await page.reload();
      await selector("variant-select").waitFor();
      assert.equal(await selector("variant-select").inputValue(), "");
      await selector("variant-select").selectOption({ index: 1 });
      await page.screenshot({
        path: `${evidence}/product-desktop.png`,
        fullPage: true,
      });
    },
  );
  await check(
    "responsive catalog and product at 390, 768 and 1280 pixels",
    async () => {
      for (const width of [390, 768, 1280]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        await noOverflow();
        await page.screenshot({
          path: `${evidence}/product-${width}.png`,
          fullPage: true,
        });
        await page.goto(`${origin}/catalog?q=Lanterns`);
        await selector("product-card").first().waitFor();
        await noOverflow();
        await page.screenshot({
          path: `${evidence}/catalog-${width}.png`,
          fullPage: true,
        });
        await page
          .getByRole("link", { name: "View Lanterns of Velora", exact: true })
          .click();
        await selector("variant-select").waitFor();
      }
    },
  );
  await check(
    "empty/error states, role restriction, operator home and logout regression",
    async () => {
      await page.goto(`${origin}/catalog?q=NoSuchFixture`);
      await page.getByRole("heading", { name: "No products found" }).waitFor();
      await page.goto(`${origin}/catalog/not-a-uuid`);
      await page.getByRole("alert").waitFor();
      await page.goto(`${origin}/admin/catalog`);
      await page.getByRole("heading", { name: "Access restricted" }).waitFor();
      await logout();
      await login("operator@pandora.test");
      await page.waitForURL(`${origin}/`);
      await page.getByRole("link", { name: "Browse catalog" }).click();
      await selector("product-card").first().waitFor();
      await logout();
      await page.goto(`${origin}/catalog`);
      await page.waitForURL("**/login");
    },
  );
  assert.deepEqual(errors, []);
  console.log(
    `Browser checks passed: ${checks} groups; no page errors. Evidence: ${evidence}`,
  );
} finally {
  await browser.close();
}
