## Current Feature

Notifications (Phase 3, part 2). Business events enqueue email jobs in a PostgreSQL outbox in the same transaction as the change; a separate worker process claims committed jobs with a lease, delivers them over SMTP to a captured inbox (Mailpit) outside any business transaction, records every attempt, and retries with a bounded schedule. Staff inspect delivery diagnostics and retry failed jobs manually (overview §2, §3, §7, §9; coding standards §8).

## Status

Completed — merged to `main` as `1c08d9b` (2026-10-01) through PR #8; CI run `36861717385` passed all 3 jobs.

## Goal

Every committed business event that someone needs to act on or know about produces exactly one durable job per recipient. Delivery failures never undo or repeat the business change, and every attempt, including ambiguous ones, is visible.

## Scope and decisions (2026-10-01)

- Branch: `feature/notifications`.
- **Events and recipients.** Overview §11 left these to this feature's contract. Retailer recipients are the active retailer users of the order's organization; staff recipients are active operators and administrators. Inactive users and inactive organizations receive nothing.

| Event | Trigger | Recipients |
|---|---|---|
| `order.submitted` | Retailer submits an order | Staff |
| `order.confirmed` | Staff confirm and reserve | Retailer |
| `order.rejected` | Staff reject with a reason | Retailer |
| `shipment.recorded` | Staff record a shipment | Retailer |
| `cancellation.requested` | Retailer requests cancellation after confirmation | Staff |
| `cancellation.decided` | Staff approve or reject that request | Retailer |
| `return.requested` | Retailer requests a return | Staff |
| `return.decided` | Staff approve or reject a return | Retailer |
| `return.received` | Staff record the return receipt | Retailer |

- **Outbox** (overview §7):
  - Jobs are written inside the business transaction, after the audit event. A rollback leaves no job.
  - Jobs are deduplicated by business event key and recipient (unique `(event_key, recipient_user_id)`).
  - Subject and plain-text body are rendered at enqueue time from committed data, together with the recipient's email snapshot and the request's correlation ID.
- **Worker** (coding standards §8):
  - A separate process, `node dist/worker.js`, built from `apps/api/src/worker.ts`. **Decision:** it lives in `apps/api` instead of the target `apps/notification-worker`, because it shares the generated Prisma client, configuration validation, clock, and Bug Lab guard. It contains no domain rules.
  - It claims due jobs with `FOR UPDATE SKIP LOCKED`, sets a lease (owner and expiry), and records an `in_progress` attempt before sending. It sends outside every transaction and then records the outcome only while it still owns the lease.
  - **Retries:** at most 5 attempts per job, with configurable delays (default 1 min, 5 min, 15 min, 1 h). SMTP 4xx and connection errors are retried; SMTP 5xx fails the job at once.
  - **Ambiguous attempts:** when a lease expires before the outcome is recorded (crash or hang), the next claim marks that attempt `ambiguous` (the message may or may not have been delivered) and counts it. We never claim exactly-once delivery.
  - It refuses the same Bug Lab configurations as the API (production, non-`pandora_buglab…` database, marker mismatch).
- **Controlled delivery failures** (overview §9): `NOTIFICATION_FAILURE_MODE=transient|permanent` replaces the transport with a failing adapter. It is refused in production.
- **Manual retry** (overview §7): `POST /api/notifications/:id/retry` with an Idempotency-Key, staff only, for `failed` jobs only. It grants exactly one more attempt now. Otherwise it returns 409 `NOTIFICATION_NOT_RETRYABLE`. Audited as entity `notification`, which operators can also see in audit search.
- **Diagnostics** (overview §3: operator operational scope, administrator full scope):
  - Staff list jobs (filters: status, event type; shared 20/50/100 pagination, newest first) and open a job with its attempts.
  - Operators see event, order, recipient name, status, attempts, errors, and times. Only administrators also see the recipient email and the message body. Retailers receive 403.
- **Inbox:** Mailpit in `docker-compose.yml` (SMTP 1025, UI 8025) for development and in `compose.demo.yml` for the demo. The Bug Lab gets a separate inbox (`mailpit-buglab`, SMTP 1026, UI 8026, Compose profile `bug-lab`), and `pnpm bug-lab start` also starts a worker.
- **Demo reset:** stops the API and the worker, truncates the notification tables with the other fixtures, and starts both again.
- **Dependency:** `nodemailer` for SMTP (MIT, no paid service).
- **Out of scope:** user notification preferences, HTML email, real email providers, links with tokens, notification UI for retailers, and notifications for draft edits or whole-order cancellation before confirmation.

