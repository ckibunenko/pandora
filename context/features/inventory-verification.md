# Inventory verification and handoff

## Implemented scope

- Stock per SKU (`sellable`, `reserved`, `damaged`) with one `InventoryItem` per variant. A migration backfilled existing variants, and a database trigger creates the item for every new variant.
- Receipts and adjustments for operators and administrators. Each writes an append-only `InventoryMovement` and an `AuditEvent` in the same Serializable transaction.
- Consistency machinery for later stock workflows:
  - `IdempotencyService` (`apps/api/src/common/idempotency/`) with scoped keys, request hashes, replay of the committed response, and an in-progress lease that a later request can take over.
  - `runSerializable` (`apps/api/src/infrastructure/prisma/serializable.ts`), which retries the whole transaction up to 3 times and then returns 409 `CONCURRENT_MODIFICATION`.
  - `recordAudit` (`apps/api/src/common/audit/audit.ts`), shared with the catalog.
- Catalog variants expose `availableQuantity` (sellable − reserved), and retailers see it on product details with a not-a-guarantee note.
- Web: `/inventory` list and `/inventory/:variantId` detail with receipt and adjustment forms and the movement history. Operators and administrators see Inventory in navigation, and operators also get it on their home page.
- Seed: opening balances for all 11 variants (normal, low, zero, damaged, inactive), written only for variants without movements.

Not included: reservations, orders, shipments, returns, damaged-stock disposal, stock counts, multiple warehouses.

## Design decisions

- **Database backstops for invariants:**
  - CHECK constraints: `0 ≤ reserved ≤ sellable`, `damaged ≥ 0`, movement type rules, and attribution (only seed opening balances may lack an actor or correlation ID).
  - Triggers: movements reject UPDATE and DELETE, and a trigger creates an inventory item for every variant.
- **Idempotency:**
  - **Claims:** a claim is committed in its own short transaction, so concurrent requests with the same key can see it. The business work and the claim's completion commit together.
  - **Failed requests** release the claim, so they leave no completed record and the same key can be retried.
  - **Only successful (201) responses are stored.**
  - **Scope:** organization, actor, operation, and target variant.
  - **Request hash:** built from the validated, trimmed payload, so whitespace-only differences replay instead of conflicting.
  - **Lost claims:** a request whose lease expired and was taken over rolls back and returns `REQUEST_IN_PROGRESS`.
- **Adjustment errors:** a change that would make stock negative, or leave sellable below reserved, returns 409 `INSUFFICIENT_STOCK`. Its detail names how many units can be removed.
- **Web retries:** a form keeps one `Idempotency-Key` per intended change. Editing any field or a successful submit replaces the key. A lost response keeps the key, so resubmitting replays the original result instead of applying the change twice.
- **Shared contracts:** the pagination schemas moved from `catalog.ts` into `packages/contracts/src/pagination.ts` so both features share them. The catalog's private `audit()` now delegates to `recordAudit`, with unchanged behavior.
- **Migration order:** the migration is named `20260930130000_inventory` so it sorts after `20260930120000_catalog`. The first generated timestamp sorted before the catalog migration and would have failed on a fresh database.

## API / PostgreSQL checks

`apps/api/checks/inventory.mjs` uses Node assertions against the real API and PostgreSQL:

- It requires a new, empty QA database and refuses a nonempty one.
- It applies all migrations, seeds, starts its own API on port 3012 (`INVENTORY_CHECK_PORT`), and stops it afterwards.
- It never touches the development database.

From the repository root, after `pnpm build`:

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" pandora_inventory_check_unique'
INVENTORY_CHECK_DATABASE=pandora_inventory_check_unique pnpm --filter @pandora/api check:inventory
```

Covered groups (18):

1. **Seed:** one item per variant, 11 opening movements, movement sums equal quantities, no audit; a reseed changes nothing.
2. **Access:** 401 without a session and 403 for retailers on every endpoint; 403 without CSRF; no side effects.
3. **List:**
   - schema and sort order (product name, then SKU);
   - case-insensitive search by SKU and product name, with a literal `%`;
   - `stock` filter and pagination;
   - 422 for invalid query values and 404 for an unknown variant.
4. **Receipt:** 201; quantity, movement, audit, and idempotency record written together; correlation ID and actor recorded; reference trimmed.
5. **Receipt validation:** 0, negative, fractional, too large, string, missing, unknown field, too-long or blank reference, unknown variant. Nothing is written.
6. **Receipt overflow:** exceeding the integer range returns 422 on `quantity` without changes.
7. **Adjustments:** below zero (sellable and damaged) returns 409; zero delta, short reason, `reserved` bucket, fraction, too large, or missing reason returns 422; valid sellable→damaged moves are recorded with audit.
8. **Reserved units:** a sellable adjustment cannot go below `reserved`, and the catalog then shows `availableQuantity` 0.
9. **Idempotency basics:** missing key 400; malformed key 422; replay returns the identical body with no new effects; the same key with another payload returns 409; a key is independent per actor and per target.
10. **Failed requests:** leave no idempotency record, and the same key can be retried.
11. **In-progress claims:** a live claim returns 409 `REQUEST_IN_PROGRESS`; an expired claim is taken over and completed.
12. **Concurrency, same key:** 6 parallel identical requests with one key apply exactly once; the others replay or return `REQUEST_IN_PROGRESS`.
13. **Concurrency, removals:** 6 parallel −1 adjustments on 3 units give exactly 3 successes, stock 0, and no oversell.
14. **Rollback:** an injected audit failure returns 500 and leaves no movement, quantity change, or idempotency record; the same key then succeeds.
15. **Database constraints:** direct UPDATE or DELETE of movements, negative stock, reserved greater than sellable, and unattributed receipts are all rejected.
16. **Movements endpoint:** newest first, paginated, schema-valid; the opening balance has a null actor.
17. **Catalog:** `availableQuantity` equals sellable − reserved for every visible variant.
18. **OpenAPI and logs:** OpenAPI lists all inventory routes with the `Idempotency-Key` header, and the logs contain no credentials or tokens.

## Browser checks

`apps/web/checks/inventory-browser.mjs` drives local Chrome over the DevTools protocol, so it adds no dependencies (`CHROME_PATH` overrides the Chrome binary). It needs a freshly seeded QA stack:

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" pandora_inventory_browser_unique'
# Apply migrations and seed that database with DATABASE_URL pointing at it (same connection settings, new database name):
#   (cd apps/api && DATABASE_URL=… pnpm exec prisma migrate deploy && DATABASE_URL=… node --env-file=../../.env dist/seed/seed.js)
# API on 3013 against that database, and a web server proxying to it:
#   (cd apps/api && DATABASE_URL=… API_PORT=3013 NODE_ENV=test node --env-file=../../.env dist/main.js)
API_PORT=3013 pnpm --filter @pandora/web dev --port 5175 --strictPort
node --env-file=.env apps/web/checks/inventory-browser.mjs
```

