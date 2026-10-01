## Current Feature

Bug Lab (Phase 2): an isolated local/QA environment where exactly one known defect (`BUG-001`, `BUG-002`, or `BUG-003`) is switched on. The same business assertion passes in Standard mode and fails in Bug Lab for the intended reason (overview §9, §10 Phase 2).

## Status

Completed — merged to `main` as `277925e` (2026-09-30) through PR #3; CI run `36771619586` passed all 3 jobs and 14 suites.

## Goal

QA learners get reproducible, realistic defects with a catalog entry, a learner brief, a separate solution, and a run manifest. Standard mode stays authoritative, and no Bug Lab setting can reach the public demo.

## Scope and decisions (2026-09-30)

- Branch: `feature/bug-lab`. Phase 2 starts with the Bug Lab. Line-level cancellation, audit search, and operational lists follow as separate features.
- **Selection:**
  - The API reads the optional `BUG_LAB_DEFECT`. Without it, the API runs in Standard mode.
  - Exactly one of `BUG-001`, `BUG-002`, or `BUG-003` is accepted. Unknown IDs and lists such as `BUG-001,BUG-002` stop startup with a clear message.
  - Switching defects means a restart against a newly prepared database; there is no runtime toggle.
- **Isolation (each rule stops startup):**
  1. A defect requires `NODE_ENV` of `development` or `test`. The public demo runs `production`.
  2. A defect requires a database named `pandora_buglab…` (the demo uses `pandora_demo`, and development uses `pandora`).
  3. The database must carry the matching marker `pandora.defect` (set only by the Bug Lab setup tool through `ALTER DATABASE … SET`).
  4. A database with a marker cannot be used by an API without the same defect, and vice versa.
- **Worker and inbox** (added with notifications): `pnpm bug-lab start` also starts a worker with the same defect selection, which refuses the same configurations, delivering to the separate `mailpit-buglab` inbox (SMTP 1026, UI 8026).
- **The defects** (each is a single, explicitly named place in the code):

  | ID | Where | Behavior |
  |---|---|---|
  | `BUG-001` | Shipment status derivation | When an order was already `partially_shipped` and the new shipment ships everything outstanding without any cancellation, it stays `partially_shipped` instead of `shipped`. The Standard database trigger rejects that status. In a database marked `BUG-001`, the trigger skips only that one status check, so the wrong state is really persisted. All other constraints stay active. |
  | `BUG-002` | Order list pagination | For page 2 and later, the offset is one too small. Page 2 repeats the last order of page 1, and the page's true last order is pushed to the next page; when the total is an exact multiple of the page size, it cannot be reached at all. |
  | `BUG-003` | Order detail | Submitted orders show each SKU's current catalog price and a line total computed from it, instead of the frozen snapshot. The stored snapshot and the order total stay correct, so the page contradicts itself. |

- **Unchanged in every mode:** authentication, CSRF, RBAC, retailer isolation, idempotency, audit, and secret handling. The check verifies these for every defect.
- **Setup tool** (`pnpm bug-lab setup --defect BUG-00X|none`):
  - Creates a new database `pandora_buglab_<defect>_<runId>` on the `DATABASE_URL` server, migrates, seeds, and adds **scenario fixtures**: 40 extra draft orders for Tabletop Lantern (`PO-000101`–`PO-000140`), so `BUG-002` can be reproduced by hand.
  - Sets the marker and writes a **run manifest** to `bug-lab/runs/<runId>.json` (gitignored): run ID, defect, database, app version (git commit plus a dirty flag), seed version (hash of the seed sources), and creation time.
  - Prints the command that starts the API and web app against it.
  - `none` prepares the same data without a defect, for Standard comparison.
  - It never drops databases and never touches development or demo databases.
- **Documentation** in `bug-lab/`:
  - `README.md`: how to run it, and the rules.
  - `catalog.md`: ID, title, area, prerequisites, severity, and the business rule broken.
  - `briefs/BUG-00X.md`: what to test and the expected behavior, without the cause.
  - `solutions/BUG-00X.md`: separate files with the cause, the fix, and the assertion.
- **Out of scope:** combined defects, the concurrency defects the overview lists as later extensions, a UI banner, browser Bug Lab checks, and worker or inbox isolation.

## Verification

- **`check:bug-lab`** (new API/PostgreSQL suite in `check:all`):
  - **Configuration rejected at startup:** an unknown ID, several IDs, `production`, a non-Bug-Lab database, a marker mismatch, and a marker without a defect.
  - **For each defect:** the same assertion passes on a Standard database with the same scenario data, and fails on the Bug Lab database with the intended wrong value. Examples: the status is `partially_shipped`; page 2 repeats the boundary order and misses one; the detail price is the new catalog price.
  - **For each defect:** a spot-check of 401, CSRF, 403, and cross-retailer 404, and that the logs hold no passwords.
  - The setup tool writes a complete manifest and refuses bad names.
- Existing suites are unchanged, and `pnpm check:all` and CI pass. `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass.

## Implementation results (2026-09-30)

- Evidence and details: [features/bug-lab-verification.md](features/bug-lab-verification.md).
- `check:bug-lab` passes 7 of 7:
  - configuration refusals;
  - the same assertion passing on Standard and failing for the intended reason for each defect;
  - each defect breaking only its own rule;
  - security in every mode.
- Full `pnpm check:all`: 14 of 14.
- **Corrections:**
  - `pnpm bug-lab start` left vite running after stop; the web server now runs in its own process group.
  - The BUG-002 description was made precise: the boundary order is displaced, and it becomes unreachable only when the total is an exact multiple of the page size.

