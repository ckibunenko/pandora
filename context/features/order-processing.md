## Current Feature

Order processing: distributor staff confirm submitted orders, reserving stock for every line atomically, or reject them with a reason. Reserved stock lowers availability in the catalog and inventory. Operators land on the queue of orders awaiting processing.

## Status

Completed — merged to `main` as `4b8d65c` (2026-09-30).

## Goal

An operator or administrator opens the submitted orders, sees whether stock covers each line, and either confirms or rejects. Confirmation reserves stock for every line in one transaction, or reserves nothing and explains the shortage. The retailer sees the new status and the rejection reason.

## Scope and decisions (2026-09-30)

- Branch: `feature/order-processing`.
- New statuses: `confirmed` and `rejected`, both reached only from `submitted`. Shipment statuses come with shipments.
- **Who can act:**
  - Confirm and reject: operators and administrators. Retailers get 403.
  - Retailers can still cancel only drafts and submitted orders. Cancelling a confirmed order returns `INVALID_ORDER_TRANSITION`; cancellation requests after confirmation are a later feature.
- **Confirmation rules:**
  - All or nothing: if any line needs more than `sellable − reserved`, the response is 409 `INSUFFICIENT_STOCK` with one detail per short SKU. The order stays submitted and nothing is reserved.
  - Catalog visibility does not matter at confirmation, because the order already holds a frozen snapshot. Stock is what counts.
- **Rejection:** requires a reason (3–500 characters) and has no stock effect.
- **Operator landing page:** the queue of submitted orders, oldest submission first. Administrators still land on catalog management.
- **Out of scope:** shipments, consuming or releasing reservations, cancellation after confirmation, returns, notifications.

## Data and invariants

- **Order:** new `confirmedAt`/`confirmedById` and `rejectedAt`/`rejectedById`/`rejectionReason`. CHECK constraints tie each status to its data:
  - confirmed and rejected orders keep their submission data and total;
  - rejected orders also carry the reason.

  Rejected orders are terminal, like cancelled ones.
- **StockReservation** (one per order line, created at confirmation): `quantityReserved > 0`, `quantityConsumed` and `quantityReleased` (both 0 for now), with `consumed + released ≤ reserved`. Remaining = reserved − consumed − released.
- **Inventory:** a reservation movement (`type = reservation`, `bucket = reserved`, positive delta, linked to the reservation) increases `inventory_items.reserved`. Invariants:
  - `reserved = Σ reserved-bucket deltas`;
  - `reserved = Σ remaining reservations` for the variant (checked in verification);
  - `reserved ≤ sellable`, still enforced by the database.
- **Migrations:** new enum values are added in their own migration, before any constraint uses them. PostgreSQL does not allow using a new enum value in the transaction that adds it.

## Consistency rules

- Confirm and reject require an Idempotency-Key and the current `version`. They run in Serializable transactions with bounded retry, and the audit event is written in the same transaction.
- **Order of checks:**
  1. The order is missing → 404.
  2. The status is not `submitted` → 409 `INVALID_ORDER_TRANSITION`.
  3. The version is stale → 409 `VERSION_CONFLICT`.
  4. Invalid body → 422.
  5. Not enough stock → 409 `INSUFFICIENT_STOCK`.
- **No overselling:** concurrent confirmations competing for the same stock never reserve more than is available. Exactly as many succeed as the stock allows; the rest get `INSUFFICIENT_STOCK`, or `CONCURRENT_MODIFICATION` once retries run out.

## API contract

| Endpoint | Access | Behavior |
|---|---|---|
| `POST /api/orders/:orderId/confirm` | Operator, administrator + CSRF + Idempotency-Key | `version`; reserves all lines; 200 |
| `POST /api/orders/:orderId/reject` | Operator, administrator + CSRF + Idempotency-Key | `version`, `reason`; 200 |
| `GET /api/orders` | as before | Adds `status=confirmed/rejected` and `sort=submitted_asc` (oldest submission first; ties by ID) |

