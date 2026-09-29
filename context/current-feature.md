## Current Feature

Architecture setup — replace the Next.js + Tailwind starter with the target pnpm monorepo skeleton (React/Vite web, NestJS API, shared contracts, Prisma/PostgreSQL), wired end to end through a health check. No business features.

## Status 

Completed

## Goals

- Remove the Next.js starter (`src/`, `public/`, Next/Tailwind config and deps, `package-lock.json`).
- Root pnpm workspace: pinned `packageManager`, strict `tsconfig.base.json`, ESLint flat config (`no-explicit-any` as error), `.nvmrc`, `.env.example`, `docker-compose.yml` with Postgres only.
- `packages/contracts`: Zod health response schema shared by web and API.
- `apps/api` (NestJS): Zod-validated startup config (`DATABASE_URL`, `PORT`), single `PrismaService`, `GET /health` and `GET /health/ready` (503 when the DB is unreachable).
- `prisma/schema.prisma`: PostgreSQL datasource and generator, no models.
- `apps/web` (Vite + React): React Router, TanStack Query, typed API client that parses responses with contract schemas, global design tokens, CSS Modules, home page with `<h1>Pandora</h1>` and API status.
- Update `AGENTS.md` commands/architecture and the stale baseline notes in `project-overview.md`.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` pass; health endpoints verified against Postgres.

## Notes

- Decisions (2026-09-29): follow the documented target architecture; use pnpm workspaces.
- Deferred on purpose: error envelope, correlation IDs, sessions, OpenAPI (arrive with the first Phase 1 endpoints); Mailpit and notification worker (Phase 3).
- Docker is required for Postgres and was not installed at the start of this task.
- Branch: `feature/architecture-setup`.
- Pinned versions: pnpm 12.8.1, TypeScript 6.0.3 (typescript-eslint does not support TS 7 yet), NestJS 12.1.1 (ESM), Prisma 7.10.0 (8.0 is still RC), Vite 8.3.1, React 19.3.0, React Router 8.4.0, Zod 4.6.5, Postgres 18.6.
- Health endpoints are served under the `/api` prefix: `GET /api/health`, `GET /api/health/ready`. The `/api` prefix and the `API_PORT` variable name were accepted by the user (2026-09-29).
- `README.md` rewritten for the new stack (replaces the create-next-app template).
- Verified: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass; API exits with a clear message when config is missing and does not print the DB URL; without a database `/api/health` returns 200 and `/api/health/ready` returns 503 while the API keeps running; `pnpm dev` in headless Chrome shows "Pandora" and "API running, database unavailable" through the Vite proxy.
- Not yet verified (needs Docker): `/api/health/ready` returning 200 against a running Postgres.

## History

// Keep this updated earliest to latest

- Initial Next.js setup: bootstrapped project with `create-next-app` (Next.js 16, React 19, TypeScript, Tailwind CSS v4), stripped the boilerplate from `page.tsx` down to a single `<h1>Pandora</h1>`, cleared `globals.css` to just the Tailwind import, removed the default `public/*.svg` assets, and added the `context/` docs referenced from `AGENTS.md`. Committed as "initial setup" and pushed to `origin/main`.
- Architecture setup (2026-09-29): replaced the Next.js starter with a pnpm monorepo skeleton (`apps/web` React/Vite, `apps/api` NestJS, `packages/contracts`, `prisma/`, Docker Compose Postgres) connected through `/api/health` and `/api/health/ready`; rewrote `README.md` and updated `AGENTS.md` and `project-overview.md`. Merged to `main` as `fd36011`. Readiness against a running Postgres is still unverified because Docker was not installed.