# Handoff: Bullizard

State of the project for whoever picks it up next (a person or another Claude session). Read this first, then
`README.md` (how to run) and `docs/ARCHITECTURE.md` (how each feature works).

## Where things stand (Oct 9, 2026)

- All work is on `main`. CI (api, web, e2e, load, contracts, fraud-gnn, sdk-python) is green.
- 14 rounds of features are built: 84 of 92 suggestions. The tracker lives in the Claude report doc
  ("Bullizard report"), which has the full list with statuses.
- Tests: 255 API tests (65 files), 103 browser tests (27 files), 14 contract tests.

## Layout

| Path | What |
|---|---|
| `apps/api` | Fastify 5 + Postgres API and worker. Migrations in `migrations/` (latest 054), business logic in `src/domain/`, routes in `src/routes/`, providers (payments, KYC, email, Steam/Riot…) in `src/providers/` |
| `apps/web` | React 19 + Vite + Tailwind v4 web app. `src/demo/` is an in-browser mock of the API used for previews and browser tests |
| `contracts` | `MarketEscrow.sol` (Hardhat) |
| `services/fraud-gnn` | Python fraud model service |
| `sdks/` | TypeScript and Python SDKs |
| `mobile/` | Android (TWA) and iOS (Capacitor) shells, see `docs/MOBILE.md` |
| `docs/` | Architecture, staging, runbook, mobile |

## Running it

See `README.md`. Postgres must be running before `npm run migrate` (on Windows: Docker Desktop and
`docker compose up -d postgres redis`, or install PostgreSQL 16 and create user/db `market`/`market`).
Front end only, no database: `VITE_DEMO=true npm run dev:web`.

## Checks before pushing

```bash
npm run typecheck -w apps/api
npm test -w apps/api                       # needs Postgres (and Redis for a few tests)
npm run build -w apps/web
VITE_DEMO=true npm run build -w apps/web && npm run e2e -w apps/web
```

## Conventions that matter

- Every API feature also gets a matching route in `apps/web/src/demo/mock.ts` (and seed data in `seed.ts`
  if useful), or the demo and browser tests break. Bump the storage key in `mock.ts` when the seed shape changes.
- Pure modules shared with the web app live in `apps/api/src/domain/` with no imports (`safety.ts`, `csv.ts`,
  `platforms.ts`).
- The seller hub (`Sell.tsx` and its components) is translated into en/ar/es/fr/de/pt; Arabic plurals need
  `_zero/_two/_few/_many`. Order, account and staff screens are English only. Customer emails are translated in
  `apps/api/src/domain/locales/`, and `test/locale.test.ts` renders every template.
- New test files: check the name isn't taken (`test/retention.test.ts` is the data-retention job; the
  retention dashboard test is `cohorts.test.ts`).
- Unlayered rules in `styles.css` beat Tailwind utilities; hide file inputs with the `.file-input` class.
- Production config guards refuse mock providers where it matters (`MALWARE_SCANNER`, `PLATFORM_ACCOUNTS`);
  `docker-compose.yml` sets the production values.

## Waiting on the owner

- Riot production app (for Riot account linking); optional Steam Web API key.
- Render staging (`docs/STAGING.md`), Chainlink VRF subscription.
- Google Play / Apple developer accounts and a decision on store payment rules (`docs/MOBILE.md`).
- Translation review, game artwork, outside security test, contract audit, legal review.

## Round 14 (Oct 10, 2026)

Built and tested; migrations 051–052:
1. Handover check (`domain/linkedAccounts.ts` `startHandover`, `domain/orders.ts` `recordHandover`): the buyer of a
   delivered account signs in to it from the order page; the `account_linked` checklist step (auto, only on listings
   that showed a linked account) is ticked, the link moves from seller to buyer, and `confirm` with
   `handoverConsent: true` releases early. Demo: the "Diamond 1 smurf" Valorant order.
2. Minimum buyer reputation (`min_buyer_reputation` on offers, `HIGH_VALUE_CENTS` in `domain/buyerReputation.ts`):
   opt-in on listings of 100.00+, enforced in `createOrder`. Seller hub checkbox (6 languages), "Established buyers
   only" badge.
3. Weekly retention digest (`domain/retentionDigest.ts`, worker job `retention_digest`, template `retention_digest`):
   Mondays UTC to staff with `analytics.view`; `COHORT_ALERT_*` thresholds in `.env`.

## Round 15 (Oct 22, 2026) — launch brief, part 1: money paths and the release rule

Built and tested; migrations 053–054. The brief is the project doc "backend-change-brief.md".
1. NOWPayments provider (`providers/payments/nowpayments.ts`, `domain/cryptoPayments.ts`): own coin picker (only coins whose
   minimum fits what is owed), payment address + amount, IPN (HMAC-SHA512 over the sorted body) funds the order like a card
   capture, settled at what reached the wallet; underpayment → top-up sharing the purchase id; carts pay with one payment
   (`/v1/checkouts/:id/crypto/*`). Refunds are manual: `crypto_refunds` queue, `refunds_payable` ledger account, buyer gives an
   address, CFO records the hash. Card checkout stays available as `PAYMENT_PROVIDER=stripe|mock`; on-chain escrow is behind
   `ONCHAIN_ESCROW_ENABLED` (off).
2. Crypto payouts (`domain/cryptoPayouts.ts`): payout address confirmed by email link + 2FA code; withdrawals take 6% (min $1.50),
   move the gross to `withdrawals_pending`, wait for `treasury.approve`; approval books the fee and sends through NOWPayments
   (JWT + TOTP verify); the payout IPN marks it paid or reverses it. Ops tab "Payouts".
3. Release rule: standard orders are `until_confirmed` (no `protection_ends_at`, no auto-release); staff release from 24h after
   delivery (`orders.release`, ops tab "Releases"); sellers file a follow-up that opens a high-priority support ticket. Accounts
   keep the 14-day window.
Still to do from the brief, in its order: commission gross-up + sell-form preview (3, 5), games and listing fields + PoE league
expiry + proof of delivery (NEW 1–3), seller onboarding (8, NEW 5), chat filter (9), currencies + Arabic (7, 11), ranks + extras.

## Suggested next round

1. Handover check for Riot/Steam games without a linked listing: let the buyer link any account of the game's
   platform and show "signed in" to staff in dispute case files.
2. Seller-side view of a buyer's reputation before accepting a buyer request proposal.
3. Retention digest: per-game breakdown and a link to the cohort that moved most.
