# Order processing: verification and handoff

## Implemented scope

- **Staff decisions:** operators and administrators confirm or reject submitted orders:
  - `POST /api/orders/:orderId/confirm` with `version`;
  - `POST /api/orders/:orderId/reject` with `version` and `reason`.

  Both need CSRF and an `Idempotency-Key`, and both return 200.
- **Confirmation** reserves every line in one Serializable transaction. For each line it creates one `StockReservation`, increases `inventory_items.reserved`, and writes a `reservation` movement in the `reserved` bucket (referencing the order number). The order becomes `confirmed`, and an order audit event records the reserved quantities.
- **All or nothing:** if any line lacks stock, the response is 409 `INSUFFICIENT_STOCK` naming only the short SKUs; nothing changes.
- **Rejection** records the reason. It has no stock effect.
- **Retailers:** they cannot cancel confirmed orders yet (`INVALID_ORDER_TRANSITION`). Cancellation requests after confirmation come in a later feature.
- **API list changes:** `GET /api/orders` supports `status=confirmed|rejected` and `sort=submitted_asc` (the processing queue). Order responses add confirmation and rejection details, `reservedQuantity` per line, and the current `availableQuantity` per line while an order is submitted.
- **Web, staff:**
  - Orders navigation for every role. Operators land on "Orders awaiting processing" (`/orders?status=submitted&sort=submitted_asc`); administrators reach it from navigation.
  - A submitted order shows, per line, the available stock and a "Short by N" or "Covered" flag, plus a shortage summary.
  - Confirm and reject panels (rejection requires a reason). Confirmed orders show a Reserved column, and the history shows confirmation and rejection.
- **Web, retailers:** confirmed and rejected orders are read-only.
- **Inventory:** reservation movements appear in the movement history, and the stock list shows reserved stock and lower availability.
- **Seed** (created only if missing):
  - `PO-000005`: submitted, cannot be confirmed (`CWO-EN-DLX` has no stock).
  - `PO-000006`: confirmed, with a reservation of `LOV-SR-STD` × 2.
  - `PO-000007`: rejected with a reason.

## Design decisions

- **Enum migration:** the new enum values have their own migration (`20260930150000_order_processing_enums`), because PostgreSQL cannot use a value in the same transaction that adds it. The constraints and triggers follow in `20260930150100_order_processing`.
- **Order data and transitions (database):**
  - Each status requires exactly its lifecycle data (CHECK).
  - The trigger allows only draft → submitted/cancelled and submitted → confirmed/rejected/cancelled. Rejected and cancelled orders are terminal.
  - An order can become confirmed only if every line has a reservation.
- **Reservations (database):**
  - A reservation must cover its order line exactly (same variant, full quantity), and only while the order is submitted.
  - Its identity and reserved quantity are immutable, and it cannot be deleted.
  - `consumed + released ≤ reserved`.
- **Movements (database):** the movement-type CHECK now also covers reservations: a reservation movement is in the `reserved` bucket, has a positive delta, and references its reservation. Receipts and adjustments can never touch `reserved`.
- **Contracts:** adjustments keep their own bucket schema (`sellable`/`damaged`). Movement responses use a wider bucket schema that includes `reserved`, so `bucket: "reserved"` in an adjustment is still a 422.
- **Confirmation check:** confirmation checks stock against `sellable − reserved`, read inside the Serializable transaction. Concurrent confirmations that race for the same units serialize: the retry sees the reduced stock and returns `INSUFFICIENT_STOCK`.
- **Seed attribution:** the seeded confirmed order is attributed to the demo operator, with correlation ID `seed-PO-000006`, because reservation movements must always carry an actor and a correlation ID.
- **Test helpers:** API checks now have a shared setup module, `apps/api/checks/harness.mjs`. The new processing checks use it; the older check files are unchanged.

## API / PostgreSQL checks