- **Order responses add:**
  - confirmation and rejection actors, times, and the rejection reason;
  - per line, `reservedQuantity` (null until confirmed) and the current `availableQuantity` while the order is submitted, which is informational.

## Audit

- Order audit events `confirmed` (with reserved quantities per SKU) and `rejected` (with the reason). Reservation movements are the inventory record, attributed to the confirming staff member and the correlation ID.

## UI acceptance criteria

- **Navigation:** Orders is visible to all roles. The operator's home redirects to `/orders?status=submitted&sort=submitted_asc`.
- **Staff view of a submitted order:**
  - Each line shows the ordered quantity, the currently available stock, and a clear shortage flag.
  - **Confirm order** opens a confirmation that states it reserves stock for every line.
  - **Reject order** requires a reason.
  - Errors, including `INSUFFICIENT_STOCK` with SKUs, are shown next to the actions and keep the input. After success, order, inventory, and catalog queries are refreshed.
- **Confirmed orders** show reserved quantities. **Rejected orders** show the reason in their history. Retailers see both states read-only.
- Status badges for `confirmed` and `rejected` always include text.
- `data-test` selectors follow the existing contract.

## Deterministic seed (additions, created only if missing)

| Number | Organization | Status | Lines |
|---|---|---|---|
| `PO-000005` | Cardboard Keep | submitted | `CWO-EN-DLX` × 2 (no stock), `LOV-SR-STD` × 1 — cannot be confirmed |
| `PO-000006` | Tabletop Lantern | confirmed | `LOV-SR-STD` × 2, reserved |
| `PO-000007` | Cardboard Keep | rejected | `TKC-EN-STD` × 5, reason "Duplicate of an earlier order" |

`PO-000002` (submitted) stays confirmable. Existing checks are updated to the new seed.

## Verification

- **Access:** retailers and unauthenticated callers cannot confirm or reject; CSRF and Idempotency-Key are required.
- **Confirm:**
  - Reservations, movements, inventory `reserved`, and the audit event are written together.
  - Catalog and inventory availability drop by the reserved amounts, and the invariants above hold.
  - A replay applies nothing new.
  - A stale version, a non-submitted order, or insufficient stock (with details) changes nothing at all.
- **Reject:** the reason is required and there is no stock effect.
- **Transitions:** confirmed and rejected orders cannot be edited, re-confirmed, rejected again, or cancelled by the retailer.
- **Concurrency:**
  - Two orders competing for the last units: exactly one is confirmed and stock is never oversold.
  - Parallel confirmations of the same order: one effect.
- **Rollback:** an injected audit failure leaves no reservation, movement, or quantity change.
- **Database:** direct writes violating the reservation or status constraints are rejected.
- **Browser:**
  - The operator lands on the queue, sees a shortage on `PO-000005`, confirms `PO-000002`, and the order shows reserved quantities.
  - The operator rejects an order with a reason.
  - The retailer sees the confirmed and rejected states; the catalog availability drops after confirmation.
  - Keyboard access, narrow layout, login/logout regression.
- Existing catalog, inventory, and order checks pass with the updated seed. `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass.

## Implementation results (2026-09-30)

- Implemented as specified. Full evidence, reproduction steps, selectors, and limitations: [order-processing-verification.md](order-processing-verification.md).
- **API/PostgreSQL:** 13 check groups passed on three fresh QA databases. They cover no oversell when orders compete for the last units, one effect per order under parallel confirmation, rollback, and database constraints.
- **Regressions:** orders 16 of 16, inventory 18 of 18 (its invariant now includes `reserved`), and catalog 11 of 11, all updated to the new seed.
- **Browser:** processing 7 of 7 and inventory 9 of 9 on two fresh stacks; order drafts 11 of 11 on a separate stack.
- **Final gates:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass.
- **Additions beyond the written spec:**
  - The new enum values have their own migration.
  - A shared setup module for API checks, `apps/api/checks/harness.mjs`.
  - A sort selector on the orders list.
  - An empty-queue message.

