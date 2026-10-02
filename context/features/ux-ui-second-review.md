# UI/UX and design: second review

## Scope and evidence

Review after implementing the approved warm visual direction on
`feature/ux-ui-improvements` (2026-10-01). This is a review of the running
application and captured screens, not a usability study with real users.

Chrome 154 on an isolated QA database, API 3014 / web 5177. The review harness
checks 49 screen/viewport combinations: 16 screens at 1440, 768 and 390px plus
the operator audit screen. Screens include sign-in, catalog/product, drafts,
fulfillment/return review, order list/empty states, stock/detail, audit,
notifications, organizations, users and account details. The harness stops its
own API, worker, web and Chrome processes afterward; QA databases are retained.

- Local review gallery: `output/ux-ui-preview.html`.
- Machine observations: `output/ux-ui-evidence/review-results.json`.
- Full-resolution screenshots: `output/ux-ui-evidence/`.
- Existing workflow/browser regression evidence: `/private/tmp/pandora-ux-ui-final-evidence`.

## Design critique

**Overall: 8.0 / 10.** A subjective assessment within the existing B2B visual
direction, weighted toward usefulness and consistency rather than novelty.

| Dimension | Score | Assessment |
| --- | --- | --- |
| Philosophy alignment | 9 | Warm off-white surfaces, restrained terracotta actions and serif headings remain consistent with the spec. |
| Visual hierarchy | 8 | Headings, filter panels, table headers and persistent feedback are distinguishable; long mobile details still require substantial scrolling. |
| Craft quality | 8 | Shared control heights, badges, surfaces and spacing are more consistent; the admin header still wraps unevenly at tablet width. |
| Functionality | 8 | Keyboard shortcuts, named scrolling regions and actionable empty states improve recovery; dense mobile tables still require horizontal exploration. |
| Originality | 7 | Fictional cover artwork and the warm palette give the catalog an identity; operational layouts appropriately use familiar conventions. |

## Keep

- The warm palette and original game covers distinguish Pandora without
  competing with stock/order information.
- Clear section boundaries and subtle row feedback improve scanning without
  filling the tool with decorative cards or animation.
- Text accompanies every status color. The consistent badge treatment also
  covers catalog/account status, return and cancellation records.
- Draft saving, submission, stock reservation and returns remain distinct.
  Recovery actions preserve sort/page-size or filters as appropriate.

## Repairs made during the review

1. The first shared-filter styling accidentally made audit filters use flex
   instead of their intended grid. Shared surface styling is now separate from
   layout; the browser regression asserts the audit grid.
2. Adding readable minimum table widths exposed a mobile overflow: absolutely
   positioned screen-reader captions were not contained by the scroll wrapper.
   The wrapper is now positioned relatively. Narrow catalog regression and the
   49-case matrix verify the result.
3. Order SKUs wrapped across multiple lines in narrow table columns. SKU cells
   now keep the identifier on one line inside the scrollable table.

## Further improvements, ranked

These are follow-up proposals, not additional completed features.

### 1. Make quantities easier to review on a phone — important

At 390px the fulfillment table starts with the product/SKU; shipped, cancelled,
outstanding and reserved quantities sit off-screen. Internal scrolling works
and is keyboard accessible, but comparing quantities still takes effort.

First add a hint only when a region actually overflows. If phone use becomes a
priority, evaluate a compact per-line quantity summary while keeping the desktop
table and every business identifier/selector. Do not silently remove columns or
alter fulfillment totals. Recheck with multi-line orders and long SKUs.

### 2. Shorten the mobile audit filter stack — important

Eight exact-value fields occupy most of a narrow screen before results appear.
Retain entity type/action as the primary controls; consider a labelled expandable
area for IDs and UTC bounds, automatically open when those fields contain values
or errors. Preserve field order, exact matching, Apply filters, URL state and
field-associated validation. This interaction change needs a separate small
specification before implementation.

### 3. Improve orientation on long pages and in admin navigation — polish

At 768px the admin navigation leaves the final link on its own row. Long order
details also separate fulfillment, returns and history by substantial scrolling.

Evaluate deliberate operational/administrative navigation grouping with the same
labels and role permissions. Add local section links using the existing order
section IDs where those sections are present. Preserve normal keyboard order and
make each destination reachable without a sticky overlay hiding its heading.

## Three quick wins for a follow-up

1. A conditional horizontal-scroll hint on overflowing table regions.
2. Persistent UTC format help associated with audit date inputs, so the format
   stays visible after typing.
3. Local jump links to existing shipments/returns/history sections on long
   order details.

## Limits of this review

The viewport matrix checks page overflow, named table regions, audit layout,
control heights and page exceptions. Existing browser suites exercise mutations,
error preservation and role access. Screenshots were visually inspected via
desktop/mobile contact sheets and representative full-size screens.

This is not a full WCAG audit, screen-reader certification, real-device test,
cross-browser test or formal visual regression against a stored baseline.
Semantic badge text colors were calculated against their new tinted backgrounds:
primary 4.89:1, success 5.68:1, danger 6.41:1, neutral 6.73:1; this does not prove
contrast for every rendered element/state.
