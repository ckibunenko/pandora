# Pandora

Pandora is a B2B order and inventory management sandbox for a fictional board-game distributor that sells to retail stores. It is a portfolio project that demonstrates Senior QA work through a working application, explicit business rules, automated tests, and reproducible defects.

It is not a real commerce service: there are no real payments, no real customer data, and no AI features. All games, publishers, and artwork are fictional.

## Status

The architecture skeleton is in place: web app, API, shared contracts, and database, connected end to end through a health check. Business features (catalog, inventory, orders, fulfillment) have not been built yet.

The product scope and business rules are in [context/project-overview.md](context/project-overview.md).

## Stack

| Layer | Technology |
|---|---|
| Web | React, TypeScript, Vite, React Router, TanStack Query, CSS Modules |
| API | NestJS, Zod |
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
pnpm dev
```

Open http://localhost:5173. The page shows whether the API and database are reachable. The API listens on `API_PORT` (3000 by default).

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Start web and API in watch mode |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Lint the repository |

Health endpoints:

- `GET /api/health`: 200 while the API process is running
- `GET /api/health/ready`: 200 when the database is reachable, 503 when it is not
