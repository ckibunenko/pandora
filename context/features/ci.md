## Current Feature

Test and CI setup. One command runs every application check on fresh, disposable databases, and GitHub Actions runs it for every push to `main` and every pull request (overview §10–§11, coding standards §9).

## Status

Completed — merged to `main` as `d0bb179` (2026-09-30) through PR #1; the GitHub Actions run passed.

## Goal

A regression cannot reach `main` unnoticed: gates, API/PostgreSQL checks, and browser checks run automatically against real PostgreSQL. The same command runs locally, so nobody has to create QA databases by hand.

## Scope and decisions (2026-09-30)

- Branch: `feature/ci`.
- **Ownership (overview §11 open decision):**
  - Application verification and CI live in this repository.
  - The companion QA repository keeps portfolio E2E automation, exploratory records, and release evidence.
  - Recommended by Claude; the user said "kreni" without choosing otherwise.
- **`pnpm check:all` (`scripts/check-all.mjs`):**
  - `--api`, `--browser`, or both by default; `--skip-build` when the build has already run.
  - Each API suite gets a fresh database named for its check pattern plus a run id.
  - Each browser group gets a fresh database, migrated and seeded, and its own QA API on 3013. One web server on 5175 proxies to it.
  - Suites that change the same seed orders are in separate groups.
  - Suites run one after another, because concurrency checks must not compete for CPU with other suites.
  - Databases are created through the configured `DATABASE_URL` server, never on the development database. Names are validated before use.
  - The script prints each database used. They are kept as evidence, and the script never drops databases.
  - Screenshots go to one evidence directory (`--evidence`, default under the system temp directory).
- **Excluded from the runner, with the reason printed:**
  - `catalog-browser.mjs`: it needs an external Playwright install, which is not a dependency.
  - `demo-reset-browser.mjs`: it needs the Docker demo stack.
  - Their API/PostgreSQL counterparts (`catalog`, `demo-reset`) run.
- **GitHub Actions (`.github/workflows/ci.yml`):**
  - Triggers: pushes to `main`, pull requests, and manual runs. Read-only permissions; concurrent runs of the same ref are cancelled.
  - Jobs:
    - `gates`: install with the frozen lockfile, then typecheck, lint, and build.
    - `api-checks`: PostgreSQL 18.6 service, all API suites.
    - `browser-checks`: PostgreSQL service, the installed Chrome, all CDP browser suites.
  - Node comes from `.nvmrc`; pnpm comes from `packageManager`.
  - Screenshots are uploaded when the browser job fails.
  - CI uses CI-only values (`SEED_USER_PASSWORD` and database credentials) that exist only in the disposable service container. There are no repository secrets.
- **Chrome in CI:** GitHub's Ubuntu runners restrict the Chrome sandbox, so `cdp.mjs` adds `--no-sandbox` only when `CI=true`.
- **Out of scope:**
  - a unit-test framework (no dependency added now; pure logic stays covered through the API checks);
  - porting the Playwright catalog browser check;
  - running the Docker demo stack in CI;
  - branch protection rules (GitHub settings, the user's decision).

## Verification

- `pnpm check:all` passes locally from a clean state (API and browser).
- A deliberately failing suite makes the runner exit non-zero and names the suite.
- A busy QA port, and invalid or development-database targets, are refused.
- The workflow runs on GitHub after the branch is pushed, with all three jobs green.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass.

## Implementation results (2026-09-30)

- Evidence and details: [features/ci-verification.md](ci-verification.md).
- `pnpm check:all` passes locally with 11 of 11 suites (7 API, 4 browser groups) in about 55 seconds.
- The failure paths exit 1: a busy port, a broken Chrome, and no suite selected.
- The first run exposed a leftover QA web server listening on IPv6 only, which the port check had missed. The check now covers IPv4 and IPv6.
- On GitHub Actions (run `36763707451`, PR #1), all three jobs pass and all 11 suites pass, in about 1.5 minutes.

