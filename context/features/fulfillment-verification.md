# Fulfillment: verification and handoff

## Implemented scope

- **Shipments** (operators and administrators): `POST /api/orders/:orderId/shipments` with `version` and `items[{orderLineId, quantity}]`.
  - Each shipment is an immutable record numbered `SH-001001` onward (lower numbers are reserved for the seed).
  - For every item it increases the line's shipped quantity and consumes the reservation.
  - It lowers `sellable` and `reserved` by the same amount, so available stock is unchanged, and writes two `shipment` movements (`sellable −q`, `reserved −q`) that reference the shipment number.
- **Cancellation after confirmation** (overview §6, Phase 1 scope):
  - `POST /api/orders/:orderId/cancellation-requests` (retailer): requests all outstanding quantities.
  - `POST /api/orders/:orderId/cancellation-requests/:requestId/approve` (staff).
  - `POST /api/orders/:orderId/cancellation-requests/:requestId/reject` (staff, reason required).
  - A pending request releases nothing, and shipping may continue.
  - Approval rechecks the requested quantities against what is still outstanding (409 `CANCELLATION_CONFLICT` if something shipped meanwhile). It then increases the cancelled quantities, releases the reservations, and writes `release` movements, so available stock rises.
  - At most one pending request per order (409 `CANCELLATION_REQUEST_PENDING`).
- **Derived statuses:** after confirmation the status is derived from line totals: `confirmed`, `partially_shipped`, `shipped`, `cancelled`, `closed_partial`. `shipped`, `closed_partial`, `cancelled`, and `rejected` are terminal. A cancellation approved after confirmation records the approver and the request reason on the order.
- **Retailer cancellation:** retailers still cancel drafts and submitted orders directly. After confirmation they must use a request (`INVALID_ORDER_TRANSITION` explains this).
- **Web:**
  - Orders after confirmation show a fulfillment table (ordered, shipped, cancelled, outstanding, reserved), the shipment list, and the cancellation-request list.
  - Staff get a shipment form (defaulting to everything outstanding) and a review panel for a pending request (approve, or reject with a reason).
  - Retailers get **Request cancellation of remaining items**, or a pending notice.
  - New statuses appear as text badges and status filters.
  - Inventory history labels `Shipment` and `Reservation released` movements.
- **Seed** (created only if missing):
  - `PO-000008`: partially shipped, `LOV-EN-STD` 2 of 5 shipped via `SH-000001`.
  - `PO-000009`: confirmed, `MBM-SR-STD` × 2, with a pending cancellation request.

## Design decisions

- **Migrations:** new enum values have their own migration (`20260930160000_fulfillment_enums`); tables, sequences, constraints, and triggers are in `20260930160100_fulfillment`.
- **Database backstops:**
  - `shipped + cancelled ≤ quantity` per line.
  - After submission, line quantities can only grow, and only while the order is `confirmed` or `partially_shipped`. Every other column stays frozen.
  - The order trigger allows the documented transitions only, and checks that each status after confirmation matches the derivation table computed from the line totals.
  - Shipments, shipment items, and cancellation request items are append-only, and each item must belong to its parent's order.
  - A cancellation request can be decided once, and its status must match its decision data.
  - Movement type rules now cover `shipment` (sellable or reserved, negative, with a reservation) and `release` (reserved, negative, with a reservation).
- **Shipment movement snapshots:** the two movements of one shipment item share the stock snapshot taken after both buckets change. Applying them one at a time could briefly break `reserved ≤ sellable`. The per-bucket sums stay exact.
- **Reservation delete guard:** it now uses the generic append-only function, which fixes the misleading message noted in the order-processing handoff.
- **Racing cancellation requests:** a race between two requests is resolved by the partial unique index. The API maps that violation to `CANCELLATION_REQUEST_PENDING`.
- **Web code:** order-page helpers moved to `apps/web/src/features/orders/order-helpers.ts`; the fulfillment UI is in `OrderFulfillment.tsx`.

## API / PostgreSQL checks

