## Current Feature

Public demo preparation (provider-independent). Everything the public demo needs that does not depend on a hosting decision: an HTTPS entry point, secure session cookies, a read-only public inbox, the daily 03:00 Europe/Belgrade reset schedule, and an operations runbook for any Linux VPS. Verified locally (overview §9 and §11).

## Status

In progress on `feature/public-demo-prep`.

## Scope and decisions (2026-10-01)

- Branch: `feature/public-demo-prep`.
- **Hosting is still undecided** (user, 2026-10-01: "for now, locally"). This feature adds no provider account, DNS, or deployment. The hosting, public URL, resource limits, and costs remain open decisions.
- **Entry point:** a Caddy reverse proxy (`caddy:2.11.4-alpine`) becomes the only published service of `compose.demo.yml`. It routes `/mail/*` to Mailpit and everything else to the existing web container (nginx: SPA, `/api` proxy, maintenance page). The web, API, worker, database, and Mailpit are no longer published.
  - **HTTPS:** `DEMO_DOMAIN` (default `localhost`) and `DEMO_TLS` (default `internal`, Caddy's local CA; on a server, an ACME contact email for automatic Let's Encrypt certificates).
  - **Ports:** HTTP (`DEMO_PORT`, default 5180) redirects to HTTPS (`DEMO_HTTPS_PORT`, default 5443), bound to `DEMO_BIND` (default `127.0.0.1`; `0.0.0.0` on a server). The container listens on the same port numbers, so redirects keep the right port.
  - **Headers:** `nosniff`, `Referrer-Policy: no-referrer`, frame denial, no `Server` header. HSTS comes from `DEMO_HSTS` (default `max-age=0` locally, so `localhost` development is not forced to HTTPS).
- **Session cookies:** the demo API sets `SESSION_COOKIE_SECURE=true`, because the demo is served only over HTTPS.
- **Public read-only inbox** (user decision, 2026-10-01): Mailpit is served at `/mail/` (`MP_WEBROOT`) for anyone.
  - The proxy refuses every method except GET and HEAD with 405. That blocks deleting, marking as read, and the Send API. All addresses are fictional.
  - Mailpit runs with the version check and remote CSS and fonts disabled.
- **Daily reset:** `deploy/demo/systemd/pandora-demo-reset.{service,timer}` runs `scripts/demo-reset.mjs` at 03:00 Europe/Belgrade (`OnCalendar` with a time zone, `Persistent=true`). A cron line is documented as an alternative. The reset lifecycle itself is unchanged and already fails closed.
- **Runbook:** `context/features/public-demo-runbook.md` covers server prerequisites, a firewall allowing only 22, 80, and 443, DNS, `.env.demo`, build, first reset, enabling the timer, verification, updates, recovery, and rollback.
- **Out of scope:** choosing and paying for a host, DNS, monitoring and alerting, backups (the demo is restored from fixtures), rate limiting beyond sign-in, and multi-host scaling.

## Verification

- **Docker demo lifecycle** (`apps/web/checks/demo-reset-browser.mjs`, extended) on a disposable `pandora-demo-qa-*` project over HTTPS with Caddy's internal CA:
  - only Caddy is published, on loopback;
  - HTTP redirects to HTTPS with the right port; the session cookie is `Secure`, `HttpOnly`, and `SameSite=Lax`;
  - security headers are present;
  - the inbox is readable at `/mail/` and refuses DELETE, PUT, and POST with 405, so messages stay;
  - the maintenance, failure, and retry lifecycle still passes, and a post-reset event reaches the public inbox.
- `systemd-analyze calendar` and `verify` for the units in a Linux container.
- `docker compose config` for the demo and development files. All existing checks pass; `pnpm typecheck`, `pnpm lint`, and `pnpm build`.

## Implementation results (2026-10-01)

- Implemented as specified. Runbook: [public-demo-runbook.md](public-demo-runbook.md); evidence: [demo reset verification](demo-reset-verification.md) (2026-10-01 results).
- **Docker demo lifecycle:** 6 of 6 on `pandora-demo-qa-public` over HTTPS with Caddy's internal CA:
  - only Caddy is published, with a 308 redirect that keeps the port, security headers, and a `Secure; HttpOnly; SameSite=Lax` cookie;
  - the read-only inbox at `/mail/` refuses DELETE, PUT, and POST;
  - the reset empties the inbox, and maintenance, failure, and retry still pass.
- **systemd:** `systemd-analyze calendar` gives the next runs at 01:00 UTC in summer and 02:00 UTC after the DST change, both 03:00 Europe/Belgrade. `systemd-analyze verify` reports only the missing `docker.service` inside the test container.
- `caddy validate` and `docker compose config` pass; the fulfillment browser group passes after the CDP option; `pnpm typecheck` and `pnpm lint` pass.
- **Found and fixed during verification:**
  - **Redirect:** Caddy's automatic HTTP→HTTPS redirect dropped the non-default port. There is now an explicit `redir` that keeps it.
  - **Inbox writes:** a top-level `respond` ran after `handle`, so DELETE reached Mailpit. The refusal now lives inside the `/mail*` handle.
  - **Stale emails:** the reset kept emails about removed orders. It now restarts Mailpit, whose temporary database is discarded.
- **Not done (needs the hosting decision):** a real domain, ACME certificate, server firewall, and running timer.

## Previous feature

[Notifications](notifications.md) merged as `1c08d9b` through PR #8; [verification](notifications-verification.md). Phases 1–3 are complete.
