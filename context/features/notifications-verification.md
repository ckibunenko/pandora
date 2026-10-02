# Notifications — verification and handoff

## Implemented scope

- **Outbox:** `NotificationOutbox.enqueue(tx, event)` runs inside the business transaction, right after the audit event.
  - It writes one `notification_jobs` row per active recipient, with the rendered subject and plain-text body, the recipient's email snapshot, and the request's correlation ID.
  - Jobs are deduplicated by `(event_key, recipient_user_id)`. A rollback leaves no job.
- **Events and recipients:**
  - `order.submitted`, `cancellation.requested`, and `return.requested` go to active operators and administrators.
  - `order.confirmed`, `order.rejected`, `shipment.recorded`, `cancellation.decided`, `return.decided`, and `return.received` go to the active retailer users of the order's organization.
  - Inactive users and inactive organizations receive nothing.
- **Worker** (`node dist/worker.js`, `apps/api/src/worker.ts`) is a separate process:
  - It claims due jobs with `FOR UPDATE SKIP LOCKED` under a lease and records an `in_progress` attempt.
  - It sends outside every transaction, then records the outcome only while it still owns the lease.
  - **Expired leases** (killed or hung worker) turn the attempt `ambiguous`; the job is retried later. Delivery is at least once and is never claimed as exactly once.
  - **On graceful stop**, it finishes the job in flight and releases claimed but unsent jobs at once (attempt `failed`, "Not sent").
  - **Retries:** at most 5 attempts with `NOTIFICATION_RETRY_DELAYS_MS`. SMTP 5xx fails the job at once.
  - It never writes business tables, and it logs IDs and correlation IDs, never addresses or bodies.
  - It refuses the same Bug Lab configurations as the API, production failure modes, and a send timeout that is not shorter than the lease.
- **Transport** (`MailTransport`): nodemailer SMTP (`nodemailer@10.0.13`, MIT-0). In development and test only, `NOTIFICATION_FAILURE_MODE=transient|permanent` swaps in the controlled failure adapter.
- **Diagnostics:**
  - `GET /api/notifications` (status and event filters, 20/50/100, newest first with an ID tie-breaker) and `GET /api/notifications/:id` (with attempts).
  - Operators see no recipient email or body; administrators do. Retailers receive 403.
- **Manual retry:** `POST /api/notifications/:id/retry`, with an Idempotency-Key and CSRF.
  - It applies only to `failed` jobs and grants exactly one more attempt now.
  - Any other state returns 409 `NOTIFICATION_NOT_RETRYABLE`.
  - It is audited as entity `notification`, which is now part of the operators' audit scope.
- **UI:**
  - **Notifications** in staff navigation, with a list (URL filters, status text, "n of m" attempts, last error, pagination) and a detail page (attempts table, correlation ID, order link, **Retry delivery**, and the email and body for administrators).
  - Both pages refresh every 2 s while a shown job is pending or sending.
  - The header now wraps whole items instead of breaking words, which the extra administrator link required.
- **Migration** `20261001120000_notifications`:
  - adds the jobs and attempts tables and their indexes;
  - CHECKs that a lease exists exactly while a job is `sending`, that `sent` jobs have a send time, and that attempts stay within the budget;
  - triggers for immutable content, frozen `sent` jobs, no deletes, and a single outcome per attempt.
  - `prisma migrate diff` from a migrated QA database to the schema is empty.
- **Inboxes:**
  - Development: Mailpit in `docker-compose.yml` (SMTP 1025, UI 8025).
  - Bug Lab: `mailpit-buglab`, Compose profile `bug-lab` (SMTP 1026, UI 8026); `pnpm bug-lab start` also starts a worker.
  - Demo: `worker` and `mailpit` in `compose.demo.yml`; the inbox UI was on loopback port 5181 and is now served read-only at `/mail/` behind Caddy (public demo preparation).
- **Demo reset:** stops and starts the API and the worker, and truncates the notification tables.

## Reproduction

