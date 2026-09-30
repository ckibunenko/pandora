# Sign-in rate limiting and session cleanup: verification and handoff

## Implemented scope

- **Rate limit:**
  - At most 5 sign-in attempts per normalized email in a rolling 15-minute window (`LoginRateLimiter`, `apps/api/src/modules/auth/login-rate-limiter.ts`).
  - Later attempts get **429 `TOO_MANY_LOGIN_ATTEMPTS`**. The response includes `Retry-After` (seconds) and the message "Too many sign-in attempts. Try again in N minutes."
  - While the limit applies, even the correct password is refused and the password is not checked.
  - A successful sign-in clears the attempts for that email.
  - Unknown emails, inactive users, and inactive organizations are counted and answered identically, so the limit reveals nothing about accounts.
- **Storage:**
  - `login_attempts` holds `key_hash` and `attempted_at`. `key_hash` is the SHA-256 of the lowercased email; a CHECK allows only 64 hex characters.
  - Refused attempts are not recorded.
- **Session cleanup** (`SessionCleanupService`):
  - Removes sessions that have been unusable for more than 24 hours (expired, revoked, or idle), and attempts older than the window.
  - Runs at API startup and every `SESSION_CLEANUP_INTERVAL_SECONDS` (optional, 1–86400, default 3600).
  - Logs counts only when something was removed. A failed run is logged and does not stop the API.
- **Demo reset** truncates `login_attempts`, and its verification counts now include it (must be 0).
- **Web:** the sign-in page shows the server's lockout message in its existing alert.
- **OpenAPI:** `POST /api/auth/login` documents 429 with the `Retry-After` header.
- **Runner (`scripts/check-all.mjs`):**
  - Added the `auth` API suite and a separate `auth` browser group; the group locks a seeded account, so it gets its own database.
  - Added a per-suite timeout. A suite that runs longer than `CHECK_SUITE_TIMEOUT_SECONDS` (default 300) is killed with its child processes (Chrome, servers) and counts as failed.
  - Ctrl-C stops every started process group.

## Design decisions

- **Per-email, not per-IP.**
  - The API has no trusted-proxy configuration. Behind the demo reverse proxy, every client would share one address, so a per-IP limit would lock out everyone.
  - Revisit this together with hosting.
  - Accepted tradeoff: anyone who knows an email can pause that account's sign-in for up to 15 minutes.
- **Strict and fair under concurrency:**
  - The first implementation recorded each attempt, then counted. That kept the upper bound, but a parallel burst could starve every attempt: in one run of 12 parallel attempts, none were checked.
  - The `auth` check exposed this.
  - Now a per-email `pg_advisory_xact_lock` covers only "count the window, then record". Exactly 5 attempts are checked, the rest get 429, and no lock is held during password hashing.
- **Retention of 24 hours:** recently revoked sessions stay for diagnostics; the admin and fulfillment checks read `revoked_reason` right after revocation.
- **No administrator unlock:** the window expires by itself, and a demo reset also clears it.

## API / PostgreSQL checks

`apps/api/checks/auth.mjs` (`pnpm --filter @pandora/api check:auth`, or `pnpm check:all --api --only auth`) uses port 3018 and starts the API with a 1-second cleanup interval.

Covered groups (6):

1. **The sixth attempt is limited:**
   - Five wrong passwords get 401, then 429 with a message of 14–15 minutes and `Retry-After` between 801 and 900 s.
   - The correct password is refused during the lockout, and the email's case is ignored.
   - Refused attempts are not recorded, and another account still signs in.
   - Only digests are stored.
2. **No enumeration:** an unknown email, an inactive user, and a user of an inactive organization behave exactly like a real account.
3. **Window and reset:**
   - Once the window is backdated, sign-in works and the attempts are cleared.
   - Four wrong attempts plus a correct one succeeds and resets the count, and a full new window follows.
   - A partly expired window frees exactly the expired slots.
4. **Parallel attempts:** 12 parallel wrong attempts for each of three emails (two real, one unknown) → exactly 5 × 401 and 7 × 429, with 5 recorded. The correct password is then refused, and works again after the window.
5. **Cleanup:**
   - Removed: a session expired 25 h ago, and one revoked 25 h ago (expired only 18 h ago).
   - Kept: a session expired 1 h ago, one revoked 10 min ago, and a live session.
   - Attempts older than the window are removed and a recent one stays. The cleanup log line appears.
6. **OpenAPI and logs:**
   - 429 and `Retry-After` are documented.
   - The limit warning logs a 12-character key prefix.
   - The logs contain no emails, attempted or real passwords, argon2 hashes, or session cookies.

## Browser checks

`apps/web/checks/auth-browser.mjs` runs in its own `check:all` group. It waits for each sign-in response through the Performance API, so a stale message is never read.

1. **Lockout:** five wrong passwords show "Invalid email or password.", and the sixth shows "Too many sign-in attempts. Try again in 15 minutes." in the `role="alert"` message.
2. **Correct password during lockout:** it is refused, the email stays filled in, and the page has no overflow at 390px.
3. **Other accounts:** another account signs in normally, and no page errors occur.

Correction during development: the first version of this browser check tagged messages with a `MutationObserver` that also watched attributes. It retriggered itself forever and froze the page. That hang is what prompted the runner's per-suite timeout.

## Results — 2026-09-30

- **`auth` API check:** 5 of 5 consecutive fresh-database runs passed after the concurrency fix. One earlier run failed because of a race in the check itself: it waited for deleted sessions but not deleted attempts. The check now waits for both.
- **Full `pnpm check:all`** (run `20260930_194719`): all 13 passed.
  - API: catalog 11, inventory 18, orders 16, processing 13, fulfillment 11, admin 12, demo-reset 6, auth 6.
  - Browser: fulfillment 8, processing 7 + inventory 9, orders 11, admin 9, auth 3.
- **Timeout:** with `CHECK_SUITE_TIMEOUT_SECONDS=1`, the browser suite was killed: FAIL, exit 1, and no leftover Chrome, API, or web process.
- **Development database:** the migration was applied with `db:deploy` (no reset), and `prisma migrate diff` is empty. After a dev-server restart, sign-in and the admin smoke test work.
- **Screenshot inspected:** the lockout message on the sign-in page.
- **Final gates:** `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass. CI is recorded after the pull request runs.

## Limitations and follow-ups

- There is no per-IP limit, no CAPTCHA, no user notification of lockouts, and no administrator unlock.
- Attempts keyed to an email that never signs in successfully stay until cleanup removes them after the window.
- The cleanup interval is per API instance. It is safe with several instances, but each instance runs it.