## Data and invariants

- **NotificationJob:** event type and key, order, recipient and email snapshot, subject and body, status (`pending`, `sending`, `sent`, `failed`), attempt count and maximum, next attempt time, lease owner and expiry, last error, correlation ID, created and sent times.
  - CHECKs: `sending` needs a lease and every other status has none; `sent` needs a sent time; the attempt count never exceeds the maximum.
- **NotificationAttempt:** job, number (unique per job), worker ID, start and finish times, outcome (`in_progress`, `sent`, `failed`, `ambiguous`), and error.
  - A trigger allows only `in_progress` → final outcome, once. Attempts are never deleted.
- Business tables, stock, and movements are never written by the worker.

## API contract

| Endpoint | Access | Behavior |
|---|---|---|
| `GET /api/notifications` | Operator, administrator | `status`, `eventType`, `page`, `pageSize`; summaries |
| `GET /api/notifications/:id` | Operator, administrator | Detail with attempts; email and body for administrators only |
| `POST /api/notifications/:id/retry` | Operator, administrator | CSRF and Idempotency-Key; `failed` → `pending`; 200 with the detail |

## UI acceptance criteria

- Staff navigation gains **Notifications**.
- **List:** status and event filters in the URL, status text (not only color), attempts as "n of m", the last error, and pagination.
- **Detail:** the attempts table, the correlation ID, a link to the order, **Retry delivery** for failed jobs (with replay-safe feedback), and the email and body for administrators only.
- **Selectors:** `notifications-nav`, `notifications-status-filter`, `notifications-event-filter`, `notifications-total`, `notification-row` (`data-notification-id`, `data-status`), `notification-link`, `notification-status`, `notification-recipient-email`, `notification-body`, `notification-attempt-row` (`data-outcome`), `notification-retry`, `notification-retry-error`.
- Keyboard access, loading, empty, and error states, and a 390 px layout without page overflow.

## Verification

- **API, PostgreSQL, and worker** (new `apps/api/checks/notifications.mjs`, `check:notifications`, with an in-process SMTP stub that can accept, return 451 or 550, or hang):
  - Enqueue: every event creates jobs for exactly the right recipients; a rollback creates none; idempotent replays and the unique key prevent duplicates.
  - Delivery: SMTP messages carry the right recipient, subject, and correlation header; jobs become `sent` with one `sent` attempt.
  - Retries: a transient failure, then success; a permanent failure stops at once; exhausted retries end `failed`. Business state is never changed.
  - A lease expiry after a killed worker yields an `ambiguous` attempt and a later delivery. Two workers in parallel deliver each job once.
  - Diagnostics access and redaction, filters and pagination, and manual retry (replay, wrong state 409, missing key 400, audit).
  - The worker refuses Bug Lab misconfiguration and a failure mode in production. Database constraints hold. OpenAPI documents the routes.
- **Browser** (new `apps/web/checks/notifications-browser.mjs`, its own database and a worker with a permanent failure mode): a submitted order produces failed staff jobs; the operator and administrator views (redaction); the detail with attempts; manual retry; filters; keyboard access and 390 px; no page errors.
- **Regressions:** demo reset (new tables, worker lifecycle), Bug Lab, and all existing checks. `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm check:all` pass.

## Implementation results (2026-10-01)

- Implemented as specified. Full evidence and reproduction: [verification](features/notifications-verification.md).
- **API/PostgreSQL and worker:** the new `check:notifications` passes 12 of 12 against an SMTP stub and real worker processes, including an ambiguous lease expiry, a graceful stop, and two parallel workers.
- **Browser:** the new `notifications` group passes 4 of 4 with a worker in the permanent failure mode.
- **Bug Lab:** a new group covers worker refusals. The demo reset check covers the new tables.
- **Docker demo lifecycle:** 5 of 5 on a disposable QA project. The worker stops and starts with the API, and a post-reset order reaches the demo Mailpit.
- **Full `pnpm check:all`** (run `20261001_073834`): 20 of 20 suites passed. `pnpm typecheck` and `pnpm lint` pass, and `prisma migrate diff` is empty.
- **Found and fixed during verification:**
  - **Worker shutdown:** the real-Mailpit run showed that a stopped worker left claimed jobs `sending` until lease expiry. They are now released at once on shutdown.
  - **Stale UI:** the browser check showed that the detail page did not refresh after a retry. Both pages now refresh while jobs are in flight.
  - **Navigation:** the extra administrator link made navigation items break mid-word. They now wrap as whole items.