```sh
pnpm check:all --only notifications --evidence /private/tmp/pandora-notifications-evidence
pnpm check:all
# Docker demo (disposable QA project; never the user demo):
pnpm demo:build
DEMO_COMPOSE_PROJECT=pandora-demo-qa-notifications DEMO_PORT=5186 DEMO_MAIL_PORT=5187 pnpm demo:reset
DEMO_COMPOSE_PROJECT=pandora-demo-qa-notifications DEMO_PORT=5186 DEMO_MAIL_PORT=5187 node --env-file=.env.demo apps/web/checks/demo-reset-browser.mjs
```

- **API suite:** `NOTIFICATIONS_CHECK_DATABASE=pandora_notifications_check_<unique>`, default port 3027. It runs its own SMTP stub (`checks/smtp-stub.mjs`: accept, 451, 550, or hang) and real worker processes.
- **Browser group:** its own seeded database. `check:all` starts a worker with the permanent failure mode next to the QA API; CDP port 9342.

## Acceptance evidence

- **API/PostgreSQL and worker: 12 groups**
  - **Enqueue and delivery:**
    - every event creates jobs for exactly the right recipients, with no worker running;
    - an audit failure rolls back the job, replays add none, and the unique key rejects duplicates;
    - SMTP delivery carries the recipient, subject, and correlation, event, and job headers, while business data stays unchanged and logs contain no addresses or bodies.
  - **Failure handling:**
    - transient failures then success; a permanent failure; retries exhausted after 5 attempts, with the order unchanged;
    - a worker killed mid-send, then an `ambiguous` attempt and delivery by a second worker;
    - a graceful stop releases claimed but unsent jobs;
    - two workers in parallel deliver each job exactly once.
  - **Diagnostics and robustness:**
    - diagnostics access, redaction, filters, and page boundaries;
    - manual retry (key, CSRF, and role required, replay, 409 states, audit visible to operators, delivery after the retry);
    - worker configuration refusals and the failure adapter;
    - database constraints;
    - OpenAPI.
- **Browser: 4 groups**
  - the retailer submission queues staff jobs, and retailers are restricted from diagnostics;
  - the operator list (failed status text, "1 of 5", error, no addresses, filters in the URL, empty state, 390 px);
  - the detail page (attempts, no body, keyboard focus on retry, retry then a second attempt via auto-refresh, 390 px);
  - the administrator view (addresses and body), the retry in the audit trail, and no page errors.
- **Bug Lab:** a new group verifies that the worker refuses unknown IDs, production, non-Bug-Lab databases, and marker mismatches, and starts on a matching database.
- **Demo reset (database):** a queued job before the reset is cleared by it.
- **Docker demo lifecycle: 5 of 5** on `pandora-demo-qa-notifications`:
  - only web and the loopback Mailpit UI are published, and the worker runs;
  - a failed restore leaves the API **and** the worker stopped;
  - after a successful reset, a submitted order is delivered to the demo's Mailpit to both staff recipients.
- **Real Mailpit (development):** a requeued QA job was delivered to Mailpit v1.31.3 with the `X-Correlation-Id`, `X-Pandora-Event`, and `X-Pandora-Notification` headers and a correctly decoded UTF-8 body.
  - This run also exposed that a stopped worker left claimed jobs `sending` until lease expiry. That was fixed with the graceful release and covered by a new check.

## Status and limits

- **Full `pnpm check:all`** (run `20261001_073834`): 20 of 20 suites passed, including the build. There are now twelve API suites and eight browser groups. `pnpm typecheck`, `pnpm lint`, and `git diff --check` pass.
- **CI:** run `36861717385` on PR #8 passed all three jobs. Merged to `main` as `1c08d9b`.
- **Duplicate delivery is possible:** delivery is at least once. A worker that sends and then loses its lease before recording the outcome produces an `ambiguous` attempt, and the message may arrive twice. This is intended and visible in diagnostics.
- **Worker location:** the worker lives in `apps/api` instead of the target `apps/notification-worker` (recorded decision), so that it shares the generated client, configuration, clock, and Bug Lab guard.
- **Out of scope:** user preferences, HTML email, real providers, and retailer-facing notification history.
- Disposable QA databases and the stopped `pandora-demo-qa-notifications` containers and volumes are kept as evidence.
