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

## Commands

Run from the repository root:

- `pnpm dev` — web (http://localhost:5173) and API (`API_PORT`, default 3000) in watch mode; Vite proxies `/api` to the API
- `pnpm build` — build every workspace package
- `pnpm typecheck` — strict TypeScript check of every package
- `pnpm lint` — ESLint (flat config, `eslint.config.mjs`)
- `pnpm --filter @pandora/api prisma <command>` — Prisma CLI (config: `apps/api/prisma.config.ts`, schema: `prisma/schema.prisma`)

There is no test suite yet.

## Architecture

pnpm workspace monorepo following the target in `context/coding-standards.md`:

- `apps/web` — React + Vite, React Router, TanStack Query, CSS Modules; design tokens in `src/styles/global.css`. All HTTP goes through `src/lib/api-client.ts`, which parses responses with contract schemas.
- `apps/api` — NestJS (ESM) with global prefix `/api`. Startup config is validated with Zod in `src/common/config/app-config.ts` and the process exits if it is invalid. `PrismaService` (`src/infrastructure/prisma`) is the single Prisma client, using the `pg` driver adapter. Feature modules live in `src/modules/`.
- `packages/contracts` — Zod schemas and types shared by web and API. Build it before typechecking dependents (root scripts do this).
- `prisma/` — schema and migrations. The Prisma 7 client is generated into `apps/api/src/generated/prisma` (gitignored) by `prisma generate`, which the API's `dev`/`build`/`typecheck` scripts run automatically.
- `docker-compose.yml` — local PostgreSQL only.