`apps/api/checks/fulfillment.mjs` (`pnpm --filter @pandora/api check:fulfillment`) uses port 3016 by default (`FULFILLMENT_CHECK_PORT`) and the shared `checks/harness.mjs`:

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" pandora_fulfillment_check_unique'
FULFILLMENT_CHECK_DATABASE=pandora_fulfillment_check_unique pnpm --filter @pandora/api check:fulfillment
```

Covered groups (11):

1. **Seed:** seeded fulfillment states are present and the invariants hold.
2. **Access:** retailers cannot ship or decide; staff cannot request; another retailer gets 404; an unknown request gets 404; no session → 401; missing CSRF → 403; missing key → 400; no side effects.
3. **Shipment validation:** empty items, unknown or foreign lines, 0 / negative / fractional quantities, and duplicate lines return 422. Too many units returns `SHIPMENT_QUANTITY_EXCEEDED` with the SKU; a stale version returns `VERSION_CONFLICT`. None of these change anything.
4. **Partial then full shipment:**
   - Sellable and reserved drop by the same amount and available stock is unchanged.
   - Two movements per item, the status goes `partially_shipped` → `shipped`, and a replay is a no-op.
   - Once shipped, further shipments and cancellation requests are rejected.
5. **Request then approve with nothing shipped:** the order becomes `cancelled`, attributed to the approver with the request's reason. The release movement restores availability, and the pending request itself releases nothing.
6. **Conflict path:**
   - Shipping continues while a request is pending, and a second request returns `CANCELLATION_REQUEST_PENDING`.
   - Approval then returns `CANCELLATION_CONFLICT` with no effect.
   - Rejection requires a reason (a short one returns 422). A new request can then be approved, and the order ends `closed_partial`.
7. **Parallel shipments:** parallel shipments of the last units produce one success and no over-shipping.
8. **Parallel requests:** duplicate requests leave exactly one pending. A shipment racing an approval never double-counts: exactly one wins, and shipped + cancelled = ordered.
9. **Rollback:** an injected audit failure leaves no shipment, movement, stock change, or idempotency record; the same key then succeeds.
10. **Database constraints:** these direct writes are rejected:
    - over-shipping, or shrinking a shipped total;
    - a status that does not match the quantities;
    - editing or deleting a shipment;
    - a shipment item from another order;
    - a second pending request, or an approval without decision data;
    - deleting a reservation (now reported as "append-only").
11. **OpenAPI and logs:** all four routes are documented with the `Idempotency-Key` header, and the logs contain no credentials or tokens.

The invariant check verifies, for every variant: the sellable and reserved sums of movements, `reserved = Σ remaining reservations`, and `reserved ≤ sellable`. For every line it verifies `consumed = shipped`, `released = cancelled`, and `shipped = Σ shipment items`.

## Browser checks

`apps/web/checks/fulfillment-browser.mjs` uses the shared CDP driver on a freshly seeded QA stack (API on 3013, web on 5175).

Covered groups (8):

1. **Progress view:** staff see `PO-000008` progress (shipped 2, outstanding 3, reserved 3) and `SH-000001`.
2. **Recording a shipment:** 9 units is flagged in the browser; 1 unit is recorded as a second shipment; outstanding drops to 2.
3. **Keyboard and layout:** Tab reaches the submit button with visible focus; no horizontal overflow at 390px.
4. **Reviewing a request:** `PO-000009`'s pending request shows the SKU and reason. Rejecting without a reason is flagged; approving cancels the order (cancelled 2) and removes the shipment form.
5. **Retailer request:** the retailer requests cancellation of the 2 remaining units on `PO-000008` with a reason. A pending notice replaces the button, and retailers never see a shipment form.
6. **Approval:** staff approve, and the order becomes "Closed (partly cancelled)" with shipped 3, cancelled 2, reserved 0.
7. **Full shipment:** shipping everything on `PO-000006` marks it Shipped, and `LOV-SR-STD` inventory history shows the `Shipment` movements with the shipment number.
8. **Final state and page errors:** the retailer sees `PO-000009` cancelled with an approved request and no request button; no page errors were raised.

## Selector contract

- **Fulfillment table:** `order-line-shipped`, `order-line-cancelled`, `order-line-outstanding`, `order-line-reserved`.
- **Shipment form:** `shipment-form`, `shipment-line` (scoped by `data-sku`), `shipment-quantity`, `shipment-submit`, `shipment-error`.
- **Shipment list:** `shipment-list`, `shipment-row` (scoped by `data-shipment-number`).
- **Staff review:** `cancellation-review`, `cancellation-approve`, `cancellation-reject`, `cancellation-reject-reason`, `cancellation-error`.
- **Retailer request:** `cancellation-request`, `cancellation-request-panel`, `cancellation-request-reason`, `cancellation-request-submit`, `cancellation-request-error`, `cancellation-pending`.
- **Request list:** `cancellation-request-list`, `cancellation-request-row` (scoped by `data-status`).

Intentional semantic-locator exceptions: the "Keep order" button in the request panel, and the form-level "enter at least one quantity" alert, located by `role=alert`.

## Results — 2026-09-30

- **API/PostgreSQL:** 11 of 11 on three fresh QA databases (`pandora_fulfillment_check_20260930_143125`, `…_143137_r2`, `…_143140_r3`).
- **Regressions on fresh databases**, updated to the new seed: processing 13 of 13 (`pandora_processing_check_20260930_143142_reg`), orders 16 of 16 (`…_143145_reg`), inventory 18 of 18 (`…_143148_reg`), catalog 11 of 11 (`…_143151_reg`).
- **Browser:**
  - Fulfillment 8 of 8 on two fresh stacks (`pandora_fulfillment_browser_20260930_143233` and `…_143353_r2`).
  - Processing 7 of 7 and inventory 9 of 9 on `pandora_processing_browser_20260930_143309_f`.
  - Order drafts 11 of 11 on `pandora_orders_browser_20260930_143332_f`.
  - Screenshots inspected: partially shipped, closed (partly cancelled), narrow layout, retailer pending request.
- **Development database:** both migrations were applied without a reset, and the seed ran twice (2, then 0 new orders). Manual API checks covered every path, including the conflict path.
- **Final gates:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass. The existing chunk-size warning remains.

## Limitations and follow-ups

- Retailers can request cancellation only of **all** remaining quantities; choosing lines or quantities is Phase 2 (overview §10).
- There is no carrier, tracking, or delivery confirmation (out of scope for the MVP).
- Every browser suite must run on its own fresh database, because the suites change the same seed orders.
- Carried over:
  - login rate limiting, session cleanup, and test/CI setup;
  - audit foreign keys and shared UI primitives;
  - minimal organization and user administration;
  - demo reset automation;
  - the Playwright catalog browser harness, which was not re-run.
