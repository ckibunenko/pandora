# Returns — verification and handoff

## Implemented scope

- **Return request** (retailer, own organization): `POST /api/orders/:orderId/returns` with a required reason and `items[{shipmentItemId, quantity}]`.
  - Allowed on `partially_shipped`, `shipped`, and `closed_partial` orders; other statuses return 409 `INVALID_ORDER_TRANSITION`.
  - Several open requests per order are allowed. Entitlement keeps them consistent.
- **Entitlement:** per shipment item, pending and approved quantities plus units received by completed returns never exceed the shipped quantity.
  - Rejected returns do not count; completed returns count what actually arrived.
  - It is checked in the Serializable transaction (409 `RETURN_QUANTITY_EXCEEDED`, details `shipments.<SH>.<SKU>`) and again by the `return_request_items_entitlement` trigger.
- **Decisions** (operator, administrator): approve the whole request with `{}`, or reject it with a reason. There is no partial approval, and approval changes no stock.
- **Receipt** (operator, administrator), once per approved return:
  - Every item is listed exactly once with sellable and damaged units.
  - Their sum may be below, but not above, the approved quantity.
  - A short receipt needs `discrepancyReason`.
  - Sellable units raise sellable stock and damaged units raise damaged stock, as `RETURN` movements referencing the `RT-` number.
- **New error codes:** `RETURN_QUANTITY_EXCEEDED` and `INVALID_RETURN_TRANSITION` (409). The second covers deciding a non-pending return and receiving a non-approved one.
- **The order row is never written:** no status, version, or line change. Shipping and cancellation keep working alongside open returns.
- **Order responses** add shipment item `id` and `returnableQuantity`, plus `returns`. Summaries add `openReturnCount`, and `GET /api/orders?returns=open` lists orders with pending or approved returns.
- **Audit:** `return_requested`, `return_approved`, `return_rejected`, and `return_received` on entity `order`, so operators see them in audit search.
- **Migrations:**
  - `20261001100000_returns_enums` adds `MovementType.RETURN`.
  - `20261001100100_returns` adds:
    - the `return_requests` and `return_request_items` tables and the `returns_number_seq` sequence (from 1001);
    - status-data and quantity CHECKs, and the return movement rule;
    - triggers for same-order items, allowed transitions, a single receipt, inspection completeness and discrepancy reasons, no deletes, and entitlement.
  - `prisma migrate diff` from a migrated QA database to `schema.prisma` is empty.
- **Seed:** `RT-000001` pending on `PO-000008` (1 × `LOV-EN-STD` from `SH-000001`).
- **Demo reset:** truncates both new tables and restarts the return sequence. The demo reset check covers both.
- **UI:**
  - Retailer: a **Request a return** form per shipment item with a required reason.
  - Staff: a review panel per pending return and a receipt form per approved one (sellable and damaged per item; the discrepancy reason becomes required when short).
  - All roles: a Returns list.
  - Orders list: a **Returns** filter and an open-returns badge.
  - Inventory: movements labelled "Return".

## Reproduction

From the repository root, with development PostgreSQL running and `.env` configured:

```sh
pnpm check:all --only returns --evidence /private/tmp/pandora-returns-evidence
pnpm check:all
```

- **API suite:** `RETURNS_CHECK_DATABASE=pandora_returns_check_<unique>`, default port 3019. The shared harness refuses nonempty databases.
- **Browser group:** its own seeded database on the runner's QA stack (API 3013, web 5175), Chrome CDP 9341.

## Acceptance evidence

- **API/PostgreSQL: 11 groups**
  - **Setup and access:**
    - seed and returnable quantities, and the open-returns filter and count for staff and both retailers;
    - access (retailer only for requests, staff only for decisions and receipts, other organization 404, CSRF, Idempotency-Key, unknown return 404);
    - validation without effects (ineligible order, unknown or foreign items, duplicates, bad quantities, missing or short reason, over-entitlement).
  - **Flows:**
    - full flow with replays, stock and movements, and audit, with the order status and version unchanged;
    - short receipt with damaged units and a required discrepancy reason, with entitlement counting only received units;
    - transitions on pending, rejected, and completed returns, rejection freeing entitlement, and every item required in the receipt;
    - returns on partially shipped and `closed_partial` orders, with shipping continuing.
  - **Robustness:**
    - concurrent requests for the last units and concurrent receipts;
    - rollback after an injected audit failure;
    - direct-SQL constraints;
    - OpenAPI.
- **Browser: 8 groups**
  - staff find the seeded return through the filter and badge;
  - rejection needs a reason, and the rejected return stays listed;
  - the retailer request form: per-item limits, the reason, keyboard order, and 390 px;
  - the pending request is listed;
  - approval, then a short receipt (over-receipt flagged, discrepancy required, 390 px);
  - the inventory return movement and an empty open-returns filter;
  - the retailer read-only view, where the unit that never arrived can be requested again;
  - no page errors.

## Status and limits

- **Full `pnpm check:all`** (run `20261001_070746`): 18 of 18 suites passed, including the build. There are now eleven API suites and seven browser groups.
- Screenshots of the staff review, the narrow request form, the narrow receipt form, and the received return were inspected.
- **Not covered:**
  - The Docker demo stack (`demo-reset-browser.mjs`) was not run. The database-level demo reset check covers the new tables.
  - Notifications for return events belong to Phase 3 part 2.
