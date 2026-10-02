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

[Minimal UI polish](ui-polish.md) is merged as `bf6f472`. Earlier: [Bug Lab](bug-lab.md) ([verification](bug-lab-verification.md)), [sign-in hardening](auth-hardening.md), [CI](ci.md), [demo reset](demo-reset.md), [administration](admin-management.md), [fulfillment](fulfillment.md), [order processing](order-processing.md), [order drafts](order-drafts.md), [inventory](inventory.md), [catalog](catalog.md), [auth](auth-sessions.md). Remaining Phase 2 after this feature: audit search, operational lists.
