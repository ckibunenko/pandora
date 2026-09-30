# Bug Lab: verification and handoff

## Implemented scope

- **Selection:**
  - `BUG_LAB_DEFECT` is parsed with Zod in `app-config.ts` and accepts exactly one of `BUG-001`, `BUG-002`, or `BUG-003`. Without it, the API runs in Standard mode.
  - Startup refuses a defect when `NODE_ENV=production`, and on any database not named `pandora_buglab…`.
- **Database marker:**
  - `pnpm bug-lab setup` sets `ALTER DATABASE … SET pandora.defect`.
  - `BugLab.onModuleInit` (`apps/api/src/common/bug-lab/bug-lab.ts`) requires the marker to equal `BUG_LAB_DEFECT` in both directions: a Standard API on a marked database, or a defect API on an unmarked or differently marked database, refuses to start.
- **Defects:** one guarded place each, all in `OrdersService`.
  - `BUG-001`, in `ship`: the final shipment of an already `partially_shipped` order keeps `PARTIALLY_SHIPPED`.
    - Migration `20260930200000_bug_lab_marker` re-creates `enforce_order_rules` unchanged except for one exemption: that exact state (`PARTIALLY_SHIPPED` where `SHIPPED` is derived), and only when the marker is `BUG-001`.
    - A `diff` against the fulfillment definition shows only that condition changed.
  - `BUG-002`, in `list`: the offset is `(page − 1) × size − 1` from page 2 on.
  - `BUG-003`, in `lineDto`: frozen lines show the variant's current price and a line total computed from it. The stored snapshot and the order total are untouched.
- **Tooling (`scripts/bug-lab.mjs`):**
  - `setup` creates a database, migrates, seeds, loads scenario fixtures (`apps/api/src/seed/bug-lab-scenario.ts`: 40 drafts for Tabletop Lantern, so 45 in total), marks the database, and writes a manifest to `bug-lab/runs/<run>.json`.
    - The manifest holds the run ID, defect, mode, database name, commit and dirty flag, seed version (hash of the seed sources), latest migration, and time. It contains no credentials.
  - `start` serves the app on 5176 with the API on 3020. The web server runs in its own process group, so stopping it leaves nothing running.
  - Database creation and marking moved to `scripts/lib/databases.mjs`, which `check-all` also uses. It validates names and refuses the development and demo databases.
- **Learner material (`bug-lab/`):** README (rules and how to run), catalog (area, severity, broken rule, prerequisites), three briefs, and three separate solutions.

## Design decisions

- **The persisted wrong state for `BUG-001`:** the overview describes the order as *left* `partially_shipped`, so the state is stored, not only displayed. The Standard trigger stays authoritative. The marker exemption is limited to the single defect state, and the check confirms that an unrelated wrong status is still rejected in the `BUG-001` database.
- **Isolation in depth:**
  - The configuration rules stop production and non-Bug-Lab databases.
  - The marker ties a database to exactly one defect.
  - The demo (`NODE_ENV=production`, database `pandora_demo`) fails the first two rules.
  - Development (`pandora`, unmarked) fails the database rule.
- **The Standard comparison uses the same scenario data** (`--defect none`). The assertion is identical for both modes and returns what it observed, so the failure reason is asserted exactly.
- **No worker or inbox exists yet.** When they arrive, they must read the same selection and refuse the same configurations.

## API / PostgreSQL checks

`apps/api/checks/bug-lab.mjs` (`pnpm --filter @pandora/api check:bug-lab`) prepares its own databases through `pnpm bug-lab setup`: one Standard and one per defect. It uses ports 3021–3025.

1. **Manifests and markers:**
   - The manifest is complete and has no credentials.
   - The marker matches the defect (none for Standard), and the scenario gives Tabletop Lantern 45 orders.
   - `setup` refuses `BUG-004`.
2. **Startup refused** (a non-zero exit with a clear message) for:
   - an unknown ID, or two IDs;
   - `production`;
   - the `pandora_demo` database, or a non-Bug-Lab QA database;
   - a marker mismatch (`BUG-002` on a `BUG-001` database);
   - a marked database without a defect;
   - a defect on an unmarked database.
3. **`BUG-001`:**
   - Standard reaches `shipped`.
   - Bug Lab observes exactly `{status: partially_shipped, outstanding: 0, shipments: 2}`. The stored status is `PARTIALLY_SHIPPED`, and an unrelated wrong status is still rejected.
4. **`BUG-002`:** Standard page 2 equals rows 21–40. Bug Lab has exactly one repeated order and one order missing from page 2.
5. **`BUG-003`:** Standard keeps the submitted prices. Bug Lab shows the new catalog price, and the stored snapshot still holds the submitted price.
6. **Each defect breaks only its own rule:** on every Bug Lab database, the other two assertions pass.
7. **Security in every mode:** 401, cross-retailer 404, retailer 403, and missing CSRF 403. The logs contain no password, hash, or session cookie.

## Results — 2026-09-30

- `check:bug-lab`: 7 of 7 on the first run, and again inside the full run.
- **Full `pnpm check:all`** (run `20260930_201302`): all 14 passed.
  - API: catalog, inventory, orders, processing, fulfillment, admin, demo-reset, auth, bug-lab.
  - Browser: fulfillment, processing + inventory, orders, admin, auth.
- **Manual run:**
  - `pnpm bug-lab setup --defect BUG-001` wrote a manifest.
  - `pnpm bug-lab start` served `/api/health/ready` → 200 on 5176.
  - The first stop left the vite process running; the web server now runs in its own process group. After the fix, stopping leaves no listener on 3020 or 5176.
- **Development database:** the migration was applied with `db:deploy` (no reset). The database has no marker, so it behaves as before.
- **Correction:** the first BUG-002 write-up said the boundary order "disappears". It is pushed to the next page, and it becomes unreachable only when the total is an exact multiple of the page size. The catalog, solution, and spec were corrected.

## Limitations and follow-ups

- There are no browser checks for the defects. The API assertions are the contract, and the briefs guide manual exploration in the UI.
- There is no UI banner showing Bug Lab mode. Learners use the dedicated port 5176 and the manifest.
- Worker and inbox isolation must be added with notifications (Phase 3).
- Combined defects and concurrency defects are later extensions (overview §9).
- Local Bug Lab databases accumulate; the tools never drop them.
