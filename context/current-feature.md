## Current Feature

Catalog — fictional board games and expansions, sellable language/edition variants, authenticated browsing, and administrator-only catalog management.

## Status

Implemented and verified — commit/push authorized by the user; merge pending.

## Goal

A signed-in retailer or staff member can browse active products, open a product, explicitly select a variant, and see its SKU, language, edition, and price. An administrator can create, edit, activate, and deactivate catalog records. Changes persist with essential audit records.

## Scope and decisions (2026-09-30)

- Next feature selected after authentication and sessions. Branch: `feature/catalog` (created during specification preparation).
- Defaults implemented under the user's instruction to proceed: EUR as the single configured currency; the fictional seed catalog below.
- Configure `CATALOG_CURRENCY=EUR` on the API, validate it at startup, and return currency with catalog prices. This slice supports EUR only, with two decimal places; currency conversion and runtime currency changes are out of scope.
- Prices are integer minor units (`unitPriceMinor`), including zero, bounded by the PostgreSQL signed integer range (0–2,147,483,647). Never compute currency values with floating-point arithmetic.
- No inventory records, availability labels, quantity input, add-to-order action, drafts, or reservations in this feature. Availability is added when real inventory exists.
- No organization/user administration, order workflow, notifications, Bug Lab, public deployment, image uploads, or audit search UI.
- Preserve the existing authentication/session contracts and demo accounts.

## Data and invariants

### Product

- UUID generated using the existing database convention; name (1–120 characters), fictional publisher (1–120), description (1–2,000), type (`base_game` or `expansion`), optional base product reference, active flag, creation/update timestamps.
- Trim text before validating length; reject blank values and unexpected mutation fields.
- A base game has no base product reference. An expansion references an existing base game, never itself or an expansion.
- Product type and base product reference are fixed after creation for this slice. This keeps the relationship valid while products are edited concurrently.
- Deactivating a base game does not deactivate its expansions: the base game is not required for purchasing an expansion. Browsing an expansion may show its base game's ID and name as relationship metadata, but must not expose inactive variants or offer an unavailable detail link.
- No hard delete. Deactivation preserves IDs and relationships for future order history.

### ProductVariant

- UUID, parent product ID, SKU, language, edition, `unitPriceMinor`, active flag, creation/update timestamps.
- SKU: 3–40 uppercase ASCII letters/digits/hyphens, starts and ends with a letter or digit. Trim and normalize to uppercase on creation; database uniqueness and format constraints use this canonical value.
- SKU and parent product are immutable after creation, including for inactive variants. A SKU is never reused.
- Initial supported languages: `en` and `sr`. Edition is trimmed text of 1–80 characters. Language and edition remain editable; SKU is the stable business identifier.
- Effective visibility requires both product and variant to be active. Deactivating a product does not rewrite its variants' individual active flags.
- Products may exist without variants while being configured; ordinary browsing includes only active products with at least one active variant. Administrators can inspect incomplete and inactive records in management views.
- Enforce foreign keys, SKU uniqueness/format, nonnegative bounded prices, and product type/reference consistency in the database as well as API validation where applicable. Verify the referenced product's type transactionally; its immutable type and restricted deletion preserve that check afterward.

## API contract to implement

Shared Zod request/response schemas belong in `packages/contracts`; document exact schemas and statuses in OpenAPI before implementing endpoint behavior. Use camelCase DTO fields to match existing contracts.

| Endpoint | Access | Behavior |
|---|---|---|
| `GET /api/catalog/products` | All authenticated roles | Active browse list |
| `GET /api/catalog/products/:productId` | All authenticated roles | Visible product details with active variants |
| `GET /api/admin/catalog/products` | Administrator | Management list, including inactive/incomplete records |
| `GET /api/admin/catalog/products/:productId` | Administrator | Management details with all variants |
| `POST /api/admin/catalog/products` | Administrator + CSRF | Create product; return 201 |
| `PATCH /api/admin/catalog/products/:productId` | Administrator + CSRF | Set editable fields/active flag; return 200 |
| `POST /api/admin/catalog/products/:productId/variants` | Administrator + CSRF | Create variant; return 201 |
| `PATCH /api/admin/catalog/products/:productId/variants/:variantId` | Administrator + CSRF | Set editable fields/active flag; return 200 |

