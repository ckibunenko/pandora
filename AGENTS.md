# Pandora

Pandora is a B2B order and inventory management platform for a fictional board-game distributor, built to showcase Senior QA skills through a working application and automated tests.

## Context Files

Read the following to get the full context of the project:

- @context/project-overview.md
- @context/coding-standards.md
- @context/ai-interaction.md
- @context/current-feature.md


## Setup

Requires Node 24 (`.nvmrc`), pnpm via corepack (`corepack enable`; version pinned in `package.json`), and Docker for PostgreSQL.

1. `cp .env.example .env` (repository root; `.env` is never committed)
2. `pnpm install`
3. `docker compose up -d postgres`
4. `pnpm --filter @pandora/api db:migrate`
5. `pnpm --filter @pandora/api db:seed`

## Commands

Run from the repository root:

- `pnpm dev` — web (http://localhost:5173) and API (`API_PORT`, default 3000) in watch mode; Vite proxies `/api` to the API
- `pnpm build` — build every workspace package
- `pnpm typecheck` — strict TypeScript check of every package
- `pnpm lint` — ESLint (flat config, `eslint.config.mjs`)
- `pnpm --filter @pandora/api db:migrate` — create/apply migrations on the dev database (`prisma migrate dev`)
- `pnpm --filter @pandora/api db:deploy` — apply committed migrations only (`prisma migrate deploy`)
- `pnpm --filter @pandora/api db:reset` — drop and recreate the dev database; disposable databases only. Prisma refuses to run this for an AI agent without explicit user consent.
- `pnpm --filter @pandora/api db:seed` — idempotent deterministic seed; refuses to run unless `NODE_ENV` is `development` or `test`
- `pnpm --filter @pandora/api prisma <command>` — Prisma CLI (config: `apps/api/prisma.config.ts`, schema: `prisma/schema.prisma`)

OpenAPI (non-production only): http://localhost:3000/api/openapi.json, UI at http://localhost:3000/api/docs.

Focused feature checks exist, each against its own empty QA database (never the dev database):

- Catalog: `apps/api/checks/catalog.mjs` (HTTP + real PostgreSQL) and `apps/web/checks/catalog-browser.mjs` (Playwright/Chrome). See `context/features/catalog-verification.md`.
- Inventory: `apps/api/checks/inventory.mjs` (`pnpm --filter @pandora/api check:inventory`) and `apps/web/checks/inventory-browser.mjs`. See `context/features/inventory-verification.md`.
- Order drafts: `apps/api/checks/orders.mjs` (`pnpm --filter @pandora/api check:orders`) and `apps/web/checks/orders-browser.mjs`. See `context/features/order-drafts-verification.md`.
- Order processing: `apps/api/checks/order-processing.mjs` (`pnpm --filter @pandora/api check:processing`, built on the shared `apps/api/checks/harness.mjs`) and `apps/web/checks/order-processing-browser.mjs`. See `context/features/order-processing-verification.md`. Browser suites that change the same seed orders need separate fresh databases.
- Fulfillment: `apps/api/checks/fulfillment.mjs` (`pnpm --filter @pandora/api check:fulfillment`) and `apps/web/checks/fulfillment-browser.mjs`. See `context/features/fulfillment-verification.md`.
- Organization and user administration: `apps/api/checks/administration.mjs` (`pnpm --filter @pandora/api check:admin`) and `apps/web/checks/admin-browser.mjs`. See `context/features/admin-management-verification.md`.
- Bug Lab: `apps/api/checks/bug-lab.mjs` (`pnpm --filter @pandora/api check:bug-lab`); see `context/features/bug-lab-verification.md`.
- Sign-in rate limiting and session cleanup: `apps/api/checks/auth.mjs` (`pnpm --filter @pandora/api check:auth`) and `apps/web/checks/auth-browser.mjs`. See `context/features/auth-hardening-verification.md`.
- Browser checks drive local Chrome through `apps/web/checks/cdp.mjs` (DevTools protocol, no extra dependencies).

`pnpm check:all` (`scripts/check-all.mjs`) runs everything above in one go:
- It builds first, then runs every API suite on its own fresh database, then the CDP browser suites.
- Each browser group gets a fresh seeded database, a QA API on 3013, and a shared web server on 5175.
- Options: `--api`, `--browser`, `--only <name>`, `--skip-build`, `--evidence <dir>`.
- It refuses to start if 3013 or 5175 is in use.
- A suite that runs longer than `CHECK_SUITE_TIMEOUT_SECONDS` (default 300) is killed with its child processes and counted as failed.
- It creates databases on the `DATABASE_URL` server and never drops them.
- Not run: `catalog-browser.mjs` (external Playwright) and `demo-reset-browser.mjs` (Docker demo stack).

CI (`.github/workflows/ci.yml`) runs three jobs on pushes to `main`, pull requests, and manual runs:
- typecheck, lint, and build;
- `check:all --api` against a PostgreSQL 18.6 service;
- `check:all --browser` with the runner's Chrome (`--no-sandbox` only when `CI=true`).

CI uses CI-only credentials and no repository secrets. There is no unit-test framework yet.

## Isolated demo

- `compose.demo.yml` and `.env.demo.example` define a separate local demo; only the web port (5180 by default) is published on loopback. Development still uses `docker-compose.yml` and `.env`.
- `pnpm demo:build` builds API/web images; `pnpm demo:reset` is destructive **only to the dedicated demo**. It persists maintenance, stops the API, deploys migrations, atomically restores fixtures/session/idempotency state, waits for readiness, then reopens. Failure stays in maintenance.
- Shared fixtures live in `apps/api/src/seed/seed-data.ts`; normal `db:seed` remains development/test-only. `restore-demo-data.ts` is an operator-only transaction, not an API operation.
- Verification: `DEMO_CHECK_DATABASE=pandora_demo_check_<unique> pnpm --filter @pandora/api check:demo-reset` on an empty QA database; `apps/web/checks/demo-reset-browser.mjs` on a disposable `pandora-demo-qa-*` Compose project. See [runbook and evidence](context/features/demo-reset-verification.md).
- No scheduler/public deployment is installed. Future workers must join the reset stop/start lifecycle; new tables need explicit reset review.

## Bug Lab

Isolated defect environment (overview §9); learner-facing docs are in [bug-lab/](bug-lab/README.md).

- **Setup and start:**
  - `pnpm bug-lab setup --defect BUG-001|BUG-002|BUG-003|none` creates `pandora_buglab_<defect>_<run>`, migrates, seeds, and adds scenario fixtures (40 extra Tabletop Lantern drafts, `PO-000101`–`PO-000140`).
  - It then sets the database marker `pandora.defect` and writes a run manifest to `bug-lab/runs/` (gitignored).
  - `pnpm bug-lab start --run <id>` serves it on 5176 (API 3020).
- **Selection:** the API reads `BUG_LAB_DEFECT` and accepts exactly one known ID. It refuses to start when:
  - `NODE_ENV=production`;
  - the database is not named `pandora_buglab…`;
  - the database marker and `BUG_LAB_DEFECT` differ in either direction (`BugLab.onModuleInit`).
- **Code:** each defect is one `bugLab.has("BUG-00X")` guard in `OrdersService` (ship status, list offset, frozen line prices). Never add defect logic anywhere else, and never change Standard behavior to make a defect pass.
- **Database:** migration `20260930200000_bug_lab_marker` lets the status trigger accept exactly the `BUG-001` state (`PARTIALLY_SHIPPED` where `SHIPPED` is derived), and only in a database marked `BUG-001`.
- **Verification:** `pnpm --filter @pandora/api check:bug-lab` (in `check:all`, which passes it a run ID) prepares its own Standard and defect databases.

## Demo accounts

All seeded accounts use the password from `SEED_USER_PASSWORD` in `.env`.

| Email | Role | Organization |
|---|---|---|
| `admin@pandora.test` | administrator | Pandora Distribution |
| `operator@pandora.test` | operator | Pandora Distribution |
| `retailer@tabletop-lantern.test` | retailer | Tabletop Lantern |
| `retailer@cardboard-keep.test` | retailer | Cardboard Keep |
| `former@tabletop-lantern.test` | retailer, inactive user | Tabletop Lantern |
| `retailer@closed-shelf.test` | retailer | Closed Shelf Games (inactive organization) |

## Architecture

pnpm workspace monorepo following the target in `context/coding-standards.md`:

- `apps/web` — React + Vite, React Router, TanStack Query, CSS Modules; design tokens in `src/styles/global.css`. All HTTP goes through `src/lib/api-client.ts`, which parses responses with contract schemas, turns error envelopes into `ApiError`, and adds the CSRF header (token kept in memory only). Protected routes are nested under `RequireAuth` (`src/features/auth/`).
- `apps/api` — NestJS (ESM) with global prefix `/api`. Startup config is validated with Zod in `src/common/config/app-config.ts` and the process exits if it is invalid. `PrismaService` (`src/infrastructure/prisma`) is the single Prisma client, using the `pg` driver adapter. Feature modules live in `src/modules/`.
  - Cross-cutting pieces in `src/common/`: `ApiExceptionFilter` turns every error into the `{ code, message, correlation_id, details? }` envelope (throw `ApiException` for business errors); `ZodValidationPipe` validates input against contract schemas (422 with field details); `correlationIdMiddleware` sets `X-Correlation-Id`; inject `Clock` instead of calling `new Date()`; `openApiSchema()` documents endpoints from the same Zod schemas.
  - Catalog (`src/modules/catalog/`): authenticated browse reads, administrator-only mutations, immutable SKU/product identity, and transactional `AuditEvent` writes. `CATALOG_CURRENCY=EUR` is required config. Catalog UI lives in `apps/web/src/features/catalog/`.
  - Inventory (`src/modules/inventory/`): one `InventoryItem` per variant (created by a DB trigger), append-only `InventoryMovement`s, receipts and adjustments for operators and administrators. Catalog variants expose `availableQuantity`.
  - Orders (`src/modules/orders/`): drafts (retailer-editable, version-checked), submission with price review and frozen line snapshots, retailer cancellation, staff confirmation (all-or-nothing `StockReservation` per line, reservation movements) or rejection with a reason, and fulfillment: immutable shipments that consume reservations and stock, and retailer cancellation requests for all remaining quantities that staff approve (releasing reservations) or reject. After confirmation the order status is derived from line totals (`deriveFulfillmentStatus`) and a database trigger verifies it. Every query is scoped to the retailer's organization (another organization's order returns 404); staff read all orders. Database triggers keep submitted lines and totals immutable. Order UI lives in `apps/web/src/features/orders/`; operators land on the processing queue.
  - Administration (`src/modules/administration/`): administrator-only management of retailer organizations and users (create, edit, activate/deactivate, staff role changes, password reset). Deactivation, role changes, and password resets revoke sessions in the same transaction (`revokeSessions` in `auth/sessions.service.ts`). The distributor cannot be deactivated. The last active administrator is protected by a Serializable check and a deferred database constraint trigger. Admin UI lives in `apps/web/src/features/admin/`.
  - `runSerializable` also retries serialization failures that PostgreSQL reports only at `COMMIT`. The pg adapter surfaces those as a raw `DriverAdapterError` (`TransactionWriteConflict`) rather than `P2034`.
  - Enum values: add new values in their own migration before any constraint uses them (PostgreSQL cannot use a new enum value in the transaction that adds it). Name migrations so they sort after existing ones.
  - Consequential mutations (stock changes, order create/submit/cancel) follow one pattern — reuse it for confirmations, reservations, shipments, and returns:
    - Wrap the operation in `IdempotencyService.execute` (`src/common/idempotency/`) and read the key with `@IdempotencyKey()`.
    - It runs the work inside `runSerializable` (`src/infrastructure/prisma/serializable.ts`: Serializable isolation, whole-transaction retry up to 3 attempts, then 409 `CONCURRENT_MODIFICATION`).
    - Inside the work: reread state → validate → update → movement → `recordAudit` (`src/common/audit/audit.ts`), all in the same transaction.
    - The work may run more than once, so it must not perform external side effects.
  - Auth (`src/modules/auth/`): global guards run in order session → CSRF → roles. Every route requires a session unless marked `@Public()`; restrict by role with `@Roles(...)`; read the caller with `@CurrentAuth()`. Unsafe methods need the `X-CSRF-Token` header from the session response.
    - Sign-in is limited to 5 attempts per normalized email per 15 minutes (`LoginRateLimiter`), with 429 `TOO_MANY_LOGIN_ATTEMPTS` and `Retry-After`. Unknown emails are handled identically. Attempts are stored only as SHA-256 digests in `login_attempts`, and a per-email advisory lock covers only the count-and-record step.
    - `SessionCleanupService` removes sessions that have been unusable for more than 24 hours, and attempts older than the window. It runs at startup and every `SESSION_CLEANUP_INTERVAL_SECONDS` (optional, default 3600).
- `packages/contracts` — Zod schemas and types shared by web and API. Build it before typechecking dependents (root scripts do this).
- `prisma/` — schema and migrations. The Prisma 7 client is generated into `apps/api/src/generated/prisma` (gitignored) by `prisma generate`, which the API's `dev`/`build`/`typecheck` scripts run automatically.
- `docker-compose.yml` — local PostgreSQL only.
