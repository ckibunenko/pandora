## Current Feature

Inventory — stock per SKU (sellable, reserved, damaged) in the single warehouse, stock receipts and manual adjustments by distributor staff, immutable inventory movements with audit, and available quantity shown in the catalog. This introduces the consistency machinery that every later stock workflow reuses: `Idempotency-Key` handling and Serializable transactions with bounded retry.

## Status

Completed — merged to `main` as `a9b1134` (2026-09-30).

## Goal

A distributor operator or administrator can see stock for every SKU, record a stock receipt, and record a manual adjustment with a reason. Every change produces an inventory movement and an audit event in the same transaction, and retried requests never apply twice. Retailers and staff see each variant's available quantity in the catalog.

## Scope and decisions (2026-09-30)

- Branch: `feature/inventory`.
- Retailers see the exact available quantity (`sellable − reserved`) for each variant, with a note that availability is not a guarantee until an order is confirmed. User decision, 2026-09-30.
- Receipts and adjustments: operator and administrator (overview §3). Retailers get 403 on all inventory endpoints; the catalog availability is their only view of stock.
- `reserved` exists and is enforced now, but stays 0 until order confirmation is built. Nothing in this feature changes it.
- Out of scope: reservations, orders, shipments, returns, damaged-stock disposal workflow, stock counts/cycle counting, multiple warehouses, notifications, audit search UI.
- Stock can be received and adjusted for inactive products and variants: physical stock exists regardless of catalog visibility.

## Data and invariants

### InventoryItem (one per variant)

- Keyed by variant ID. Quantities `sellable`, `reserved`, `damaged` are integers with `0 ≤ reserved ≤ sellable`, `damaged ≥ 0`, all within the PostgreSQL signed integer range. Enforced by database CHECK constraints as well as service logic.
- Every variant has exactly one inventory item: the migration backfills existing variants with zeros, and a database trigger creates the item for every new variant (catalog API and seed included).
- `reserved` cannot be edited directly; it only changes through future reservation workflows.
- Available quantity = `sellable − reserved`. Damaged units are never available.

### InventoryMovement (append-only)

- ID, variant, type (`opening_balance`, `receipt`, `adjustment`; later features add reservation/shipment/return types), bucket (`sellable` or `damaged`), nonzero signed `delta`, resulting `sellable`/`reserved`/`damaged` after the movement, optional receipt reference, reason (required for adjustments), actor and organization (null only for seed opening balances), correlation ID (null only for seed), and `occurredAt` from the injected clock.
- For every variant, `sellable` equals the sum of sellable deltas and `damaged` equals the sum of damaged deltas. Checked in verification.

### Operations

- **Receipt:** `quantity` 1–1,000,000, optional `reference` (1–80 chars, e.g. a delivery note) and `note` (1–500). Adds to `sellable`. Resulting quantity above the integer range returns 422 on `quantity`.
- **Adjustment:** `bucket` (`sellable` | `damaged`), nonzero `delta` between −1,000,000 and 1,000,000, `reason` 3–500 chars. The result must keep every invariant; otherwise 409 `INSUFFICIENT_STOCK` with no changes.
- Text fields are trimmed; unknown fields are rejected.

## Consistency rules (overview §7)

- **Idempotency-Key** is required on receipts and adjustments (1–255 printable ASCII characters). Scope: organization, actor, operation, and target variant. The canonical payload hash and committed response are persisted.
  - Missing key → 400 `IDEMPOTENCY_KEY_REQUIRED`.
  - Same key, same payload, completed → replay the original status and body without new effects.
  - Same key, different payload → 409 `IDEMPOTENCY_KEY_REUSED`.
  - Same key while the first request is still running → 409 `REQUEST_IN_PROGRESS`. An in-progress claim has a short lease so a crashed request cannot block the key forever.
  - A failed or rolled-back operation leaves no completed idempotency record, movement, audit event, or quantity change. Access checks run before any replay.
- **Transactions:** receipts and adjustments run in short PostgreSQL Serializable transactions: reread the item → validate → update quantities → insert movement and audit → complete the idempotency record → commit. Serialization or write conflicts retry the whole transaction, up to 3 attempts; exhaustion returns 409 `CONCURRENT_MODIFICATION`.

## API contract

| Endpoint | Access | Behavior |
|---|---|---|
| `GET /api/inventory` | Operator, administrator | Paginated stock list |
| `GET /api/inventory/:variantId` | Operator, administrator | One item with product/variant summary |
| `GET /api/inventory/:variantId/movements` | Operator, administrator | Paginated movements, newest first |
| `POST /api/inventory/:variantId/receipts` | Operator, administrator + CSRF + Idempotency-Key | Record receipt; 201 with movement and item |
| `POST /api/inventory/:variantId/adjustments` | Operator, administrator + CSRF + Idempotency-Key | Record adjustment; 201 with movement and item |

