## Current Feature

Public demo preparation (provider-independent). Everything the public demo needs that does not depend on a hosting decision: an HTTPS entry point, secure session cookies, a read-only public inbox, the daily 03:00 Europe/Belgrade reset schedule, and an operations runbook for any Linux VPS. Verified locally (overview §9 and §11).

## Status

In progress on `feature/public-demo-prep`.

## Scope and decisions (2026-10-01)

- Branch: `feature/public-demo-prep`.
- **Hosting is still undecided** (user, 2026-10-01: "for now, locally"). This feature adds no provider account, DNS, or deployment. The hosting, public URL, resource limits, and costs remain open decisions.
- **Entry point:** a Caddy reverse proxy (`caddy:2.11.4-alpine`) becomes the only published service of `compose.demo.yml`. It routes `/mail/*` to Mailpit and everything else to the existing web container (nginx: SPA, `/api` proxy, maintenance page). The web, API, worker, database, and Mailpit are no longer published.
  - **HTTPS:** `DEMO_DOMAIN` (default `localhost`) and `DEMO_TLS` (default `internal`, Caddy's local CA; on a server, an ACME contact email for automatic Let's Encrypt certificates).
  - **Ports:** HTTP (`DEMO_PORT`, default 5180) redirects to HTTPS (`DEMO_HTTPS_PORT`, default 5443), bound to `DEMO_BIND` (default `127.0.0.1`; `0.0.0.0` on a server). The container listens on the same port numbers, so redirects keep the right port.
  - **Headers:** `nosniff`, `Referrer-Policy: no-referrer`, frame denial, no `Server` header. HSTS comes from `DEMO_HSTS` (default `max-age=0` locally, so `localhost` development is not forced to HTTPS).
- **Session cookies:** the demo API sets `SESSION_COOKIE_SECURE=true`, because the demo is served only over HTTPS.
- **Public read-only inbox** (user decision, 2026-10-01): Mailpit is served at `/mail/` (`MP_WEBROOT`) for anyone.
  - The proxy refuses every method except GET and HEAD with 405. That blocks deleting, marking as read, and the Send API. All addresses are fictional.
  - Mailpit runs with the version check and remote CSS and fonts disabled.
- **Daily reset:** `deploy/demo/systemd/pandora-demo-reset.{service,timer}` runs `scripts/demo-reset.mjs` at 03:00 Europe/Belgrade (`OnCalendar` with a time zone, `Persistent=true`). A cron line is documented as an alternative. The reset lifecycle itself is unchanged and already fails closed.
- **Runbook:** `context/features/public-demo-runbook.md` covers server prerequisites, a firewall allowing only 22, 80, and 443, DNS, `.env.demo`, build, first reset, enabling the timer, verification, updates, recovery, and rollback.
- **Out of scope:** choosing and paying for a host, DNS, monitoring and alerting, backups (the demo is restored from fixtures), rate limiting beyond sign-in, and multi-host scaling.

## Verification

- **Docker demo lifecycle** (`apps/web/checks/demo-reset-browser.mjs`, extended) on a disposable `pandora-demo-qa-*` project over HTTPS with Caddy's internal CA:
  - only Caddy is published, on loopback;
  - HTTP redirects to HTTPS with the right port; the session cookie is `Secure`, `HttpOnly`, and `SameSite=Lax`;
  - security headers are present;
  - the inbox is readable at `/mail/` and refuses DELETE, PUT, and POST with 405, so messages stay;
  - the maintenance, failure, and retry lifecycle still passes, and a post-reset event reaches the public inbox.
- `systemd-analyze calendar` and `verify` for the units in a Linux container.
- `docker compose config` for the demo and development files. All existing checks pass; `pnpm typecheck`, `pnpm lint`, and `pnpm build`.

## Implementation results (2026-10-01)

- Implemented as specified. Runbook: [public-demo-runbook.md](features/public-demo-runbook.md); evidence: [demo reset verification](features/demo-reset-verification.md) (2026-10-01 results).
- **Docker demo lifecycle:** 6 of 6 on `pandora-demo-qa-public` over HTTPS with Caddy's internal CA:
  - only Caddy is published, with a 308 redirect that keeps the port, security headers, and a `Secure; HttpOnly; SameSite=Lax` cookie;
  - the read-only inbox at `/mail/` refuses DELETE, PUT, and POST;
  - the reset empties the inbox, and maintenance, failure, and retry still pass.
