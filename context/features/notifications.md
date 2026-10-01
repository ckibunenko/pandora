## Current Feature

Notifications (Phase 3, part 2). Business events enqueue email jobs in a PostgreSQL outbox in the same transaction as the change; a separate worker process claims committed jobs with a lease, delivers them over SMTP to a captured inbox (Mailpit) outside any business transaction, records every attempt, and retries with a bounded schedule. Staff inspect delivery diagnostics and retry failed jobs manually (overview §2, §3, §7, §9; coding standards §8).

## Status

In progress on `feature/notifications`.

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

- Implemented as specified. Full evidence and reproduction: [verification](notifications-verification.md).
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