`apps/api/checks/order-processing.mjs` (`pnpm --filter @pandora/api check:processing`) uses port 3015 by default (`PROCESSING_CHECK_PORT`):

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" pandora_processing_check_unique'
PROCESSING_CHECK_DATABASE=pandora_processing_check_unique pnpm --filter @pandora/api check:processing
```

Covered groups (13):

1. **Seed:** the seeded submitted, confirmed (with reservation), and rejected orders exist; the reserved invariants hold; a reseed changes nothing.
2. **Access:** retailers get 403 and requests without a session get 401; CSRF and `Idempotency-Key` are required; rejected requests change nothing.
3. **Queue:** oldest submission first; the confirmed and rejected filters work; submitted order details show current availability; an invalid sort returns 422.
4. **Insufficient stock:** 409 names only `CWO-EN-DLX`. No reservation, movement, or version change is written, and no idempotency record is kept.
5. **Confirm:**
   - One reservation per line, with inventory `reserved` and movements (actor, correlation, reference) updated together.
   - The audit event records the reserved quantities.
   - Catalog availability drops by the reserved amount.
   - A replay returns the identical body with no new effects.
6. **Transitions:**
   - After confirmation, confirming again, rejecting, retailer cancellation, and line edits all return `INVALID_ORDER_TRANSITION`.
   - Confirming a draft or a rejected order returns `INVALID_ORDER_TRANSITION`; a stale version returns `VERSION_CONFLICT`.
7. **Reject:** a missing, blank, too-short, or too-long reason, or an unknown field, returns 422. A valid rejection trims the reason, is attributed, has no stock effect, and the retailer sees the reason.
8. **Last unit:** two orders competing for the last unit — exactly one is confirmed, with no oversell.
9. **Three units:** five orders competing for three units — exactly three are confirmed.
10. **Same order in parallel:** four parallel confirmations of one order with different keys create exactly one set of reservations.
11. **Rollback:** an injected audit failure leaves no reservation, movement, stock change, or idempotency record; the same key then succeeds.
12. **Database constraints:** these direct writes are rejected:
    - reserving a draft line;
    - a partial reservation;
    - confirming without reservations;
    - deleting a reservation, or changing its reserved quantity;
    - over-consuming a reservation;
    - moving a confirmed order back to submitted;
    - editing a rejected order;
    - a reservation movement without a reservation.

    The API also rejects `bucket: "reserved"` in an adjustment with 422.
13. **OpenAPI and logs:** confirm and reject are documented with the `Idempotency-Key` header, and the logs contain no credentials or tokens.

The shared invariant check verifies, for every variant: `reserved = Σ reserved-bucket deltas = Σ remaining reservations` and `reserved ≤ sellable`.

## Browser checks

`apps/web/checks/order-processing-browser.mjs` uses the shared CDP driver and a freshly seeded QA stack, set up like the inventory and order browser checks (API on 3013, web on 5175).

Covered groups (7):

1. **Queue:** the operator lands on "Orders awaiting processing", with `PO-000002` before `PO-000005`.
2. **Shortage:** `PO-000005` shows "Short by 2" for `CWO-EN-DLX` and "Covered" for `LOV-SR-STD`, with no horizontal overflow at 390px. Confirming fails with a message naming the SKU and stating that nothing was reserved; the order stays submitted.
3. **Rejection:** the reason is required and the field is flagged; the submit button is reachable with Tab and shows focus; the history records the rejection with its reason.
4. **Confirmation:** confirming `PO-000002` shows "reserves 13 units across 2 lines"; the order becomes Confirmed, the Reserved column shows 3 and 10, and the history shows the confirmation.
5. **Inventory:** `CWO-EN-STD` shows 25 / 3 / 0 / 22 (sellable, reserved, damaged, available), and the movement history shows "Reservation … +3 reserved … PO-000002". The empty queue says "Nothing is waiting for a decision."
6. **Retailers:** Tabletop Lantern sees `PO-000002` confirmed with reserved quantities and no cancel button, and catalog availability 22. Cardboard Keep sees `PO-000005` rejected with the reason.
7. **Administrator and page errors:** the administrator lands on catalog management and reaches the queue from navigation; no page errors were raised.

## Selector contract

- **Navigation:** `orders-nav` (all roles; for staff it opens the queue).
- **List:** `orders-sort`, in addition to the existing order list selectors.
- **Staff review:**
  - Line status: `order-line-available`, `order-line-shortage`, `order-line-covered`, `order-shortage-summary`.
  - Confirming: `order-confirm`, `order-confirm-panel`, `order-confirm-submit`, `order-confirm-error`.
  - Rejecting: `order-reject`, `order-reject-panel`, `order-reject-reason`, `order-reject-submit`, `order-reject-error`.
- **Confirmed orders:** `order-line-reserved`.

Intentional semantic-locator exceptions: the Back buttons inside both panels.

## Results — 2026-09-30

- **API/PostgreSQL:** 13 of 13 on three fresh QA databases (`pandora_processing_check_20260930_120813`, `…_120827_r2`, and `…_120834_r3`).
- **Regressions on fresh databases**, with expectations updated to the new seed: orders 16 of 16, inventory 18 of 18 (the invariant now covers `reserved`), catalog 11 of 11.
- **Browser:**
  - Processing 7 of 7 and inventory 9 of 9, on two fresh stacks (`pandora_processing_browser_20260930_121102` and `…_121307_r2`).
  - Order drafts 11 of 11, on a separate fresh stack (`pandora_orders_browser_20260930_121202_p`), because it changes the same seed orders.
  - Screenshots inspected: queue, shortage review, narrow review, confirmed order.
- **Found and fixed during verification:**
  - The empty-queue message now says "Nothing is waiting for a decision" instead of implying no orders exist.
  - The shortage message had a doubled period.
- **Development database:** both migrations were applied without a reset, and the seed ran twice (3, then 0 new orders).
- **Final gates:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass. The existing chunk-size warning remains.

## Limitations and follow-ups

- The delete guard on `stock_reservations` reuses the movement guard function, so its error message says "Inventory movements are append-only". The rule is enforced; only the message is generic.
- Reserved stock is only created in this feature. Consuming it (shipments) and releasing it (cancellations after confirmation) come with the next features, together with the derived shipment statuses.
- Browser suites that change the same seed orders must run on separate fresh databases (documented above).
- Carried over: login rate limiting, session cleanup, test/CI setup, audit foreign keys, shared UI primitives, and the Playwright catalog browser harness, which was not re-run.
