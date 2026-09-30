# Organization and user administration: verification and handoff

## Implemented scope

- **Organizations** (administrators only):
  - `GET /api/admin/organizations` with search, type, status, and pagination.
  - `GET /api/admin/organizations/:organizationId`.
  - `POST /api/admin/organizations`: creates a **retailer** organization.
  - `PATCH /api/admin/organizations/:organizationId`: `name` and `isActive`.
  - Names are unique regardless of case (409 `ORGANIZATION_NAME_EXISTS`).
  - The distributor cannot be deactivated (409 `DISTRIBUTOR_ORGANIZATION_PROTECTED`).
  - Deactivating an organization revokes every member's sessions and leaves orders, reservations, stock, and user flags unchanged.
- **Users** (administrators only):
  - `GET /api/admin/users` with search (email or name), organization, role, status, and pagination.
  - `GET /api/admin/users/:userId`.
  - `POST /api/admin/users`: email (lowercased), display name, organization, role, and initial password.
  - `PATCH /api/admin/users/:userId`: `displayName`, `role`, and `isActive`.
  - `POST /api/admin/users/:userId/password`: 200 with the user.
  - Rules:
    - The role must match the organization (422 on `role`).
    - Emails are unique (409 `EMAIL_ALREADY_EXISTS`).
    - Email and organization are fixed after creation.
    - Passwords are 12–256 characters and argon2id-hashed. They never appear in responses, audit, or logs.
- **Session revocation** runs in the same transaction as the change. The reason is stored on the session:

  | Change | Reason |
  |---|---|
  | User deactivated | `user_deactivated` |
  | Role changed | `role_changed` |
  | Password reset | `password_reset` |
  | Organization deactivated | `organization_deactivated` |

  Display-name changes and reactivation revoke nothing, and reactivation does not restore revoked sessions.
- **Last administrator:** deactivating or demoting the last active administrator returns 409 `LAST_ACTIVE_ADMINISTRATOR`.
- **Audit:** `organization/created|updated` and `user/created|updated` store before and after snapshots, plus `revokedSessions`. `user/password_reset` stores `{id, revokedSessions}` only.
- **Web:**
  - Administrators get **Organizations** and **Users** in the navigation (the landing page stays `/admin/catalog`).
  - List pages have URL-kept filters and pagination.
  - The organization page has a form and a member list with **Add user**.
  - The user page shows read-only email and organization, an account form (role choices follow the organization type), and a separate password-reset form with confirmation.
  - Notices explain in advance when saving signs someone out, including the administrator's own account.

## Design decisions

- **Migration `20260930170000_admin_management`** is hand-written; the Prisma schema is unchanged, and a `migrate diff` against the dev database is empty. It adds:
  - A unique index on `lower(name)`.
  - Length CHECKs for organization names and display names.
  - An organization trigger: the type is immutable, and the distributor must stay active.
  - A user trigger: id, email, and organization are immutable, and the role must match the organization type.
  - A **deferred constraint trigger**: at commit, at least one active administrator must remain in the active distributor.
- **No `Idempotency-Key`**, the same as catalog administration:
  - Unique names and emails block duplicate creates.
  - Updates are idempotent by value.
  - A repeated password reset only revokes sessions again.
- **Serializable transactions.** Every mutation runs in `runSerializable`. Two administrators demoting each other is a write skew, which PostgreSQL detects; the retry then sees no other administrator and returns 409. The deferred trigger is the backstop.
- **Password hashing** runs before the transaction, so a retry does not repeat it.
- **Defect found and fixed in shared infrastructure:**
  - PostgreSQL sometimes reports a serialization failure only at `COMMIT`. The Prisma pg adapter then throws a raw `DriverAdapterError` with `cause.kind = "TransactionWriteConflict"` instead of `P2034`.
  - `runSerializable` did not recognize it, so the request returned **500 instead of retrying**. Reproduction before the fix: 20 of 25 parallel demotion pairs returned a 500.
  - Fixed in `apps/api/src/infrastructure/prisma/serializable.ts`. Afterwards, 25 of 25 pairs gave exactly one 200 and one 409.
  - It affected every Serializable workflow, although the earlier feature checks never triggered a commit-time conflict. A regression group now covers it.
