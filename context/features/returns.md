## Current Feature

Returns (Phase 3, part 1). A retailer asks to return shipped units, staff approve or reject the whole request, and an approved return gets exactly one receipt with inspection that splits the received units into sellable and damaged stock (overview §6). Notifications (outbox, worker, Mailpit) are part 2 and out of scope here.

## Status

Completed — merged to `main` as `e66fb6b` (2026-10-01) through PR #7; CI run `36828935735` passed all 3 jobs.

## Goal

A shipped unit can come back once, and only once. Every return is traceable from the shipment item through the decision and inspection to the inventory movement. Sellable and damaged stock change only at receipt, and the order's fulfillment status never changes.

## Scope and decisions (2026-10-01)

- Branch: `feature/returns`.
- **Eligible orders:** `partially_shipped`, `shipped`, and `closed_partial`, which are the statuses that have shipments. Other statuses return 409 `INVALID_ORDER_TRANSITION`. There is no return window and no expiry; refunds stay out of scope (overview §3).
- **Return request** (retailer, own organization):
  - A required reason (3–500 characters).
  - Items: `[{shipmentItemId, quantity}]`, at least 1, each shipment item once, quantity 1–10,000. Each item references a shipment item of the same order (422 otherwise).
  - Several requests per order may be open at the same time; entitlement keeps them consistent.
- **Entitlement** (overview §6), per shipment item: quantities in pending and approved returns, plus received units in completed returns, never exceed the shipped quantity. Rejected returns do not count. A violation returns 409 `RETURN_QUANTITY_EXCEEDED` with details `shipments.<SH-number>.<SKU>`. It is checked in the Serializable transaction and again by a database trigger.
- **Decision** (staff): approve the whole request, or reject it with a reason (3–500 characters). There is no partial approval. Approval does not touch stock.
- **Receipt** (staff, once per approved return):
  - Lists every item of the return exactly once with `sellableQuantity` and `damagedQuantity` (each ≥ 0); otherwise 422.
  - Sellable plus damaged per item may not exceed the approved quantity: 409 `RETURN_QUANTITY_EXCEEDED`.
  - A short receipt (fewer units than approved on any item) requires `discrepancyReason` (3–500 characters): 422 otherwise. It is optional on a full receipt.
  - Sellable units increase sellable stock and damaged units increase damaged stock, as `return` movements referencing the return number.
  - A completed return counts its received units, not its requested quantity, toward entitlement.
- **New error code `INVALID_RETURN_TRANSITION`** (409): deciding a return that is not pending, or receiving one that is not approved.
- **Statuses:** `pending` → `approved` | `rejected`; `approved` → `completed`. `rejected` and `completed` are final.
- **Numbers:** `RT-001001` onward from a database sequence; lower numbers are reserved for the seed.
- **The order itself is untouched:** no status, version, or line change (the database rejects changes to terminal orders anyway). Concurrency is handled by the return's own status, Serializable transactions, and the entitlement trigger.
- **Orders list:** staff can filter to orders with open returns (`returns=open`: pending or approved), and the summary shows the open return count.
- **Out of scope:** refunds, notifications, partial approval, editing or withdrawing a request, return windows, carriers, Bug Lab changes.

## Data and invariants

- **ReturnRequest:** number, order, status, reason, requester and time; decider, time, and decision reason (required on rejection); receiver, time, and discrepancy reason. A CHECK makes each status carry exactly its data.
- **ReturnRequestItem:** request, shipment item, quantity > 0, and `receivedSellable`/`receivedDamaged` (both null until receipt, then both ≥ 0 with a sum ≤ quantity).
- **Triggers:**
  - items belong to shipments of the request's order;
  - requests move only along the allowed transitions, keep their identity, and are never deleted;
  - items are never deleted and receive their quantities once, only while the request is approved;
  - completing a request requires every item to be received and a discrepancy reason when any item is short;
  - the entitlement rule above.
- **Movements:** new type `RETURN`, bucket `SELLABLE` or `DAMAGED`, delta > 0, no reservation, attributed to the receiving staff member. The enum value gets its own migration first.
- **Demo reset** truncates the new tables and restarts the return sequence. Seed numbers stay below 1001.

## Consistency rules

- Every mutation (request, approve, reject, receive) requires an Idempotency-Key and CSRF, and runs Serializable with bounded retry and atomic audit.
- **Order of checks:**
  - Request: 404 → `INVALID_ORDER_TRANSITION` → 422 → `RETURN_QUANTITY_EXCEEDED`.
  - Decision: 404 (order, then return) → `INVALID_RETURN_TRANSITION` → 422.
  - Receipt: 404 (order, then return) → `INVALID_RETURN_TRANSITION` → 422 (unknown or missing items) → `RETURN_QUANTITY_EXCEEDED` → 422 (missing discrepancy reason on a short receipt).
- A rejected or failed operation changes no stock, movement, or audit.

## API contract

| Endpoint | Access | Behavior |
|---|---|---|
| `POST /api/orders/:orderId/returns` | Retailer (own organization) | `reason`, `items[{shipmentItemId, quantity}]`; 200 with the order |
| `POST /api/orders/:orderId/returns/:returnId/approve` | Operator, administrator | `{}`; 200 |
| `POST /api/orders/:orderId/returns/:returnId/reject` | Operator, administrator | `reason`; 200 |
| `POST /api/orders/:orderId/returns/:returnId/receive` | Operator, administrator | `items[{returnItemId, sellableQuantity, damagedQuantity}]`, optional `discrepancyReason`; 200 |

