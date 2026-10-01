## Current Feature

Minimal UI polish: original cover art for every catalog product, a calmer product page, a branded sign-in page, and subtle card depth, within the visual direction of overview §8 (warm off-white, terracotta, serif headings, original fictional artwork).

## Status

Implemented and verified locally on `feature/ui-polish`; waiting for commit permission (then PR and CI).

## Scope and decisions (2026-09-30)

- Branch: `feature/ui-polish`. The user asked for a *minimal* polish, so this stays within the documented visual direction and needs no design choice between alternatives.
- **Cover art** (`apps/web/src/features/catalog/ProductCover.tsx`):
  - Abstract SVG art is generated deterministically from the product ID, so it is original and fictional, has no external assets, and each product always gets the same cover.
  - There are five warm palettes and four motifs: sunrise, hex tiles, tokens, peaks. Expansions carry a ribbon.
  - The title and publisher sit on light plates, so they stay readable on any motif.
  - The cover stays `aria-hidden`; the link keeps its accessible name.
- **Cards:** rounded covers with a soft shadow that lift slightly on hover and keyboard focus. The global reduced-motion rule disables the transition.
- **Product page:** the cover is capped at 480 px, so it no longer dominates the page at desktop width.
- **Sign-in page:** a wordmark and one-line tagline above the form, with a terracotta top border and a soft shadow on the card.
- **Unchanged:**
  - every `data-test` selector and the selector contract;
  - all behavior and API contracts;
  - every other page.
- **Out of scope** (follow-up if wanted): shared UI primitives, restyling staff tables and forms, dark mode, and custom illustrations per game.

## Verification

- `pnpm check:all` passes.
- A manual CDP check on the development stack:
  - no horizontal overflow on the catalog and product pages at 390 px and 360 px, or on the sign-in page at 390 px;
  - all 7 visible covers render an SVG;
  - Tab reaches a cover link with a visible 3 px focus outline;
  - no page errors.
- Before and after screenshots inspected: catalog, product page, sign-in page, and narrow catalog.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass.

## Implementation results (2026-09-30)

- Full `pnpm check:all` (run `20260930_203602`): 14 of 14 passed.
- **Manual checks:**
  - no overflow at 390 and 360 px;
  - 7 of 7 covers render;
  - keyboard focus visible (`:focus-visible`, 3 px solid);
  - 0 page errors.
- The Playwright catalog browser check is still not part of `check:all` (external dependency). The catalog layout was covered by the manual checks above.

## Previous feature

[Bug Lab](features/bug-lab.md) is merged as `277925e`; [verification](features/bug-lab-verification.md). Earlier: [sign-in hardening](features/auth-hardening.md), [CI](features/ci.md), [demo reset](features/demo-reset.md), [administration](features/admin-management.md), [fulfillment](features/fulfillment.md), [order processing](features/order-processing.md), [order drafts](features/order-drafts.md), [inventory](features/inventory.md), [catalog](features/catalog.md), [auth](features/auth-sessions.md). Remaining Phase 2: line-level cancellation, audit search, operational lists.

## History

// Keep this updated earliest to latest