- **systemd:** `systemd-analyze calendar` gives the next runs at 01:00 UTC in summer and 02:00 UTC after the DST change, both 03:00 Europe/Belgrade. `systemd-analyze verify` reports only the missing `docker.service` inside the test container.
- `caddy validate` and `docker compose config` pass; the fulfillment browser group passes after the CDP option; `pnpm typecheck` and `pnpm lint` pass.
- **Found and fixed during verification:**
  - **Redirect:** Caddy's automatic HTTP→HTTPS redirect dropped the non-default port. There is now an explicit `redir` that keeps it.
  - **Inbox writes:** a top-level `respond` ran after `handle`, so DELETE reached Mailpit. The refusal now lives inside the `/mail*` handle.
  - **Stale emails:** the reset kept emails about removed orders. It now restarts Mailpit, whose temporary database is discarded.
- **Not done (needs the hosting decision):** a real domain, ACME certificate, server firewall, and running timer.

## Previous feature

[Notifications](features/notifications.md) merged as `1c08d9b` through PR #8; [verification](features/notifications-verification.md). Phases 1–3 are complete.

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
- Bug Lab (2026-09-30, Phase 2): exactly one `BUG_LAB_DEFECT` (`BUG-001` persisted wrong fulfillment status, `BUG-002` off-by-one page offset, `BUG-003` current prices on frozen lines), refused in production, on non-`pandora_buglab…` databases, or on a marker mismatch. Includes `pnpm bug-lab setup|start` with scenario fixtures and run manifests, and a catalog, briefs, and solutions in `bug-lab/`. `check:bug-lab` 7/7: the same assertion passes on Standard and fails for the intended reason for each defect; locally `check:all` 14/14; CI green on PR #3; see [features/bug-lab-verification.md](features/bug-lab-verification.md). Merged to `main` as `277925e`.
- Minimal UI polish (2026-10-01): original generated SVG cover art per product (deterministic from the product ID; five warm palettes, four motifs, expansion ribbon); catalog cards with depth and a hover/focus lift; product cover capped at 480 px; branded sign-in page. No selector, behavior, or API changes. `check:all` 14/14; manual checks at 390 and 360 px, keyboard focus, no page errors; CI green on PR #4. Merged to `main` as `bf6f472`.
- Line-level cancellation requests (2026-10-01, Phase 2): retailers choose which lines and how many unshipped units to cancel (optional `items`; omitted still means everything outstanding), with the new 409 `CANCELLATION_QUANTITY_EXCEEDED`; staff still approve or reject the whole request, and a partial approval keeps the order open. No migration or seed change; audit records `scope`. Fulfillment checks 14/14 API and 10/10 browser; `check:all` 14/14; CI green on PR #5. Merged to `main` as `37bb2d4`.
- Phase 2 operational completion (2026-10-01): read-only staff audit search/detail with role scope, exact filters and audit indexes; complete order/movement pagination and URL state, multi-page authorization acceptance. New checks: API 9/9, browser 7/7; local full `check:all` 16/16. Corrected existing administration browser synchronization and aligned draft concurrency coverage with the shared retry-exhaustion contract, while adding persisted-winner/audit/stale-retry assertions. All three CI jobs passed on PR #6, run `36825594931`. Merged to `main` as `5868e8e`; Phase 2 is complete. Next: Phase 3 returns, then durable notifications. See [verification](features/phase-2-operations-verification.md).
- Returns (2026-10-01, Phase 3 part 1): retailers request shipped units back with a reason; staff approve or reject the whole request and record one receipt that splits units into sellable and damaged stock (`RETURN` movements). Entitlement per shipment item is enforced in the transaction and by a database trigger (`RETURN_QUANTITY_EXCEEDED`), with the new `INVALID_RETURN_TRANSITION`; returns never change the order. Orders list filter for open returns, seed `RT-000001`, demo reset covers the new tables. `check:returns` 11/11, returns browser 8/8, `check:all` 18/18; CI green on PR #7. Merged to `main` as `e66fb6b`; see [verification](features/returns-verification.md).
- Notifications (2026-10-01, Phase 3 part 2): transactional outbox for nine business events (one job per active recipient, deduplicated), a separate worker that delivers to a captured Mailpit inbox under a lease with bounded retries, ambiguous-attempt recording, and graceful release; controlled failure adapter outside production; staff diagnostics with redaction for operators and an idempotent, audited manual retry; Mailpit for development, demo, and a separate Bug Lab inbox; demo reset stops/starts the worker. `check:notifications` 12/12, notifications browser 4/4, Docker demo lifecycle 5/5, `check:all` 20/20; CI green on PR #8. Merged to `main` as `1c08d9b`; see [verification](features/notifications-verification.md).
