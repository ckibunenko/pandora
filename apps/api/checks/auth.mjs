// Sign-in rate limiting and session cleanup checks against an isolated, empty QA database.
// Usage: see context/features/auth-hardening-verification.md.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { errorEnvelopeSchema } from "@pandora/contracts";
import { startQaApi } from "./harness.mjs";

// Cleanup runs every second in this API process so its effect can be observed.
process.env.SESSION_CLEANUP_INTERVAL_SECONDS = "1";
const qa = await startQaApi({
  databaseEnv: "AUTH_CHECK_DATABASE",
  databasePattern: /^pandora_auth_check_[a-z0-9_]+$/,
  portEnv: "AUTH_CHECK_PORT",
  defaultPort: "3018",
});
const { db, call, check } = qa;

const PASSWORD = process.env.SEED_USER_PASSWORD;
const WRONG = "definitely-not-the-password";
const OPERATOR_ID = "01920000-0000-7000-8000-000000000102";
const keyOf = (email) => createHash("sha256").update(email.toLowerCase()).digest("hex");
const attemptsFor = (email) => db.loginAttempt.count({ where: { keyHash: keyOf(email) } });
const HOUR = 60 * 60 * 1000;

async function attempt(email, password) {
  const response = await fetch(`${qa.origin}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (response.status !== 200) errorEnvelopeSchema.parse(body);
  return { status: response.status, code: body.code, message: body.message, retryAfter: response.headers.get("retry-after") };
}
async function exhaust(email) {
  for (let i = 0; i < 5; i += 1) {
    const result = await attempt(email, WRONG);
    assert.deepEqual([result.status, result.code], [401, "INVALID_CREDENTIALS"], `attempt ${i + 1} for ${email}`);
  }
}
const backdate = (email, minutes) =>
  db.$executeRaw`UPDATE login_attempts SET attempted_at = attempted_at - make_interval(mins => ${minutes}) WHERE key_hash = ${keyOf(email)}`;

try {
  await check("five attempts per email: the sixth, and even the correct password, get 429 with Retry-After; other accounts are unaffected", async () => {
    const email = "retailer@cardboard-keep.test";
    await exhaust(email);
    const limited = await attempt(email, WRONG);
    assert.deepEqual([limited.status, limited.code], [429, "TOO_MANY_LOGIN_ATTEMPTS"]);
    assert.match(limited.message, /^Too many sign-in attempts\. Try again in 1[45] minutes\.$/);
    assert.ok(Number(limited.retryAfter) > 800 && Number(limited.retryAfter) <= 900, `Retry-After ${limited.retryAfter}`);
    const correct = await attempt(email, PASSWORD);
    assert.deepEqual([correct.status, correct.code], [429, "TOO_MANY_LOGIN_ATTEMPTS"], "the correct password is refused while limited");
    assert.equal(await attemptsFor(email), 5, "refused attempts are not recorded");
    assert.equal((await attempt("RETAILER@Cardboard-Keep.TEST", PASSWORD)).status, 429, "the key ignores case");
    assert.equal((await attempt("operator@pandora.test", PASSWORD)).status, 200, "another account still signs in");
    const stored = await db.loginAttempt.findMany({ select: { keyHash: true } });
    assert.ok(stored.every((row) => /^[0-9a-f]{64}$/.test(row.keyHash)), "only digests are stored");
  });

  await check("no account enumeration: unknown emails and inactive users are counted and answered like real accounts", async () => {
    for (const email of ["nobody@nowhere.test", "former@tabletop-lantern.test", "retailer@closed-shelf.test"]) {
      await exhaust(email);
      const limited = await attempt(email, PASSWORD);
      assert.deepEqual([limited.status, limited.code], [429, "TOO_MANY_LOGIN_ATTEMPTS"], email);
      assert.match(limited.message, /^Too many sign-in attempts\. Try again in 1[45] minutes\.$/);
      assert.ok(Number(limited.retryAfter) > 0);
    }
  });

  await check("the window expires, a successful sign-in clears the attempts, and the count starts again", async () => {
    const email = "retailer@cardboard-keep.test";
    await backdate(email, 16);
    assert.equal((await attempt(email, PASSWORD)).status, 200, "sign-in works once the window passes");
    assert.equal(await attemptsFor(email), 0, "success clears the attempts");
    for (let i = 0; i < 4; i += 1) assert.equal((await attempt(email, WRONG)).status, 401);
    assert.equal((await attempt(email, PASSWORD)).status, 200, "the fifth attempt, correct, succeeds");
    await exhaust(email);
    assert.equal((await attempt(email, WRONG)).status, 429, "a full new window is available after success");
    // Partly expired window: two attempts drop out, so two more are allowed.
    await db.$executeRaw`UPDATE login_attempts SET attempted_at = attempted_at - interval '16 minutes'
      WHERE id IN (SELECT id FROM login_attempts WHERE key_hash = ${keyOf(email)} ORDER BY attempted_at LIMIT 2)`;
    assert.equal((await attempt(email, WRONG)).status, 401);
    assert.equal((await attempt(email, WRONG)).status, 401);
    assert.equal((await attempt(email, WRONG)).status, 429);
  });

  await check("12 parallel attempts: exactly five passwords are checked and seven get 429 (repeated 3 times)", async () => {
    // Before the per-email lock, a burst could starve every attempt, including legitimate ones.
    for (const email of ["retailer@tabletop-lantern.test", "operator@pandora.test", "burst@nowhere.test"]) {
      const results = await Promise.all(Array.from({ length: 12 }, () => attempt(email, WRONG)));
      const statuses = results.map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 401).length, 5, `${email}: ${statuses.join(",")}`);
      assert.equal(statuses.filter((s) => s === 429).length, 7, `${email}: ${statuses.join(",")}`);
      assert.equal(await attemptsFor(email), 5, "exactly the checked attempts are recorded");
      assert.equal((await attempt(email, PASSWORD)).status, 429);
      await backdate(email, 16);
    }
    assert.equal((await attempt("operator@pandora.test", PASSWORD)).status, 200, "the operator can sign in again after the window");
  });

  await check("cleanup removes sessions unusable for over 24 hours and old attempts; usable and recent ones stay", async () => {
    const active = await attempt("admin@pandora.test", PASSWORD);
    assert.equal(active.status, 200);
    const admin = await qa.login("admin@pandora.test");
    const now = Date.now();
    const session = async (label, createdOffset, expiresOffset, revokedOffset = null) => {
      const created = new Date(now + createdOffset);
      const expires = new Date(now + expiresOffset);
      const revoked = revokedOffset === null ? null : new Date(now + revokedOffset);
      const [row] = await db.$queryRaw`
        INSERT INTO sessions (user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at, revoked_at, revoked_reason)
        VALUES (${OPERATOR_ID}::uuid, ${randomBytes(32).toString("hex")}, 'qa', ${created}, ${created}, ${expires},
          ${revoked}, ${revoked ? "logout" : null})
        RETURNING id`;
      return [label, row.id];
    };
    const sessions = [
      await session("expired 25 h ago", -33 * HOUR, -25 * HOUR),
      await session("revoked 25 h ago", -26 * HOUR, -18 * HOUR, -25 * HOUR),
      await session("expired 1 h ago", -9 * HOUR, -1 * HOUR),
      await session("revoked 10 min ago", -1 * HOUR, 7 * HOUR, -10 * 60 * 1000),
    ];
    const email = "operator@pandora.test";
    for (let i = 0; i < 2; i += 1) assert.equal((await attempt(email, WRONG)).status, 401);
    await backdate(email, 20);
    assert.equal((await attempt(email, WRONG)).status, 401, "a recent attempt that must stay");

    const remaining = async () =>
      new Set((await db.session.findMany({ where: { id: { in: sessions.map(([, id]) => id) } }, select: { id: true } })).map((s) => s.id));
    // One cleanup run deletes sessions, then attempts; wait for both effects.
    for (let i = 0; i < 50 && ((await remaining()).size !== 2 || (await attemptsFor(email)) !== 1); i += 1) await delay(100);
    const left = await remaining();
    assert.deepEqual(
      sessions.filter(([, id]) => left.has(id)).map(([label]) => label),
      ["expired 1 h ago", "revoked 10 min ago"],
    );
    assert.equal(await attemptsFor(email), 1, "attempts older than the window are removed");
    assert.equal((await call("/auth/session", { actor: admin })).status, 200, "usable sessions are untouched");
    assert.match(qa.logs(), /"Session cleanup"/);
  });

  await check("OpenAPI documents 429 with Retry-After; logs hold a key prefix but no emails or passwords", async () => {
    const document = await (await fetch(`${qa.origin}/openapi.json`)).json();
    const response = document.paths["/api/auth/login"].post.responses["429"];
    assert.ok(response?.headers?.["Retry-After"], "429 and Retry-After documented");
    const logs = qa.logs();
    assert.match(logs, /"Sign-in attempts limited"/);
    assert.match(logs, new RegExp(`"key":"${keyOf("retailer@cardboard-keep.test").slice(0, 12)}"`));
    for (const secret of ["cardboard-keep.test", "nobody@nowhere.test", WRONG, PASSWORD, "$argon2", "pandora_session="]) {
      assert.ok(!logs.includes(secret), "logs must not contain emails, passwords, hashes, or tokens");
    }
  });

  console.log(`\n${qa.passed} auth hardening check groups passed.`);
} catch (error) {
  console.error(qa.logs().slice(-4000));
  throw error;
} finally {
  await qa.stop();
}
