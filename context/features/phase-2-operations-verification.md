# Phase 2 operations — verification and handoff

## Implemented scope

- Read-only `GET /api/audit-events` and `GET /api/audit-events/:eventId`, with shared Zod/OpenAPI contracts and authenticated role guards.
- Administrators can read every business audit entity. Operators can read only `order` and `inventory_item`, regardless of caller-supplied filters. A detail outside their scope returns 404. Retailers are forbidden.
- Exact AND filters: entity type/UUID, action, actor UUID, acting organization UUID, correlation ID, inclusive UTC start/end. Organization attribution is the organization of the actor at the time of the write; it is not the order's retailer. No wildcard or full-text payload search.
- Summaries omit snapshots, emails, roles, credentials and session fields. Detail returns existing before/after JSON; administration snapshots can include account email and role, but never passwords, hashes or tokens. Actor/organization names are current lookup values; recorded IDs and snapshots remain unchanged. Missing names fall back to IDs.
- Pagination uses the existing 20/50/100 contract. Audit count, page and name lookup share a RepeatableRead snapshot; ordering is occurredAt DESC then id DESC. Later pages are separate snapshots, so concurrent inserts may shift offsets between page requests. Out-of-range pages return an empty list with the actual total.
- Migration `20261001090000_audit_search` adds time/ID, actor/time and acting-organization/time indexes. No new business table, seed or reset policy is needed.
- Staff navigation and `/audit` + `/audit/:eventId` UI: URL filters/pagination, field validation, read-only snapshots, loading, empty, error and retry states; preserved filters on returning from detail.
- Orders and Movement history gain 20/50/100 controls. Movement history now uses the URL for page and size. Shared pagination was extracted from administration without changing existing selectors. Inventory and administration controls retain their behavior.
- The Bug Lab manifest check now verifies the current latest migration and the database's actually applied migration. It no longer assumes the Bug Lab marker migration stays last forever; defect logic and assertions are unchanged.

## Reproduction

From the repository root, with development PostgreSQL running and `.env` configured:

```sh
pnpm check:all --only operations --evidence /private/tmp/pandora-operations-evidence
pnpm check:all
pnpm typecheck
pnpm lint
```

The runner creates fresh QA databases on the configured server, never modifies the development database and never drops the QA databases. The new API suite uses `OPERATIONS_CHECK_DATABASE=pandora_operations_check_<unique>` and refuses nonempty databases through the shared harness. Its default API port is 3018. Browser checks use the runner's QA stack on API 3013/web 5175 and Chrome CDP 9340, plus a separate seeded database.

`--only operations` runs both the new API suite and browser group. They are also included automatically in CI's existing `check:all --api` and `check:all --browser` jobs. No dependencies were added.

## Acceptance evidence

- API/PostgreSQL: 9 groups — authorization and restricted detail, exact/intersecting filters, inclusive UTC boundaries, strict invalid input without effects, UUID tie-breaking across three pages, real mutation snapshots and idempotency, password-reset safety, all five operational lists beyond page one, retailer isolation, and OpenAPI.
- Browser: 7 groups — creates 41 drafts, 21 extra variants/receipts/organizations/users through business APIs; compares pages with authoritative API results, changes sizes, reloads URLs, filters and reads snapshots, returns with filters, validates bad fields, retries a lost read, checks out-of-range/empty results, restricts operators/retailers, exercises keyboard and 390/1024/1100/1280px widths.
- Desktop and 390px list/detail screenshots are captured. Narrow tables scroll in their own focusable region to preserve readable identifiers. Detail snapshots wrap without page overflow.

## Status and limits

- **Full `pnpm check:all`**: run `20261001_061434`, 16/16 suites passed, including build, all existing concurrency acceptance, and Bug Lab 7/7. There are now ten API suites and six browser groups (the processing group also runs inventory).
- **Focused operations**: API/PostgreSQL 9/9; browser 7/7. Typecheck, lint and `git diff --check` passed.
- Evidence: `/private/tmp/pandora-phase2-final-evidence/operations-browser/` (`audit-list.png`, `audit-detail.png`, `audit-list-narrow.png`, `audit-list-narrow-results.png`, `audit-detail-narrow.png`, `audit-detail-narrow-values.png`). All six were visually inspected across the focused/full runs. The narrow table retains readable columns inside its own scroll region; JSON values wrap.
- The initial full run caught an obsolete Bug Lab assertion about the last migration; after correcting the assertion, the final full run passed. No defect guard or business invariant was relaxed.
- As before, `check:all` excludes the external Playwright catalog suite and Docker demo lifecycle browser suite; their API/database counterparts passed. No GitHub CI run has been triggered for this feature yet.

No public deployment, scheduled reset, returns, notification worker or email delivery is added. No audit write/export endpoint is exposed. Database changes are deployed through committed migrations; the development database has not been migrated by these checks. Commit was approved by the user; PR/CI and merge remain pending.
