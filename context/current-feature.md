## Current Feature

Safe demo reset tooling for an isolated Docker Compose stack.

## Status

Implemented and verified on `feature/demo-reset`; commit and push approved, ready for merge. Administration was merged to `main` as `17d5ef5`.

## Goal

Restore the fictional demo to its deterministic seed without touching the development database, admitting mutations during reset, or reopening the demo after a failed restoration.

## Scope and decisions (2026-09-30)

- A separate Compose file/project runs PostgreSQL, the API, and a web/reverse-proxy container. Only the web port is published, on loopback by default. Database volumes and networks are separate from development.
- An operator CLI owns reset; no business role, browser page, or API endpoint can invoke it.
- Lifecycle: acquire an exclusive operator lock → start database/proxy if needed → persist a maintenance marker → stop API and wait for exit → migrate → atomically truncate business/session/idempotency data and restore seed → start API and wait for readiness → clear maintenance.
- The reverse proxy serves a maintenance page and returns 503 `MAINTENANCE` for API calls while the marker exists. Its volume survives container restarts.
- Stopping the API drains or terminates all its work before restoration. No worker exists yet; any future worker must be included in the stop/start lifecycle before deployment.
- The reset command is restricted to the dedicated `pandora_demo` database in the demo stack. Tests use explicitly named disposable QA databases. It refuses other database names and other connected database clients.
- Truncation, seed, sequence restart, and verification share one transaction. It never calls `prisma migrate reset`, drops a database, disables constraints, or resets development data.
- Old sessions and idempotency receipts disappear. Both business-number sequences return to 1001; fixed seed records keep their reserved low numbers.
- Failure leaves maintenance active and API stopped. A successful retry is the recovery path; no automatic unlock after a killed operator process.
- No hosting or scheduler is selected. Document the intended daily 03:00 Europe/Belgrade schedule and operator recovery; actual scheduled deployment remains pending.

## Verification

- Build/typecheck/lint and diff checks.
- Disposable PostgreSQL: seed restoration after real changes; session/idempotency removal; sequence restart; repeat reset; rejected wrong target; other-client refusal; transaction rollback on restore failure.
- Isolated demo stack: API inaccessible directly, maintenance 503 at the public entry point, exclusive concurrent reset, API stopped before data changes, failed reset stays closed, successful recovery and login.
- Browser: maintenance presentation and sign-in/catalog after restoration.
- Existing administration and fulfillment API regression checks on fresh QA databases because the normal seed is extracted for reuse.

## Implementation results (2026-09-30)

- Added the isolated Compose stack, operator reset CLI, transactional restoration, and a maintenance page/API envelope. Extracted the existing fixtures for reuse without changing normal seed behavior.
- Database checks: 6/6. Docker lifecycle/browser checks: 5/5, including deliberately failed restoration and recovery. Administration regression: 12/12; fulfillment regression: 11/11.
- Both Docker images, typecheck, lint, build, and diff checks passed; the existing Vite chunk-size warning remains.
- [Runbook, reproduction commands, results, and limitations](features/demo-reset-verification.md).
- Actual public hosting and the daily scheduler remain unconfigured. Next planned work: test/CI setup, login rate limiting, and expired-session cleanup.

## Previous feature

[Organization and user administration](features/admin-management.md) is merged as `17d5ef5`; [verification](features/admin-management-verification.md).

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

- Isolated demo reset (2026-09-30): dedicated Compose stack, persistent maintenance, stopped API writers, atomic fixture/session/idempotency restoration, readiness-gated reopening, and fail-closed recovery. Verified with 6 database and 5 lifecycle/browser groups plus administration/fulfillment regressions; completed on `feature/demo-reset`; commit and push approved, ready for merge.
