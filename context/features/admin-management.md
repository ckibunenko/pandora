## Current Feature

Minimal organization and user administration. Administrators manage retailer organizations and user accounts: create, rename or edit, activate and deactivate, change staff roles, and reset passwords. Deactivation, role changes, and password resets end the affected sessions immediately. The distributor organization and the last active administrator are protected (overview §3, §7, §10 Phase 1).

## Status

Implemented and verified on branch `feature/admin-management`; merged to main as `17d5ef5` on 2026-09-30.

## Goal

An administrator can onboard a new retailer store and its users, and can remove access without losing history. Every change is audited, access revocation is immediate, and the system can never lose its last administrator.

## Scope and decisions (2026-09-30)

- Branch: `feature/admin-management`.
- **Administrators only.** Operators and retailers get 403 on every endpoint and do not see the screens.
- **Organizations:**
  - Create **retailer** organizations only; there is exactly one distributor.
  - Rename, deactivate, and reactivate. The organization type never changes.
  - Names are unique, ignoring case → 409 `ORGANIZATION_NAME_EXISTS`.
  - The distributor organization cannot be deactivated → 409 `DISTRIBUTOR_ORGANIZATION_PROTECTED`.
- **Users:**
  - Create with email, display name, organization, role, and an initial password.
  - Afterwards the display name, role, and active flag can change. Email and organization are fixed after creation.
  - The role must match the organization: `retailer` in retailer organizations, `operator` or `administrator` in the distributor. Otherwise 422 on `role`.
  - Emails are unique after lowercasing → 409 `EMAIL_ALREADY_EXISTS`.
  - Password reset by an administrator. Passwords are 12–256 characters, stored as argon2id hashes, and never returned, logged, or audited.
- **Last administrator:** the last active administrator cannot be deactivated or demoted → 409 `LAST_ACTIVE_ADMINISTRATOR`. Administrators may otherwise change their own account; if that ends their own session, they are signed out.
- **Session revocation, in the same transaction as the change:**

  | Change | Reason recorded on the session |
  |---|---|
  | User deactivated | `user_deactivated` |
  | Role changed | `role_changed` |
  | Password reset | `password_reset` |
  | Organization deactivated (every user in it) | `organization_deactivated` |

  - Display-name changes and reactivation revoke nothing.
  - Reactivation does not restore revoked sessions.
- **Deactivation preserves history and stock:** orders, reservations, and audit stay unchanged, and nothing is released automatically (overview §3).
- **Idempotency:** these endpoints do not take an `Idempotency-Key`, the same as catalog administration. Unique names and emails block duplicate creates, updates are idempotent by value, and a repeated password reset only revokes sessions again.
- **Out of scope:** email changes, moving users between organizations, invitations, self-service password recovery, deleting organizations or users, and a separate audit viewer.

## Data and invariants

Migration `20260930170000_admin_management`, written by hand (no schema field changes):

- **Organizations:**
  - unique index on `lower(name)`;
  - CHECK that the trimmed name is 1–120 characters;
  - trigger: the type is immutable, and a distributor cannot be inactive.
- **Users:**
  - CHECK that the trimmed display name is 1–120 characters;
  - trigger: email and organization are immutable, and the role must match the organization type (on insert and update);
  - deferred constraint trigger: after any user update or delete, at least one active administrator must remain in the distributor organization.

## Consistency rules

- Every mutation runs in a Serializable transaction with bounded retry (`runSerializable`):
  - Organizations: reread → validate → update → revoke sessions → audit.
  - Users: the same order.
  - Two administrators demoting each other at the same time can never leave zero administrators; the deferred database trigger is the backstop.
- Password hashing happens before the transaction, so retries do not repeat it.
- Unique violations map to their 409 codes, including races between two creates.
- **Order of checks:** 404 → 422 (input, and the role/organization match) → business 409s.

## API contract

| Endpoint | Behavior |
|---|---|
| `GET /api/admin/organizations` | `page`, `pageSize` (20/50/100), `q` (name), `type`, `status` (`all`/`active`/`inactive`); sorted by name, then id |
| `GET /api/admin/organizations/:organizationId` | Detail |
| `POST /api/admin/organizations` | `{ name }`; 201; creates a retailer organization |
| `PATCH /api/admin/organizations/:organizationId` | `{ name?, isActive? }`; 200 |
| `GET /api/admin/users` | `page`, `pageSize`, `q` (email or name), `organizationId`, `role`, `status`; sorted by email, then id |
| `GET /api/admin/users/:userId` | Detail |
| `POST /api/admin/users` | `{ email, displayName, organizationId, role, password }`; 201 |
| `PATCH /api/admin/users/:userId` | `{ displayName?, role?, isActive? }`; 200 |
| `POST /api/admin/users/:userId/password` | `{ password }`; 200 with the user |

- All endpoints require a session and the administrator role. Mutations also require CSRF.
- **Organization response:** `id`, `name`, `type`, `isActive`, `userCount`, `activeUserCount`, `createdAt`.
- **User response:** `id`, `email`, `displayName`, `role`, `isActive`, `organization {id, name, type, isActive}`, `createdAt`. It never includes the password hash.

## Audit

In the same transaction as the change:

| Event | Contents |
|---|---|
| `organization/created`, `organization/updated` | Before and after snapshots of name, type, and active flag; `revokedSessions` when sessions were ended |
| `user/created`, `user/updated` | Snapshots of email, display name, role, organization, and active flag; `revokedSessions` |
| `user/password_reset` | User id and `revokedSessions`; never a password or hash |

