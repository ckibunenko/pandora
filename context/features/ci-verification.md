# Test and CI setup: verification and handoff

## Implemented scope

- **`pnpm check:all`** (`scripts/check-all.mjs`):
  - Builds first (with `NODE_ENV=production`; skip it with `--skip-build`).
  - **API/PostgreSQL:** runs catalog, inventory, orders, processing, fulfillment, admin, and demo-reset. Each gets a fresh database, named after that suite's required pattern plus a run id.
  - **Browser:** one web server on 5175. Each group gets a fresh database, migrated and seeded, and its own QA API on 3013. The groups:
    - fulfillment;
    - order processing + inventory;
    - order drafts;
    - administration.
  - Runs suites sequentially and continues after a failure. It prints a PASS/FAIL summary with durations and database names, and exits 1 if anything failed or nothing was selected.
  - Options: `--api`, `--browser`, `--only <name>` (repeatable), `--evidence <dir>`.
  - **Safety:**
    - Database names must match `pandora_[a-z0-9_]+` and differ from the `DATABASE_URL` database. Databases are only created, never dropped.
    - It refuses to start if 3013 or 5175 answers on IPv4 or IPv6.
    - Background servers run in their own process group and are stopped at the end.
- **Not run by the runner** (printed as SKIP):
  - `catalog-browser.mjs` needs an external Playwright install.
  - `demo-reset-browser.mjs` needs the Docker demo stack.
  - Their API counterparts do run.
- **GitHub Actions** (`.github/workflows/ci.yml`):
  - Triggers: pushes to `main`, pull requests, and manual dispatch. `contents: read` only; concurrent runs of the same ref are cancelled.
  - Jobs:
    - `gates`: frozen-lockfile install, then typecheck, lint, and build.
    - `api-checks`: PostgreSQL 18.6 service, `check:all --api`.
    - `browser-checks`: PostgreSQL service, the runner's `/usr/bin/google-chrome`, `check:all --browser`. Screenshots are uploaded only on failure.
  - Node comes from `.nvmrc` and pnpm from `packageManager`.
  - CI-only credentials exist only in the job's disposable service container. There are no repository secrets.
- **`cdp.mjs`** adds `--no-sandbox` only when `CI=true`, because GitHub's Ubuntu runners block Chrome's user-namespace sandbox.

## Decisions

- **Ownership (overview §11):** application checks and CI live in this repository, and the QA repository keeps portfolio E2E and release evidence. Recorded in the overview.
- **No new dependencies.** The runner uses Node built-ins and the API's existing Prisma client to create databases.
- **No unit-test framework yet.** Pure logic such as `deriveFulfillmentStatus` is covered end to end by the API checks. A framework is a separate decision.
- **Sequential execution:** the concurrency checks must not compete with other suites for CPU. A full local run takes about 55 seconds.

## Results — 2026-09-30

- **Full local run** (`pnpm check:all`, run `20260930_190402`): all 11 passed, in 55 seconds.
  - API: catalog 11, inventory 18, orders 16, processing 13, fulfillment 11, admin 12, demo-reset 6.
  - Browser: fulfillment 8, processing 7 + inventory 9, orders 11, admin 9.
- **Leftover server found:**
  - During the first run, an old QA web server from an earlier session was still listening on `[::1]:5175`. The runner's port check had looked only at IPv4, so it did not notice.
  - The results stayed valid, because both servers proxy to the same QA API on 3013.
  - The runner now checks IPv4 and IPv6, and the old process was stopped.
- **Browser rerun** (`20260930_190535`): 4 of 4 groups passed, and no process listens on 3013 or 5175 afterwards.
- **Failure paths:** each of these exits 1:
  - a listener on `[::1]:5175` → "Port 5175 is already in use";
  - a broken `CHROME_PATH` → `FAIL browser:admin` in the summary;
  - `--only nonexistent` → nothing selected.
- **Database-name validation** was reviewed in code only. With generated run ids it cannot be reached from the CLI.
- **Final gates:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` pass.
- **GitHub Actions:** not yet run. The workflow runs once the branch is pushed. This file is updated with the result.

## Limitations and follow-ups

- The runner uses fixed ports 3013 and 5175, so there is one run at a time per machine.
- Databases accumulate locally, because the runner never drops them. Clean them up by hand when needed.
- Enabling branch protection on `main` so that CI must pass before merging is a GitHub setting and the user's decision.
- Still open:
  - the Playwright catalog browser check and the demo-reset browser check in CI;
  - a unit-test framework;
  - login rate limiting and session cleanup.
