## Current Feature

Safe demo reset tooling for an isolated Docker Compose stack.

## Status

Completed — merged to `main` as `ada25a1` (2026-09-30). Administration was merged to `main` as `17d5ef5`.

## Goal

Restore the fictional demo to its deterministic seed without touching the development database, admitting mutations during reset, or reopening the demo after a failed restoration.

## Scope and decisions (2026-09-30)

- A separate Compose file/project runs PostgreSQL, the API, and a web/reverse-proxy container. Only the web port is published, on loopback by default. Database volumes and networks are separate from development.
- An operator CLI owns reset; no business role, browser page, or API endpoint can invoke it.
- Lifecycle: acquire an exclusive operator lock → start database/proxy if needed → persist a maintenance marker → stop API and wait for exit → migrate → atomically truncate business/session/idempotency data and restore seed → start API and wait for readiness → clear maintenance.
- The reverse proxy serves a maintenance page and returns 503 `MAINTENANCE` for API calls while the marker exists. Its volume survives container restarts.
- Stopping the API drains or terminates all its work before restoration. The notification worker (added with notifications) is stopped and started together with the API.
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
