# Handoff: Bullizard

State of the project for whoever picks it up next (a person or another Claude session). Read this first, then
`README.md` (how to run) and `docs/ARCHITECTURE.md` (how each feature works).

## Where things stand (Oct 22, 2026)

- All work is on `main`. CI (api, web, e2e, load, contracts, fraud-gnn, sdk-python) is green.
- 14 rounds of features are built: 84 of 92 suggestions. The tracker lives in the Claude report doc
  ("Bullizard report"), which has the full list with statuses.
- Tests: 70 API test files (multinode excluded), 110+ browser tests (31 files), 14 contract tests. See Round 16.

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
- NOWPayments account + sandbox keys; rank commission rates and thresholds (CEO; placeholders are in migration 055);
  the rules-test questions (support can edit them in the ops console); whether `PAYOUT_HOLD_DAYS` stays.

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

## Round 16 (Oct 22, 2026) — launch brief, part 2: everything else in the brief

Built and tested; migrations 055–063. All API test files pass (70 files, multinode excluded as before) and the browser suite
is green. Highlights, in the brief's order:
3/4/5. Commission is a gross-up (`domain/commission.ts`): buyer price = ceil(seller price ÷ (1 − rate)); the seller receives
   their price exactly. Rate = the seller's rank (`seller_ranks`: Hatchling 13.99% → Dragon 9.99% by 30-day sales, staff-editable
   at `PUT /v1/admin/ranks`, ops tab "Seller ranks") or the launch promo (5% for 60 days from the first listing/proposal,
   `commission_settings`). `users.commission_rate_bps` is refreshed on each order and hourly; `GROSS_SQL` prices listings in SQL
   (public `price_cents` is the buyer price, `seller_price_cents` the seller's; tiers likewise). Sell form shows a live preview
   (`GET /v1/seller/price-preview`): buyers pay in USD/EUR/EGP, "You earn" = the price, fee details link to the help centre.
   Proposals on buyer requests are grossed up the same way.
7. Currencies USD/EUR/EGP (GBP dropped). `FX_PROVIDER=live` merges ECB with open.er-api.com (EGP). The web picks the
   currency from the viewer's time zone / language on first visit (Egypt → EGP, euro area → EUR), switchable; checkout locks it.
NEW 1–3. Games: Aion / Aion 2 (server + region), Albion Online (server), Path of Exile 1 & 2 (league + Softcore/Hardcore).
   Challenge leagues are a table (`game_leagues`, support opens/ends them, ops tab "Leagues"); when a league ends, listings in it
   from sellers not seen for 14 days expire (`expired` status, worker `league_expiry`); sellers relist into an open league.
   Games that deliver in-game need the buyer's character name / UID (`handoverFieldFor`): confirmed in one tap at checkout,
   remembered on the account (`users.handover_names`), stored on the order. Proof of delivery (`DELIVERY_PROOF_REQUIRED`):
   manual in-game deliveries need a photo/video chat attachment from the seller (`proofAttachmentId`); attachments now accept
   MP4/WebM up to 50 MB (scanned, stored as-is); the buyer sees the proof on the order.
8 / NEW 5. Onboarding (`domain/onboarding.ts`): Tier 1 + a passed rules test (`rules_questions`, staff-editable, ops tab
   "Rules test") gate the first listing (`requireSeller`); identity (Tier 2) is due 30 days after the first listing: reminders at
   7 and 1 days, then listings pause and selling/withdrawals stop (`selling_restricted_at`) until KYC approval lifts it.
9. Chat filter: Facebook/Messenger/Instagram, emails (allowed only in account-order rooms), links (except bullizard.*),
   @handles, "add me", and disguised spellings (`squash()`: d1scord, d i s c o r d). Warnings use the launch wording with no
   strike counts; `OFFPLATFORM_SUSPEND_STRIKES=1` makes the first offence a ban.
10. Launch phases: `categories.phase` + `launch_settings.phase` (1 = currency/items/top-ups; 2 + accounts/boosting; 3 all),
   `category_open()` hides closed categories from search and pages and refuses listings in them; CEO switches the phase from
   ops tab "Seller ranks". Tests run at phase 3 (`test/helpers.ts`).
NEW 6. Founding Sellers: stamped on the first listing while `launch_settings.founding_until` is open; badge on listings and
   shop pages; free featured spots (`offers.featured_until`, 2 at a time, 7 days) that lead every search ordering.
NEW 7. Game voting (`/games/vote`, `game_suggestions`); staff mark planned/added/declined. NEW 8. Creator affiliate codes
   (`affiliates`, finance ops tab "Creator codes"): a buyer attaches a code once (signup `creatorCode` or `/me/affiliate`);
   every completed order pays the creator a share of the commission into their balance.
NEW 9–11. Official order message (`system_order` chat kind, server-only, framed card with the order ref, item, character and a
   status chip; posted at creation and on each status change), the staff-managed "Stay safe" panel (`site_texts.chat_safety`,
   `PUT /v1/admin/texts/chat_safety`), and human order IDs `order#XXXXXXX` (`orders.ref`).
11. Arabic: order, orders list, account and checkout components are translated (see `i18n/ar.ts`, ~300 new keys).
Design updates applied: underpayments are never refunded; when the window closes the money goes to the buyer's credit
   (`creditPartialPayments`, spendable at checkout or withdrawable through `POST /v1/me/credit/withdraw`, withdrawals carry
   `source`); outside-contact messages are not delivered (422 `offplatform_blocked`, stored hidden for the moderation queue)
   and the action per offence is staff-set (`moderation_settings.offplatform_actions`, ops tab "Moderation").
Demo: the mock mirrors all of it (`bz.demo.v26`); seeded sellers have ranks/promo states, PoE leagues, a founding seller
with a featured listing, a creator code `ARCANE-TV`, and a game-vote board.

## Round 17 (Oct 22, 2026) — the Designer's "needs back-end" list, on top of the new look

The Designer's pages (commits cd40cfe…37b9323) sit on top of Round 16; this round closes the three things those
screens were waiting for, plus a slot for game logos.

1. **Seller rank on listings.** `OFFER_LIST_SQL` now returns `seller_rank` (the name stored on `users.seller_rank`
   by `refreshSellerRate`), so listing tables and the offer page show the rank pill. Demo mock does the same.
2. **Coins too small for the order are greyed, not hidden.** `NowPaymentsProvider.coinsFor` returns every coin with
   `minUsd` and `available`; `GET …/crypto/coins` lists available ones first, and `POST …/crypto/pay` still refuses an
   unavailable coin (`coin_unavailable`). The checkout shows the greyed coin with "Too small for this coin (min $X)".
3. **"From your balance" at checkout.** The web now sends `useCredit: true` on every buy and cart checkout, so a
   buyer's balance (referral rewards, kept underpayments) is spent first:
   - `POST /v1/orders/cart` accepts `useCredit`; a cart the balance covers completely is funded at once
     (`fundWithoutCard` per order, checkout `status: 'paid'`, no payment step). Partial cover charges only the rest.
   - Cart views return `credit_cents`, `charged_cents`, `ref` and `character_name` per order.
   - Order and cart checkout summaries show Price / From your balance / To pay, and the coin step is priced on
     what is left (`charged_cents`).
   - Demo: `window.__bzDemo.credit(cents)` tops up the signed-in user's balance (used by the browser test).
4. **Game logos.** `apps/web/src/components/GameArt.tsx` shows `/games/<slug>.(webp|png|svg)` when the file exists
   (see `apps/web/public/games/README.md`); the owner drops in the official logos under each publisher's fan-kit
   terms. Until then tiles show the name only.

Tests: `cart.test.ts` (balance spent first / fully covered cart), `crypto-payments.test.ts` (greyed coins),
`e2e/crypto.spec.ts` (greyed Monero with reason; balance → "From your balance" → paid-at-once). 70 API files and
117 browser tests green.

## Suggested next round

1. Handover check for Riot/Steam games without a linked listing: let the buyer link any account of the game's
   platform and show "signed in" to staff in dispute case files.
2. Seller-side view of a buyer's reputation before accepting a buyer request proposal.
3. Retention digest: per-game breakdown and a link to the cohort that moved most.
