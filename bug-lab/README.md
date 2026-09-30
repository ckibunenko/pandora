# Pandora Bug Lab

The Bug Lab is an isolated local environment in which exactly one known defect is switched on. Use it to practise finding, reproducing, and reporting defects against a realistic B2B ordering application. The public demo and normal development always run **Standard mode**, where the same checks pass.

## Rules

- **One defect at a time.** The API accepts `BUG_LAB_DEFECT=BUG-001`, `BUG-002`, or `BUG-003` and refuses unknown IDs or lists.
- **Isolated database only.**
  - A defect requires a database named `pandora_buglab_…`, prepared by the setup tool and marked for that defect.
  - The API refuses a defect with `NODE_ENV=production` (the public demo), on any other database, or when the database marker does not match.
- **Switching defects** means preparing a new database and restarting. There is no runtime toggle.
- **Only the business rule named in the catalog is broken.** Sign-in, CSRF, roles, retailer isolation, and secret handling behave exactly as in Standard mode.

## Running a lab

Requirements are the same as for development: PostgreSQL running, `.env` present, dependencies installed, and the API built with `pnpm build`.

```bash
pnpm bug-lab setup --defect BUG-001        # or BUG-002, BUG-003, or none for a Standard comparison
pnpm bug-lab start --run <run id printed by setup>
```

`setup` does the following:
- creates a new database `pandora_buglab_<defect>_<run>`;
- applies the migrations and loads the normal demo seed;
- adds scenario fixtures: 40 extra draft orders for Tabletop Lantern, `PO-000101`–`PO-000140`;
- marks the database for the defect;
- writes a run manifest to `bug-lab/runs/<run id>.json`: run ID, defect, database, app commit and dirty flag, seed version, latest migration, and time. Keep the manifest with any defect report.

`start` serves the app at http://localhost:5176 (API on 3020); stop it with Ctrl-C. Sign in with the demo accounts listed in the main README.

Prepare a `none` run as well, so you can compare the same steps against Standard behavior.

## Contents

- [catalog.md](catalog.md): the defect catalog, with area, prerequisites, and the business rule each defect breaks.
- `briefs/`: what to test for each defect, without the answer. Start here.
- `solutions/`: cause, fix, and the automated assertion. Read these only after you have written your report.

## How it is verified

`pnpm --filter @pandora/api check:bug-lab` (also part of `pnpm check:all` and CI) runs the following:
- It prepares a Standard database and one database per defect.
- It checks that each business assertion passes on Standard and fails on its defect's database for the intended reason, and that the other two assertions still pass there.
- It checks that every forbidden configuration is refused and that security behavior is identical in every mode.