- **Order responses add:**
  - per shipment item: `id` and `returnableQuantity`;
  - `returns` (number, status, reason, requester, decision, receipt, and items with shipment number, SKU, quantity, and received split).
- **Order summaries add** `openReturnCount`. `GET /api/orders` accepts `returns=open`.

## Audit

Order audit events (entity `order`, so operators see them in audit search):
- `return_requested`: number, reason, and quantities per shipment and SKU;
- `return_approved`;
- `return_rejected`: reason;
- `return_received`: sellable and damaged per SKU, and the discrepancy reason.

## UI acceptance criteria

- **Retailer**, on an eligible order with returnable units:
  - **Request a return** opens a form with one quantity per shipment item (shipment number, SKU, product, shipped, returnable). Quantities default to 0.
  - The reason is required. Client-side validation checks 0 to returnable, at least one unit overall, and reason length.
  - The button names the total, for example "Send return request for 2 units".
- **Staff:**
  - Each pending return has a review panel with **Approve** and **Reject** (reason required).
  - Each approved return has a receipt form: sellable (default: the approved quantity) and damaged (default 0) per item, a discrepancy reason that becomes required when short, and **Record receipt of N units**.
- **All roles:** a Returns section lists every return with status text, items, decision, and the received split. Returns are shown separately from fulfillment quantities.
- **Orders list:** a **Returns** filter (all or open) and an open-returns badge on rows.
- **Inventory:** return movements appear as "Return".
- **Selectors:**
  - Request: `return-request`, `return-request-panel`, `return-request-line` (`data-shipment-number`, `data-sku`), `return-request-quantity`, `return-request-reason`, `return-request-submit`.
  - Review: `return-review` (`data-return-number`), `return-approve`, `return-reject-reason`, `return-reject`.
  - Receipt: `return-receipt` (`data-return-number`), `return-receipt-line` (`data-sku`), `return-receipt-sellable`, `return-receipt-damaged`, `return-receipt-discrepancy`, `return-receipt-submit`.
  - Lists and errors: `return-list`, `return-row` (`data-return-number`, `data-status`), `return-error`, `orders-returns-filter`, `order-open-returns`.
  - Existing selectors are unchanged.
- Keyboard access, field-associated errors, and a 390 px layout without horizontal overflow.

## Deterministic seed (addition, created only if missing)

`RT-000001` on `PO-000008`: pending, 1 × `LOV-EN-STD` from `SH-000001`, reason "One box arrived with a crushed corner".

## Verification

- **API/PostgreSQL** (new `apps/api/checks/returns.mjs`, `check:returns`):
  - Access: only the owning retailer requests (other organization 404, staff 403); only staff decide and receive; CSRF and Idempotency-Key are required.
  - Validation without effects: ineligible statuses, unknown or foreign shipment items, duplicates, bad quantities, a missing reason, and over-entitlement.
  - The full flow: request, approve, full receipt (sellable only), and stock and movements; then a short receipt with sellable and damaged units, which requires a discrepancy reason.
  - Rejection frees entitlement; a completed short return counts only the received units.
  - Transitions: approving, rejecting, or receiving twice, and receiving a pending or rejected return, return `INVALID_RETURN_TRANSITION`.
  - The order status and version never change; replays return the same response; audit events are recorded.
  - Concurrency: parallel requests for the last returnable units leave exactly one successful; parallel receipts of one return add stock once.
  - Rollback: an injected audit failure on receipt leaves no movement, stock, or status change.
  - Database: constraints reject over-entitlement, a second receipt, deleted items, a cross-order item, and invalid `RETURN` movements.
  - Invariants: movement sums equal sellable and damaged stock.
  - OpenAPI documents the routes and the Idempotency-Key header.
- **Browser** (new `apps/web/checks/returns-browser.mjs`, own database): the retailer requests a return with validation; staff approve and record a short receipt with a discrepancy reason; staff reject the seeded return; the Returns list, orders filter, inventory movements, keyboard access, and 390 px layout; no page errors.
- **Regressions:** demo reset (new tables), the orders list, and all existing checks. `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm check:all` pass.

## Implementation results (2026-10-01)

- Implemented as specified. Full evidence and reproduction: [verification](returns-verification.md).
- **API/PostgreSQL:** the new `check:returns` passes 11 of 11, covering access, validation without effects, the full and short flows, transitions, entitlement, concurrency, rollback, and database constraints. The demo reset check now covers the new tables and sequence.
- **Browser:** the new `returns` group passes 8 of 8 on its own database.
- **Full `pnpm check:all`** (run `20261001_070746`): 18 of 18 suites passed, including the build. `pnpm typecheck` and `pnpm lint` pass. `prisma migrate diff` from a migrated QA database to the schema is empty.
- **Design notes:**
  - Receipt validation reports a missing discrepancy reason (422) after an over-quantity (409), because shortness is only meaningful once quantities fit.
  - Return actions are keyed by return status in the UI, because returns do not bump the order version.
  - Staff return panels sit above the shipment form, next to cancellation decisions.

