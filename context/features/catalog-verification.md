# Catalog verification and handoff

## Implemented scope

Catalog read API and administrator mutations, Zod/OpenAPI contracts, an additive PostgreSQL migration, deterministic seed (8 products / 11 variants), EUR configuration, transactional audit, catalog/detail screens, and administrator product/variant forms. Product type/base relationship and variant SKU/parent are immutable. Products and variants are deactivated instead of deleted.

No inventory availability, ordering, notifications, image uploads, or audit search UI. Product covers are original typographic placeholders. Public-demo auth limitations from [auth-sessions.md](auth-sessions.md) remain.

## Design record

Extension of the existing Pandora system: warm background `#f7f3ec`, surface `#fffdf9`, terracotta `#a4523a`, Georgia headings, system sans-serif body, existing 4px spacing rhythm and 4/8px corner tokens. Stable product grid for browsing; table and split forms for staff. No new UI dependencies or font downloads. Motion is limited to 140ms color feedback and respects the existing reduced-motion rule.

Design dials: variance 2, motion 1, density 6, asset dependence 2, brand fidelity 10. Primary journeys are browse → choose edition and manage → save. Login semantics, session/CSRF handling, and existing auth selectors are preserved; role landing routes change as specified.

## API / PostgreSQL checks

`apps/api/checks/catalog.mjs` uses Node assertions against the actual API and PostgreSQL. It requires an explicitly named, empty local QA database and refuses a nonempty database before migrations/seed. It does not reset development data. It applies both migrations, seeds twice, runs 11 groups of checks, then stops its API process. QA data remains available for inspection and browser checks.

From the repository root, after `pnpm build`, create a **new** local database for each run (substitute a unique suffix):

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" pandora_catalog_check_unique'
CATALOG_CHECK_DATABASE=pandora_catalog_check_unique pnpm --filter @pandora/api check:catalog
```

The runner reads the root `.env`, changes only the database name in its own process, sets `NODE_ENV=test`, and starts an isolated API on port 3011. Set `CATALOG_CHECK_PORT` if that port is occupied. Never point this harness at a shared database.

Covered groups:

1. Authentication on all eight endpoints; operator/retailer denial on admin routes; missing/invalid CSRF; no audit side effects.
2. Ordinary/admin visibility, inactive parent and variant handling, literal search escaping, combined filters, query validation, response schemas, page sizes.
3. Product/variant creation, canonical SKU, zero/maximum price, fractional/negative/overflow rejection, actor/correlation attribution, no-op audit, nested ID ownership.
4. Immutable/unknown fields and invalid expansion relationships leave counts unchanged.
5. Database constraints reject invalid direct writes.
6. Product/variant deactivation/reactivation, independent expansion visibility, preserved variant flags.
7. Two parallel requests for the same canonical SKU produce one 201, one 409, one variant, and one audit event.
8. An injected audit-insert failure rolls back product creation and update; no successful audit survives. Injection exists only inside the isolated QA database and is removed in `finally`.
9. 41 products with tied names and multiple matching variants paginate as 20/20/1/0 with stable ID ordering and correct totals.
10. OpenAPI exposes all catalog routes.
11. Session and logout regression.

## Browser checks

`apps/web/checks/catalog-browser.mjs` uses an existing external Playwright installation and local Chrome; no browser dependency was added to the application. Set `PANDORA_PLAYWRIGHT_MODULE` to the absolute path of the installed package's `index.mjs`, or make `playwright` resolvable normally.

Start the API with `DATABASE_URL` pointing to the QA database from the previous check (preserve the local connection settings, replace only the database name), `API_PORT=3011`, `NODE_ENV=test`, and `CATALOG_CURRENCY=EUR`. Then start a separate web server:

```sh
API_PORT=3011 pnpm --filter @pandora/web dev --port 5174
PANDORA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node --env-file=.env apps/web/checks/catalog-browser.mjs
```

By default the harness opens `http://localhost:5174` and saves screenshots to `/private/tmp/pandora-catalog-evidence`. Override with `CATALOG_CHECK_WEB_URL` and `CATALOG_CHECK_EVIDENCE`. The harness verifies the API fixture signature (41 `Boundary QA` products) before making browser mutations. It creates additional QA records without removing existing data.

Seven groups cover keyboard login/focus, role landing routes, product creation and validation, duplicate SKU error/input preservation, variant edit and decimal parsing, deactivation/reactivation, catalog filters/pagination, explicit variant selection/reload, empty/error states, role restriction, logout, and narrow layouts. Browser `pageerror` events fail the check.

## Selector contract

Scope repeated products by `data-product-id` and variants by `data-sku`. Never locate by row index or generated CSS classes. Existing `login-*`, `current-user`, and `logout-button` selectors remain stable.

- Navigation: `catalog-nav`, `catalog-admin-nav`, `product-create`, `product-preview`.
- Lists: `catalog-search`, `catalog-search-submit`, `catalog-type`, `catalog-language`, `catalog-status`, `catalog-total`, `catalog-page-size`, `catalog-page`, `catalog-previous`, `catalog-next`, `catalog-retry`, `catalog-clear-filters`, `catalog-clear-invalid-filters`.
- Products: `product-card`, `product-detail-link`, `product-row`, `product-edit`, `product-form`, `product-active`, `product-save`.
- Variant details: `variant-select`, `selected-variant`, `base-product-link`.
- Variant administration: `variant-row`, `variant-create`, `variant-edit`, `variant-form`, `variant-active`, `variant-save`.
- Fields: `field-name`, `field-publisher`, `field-description`, `field-type`, `field-baseProductId`, `field-sku`, `field-language`, `field-edition`, `field-unitPriceMinor`.
- Base-game pagination: `base-product-previous`, `base-product-next`.

Intentional semantic-locator exceptions: Pandora wordmark; operator Home navigation; secondary product-title link in browse cards; secondary `Edit <product name>` table link; both back links; variant Done/Cancel button; base-game loading retry; product-detail loading retry; admin-detail loading retry; restricted-access return link. Status/error text is located by `role=status`/`role=alert`. This keeps approximately 80% of distinct functional/observation targets under named test attributes.

## Results — 2026-09-30

- Additive catalog migration applied to local development PostgreSQL without resetting it; seeded demo catalog loaded.
- Fresh QA database `pandora_catalog_check_20260930_1`: both migrations applied, seed repeated with 8 products / 11 variants / 6 users / 4 organizations, all 11 integration groups passed.
- Chrome against isolated API/web on ports 3011/5174: all 7 browser groups passed, no page errors, no horizontal page overflow at tested widths.
- Screenshots inspected at desktop 1440×900 and narrow 390×844; responsive checks additionally covered 768 and 1280px widths. Evidence is local in `/private/tmp/pandora-catalog-evidence`.
- Final gates passed: `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Build emits a non-failing large-JavaScript-chunk warning; code splitting is not part of this slice.
- The existing development API process needed a restart to load the new module. Development smoke passed on web/API ports 5173/3000 (7 visible products, 8 administrative products). Temporary QA servers were stopped after verification; the isolated QA database and screenshots are retained.
- Browser automation used an existing temporary Playwright installation. Cross-browser coverage, CI setup, public-demo hardening, and portfolio E2E ownership remain separate work.
