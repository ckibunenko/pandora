# Pandora

Pandora is a B2B order and inventory management sandbox for a fictional board-game distributor that sells to retail stores. It is a portfolio project that demonstrates Senior QA work through a working application, explicit business rules, automated tests, and reproducible defects.

It is not a real commerce service: there are no real payments, no real customer data, and no AI features. All games, publishers, and artwork are fictional.

## Status

Built so far:

- Architecture: web app, API, shared contracts, and PostgreSQL database.
- Sign-in with server-side sessions for retailers, distributor operators, and administrators, using seeded demo accounts. Repeated failed sign-ins for the same email are paused for 15 minutes, and old sessions are cleaned up automatically.
- Catalog browsing, language/edition variants, EUR prices, administrator management, and transactional catalog audit. The seed includes eight fictional products and eleven variants.
- Inventory per SKU (sellable, reserved, damaged) with stock receipts and adjustments by distributor staff. Every change is an immutable movement with audit. Changes are safe to retry thanks to `Idempotency-Key`, and they don't oversell under concurrency. Retailers see each variant's available quantity in the catalog.

- Order drafts and submission for retailers. Drafts are shared within the retailer organization and protected against concurrent edits. Prices are checked on submission and then frozen, and orders can be cancelled before confirmation.

- Order processing for distributor staff. Staff confirm submitted orders, which reserves stock for every line at once and never oversells, or reject them with a reason. Operators start from the queue of orders awaiting processing.
- Fulfillment: full and partial shipments that consume reserved stock, and cancellation of remaining quantities through retailer requests that staff approve or reject. The order status follows the shipped and cancelled quantities, so every order can move from draft to a final state.
- Organization and user administration for administrators. Administrators create retailer stores and accounts, change staff roles, deactivate access, and reset passwords. These changes sign affected users out immediately, and the last administrator cannot be removed.
- **Bug Lab** for QA practice: an isolated local environment where exactly one known defect (`BUG-001`–`BUG-003`) is switched on. It comes with a defect catalog, learner briefs, separate solutions, and run manifests; see [bug-lab/README.md](bug-lab/README.md). The same automated assertion passes in Standard mode and fails in the Bug Lab.

- **Audit trail**: staff search committed changes by entity, action, actor, acting organization, correlation ID and UTC time range, and inspect read-only before/after values. Administrators see all business audit; operators see orders and inventory only.
- Operational lists have 20/50/100 page controls; Orders and Movement history now preserve their pagination in the URL.

- **Returns**: retailers send shipped units back; staff approve or reject the request and inspect the receipt into sellable or damaged stock.
- **Notifications**: business events queue emails in a transactional outbox; a separate worker (`pnpm --filter @pandora/api worker`) delivers them to a captured Mailpit inbox (`docker compose up -d mailpit`, http://localhost:8025) with leases, bounded retries, and staff diagnostics.

The product scope and business rules are in [context/project-overview.md](context/project-overview.md).

An isolated local demo can be built and restored with `pnpm demo:build` and `pnpm demo:reset` after creating `.env.demo` from `.env.demo.example`. Reset discards demo changes, signs everyone out, and restores the fixtures behind a maintenance page. Its database is separate from development. Setup, recovery, and verification: [demo reset runbook](context/features/demo-reset-verification.md).

## Stack

| Layer | Technology |
|---|---|
| Web | React, TypeScript, Vite, React Router, TanStack Query, CSS Modules |
| API | NestJS, Zod, OpenAPI |
| Database | PostgreSQL, Prisma |
| Tooling | pnpm workspaces, ESLint, Docker Compose |

```text
apps/web            React frontend
apps/api            NestJS API (served under /api)
packages/contracts  Schemas shared by web and API
prisma/             Database schema and migrations
```

## Getting started

Requirements: Node 24, Docker, and pnpm (enable it with `corepack enable`).

```bash
cp .env.example .env
pnpm install
docker compose up -d postgres
pnpm --filter @pandora/api db:migrate
pnpm --filter @pandora/api db:seed
pnpm dev
```

Existing installations must add `CATALOG_CURRENCY=EUR` to `.env`, apply the catalog migration with `pnpm --filter @pandora/api db:deploy`, and rerun the seed.

Open http://localhost:5173 and sign in with a demo account. Every account uses the password set in `SEED_USER_PASSWORD` in your `.env`.

| Email | Role |
|---|---|
| `admin@pandora.test` | Administrator |
| `operator@pandora.test` | Distributor operator |
| `retailer@tabletop-lantern.test` | Retailer (Tabletop Lantern) |
| `retailer@cardboard-keep.test` | Retailer (Cardboard Keep) |

Two more accounts exist for negative testing and cannot sign in: `former@tabletop-lantern.test` is an inactive user, and `retailer@closed-shelf.test` belongs to an inactive organization.

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Start web and API in watch mode |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Lint the repository |
| `pnpm --filter @pandora/api db:migrate` | Apply migrations to the development database |
| `pnpm --filter @pandora/api db:seed` | Load the demo data (safe to run repeatedly) |
| `pnpm check:all` | Build, then run every API/PostgreSQL and browser check, each on its own fresh QA database (needs PostgreSQL and Chrome) |

## Continuous integration

GitHub Actions runs on every push to `main` and on every pull request. It has three jobs:

- typecheck, lint, and build;
- all API/PostgreSQL checks against a real PostgreSQL service;
- all browser checks in headless Chrome.

Locally, `pnpm check:all` runs the same checks and prints a pass/fail summary with the databases it used.

## API

- OpenAPI document: http://localhost:3000/api/openapi.json (interactive docs at `/api/docs`; not served in production).
- Errors share one shape: `{ code, message, correlation_id, details? }`. Every response carries an `X-Correlation-Id` header that matches `correlation_id`.
- `GET /api/health` returns 200 while the API process is running. `GET /api/health/ready` returns 200 when the database is reachable and 503 when it is not.

## Catalog verification

Run `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Focused catalog integration checks use a separate empty PostgreSQL database; the browser harness uses that QA API and an externally installed Playwright/Chrome. Reproduction commands, selector contracts, and results are in [context/features/catalog-verification.md](context/features/catalog-verification.md).