- **Navigation wrapping:** with six links, the administrator navigation overflowed at 390px. The browser check found this, and `.nav` now wraps on narrow screens.
- **Revoked sessions** are counted only when unexpired, so `revokedSessions` reflects sessions that were actually usable.

## API / PostgreSQL checks

`apps/api/checks/administration.mjs` (`pnpm --filter @pandora/api check:admin`) uses port 3017 by default (`ADMIN_CHECK_PORT`) and the shared `checks/harness.mjs`:

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" pandora_admin_check_unique'
ADMIN_CHECK_DATABASE=pandora_admin_check_unique pnpm --filter @pandora/api check:admin
```

Covered groups (12):

1. **Access:**
   - Operators and retailers get 403 on reads and on every mutation.
   - Anonymous callers get 401, and a missing CSRF token gets 403.
   - Nothing changes.
2. **Organizations:**
   - Create with a trimmed name; search, type, and status filters; name ordering; user counts.
   - `%` in a search is matched literally.
   - A duplicate in another case, an empty or too-long name, unknown fields, an empty patch, an unknown id, a bad uuid, or an invalid page size are rejected with no audit.
   - Rename; a no-op writes no audit.
3. **Distributor protection:** deactivation → 409 with no effect.
4. **Users:**
   - The email is normalized, and the new user can sign in.
   - A duplicate email, a role mismatch (field `role`), an unknown organization (field `organizationId`), a short password, a bad email, or unknown fields are rejected with no audit.
   - No password data appears in responses or audit.
   - The list filters and email ordering work.
5. **Revocation:**
   - A display-name change keeps the session.
   - A role change ends it (`role_changed`, audited with `revokedSessions`).
   - Deactivation ends it (`user_deactivated`) and blocks sign-in.
   - Reactivation restores sign-in but not old sessions.
6. **Password reset:**
   - A weak password → 422.
   - Old sessions end (2, both `password_reset`), the old password fails, and the new one works.
   - The hash changes, and the audit contains `{id, revokedSessions}` only.
   - An unknown user → 404.
7. **Organization deactivation:**
   - Every member's session ends with `organization_deactivated`, and sign-in fails.
   - Orders, reservations, stock, and movements are identical; staff still read the orders.
   - Reactivation restores sign-in.
8. **Last administrator:**
   - Deactivating or demoting the only administrator → 409 with no effect, and the session stays valid.
   - With two administrators, parallel demotion and deactivation leave exactly one.
9. **Regression:** 10 rounds of the commit-time serialization conflict; always exactly one 200 and never a 500.
10. **Database constraints:** these direct writes are rejected:
    - an organization type change, or an inactive distributor;
    - a duplicate name in another case, or a blank name;
    - a user moving organizations, or an email change;
    - a role mismatch in either direction, or a blank display name;
    - deactivating the last administrator.

    An administrator swap within one transaction is allowed.
11. **Rollback:** an injected audit failure on deactivation, organization deactivation, and password reset leaves everything unchanged, and the session stays valid.
12. **OpenAPI and logs:** every route and method is documented. The logs contain no seed or test passwords, argon2 hashes, or session cookies.

## Browser checks

`apps/web/checks/admin-browser.mjs` uses the shared CDP driver on a freshly seeded QA stack (API on 3013, web on 5175; the setup is the same as in `inventory-verification.md`):

```sh
node --env-file=.env apps/web/checks/admin-browser.mjs
```

Covered groups (9):

1. Navigation to both lists; the status filter is kept in the URL; the inactive badge; the role filter.
2. **Organization create:** an empty name is flagged; creation lands on the new page; a duplicate in another case shows the error, keeps the input, and marks the field.
3. **Add user from the organization page:**
   - The organization is prefilled, and the retailer role is fixed.
   - A short password is flagged; the email is normalized.
   - The distributor offers operator and administrator.
   - The new user signs in and sees no admin navigation.
4. **Deactivation:** deactivating the signed-in user (via the API) sends their next page load to sign-in.
5. **Password reset:** a confirmation mismatch is flagged; the fields are cleared after success; the old password is rejected and the new one works.
6. **Last administrator:** the own-account notice appears; saving shows the last-administrator error and keeps the unsaved input.
7. **Organization deactivation:** the notice states how many users are signed out; the status becomes inactive; the distributor's active flag is disabled.
8. **Keyboard and layout:** Tab moves from the display name to the active checkbox with a visible focus outline. There is no horizontal overflow at 390px on the user page and on both lists.
9. **Operators:** no admin navigation, and "Access restricted" on direct links. No page errors.

## Selector contract

- **Navigation:** `organizations-nav`, `users-nav`.
- **Organization list:**
  - `organization-create`, `organization-search`, `organization-search-submit`, `organization-type-filter`, `organization-status-filter`, `organization-total`;
  - `organization-row` (scoped by `data-organization-name`), `organization-link`, `organization-status`;
  - `organization-clear-filters`, `organization-retry`;
  - `organization-page-size`, `organization-page`, `organization-previous`, `organization-next`.
- **Organization page:**
  - `organization-heading`, `organization-form`, `field-organization-name`, `organization-active`, `organization-deactivation-notice`, `organization-save`, `organization-saved`, `organization-error`;
  - `organization-add-user`, `organization-members`, `organization-member` (scoped by `data-email`).
- **User list:**
  - `user-create`, `user-search`, `user-search-submit`, `user-organization-filter`, `user-role-filter`, `user-status-filter`, `user-total`;
  - `user-row` (scoped by `data-email`), `user-link`, `user-status`;
  - `user-clear-filters`, `user-retry`;
  - `user-page-size`, `user-page`, `user-previous`, `user-next`.
- **User page:**
  - `user-heading`, `user-created`, `user-details`, `user-email`;
  - `user-form`, `field-user-email`, `field-user-display-name`, `field-user-organization`, `field-user-role`, `field-user-password`;
  - `user-active`, `user-sessions-notice`, `user-save`, `user-saved`, `user-error`;
  - `password-form`, `field-new-password`, `field-confirm-password`, `password-save`, `password-saved`, `password-error`.

Intentional semantic-locator exceptions:

- the member email links in the organization page's user table;
- the "Show all users" link;
- the organization link on the user page;
- the "Access restricted" heading, located by `h1` text.

## Results — 2026-09-30

- **API/PostgreSQL:** administration 12 of 12 on fresh QA databases (`pandora_admin_check_20260930_155533`, `…_160221_reg`). A standalone race reproduction ran 25 rounds before and after the fix (`pandora_admin_check_race_*`).
- **Regressions on fresh databases** (`…_20260930_160221_reg`, catalog on `…_160247_reg2`): catalog 11, inventory 18, orders 16, processing 13, and fulfillment 11, all passing.
- **Browser:**
  - Administration 9 of 9 on `pandora_admin_browser_20260930_160138_r3`, and again on `…_160337_admin` after the final CSS change.
  - Separate fresh stacks: fulfillment 8 of 8 (`…_160305_fulfillment`), processing 7 of 7 and inventory 9 of 9 (`…_160314_order-processing`), and order drafts 11 of 11 (`…_160326_orders`).
  - Screenshots inspected: users list, user page after a password reset, and the narrow user page.
- **Development database:** the migration was applied with `db:deploy` (no reset), and `prisma migrate diff` against the schema is empty. A smoke test listed organizations and users with no password fields.
- **Final gates:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass. The existing chunk-size warning remains.

## Limitations and follow-ups

- There is no email change, no moving users between organizations, no deletion, and no invitations or self-service recovery (out of scope).
- Organization and user lists are for administrators only; a system-wide audit viewer is Phase 2.
- The user-creation form lists at most 100 active organizations (page size 100).
- A self-demotion or self-deactivation signs the administrator out right after the successful save. The UI warns about this beforehand.
- The Playwright catalog browser harness was not re-run. The shared navigation change is covered by the CDP suites above.
- Still open: login rate limiting, session cleanup, test/CI setup, audit foreign keys, shared UI primitives, and demo reset automation.

Follow-up (2026-09-30, found by CI on PR #2): the race checks now also accept `CONCURRENT_MODIFICATION` for the losing request. They require at most one success and never zero administrators. `runSerializable` now waits a short random time between retries; see [auth-hardening-verification.md](auth-hardening-verification.md).
