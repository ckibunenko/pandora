# UX/UI improvements — verification

## Final result (2026-10-01)

Implemented and verified locally on `feature/ux-ui-improvements`, based on
`40be2c8`. The user authorized commit and push on 2026-10-01. No PR, CI run or
merge is recorded for these UI changes yet. Public-demo
preparation remains a separate pending release; no public deployment occurred.

## Gates actually run

- `pnpm build`: pass after the final application edits.
- `pnpm typecheck`: pass.
- `pnpm lint`: pass, including the local review harness.
- `git diff --check`: pass.
- Build, lint and diff whitespace checks were repeated successfully before the
  user-authorized commit/push; application source is unchanged since the final
  browser/visual checks below.
- Source comparison against HEAD: existing `data-test` values and order preserved
  in all 12 changed TSX files. New skip-link and order recovery controls use
  semantic locators; existing row identifiers and role navigation are retained.
- `pnpm check:all --browser --skip-build --evidence /private/tmp/pandora-ux-ui-final-evidence`:
  **8/8 browser groups, 70 check groups**, run `20261001_144944`.

| Browser group | Check groups passed |
| --- | ---: |
| Operations / audit | 9 |
| Fulfillment | 10 |
| Returns | 8 |
| Notifications | 4 |
| Processing + inventory | 7 + 9 |
| Drafts / orders | 11 |
| Administration | 9 |
| Authentication | 3 |

The operations suite now also verifies filtered empty-state recovery without
losing sort/page size, out-of-range page recovery without losing filters, the
skip link's keyboard focus destination, ArrowRight scrolling of a named table
region, the narrow catalog caption boundary and the audit grid layout.

## Visual/layout review

Command: `node --env-file=.env output/ux-ui-inspect.mjs`.

- A fresh QA database: `pandora_ux_ui_review_1790866188922`.
- Built API on 3014, Vite on 5177, Chrome 154 via existing CDP driver.
- A QA-only rejection creates real audit and outbox data; an isolated permanent-
  failure worker makes a delivery diagnostic available. No dev/demo records are
  changed. Processes are stopped and QA databases retained.
- **49/49 screen/viewport observations:** 16 screens at 1440/768/390px plus the
  operator audit view. No page overflow, no JS exceptions; all observed tables
  have named focusable regions and observed form controls have at least 44px
  height. Checkboxes are excluded from the height measurement.
- Final observations/screenshots: `output/ux-ui-evidence/`.
- Visual review: desktop/mobile contact sheets and representative full-size
  screens. Findings and follow-up proposals: [second review](ux-ui-second-review.md).
- Static screenshot gallery: `output/ux-ui-preview.html`; Chrome check verifies
  screen/width controls, image loading, mobile layout and no page exceptions.

## Repairs discovered through verification

- Separate shared filter surfaces from flex/grid layout: audit retains its grid.
- Contain absolutely positioned screen-reader captions in the positioned table
  scroll region to prevent mobile document overflow.
- Keep order SKUs on one line within horizontally scrollable tables.

## Scope and limitations

- No backend, contract, schema, dependency, seed, business-state transition or
  Bug Lab behavior changes. API/PostgreSQL suites and Docker lifecycle checks
  were not rerun for this presentation/UI change; the prior full 20/20 result is
  historical evidence, not a result of this branch's UI verification.
- `catalog-browser.mjs` (external Playwright) and Docker `demo-reset-browser.mjs`
  remain outside the browser runner. The review matrix covers catalog/admin
  catalog/product layout; existing order checks cover variant selection and
  adding to a draft.
- Chrome emulation is not a real-device/cross-browser or full screen-reader
  accessibility audit. There is no stored visual baseline for formal regression.
- Build exits successfully with a PostCSS import-origin warning and a large-
  chunk advisory (~892kB JS, ~241kB gzip). No build/plugin configuration was
  weakened. Runtime and referenced screenshot assets loaded during verification;
  route splitting would be a separate performance change.
- `output/` remains local/untracked. Its gallery, screenshots and review harness
  are review artifacts, not application source or a public deployment.
