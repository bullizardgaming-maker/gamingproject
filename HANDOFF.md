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
- Render account + Neon staging branch + domain names for staging (`docs/HOSTING.md`, `docs/STAGING.md`), Chainlink VRF subscription.
- Google Play / Apple developer accounts and a decision on store payment rules (`docs/MOBILE.md`).
- Translation review, the Designer's game banners (`apps/web/public/games/README.md`), outside security test, contract
  audit, legal review (the Terms page text in `terms.body` is an interim summary until Legal's version lands).
- NOWPayments account + sandbox keys (later, per the CEO); the rules-test questions (support can edit them in the ops
  console); whether `PAYOUT_HOLD_DAYS` stays. Rank rates are final: Hatchling 13.99% → Scale 12.99% → Fang 11.99% →
  Basilisk 10.99% → Dragon 9.99% (migration 055, editable in Ops → Ranks).

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
4. **Only launch games can be listed.** Migration 064 adds `launch_settings.allowed_games` (seeded with the five
   launch games; `NULL` opens every game) and `game_allowed(game)`; `createOffer` refuses others with
   `game_not_open`. Staff edit the list in Ops → Ranks → "Games sellers can list" (`PUT /v1/admin/launch
   { allowedGames }`); game-vote winners go there. The test harness sets it to NULL.
5. **Game logos.** `apps/web/src/components/GameArt.tsx` shows `/games/<slug>.(webp|png|svg)` when the file exists
   (see `apps/web/public/games/README.md`); the owner drops in the official logos under each publisher's fan-kit
   terms. Until then tiles show the name only.

Tests: `cart.test.ts` (balance spent first / fully covered cart), `crypto-payments.test.ts` (greyed coins), `launch-phase.test.ts` (allowed games),
`e2e/crypto.spec.ts` (greyed Monero with reason; balance → "From your balance" → paid-at-once), `e2e/launch.spec.ts`
(allowed games panel). 70 API files and 119 browser tests green.

## Round 18 (Oct 23, 2026) — the front end's eight requests (`claude/frontend-requests-for-backend.md`)

API only; the Designer's demo mock already speaks these shapes. Migration 065.

1. **Currency sold by amount.** Offers take `unitLabel` ("M", "k", "orbs"), `unitSize` (game currency per unit) and
   `minQty` (currency category only; `cleanUnit` in offers.ts). Listings return `unit_label`, `unit_size`, `min_qty`,
   `price_per_unit_cents` (= the grossed-up unit price) and `stock_qty`. `POST /orders { quantity }` is in units; below
   `min_qty` → 400 `below_minimum`; quantity cap raised to 1,000,000. New sorts on `GET /offers`: `recommended`
   (rating ÷ price), `min_qty_asc`, `delivery`.
2. **Badges and presence.** `GET/PUT /seller/badges` (up to 2 of the earned ones: `rank:<name>`, `founding`,
   `id_verified`, `top_seller`; domain/badges.ts). Offers and `GET /sellers/:id` return `seller_badges`; offers also
   `seller_last_seen_at` next to `seller_online`. A lost rank badge drops off when the rank is refreshed.
3. **Seller profile.** `GET /sellers/:id` adds `positive_pct_90d`, `orders_sold`, `delivered_pct`, `about` (= storefront
   intro), `languages`, `featured_offer_ids` (= pinned listings), `member_since` was already there. Sellers set
   `languages` (BCP-47 codes, max 8) through `PUT /seller/storefront`.
4. **Coins with network and fee.** `GET …/crypto/coins` items carry `network`, `fee_cents` (estimate the buyer pays
   from their wallet; defaults per coin in cryptoPayments.ts, overridable with `CRYPTO_NETWORK_FEES_JSON`),
   `total_cents` = owed + fee, `disabled` and `reason`. Popular coins first (USDT TRC-20/BEP-20/ERC-20, USDC, BTC,
   ETH, LTC, TRX, SOL). The payment itself is still created for the owed amount; the fee is informational.
5. **Confirm from `paid`.** `POST /orders/:id/confirm` works while the order is `paid`; `delivered_at` is stamped and
   the event reason is `buyer_confirmed_early`.
6. **Wallet.** `GET /me/wallet?limit&before` → `balances` per currency (buyer credit + released sales), `breakdown`
   (`credit_cents`, `credit_available_cents`, `sales_cents`), paged `entries` (`order` held/completed/cancelled,
   `sale`, `refund`, `credit`, `withdrawal` pending/completed/cancelled; `ref` is the order# or withdrawal#) and
   `next` (pass as `before`). `POST /me/withdrawals` withdraws the buyer balance under the seller rules (6%, min
   $1.50, confirmed address); `GET /me/withdrawals` lists them. domain/wallet.ts.
7. Nothing removed server-side (seller codes, cart, price history, 72h/14d) — endpoints stay; the order-created
   chat line now says "held until the buyer confirms" for `until_confirmed` orders.
8. **Translations.** `site_texts` has a `locale` column (PK key+locale); `GET /texts/:key?lang=ar` returns the
   locale's row or English; `PUT /admin/texts/:key { lang }` upserts, `GET /admin/texts/:key` lists locales. System
   chat messages carry `code` + `params` (`order_created`, `payment_received`, `delivered`, `completed`,
   `completed_early`, `staff_released`, `dispute_opened`, `dispute_statement`, `refunded`, `security_review`,
   `handover_confirmed`, `checklist_completed`, `underpayment_kept`, `refund_address_given`,
   `account_suspended_offplatform`, `account_banned_offplatform`); the English body stays for old clients.

Tests: `frontend-requests.test.ts` (one case per item), coin order/fields in `crypto-payments.test.ts`. 71 API files
(269 tests) green. Web untouched this round (the Designer's mock carries the same shapes).

## Round 19 (Oct 23, 2026) — CEO decisions and launch setup (`claude/next-tasks.md`)

1. **Hosting.** Proposal, costs and what the owner must provide: `docs/HOSTING.md` (Render recommended; Railway/Fly
   compared). `render.yaml` (staging) now takes a Neon branch as `DATABASE_URL`; `render.production.yaml` adds a
   separate worker, S3 uploads, Frankfurt region. The live Vercel site stays a demo until `VITE_DEMO=false` and
   `VITE_API_URL` are set on the Vercel environment.
2. **Staging money paths.** `apps/api/scripts/money-paths.ts` runs pay, duplicate webhook, confirm, double-click confirm,
   double-click buy, early confirm, staff release (24h rule, with the new sandbox route
   `POST /sandbox/orders/:id/age-delivery`), dispute, withdraw (quote + request), chat filter, and reports underpay as
   skipped until the NOWPayments sandbox keys exist. Run it against staging once the host is up (command in
   docs/HOSTING.md); it runs green against a local sandbox API.
3. **Front-end fixes.** Offers carry both the demo names and the API names (`price_per_unit_cents`, `stock_qty`,
   `unit_size`) — the mock emits both, the app reads either. Chat system messages render from `code` + `params`
   (`chat.ev.*` keys in all six languages, `systemText()` in Chat.tsx; the mock emits codes too), with a translated
   buyer/seller role.
4. **Referral like G2G.** Migration 066: `referral_settings` (`rate_bps` 2000, `active_days` 365, staff-editable via
   `GET/PUT /admin/referral`, Ops permission `ranks.manage`). On every completed order of a referred user the referrer
   earns `rate_bps` of Bullizard's commission, from treasury into their withdrawable balance (`seller_available`),
   starting with the friend's first completed order and continuing while the gap between their completed orders stays
   under `active_days`; blocked for linked accounts (`referral_rewards.reason`). The one-time credit, the minimum order
   and the monthly cap are gone (`REFERRAL_*` env vars removed). `GET /me/referral` returns the rate, friends, earnings
   and rewards; the wallet lists `referral` (and `affiliate`) entries. Web: "Invite friends" card on the account page,
   Home invite card at 20%, help article `invite-friends` (six languages), referral email in six languages.
5. **Buy box.** No checkbox. One line under Buy now — "By buying you agree to the Terms" — in six languages, "Terms"
   linking to the new `/terms` page (`terms.*` keys; Legal's text replaces `terms.body`). The API still receives
   `acceptTos: true` from the app, so the acceptance timestamp on the order is unchanged.
6. **Merchant API hidden.** `MERCHANT_API_ENABLED=false` by default: `/v1/developer/*` answer 404, API keys fail with
   `merchant_api_disabled`, `/v1/docs` and `/v1/openapi.json` are not mounted. `GET /v1/features` tells the app;
   `/developers` shows "Page not found" until it is on. Tests run with it on (`vitest.config.ts`);
   `merchant-api-switch.test.ts` covers off.
7. **Game art.** `GameBanner` replaces the logo slot: our own banner per game from `public/games/<slug>.webp` (Designer
   supplies; spec in `public/games/README.md`), a brand gradient until then, the game name always as text. Home tiles
   and the game-page header use it.
8. **Rank rates** are final as seeded; "placeholder" wording removed here (migration 055's comment is history).

Tests: `promos-fx.test.ts` (recurring referral, rate change, inactivity), `merchant-api-switch.test.ts`,
`e2e/launch-decisions.spec.ts` (terms line + Terms page, invite card and help article, translated chat notice, hidden
Developers page). 72 API files and 123 browser tests green.

## Suggested next round

1. Handover check for Riot/Steam games without a linked listing: let the buyer link any account of the game's
   platform and show "signed in" to staff in dispute case files.
2. Seller-side view of a buyer's reputation before accepting a buyer request proposal.
3. Retention digest: per-game breakdown and a link to the cohort that moved most.
