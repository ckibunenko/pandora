## Current Feature

Login rate limiting and expired-session cleanup. Repeated failed sign-ins for the same email are temporarily refused, and sessions that can no longer be used are removed automatically. Both items are carried over from the auth feature ([auth-sessions.md](features/auth-sessions.md): "needed before a public demo exists").

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

- Evidence and details: [features/auth-hardening-verification.md](features/auth-hardening-verification.md).
- Full `pnpm check:all`: 13 of 13 pass (8 API suites, 5 browser groups). The new `auth` API check passed 5 of 5 on fresh databases, and the browser check passed 3 of 3.
- **Corrections found by the checks:**
  - The first limiter could starve a parallel burst entirely (0 of 12 checked). A per-email advisory lock around "count, then record" now checks exactly 5.
  - The first browser check froze the page with a self-retriggering `MutationObserver`. That hang led to a per-suite timeout in the runner, which kills hung suites together with their children.
- The migration was applied to the dev database without a reset, and there is no schema drift.
- **CI on PR #2:**
  - The first run failed on the admin race check. A request that lost three serialization retries got the defined 409 `CONCURRENT_MODIFICATION`.
  - Fix: `runSerializable` now waits a short random time between retries, and the race checks accept that outcome. They still require no 500, at most one success, and at least one administrator.
  - The second run (`36769046435`) passed all 3 jobs and 13 suites.

## Previous feature

[Test and CI setup](features/ci.md) is merged as `d0bb179`; [verification](features/ci-verification.md). Earlier: [demo reset](features/demo-reset.md), [organization and user administration](features/admin-management.md), [fulfillment](features/fulfillment.md), [order processing](features/order-processing.md), [order drafts](features/order-drafts.md), [inventory](features/inventory.md), [catalog](features/catalog.md), [auth and sessions](features/auth-sessions.md). Still outstanding: audit foreign keys, shared UI primitives, demo hosting and scheduling, and a unit-test framework.

## History

// Keep this updated earliest to latest

- Initial Next.js setup: bootstrapped project with `create-next-app` (Next.js 16, React 19, TypeScript, Tailwind CSS v4), stripped the boilerplate from `page.tsx` down to a single `<h1>Pandora</h1>`, cleared `globals.css` to just the Tailwind import, removed the default `public/*.svg` assets, and added the `context/` docs referenced from `AGENTS.md`. Committed as "initial setup" and pushed to `origin/main`.
- Architecture setup (2026-09-29): replaced the Next.js starter with a pnpm monorepo skeleton (`apps/web` React/Vite, `apps/api` NestJS, `packages/contracts`, `prisma/`, Docker Compose Postgres) connected through `/api/health` and `/api/health/ready`; rewrote `README.md` and updated `AGENTS.md` and `project-overview.md`. Merged to `main` as `fd36011`. Readiness against a running Postgres is still unverified because Docker was not installed.
- Authentication and sessions (2026-09-30): organizations, users, and Postgres-backed sessions (login, session, logout; 30 min idle / 8 h absolute; role and CSRF guards), API foundations (error envelope, correlation IDs, Zod validation, OpenAPI, JSON logs), deterministic seed with demo accounts, and a login page. OrbStack now provides local Postgres, which also confirmed `/api/health/ready` returns 200. Merged to `main` as `023f156`. Not yet verified: `db:reset` followed by `db:seed`.
- Catalog (2026-09-30): products/variants, EUR prices, browse/admin API and UI, seed, and transactional audit; 11 PostgreSQL/API and 7 browser check groups passed (see [features/catalog-verification.md](features/catalog-verification.md)). Independently rechecked before merge, then merged to `main` as `25153bd`.
- Inventory (2026-09-30): stock per SKU with receipts, adjustments, append-only movements, and audit; Idempotency-Key handling and Serializable transactions with bounded retry; catalog availability for all roles. 18 API/PostgreSQL groups (three fresh databases), catalog regression 11/11, and 9 browser groups (two fresh stacks) passed; see [features/inventory-verification.md](features/inventory-verification.md). Merged to `main` as `a9b1134`.
- Order drafts and submission (2026-09-30): shared retailer drafts with version checks, submission with price review and frozen snapshots, retailer cancellation, staff read-only access, Add to draft from the catalog, and demo orders. 16 API/PostgreSQL groups (three fresh databases), inventory and catalog regressions, and 11 order plus 9 inventory browser groups (two fresh stacks) passed; see [features/order-drafts-verification.md](features/order-drafts-verification.md). Merged to `main` as `6665eaa`.
- Order processing (2026-09-30): staff confirmation with all-or-nothing stock reservation (reservation records and movements), rejection with a reason, the operator processing queue, and seed orders for each state. 13 API/PostgreSQL groups (three fresh databases), updated order, inventory, and catalog regressions, and processing 7 / inventory 9 / order drafts 11 browser groups passed; see [features/order-processing-verification.md](features/order-processing-verification.md). Merged to `main` as `4b8d65c`.
- Fulfillment (2026-09-30): immutable shipments that consume reservations and stock, retailer cancellation requests for all remaining quantities with staff approval (releasing reservations) or rejection, the order status derived from quantities and verified by the database, and seed orders for these states. 11 API/PostgreSQL groups (three fresh databases), updated processing, orders, inventory, and catalog regressions, and fulfillment 8 / processing 7 / inventory 9 / order drafts 11 browser groups passed; see [features/fulfillment-verification.md](features/fulfillment-verification.md). Merged to `main` as `e7cf5af`.
- Organization and user administration (2026-09-30): administrator-only organization and account management, immediate session revocation, and distributor/last-administrator protection; fixed retry of commit-time serialization conflicts. API checks 12/12 and typecheck/lint/build passed again before the approved commit on `feature/admin-management`. Earlier browser checks passed 9/9; see [verification](features/admin-management-verification.md). Merged to `main` as `17d5ef5` before starting demo reset automation.
- Isolated demo reset (2026-09-30): dedicated Compose stack, persistent maintenance, stopped API writers, atomic fixture/session/idempotency restoration, readiness-gated reopening, and fail-closed recovery. Verified with 6 database and 5 lifecycle/browser groups plus administration/fulfillment regressions; demo reset 6/6 and administration 12/12 rerun on fresh databases before merge. Merged to `main` as `ada25a1`.
- Test and CI setup (2026-09-30): `pnpm check:all` runs every API/PostgreSQL suite and every CDP browser group on fresh, disposable QA databases. GitHub Actions runs typecheck/lint/build, API checks, and browser checks on pushes to `main` and pull requests. Application checks and CI live in this repository. Locally 11/11 suites passed in about 55 s; on GitHub Actions run `36763707451` (PR #1) all 3 jobs and 11 suites passed; see [features/ci-verification.md](features/ci-verification.md). Merged to `main` as `d0bb179`.
- Sign-in rate limiting and session cleanup (2026-09-30): at most 5 sign-in attempts per normalized email per 15 minutes (429 with `Retry-After`, identical for unknown accounts, digests only, per-email advisory lock so a parallel burst checks exactly 5). Automatic removal of sessions unusable for more than 24 hours. Demo reset also clears attempts. `check:all` gained the auth suites and a per-suite timeout. CI on PR #2 exposed immediate serialization retries colliding, so `runSerializable` now backs off with jitter. Final CI: 3 jobs and 13 suites passed; see [features/auth-hardening-verification.md](features/auth-hardening-verification.md). Merged to `main` as `c239416` + `a564c18`.
