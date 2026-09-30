# Pandora

Pandora is a B2B order and inventory management sandbox for a fictional board-game distributor that sells to retail stores. It is a portfolio project that demonstrates Senior QA work through a working application, explicit business rules, automated tests, and reproducible defects.

It is not a real commerce service: there are no real payments, no real customer data, and no AI features. All games, publishers, and artwork are fictional.

## Status

Built so far:

- Architecture: web app, API, shared contracts, and PostgreSQL database.
- Sign-in with server-side sessions for retailers, distributor operators, and administrators, using seeded demo accounts.
- Catalog browsing, language/edition variants, EUR prices, administrator management, and transactional catalog audit. The seed includes eight fictional products and eleven variants.
- Inventory per SKU (sellable, reserved, damaged) with stock receipts and adjustments by distributor staff. Every change is an immutable movement with audit. Changes are safe to retry thanks to `Idempotency-Key`, and they don't oversell under concurrency. Retailers see each variant's available quantity in the catalog.

- Order drafts and submission for retailers. Drafts are shared within the retailer organization and protected against concurrent edits. Prices are checked on submission and then frozen, and orders can be cancelled before confirmation.

- Order processing for distributor staff. Staff confirm submitted orders, which reserves stock for every line at once and never oversells, or reject them with a reason. Operators start from the queue of orders awaiting processing.
- Fulfillment: full and partial shipments that consume reserved stock, and cancellation of remaining quantities through retailer requests that staff approve or reject. The order status follows the shipped and cancelled quantities, so every order can move from draft to a final state.

Returns, notifications, and the Bug Lab have not been built yet. The product scope and business rules are in [context/project-overview.md](context/project-overview.md).

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

## API

- OpenAPI document: http://localhost:3000/api/openapi.json (interactive docs at `/api/docs`; not served in production).
- Errors share one shape: `{ code, message, correlation_id, details? }`. Every response carries an `X-Correlation-Id` header that matches `correlation_id`.
- `GET /api/health` returns 200 while the API process is running. `GET /api/health/ready` returns 200 when the database is reachable and 503 when it is not.

## Catalog verification

Run `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Focused catalog integration checks use a separate empty PostgreSQL database; the browser harness uses that QA API and an externally installed Playwright/Chrome. Reproduction commands, selector contracts, and results are in [context/features/catalog-verification.md](context/features/catalog-verification.md).
