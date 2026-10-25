# Hosting proposal (Back-End, 2026-10-23)

The web app stays on Vercel. The API, the background worker, the WebSocket server and Redis can't run on
Vercel (long-lived processes, sockets, a private network for ClamAV), so they need a container host.
Neon is the database everywhere (staging on a Neon branch, production on the main branch).

## Recommendation: Render

| | Render (recommended) | Railway | Fly.io |
|---|---|---|---|
| Setup | `render.yaml` blueprint already in the repo: API, worker, Redis, ClamAV, disk, pre-deploy migrations | Per-service clicks or a `railway.json`; no blueprint for the whole stack | `fly.toml` per app; Redis via Upstash add-on; ClamAV as a second app |
| WebSockets | Yes | Yes | Yes |
| Private network (API ↔ ClamAV/Redis, no public ports) | Yes, by default | Yes | Yes (6PN) |
| Migrations before each deploy, rollback on failure | `preDeployCommand` | Manual (deploy hook) | `release_command` |
| Health-check based deploys | `/readyz` | Yes | Yes |
| Region near MENA | Frankfurt | Amsterdam (EU West) | Amsterdam / Paris |
| Ops effort | Lowest: one blueprint, dashboard logs, zero-downtime deploys | Low | Medium: CLI-first, more knobs |
| Price (see below) | Mid | Similar, usage-based | Lowest for tiny apps, climbs with RAM |

Render wins on setup time and on the ClamAV requirement (`MALWARE_SCANNER=clamd` is mandatory in production and
the signature database needs ~2 GB RAM in a private service). Railway is the fallback if Render's EU region is
ever a problem; the Dockerfile and env vars are the same.

## Costs (monthly, USD, list prices as of Oct 2026 — confirm on the pricing pages before signing up)

### Staging (`render.yaml`)
| Item | Plan | Cost |
|---|---|---|
| API (worker runs in-process) | Render Starter, 512 MB | 7 |
| Redis | Render Key Value Starter, 256 MB | 10 |
| Uploads disk 1 GB | | ~0.25 |
| Database | Neon Free (0.5 GB, auto-suspend) or a branch of the Launch plan | 0 |
| Web | Vercel Hobby (preview env) | 0 |
| **Total** | | **≈ 17** |

Staging drops ClamAV (≈ 25): `render.yaml` runs `NODE_ENV=production` + `APP_ENV=staging` + `MALWARE_SCANNER=dev`
(Round 23a; `NODE_ENV=staging` is not a valid value). Uploads are then not scanned there, which is fine for
money-path testing but not for testing uploads.

### Production (`render.production.yaml`)
| Item | Plan | Cost |
|---|---|---|
| API | Render Standard, 2 GB (2 instances at launch: 50) | 25 |
| Worker (jobs, emails, league expiry, ID reminders, payouts) | Render Starter | 7 |
| Redis | Render Key Value Standard, 1 GB | 32 |
| ClamAV | Render Standard private service | 25 |
| Uploads | S3-compatible bucket (`STORAGE_PROVIDER=s3`), ~5 GB | ~1 |
| Database | Neon Launch (10 GB, point-in-time restore 7 days, branches) | 19 |
| Web | Vercel Pro (custom domain, analytics, team) | 20 |
| Email (Postmark) + SMS (Twilio) | starter tiers | 15–30 |
| **Total** | | **≈ 130–150** (≈ 155–175 with a second API instance) |

Not included: Sentry (free tier works), the domain (~15/yr), NOWPayments (per-transaction, no monthly fee), Sumsub
KYC (per verification).

## What I need from you

1. **Render account** (render.com) on bullizard.gaming@gmail.com, add me as a collaborator or run the blueprint yourself:
   New → Blueprint → this repo → it asks for `DATA_ENCRYPTION_KEYS`, `PUBLIC_WEB_URL`, `PUBLIC_API_URL`, `DATABASE_URL`.
2. **Neon**: in the existing project create a branch `staging` from `main`; paste its pooled connection string as
   `DATABASE_URL` in Render (never in chat). Production uses the `main` branch string.
3. **Domain**: which one? Staging needs `staging.<domain>` (Vercel) and `api-staging.<domain>` (Render) on the same
   registrable domain, or sign-in is lost on reload (`SameSite=Strict` cookie). Production: `<domain>` + `api.<domain>`.
4. **Vercel**: add a `staging` environment (or a `staging` branch) with `VITE_DEMO=false` and
   `VITE_API_URL=https://api-staging.<domain>`. The production environment gets the same two with the production API.
   Until these are set, `vercel.json` builds the demo (`VITE_DEMO=true`), so the live site is a demo.
5. **Secrets you keep**: the `DATA_ENCRYPTION_KEYS` value (`echo "v1:$(openssl rand -base64 32)"`). Without it, data
   encrypted with it can't be read. Store it in a password manager.
6. Later: NOWPayments sandbox keys (for the underpayment path on staging), an email provider key, Sentry DSN.

## Staging money-path check

Once the staging API answers on `/readyz`, run from the repo:

```
API_URL=https://api-staging.<domain> STAFF_EMAIL=<support login> STAFF_PASSWORD=... npx tsx apps/api/scripts/money-paths.ts
```

It exercises pay, duplicate webhook, confirm, double-click confirm, double-click buy, early confirm, staff release
(24-hour rule), dispute, withdraw (fee quote + request), chat filter and reports underpay as skipped until the
NOWPayments sandbox keys are in. The same script runs against a local API (`npm run dev` in `apps/api` with
`SANDBOX_MODE=true PAYMENT_PROVIDER=mock`).
