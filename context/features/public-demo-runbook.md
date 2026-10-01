# Public demo — operations runbook

Provider-independent steps for running the Pandora demo on one Linux server. The hosting provider is still undecided (overview §11), so nothing here is installed yet. Everything below was verified locally with the same Compose stack over HTTPS (see [verification](demo-reset-verification.md)).

## What runs

```text
Internet ──80/443──▶ caddy ──/mail/*──▶ mailpit (read-only; non-GET/HEAD → 405)
                       └──────/*──────▶ web (nginx: SPA, maintenance page) ──/api──▶ api ──▶ postgres
                                                              worker ──SMTP──▶ mailpit     ▲
                                                                 └─────────────────────────┘
```

- `compose.demo.yml`: postgres, api, worker, mailpit, web, and caddy. **Only Caddy publishes ports.**
- The API runs with `NODE_ENV=production` (Standard mode; Bug Lab configuration is refused), and session cookies are `Secure`.
- `scripts/demo-reset.mjs` restores the fixtures behind a maintenance page and fails closed. `deploy/demo/systemd/` runs it daily at 03:00 Europe/Belgrade.

## Server prerequisites

- A Linux VPS (Debian 12 or Ubuntu 24.04), 2 vCPU / 4 GB RAM recommended for building the images on the server (or build them elsewhere and push them to a registry).
- Docker Engine with the Compose plugin (`docker compose up --wait` support), git, and **Node 24** (only for `scripts/demo-reset.mjs`, which uses no dependencies).
- A DNS name (A/AAAA record) pointing at the server **before** the first start, so Caddy can obtain a certificate.
- **Firewall:** allow only 22, 80, and 443.

  ```sh
  ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
  ```

  Docker bypasses ufw for published ports; that is fine here because only Caddy publishes 80/443.

## Install

```sh
sudo useradd -m -G docker pandora
sudo mkdir -p /opt/pandora && sudo chown pandora: /opt/pandora
sudo -u pandora git clone https://github.com/ckibunenko/pandora.git /opt/pandora
cd /opt/pandora && sudo -u pandora git checkout <release tag or commit>
sudo -u pandora cp .env.demo.example .env.demo && sudo chmod 600 .env.demo
```

Edit `.env.demo`:

| Variable | Public value |
|---|---|
| `DEMO_DB_PASSWORD` | 12–128 random URL-safe characters (never reused) |
| `DEMO_USER_PASSWORD` | the shared password for the seeded demo accounts that visitors use (12–256 characters) |
| `DEMO_DOMAIN` | the public DNS name, e.g. `demo.example.com` |
| `DEMO_TLS` | an ACME contact email (Caddy obtains and renews Let's Encrypt certificates) |
| `DEMO_BIND` | `0.0.0.0` |
| `DEMO_PORT` / `DEMO_HTTPS_PORT` | `80` / `443` |
| `DEMO_HSTS` | `max-age=31536000`, only once HTTPS works for this name |

Build and initialize (the reset also creates a new demo from fixtures):

```sh
sudo -u pandora docker compose --env-file .env.demo -f compose.demo.yml build api web
sudo -u pandora node --env-file=.env.demo scripts/demo-reset.mjs
```

## Verify

```sh
curl -sI http://$DOMAIN/ | grep -i -e '^HTTP' -e location      # 308 → https://$DOMAIN:443/
curl -sI https://$DOMAIN/ | grep -i -e '^HTTP' -e x-content-type-options -e strict-transport-security
curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/api/health/ready     # 200
curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/mail/                 # 200
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE https://$DOMAIN/mail/api/v1/messages   # 405
```

Then sign in as a seeded account, submit the draft `PO-000001` as `retailer@tabletop-lantern.test`, and check that two emails appear at `https://$DOMAIN/mail/`.

## Daily reset (03:00 Europe/Belgrade)

```sh
sudo cp deploy/demo/systemd/pandora-demo-reset.{service,timer} /etc/systemd/system/
# Adjust User=, WorkingDirectory=, and the node path in the service if they differ.
sudo systemctl daemon-reload
sudo systemctl enable --now pandora-demo-reset.timer
systemctl list-timers pandora-demo-reset.timer        # next run 01:00 UTC (summer) / 02:00 UTC (winter)
sudo systemctl start pandora-demo-reset.service       # run once now
journalctl -u pandora-demo-reset.service -n 50        # outcome and errors
```

- The timer uses `OnCalendar=*-*-* 03:00:00 Europe/Belgrade`, so it follows daylight saving time independently of the server's time zone. `Persistent=true` runs a missed reset after downtime.
- **Cron alternative**, only with a cron that supports `CRON_TZ` (cronie; Debian's default cron does not):

  ```text
  CRON_TZ=Europe/Belgrade
  0 3 * * * cd /opt/pandora && /usr/bin/node --env-file=.env.demo scripts/demo-reset.mjs >> /var/log/pandora-demo-reset.log 2>&1
  ```

## Update and rollback

- **Update:** `git fetch && git checkout <new tag>`, rebuild `api web`, then run the reset. It deploys migrations and restores fixtures; demo data is disposable by design.
- **Rollback:** check out the previous tag, rebuild, and reset. A migration that already ran is not reverted; restore from a fresh volume (`docker compose ... down -v` on the demo project only) if the old code cannot run on the newer schema.

## Recovery

- **A failed reset leaves maintenance on and the API and worker stopped.** Read `journalctl -u pandora-demo-reset.service`, fix the cause, and run the reset again. Never remove `/maintenance/enabled` by hand while data is in an unknown state.
- **Lock:** a killed reset can leave `/maintenance/reset-lock`. Only when no reset is running: `docker compose --env-file .env.demo -f compose.demo.yml run --rm --no-deps web rmdir /maintenance/reset-lock`. Details are in the [demo reset runbook](demo-reset-verification.md).
- **Certificates:** Caddy keeps its certificates in the `demo-caddy-data` volume. Do not delete it on every deploy (Let's Encrypt rate limits).

## Known limits

- **No monitoring or alerting:** failed resets are visible only in the journal and as the maintenance page.
- **No backups:** the demo is restored from version-controlled fixtures daily.
- **Shared accounts:** visitors share the seeded accounts. An administrator account can change other accounts (for example passwords) until the next reset.
- **Public inbox:** emails are fictional and the inbox cannot be changed by visitors, but anyone can read it. Mailpit keeps its default message limit, and every reset empties it.
- **Rate limiting:** sign-in is rate-limited per email (5 attempts per 15 minutes); there is no per-IP limit.
