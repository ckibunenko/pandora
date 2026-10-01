## Current Feature

Minimal UI polish: original cover art for every catalog product, a calmer product page, a branded sign-in page, and subtle card depth, within the visual direction of overview §8 (warm off-white, terracotta, serif headings, original fictional artwork).

## Status

Completed — merged to `main` as `bf6f472` (2026-10-01) through PR #4; CI run `36819845588` passed all 3 jobs and 14 suites.

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

