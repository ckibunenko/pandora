## Current Feature

Test and CI setup. One command runs every application check on fresh, disposable databases, and GitHub Actions runs it for every push to `main` and every pull request (overview §10–§11, coding standards §9).

## Status

Completed — merged to `main` as `d0bb179` (2026-09-30) through PR #1; the GitHub Actions run passed.

## Goal

A regression cannot reach `main` unnoticed: gates, API/PostgreSQL checks, and browser checks run automatically against real PostgreSQL. The same command runs locally, so nobody has to create QA databases by hand.

## Scope and decisions (2026-09-30)

- Branch: `feature/ci`.
- **Ownership (overview §11 open decision):**
  - Application verification and CI live in this repository.
  - The companion QA repository keeps portfolio E2E automation, exploratory records, and release evidence.
  - Recommended by Claude; the user said "kreni" without choosing otherwise.
- **`pnpm check:all` (`scripts/check-all.mjs`):**
  - `--api`, `--browser`, or both by default; `--skip-build` when the build has already run.
  - Each API suite gets a fresh database named for its check pattern plus a run id.
  - Each browser group gets a fresh database, migrated and seeded, and its own QA API on 3013. One web server on 5175 proxies to it.
  - Suites that change the same seed orders are in separate groups.
  - Suites run one after another, because concurrency checks must not compete for CPU with other suites.
  - Databases are created through the configured `DATABASE_URL` server, never on the development database. Names are validated before use.
  - The script prints each database used. They are kept as evidence, and the script never drops databases.
  - Screenshots go to one evidence directory (`--evidence`, default under the system temp directory).
- **Excluded from the runner, with the reason printed:**
  - `catalog-browser.mjs`: it needs an external Playwright install, which is not a dependency.
  - `demo-reset-browser.mjs`: it needs the Docker demo stack.
  - Their API/PostgreSQL counterparts (`catalog`, `demo-reset`) run.
- **GitHub Actions (`.github/workflows/ci.yml`):**
  - Triggers: pushes to `main`, pull requests, and manual runs. Read-only permissions; concurrent runs of the same ref are cancelled.
  - Jobs:
    - `gates`: install with the frozen lockfile, then typecheck, lint, and build.
    - `api-checks`: PostgreSQL 18.6 service, all API suites.
    - `browser-checks`: PostgreSQL service, the installed Chrome, all CDP browser suites.
  - Node comes from `.nvmrc`; pnpm comes from `packageManager`.
  - Screenshots are uploaded when the browser job fails.
  - CI uses CI-only values (`SEED_USER_PASSWORD` and database credentials) that exist only in the disposable service container. There are no repository secrets.
- **Chrome in CI:** GitHub's Ubuntu runners restrict the Chrome sandbox, so `cdp.mjs` adds `--no-sandbox` only when `CI=true`.
- **Out of scope:**
  - a unit-test framework (no dependency added now; pure logic stays covered through the API checks);
  - porting the Playwright catalog browser check;
  - running the Docker demo stack in CI;
  - branch protection rules (GitHub settings, the user's decision).

## Verification

- `pnpm check:all` passes locally from a clean state (API and browser).
- A deliberately failing suite makes the runner exit non-zero and names the suite.
- A busy QA port, and invalid or development-database targets, are refused.
- The workflow runs on GitHub after the branch is pushed, with all three jobs green.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass.

## Implementation results (2026-09-30)

- Evidence and details: [features/ci-verification.md](features/ci-verification.md).
- `pnpm check:all` passes locally with 11 of 11 suites (7 API, 4 browser groups) in about 55 seconds.
- The failure paths exit 1: a busy port, a broken Chrome, and no suite selected.
- The first run exposed a leftover QA web server listening on IPv6 only, which the port check had missed. The check now covers IPv4 and IPv6.
- On GitHub Actions (run `36763707451`, PR #1), all three jobs pass and all 11 suites pass, in about 1.5 minutes.

## Previous feature

[Isolated demo reset](features/demo-reset.md) is merged as `ada25a1`; [verification](features/demo-reset-verification.md). Earlier: [organization and user administration](features/admin-management.md), [fulfillment](features/fulfillment.md), [order processing](features/order-processing.md), [order drafts](features/order-drafts.md), [inventory](features/inventory.md), [catalog](features/catalog.md), [auth and sessions](features/auth-sessions.md). Still outstanding: login rate limiting, session cleanup, audit foreign keys, shared UI primitives, and scheduling/hosting for the demo reset.

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
