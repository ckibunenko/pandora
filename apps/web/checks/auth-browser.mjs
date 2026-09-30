// Browser checks for sign-in rate limiting, using the shared CDP driver.
// Requires a freshly seeded QA API and web server (pnpm check:all runs it in its own group); it locks a seeded account.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunner, startBrowser } from "./cdp.mjs";

const BASE = process.env.AUTH_BROWSER_URL ?? "http://localhost:5175";
const EVIDENCE = process.env.AUTH_CHECK_EVIDENCE ?? join(tmpdir(), "pandora-auth-evidence");
const PASSWORD = process.env.SEED_USER_PASSWORD;
assert.ok(PASSWORD, "SEED_USER_PASSWORD must be set (run with --env-file=.env).");
const LOCKED = "retailer@cardboard-keep.test";

const page = await startBrowser({ base: BASE, evidence: EVIDENCE, port: Number(process.env.AUTH_CDP_PORT ?? 9340) });
const { q, evaluate, waitFor, text, fill, click, navigate, screenshot, setWidth, noHorizontalOverflow, logout, pageErrors } = page;
const runner = checkRunner();
const check = runner.check;

const loginResponses = `performance.getEntriesByType("resource").filter((entry) => entry.name.endsWith("/api/auth/login")).length`;

/** Submits once and waits until that request's response is rendered, so a stale message is never read. */
async function submit(email, password) {
  const before = await evaluate(loginResponses);
  await fill("[data-test=login-email]", email);
  await fill("[data-test=login-password]", password);
  await click("[data-test=login-submit]");
  await waitFor(
    `${loginResponses} > ${before} && (location.pathname !== "/login" || (!${q("[data-test=login-submit]")}.disabled && !!${q("[data-test=login-error]")}))`,
    `sign-in attempt ${before + 1} settled`,
  );
}

try {
  await setWidth(1280);
  await navigate("/login");
  await waitFor(`!!${q("[data-test=login-email]")}`, "login form");

  await check("five wrong passwords show the normal error; the sixth attempt shows the lockout message", async () => {
    for (let i = 0; i < 5; i += 1) {
      await submit(LOCKED, "wrong-password-in-browser");
      assert.equal(await text("[data-test=login-error]"), "Invalid email or password.");
    }
    await submit(LOCKED, "wrong-password-in-browser");
    assert.equal(await text("[data-test=login-error]"), "Too many sign-in attempts. Try again in 15 minutes.");
    assert.equal(await evaluate(`${q("[data-test=login-error]")}.getAttribute("role")`), "alert");
    await screenshot("login-locked");
  });

  await check("the correct password is refused during the lockout; the email stays filled in", async () => {
    await submit(LOCKED, PASSWORD);
    assert.equal(await evaluate("location.pathname"), "/login");
    assert.match(await text("[data-test=login-error]"), /^Too many sign-in attempts/);
    assert.equal(await evaluate(`${q("[data-test=login-email]")}.value`), LOCKED);
    await setWidth(390);
    assert.ok(await noHorizontalOverflow(), "login page overflows at 390px");
    await setWidth(1280);
  });

  await check("another account signs in normally; no page errors", async () => {
    await submit("operator@pandora.test", PASSWORD);
    await waitFor(`location.pathname !== "/login" && !!${q("[data-test=logout-button]")}`, "operator signed in");
    await logout();
    assert.deepEqual(pageErrors, []);
  });

  console.log(`\n${runner.passed} auth browser check groups passed. Screenshots: ${EVIDENCE}`);
} finally {
  page.close();
}