- **Contract additions:**
  - `NOTIFICATION_NOT_RETRYABLE`;
  - the audit entity `notification`, also visible to operators;
  - `nodemailer@10.0.13`.

## Previous feature

[Returns](features/returns.md) merged as `e66fb6b` through PR #7; [verification](features/returns-verification.md). Earlier features are listed in the history below.

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
- Sign-in rate limiting and session cleanup (2026-09-30): at most 5 sign-in attempts per normalized email per 15 minutes (429 with `Retry-After`, identical for unknown accounts, digests only, per-email advisory lock so a parallel burst checks exactly 5). Automatic removal of sessions unusable for more than 24 hours. Demo reset also clears attempts. `check:all` gained the auth suites and a per-suite timeout. CI on PR #2 exposed immediate serialization retries colliding, so `runSerializable` now backs off with jitter. Final CI: 3 jobs and 13 suites passed; see [features/auth-hardening-verification.md](features/auth-hardening-verification.md). Merged to `main` as `c239416` + `a564c18`.
- Bug Lab (2026-09-30, Phase 2): exactly one `BUG_LAB_DEFECT` (`BUG-001` persisted wrong fulfillment status, `BUG-002` off-by-one page offset, `BUG-003` current prices on frozen lines), refused in production, on non-`pandora_buglab…` databases, or on a marker mismatch. Includes `pnpm bug-lab setup|start` with scenario fixtures and run manifests, and a catalog, briefs, and solutions in `bug-lab/`. `check:bug-lab` 7/7: the same assertion passes on Standard and fails for the intended reason for each defect; locally `check:all` 14/14; CI green on PR #3; see [features/bug-lab-verification.md](features/bug-lab-verification.md). Merged to `main` as `277925e`.
- Minimal UI polish (2026-10-01): original generated SVG cover art per product (deterministic from the product ID; five warm palettes, four motifs, expansion ribbon); catalog cards with depth and a hover/focus lift; product cover capped at 480 px; branded sign-in page. No selector, behavior, or API changes. `check:all` 14/14; manual checks at 390 and 360 px, keyboard focus, no page errors; CI green on PR #4. Merged to `main` as `bf6f472`.
- Line-level cancellation requests (2026-10-01, Phase 2): retailers choose which lines and how many unshipped units to cancel (optional `items`; omitted still means everything outstanding), with the new 409 `CANCELLATION_QUANTITY_EXCEEDED`; staff still approve or reject the whole request, and a partial approval keeps the order open. No migration or seed change; audit records `scope`. Fulfillment checks 14/14 API and 10/10 browser; `check:all` 14/14; CI green on PR #5. Merged to `main` as `37bb2d4`.
- Phase 2 operational completion (2026-10-01): read-only staff audit search/detail with role scope, exact filters and audit indexes; complete order/movement pagination and URL state, multi-page authorization acceptance. New checks: API 9/9, browser 7/7; local full `check:all` 16/16. Corrected existing administration browser synchronization and aligned draft concurrency coverage with the shared retry-exhaustion contract, while adding persisted-winner/audit/stale-retry assertions. All three CI jobs passed on PR #6, run `36825594931`. Merged to `main` as `5868e8e`; Phase 2 is complete. Next: Phase 3 returns, then durable notifications. See [verification](features/phase-2-operations-verification.md).
- Returns (2026-10-01, Phase 3 part 1): retailers request shipped units back with a reason; staff approve or reject the whole request and record one receipt that splits units into sellable and damaged stock (`RETURN` movements). Entitlement per shipment item is enforced in the transaction and by a database trigger (`RETURN_QUANTITY_EXCEEDED`), with the new `INVALID_RETURN_TRANSITION`; returns never change the order. Orders list filter for open returns, seed `RT-000001`, demo reset covers the new tables. `check:returns` 11/11, returns browser 8/8, `check:all` 18/18; CI green on PR #7. Merged to `main` as `e66fb6b`; see [verification](features/returns-verification.md).
- Notifications (2026-10-01, Phase 3 part 2): transactional outbox for nine business events (one job per active recipient, deduplicated), a separate worker that delivers to a captured Mailpit inbox under a lease with bounded retries, ambiguous-attempt recording, and graceful release; controlled failure adapter outside production; staff diagnostics with redaction for operators and an idempotent, audited manual retry; Mailpit for development, demo, and a separate Bug Lab inbox; demo reset stops/starts the worker. `check:notifications` 12/12, notifications browser 4/4, Docker demo lifecycle 5/5, `check:all` 20/20; CI green on PR #8. Merged to `main` as `1c08d9b`; see [verification](features/notifications-verification.md).