## UI acceptance criteria

- **Navigation (administrators only):** Organizations and Users. The administrator landing page stays `/admin/catalog`.
- **Organizations list (`/admin/organizations`):** search, type and status filters, pagination, and a text status badge. **New organization** opens a create page.
- **Organization page:**
  - A form for the name and the active flag, with the consequences of deactivation explained.
  - For the distributor, the active flag is disabled and the reason is shown.
  - The organization's users are listed, with **Add user** prefilled for this organization.
- **Users list (`/admin/users`):** search, role, status, and organization filters, and pagination.
- **User page:**
  - Details (email and organization read-only; display name, role, and active flag editable). Role choices depend on the organization type.
  - A separate password-reset form.
  - The messages explain that sessions are ended.
- **Errors:**
  - Business 409s (`LAST_ACTIVE_ADMINISTRATOR`, duplicates) appear as readable alerts.
  - Field errors are attached to their fields, and unsaved input is kept.
- Keyboard access, a narrow layout, and `data-test` selectors following the contract.

## Deterministic seed

No new seed records. The existing four organizations and six users already cover an inactive organization, an inactive user, and a single administrator.

## Verification

- **Access:**
  - Operators and retailers get 403 on every endpoint.
  - No session → 401; missing CSRF → 403.
- **Organizations:**
  - Create, list, filter, paginate, and rename.
  - A duplicate name in any case → 409.
  - Invalid input → 422; unknown id → 404.
  - The distributor cannot be deactivated.
- **Users:**
  - Create; the email is normalized; the new user can sign in.
  - Duplicate email → 409; role/organization mismatch → 422; a short password → 422.
  - Responses never contain a hash.
- **Revocation:**
  - A role change, deactivation, or password reset makes existing sessions return 401.
  - A deactivated user cannot sign in until reactivated.
  - After a reset, the old password fails and the new one works.
  - A display-name change keeps sessions.
- **Organization deactivation:**
  - All member sessions end and sign-in fails.
  - Orders, reservations, and stock are unchanged.
  - Reactivation restores sign-in.
- **Last administrator:**
  - Deactivating or demoting the only administrator → 409 with no effect.
  - With two administrators, parallel demotions leave exactly one.
- **Database:** direct writes that break these rules are rejected: a type change, an inactive distributor, a user moving organizations, an email change, a role mismatch, no active administrator, or a duplicate name.
- **Rollback:** an injected audit failure leaves no change and no revoked session.
- **OpenAPI and logs:** the routes are documented; logs contain no passwords, hashes, or tokens.
- **Browser:**
  - The administrator creates an organization and a user, and the user signs in.
  - The administrator deactivates the user; the user's next request returns to the login page.
  - A password reset works.
  - The last-administrator error is shown.
  - Keyboard access, the narrow layout, and absence of the navigation for other roles work.
- All existing checks pass. `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass.

## Implementation results (2026-09-30)

- Implemented as specified. Evidence, reproduction steps, selectors, and limitations: [features/admin-management-verification.md](admin-management-verification.md).
- **API/PostgreSQL:** administration 12 of 12 on fresh QA databases, including parallel demotions, rollback, and database constraints.
- **Regressions:** catalog 11, inventory 18, orders 16, processing 13, fulfillment 11, all passing.
- **Browser:** administration 9 of 9; fulfillment 8, processing 7 plus inventory 9, and order drafts 11, each on its own fresh stack.
- **Final gates:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass.
- **Defects found and fixed:**
  - `runSerializable` returned 500 instead of retrying when PostgreSQL reported a serialization failure only at `COMMIT`, because the pg adapter throws a raw `DriverAdapterError` there instead of `P2034`. This is shared infrastructure, so every Serializable workflow benefits. A regression group now covers it.
  - The administrator navigation overflowed at 390px after the two new links; the navigation now wraps on narrow screens.

## Continuation checkpoint (2026-09-30)

- Resumed on `feature/admin-management` with the existing uncommitted implementation preserved.
- Re-ran `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check`: all passed. The existing Vite chunk-size warning remains.
- Re-ran all 12 administration API/PostgreSQL check groups on the new isolated database `pandora_admin_check_20260930_resume`: all passed, including session revocation, last-administrator races, commit-time serialization retry, and rollback.
- Browser and other feature regression results above are from the earlier implementation run; they were not re-run at this checkpoint.
- Updated stale overview statements about inventory, ordering, and the implemented feature set. No application behavior changed at this checkpoint.
- Commit permission received on 2026-09-30. Next planned feature: specify safe demo reset automation to close the remaining Phase 1 tooling gap; hosting and scheduler decisions are still open. Login rate limiting, session cleanup, and test/CI setup remain separate follow-ups.

## Previous feature

Fulfillment is completed and merged as `e7cf5af`. Specification and evidence: [features/fulfillment.md](fulfillment.md) and [features/fulfillment-verification.md](fulfillment-verification.md). Earlier features: [order processing](order-processing.md), [order drafts](order-drafts.md), [inventory](inventory.md), [catalog](catalog.md), [auth and sessions](auth-sessions.md). Still outstanding: login rate limiting, session cleanup, test/CI setup, audit foreign keys, shared UI primitives, and demo reset automation.
