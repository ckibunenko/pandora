# Demo reset: operator runbook and verification

## Implemented scope

`compose.demo.yml` defines a disposable, local Standard-mode demo. It has its own PostgreSQL volume/network, a production-built API, and a static web/reverse proxy. Only `127.0.0.1:5180` is published by default; neither the API nor PostgreSQL has a host port. Development continues to use `docker-compose.yml` and `.env` unchanged.

The CLI is operator tooling, not an application endpoint. Business administrators cannot invoke it. It deletes demo changes, sessions, and idempotency receipts and restores the existing fixture set: four organizations, six users, eight products, eleven variants, and nine orders, including a shipment and a pending cancellation request. New order/shipment numbers restart at 1001.

## Start or restore the local demo

Requires Node 24, the repository's pinned pnpm, and Docker Compose with `up --wait` support. Run from the repository root:

```sh
cp .env.demo.example .env.demo
# Choose local demo credentials in .env.demo; do not overwrite an existing file.
pnpm demo:build
pnpm demo:reset
```

Open http://localhost:5180 and use a seeded account with `DEMO_USER_PASSWORD`. The reset command initializes a new demo as well as restoring an existing one. **Every successful reset discards all changes made in this demo.** It does not reset or reseed development.

`DEMO_DB_PASSWORD` must be 12–128 URL-safe letters, digits, underscores, or hyphens; `DEMO_USER_PASSWORD` must be 12–256 characters. `DEMO_PORT` changes the loopback port. The database name and internal host are fixed to `postgres/pandora_demo`. Do not change database credentials after initialization without a separate credential migration.

Rebuild before resetting after code or migration changes. Do not run builds and resets concurrently. The API image includes migration tooling; this is a local demo image, not a minimized public production deployment.

## Reset lifecycle and guarantees

1. Atomically create `/maintenance/reset-lock` in the project's Docker volume. Different shells/checkouts using the same Docker daemon/project share this lock. Existing locks cause an immediate failure without stopping the API.
2. Persist `/maintenance/enabled`. The proxy returns a maintenance page for browser navigation and a JSON 503 `MAINTENANCE` envelope for `/api/` requests, with `X-Correlation-Id`, `Retry-After: 30`, and no-store caching.
3. Stop the API, allowing 30 seconds for termination, and verify it is no longer running. In-flight transactions either complete before shutdown or are rolled back when the connection closes. There is no published API port that bypasses the proxy.
4. Start/wait for the database and web containers, then apply committed migrations with `migrate deploy`.
5. The reset process checks the exact connected database, obtains a PostgreSQL advisory transaction lock, and refuses to proceed while any other database client remains connected.
6. In one database transaction: truncate the explicit business/session/idempotency tables; restart both number sequences; call the shared seed; verify fixture counts; force deferred constraints. No database/schema drop, `migrate reset`, disabled trigger, or `TRUNCATE CASCADE` is used. A failed seed rolls back the data restoration and sequence restart.
7. Start the API and wait for its readiness healthcheck. Only then remove the maintenance marker and release the operator lock.

The seed extraction preserves normal `db:seed` behavior, including its development/test-only environment restriction. The production reset entry point has a separate explicit opt-in and fixed Compose database target. Logs do not print reset credentials or hashes.

Relevant platform semantics: [Docker Compose stop](https://docs.docker.com/reference/cli/docker/compose/stop/), [Compose readiness waiting](https://docs.docker.com/reference/cli/docker/compose/up/), and [PostgreSQL transaction/advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html).

## Failure and recovery

A failed migration, restore, or readiness check keeps maintenance enabled and stops the API. An ordinary handled failure releases the operator lock, so fix the reported cause and rerun `pnpm demo:reset`. Migrations are a separate committed deployment step; the restoration transaction cannot roll back an already applied migration.

If the operator process is killed, its lock may remain. First inspect running containers and confirm that no reset process is still running in any shell using this Docker project:

```sh
docker ps --filter label=com.docker.compose.project=pandora-demo
docker compose --env-file .env.demo -f compose.demo.yml ps -a
```

Only after the abandoned reset and any migration/restore container have stopped, remove its empty lock directory, leaving maintenance enabled:

```sh
docker compose --env-file .env.demo -f compose.demo.yml run --rm --no-deps web rmdir /maintenance/reset-lock
pnpm demo:reset
```

Do not manually clear the maintenance marker or start the API to bypass a failed reset. Do not use `down -v` as routine recovery. The maintenance marker persists across proxy restarts and container recreation.

## Scheduling and deployment boundary

The planned public-demo reset time remains **03:00 Europe/Belgrade daily**. A future deployment scheduler should invoke `pnpm demo:reset` from the repository root, with the correct Node/pnpm PATH, Docker access, and that named timezone. Select a scheduler with explicit timezone/DST support and retain the command's exit status/logs for failure alerting. No host cron job, public hosting, HTTPS, or scheduler was installed by this feature.

The current stack is loopback HTTP and uses non-Secure session cookies for that reason. A public deployment must add HTTPS and enable secure cookies. No notification worker exists yet; when one is added, include it in the stop/verify/start lifecycle before using reset with that deployment. New persistence tables must be explicitly reviewed for truncation and restoration.

## Reproduce verification

Database checks use a new empty database on local PostgreSQL, never the development database:

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" pandora_demo_check_unique'
DEMO_CHECK_DATABASE=pandora_demo_check_unique pnpm --filter @pandora/api check:demo-reset
```

Lifecycle/browser checks require built demo images, `.env.demo`, local Chrome, and a disposable QA project. The script refuses the ordinary `pandora-demo` project:

```sh
DEMO_COMPOSE_PROJECT=pandora-demo-qa-check DEMO_PORT=5186 pnpm demo:reset
DEMO_COMPOSE_PROJECT=pandora-demo-qa-check DEMO_PORT=5186 node --env-file=.env.demo apps/web/checks/demo-reset-browser.mjs
```

## Results — 2026-09-30

- **Database: 6/6 groups** on `pandora_demo_check_20260930_reset`: empty restoration and constraints; rejected wrong names/targets; other-client refusal; injected seed failure with complete rollback; successful recovery clearing sessions/receipts and restoring data/sequences; repeated reset.
- **Lifecycle/browser: 5/5 groups** on `pandora-demo-qa-reset`, port 5186: only the web port is published; existing reset lock rejected; injected restore failure leaves old data, maintenance, and stopped API; desktop/mobile maintenance and proxy restart persistence; successful retry invalidates the old cookie and permits fresh login.
- **Regression:** administration 12/12 on `pandora_admin_check_20260930_seed`; fulfillment 11/11 on `pandora_fulfillment_check_20260930_seed`.
- **Images:** both Docker image builds passed. Added OpenSSL after the first build reported Prisma's missing-library warning; the updated image migrated and restored the QA demo successfully.
- **Browser evidence:** `/tmp/pandora-demo-reset-evidence/` contains catalog before/after and desktop/mobile maintenance screenshots. The mobile maintenance and restored catalog screenshots were visually inspected; keyboard focus and 390px overflow checks passed.
- **Quality gates:** typecheck, lint, build, and diff checks passed. The existing Vite chunk-size warning remains.
- Development data was not reset. The user demo project was not reset; execution used a new disposable QA Compose project.

The temporary `pandora-demo-qa-reset` containers were stopped after verification; their volumes and screenshot evidence were retained.
