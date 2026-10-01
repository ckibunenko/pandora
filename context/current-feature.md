## Current Feature

Line-level cancellation requests (Phase 2). After confirmation, a retailer chooses which lines and how many unshipped units to cancel, instead of always cancelling everything that remains. Staff still approve the whole request or reject it with a reason (overview §6).

## Status

Completed — merged to `main` as `37bb2d4` (2026-10-01) through PR #5; CI run `36821755066` passed all 3 jobs.

## Goal

A retailer can cancel part of a confirmed or partially shipped order and keep the rest coming. Approving such a request releases only the requested reservations and leaves the remainder open for shipment. Stock, reservations, movements, audit, and the derived order status stay consistent.

## Scope and decisions (2026-10-01)

- Branch: `feature/line-cancellation`.
- **Request body:** `POST /api/orders/:orderId/cancellation-requests` accepts an optional `items[{orderLineId, quantity}]`.
  - With `items`, the request covers exactly those quantities. Each line may appear only once, each quantity is a whole number from 1 to 10,000, and at least one item is required.
  - Without `items`, the request covers every outstanding unit, as in Phase 1. Existing clients and checks keep working.
- **No partial approval** (overview §6): staff approve or reject the whole request. Approval rechecks every item against the current outstanding quantity and returns 409 `CANCELLATION_CONFLICT` with no effect if any item no longer fits.
- **New error code `CANCELLATION_QUANTITY_EXCEEDED`** (409): a requested quantity is above the line's outstanding quantity when the request is made. It mirrors `SHIPMENT_QUANTITY_EXCEEDED`, with `lines.<SKU>` details.
- **Order status after approval** is derived from the quantities as before. Cancelling only some units leaves the order `confirmed` (nothing shipped) or `partially_shipped`. Shipping the remainder later ends in `closed_partial`. Cancellation data on the order (`cancelledAt`, `cancelledBy`, reason) is set only when every unit ends up cancelled.
- **Unchanged:**
  - one pending request per order; a pending request releases nothing and shipping may continue;
  - the database schema (no migration needed: items, quantities, the one-pending index, and status derivation already support this);
  - audit actions and the Bug Lab;
  - the seed.
- **Out of scope:** partial approval, editing or withdrawing a pending request, returns, notifications.

## Consistency rules

- Idempotency-Key, current order `version`, Serializable transaction with bounded retry, atomic audit, and a version bump, as for every fulfillment mutation.
- **Order of checks for a request:**
  1. 404 (also another organization's order).
  2. `INVALID_ORDER_TRANSITION` (not `confirmed`/`partially_shipped`).
  3. `VERSION_CONFLICT`.
  4. 422 for invalid input, including unknown lines and lines of another order.
  5. `CANCELLATION_REQUEST_PENDING`, then `CANCELLATION_QUANTITY_EXCEEDED`.
- A rejected request changes nothing except the request itself and the order version.

## Audit

`cancellation_requested` records the requested quantity per SKU (as before) and now also `scope`: `selected` or `all_remaining`. `cancellation_approved` keeps recording the released quantity per SKU.

## UI acceptance criteria

- **Retailer**, on a `confirmed` or `partially_shipped` order with no pending request:
  - **Request cancellation** opens a panel with one quantity field per line that still has outstanding units, labelled with SKU, product, and outstanding quantity.
  - Fields default to 0, so the retailer chooses what to cancel; **Cancel all remaining** fills every field with its outstanding quantity.
  - Client-side validation per field (0 to outstanding) and at least one unit overall, with errors associated with their fields.
  - The submit button names the total, for example "Send request to cancel 2 units".
  - Optional reason; **Keep order** closes the panel.
- **Staff:** the review panel lists the requested quantities and says that approval releases only those units; the rest stays open for shipment.
- After a partial approval the order stays open: the fulfillment table shows the cancelled units, the shipment form defaults to the new outstanding quantities, and the retailer may request again.
- Selectors: `cancellation-request-line` (with `data-sku`), `cancellation-request-quantity`, `cancellation-request-all`. Existing selectors are unchanged.
- Keyboard access and a narrow layout (390 px) without horizontal overflow.

## Verification

- **API/PostgreSQL** (added to `apps/api/checks/fulfillment.mjs`):
  - Validation without effects: empty `items`, unknown or foreign lines, duplicate lines, zero, negative, and fractional quantities return 422; a quantity above outstanding returns 409 `CANCELLATION_QUANTITY_EXCEEDED` with `lines.<SKU>` details.
  - A selected request on a two-line order: approval releases only the requested units, the order stays `confirmed`, a later full shipment of the rest ends `closed_partial`.
  - On a partially shipped order: cancel part of one line, approve, status stays `partially_shipped`, and a second request is possible.
  - A shipment after a selected request that leaves less than requested makes approval return `CANCELLATION_CONFLICT` with no effect.
  - Omitting `items` still requests every outstanding unit (Phase 1 behavior).
  - Replay returns the same response; audit `scope` is recorded; invariants (movement sums, reservations, line totals) hold.
- **Browser** (added to `apps/web/checks/fulfillment-browser.mjs`): the retailer requests part of an order, client-side validation flags an over-quantity, staff approve, the order stays open with the new outstanding quantity; keyboard and 390 px layout.
- All existing checks pass; `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm check:all`.

## Implementation results (2026-10-01)

- Implemented as specified; no migration, no seed change, and no Bug Lab change.
- **API/PostgreSQL:** fulfillment 14 of 14 (3 new groups: validation without effects, selected request with partial release then `closed_partial`, partial approval on a partially shipped order with an overtaken request and the omitted-`items` fallback).
- **Browser:** fulfillment 10 of 10. The PO-000008 flow now goes partial request (empty and over-quantity flagged) → approval leaves it `partially_shipped` → **Cancel all remaining** by keyboard and at 390 px → approval closes it `closed_partial`, so later groups see the same final state as before.
- **Full `pnpm check:all`** (run `20261001_054523`): 14 of 14 suites passed, including the build. `pnpm typecheck` and `pnpm lint` pass.
- Screenshots of the narrow request form and the closed order with two approved partial requests were inspected.

## Previous feature

[Minimal UI polish](features/ui-polish.md) is merged as `bf6f472`. Earlier: [Bug Lab](features/bug-lab.md) ([verification](features/bug-lab-verification.md)), [sign-in hardening](features/auth-hardening.md), [CI](features/ci.md), [demo reset](features/demo-reset.md), [administration](features/admin-management.md), [fulfillment](features/fulfillment.md), [order processing](features/order-processing.md), [order drafts](features/order-drafts.md), [inventory](features/inventory.md), [catalog](features/catalog.md), [auth](features/auth-sessions.md). Remaining Phase 2 after this feature: audit search, operational lists.

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
