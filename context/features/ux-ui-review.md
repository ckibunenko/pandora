# UX/UI review and implementation brief

## Status

Specification and source review completed on 2026-10-01 at `40be2c8`.
The user authorized continuing with the proposed visual direction and requested
a second UI/UX/design review after implementation (2026-10-01). Implementation,
verification and the second review are complete locally on
`feature/ux-ui-improvements`; the user authorized commit and push on 2026-10-01.
PR/merge remain pending. Public demo preparation is preserved in
[public-demo-prep.md](public-demo-prep.md); its PR/merge and deployment remain pending.

## Product baseline

Reviewed overview sections 3–8, coding standards, and the UI acceptance criteria
for catalog, inventory, drafts, processing, fulfillment, line cancellation,
returns, notifications, operational pagination/audit, and administration.
Also inspected the shell, shared catalog styling/pagination, operational list
screens, order styling, administration styling, form fields, and sign-in styles.

This is **Redesign · Preserve**: improve the existing B2B application for
retailers, warehouse operators, and administrators. Preserve routes, navigation
labels, role permissions, form submission semantics, query parameters,
idempotency, business rules, artwork, and every existing selector. Preserve the
explicit distinction between draft saving, submission, and stock reservation,
and keep returns separate from fulfillment.

## Findings and proposed repairs

| Priority | Source observation | Proposed repair | Verification |
| --- | --- | --- | --- |
| 1 | `CatalogLayout.tsx` has no skip link to the main content. Administrators traverse eight navigation links before reaching page controls. | Add a focus-visible skip link and an addressable main region. | Keyboard reaches the main content; existing navigation and role landing pages work. |
| 1 | Orders, inventory, catalog administration, organizations/users and several detail tables use a bare `tableScroll` wrapper. Audit and notifications already use named, focusable regions. | Apply the existing named-region pattern consistently to tables that need horizontal scrolling. | At narrow widths, tables scroll internally; keyboard users can focus and scroll the region; page has no overflow. |
| 1 | Orders' filtered empty state can suggest creating a draft or say that no retailer has created an order, even when existing orders were excluded by filters. Out-of-range pages also share that message. | Distinguish no records, no filter matches, and an empty page; offer a relevant reset/previous-page action. | Status/returns filters and page size still persist in the URL; page reset produces the expected records. |
| 1 | Operator audit copy says “ORDERS & INVENTORY” and describes only orders/stock, while `OPERATIONAL_TYPES` includes notifications. | Include delivery events in the scope explanation. | Copy agrees with the notification spec and existing redacted operator view. |
| 2 | Shared tables have transparent backgrounds and little row feedback; numeric alignment exists only where feature CSS is applied. | Improve table-header separation, row hover/focus-within feedback and visual grouping using existing surface/border tokens; retain numeric alignment. | Inspect representative short/long rows, links, focus outlines, and narrow layouts. |
| 2 | Badge styling is repeated across Orders, Administration and Notifications; confirmed/rejected orders use filled badges while equivalent states elsewhere use outlines. | Use a consistent badge shape and semantic color treatment while keeping all visible labels and data attributes. | All order, return, account and delivery states remain identifiable by text, including without color. |
| 2 | Catalog filters, audit filters and notification filters have different spacing/border treatments; pagination is separated by both large padding and margin. | Normalize spacing and section boundaries within the existing design system; keep dense operational screens readable. | All filter labels, inputs, actions and pagination controls remain visible at desktop and narrow widths. |
| 2 | Shared success/error messages are mostly plain text with vertical padding; operational forms use a single terracotta-bordered panel treatment. | Give persistent feedback and form sections clearer grouping, with text plus semantic colors. | Errors remain associated with fields; input and retries survive errors; consequential buttons remain disabled while pending. |
| 2 | Login controls lack the explicit 44px minimum already used by operational controls. | Apply consistent input/button minimum heights and state feedback. | Sign-in, field errors, keyboard focus and narrow layout remain usable. |

The initial findings above came from specification/source inspection while the
dev stack was stopped. Implementation was subsequently verified on isolated QA
stacks: [verification](ux-ui-verification.md). The [second review](ux-ui-second-review.md)
records visual findings and follow-up priorities.

## Design decisions

- **Narrative role:** a working operational tool; tables and actions carry the
  hierarchy, catalog artwork remains the visual centerpiece of browsing.
- **Viewing distance:** laptop/desktop first; catalog and order review also work
  on a phone. Keep useful information density instead of enlarging every block.
- **Temperature:** warm and restrained, with clear feedback.
- **Capacity:** eight admin navigation links must wrap deliberately; long SKUs,
  identifiers and operational tables remain readable in internal scroll regions.
- **Design Read:** variance 2, motion 1, density 7, asset dependence 1, brand
  fidelity 10. Use familiar layouts, existing assets and minimal state feedback.
- **Palette:** retain background `#f7f3ec`, surface `#fffdf9`, text `#1f1b16`,
  muted text `#5c544a`, border `#ddd3c4`, terracotta `#a4523a`/hover `#8a4330`,
  success `#2f6b3f`, danger `#a12a2a`, and focus `#1f5fa8`.
- **Typography:** existing Georgia headings and system sans-serif body;
  tabular numerals for stock, quantities and money.
- **Spacing/radii:** existing 4px spacing scale and 4px/8px radii; repair
  inconsistent spacing rather than introduce a new scale.
- **Shadows:** preserve cover/sign-in depth; operational tables and forms use
  borders and surfaces for grouping.
- **Motion:** current 140–160ms hover/state transitions only; honor the existing
  reduced-motion rule.

## Implementation sequence

1. Create a dedicated `feature/ux-ui-improvements` branch and document the active
   work in `context/current-feature.md`, retaining public-demo preparation notes.
2. Produce an early viewable implementation of the shared navigation, table,
   filter, badge and feedback treatments for review.
3. Apply the agreed treatments to operational screens, repair the specific
   empty-state/scope copy issues, and normalize sign-in controls.
4. Verify in the browser under the project workflow on isolated QA resources:
   administrator/operator/retailer navigation; catalog/order review; operational
   lists; keyboard access; 1440px, 768px and 390px layouts; relevant error and empty
   states; no page errors. Record screenshots and the actual results.
5. Run typecheck, lint, build and the affected existing browser suites. Review
   the diff and selector contract. Request commit approval only after these pass.

The highest-risk changes are focus/navigation behavior and feedback markup.
Keep each change small and independently reviewable. No new dependency, backend
endpoint, migration, business feature, theme mode or hosting action is needed.