- Pagination follows the catalog: `page` (positive integer), `pageSize` 20/50/100, response `{ items, page, pageSize, total }`.
- Stock list filters: `q` (literal case-insensitive substring of SKU or product name, ≤120 chars) and `stock` (`all` | `available` | `unavailable`, where unavailable means available quantity 0). Sort: product name, SKU, variant ID.
- Movements sort: `occurredAt` descending, then ID descending.
- Unknown variant → 404 `NOT_FOUND`. Invalid UUIDs, filters, or bodies → 422 `VALIDATION_FAILED` with field details.
- Catalog responses add `availableQuantity` to every variant (browse and admin).

## Audit

- One audit event per receipt/adjustment, in the same transaction as the movement: entity `inventory_item` (variant ID), action `received` or `adjusted`, before/after quantities, and the movement ID. Seed opening balances are setup, not audited.

## UI acceptance criteria

- Staff navigation gets **Inventory** (`/inventory`) for operators and administrators. Operators still land on the existing home until the orders screen exists.
- `/inventory`: table with SKU, product, language/edition, sellable, reserved, damaged, available, and catalog status; search, stock filter, and server pagination; explicit loading, empty, and error states. Rows are scoped by SKU.
- `/inventory/:variantId`: current quantities, a receipt form, an adjustment form, and the movement history with pagination. Forms preserve input on errors, link errors to fields, disable double submission, and show a clear success message. After success, affected inventory and catalog queries are invalidated.
- A form keeps one idempotency key for a submission and its retries, and generates a new key after success or after the input changes.
- Catalog product details show `Available: N` for the selected variant with the not-a-guarantee note.
- Selectors: `data-test` attributes for all functional targets, following the existing contract. Repeated rows are scoped by `data-sku`.

## Deterministic seed

Opening balances (sellable / damaged); reserved is 0 everywhere. Covers normal, low, zero, damaged, and inactive cases.

| SKU | Sellable | Damaged | Case |
|---|---|---|---|
| `LOV-EN-STD` | 40 | 0 | normal |
| `LOV-SR-STD` | 12 | 0 | normal |
| `LOV-MD-EN` | 3 | 0 | low |
| `CWO-EN-STD` | 25 | 0 | normal |
| `CWO-EN-DLX` | 0 | 0 | zero |
| `SWA-EN-STD` | 18 | 2 | damaged units present |
| `SWA-GI-EN` | 1 | 0 | boundary: one unit |
| `MBM-SR-STD` | 9 | 0 | normal |
| `MBM-EN-STD` | 5 | 0 | inactive variant |
| `TKC-EN-STD` | 60 | 0 | normal |
| `EBW-EN-STD` | 7 | 0 | inactive product |

- Seed writes an opening balance only for variants that have no movements yet, so rerunning it never rewrites stock that later receipts or adjustments changed and never duplicates movements.

## Verification

- Access: every endpoint unauthenticated (401), retailer (403), operator and administrator allowed; missing/invalid CSRF (403).
- Receipts and adjustments: quantities, movements, audit, and sum-of-movements invariant on real PostgreSQL; bounds (0, negative, fractional, overflow); adjustments that would go below zero or below reserved return 409 with no side effects.
- Idempotency: missing key, replay, reused key with a different payload, in-progress conflict, and no record after a failed request.
- Concurrency: parallel adjustments that together would go negative produce exactly one success; parallel identical requests with one key produce one effect.
- Rollback: an injected audit failure leaves no movement, quantity change, or completed idempotency record.
- Catalog shows `availableQuantity`; seed rerun keeps stock and movement counts unchanged.
- Browser: stock list, filters, receipt, adjustment, error preservation, retailer availability display, keyboard access, narrow layout, and login/logout regression.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` pass. Record actual results and gaps.

## Implementation results (2026-09-30)

- Implemented as specified. Full evidence, reproduction steps, selectors, and limitations: [inventory-verification.md](inventory-verification.md).
- API/PostgreSQL: 18 check groups passed on three fresh QA databases. Catalog regression: 11 of 11. Browser: 9 groups passed on two fresh QA stacks, including a lost-response retry that applied only once.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass.
- Additions beyond the written spec:
  - The operator home page links to Inventory; without it, operators had no route there.
  - The pagination schemas are shared through a new `pagination.ts` contract module.
  - The catalog's audit writes go through the shared `recordAudit` helper.
- The migration was renamed to `20260930130000_inventory` so it runs after the catalog migration on fresh databases.

