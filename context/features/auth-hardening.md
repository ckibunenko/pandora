## Current Feature

Login rate limiting and expired-session cleanup. Repeated failed sign-ins for the same email are temporarily refused, and sessions that can no longer be used are removed automatically. Both items are carried over from the auth feature ([auth-sessions.md](auth-sessions.md): "needed before a public demo exists").

## Status

Completed — merged to `main` as `c239416` + `a564c18` (2026-09-30) through PR #2, with CI green.

## Goal

Guessing a password becomes impractical without revealing which accounts exist, and the sessions table no longer grows without bound.

## Scope and decisions (2026-09-30)

- Branch: `feature/auth-hardening`.
- **Rate limit, per email address:**
  - At most **5 sign-in attempts per normalized email in a rolling 15-minute window**.
  - The 6th attempt and later get **429 `TOO_MANY_LOGIN_ATTEMPTS`** with a `Retry-After` header and a message stating how long to wait.
  - During the lockout **even the correct password is refused**, and the password is not checked at all.
  - A successful sign-in clears the attempts for that email.
- **No account enumeration:** unknown emails, inactive users, and inactive organizations are counted and answered exactly like existing accounts.
- **Storage:**
  - Attempts are stored in PostgreSQL (`login_attempts`: SHA-256 of the normalized email, and the time). Raw emails and passwords are never stored.
  - The limit holds across API instances and restarts.
- **Strict under concurrency:**
  - Each attempt is recorded first and then counted against the window. An attempt over the limit removes its own record and gets 429.
  - Parallel attempts can therefore never check more than 5 passwords per window, and no database lock is held during password hashing.
- **No per-IP limit.** The API has no trusted-proxy configuration, and behind the demo reverse proxy every client would share one address. Revisit this with hosting.
- **Lockout as a nuisance:** anyone who knows an email can lock that account for up to 15 minutes. This is the accepted tradeoff of a per-account limit, and the lockout is temporary.
- **Session cleanup:**
  - The API removes sessions that have been unusable for **more than 24 hours**: expired, idle-expired, or revoked.
  - Usable sessions and recently revoked ones (kept for diagnostics) stay.
  - The same run removes attempts older than the rate-limit window.
  - It runs at startup and then every `SESSION_CLEANUP_INTERVAL_SECONDS` (default 3600). Deletes are idempotent, so several API instances are safe.
  - A failed run is logged and does not stop the API.
- **Demo reset** also clears `login_attempts`.
- **Logging:** a lockout logs a warning with a short hash prefix, never the email. Cleanup logs the counts removed.
- **UI:** the sign-in page shows the lockout message from the server. No other UI changes.
- **Out of scope:** CAPTCHA, notifying users about lockouts, per-IP limits, and administrator unlock (the window expires by itself; a demo reset also clears it).

## Data

- `LoginAttempt`: `id`, `keyHash` (64 hex), and `attemptedAt`, with an index on `(keyHash, attemptedAt)`. A new migration sorts after the existing ones.
- Config: `SESSION_CLEANUP_INTERVAL_SECONDS` is optional, an integer from 1 to 86400, default 3600.

## Verification

- **API/PostgreSQL** (`check:auth`):
  - 5 wrong passwords, then 429 with `Retry-After`, including for the correct password.
  - Another account is unaffected.
  - An unknown email and an inactive user behave identically.
  - When the window expires (attempts backdated in the database), sign-in works and the attempts are cleared.
  - A success resets the count.
  - 10 parallel wrong attempts check at most 5 passwords, and the rest get 429.
  - No emails or passwords appear in the database or logs.
- **Cleanup** (API started with a 1-second interval):
  - Sessions expired, idle, or revoked more than 24 hours ago are deleted.
  - Usable and recently revoked sessions stay.
  - Old attempts are deleted.
- **Demo reset** clears attempts. The existing demo-reset check covers this.
- **Browser** (new group in `check:all`): repeated wrong passwords show the lockout message, and another account still signs in.
- `pnpm check:all` passes locally, and CI is green on the pull request. `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass.

## Implementation results (2026-09-30)

- Evidence and details: [features/auth-hardening-verification.md](auth-hardening-verification.md).
- Full `pnpm check:all`: 13 of 13 pass (8 API suites, 5 browser groups). The new `auth` API check passed 5 of 5 on fresh databases, and the browser check passed 3 of 3.
- **Corrections found by the checks:**
  - The first limiter could starve a parallel burst entirely (0 of 12 checked). A per-email advisory lock around "count, then record" now checks exactly 5.
  - The first browser check froze the page with a self-retriggering `MutationObserver`. That hang led to a per-suite timeout in the runner, which kills hung suites together with their children.
- The migration was applied to the dev database without a reset, and there is no schema drift.
- **CI on PR #2:**
  - The first run failed on the admin race check. A request that lost three serialization retries got the defined 409 `CONCURRENT_MODIFICATION`.
  - Fix: `runSerializable` now waits a short random time between retries, and the race checks accept that outcome. They still require no 500, at most one success, and at least one administrator.
  - The second run (`36769046435`) passed all 3 jobs and 13 suites.