Covered groups (9):

1. The operator reaches Inventory from home and navigation; the list shows seeded stock, and zero availability is highlighted.
2. Search and the stock filter narrow the list; the filter is kept in the URL.
3. **Receipt:** client-side validation marks the field invalid; a successful receipt updates the stock summary and adds a history row; the form clears.
4. **Adjustment rejected by the server:** the error is linked to the delta field and the input is preserved; a valid adjustment then succeeds.
5. **Lost response:** a receipt response is dropped after the server committed it. The UI asks to retry, keeps the input, and the resubmit reuses the key: stock rises by 3 once and exactly one movement is added.
6. **Keyboard:** the receipt fields and submit button are reachable with Tab and have a visible focus outline.
7. **Narrow layout:** at 390px the list and detail have no horizontal page overflow.
8. **Retailer:** no Inventory navigation; `/inventory` shows "Access restricted"; product details show `Available: 7` and the note.
9. The administrator also reaches inventory; no page errors were raised during the run.

Screenshots are saved to `$TMPDIR/pandora-inventory-evidence` (`INVENTORY_CHECK_EVIDENCE` overrides this).

## Selector contract

Repeated rows are scoped by `data-sku` (inventory rows) and `data-movement-id` (movement rows).

- **Navigation:** `inventory-nav` (layout navigation and operator home).
- **List:**
  - Search and filters: `inventory-search`, `inventory-search-submit`, `inventory-stock-filter`, `inventory-clear-filters`.
  - Results and rows: `inventory-total`, `inventory-row`, `inventory-detail-link`.
  - Paging and errors: `inventory-page-size`, `inventory-page`, `inventory-previous`, `inventory-next`, `inventory-retry`.
- **Detail:** `inventory-sku`, `stock-sellable`, `stock-reserved`, `stock-damaged`, `stock-available`.
- **Forms:**
  - Receipt: `receipt-form`, `receipt-submit`, `receipt-success`, `receipt-error`.
  - Adjustment: `adjustment-form`, `adjustment-submit`, `adjustment-success`, `adjustment-error`.
  - Fields (via the shared `CatalogFormField`): `field-quantity`, `field-reference`, `field-note`, `field-bucket`, `field-delta`, `field-reason`.
- **History:** `movement-row`, `movement-page`, `movement-previous`, `movement-next`.
- **Catalog:** `variant-available`, `availability-note`.

Intentional semantic-locator exceptions: both back links, the retry buttons on the detail and movement errors, the "Clear filters" button inside the error alert, and the "Access restricted" return link. Status and error text is also reachable via `role=status` / `role=alert`.

## Results — 2026-09-30

- **API/PostgreSQL:** all 18 groups passed on three separate fresh QA databases (`pandora_inventory_check_20260930_110133`, then `…_r2` and `…_r3`).
- **Catalog regression:** `apps/api/checks/catalog.mjs` passed 11 of 11 groups on a fresh database (`pandora_catalog_check_20260930_110151`).
- **Browser:** all 9 groups passed on two separate fresh QA stacks (`pandora_inventory_browser_20260930_110307` and `…_110510_r2`). Screenshots were inspected: list, detail, narrow detail, and retailer availability.
- **Found and fixed during verification:** the operator home page had no route to Inventory; it now links there. Two failures came from the browser script itself, not the app (an in-page selector evaluated in Node, and acting before a re-render); the script was fixed.
- **Development database:** the additive migration was applied without a reset, the seed ran twice (11, then 0 opening movements), and movement sums matched.
- **Final gates:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass. The build keeps the existing non-failing large-chunk warning.

## Limitations and follow-ups

- The Playwright-based `apps/web/checks/catalog-browser.mjs` was not re-run, because it needs an external Playwright install. Catalog UI changes are limited to the availability row and note, which the inventory browser checks cover.
- Inventory UI reuses catalog styles, `CatalogFormField`, and `useExpiredSession` across features. Move these into shared `components/` and `lib/` when the next feature needs them.
- The movement history in the UI uses a page size of 20; the API supports 20, 50, and 100.
- Carried over: login rate limiting, session cleanup, test/CI setup, and foreign keys on audit events.
