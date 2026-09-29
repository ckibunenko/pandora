## Current Feature

Authentication and sessions — organizations, users, and server-side sessions with login/logout, role checks, and CSRF protection, plus the API foundations every later endpoint relies on (error envelope, correlation IDs, Zod validation, OpenAPI). Seeded demo accounts for all three roles.

## Status 

In Progress

## Goals

- Postgres running locally via OrbStack + Docker Compose; `/api/health/ready` returns 200.
- Contracts: error envelope, user role and organization type, login request, session response.
- API foundations: correlation ID middleware, global exception filter (envelope with stable codes), `ZodValidationPipe` (422 with field details), injectable clock, JSON logs, OpenAPI at `/api/openapi.json` and `/api/docs` (non-production).
- First migration: `Organization` (single distributor enforced), `User`, `Session` (only token hashes stored).
- `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`; 30 min idle / 8 h absolute expiry; inactive user or organization cannot log in or use a session; argon2id passwords.
- Global session guard (default deny), `RolesGuard` (403), `CsrfGuard` on unsafe methods (403).
- Deterministic seed: distributor admin and operator, two retailer organizations, one inactive user; password from `SEED_USER_PASSWORD`.
- Web: login page, protected home with current user and logout, session-aware API client with CSRF header, `data-test` selectors.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` pass; curl and browser checks from the plan pass.

## Notes

- Decisions (2026-09-30): auth and sessions is the next feature; Claude installs OrbStack via Homebrew.
- Out of scope: admin organization/user management, deactivation and password-reset endpoints, audit log, role landing pages, automated tests.
- `nestjs-zod` does not support NestJS 12, so validation uses a small in-repo pipe.
- Branch: `feature/auth-sessions`.
- Deviations from the plan:
  - The CSRF token is stored in plain text (`sessions.csrf_token`), not hashed, because `GET /api/auth/session` must return it. It is useless without the session cookie, whose token is still stored only as a SHA-256 hash.
  - IDs use Postgres 18's `uuidv7()` as the column default, so the database generates them. This also covers inserts made outside Prisma.
  - `NODE_ENV` is now required config: it controls whether OpenAPI is served and blocks seeding in production.
  - Framework 400 errors return a fixed message, because body-parser messages quote the raw request body, which could include a password.
  - The `@scarf/scarf` install script (telemetry pulled in by `swagger-ui-dist`) is explicitly denied in `pnpm-workspace.yaml`.
- Local database: OrbStack installed via Homebrew; the dev DB was reset once with the user's consent (Prisma requires it for AI agents).
- Verified with curl (manual script):
  - `/api/health/ready` returns 200 against Postgres.
  - Login works, with `HttpOnly; SameSite=Lax` cookie and case-insensitive email.
  - Wrong password, unknown email, inactive user, and inactive organization all return the same 401 `INVALID_CREDENTIALS`.
  - Malformed JSON and form-encoded bodies return 400. Invalid email and unknown field return 422 with the field name.
  - Session endpoint: 200 with a cookie; 401 without one or with a forged cookie.
  - Logout returns 403 without or with a wrong CSRF header, 204 with the correct one, then the session returns 401.
  - Idle over 30 minutes and past absolute expiry both return 401. Deactivating a user invalidates their live session immediately.
  - A valid `X-Correlation-Id` is echoed, an invalid one is replaced, and an unknown route returns 404 `NOT_FOUND`.
- Verified in the database: only a single distributor is allowed and emails must be lowercase (both enforced by the DB). Session token hashes are SHA-256 hex. Password hashes are argon2id. The seed is idempotent (ran twice, same data).
- Verified in headless Chrome (18 checks, 4 consecutive runs):
  - Signing out, or visiting `/` while signed out, redirects to `/login`.
  - Tab order is email → password → submit, with a visible focus outline.
  - A wrong password shows a generic error.
  - Admin, operator, and retailer can each sign in, see their role and organization, keep the session across a reload, and sign out.
- Logs are JSON, and no passwords, tokens, cookies, or hashes appear in them.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- Not run: `db:reset` followed by `db:seed` (a second reset would need another consent). A fresh migration followed by a seed was verified once.
- Known limitations (accepted for now):
  - There is no login rate limiting or lockout; this is needed before a public demo exists.
  - Expired and revoked session rows are never cleaned up.
  - There are no automated tests yet.
  - `.env.example` holds the development demo password, so the public demo must set its own `SEED_USER_PASSWORD`.

## History

// Keep this updated earliest to latest

- Initial Next.js setup: bootstrapped project with `create-next-app` (Next.js 16, React 19, TypeScript, Tailwind CSS v4), stripped the boilerplate from `page.tsx` down to a single `<h1>Pandora</h1>`, cleared `globals.css` to just the Tailwind import, removed the default `public/*.svg` assets, and added the `context/` docs referenced from `AGENTS.md`. Committed as "initial setup" and pushed to `origin/main`.
- Architecture setup (2026-09-29): replaced the Next.js starter with a pnpm monorepo skeleton (`apps/web` React/Vite, `apps/api` NestJS, `packages/contracts`, `prisma/`, Docker Compose Postgres) connected through `/api/health` and `/api/health/ready`; rewrote `README.md` and updated `AGENTS.md` and `project-overview.md`. Merged to `main` as `fd36011`. Readiness against a running Postgres is still unverified because Docker was not installed.