## Current Feature

Bug Lab (Phase 2): an isolated local/QA environment where exactly one known defect (`BUG-001`, `BUG-002`, or `BUG-003`) is switched on. The same business assertion passes in Standard mode and fails in Bug Lab for the intended reason (overview §9, §10 Phase 2).

## Status

Implemented and verified locally on `feature/bug-lab`; waiting for commit permission (then PR and CI).

## Goal

QA learners get reproducible, realistic defects with a catalog entry, a learner brief, a separate solution, and a run manifest. Standard mode stays authoritative, and no Bug Lab setting can reach the public demo.

## Scope and decisions (2026-09-30)

- Branch: `feature/bug-lab`. Phase 2 starts with the Bug Lab. Line-level cancellation, audit search, and operational lists follow as separate features.
- **Selection:**
  - The API reads the optional `BUG_LAB_DEFECT`. Without it, the API runs in Standard mode.
  - Exactly one of `BUG-001`, `BUG-002`, or `BUG-003` is accepted. Unknown IDs and lists such as `BUG-001,BUG-002` stop startup with a clear message.
  - Switching defects means a restart against a newly prepared database; there is no runtime toggle.
- **Isolation (each rule stops startup):**
  1. A defect requires `NODE_ENV` of `development` or `test`. The public demo runs `production`.
  2. A defect requires a database named `pandora_buglab…` (the demo uses `pandora_demo`, and development uses `pandora`).
  3. The database must carry the matching marker `pandora.defect` (set only by the Bug Lab setup tool through `ALTER DATABASE … SET`).
  4. A database with a marker cannot be used by an API without the same defect, and vice versa.
- **No worker or inbox exists yet.** When they arrive, they must follow the same selection and isolation rules.
- **The defects** (each is a single, explicitly named place in the code):

  | ID | Where | Behavior |
  |---|---|---|
  | `BUG-001` | Shipment status derivation | When an order was already `partially_shipped` and the new shipment ships everything outstanding without any cancellation, it stays `partially_shipped` instead of `shipped`. The Standard database trigger rejects that status. In a database marked `BUG-001`, the trigger skips only that one status check, so the wrong state is really persisted. All other constraints stay active. |
  | `BUG-002` | Order list pagination | For page 2 and later, the offset is one too small. Page 2 repeats the last order of page 1, and the page's true last order is pushed to the next page; when the total is an exact multiple of the page size, it cannot be reached at all. |
  | `BUG-003` | Order detail | Submitted orders show each SKU's current catalog price and a line total computed from it, instead of the frozen snapshot. The stored snapshot and the order total stay correct, so the page contradicts itself. |

- **Unchanged in every mode:** authentication, CSRF, RBAC, retailer isolation, idempotency, audit, and secret handling. The check verifies these for every defect.
- **Setup tool** (`pnpm bug-lab setup --defect BUG-00X|none`):
  - Creates a new database `pandora_buglab_<defect>_<runId>` on the `DATABASE_URL` server, migrates, seeds, and adds **scenario fixtures**: 40 extra draft orders for Tabletop Lantern (`PO-000101`–`PO-000140`), so `BUG-002` can be reproduced by hand.
  - Sets the marker and writes a **run manifest** to `bug-lab/runs/<runId>.json` (gitignored): run ID, defect, database, app version (git commit plus a dirty flag), seed version (hash of the seed sources), and creation time.
  - Prints the command that starts the API and web app against it.
  - `none` prepares the same data without a defect, for Standard comparison.
  - It never drops databases and never touches development or demo databases.
- **Documentation** in `bug-lab/`:
  - `README.md`: how to run it, and the rules.
  - `catalog.md`: ID, title, area, prerequisites, severity, and the business rule broken.
  - `briefs/BUG-00X.md`: what to test and the expected behavior, without the cause.
  - `solutions/BUG-00X.md`: separate files with the cause, the fix, and the assertion.
- **Out of scope:** combined defects, the concurrency defects the overview lists as later extensions, a UI banner, browser Bug Lab checks, and worker or inbox isolation.

## Verification

- **`check:bug-lab`** (new API/PostgreSQL suite in `check:all`):
  - **Configuration rejected at startup:** an unknown ID, several IDs, `production`, a non-Bug-Lab database, a marker mismatch, and a marker without a defect.
  - **For each defect:** the same assertion passes on a Standard database with the same scenario data, and fails on the Bug Lab database with the intended wrong value. Examples: the status is `partially_shipped`; page 2 repeats the boundary order and misses one; the detail price is the new catalog price.
  - **For each defect:** a spot-check of 401, CSRF, 403, and cross-retailer 404, and that the logs hold no passwords.
  - The setup tool writes a complete manifest and refuses bad names.
- Existing suites are unchanged, and `pnpm check:all` and CI pass. `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass.

## Implementation results (2026-09-30)

- Evidence and details: [features/bug-lab-verification.md](features/bug-lab-verification.md).
- `check:bug-lab` passes 7 of 7:
  - configuration refusals;
  - the same assertion passing on Standard and failing for the intended reason for each defect;
  - each defect breaking only its own rule;
  - security in every mode.
- Full `pnpm check:all`: 14 of 14.
- **Corrections:**
  - `pnpm bug-lab start` left vite running after stop; the web server now runs in its own process group.
  - The BUG-002 description was made precise: the boundary order is displaced, and it becomes unreachable only when the total is an exact multiple of the page size.

## Previous feature

[Sign-in rate limiting and session cleanup](features/auth-hardening.md) is merged as `c239416` + `a564c18`; [verification](features/auth-hardening-verification.md). Earlier: [CI](features/ci.md), [demo reset](features/demo-reset.md), [administration](features/admin-management.md), [fulfillment](features/fulfillment.md), [order processing](features/order-processing.md), [order drafts](features/order-drafts.md), [inventory](features/inventory.md), [catalog](features/catalog.md), [auth](features/auth-sessions.md). Still outstanding: audit foreign keys, shared UI primitives, demo hosting and scheduling, a unit-test framework, and the Playwright catalog check in CI.

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