- Lists return `{ items, page, pageSize, total }`; default page 1 and page size 20, supported sizes 20/50/100. Page must be a positive integer; an out-of-range page returns an empty list with the correct total.
- List filters: `q` (trimmed, at most 120 characters; literal case-insensitive substring over product name/publisher or eligible variant SKU), `type`, and `language`. Administrator lists additionally support `status=all|active|inactive` (default `all`, referring to the product's own flag).
- Apply filters before pagination, without duplicate products when multiple variants match. Variant-based filters use active variants for ordinary browsing and all variants for administration. A language filter matches products with a qualifying variant; details still return all variants allowed by the endpoint's visibility rules.
- Fixed sort: product name ascending, then unique product ID ascending. Variant order: SKU ascending, then ID. Keep totals and page results consistent within a request.
- List responses contain product summary fields and eligible variant summaries with explicit prices/currency. Do not show a single ambiguous product price or automatically select a variant.
- Missing/hidden product and mismatched product/variant URL ownership return 404 `NOT_FOUND`. Missing session returns 401; forbidden role or invalid CSRF returns 403 using existing codes.
- Invalid UUIDs, unsupported filters, unknown mutation fields, empty patches, immutable fields, invalid prices, and invalid base-game relationships return 422 `VALIDATION_FAILED` with field details. Duplicate canonical SKU returns 409 `SKU_ALREADY_EXISTS` with no partial changes. Reuse the existing validation error envelope.
- Catalog endpoints do not require `Idempotency-Key` in this slice. Disable automatic mutation retries. Product creation after an ambiguous network failure requires checking the management list before retrying; it does not promise replay/deduplication. SKU uniqueness prevents duplicate variants. PATCH sets absolute values; a no-op must not create a new audit event.
- Concurrent edits of the same field use last committed write wins; PATCH updates only explicitly supplied fields. Catalog edit versioning is outside this slice; future draft versioning remains required.

## Essential audit

- Add only the persistence needed for catalog create/update/activation events: actor/user and organization IDs, entity type/ID, action, timestamp from the injected clock, correlation ID, and explicitly selected before/after business fields.
- Commit a catalog mutation and its audit event in the same transaction. Rejected or rolled-back operations leave neither a change nor a success audit event. Audit insertion failure rolls back the mutation.
- Treat audit rows as append-only in application behavior. Do not include credentials, cookies, tokens, or unrelated request data. System-wide search, audit screens, and notification delivery remain later features.
- Seed operations are deterministic setup, not administrator actions; do not invent a user actor or duplicate audit records when reseeding.

## UI acceptance criteria

- Retailers land on `/catalog` after login. Operators retain the existing home until the orders screen exists, with catalog navigation. Administrators land on `/admin/catalog` and can also browse the ordinary catalog.
- Catalog provides product cards, search, type/language filters, and server pagination. Filter changes reset to page 1; loading, empty, and error states are explicit.
- Product details show description, publisher, base/expansion relationship, and an unselected variant control. Selecting a variant reveals its precise SKU, language, edition, and formatted EUR price.
- Administrator list exposes active status and navigation to create/edit product and variant forms. Deactivation is reversible; no delete action.
- Preserve entered data on validation/network failures; associate errors with fields and show a clear success outcome. Disable duplicate submissions while a request is pending and invalidate affected browse/admin queries after successful mutations.
- Follow existing CSS Modules, design tokens, API client, session protection, and TanStack Query patterns. Use the warm palette, semantic HTML, visible focus, and keyboard-accessible controls. Catalog and details must work on narrow screens.
- Document selector coverage during implementation: approximately 80% of automation-relevant targets use stable `data-test` attributes; list intentional semantic-locator exceptions. Scope repeated product targets by product ID and variants by SKU.
- Use original locally stored artwork or simple original placeholders. No real game branding or required external image service.

## Deterministic seed catalog

The following names and publishers are fictional working fixtures, not references to real commercial products.

| Product | Type / parent | Publisher | Variants: SKU / language / edition / price minor units |
|---|---|---|---|
| Lanterns of Velora | Base game | Copper Finch Games | `LOV-EN-STD` / en / Standard / 4200; `LOV-SR-STD` / sr / Standard / 4200 |
| Lanterns of Velora: Mistbound Docks | Expansion / Lanterns of Velora | Copper Finch Games | `LOV-MD-EN` / en / Standard / 1800 |
| Clockwork Orchard | Base game | Amber Meeple Studio | `CWO-EN-STD` / en / Standard / 3500; `CWO-EN-DLX` / en / Deluxe / 5500 |
| The Saltwind Atlas | Base game | Paper Badger Works | `SWA-EN-STD` / en / Standard / 4800 |
| The Saltwind Atlas: Glass Isles | Expansion / The Saltwind Atlas | Paper Badger Works | `SWA-GI-EN` / en / Standard / 2200 |
| Mossbridge Market | Base game | Copper Finch Games | `MBM-SR-STD` / sr / Standard / 2900; `MBM-EN-STD` / en / Standard / 2900 (inactive variant) |
| Tinker's Comet | Base game | Amber Meeple Studio | `TKC-EN-STD` / en / Standard / 0 (zero-price boundary fixture) |
| Echoes of Brindlewood | Base game (inactive) | Paper Badger Works | `EBW-EN-STD` / en / Standard / 3900 (individually active; hidden by parent) |

- Eight products and eleven variants with stable fixture identifiers; rerunning seed produces the same catalog without duplicate products, variants, or audit events.
- Keep seed prices and the product/variant active flags deterministic. Do not seed inventory before the inventory feature.
- Use isolated extra fixtures with at least 21 eligible products for pagination checks; do not inflate the default demo solely for that test.

## Verification and completion

- Check every endpoint's unauthenticated/forbidden/authorized behavior, including direct administrator API calls by an operator and retailer, and missing/invalid CSRF.
- Check visibility through both lists and direct detail URLs, inactive variants, inactive parents, products without variants, and expansion references to inactive base games.
- Check normalized duplicate SKU, including simultaneous creation attempts; price zero/negative/fractional/overflow boundaries; invalid expansion references; immutable fields; unknown fields; and mismatched nested IDs.
- Check search/filter combinations, deterministic page boundaries and totals, no duplicate products, and page sizes 20/50/100.
- Verify persisted data and audit atomicity on real PostgreSQL, including rollback on audit failure. Verify existing identity records remain intact after migration and seed reruns.
- Browser checks cover browse/detail/variant selection, administrator create/edit/deactivate/reactivate flows, error input preservation, keyboard access, narrow layouts, and login/logout regression.
- Run `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Record actual results and any gaps; do not mark the feature complete based on the specification alone.
- Establish reproducible API/DB/browser checks with implementation. A broad unit-test framework and companion portfolio automation setup are not prerequisites for this specification; test/CI ownership remains a separate decision.
- No database reset is needed for this feature plan. Use an additive migration and an isolated database for destructive verification.
- Review changes before commit; committing still requires user permission. Do not merge or delete the branch as part of specification preparation.

## Implementation order

1. Add shared catalog schemas and OpenAPI definitions, configuration, Prisma models, reviewed additive migration, and deterministic seed.
2. Implement authenticated reads and administrator mutations with database constraints and transactional audit.
3. Implement catalog/detail and administrator screens, navigation, cache invalidation, and selectors.
4. Run the verification above, document evidence, and update status/history when implementation is actually complete.

## Implementation results (2026-09-30)

- Catalog models, additive migration and DB invariants, Zod/OpenAPI contracts, authenticated browse API, administrator mutations, and atomic audit are implemented.
- Seed contains 8 products and 11 variants. `CATALOG_CURRENCY=EUR` is required; `.env.example` and local `.env` are updated.
- Catalog/detail screens, variant selection, filters/pagination, administrator forms, role landing routes, cache invalidation, and selector contracts are implemented.
- Real PostgreSQL integration checks: 11 groups passed on a separate QA database. Chrome browser checks: 7 groups passed, including keyboard access and responsive layouts; screenshots inspected.
- Full reproduction instructions, covered cases, design decisions, selector exceptions, and limitations: [features/catalog-verification.md](features/catalog-verification.md).
- Final gates passed: `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check`. Build reports a non-failing JavaScript chunk-size warning.
- Changes are prepared on `feature/catalog`; merge remains pending. Inventory and order workflows remain the next business slices.

## Previous feature

Authentication and sessions is completed and merged as `023f156`. Its full scope, verification notes, and accepted limitations are preserved in [features/auth-sessions.md](features/auth-sessions.md). Public-demo login rate limiting, session cleanup, and automated test/CI setup remain outstanding; they are not silently included in catalog scope.

## History

// Keep this updated earliest to latest

- Initial Next.js setup: bootstrapped project with `create-next-app` (Next.js 16, React 19, TypeScript, Tailwind CSS v4), stripped the boilerplate from `page.tsx` down to a single `<h1>Pandora</h1>`, cleared `globals.css` to just the Tailwind import, removed the default `public/*.svg` assets, and added the `context/` docs referenced from `AGENTS.md`. Committed as "initial setup" and pushed to `origin/main`.
- Architecture setup (2026-09-29): replaced the Next.js starter with a pnpm monorepo skeleton (`apps/web` React/Vite, `apps/api` NestJS, `packages/contracts`, `prisma/`, Docker Compose Postgres) connected through `/api/health` and `/api/health/ready`; rewrote `README.md` and updated `AGENTS.md` and `project-overview.md`. Merged to `main` as `fd36011`. Readiness against a running Postgres is still unverified because Docker was not installed.
- Authentication and sessions (2026-09-30): organizations, users, and Postgres-backed sessions (login, session, logout; 30 min idle / 8 h absolute; role and CSRF guards), API foundations (error envelope, correlation IDs, Zod validation, OpenAPI, JSON logs), deterministic seed with demo accounts, and a login page. OrbStack now provides local Postgres, which also confirmed `/api/health/ready` returns 200. Merged to `main` as `023f156`. Not yet verified: `db:reset` followed by `db:seed`.

- Catalog (2026-09-30, implemented on `feature/catalog`; merge pending): products/variants, EUR prices, browse/admin API and UI, seed, and transactional audit; 11 PostgreSQL/API and 7 browser check groups passed. See the verification record above.