- Initial Next.js setup: bootstrapped project with `create-next-app` (Next.js 16, React 19, TypeScript, Tailwind CSS v4), stripped the boilerplate from `page.tsx` down to a single `<h1>Pandora</h1>`, cleared `globals.css` to just the Tailwind import, removed the default `public/*.svg` assets, and added the `context/` docs referenced from `AGENTS.md`. Committed as "initial setup" and pushed to `origin/main`.
- Architecture setup (2026-09-29): replaced the Next.js starter with a pnpm monorepo skeleton (`apps/web` React/Vite, `apps/api` NestJS, `packages/contracts`, `prisma/`, Docker Compose Postgres) connected through `/api/health` and `/api/health/ready`; rewrote `README.md` and updated `AGENTS.md` and `project-overview.md`. Merged to `main` as `fd36011`. Readiness against a running Postgres is still unverified because Docker was not installed.
- Authentication and sessions (2026-09-30): organizations, users, and Postgres-backed sessions (login, session, logout; 30 min idle / 8 h absolute; role and CSRF guards), API foundations (error envelope, correlation IDs, Zod validation, OpenAPI, JSON logs), deterministic seed with demo accounts, and a login page. OrbStack now provides local Postgres, which also confirmed `/api/health/ready` returns 200. Merged to `main` as `023f156`. Not yet verified: `db:reset` followed by `db:seed`.
- Catalog (2026-09-30): products/variants, EUR prices, browse/admin API and UI, seed, and transactional audit; 11 PostgreSQL/API and 7 browser check groups passed (see [features/catalog-verification.md](features/catalog-verification.md)). Independently rechecked before merge, then merged to `main` as `25153bd`.
- Inventory (2026-09-30): stock per SKU with receipts, adjustments, append-only movements, and audit; Idempotency-Key handling and Serializable transactions with bounded retry; catalog availability for all roles. 18 API/PostgreSQL groups (three fresh databases), catalog regression 11/11, and 9 browser groups (two fresh stacks) passed; see [features/inventory-verification.md](features/inventory-verification.md). Merged to `main` as `a9b1134`.
- Order drafts and submission (2026-09-30): shared retailer drafts with version checks, submission with price review and frozen snapshots, retailer cancellation, staff read-only access, Add to draft from the catalog, and demo orders. 16 API/PostgreSQL groups (three fresh databases), inventory and catalog regressions, and 11 order plus 9 inventory browser groups (two fresh stacks) passed; see [features/order-drafts-verification.md](features/order-drafts-verification.md). Merged to `main` as `6665eaa`.
- Order processing (2026-09-30): staff confirmation with all-or-nothing stock reservation (reservation records and movements), rejection with a reason, the operator processing queue, and seed orders for each state. 13 API/PostgreSQL groups (three fresh databases), updated order, inventory, and catalog regressions, and processing 7 / inventory 9 / order drafts 11 browser groups passed; see [features/order-processing-verification.md](features/order-processing-verification.md). Merged to `main` as `4b8d65c`.
- Fulfillment (2026-09-30): immutable shipments that consume reservations and stock, retailer cancellation requests for all remaining quantities with staff approval (releasing reservations) or rejection, the order status derived from quantities and verified by the database, and seed orders for these states. 11 API/PostgreSQL groups (three fresh databases), updated processing, orders, inventory, and catalog regressions, and fulfillment 8 / processing 7 / inventory 9 / order drafts 11 browser groups passed; see [features/fulfillment-verification.md](features/fulfillment-verification.md). Merged to `main` as `e7cf5af`.
- Organization and user administration (2026-09-30): administrator-only organization and account management, immediate session revocation, and distributor/last-administrator protection; fixed retry of commit-time serialization conflicts. API checks 12/12 and typecheck/lint/build passed again before the approved commit on `feature/admin-management`. Earlier browser checks passed 9/9; see [verification](features/admin-management-verification.md). Merged to `main` as `17d5ef5` before starting demo reset automation.
- Isolated demo reset (2026-09-30): dedicated Compose stack, persistent maintenance, stopped API writers, atomic fixture/session/idempotency restoration, readiness-gated reopening, and fail-closed recovery. Verified with 6 database and 5 lifecycle/browser groups plus administration/fulfillment regressions; demo reset 6/6 and administration 12/12 rerun on fresh databases before merge. Merged to `main` as `ada25a1`.
- Test and CI setup (2026-09-30): `pnpm check:all` runs every API/PostgreSQL suite and every CDP browser group on fresh, disposable QA databases. GitHub Actions runs typecheck/lint/build, API checks, and browser checks on pushes to `main` and pull requests. Application checks and CI live in this repository. Locally 11/11 suites passed in about 55 s; on GitHub Actions run `36763707451` (PR #1) all 3 jobs and 11 suites passed; see [features/ci-verification.md](features/ci-verification.md). Merged to `main` as `d0bb179`.
- Sign-in rate limiting and session cleanup (2026-09-30): at most 5 sign-in attempts per normalized email per 15 minutes (429 with `Retry-After`, identical for unknown accounts, digests only, per-email advisory lock so a parallel burst checks exactly 5). Automatic removal of sessions unusable for more than 24 hours. Demo reset also clears attempts. `check:all` gained the auth suites and a per-suite timeout. CI on PR #2 exposed immediate serialization retries colliding, so `runSerializable` now backs off with jitter. Final CI: 3 jobs and 13 suites passed; see [features/auth-hardening-verification.md](features/auth-hardening-verification.md). Merged to `main` as `c239416` + `a564c18`.
- Bug Lab (2026-09-30, Phase 2): exactly one `BUG_LAB_DEFECT` (`BUG-001` persisted wrong fulfillment status, `BUG-002` off-by-one page offset, `BUG-003` current prices on frozen lines), refused in production, on non-`pandora_buglab…` databases, or on a marker mismatch. Includes `pnpm bug-lab setup|start` with scenario fixtures and run manifests, and a catalog, briefs, and solutions in `bug-lab/`. `check:bug-lab` 7/7: the same assertion passes on Standard and fails for the intended reason for each defect; locally `check:all` 14/14; CI green on PR #3; see [features/bug-lab-verification.md](features/bug-lab-verification.md). Merged to `main` as `277925e`.
