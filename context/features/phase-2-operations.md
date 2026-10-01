## Current Feature

Phase 2 operational completion: searchable audit and complete pagination controls.

## Status

Implemented and locally verified on `feature/phase-2-operations` (2026-10-01). Commit approved by the user; PR/CI and merge to `main` remain pending.

## Goal

Staff can investigate committed changes and navigate operational datasets beyond the first page without losing filters or exposing restricted records.

## Scope and decisions

- `GET /api/audit-events` and `GET /api/audit-events/:eventId`, read-only, authenticated staff only. Administrators see all entity types; operators see only `order` and `inventory_item`. A restricted or nonexistent detail returns 404. Retailers receive 403, including when supplying another actor or organization filter.
- Search filters: exact entity type, entity UUID, action, actor UUID, acting organization UUID, correlation ID, inclusive UTC `from`/`to` timestamps. All filters combine with AND and are applied before count/pagination. Organization means the actor's organization recorded at the event, not the order's retailer. No full-text snapshot search.
- Summary: event ID, entity type/ID, action, time, correlation ID, actor ID/name and acting organization ID/name. Summary contains no emails, roles, credentials or sessions. Detail also exposes recorded before/after JSON (administrative snapshots may include account email/role, never credentials). Names are current display names, IDs and snapshots are historical. No new audit mutations.
- Strict queries, UUIDs, nonempty bounded text and chronological UTC timestamps; invalid filters return 422. Shared pagination: 20/50/100 items, page >= 1, stable occurredAt DESC + id DESC, count and data in one RepeatableRead snapshot. A page beyond the end returns an empty page with the actual total.
- Add audit indexes for time/ID, actor/time and acting organization/time. Existing mutation behavior, seeds and Bug Lab guards stay unchanged.
- Existing order, inventory, movement, organization and user APIs already paginate. Complete Orders and Movement history controls with 20/50/100, keep movement page/size in the URL, and verify real page boundaries and authorization for every operational list. Existing selectors remain; add `orders-page-size`, `movement-page-size` and `audit-*` selectors.
- UI: `/audit`, staff navigation; labelled filter form, URL state, reset to page 1 on filter/size changes, previous/next and clear filters, loading/empty/error/retry states, read-only detail with before/after and correlation ID. Keyboard access and no page overflow at 390px.
- Design: extension of Pandora's existing warm operational tables (variance 2, motion 1, density 7, assets 1, fidelity 10). Preserve Georgia/system fonts, existing semantic colors, spacing/radii, button feedback and stable selectors. No new imagery or animation.
- Out of scope: returns, notifications, exports, audit editing, public deployment, separate shipment/cancellation list endpoints and unrelated UI redesigns.

## Verification

- New API/PostgreSQL `check:operations`: access and restricted details; exact/intersecting filters; UTC date boundaries; invalid queries; deterministic multi-page traversal with equal timestamps; 20/50/100 and out-of-range pages; unchanged audit after reads; audit from real mutations and safe password-reset snapshots; pagination/authorization for orders, inventory, movements, organizations and users.
- New CDP operations browser group on its own fresh QA database: create sufficient fixtures through business APIs, audit filtering/detail/navigation, URL persistence, page boundaries and page-size resets, operational controls, error/empty states, operator/retailer access, keyboard and 390px screenshots.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, full `pnpm check:all` including existing concurrency and Bug Lab acceptance checks.

## Implementation results (2026-10-01)

- New API/PostgreSQL checks: 9/9; new CDP browser checks: 7/7. Seed fixtures were created only in dedicated QA databases.
- Full `pnpm check:all`, run `20261001_061434`: 16/16 suites passed, including build, existing concurrency acceptance and all three Bug Lab assertions. Typecheck, lint and `git diff --check` passed.
- Reviewed desktop and narrow screenshots, with keyboard checks and no page overflow at 390, 1024, 1100 and 1280px. Evidence: `/private/tmp/pandora-phase2-final-evidence/operations-browser/`.
- Fixed the obsolete Bug Lab check that assumed its marker migration would always be last. It now compares the manifest with current repository migrations and the actual applied migration; no defect behavior changed.
- Added one audit-index migration, verified on fresh QA databases. Development/demo databases remain unchanged. No dependencies added.
- Full details and reproduction: [verification](features/phase-2-operations-verification.md).
- Phase 2 implementation and local verification are complete; GitHub CI and merge remain pending. Phase 3 (returns/notifications) and public deployment remain planned.

## Previous feature

[Line-level cancellation](features/line-cancellation.md) merged as `37bb2d4` through PR #5; all three CI jobs passed. The remaining Phase 2 scope is addressed in this feature. Returns and notifications belong to Phase 3.
