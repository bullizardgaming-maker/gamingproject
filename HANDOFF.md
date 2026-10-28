# Handoff: Bullizard

State of the project for whoever picks it up next (a person or another Claude session). Read this first, then
`README.md` (how to run) and `docs/ARCHITECTURE.md` (how each feature works).

## Where things stand (Oct 26, 2026, after Round 23c)

- All work is on `main`. CI (api, web, e2e, load, contracts, fraud-gnn) is green. Staging tests: four manual workflows (Round 23c).
- 14 rounds of features are built: 84 of 92 suggestions. The tracker lives in the Claude report doc
  ("Bullizard report"), which has the full list with statuses.
- Tests: 70 API test files (multinode excluded), 110+ browser tests (31 files), 14 contract tests. See Round 16.

## Layout

| Path | What |
|---|---|
| `apps/api` | Fastify 5 + Postgres API and worker. Migrations in `migrations/` (latest 081), business logic in `src/domain/`, routes in `src/routes/`, providers (payments, KYC, email, Steam/Riot…) in `src/providers/` |
| `apps/web` | React 19 + Vite + Tailwind v4 web app. `src/demo/` is an in-browser mock of the API used for previews and browser tests |
| `contracts` | `MarketEscrow.sol` (Hardhat) |
| `services/fraud-gnn` | Python fraud model service |
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
docker build -f apps/api/Dockerfile -t bz-api . && docker run --rm -v "$PWD/apps/api/scripts:/app/apps/api/scripts:ro" bz-api node scripts/check-runtime-imports.mjs
```
CI also starts the built image against Postgres and waits for `/readyz` (job `api-image`).

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
6. **Merchant API hidden** (removed entirely in Round 23c). `MERCHANT_API_ENABLED=false` by default: `/v1/developer/*` answer 404, API keys fail with
   `merchant_api_disabled`, `/v1/docs` and `/v1/openapi.json` are not mounted. `GET /v1/features` tells the app;
   `/developers` shows "Page not found" until it is on. Tests run with it on (`vitest.config.ts`);
   `merchant-api-switch.test.ts` covers off.
7. **Game art.** `GameBanner` replaces the logo slot: our own banner per game from `public/games/<slug>.webp` (Designer
   supplies; spec in `public/games/README.md`), a brand gradient until then, the game name always as text. Home tiles
   and the game-page header use it.
8. **Rank rates** are final as seeded; "placeholder" wording removed here (migration 055's comment is history).

Tests: `promos-fx.test.ts` (recurring referral, rate change, inactivity), `merchant-api-switch.test.ts`,
`e2e/launch-decisions.spec.ts` (terms line + Terms page, invite card and help article, translated chat notice, hidden
Developers page).

### Round 19, second pass (Oct 24) — copy deck, legal pack, support console gaps

Shared contract for the API/web split: `docs/ROUND19-CONTRACT.md`. The copy deck as read: `docs/copy-deck.md`.

**A. Front-end fixes and CEO decisions**
- Chat: the API now emits the deck's codes (`order_created`, `paid` {character}, `delivered`, `confirmed_early`,
  `completed`, `staff_released`, `follow_up`, `dispute_opened`, `dispute_buyer`, `dispute_seller`, `refunded`,
  `underpaid`, `delivery_late` as a warning). `systemText()` renders `sys.<code>` (deck §2.8, EN+AR) first, then the
  older `chat.ev.*` keys, then the server's English. No amounts in any of them.
- Referral: the share starts after the friend's **first** completed order (`referral_rewards.reason = first_order` for
  that one); active = a completed order in the last **30 days** (`referral_settings.active_days` now 30, migration
  067); still staff-editable. No per-order email: the hourly job `referral_digests` sends one `referral_earned` email
  per referrer per day (dedupe `referral_earned:<id>:<day>`).
- Buy box: "By buying you agree to the Terms" sits directly under Buy now at 13px (`.of-agree`), the link opens
  `/terms` in a new tab. `offer.tos` and `checkout.rules` are gone; the order page shows "Terms v{version} accepted on
  {date}" instead, linking to that exact version.
- Merchant API stays hidden (Round 19 first pass); `footer.api` deleted.

**B. Copy deck §8** — applied by the web pass: all `[CHANGE]`/`[NEW]` keys EN+AR, §0.4 keys deleted or gated behind
`PHASE2_UI` (full demo only), `err.<code>` mapping in `src/api.ts` (server message when no key; `err.generic` only for
5xx/unknown; `err.network` offline), `rank.name.*`/`rank.perk.*` wherever a rank shows, help-centre fixes +
`invite-friends`, per-game SEO blocks on the five launch game pages. Emails (`notifications.ts`, Arabic in
`locales/ar.ts`): new `welcome` (on sign-up), `order_completed`, `kyc_due_reminder` (replaces id_reminder/id_overdue),
`referral_earned` (daily digest), `legal_change`; rewritten per §5: `order_paid` (order ref, character, Terms version
+ link), `seller_new_order`, `order_delivered`, `seller_paid`, `dispute_opened`, `dispute_resolved` (per-side text),
`withdrawal_requested`, `withdrawal_paid`, `order_refunded` (back in balance), `delivery_late`, `delivery_overdue`,
`kyc_result`. Switched off (§5.13; inbox item still appears, no email, `notifications.status = skipped`):
`protection_ending`, `chargeback_received`, `warranty_claim`, `warranty_update`, `order_progress`, `request_posted`,
`request_proposal`, `request_accepted`. ES/FR/DE/PT copies of changed templates removed (English fallback until
translated). `site_texts.chat_safety` EN updated + AR row (§2.8). Auto-cancel/auto-refund of late orders is off:
`AUTO_REFUND_LATE_ORDERS=false` (default); `POST /orders/:id/cancel-late` answers 409 `disputes_only` and the worker
job skips; the late-delivery chat warning (`delivery_late`) still posts. Tests run with it on.

**C. Legal pack** (migration 067, `src/domain/legal.ts`, `apps/web/src/pages/Legal.tsx`)
- `legal_documents` (doc, locale, version, effective_at, title, content_md, sha256, material, created_by), seeded with
  interim English rows version `2026-10-24` for terms, privacy, seller-agreement, refunds, restricted-countries.
  Legal's approved text goes in through Ops: `PUT /admin/legal/:doc { lang, version, effectiveAt, title, contentMd,
  material }` (`support.manage`); a material change must take effect ≥ 14 days later, emails every active user once
  (`legal_change`) and shows a banner from `GET /features.legal.notice` until then; after it takes effect
  `GET /me/legal` reports `reacceptanceRequired` and the app shows an accept bar (`POST /me/legal/accept`).
- `TOS_VERSION` env var removed; the version comes from the table (`tosVersion()`), recorded on sign-up
  (`users.tos_version`, `tos_accepted_at`) and on every order (`orders.tos_version`), and sent in the order-paid email.
- Sign-up requires `acceptTerms: true` ("I'm 18 or older and agree to the Terms and Privacy Policy", links open in a
  new tab); 400 without it.
- Public pages `/terms`, `/privacy`, `/seller-agreement`, `/refunds`, `/restricted-countries` (API-backed, version +
  date on each, Arabic when a row exists), `/terms/history` (every version with its hash), `/terms/versions/:v`.
  Linked from the footer (with the `footer.legal` 18+ line) and a "Legal documents" block in the help centre.

**D. Support console gaps**
- Split decisions: `POST /admin/disputes/:id/resolve { outcome: 'split', refundCents, note }` → `refundCents` to the
  buyer's balance, the rest (minus its share of the commission) to the seller; `disputes.status = resolved_split`,
  `refund_cents`. Buyer-favour refunds of crypto/balance orders now land in the buyer's balance too (no on-chain refund
  queue; `postRefund`), withdrawable at the standard fee.
- Listing ban: `POST /admin/users/:id/listing-ban { on, reason }` (`moderation.manage`) sets `users.listing_banned_at`,
  pauses the seller's active listings (`expired_reason = listing_ban`) and restores them on lift; creating/relisting
  answers 403 `listing_banned`. Ticket category `appeal`.
- Rules test: `rules_questions.question_ar/options_ar/explanation_ar`, `GET /seller/rules-test?lang=ar`, pass mark 90%,
  the 13 deck questions seeded (old six retired). `PUT /admin/rules-test` accepts the Arabic fields.
- Ops → Moderation offence actions now `warn, suspend, ban`; instant ban for payment details (incl. Fawry, Orange Cash,
  Vodafone Cash, InstaPay, Etisalat Cash, bank/IBAN), wallet addresses, other marketplaces, recruiting, impersonation,
  ban dodging. Filter also catches Egyptian local numbers (01x…, Arabic digits), look-alike letters (Cyrillic/Greek/
  full-width), and platform names split across the sender's last three messages (`detectSplit`).
- Orders above $200 carry `lead_review: true` in `GET /admin/disputes`, `GET /admin/orders/unconfirmed` and the staff
  view of an order.

**E. Checked**
- Unverified sellers withdraw during their first 30 days; once `selling_restricted_at` is set (ID deadline passed) the
  crypto withdrawal path answers 403 `kyc_overdue` for earnings (refund credit stays withdrawable).
- Refunds (full and split) land in the buyer balance; `POST /me/withdrawals` charges 6% with the $1.50 floor.

**F. Staging** waits on the CEO's Render/Neon/domain/Vercel accounts (`docs/HOSTING.md`); then deploy and run
`apps/api/scripts/money-paths.ts`.

Tests: `round19.test.ts` (legal docs + notice + re-acceptance, split decisions, Lead flag, listing ban + appeal, filter
additions incl. split messages and instant ban, Arabic rules test, referral first-order rule), updates in
`crypto-payments` (refund to balance + withdrawal fee; 30-day withdrawal rule), `moderation`, `chat`, `promos-fx`,
`onboarding`, `locale`, `sessions-and-email`, `notification-centre`, `frontend-requests`; e2e `onboarding`, `crypto`,
`launch-decisions` updated. 73 API files green (the four date-window tests — analytics, exports, tax, clawback
statement — only fail when run between 22:00 and 24:00 UTC because the DB runs in Africa/Cairo); browser suite green.

## Round 20 (Oct 24, 2026) — review fixes (`claude/round-20-fixes.md`) and launch gate §2 + §4 (`claude/launch-gate.md`)

Migration 068. API tests: `chat-filter.test.ts` (109 phrases), `round20.test.ts`, `money-invariants.test.ts`, updates in
`crypto-payments`, `round19`, `release-rule`, `platform`, `affiliates-votes`, `promos-fx`, `escrow-flow`, `linked-accounts`,
`risk-and-chargebacks`, `seller-currency`, `warranty`, `chat`, `moderation`. Browser: `launch-decisions`, `launch` updated.

### Launch blockers
1. **Chat filter false bans.** Disguised-spelling matching now works on whole tokens only (`safety.ts` `disguisedHits`): a
   token or a run of adjacent tokens must spell the platform name exactly once squashed, so "even more" ⊅ venmo,
   "gazelle" ⊅ zelle, "scene bad" ⊅ eneba. Arabic "فوري" only counts next to a payment word (ادفع/حول/كود/رقم/محفظة/على …
   فوري, or فوري … دفع/كود/كاش), "التسليم فوري" passes; bare `we pay` dropped. `classify()` decides the action: instant
   ban only for a spelled-out hit of an instant-ban category (payment method, wallet address, marketplace,
   impersonation); loose phrases (`pay_outside`, `recruiting`, `ban_dodging`) and split-message hits are blocked and
   queued for staff with **no strike and no ban** (`chat_flags.strike`; dismissing one no longer refunds a strike that
   was never given). 59 normal EN/AR phrases must pass, 27 disguised/explicit ones must hit (`chat-filter.test.ts`).
2. **Late crypto deposits.** `crypto_payments.applied_at` marks the rows that funded an order. A deposit that arrives
   after the order was cancelled, or on top of a funded order, goes to the buyer's balance through `creditLateDeposit`
   (row lock; credits only `settled − credited_cents`; a later IPN never overwrites `credited`); a cart whose orders all
   lapsed is treated as closed even if the checkout row says otherwise, so one payment is credited once, not per order.
3. **Payout double-pay.** The withdrawal id is NOWPayments' `unique_external_id`. A 4xx reverses the withdrawal; a
   timeout/5xx leaves it `unknown` with the money still booked as paid out until `recheckUnknownPayout` asks the
   provider (hourly job `payouts_unknown`, or Ops → Payouts → "Check with provider now"): found → processing → paid by
   IPN; not found → reversed. Money never goes back on a guess (`NowPaymentsError.rejected`).

### Rules now enforced
4. **No auto-release, ever.** `autoCompleteExpired` only marks the end of the 14-day window (`protection_window_elapsed`
   event + chat note `protection_ended`); staff release account orders after the window (`releaseByStaff` allows it even
   with an unfinished changeover once the window is over).
5. **Payout address = email link + a second factor, always.** Authenticator when enabled, otherwise a 6-digit code by
   SMS (verified phone) or a separate email (`payout_address_code`), 5 attempts (`payout_address_changes.code_hash`).
6. **Lead-only above $200.** New staff role `lead` (Support Lead) with `orders.lead`; release, dispute decisions and
   refund-after-release on orders > $200 need it (server-side, `requireLeadForLargeOrder`). Ops role picker + demo updated.
7. **30-day rule inline.** `idDeadlinePassed()` from `seller_since` blocks listing and earnings withdrawals the moment the
   deadline passes, not only after the worker flags the account.
8. **Ban vs suspend.** `users.status` gains `banned` (never lifted automatically, `banned_at`), suspensions get
   `suspended_until` (lifted on the next request or by the hourly job). `POST /admin/users/:id/suspend {reason, days?}`,
   `/ban {reason}` (sessions revoked), `/reinstate {note}` (a ban needs `orders.lead`). Off-platform: contact share on the
   ladder → 7-day suspension; payment details → ban. Fraud confirmation → ban.

### Referral and creator codes (CEO, Oct 24)
9–13. One code per user, at sign-up only: `POST /auth/register { code }` (invite or creator; `referralCode`/`creatorCode`
   still accepted, two different codes → 400 `one_code_only`; response carries `codeApplied`). `POST /me/affiliate` → 410.
   A buyer with an invite code never also earns for a creator. No reward when the code owner is the order's seller.
   Rates capped at 50% of the commission (`rate_too_high`). Linked-account check adds `ip_subnet` and `wallet` (the
   paying wallet when the IPN reports it, and every confirmed payout address). Releases lock the buyer row first, so two
   first orders completing together count once (and can't deadlock). Web: code field on the sign-up form (pre-filled from
   `?ref=`), the apply-code box is gone, help article + invite copy say "entered at sign-up".
14. Test: a comeback order after 31+ days earns nothing; the next within 30 days earns again.

### Split disputes, legal, minor
15. Split: the promo-funded share of the refund goes back to the treasury (never withdrawable credit); the seller part
   carries reserve cut + commission tax like a full release; `orders.seller_received_cents` is what the wallet "sale" line
   shows.
16. Legal: a version in force is immutable (`version_in_force`; drafts not yet in force can be corrected); material
   changes need exactly 14 days; `tosVersion()` fails closed (503 `terms_unavailable`, `/features.legal.tosVersion` null)
   when no Terms are in force.
17. `createOrder` refuses listings in a closed launch-phase category (`category_not_open`). 18. `id_deadlines`,
   `referral_digests`, `payouts_unknown` run hourly, `ops_alerts` every 15 min (`every()` in worker.ts). 19. Web renders
   no categories until `GET /categories` answers. 20. `CARD_REFUNDS_ENABLED=false` (default): refunds always land in the
   balance; the gateway refund only runs when cards are on. 21. Em dash removed from `chat.ev.dispute_opened`.

### Launch gate §2 (automated checks)
- **Dependency audit: 0 vulnerabilities** in root, `apps/api`, `apps/web` (`npm audit fix`; `contracts/` — the on-chain
  escrow toolchain, not part of the launch — left the root workspace and keeps its own lockfile; CI runs it on its own).
  Python fraud service: `requirements.lock` (pinned) + `pip-audit` → no known vulnerabilities.
- **Secret scan**: gitleaks over all 105 commits → 2 findings, both the public USDC contract address in a test
  (allow-listed in `.gitleaks.toml`). Nothing to rotate. `.env` was never committed.
- **Static scan in CI**: `.github/workflows/security.yml` — gitleaks (full history), Semgrep (OWASP + JS/TS + Node +
  secrets + React + Python; 0 findings after fixes: explicit GCM tag length, mock checkout page isolated), CodeQL
  (JS/TS + Python, security-extended), npm + pip audits; on every push/PR and weekly.
- **Money property tests**: `money-invariants.test.ts` — 15,000 random cases of gross-up, split-dispute allocation and
  withdrawal fee arithmetic, plus randomised end-to-end scenarios (`MONEY_FUZZ_RUNS`, default 12) over confirm / staff
  release / refund / split / seller decisions with promo codes and double-clicks: books balance, closed orders hold no
  escrow, exactly one closing posting, conservation per order, nobody paid twice, withdrawals once.
- **ZAP**: `security/zap/zap-staging.yaml` + README — automation plan (auth, headers, CSP, CORS, cookies, rate limits,
  uploads via OpenAPI), fails on High; runs once staging is up.

### Launch gate §4 (damage limits)
- **Kill switches** (Ops → Controls, permission `controls.manage`: admin + finance): pause withdrawals / new orders /
  chat / sign-ups, each a 503 with its own code (`withdrawals_paused`, `orders_paused`, `chat_paused`,
  `signups_paused`) and an optional message; `GET /features.paused` drives a site banner; audited; 5-second cache.
- **Limits** (same panel, `platform_controls`): max order $500 in beta, max withdrawals $5,000 per user per day, new
  accounts (first 7 days) $100 per order and 3 open orders (`order_too_large`, `new_account_limit`, `withdrawal_limit`).
- **Alerts** (`opsAlerts.ts`, every 15 min, one email per condition per hour to admins + finance, plus an error log line
  for Sentry): failed payouts, payouts stuck `unknown`, a single withdrawal above $2,000, 3+ withdrawals by one user in
  24h, disputes opened per hour ≥ 5, bans per hour ≥ 3 (thresholds editable).

Suites on this commit: API 76 files / 405 tests green (typecheck clean), browser 121 green, `npm audit` 0 in root/api/web,
Semgrep 0 findings, gitleaks 0 real findings.

### Staging
`docs/STAGING-CHECKLIST.md`: the accounts to create, the exact values to paste (staging and production), the deploy
steps in order, `make-staff` script for staff roles. `render.yaml` / `render.production.yaml` carry the Round 19–20
switches (`AUTO_REFUND_LATE_ORDERS`, `CARD_REFUNDS_ENABLED`, `MERCHANT_API_ENABLED`, `RECON_INTERVAL_HOURS`).

## Round 21 (Oct 24, 2026) — CFO money review B1–B14 (`claude/cfo-money-review.md`)

CEO answers applied: payout hold new 1 day / established 0 / watch 14; 0.5% underpayment tolerance kept; 10% reserve kept;
Support Lead is the second approver above $500; referral pays on friends' purchases only (already the rule, `referrals.test.ts`);
USDT-only payouts (TRC-20 + BEP-20) at launch.

**Already done in Round 20, not redone:** B4 (kill switches), B5 per-user/order limits (`platform_controls`), and the
four-eyes rule on ledger adjustments (`requested_by <> decided_by`, since Round 7). Everything below is new, one test each.

| # | What changed | Test |
|---|---|---|
| B1 | NOWPayments fee booked once: gateway is debited the gross received (`settledAmountCents`), escrow gets the order amount, `psp_fee` moves the difference treasury → gateway. No more double count. | `crypto-payments.test.ts` "books the fee once" |
| B2 | Payout network/conversion fees from the payout IPN (`fee`, `conversion_fee`) are stored on the withdrawal (`network_fee_cents`, `conversion_fee_cents`) and posted treasury → gateway_clearing under `payout_network_fee:<id>` / `payout_conversion_fee:<id>`. `PAYOUT_COINS = usdttrc20, usdtbsc`; any other payout address → 400 `unsupported_coin`. | `crypto-payments.test.ts` payout IPN fee + `btc` refusal |
| B3 | No VAT until a company exists: `PLATFORM_TAX_COUNTRY` is optional and unset by default; with no home country every order is `outside_scope`, 0 tax, no `tax_payable` leg. Set the country the day the company is registered. | `round20.test.ts` "no VAT until a company exists" |
| B5 | Platform-wide payout cap: `max_platform_payout_day_cents` (default $20,000, Ops → Controls) — approvals past it in a rolling 24h → 409 `platform_payout_cap`. | `crypto-payments.test.ts` four-eyes/cap |
| B6 | Overpayment above the 0.5% tolerance → buyer's store credit (`user_credit`), order event `overpayment_credited`, chat system message `overpaid`; carts split it per order. | `crypto-payments.test.ts` "overpayment" |
| B7 | Reconciliation: `RECON_TOLERANCE_CENTS=100`; NOWPayments balance values **every** coin in USD (stables 1:1, others via `/v1/estimate`; a coin that can't be valued fails the run instead of being ignored); totals include `user_credit`, `withdrawals_pending`, `refunds_payable`, `tax_payable`, `fx_pnl`; a daily row in `reconciliation_snapshots`; `GET /admin/reconciliation/snapshots`. | `crypto-payments.test.ts` reconciliation |
| B8 | `PAYOUT_HOLD_DAYS_NEW=1`, `PAYOUT_HOLD_DAYS_ESTABLISHED=0`, watch-listed 14. | `payout-holds.test.ts` |
| B9 | Four-eyes on withdrawals: amount > `four_eyes_withdrawal_cents` ($500) or the user's day > `four_eyes_user_day_cents` ($1,000) needs a second approver with the Lead role (`lead` now holds `treasury.approve`). First approval records `first_approved_by/at` and returns `needs_second_approval: true`; same person again → 403 `four_eyes`; non-Lead second → 403 `lead_required`. Audited as `withdrawal.first_approve` / `withdrawal.approve`. | `crypto-payments.test.ts` four-eyes/cap |
| B10 | The $0.50 minimum charge only applies when `CARD_PAYMENTS_ENABLED=true` (default false): a balance-funded order charges exactly what is owed, down to $0.01. | `promos-fx.test.ts` |
| B11 | Ops → Crypto refunds tab hidden (refunds go to balance only); the panel and API stay for later. | browser suite |
| B12 | `FX_SPREAD_BPS=0`; `PAYOUT_CURRENCIES=USD` — `PUT /seller/payout-currency` refuses anything else with 400 `payout_currency_locked` (widen the list later); the currency picker shows `≈ EUR` / `≈ EGP` with "EUR and EGP are approximate; you pay and get paid in USD." | `seller-currency.test.ts`, `promos-fx.test.ts` (EGP, no spread) |
| B13 | `GET /admin/analytics` has a `money` section: promo cost, referral + creator cost, NOWPayments + payout network fees (treasury debits by memo in the period), buyer credit outstanding, withdrawals pending (count + amount), median hours from paid to released. Ops → Business shows it as a KPI row. | `analytics.test.ts` "CFO B13" |
| B14 | Coin list copy: "≈ $X network fee, paid by your wallet" and the note that fees come out of the wallet, not the order — all six languages. | browser suite |

New config (all in `.env.example`, `render*.yaml`): `PAYOUT_HOLD_DAYS_NEW=1`, `PAYOUT_HOLD_DAYS_ESTABLISHED=0`,
`PLATFORM_TAX_COUNTRY` (unset), `RECON_TOLERANCE_CENTS=100`, `FX_SPREAD_BPS=0`, `CARD_PAYMENTS_ENABLED=false`,
`PAYOUT_CURRENCIES=USD`. Migration `068_round20.sql` gained the withdrawal fee/first-approver columns, the three
controls and `reconciliation_snapshots` (re-run `node dist/migrate.js` on staging; it is idempotent).

Ops → Controls gained: platform payouts per day, four-eyes single withdrawal and user-day thresholds.

## Round 22 (Oct 25, 2026) — review fixes (`claude/round-22-fixes.md`)

Migration **069** (`069_round22.sql`, idempotent; re-run `node dist/migrate.js` on staging). New config
`PAYOUT_UNKNOWN_REVERSE_HOURS=6`. CI runs the money property tests with `MONEY_FUZZ_RUNS=40` (default 25 locally).
New tests: `round22.test.ts` (one case per item), `chat-filter.test.ts` + `test/fixtures/chat-phrases.ts` (the permanent
fixture), `money-invariants.test.ts` (rewritten on the NOWPayments path), shared fake provider `test/fakeNowPayments.ts`;
updates in `chat`, `moderation`, `round19`, `round20`, `unit`, `crypto-payments`. Browser: `launch-decisions` (categories retry).

**Chat filter decision** (`safety.ts` `classify`, `chat.ts`, `moderation.ts` `decideChatFlag`). Every hit is blocked (not
delivered) and queued for staff with **no strike**; a strike (and the staff-set warn → suspend → ban ladder) only happens
when staff confirm the flag. Automatic ban only for the unambiguous: a chat/payment link (t.me/x, wa.me/…, paypal.me/x,
discord.gg/…), a full phone number with a messenger or payment name ("whatsapp 0101234567", "my wats app is 0101234567"), a
handle with a messenger name ("telegram @x", "discord: pat#1234", "snap: x"), a payment name with an email, a wallet address
offered for payment ("send to 0x…"). Split-message hits never ban. Fixed false hits: Arabic فوري only as Fawry next to a
payment word (whole words; الكود/تحويل/على طول no longer match), g2g/Eldorado need a shopping context or the site name,
impersonation needs a claim about Bullizard/the site, "my id/username is", "hmu", "add me as friend in game", "insta
delivery", "tele port", "line id", "ok.gg", "10.co" pass. Newly caught: "wats app", "on dc", "my disc is", any link with a
path (bit.ly/abc). Top-up and in-game-delivery rooms strip labelled player IDs/UIDs before the phone check. A filter ban
revokes every session, like the admin ban (item 20). Fixture: 140+ normal phrases (EN + Egyptian/MSA Arabic, top-up IDs) never flagged; 50 disguised/explicit contacts blocked, 16 of them the automatic-ban set; the 27 Round 20 hits stay in the fixture.

| # | What changed |
|---|---|
| 2 | `lead` lost `treasury.approve`; new `withdrawals.second_approve` (Lead, admin). Finance always gives the first approval (`finance_first` otherwise); the Lead only adds the second signature above the four-eyes thresholds ($500 / $1,000 user day); treasury withdrawals and crypto-refund sends stay `treasury.approve` (Finance/admin). Lead sees Ops → Payouts. |
| 3 | `NowPaymentsProvider.platformBalance` throws on a failed read or an unvaluable coin; reconciliation records `psp_balance_unreadable` → run is not ok and alerts admins + finance. `null` now only means "nothing held in that currency". |
| 4 | `withdrawals.external_id` (= our id = `unique_external_id`) stored before the call; batch ids stored before the 2FA verify; a failed verify → `unknown` + `verify_pending`, never reversed, the job retries the verify. IPNs match by payout id, batch id or `unique_external_id` and are applied while `unknown`. Hourly job also polls `processing` payouts (lost IPNs) and sends approved ones never handed over. "Not found" reverses only after two answers ≥ 30 min apart **and** `PAYOUT_UNKNOWN_REVERSE_HOURS`; Ops recheck refuses during the first 10 min (`too_early`). |
| 5 | Withdrawals kill switch also blocks staff approvals, `sendPayout` and treasury withdrawals (request + approve). Rejecting still works. |
| 6 | Refund after release / warranty refunds on NOWPayments orders (and any order while `CARD_REFUNDS_ENABLED=false`) go to the buyer's balance; the crypto-refund queueing and the card refund call are gone from `clawback.ts`. |
| 7 | `applyCryptoPayment` runs in one transaction holding the order row(s) then the payment row (same order as the reaper's `cancelOrder` → `creditPartialPayments`); capture happens inside it (`handlePaymentCapturedIn`, `handleCheckoutCapturedIn`). |
| 8 | `crypto_payments.applied_cents` records what each deposit funded; a later, larger IPN for the same address credits the difference to the buyer's balance (memo `crypto_extra_deposit`), once. |
| 9 | Cancelled-then-captured books the provider fee (`psp_fee`) and any overpayment. |
| 10 | Withdrawals to a non-USDT payout address → 400 `unsupported_coin`; migration 069 clears non-USDT payout addresses (seller re-adds a USDT TRC-20/BEP-20 one). |
| 11 | Platform daily payout cap read under an advisory lock; the per-user daily cap is re-checked at approval (`withdrawal_limit`). |
| 12 | `withdrawal.approve` is audited even when the payout call fails (`details.payout = payout_failed / payout_unknown`). |
| 13 | Creator codes: no earning when creator and buyer share a device, card, IP subnet or wallet. |
| 14 | Warranty refunds on orders above $200 need `orders.lead`. |
| 18/19 | No em dash in the dispute message (API + ar/fr/pt/de). After the account window the chat note says the buyer can still confirm or contact support; disputes are closed (matches `openDispute`). |
| 21 | The inline ID deadline uses `rules_settings.id_due_days`. |
| 22 | `material` is required on `PUT /admin/legal/:doc`; a draft announced as material can't be re-published as non-material (`material_draft`); the audit entry records `material`, `previousMaterial`, the hash. |
| 23 | Ops Business money row: per currency (`byCurrency`; top level = USD), `unknown` withdrawals counted as pending, promo cost net of promo money returned by refunds/splits/refunds after release (`promoGrossCents` kept). |
| 24 | Web: if GET /categories fails, no category is shown and "Try again" appears (Home, Games). Demo: `localStorage['bz.demo.fail']='categories'`. |
| 25 | Referral "active" = the friend had a completed order in the 30 days before **this order was placed**. |
| 15–17 | `money-invariants.test.ts` runs on a fake NOWPayments (exact/over/under/late payments, IPN replays, IPN vs reaper, second transfer, confirm vs dispute, staff release, refunds, splits, refunds after release, invite + creator codes, payouts ok/timeout/down/reject/verify-fail) and checks: one capture per order, every deposit counted once, nobody paid twice (a reversed withdrawal never has a live provider payout), rewards ≤ half the commission and booked as recorded, and the provider wallet equals the ledger (reconciliation clean). The late-deposit property calls the real IPN code. Breaking the payout lookup or the late-deposit `credited_cents` check makes it fail (checked). |

**NOWPayments sandbox checks still needed** (we could not reach the sandbox; everything above runs against the provider
interface with a fake). The CEO/Back-End must run these with the sandbox keys and note the answers here:
1. `POST /v1/payout` twice with the same `unique_external_id`: is the second refused (which HTTP status / message) or does it
   return the first withdrawal? Either is safe for us only if it never creates a second payout. Same check after a verify failure.
2. `GET /v1/payout?limit=100&page=0&date_from=YYYY-MM-DD&order_by=created_at&order=desc`: the exact parameter names, whether the
   rows carry `unique_external_id`, `id`, `batch_withdrawal_id`, `status`, `hash`, `fee`, `currency`, `amount`, and whether the
   list is `{ data: [...] }` or a bare array (`findPayoutByExternalId` accepts both).
3. `GET /v1/payout/:id`: does it take the withdrawal id (what we store as `payout_id`) or the batch id?
4. A batch whose `/verify` failed: its status (CREATING or WAITING?), whether `/verify` can be retried with a new TOTP, how long
   it stays verifiable, and whether it can be cancelled.
5. The payout IPN body: does it include `unique_external_id`, `fee`, `conversion_fee`?
6. `GET /v1/balance` shape (`{ coin: { amount, pendingAmount } }`) and its error responses.
Then run `apps/api/scripts/money-paths.ts` against staging (docs/HOSTING.md).

## Round 22b (Oct 25, 2026) — follow-ups to Round 22

Migration **070** (`070_round22b.sql`, idempotent; re-run `node dist/migrate.js` on staging). New test file `round22b.test.ts`
(one case per item, with a three-way concurrent job run); `chat-filter.test.ts` + the fixture gained the new phrases (and
`ACCOUNT_R22B`); `fakeNowPayments.ts` records every payout POST/GET (`payoutPosts`, `payoutGets`). Demo mock follows items 2, 3, 5, 6.

| # | What changed |
|---|---|
| 1 | `sendPayout` claims the row in one conditional `UPDATE … RETURNING` (status `processing`, no `provider_attempted_at`, no `payout_id`, no `provider_ref`); otherwise it refuses (`payout_already_sent`) and nothing is sent. Migration 070 backfills `provider_attempted_at` where provider ids exist. The hourly job claims its rows with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` (lease: `updated_at` for `unknown`, `last_polled_at` for `processing`), so two worker processes never check, poll or send the same withdrawal. |
| 2 | Wallet addresses (`safety.ts` `classify`, `walletOffered`): automatic ban only when the sender offers their OWN receiving address ("send to my wallet …", "pay me at …", "send me … to …", "ابعتلي على محفظتي …"). A question or an order to pay some address ("Should I send USDT to …?", "send to 0x…", "pay to T… in usdt" — the last two banned in Round 22) and past tense ("I sent USDT to …") are blocked and queued, no strike. A NOWPayments deposit address of any order in the room or of the user (`ownAddresses`, from `crypto_payments.pay_address`) is removed before the checks (`detectOffPlatform` option), so a message about the buyer's payment is **delivered**; anything else in it (phone, handle…) is checked as usual. |
| 3 | Account rooms (account order or inquiry on an account listing) strip labelled IDs like top-up rooms (`uid`, `id`, `player id`, `الـ UID`, `الايدي`). "linked/connected to facebook/google …", "مربوط بالفيسبوك" (how the account signs in) is dropped before the checks in every room, so it is never a contact offer. |
| 4 | Phone numbers with every digit spaced out ("0 1 0 1 2 3 4 5 6 7 8") are caught: blocked and queued; a ban only with a messenger/payment name, as before. |
| 5 | `chat_flags.auto_ban` + `prior_status` are stored when the filter bans. Dismissing that flag restores the prior status (only if the user is still under `off_platform_ban` and no other confirmed flag or other open automatic-ban flag remains); audited as `user.auto_ban_lifted`. Migration 070 marks the open Round 22 filter bans. |
| 6 | `decideWithdrawal` rejects an approval whose `destination_currency` is not in `PAYOUT_COINS` (status `rejected`, note `unsupported_coin`, `refused: 'unsupported_coin'`, money back through the normal reject path). `sendPayout` reverses an approved one (`failed`, `unsupported_coin`). Migration 070 resets `users.payout_currency` EUR/EGP → USD. |
| USD | (Third pass, migration **071**.) Every withdrawal path (`/seller/withdrawals`, `/me/withdrawals`, `/me/credit/withdraw`, the card-rail `requestWithdrawal`) is USD only: any other `currency` → 400 `unsupported_currency`; `/seller/withdrawals` defaults to USD. Balances left in another currency are never converted automatically: Ops alert `non_usd_balances` (and a NOTICE from migration 071) lists them for Finance to convert by a manual ledger adjustment. `seller-currency.test.ts` now checks the EUR withdrawal is refused. |
| USD-2 | `PUT /seller/payout-currency` accepts USD only (400 `unsupported_currency`, whatever `PAYOUT_CURRENCIES` says); the payout-currency picker is gone from Sell → Money. Tests that need a legacy EUR seller set `users.payout_currency` directly. |
| 5b | (Third pass.) The filter ban also stores `prior_suspended_until` / `prior_suspension_reason`; dismissing restores a prior suspension with its original end, or `active` when no end (still ahead) was stored. |
| 7 | A FINISHED payout IPN/poll for a withdrawal already `failed` (reversed) sets `paid_after_reversal_at` / `paid_after_reversal_hash`, logs an error, emails admins + finance (`ops_alert`) once, and Ops alerts repeat it for 7 days (`payout_after_reversal`). Nothing is booked automatically: Finance recovers or writes it off. Four-eyes: the first approval stores `four_eyes_required`, so a withdrawal that needed two signatures still does after the user's 24h total drops. Treasury withdrawals lock `727281`; `727276` stays the platform payout cap. |

## Round 23a (Oct 25, 2026) — domain, email, Cloudflare (`claude/round-23a-domain-code.md`)

Migration **072** (`072_round23a.sql`, idempotent; runs in Render's pre-deploy step). New test files: `round23a.test.ts`
(one block per item, 23 cases), browser `e2e/round23a.spec.ts` (newsletter, Turnstile, video size). Whole API suite: 80 files, 682 tests; browser suite: 127 passed (5 skipped as before). New checks:
`apps/api/scripts/check-runtime-imports.mjs`, `apps/web/scripts/verify-static-files.mjs` (part of `npm run build -w apps/web`),
CI job **`api-image`** (builds `apps/api/Dockerfile`, checks the image's imports, migrates, starts `node dist/index.js`, waits for
`/readyz` and `/healthz`).

| # | What changed |
|---|---|
| 9 | Crash on start: npm keeps `@sentry/node` and `undici` under `apps/api/node_modules` (versions differing from the hoisted ones) and the Dockerfile copied only the root `node_modules`. It now copies both. `@sentry/node` was already a production dependency. Every runtime import of `dist/` resolves in the image (24 package specifiers); `dist/index.js` and `dist/worker.js` start in it. |
| 7 | `APP_ENV=development|test|staging|production` (default = NODE_ENV). Staging = `NODE_ENV=production` + `APP_ENV=staging`: every production check, plus `MALWARE_SCANNER=dev` allowed (no ClamAV, no `CLAMD_HOST`). `NODE_ENV=staging` now fails with that instruction instead of a ZodError (docs/HOSTING.md had suggested it). Logs and Sentry report APP_ENV. Blank values of `sync: false` keys count as unset. |
| 8 | `render.yaml`: `region: frankfurt` on the API and the Key Value store (Render env groups have no region field), ClamAV service removed, `APP_ENV=staging`, `MALWARE_SCANNER=dev`, Resend email, NOWPayments sandbox URL; secrets `sync: false` (list below). `render.production.yaml` switched to Resend and gained the Turnstile / origin / Brevo keys. |
| 10 | `createPool` rewrites `sslmode=require|prefer|verify-ca` to `verify-full` (what pg 8 already does, without the pg 9 warning); docs say to use `?sslmode=verify-full`. |
| 1 | `EMAIL_PROVIDER=resend` (`ResendMessenger`, HTTP API, `Idempotency-Key` = `notification-<id>` from the outbox, so a retry is one message; status emails `status-email-<id>`; others a fresh UUID), `reply_to` = `EMAIL_REPLY_TO` (support@bullizard.com). We add no tracking: keep open/click tracking **off** on the Resend domain. Production/staging refuse `console`; console and postmark stay for development. Team mailboxes go through the same outbox (`notifications.to_email`): ops alerts → `ALERTS_EMAIL`, reconciliation and payout-after-reversal → `ALERTS_EMAIL` + `FINANCE_EMAIL`. |
| 2 | `ORIGIN_SHARED_SECRET` set → every request needs `X-Origin-Auth` = the secret (SHA-256 digests compared in constant time), else 403 `origin_forbidden`; `/readyz` and `/healthz` are exempt. With the header, `req.ip` becomes `CF-Connecting-IP` (first hook, before rate limits), so rate limits, fraud signals, referral `ip_subnet`, audit log, `buyer_ip`, sessions and the captcha check all see the client. Unset: unchanged (TRUST_PROXY). |
| 3 | WebSocket ping frame every `WS_PING_SECONDS` (30; Cloudflare idles out at 100 s); sockets missing two pongs are dropped. Request bodies stay ≤ 12 MB except proof videos, now ≤ 95 MB (413 `file_too_large`, `details.maxMb`; the web app shows `upload.videoTooLarge` in 6 languages before uploading). With S3/R2 storage, larger videos (≤ 500 MB) go straight to the bucket: `POST /v1/chat/rooms/:id/attachments/direct` → signed PUT URL (15 min, exact type and size) → `POST /v1/chat/attachments/:id/complete` (read back, sniffed, scanned, posted). Abandoned reservations are removed by the daily retention job. The bucket needs CORS for PUT from the web origin, and the web build `VITE_UPLOAD_ORIGIN`. |
| 4 | `apps/web/public/.well-known/security.txt` (exact text from the spec). Both `vercel.json` files: the SPA rewrite skips `/.well-known/`, and the file is served `text/plain; charset=utf-8`. |
| 5 | Newsletter consent, unticked: sign-up checkbox and Account → "News and offers" (`PUT /v1/me/newsletter`); `users.news_opt_in`, `news_opt_in_at` (time of the current choice), `news_synced_at`. With `BREVO_API_KEY` + `BREVO_LIST_ID_EN/AR` the worker (`newsletter_sync`, every 15 min) adds the contact to the list for their language (Arabic → Newsletter AR, others → EN) or unlinks both; failures retry. Account deletion deletes the Brevo contact. Without Brevo: Ops → Business → "Download subscribers (CSV)" (`GET /v1/admin/newsletter.csv`, `analytics.view`, audited). Campaign sender `news@news.bullizard.com` is set in Brevo (`NEWSLETTER_SENDER` documents it). |
| 6 | Turnstile: `TURNSTILE_SECRET` (+ `TURNSTILE_SITE_KEY`) on the API, `VITE_TURNSTILE_SITE_KEY` on the web; required in production and staging. Sign-up, every sign-in and the password-reset request need a token. The widget script is injected only by those forms (never in `index.html`); leaving the auth pages after it loaded reloads the next page, so checkout pages never carry it and `payment-scripts.json` stays first-party. CSP adds `https://challenges.cloudflare.com` to `script-src` and `frame-src` only when the site key is set (checked at build). Tests use Cloudflare's test keys (`1x…AA` pass, `2x…AA` fail, token `XXXX.DUMMY.TOKEN.XXXX`); the demo turns it on with `localStorage['bz.demo.turnstile']`. |

`docker compose` (the image runs NODE_ENV=production) now needs `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` in `.env`, and uses
Cloudflare's always-pass Turnstile test secret unless `.env` sets one.

### What the Domain helper needs back

**Render, staging API (`bullizard-api-staging`, Frankfurt).** Set by the blueprint (not secret): `NODE_ENV=production`,
`APP_ENV=staging`, `SANDBOX_MODE=true`, `PAYMENT_PROVIDER=mock`, `KYC_PROVIDER=mock`, `EMAIL_PROVIDER=resend`,
`EMAIL_FROM="Bullizard <no-reply@mail.bullizard.com>"`, `EMAIL_REPLY_TO=support@bullizard.com`, `ALERTS_EMAIL=alerts@bullizard.com`,
`FINANCE_EMAIL=finance@bullizard.com`, `SMS_PROVIDER=console`, `MALWARE_SCANNER=dev`, `PLATFORM_ACCOUNTS=mock`, `TRUST_PROXY=1`,
`NOWPAYMENTS_API_URL=https://api-sandbox.nowpayments.io`, `MERCHANT_API_ENABLED=true`, `AUTO_REFUND_LATE_ORDERS=false`,
`CARD_REFUNDS_ENABLED=false`, `CARD_PAYMENTS_ENABLED=false`, `PAYOUT_CURRENCIES=USD`, `FX_SPREAD_BPS=0`, `PAYOUT_HOLD_DAYS_NEW=1`,
`PAYOUT_HOLD_DAYS_ESTABLISHED=0`, `RECON_TOLERANCE_CENTS=100`, `PAYOUT_UNKNOWN_REVERSE_HOURS=6`, `RUN_WORKER_IN_PROCESS=true`,
`STORAGE_DIR=/data/uploads`, `REDIS_URL` (from the Key Value store). Generated by Render (secret): `JWT_SECRET`, `FINGERPRINT_KEY`,
`CRYPTO_INDEXER_SECRET`. Asked for on creation (`sync: false`):

| Name | Value / example | Secret |
|---|---|---|
| `DATA_ENCRYPTION_KEYS` | `v1:` + `openssl rand -base64 32` (keep a copy) | yes |
| `PUBLIC_WEB_URL` | `https://staging.bullizard.com` (exact web origin; CORS allows only it) | no |
| `PUBLIC_API_URL` | `https://api-staging.bullizard.com` | no |
| `DATABASE_URL` | Neon pooled URL of the `staging` branch, `…neon.tech/neondb?sslmode=verify-full` | yes |
| `RESEND_API_KEY` | `re_…` (sending access, domain mail.bullizard.com) | yes |
| `TURNSTILE_SECRET` | the staging widget's secret, `0x4AAAA…` | yes |
| `ORIGIN_SHARED_SECRET` | `openssl rand -hex 32`, same value as Cloudflare's `X-Origin-Auth` | yes |
| `BREVO_API_KEY` | `xkeysib-…`, optional (blank = CSV export) | yes |
| `BREVO_LIST_ID_EN` / `BREVO_LIST_ID_AR` | list ids of "Newsletter EN" / "Newsletter AR", e.g. `3` / `4`; optional | no |
| `NOWPAYMENTS_API_KEY` / `NOWPAYMENTS_IPN_SECRET` | sandbox keys; blank while `PAYMENT_PROVIDER=mock` | yes |

Optional, not in the blueprint: `TURNSTILE_SITE_KEY` (not secret; only echoed by `/v1/auth/config`), `GEO_COUNTRY_HEADER=cf-ipcountry`
(safe once `ORIGIN_SHARED_SECRET` is set), `SENTRY_DSN` (secret). To test NOWPayments on staging later: `PAYMENT_PROVIDER=nowpayments`,
`SANDBOX_MODE=false`, `PLATFORM_ACCOUNTS=live`, plus the two keys.

**NOWPayments IPN (payments and payouts, one path):** `POST https://api-staging.bullizard.com/v1/payments/webhook/nowpayments`
(production: `https://api.bullizard.com/v1/payments/webhook/nowpayments`). Server-to-server, signed (`x-nowpayments-sig`): skip
Cloudflare bot/challenge rules for this path; it still needs the `X-Origin-Auth` Transform Rule like every other request.

**Auth paths for the Cloudflare rate-limit rule (all `POST`):** sign-in `/v1/auth/login` (+ 2FA step `/v1/auth/mfa`); sign-up
`/v1/auth/register`; code verify `/v1/verify/email/confirm`, `/v1/verify/sms/confirm` (sending: `/v1/verify/email/send`,
`/v1/verify/sms/send`), payout address `/v1/seller/payout-address/confirm`; password reset `/v1/auth/password/forgot`,
`/v1/auth/password/reset`; withdrawal request `/v1/seller/withdrawals`, `/v1/me/withdrawals`, `/v1/me/credit/withdraw`.

**Health:** `GET /readyz` (Render health check) and `GET /healthz` answer without `X-Origin-Auth` (query strings too); every other
path without the header gets 403 `origin_forbidden`. WebSocket: `/v1/ws` (enable WebSockets on the zone; we ping every 30 s).
Uploads through Cloudflare stay under 100 MB (videos ≤ 95 MB).

**Vercel, staging environment:** `VITE_DEMO=false`, `VITE_API_URL=https://api-staging.bullizard.com`,
`VITE_TURNSTILE_SITE_KEY=<staging site key>` (public), `VITE_SITE_URL=https://staging.bullizard.com`; only with S3/R2 uploads:
`VITE_UPLOAD_ORIGIN=<bucket endpoint>`. All are build-time: redeploy after a change. `/.well-known/security.txt` is served as
`text/plain`.

## Round 23b (Oct 25, 2026) — review fixes to Round 23a

Migration **073** (`073_round23b.sql`, idempotent): `users.news_synced_email` / `news_synced_list`, table `newsletter_state`,
staff role `marketing` (and the staff_roles check now also allows `lead`, which it never did). New test file `round23b.test.ts`
(18 cases); `round23a.test.ts` updated (production env now has the origin secret and Twilio; CSV export as marketing; Turnstile
test tokens carry their action). New ClamAV image `services/clamav/` (CI builds it and checks the limits with `clamconf`).

| # | What changed |
|---|---|
| 1 | `APP_ENV=production` refuses to start without `ORIGIN_SHARED_SECRET`. Staging may leave it blank; `index.ts` then logs a warning at start (`originWarning`). `/metrics` stays behind the origin guard (not exempt) and `METRICS_TOKEN`: scrape it through Cloudflare with both headers (`X-Origin-Auth` from the Transform Rule, `Authorization: Bearer <METRICS_TOKEN>`); without the token it is 404 in production. |
| 2 | Videos are never buffered. The `video/*` body parser hands the route the request stream; `uploadVideoStream` spools it to a private temp file in chunks (SHA-256 and size counted on the way, refused with 413 as soon as it passes 95 MB or when Content-Length says so), streams the file to the scanner (`scanStream`) and to storage (`putFile`; local storage encrypts as a stream in the same AES-GCM format, S3 uploads the file stream). `completeDirectVideoUpload` reads the object with `getStream` into the same spool. Videos are served as a stream, hashed on the way out (a mismatch ends the response with an error). Direct uploads are capped at **100 MB** (`MAX_DIRECT_VIDEO_BYTES`), the API path stays 95 MB. Images (≤ 8 MB) are unchanged. Tests check that a 90 MB upload and a 99 MB direct upload never allocate a buffer of 8 MB or more (the old parser allocated 94 MB at once). |
| 3 | `services/clamav/Dockerfile` = `clamav/clamav:stable` + `clamd-limits.conf`: `StreamMaxLength`, `MaxScanSize`, `MaxFileSize` 120M, `ReadTimeout`/`CommandReadTimeout` 180. `render.production.yaml` (`bullizard-clamav`, `runtime: docker`) and `docker-compose.yml` build it. The clamd scan timeout is 15 s + 1 s per 5 MB, capped at 120 s (`clamdTimeoutMs`; 95 MB → 34 s). Still fail closed: a timeout, a dropped socket or any reply other than OK/FOUND (e.g. "INSTREAM size limit exceeded") → 503 `scanner_unavailable`, nothing stored. |
| 4a | Turnstile siteverify must return the endpoint's `action` (`signup` register, `signin` login, `reset` password forgot; the widget already sends them) and `hostname` = `TURNSTILE_HOSTNAME` or PUBLIC_WEB_URL's host (case-insensitive). |
| 4b | Brevo sync keeps Brevo equal to what each user should be: in the list for their language only while opted in, active (not banned/suspended) and not deleted, under their current address. A ban/suspension unlinks the contact; reactivation re-adds it; an address change unlinks the old contact and adds the new one; a language change moves the list. What Brevo holds is stored (`news_synced_email`, `news_synced_list`); deletion clears both. |
| 4c | `pullBrevoUnsubscribes` (runs at the start of each `newsletter_sync`, every 15 min): contacts of our lists changed since the last pull (1 h overlap) that are blacklisted or unsubscribed from the list → `news_opt_in = false`, so neither the sync nor the CSV re-subscribes them. |
| 4d | New permission `newsletter.export` (admin and the new `marketing` role only; compliance, finance and support get 403) for `GET /v1/admin/newsletter.csv` (still audited) and `/v1/admin/newsletter/status`. Ops → **Newsletter** tab (moved out of Business). The CSV and the count include active accounts only. |
| 4e | `SMS_PROVIDER=console` is refused when `APP_ENV=production` (staging may keep it). |

Render production now needs `ORIGIN_SHARED_SECRET` set (already `sync: false` in `render.production.yaml`) and the ClamAV service
rebuilt from `services/clamav` (a blueprint sync recreates it as a Docker service).

## Round 23c (Oct 26, 2026) — follow-ups 11–13, no seller API, staging test workflows

Migration **074** (`074_round23c.sql`): drops `api_keys`, `webhook_endpoints`, `webhook_deliveries`. New test file
`round23c.test.ts` (11 cases); shared template fixture `test/fixtures/template-data.ts`.

| # | What changed |
|---|---|
| 11 | `loadConfig` treats a blank (or whitespace) value of any optional key as unset, numbers and defaults included (Render sends `""` for an empty `sync: false` key; `BREVO_LIST_ID_EN=""` used to become 0 and stop the start). Tested by booting staging and production with every optional `sync: false` key of both blueprints set to `""`. |
| 12 | One HTML layout for every customer email (`emailHtml` in `notifications.ts`): a full document with `lang`/`dir` (`dir="rtl" lang="ar"` for Arabic), always next to the plain-text part. The verification-code email now has it too (it had text only). Tested for every template × all 6 locales. |
| 13 | `vite.config.ts`: `VITE_API_URL` / `VITE_UPLOAD_ORIGIN` that are not https URLs (http only for localhost) stop the build with `VITE_API_URL must be an https URL, got 'false'` (`originOf`). |
| CEO | **No seller API.** Removed: `routes/merchant.ts`, `domain/apikeys.ts`, `domain/webhooks.ts` (outbox, dispatcher, worker job `webhooks`, every `enqueueWebhook` call, the `webhook_deliveries` metric/alert/recon warning/retention purge, key-rotation target), `openapi.ts`, `api-schemas.ts` (`ExportQuery` moved into `routes/seller.ts`), `/v1/docs`, `/v1/openapi.json`, `@fastify/swagger(-ui)`, `/v1/sandbox/webhooks/flush`, API-key auth on the sandbox (session only now), `MERCHANT_API_ENABLED` (config, Render, `/features.merchantApi`), `RETENTION_WEBHOOK_DELIVERIES_DAYS`, `bulkUpdatePrices`, the status component "Seller API and webhooks", `sdks/` and the `sdk-python` CI job, `sdk.test.ts`, `merchant-api*.test.ts`; web: `Developers.tsx`, the `/developers` route and sitemap entry, the demo mock routes and seed keys (storage keys bumped to `bz.demo.v27` / `bz.demo.launch.v3`). Kept: the NOWPayments IPN `/v1/payments/webhook/nowpayments` and the other provider callbacks, `/v1/sandbox/*`, `offers.low_stock_threshold` (an offer field the API still accepts; nothing reads it now). Tests that went through API keys now use the session routes (`/v1/seller/exports/*`, `/v1/seller/invoices`). |
| Staging | `STAGING_TEST_TOKEN` (staging only: `loadConfig` refuses it unless `APP_ENV=staging`, ≥ 32 chars; the route checks `APP_ENV` again): a sign-in, sign-up or reset request carrying `X-Staging-Test-Token` with that value (SHA-256 digests compared in constant time) skips Turnstile. Workflows `staging-money-paths.yml`, `staging-zap.yml`, `staging-load.yml`, `staging-kill-switch.yml` (manual, schedule commented out, one concurrency group). Scripts: `scripts/staging-client.ts` (shared client, TOTP for the staff 2FA, delivery proof upload), `money-paths.ts` (signs in with the test accounts; registers throwaway ones only without them), `kill-switch.ts` (pause → check the four 503s → always resume; `--resume-only`), `loadtest-staging.ts` (≤ 4.5 req/s, fails on any 429/Cloudflare block/5xx). ZAP plan: no OpenAPI import (a `requestor` job seeds the API), a `replacer` job adds the test-token header, email-sending and sandbox paths excluded; passes on Medium-only (exit 2), fails on High. |

**What the CEO sets for the staging workflows** (details: `docs/STAGING.md` §5):
- Render, staging env group `bullizard-staging`: `STAGING_TEST_TOKEN` = `openssl rand -hex 32` (new `sync: false` key). Keep
  `SANDBOX_MODE=true`, `RATE_LIMIT_PER_MINUTE=300`. Nothing on production.
- GitHub → Settings → Secrets and variables → Actions: `STAGING_TEST_TOKEN` (same value), `STAGING_STAFF_EMAIL`,
  `STAGING_STAFF_PASSWORD`, `STAGING_STAFF_TOTP_SECRET` (base32 key of the staff account's 2FA), `STAGING_BUYER_EMAIL`,
  `STAGING_BUYER_PASSWORD`, `STAGING_SELLER_EMAIL`, `STAGING_SELLER_PASSWORD`.
- Accounts on staging: buyer, seller, and a staff account with role `admin` and 2FA on (older than the new-account window).
- Run: GitHub → Actions → "staging money paths" / "staging ZAP scan" / "staging load test" / "staging kill switches" → Run workflow.

## Round 23d (Oct 26, 2026) — fixes from the independent reviews (`claude/round-23d-fixes.md`)

Migration **075** (`075_round23d.sql`): legal-document immutability trigger, `kyc_deletion_requests`, `upload_slots`,
newsletter backfill + `news_sync_attempts` / `news_sync_next_at` / `news_opt_out_at` + `newsletter_forget_queue`,
`terms_acceptances` (backfilled from `users.tos_version`), `mfa_challenges`. New test file `round23d.test.ts` — one
test per item, each written to fail on d24a0a0 and pass now. The API image now installs **ffmpeg** (item 7); the
CI `image.env` origin secret was lengthened to pass the new 32-character rule (item 12). Items that mentioned
`routes/merchant.ts` are void: Round 23c removed the seller API.

| # | What changed |
|---|---|
| 1 | A `preSerialization` hook in `server.ts` strips staff-only columns (`buyer_ip`, `buyer_ip_country`, `buyer_device`, `risk_score`) from every response to a non-staff caller, however deep the row sits; `payment_ref` / `idempotency_key` only reach the order's own buyer; `seller_rate_bps` only the listing's seller (item 13). Covers every `SELECT *` at once. |
| 2 | Direct video upload: on complete the scanned bytes are written under `<key>/v` (a key the signed PUT cannot reach) and the upload key is deleted, so a replayed PUT after complete changes nothing. Video downloads are spooled and hashed first; only a file matching its SHA-256 and size is streamed (from the verified temp copy) — a tampered object is a clean 500 `integrity_error`, never a 200 with bytes. |
| 3 | `requirePermission` refuses any non-active account (`account_restricted`); banned accounts cannot sign in, refresh or use an existing token; suspended accounts with staff roles cannot sign in or refresh until the suspension ends. Suspend/ban check rank (`outranks` in `permissions.ts`: admin 100 > finance/compliance 80 > lead 60 > support/arbiter/marketing 40): a lead cannot touch an admin or finance, nobody can act on themselves (`rank`). |
| 4 | New permission `legal.publish` (admin, compliance) for `PUT /admin/legal/:doc`; `effectiveAt` cannot be in the past (`backdated`); adding a language to a version already in force is refused (`version_in_force`: publish a new version); a DB trigger blocks UPDATE/DELETE of any in-force row, whoever asks. |
| 5 | Account deletion also refuses while store credit > 0 (`credit_remaining`) and now clears payout address + currency, `payout_address_changes`, linked accounts (external id, name, URL), push subscriptions, saved searches, watches, support ticket subjects and the user's messages, and the raw KYC payload (`result = {}`; provider, applicant id, level, status and dates stay for AML retention). The provider-side applicant deletion is queued in `kyc_deletion_requests` — Ops → `GET /admin/privacy/kyc-deletions`, `POST …/:id/done` (permission `retention.manage`), since that call is irreversible. Chat erasure (`erase-chat` and the retention shred) now also deletes the user's `chat_attachments` rows, names and stored objects (`eraseUserAttachments`). |
| 6 | Every staff read of a chat they are not part of is audited (`chat.viewed`, with `afterSeq` and `via: rest|ws`): REST at any offset, WebSocket `subscribe` and `sync` (`auditAs` in `audit.ts`). |
| 7 | Proof videos are re-muxed with ffmpeg (`-map_metadata -1 -map_chapters -1 -c copy`) before scanning results are stored: GPS, device and title atoms are gone; the stored hash is the clean file's. Fail closed: an unreadable video is 422 `video_not_processable`. `VIDEO_METADATA_STRIP=off` exists for tests only and is refused in production. |
| 8 | Upload slots (`upload_slots`) are reserved under a per-user advisory lock *before* a byte is spooled: 20 per hour counting in-flight ones (parallel requests cannot slip past), at most 2 spools at once (`upload_in_progress`); a spool with no bytes for 30 s or longer than 10 min is dropped with a 408 and its temp dir removed; all spools together may claim 2 GB of temp space (`uploads_busy`); `LocalEncryptedStorage.putFile` removes its `.part` on failure. |
| 9 | Migration 075 marks every row with `news_synced_at` (opted-out too) so the sync pushes pending opt-outs. |
| 10 | Newsletter sync: a failing row retries once at once, then backs off 2^n minutes (≤ 6 h) and is parked after 10 attempts with an error log — the queue never blocks. Brevo unsubscribes set `news_opt_out_at` and leave the consent time alone. A failed Brevo deletion at account deletion is queued (`newsletter_forget_queue`) with the address Brevo had (`news_synced_email`) and retried by every sync. |
| 11 | `terms_acceptances` keeps every acceptance (sign-up, settings, each order). `createOrder` (and the cart) refuse with 409 `terms_reacceptance_required` while a material change awaits acceptance; the client sends `tosVersion` (the web does, from `/legal/terms`) and a stale one is 409 `terms_stale`. |
| 12 | MFA challenge tokens carry a `jti` stored in `mfa_challenges`: exchanged once, and all open ones die on password reset. Wrong codes on `/me/2fa/disable` and wrong passwords on `/me/delete` count towards the sign-in lockout. `ORIGIN_SHARED_SECRET` must be ≥ 32 characters; `STAFF_MFA_REQUIRED=false` is refused in production. `createOrder` checks the seller's 30-day ID deadline live (`seller_id_overdue`). |
| 13 | **Web:** the access token lives in memory only (`api.ts`); what persists is the httpOnly refresh cookie plus a `mkt.signed-in` flag so a reload exchanges the cookie first. The demo build keeps the token in localStorage (no cookie there). The device id (`mkt.device`, localStorage) stays — see "For Legal" below. Public offers no longer carry `seller_rate_bps`; seller-profile reviews show the buyer as an initial ("J.") with a "Verified buyer" label. |
| 14 | Logs: `redactUrl` blanks the query string of OAuth callbacks and any URL carrying `code`/`state`/`token`; `deepRedact` (pino `formatters.log`) censors secret keys at any depth; the `req` serializer logs only id, method, redacted url and address. |
| 15 | The tax CSV goes through `toCsv`/`csvCell` (quoting, formula neutralising). |

Suites on this commit: API 79 files / 708 tests green (2 skipped), typecheck clean; web typecheck + demo build green,
browser 127 passed / 5 skipped; `npm audit` 0 in root, api, web; image start check (build, runtime imports, migrate
through 075, `/readyz` + `/healthz`) passed locally. Adjusted existing tests: `cart.test.ts` (checkout view now carries
`buyer_id` so the buyer keeps `payment_ref`), `risk-and-chargebacks.test.ts` (risk score read from the row, not the
API), `round19.test.ts` (trigger disabled for the scratch move), `tax.test.ts` (CRLF rows), `round23a/b/c` (32-char
origin secret), `mfa.test.ts` unchanged (a wrong code no longer spends the challenge).

**For Legal — Privacy Policy wording (item 13).** The policy's "one essential cookie for sign-in" line now matches the
code: the sign-in session is an httpOnly cookie and the short-lived access token is held in memory only. Two things the
policy must still state: (1) the site stores a random **device identifier** in the browser's local storage
(`mkt.device`, not a cookie, not shared with advertisers) and sends it with requests as a fraud and account-abuse
signal; (2) on account deletion the identity-check **result** is kept for the AML retention period (provider,
applicant id, level, status, dates — no document data), and the deletion of the applicant at the KYC provider is
carried out by compliance within [N] days of the request.

## Round 23e (Oct 26, 2026) — review fixes (`claude/round-23e-fixes.md`)

Migration **076** (`076_round23e.sql`): `storage_deletions` (retry queue for stored objects), the two foreign keys to
`chat_attachments` (`order_progress.attachment_id`, `orders.delivery_proof_id`) become `ON DELETE SET NULL`,
`chat_attachments.chunk_bytes` / `chunk_sha256`. New test file `round23e.test.ts` — one test per item, each written to
fail on 0123a8c and pass now. Still no seller API, API keys, SDKs or Developers page (permanent CEO decision).

| # | What changed |
|---|---|
| 1 | Chat erasure (`eraseUserChat` in `privacy.ts`, used by `erase-chat` and the retention job): key shred, references let go (progress screenshot, delivery proof), attachment rows deleted and their keys queued — one transaction; objects are deleted after commit (`drainStorageDeletions`), a failure backs off 2^n min (≤ 1 day) and every retention run drains the queue. Retention picks up any deleted user who still has a key **or** files (resumable), and one user's failure no longer stops the run (`chatErasureErrors`). Room purges use the same order. |
| 2 | Account deletion checks seller balance and store credit in **every** currency, again inside the deletion transaction with the user row locked (`assertNoMoneyLeft`). |
| 3 | `assertMayChangeStatus` (`users.ts`) — the rank rule — on suspend, ban, reinstate, confirming a risk flag (which now also signs the account out) and deciding a chat flag (penalty ladder / lifting an auto-ban). A suspension (admin or ladder) revokes every session at once. |
| 4 | `crypto_refund` on an order reaches only its buyer and staff. On order rows `released_by`, `release_note`, `tax_country` are staff-only (`ORDER_STAFF_FIELDS` in `server.ts`). |
| 5 | Video re-mux keeps only `0:v` and `0:a?` (`-sn -dn`): subtitle/data tracks (DJI/GoPro GPS) are dropped. ffmpeg runs single-threaded under `sh -c 'ulimit -t/-v/-f'` (60 s CPU, 1 GB memory, 400 MB output) and is SIGKILLed after 2 min (`ffmpegLimits`). |
| 6 | Uploads store per-chunk SHA-256 (1 MiB). A video view streams from storage through `verifyingStream`: each chunk is passed on only after it matched; the response starts once the first chunk checked out (a bad file is a clean 500), a bad later chunk ends the stream without its bytes. No spool per view; files stored before 076 are spooled against a separate 512 MB download budget. At most 3 streams per user (`downloads_busy`). Upload budget untouched by views. |
| 7 | `seller_price_cents`, `seller_price_tiers` only for the listing's seller (and staff); on orders `commission_bps`, `commission_cents`, `commission_tax_cents`, `seller_net_cents`, `seller_received_cents` only for the seller and staff. |
| 8 | Opting out in the app keeps `news_opt_in_at`; `news_opt_out_at` records the opt-out (also returned as `newsOptOutAt`). |
| 9 | `POST /orders` and `/orders/cart` refuse a missing `tosVersion` (400 `tos_version_required`); stale stays 409 `terms_stale`. The web sends the version loaded with the page (`useTermsVersion`, `lib/terms.ts`). The demo mock enforces the same. Test harness: `client()` adds the version in force unless a test sets `tosVersion` itself. |
| 10 | Wrong password / 2FA code on `/me/delete` and `/me/2fa/disable` is **403 `invalid_credentials`** (still counted towards the lockout once); the web client only refreshes on 401. |
| 11 | **Web:** a legacy `mkt.token` is removed on load and that browser is treated as signed in (cookie exchanged); each browser also tries the exchange once without the flag (`mkt.session-probed`). Refresh is single-flight per tab and, with Web Locks, across tabs (`bz-auth-refresh`); a 409 race is retried with backoff (300/600/1200 ms) and never signs the tab out. |
| 12 | Staff REST chat reads: a full read (offset 0) is always audited; polling (`afterSeq > 0`) once per staff, room and session every 15 min (`auditOncePerSession`). WebSocket subscribe/sync unchanged. |
| 13 | Logs: `code` is redacted only inside request `body` / `query` / `params` (OTP, OAuth code) and under explicit names (`otpCode`, `mfaCode`, …); `err.code` and other error codes stay. |

Suites on this commit: API 81 files / 724 tests green, typecheck clean; web typecheck + demo build green, browser
126 passed / 5 skipped (one `round23a.spec.ts` Arabic-label run was flaky once and passed on rerun); `npm audit` 0 in
root, api, web; image start check (build, runtime imports, migrate through 076, `/readyz` + `/healthz`, ffmpeg re-mux
under the ulimits as user `node`) passed locally. Adjusted existing tests: `launch-basics`, `mfa`, `round23d` (wrong
password/code is 403; a suspension signs out at once), `round20` (signs in again after the suspension), `bulk-listings`,
`promos-fx`, `requests`, `escrow-flow`, `payout-holds`, `warranty` (seller-only prices and order money read from the
seller's view); `helpers.ts` (`client()` sends the Terms version in force with orders).

## Round 23f part A (Oct 27, 2026) — review fixes (`claude/round-23f-fixes.md`)

Migration **077** (`077_round23f.sql`): `download_slots`. New test file `round23f.test.ts` (part A: one test per item,
each failing on 0f824b2).

| # | What changed |
|---|---|
| 1 | `deepRedact` copies plain objects only; a FastifyRequest/Reply or raw IncomingMessage is left to its serializer, so request logs have `method`, the redacted `url`, `remoteAddress` and `res.statusCode` again (lost since 23d). `createLogger(cfg, destination?)` takes a stream for tests. |
| 2 | Verified downloads use `pipeline(source, verifier)`: a client that aborts destroys the storage read. |
| 3 | `GET /legal/:doc` is `Cache-Control: no-store` plus `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control: no-store`, read from the primary. On 409 `terms_stale` the offer page and cart fetch the version in force and show `TermsChanged` (read the new Terms → "Accept and continue", which re-sends the order with it). Keys `legal.changedNotice`, `legal.readNew`, `legal.acceptAndContinue` in all six locales. **Cloudflare:** no cache rule may override origin headers for `/v1/*` (the API sends `no-store` where it matters). |
| 4 | A storage read gets 15 s to first byte and 30 s idle (504 `storage_timeout`, slot freed), 15 min at most. The 3-streams-per-user limit is counted in Postgres (`download_slots`, per-user advisory lock), so it holds across nodes; an unreleased slot (node died) stops counting after 15 min; retention deletes rows older than a day. |
| 5 | `drainStorageDeletions` never deletes a key a `chat_attachments` or `shop_banners` row still references (the queue entry is dropped with a warning). |
| 6 | Custom not-found handler: logs `{ method, path }` without the query and answers 404 `not_found` (Fastify's default logged the full URL). |

Suites: API 82 files / 730 tests green, typecheck clean; web typecheck + demo build green, affected browser specs
(cart, buyer, launch-decisions, crypto, games) 21 passed / 2 skipped; `npm audit` 0 in root, api, web; image start
check (build, runtime imports, migrate through 077, `/readyz` + `/healthz`, 404 log line without the query) passed.

## Round 23f part B (Oct 27, 2026) — copy deck §9 (`claude/bullizard-copy-deck.md`, "9. Round 22 to 23c strings")

Migration **078** (`078_round23f_copy.sql`): payout addresses in a coin other than USDT are removed and
`users.payout_address_cleared_at` is set (the wallet shows `money.payoutAddress.cleared`). Tests: `round23f-copy.test.ts`
(API, plus the web's `errorMessage`, chat-line mapping and keys) and `e2e/round23f.spec.ts`.

| § | What changed |
|---|---|
| 9.1–9.6 web | Every key in en/ar **and** es/fr/de/pt (seller keys in `<loc>.seller.ts`). Placed: sign-up hint under the newsletter box, `account.newsletter.toggle` in Account, `auth.botCheckExpired` (Turnstile re-runs itself when a token expires), `auth.resetSent`, `account.data.before`, `upload.uploading` / `upload.scanning` on the deliver button (uploads report progress through XHR), `money.payoutAddress.coinHint`, `money.payoutAddress.cleared`. `upload.videoTooLarge` takes `{maxMb}` from `details.maxMb`. |
| 9.2 / 9.8 API codes | `invalid_credentials` (sign-in, one message for unknown accounts too), `session_expired` (bad/expired token, refresh without or with a dead token), `reauth_required` (expired 2FA challenge), `wrong_current_password` (**403**, so the client does not refresh-and-retry). `balance_owed` no longer mentions chargebacks. |
| 9.2 web | `errorMessage` checks `err.<code>` before the 429 and 5xx fallbacks (`account_locked`, `scanner_unavailable`). `ApiError` carries `details`. |
| 9.5 chat | The WebSocket error frame now carries `details`; `lib/chatBlocked.ts` picks the line: `queue` → `chat.blocked.queue`, `ban` → `chat.blocked.ban`, stopped in the browser → `chat.notSent` + `chat.bannable`. The demo mock sends `details.action` too. |
| 9.6 email | `withdrawal_failed` gets a reason **code** (`unsupported_coin`, `not_approved`, `provider_failed`; anything else reads as `provider_failed`), worded per language (`withdrawalReasons` in each pack); the provider's text goes to the log. |
| 9.7 email | One layout (`emailLayoutHtml` in `notifications.ts`): greeting (`Hey {name},` — display name from the user row), body, one rune-green button (`#4bae24`, text `#0d131c`, radius 8, no shadow) made from the body's last "Label: URL" line, plain sign-off, rule, footer (why / safety / Email settings — not on security emails / legal). Plain text keeps "Label: URL". Variables are isolated in the HTML part (`<bdi>`, `<span dir="ltr">` for amounts and IDs) by rendering the body a second time with private-use markers. `arCount` / `arDuration` (`locales/types.ts`); every pack has `layout`, `duration`, `verifySubject`. Missing `quantity` / `tos_version` drop their piece. Verification-code email: subject with the code, code in a large LTR block (`renderCodeEmail`). |

Suites: API 83 files / 739 tests green, typecheck clean; web typecheck + demo build green; browser suite 126 passed / 5
skipped / 1 failure (the Turnstile spec, whose expected text changed with §9.2 — updated), then the affected specs
(round23f, round23a, moderation, launch, messages, buyer, seller, wallet) 27 passed; `npm audit` 0 in root, api, web;
image start check (build, runtime imports, migrate through 078, `/readyz` + `/healthz`) passed. Adjusted tests:
`locale.test.ts` (plain sign-off, code email subject), `sessions-and-email.test.ts` (403 `wrong_current_password`),
`e2e/round23a.spec.ts` (new newsletter label and captcha text). §9.8 item 7 (looking at one email per template in a
browser) is for the copy owner: `render(ctx, name, TEMPLATE_DATA, 'ar').html` gives the page.

## Round 24 (Oct 27, 2026) — API side of the Round 24 front end, and no phone anywhere (`claude/round-24-backend-brief.md`)

Migration **079** (`079_round24.sql`). New test files `test/round24.test.ts` (API, one test per item, each failing on
b5d47b0) and `e2e/round24.spec.ts` (sign-up to level 1 with no phone). Still no seller API, API keys, SDKs or Developers page.

| § | What changed |
|---|---|
| 1 Listing fields | `GET /offers`, `GET /offers/:id` (every `OFFER_LIST_SQL` reader) return `seller_level` = 1 + ⌊2·√completed orders⌋, `seller_positive_pct` (4–5 star share of visible reviews, one decimal, null without reviews; `users.positive_review_count`, kept by `seller_rating_refresh`), `sold_count` (completed orders on the listing; `offers.sold_count`, kept by trigger `orders_sold_count`), `public_id` (`BZO` + 12 characters, stored, unique, backfilled, never the DB id) and `delivery_methods`. `repairCounters` also repairs the two new counters. Badges stay in the API for the profile. |
| 2 Delivery methods | One table: `apps/api/src/domain/delivery.ts` (import-free; the web's `lib/delivery.ts` and the demo mock import it and add icons/labels). Albion `f2f` + `market` (character + city from the 7 cities), PoE 1/2 `f2f`, Aion/Aion 2 `f2f` + `mail`, any other game with a handover field `f2f` (character) or `uid`. A listing has methods only when its game/category has a handover field. `POST /offers` and `PATCH /offers/:id` take `deliveryMethods` (non-empty subset; 400 `invalid_delivery_method`; PATCH `null` = all). The sell form shows the boxes from `methodsForListing(game, category)`. |
| 3 Orders and cart | `POST /orders` and each `/orders/cart` item take `deliveryMethod`, `deliveryInfo { character?, city?, uid? }`, `saveInfo`. Method must be one the listing offers (default: its first), every field of it is required, city from the list (400 `invalid_delivery_method` / `delivery_info_required` / `delivery_info_invalid`, `details.field`). Stored on `orders.delivery_method` / `delivery_info`; `character_name` keeps the character or UID. `characterName` alone still works; nothing at all is still `character_name_required`. The name is remembered only with `saveInfo: true`. `delivery_method`, `delivery_info`, `character_name` on order rows reach only the buyer, the seller and staff (`ORDER_PARTY_FIELDS` in `server.ts`). |
| 4 Disputes from support | `POST /admin/support/tickets/:id/dispute` (`disputes.manage`; body `category`, optional `orderId` when the ticket names none, optional `reason`): the order must belong to the ticket's user, be paid/delivered, not disputed (and the usual crypto-escrow / protection-window rules). The customer is the opener, the ticket subject the reason, its first message their statement; `disputes.ticket_id` / `opened_by_staff` and `support_tickets.dispute_id` link both ways; ticket set to high priority with an internal note; audited `dispute.open_from_ticket`; same freeze, emails and $200 Lead rule. Tickets show `dispute`; the dispute list and case file carry `ticket_id`; `opened_by_staff` is hidden from the parties. The thread comes back only for staff with `support.manage`. Web: Operations → Support → ticket → "Open dispute from this ticket". The buyer endpoint `POST /orders/:id/dispute` still works (not called by the web). Chat "Stay safe" text: "If something is wrong, contact support." / «في مشكلة؟ تواصل مع الدعم.» (migration, only that sentence replaced). `GET /seller/withdrawals/quote` with an empty, zero or malformed amount: 400 `amount_required`. |
| 6 No phone | Level 1 = verified email (`confirmVerificationCode`); migration 079 sets `kyc_tier = 1` for every user with a verified email. All tier-1 errors read "Verify your email first." `SMS_PROVIDER` is `none` \| `console` \| `twilio`; unset = `none` in production (SMS off: `DisabledSms` sends and logs nothing) and `console` in development; the "production needs twilio" guard is gone, `console` stays refused in production. `render.production.yaml` / `render.yaml`: `SMS_PROVIDER=none`, no Twilio keys. `/verify/sms/*` stays dormant (400 `sms_unavailable` with SMS off). Payout-address codes always go by email (never SMS). Web: the Account page has no phone step; strings `err.kyc_required`, new `err.tier1_required`, `offer.verifyFirst`, `sell.tier1.lede`, `sell.tier1.verify`, `account.lede`, `account.level1`, help article `verify-identity` (EN + AR; ES/FR/DE/PT fall back to EN for `sell.tier1.verify`). The new-account cap already exists and is staff-editable (Ops → Controls: `new_account_days`, `new_account_max_order_cents`, `new_account_max_open_orders`). |
| 5 Browser specs | `disputes.spec` (arbiter flow), `crypto.spec` (refund to balance) and `launch-decisions.spec` (dispute notices) run again through the support ticket (`disputeViaSupport` in `e2e/helpers.ts`). `bulk`, `linked-accounts`, `trust` stay skipped (features removed). Demo storage keys bumped (`bz.demo.v28`, `bz.demo.launch.v4`). |

Suites: API 84 files / 750 tests green, typecheck clean; web `tsc -b` + demo build green; full browser suite 126 passed /
8 skipped / 0 failed, **a11y 13/13 green** (the contrast failures on the CEO colours were fixed by b5d47b0); `npm audit
--omit=dev` 0 in root, api, web; image start check (build, runtime imports, migrate through 079, `/readyz` + `/healthz`
as staging, and `/readyz` as `APP_ENV=production` with no SMS settings at all) passed. Adjusted existing tests:
`games.test.ts` (remembered name needs `saveInfo: true`), `crypto-payments.test.ts` (payout code by email even with a
verified phone). Docker Hub was reachable; the build here needed the agent proxy CA in a scratch copy of the Dockerfile
(the repo Dockerfile is unchanged).

## Round 25 (Oct 28, 2026) — back end B1–B8: currency unit prices, market search, crypto in EUR, review fixes

Migration **080** (`080_round25.sql`). New shared, import-free module `apps/api/src/domain/unitPrice.ts` (the web may
import it like `delivery.ts`): `parseUnitPrice`, `formatUnitPrice`, `totalCentsFor`, `unitMicrosFor`, `grossMicros`,
`checkVolumeDiscounts`, `DELIVERY_TIMES`, `MIN_CURRENCY_ORDER_USD_CENTS`. New tests `test/round25.test.ts` and
`test/round25-crypto.test.ts`. The demo mock (`apps/web/src/demo/mock.ts`) was not touched: the web team adds the routes
below to it.

### API contract for the front end (Round 25)

All money is USD unless a field says otherwise. **Micro-units**: integer, 6 decimals (`123` = 0.000123). Buyer-facing
prices are grossed up by the seller's commission, as before.

**B1 `GET /v1/games/:slug/servers?category=currency`** (slug = the web's `slugify(game)`; category default `currency`;
404 `not_found` for an unknown game). Every server of the game's first listing field (server, region or league; a
select field lists all its options, a free-text field the values sellers used), active, in-stock, visible listings
only, no paging:
```json
[{ "name": "Europe", "offers": 5, "sellers": [{ "id": "uuid", "name": "Silver seller 0", "avatar": null }],
   "sellers_count": 5, "sold": 12, "from_unit_price": "0.002106", "from_unit_price_micros": 2106 },
 { "name": "Americas", "offers": 0, "sellers": [], "sellers_count": 0, "sold": 0, "from_unit_price": null, "from_unit_price_micros": null }]
```
`sellers`: at most 4 (most sales first). `avatar` is always `null` (users have no avatar yet). `sold` = completed orders
of those listings. `from_unit_price` = lowest buyer unit price.

**B2/B3 currency listings.** `POST /v1/offers` (currency category):
```json
{ "categorySlug": "currency", "game": "Albion Online", "title": "Silver", "deliveryMode": "manual",
  "attributes": { "server": "Europe" }, "stock": 50000000, "unitPrice": "0.000123",
  "deliveryMethods": ["f2f", "market"], "deliveryTime": "1h",
  "volumeDiscounts": [{ "minQty": 2000000, "percentOff": 5 }] }
```
- `unitPrice` (string, ≤ 6 dp) or `unitPriceMicros` (integer); both may be sent if equal (400 `invalid_unit_price`).
- With a unit price the body must also give: the game's server/region field (400 `server_required` with
  `details.field`, or `invalid_attributes` for a required select), `stock` ≥ 1 for manual (400 `stock_required`),
  `deliveryMethods` from the game's list in `domain/delivery.ts` (400 `invalid_delivery_method`), `deliveryTime` one of
  `15m 1h 3h 6h 12h 24h` (400 `delivery_time_required` / `validation_error`).
- `volumeDiscounts`: 0–4 tiers, `minQty` rising and above `minQty` of the listing, `percentOff` 1–50 and rising
  (400 `invalid_volume_discounts`; shape errors `validation_error`). `[]` removes them. `priceTiers` are refused on
  this form (400 `invalid_tiers`).
- An older body (`priceCents`, no unit price) still works: unit price = that many cents, 24 h, all methods.
- `minBuyerReputation` / `establishedBuyersOnly` are ignored if sent; nothing gates on them (080 cleared the column).
- `PATCH /v1/offers/:id` takes the same fields (`unitPrice`/`unitPriceMicros`, `volumeDiscounts`, `deliveryTime`;
  `deliveryHours` on a currency listing must be 1, 3, 6, 12 or 24). A 409 `version_conflict` changes nothing.
- Listing reads (`/offers`, `/offers/:id`) add: `unit_price_micros` (buyer, null on non-currency), `volume_discounts`,
  `delivery_minutes`, `delivery_time` (null = instant or over 24 h), `price_settlement_micros`, and on `/offers` lists
  `display_unit_price_micros` (in `currency=`). Owner/staff only: `seller_unit_price_micros`, `featured_until`.
  `min_buyer_reputation` and `featured` are gone from every read except as below.
- Orders: total = quantity × unit price (after the volume discount, rounded up to the micro-unit), **rounded up to the
  cent**, then the commission is grossed up on that as before. Minimum $1.00 buyer total (400 `below_minimum_order`,
  `details: { minCents: 100, currency: "USD" }`). `POST /v1/orders/quote` returns, in addition: `listingUnitPriceMicros`,
  `volumePercentOff`, `unitPriceMicros` (buyer per unit, rounded). Show the quote's `amountCents` as the total; the
  per-unit numbers are for display. Order rows add `unit_price_micros`, `listing_unit_price_micros`, `amount_usd_cents`.
  `quantity` may now be up to 2,000,000,000 (stock and `minQty` too).

**B4 market.** `GET /v1/offers` new query parameters: `server` (needs `game`; the game's first field),
`minUnitPrice` / `maxUnitPrice` (decimal strings, display currency), `deliveryMethod` (`f2f|mail|market|uid`),
`maxDeliveryTime` (`15m…24h`; instant counts as 0), `online=true`, `minLevel` (seller level), plus the existing ones.
New sorts: `most_sold`, `fastest_delivery` (`recommended`, `price_asc`, `price_desc`, `newest` as before; `price_*`
now sort by unit price). `pageSize` is still at most 60.
`GET /v1/offers/facets` (same parameters):
```json
{ "games": [{ "game": "Albion Online", "count": 12 }],
  "servers": { "key": "server", "label": "Server", "values": [{ "name": "Americas", "count": 1 }, { "name": "Europe", "count": 0 }] },
  "delivery_methods": [{ "method": "f2f", "count": 9 }] }
```
Each facet ignores its own filter. `servers` is `null` without `game`.

**Featured (CEO):** only `GET /v1/offers?seller=<id>` (the seller's shop page) returns `featured: true|false` and pins
featured listings first. No other read has `featured`, and nothing else boosts them.

**B5 `GET /v1/payment-methods?currency=EGP`** → `[{ "id": "crypto", "currencies": ["USD", "EUR"], "enabled": true,
"pay_currency": "USD" }]` (`pay_currency`: what this viewer is charged in; EUR viewers get `EUR`). Config
`PAYMENT_METHODS_JSON` (array of `{ id, currencies, enabled, viewerCurrencies? }`) adds methods; only enabled ones are
listed. Unknown currency: 400 `unsupported_currency`.
`POST /v1/orders/:id/crypto/pay` and `/v1/checkouts/:id/crypto/pay`: `{ "coin": "usdttrc20", "priceCurrency": "USD" | "EUR" }`
(default USD; anything else 400). The payment view adds `price_currency`, `price_amount` (string, in that currency),
`fx_rate` (EUR per USD, string). Provider down, erroring or slow (10 s deadline): **503 `payment_provider_unavailable`**
on `/crypto/coins` and `/crypto/pay` (`details.retryable: true`).

**B6** `GET /v1/fx/rates` (no-store):
```json
{ "base": "USD", "settlement": "USD", "spreadBps": 0, "quote_ttl_seconds": 900, "as_of": "2026-10-28T00:00:00.000Z",
  "exact": { "EGP": "48.50000000", "EUR": "0.92000000" },
  "rates": [{ "currency": "EUR", "rate": "0.92000000", "fetched_at": "…", "as_of": "…", "source": "static" }] }
```
The order's quote (`presentment_currency`, `presentment_amount_cents`, `fx_rate`, `fx_locked_at`) holds 15 minutes.
`POST /v1/orders/:id/fx-quote` (and `/v1/checkouts/:id/fx-quote`) `{ "currency": "EUR" }` →
`{ currency, rate, amountCents, usdCents, lockedUntil, fresh }`. Paying in EUR after the hold (or in a currency the
order was not quoted in) answers **409 `fx_quote_expired`** with `details { currency, rate, amountCents, usdCents,
lockedUntil }`: show the new price, then send pay again. An EUR invoice is exactly `amountCents`; settlement, balances
and payouts stay USD.

**B7** `/v1/me/saved-searches*` are gone (404); no digest job or email. The table stays.

**Card path:** `GET|POST /v1/seller/payout-account` are gone (404). `POST /v1/seller/withdrawals` is always the USDT
request (6 %, min $1.50, CFO approval).

### What changed

| § | Change |
|---|---|
| B1 | `serverSummary` / `gameForSlug` (`domain/search.ts`), route in `routes/public.ts`. |
| B2 | `offers.unit_price_micros` (backfill `price_cents × 10,000` on currency listings), `price_settlement_micros` (trigger + FX refresh), `orders.unit_price_micros` / `listing_unit_price_micros` (backfill `× 10,000`). `priceOrder` prices micro listings with BigInt totals rounded up; seller code, FX, gross-up, promo, credit, cart, refunds, ranks (seller_net) and referral (commission) are unchanged downstream and covered end to end in `round25.test.ts`. Snapshot keeps `unit_price_micros`, `price_cents`, `volume_discounts`, `unit_label/size`, `delivery_minutes`; the price part keeps `listingUnitPriceMicros` and cents. |
| B3 | `offers.volume_discounts`, `offers.delivery_minutes` (delivery deadline uses it). `checkMinBuyerReputation` and the order gate removed. In-game listings now store their methods (backfilled; `null` on PATCH stores all). |
| B4 | `filterSql` + `searchFacets`; indexes `offers_market`, `offers_delivery_methods` (GIN), `offers_attributes_gin`, `offers_live_sold`, `users_completed_orders`. Featured weighting removed from every sort; `featured` only with `seller=`. |
| B5 | `domain/paymentMethods.ts`, config `PAYMENT_METHODS_JSON` (checked at start), `NOWPAYMENTS_TIMEOUT_MS` (10 s); every NOWPayments call has a deadline; `viaProvider` logs `{ provider, op, providerStatus, error }` only. EUR invoices: `crypto_payments.price_currency / price_amount / fx_rate`; a deposit is valued in USD in proportion to its invoice. |
| B6 | `currentRates` shape above; `FX_QUOTE_TTL_MINUTES` (15); `lockFxQuote` / `quoteFx`. `SETTLEMENT_CURRENCY` other than USD is refused at start. |
| B7 | `domain/savedSearches.ts`, routes, worker job and `saved_search_digest` (all languages) removed. |
| B8 M2 | `orders.amount_usd_cents` (stored at order time, backfilled); `isLeadOrder` and every `lead_review` / `orders.lead` check use it (`admin.ts`, `orders.ts`). |
| B8 L1 | 080 sets `kyc_tier = 0` for banned or deleted accounts at level 1 without a verified phone (079's promotions); `confirmVerificationCode` no longer lifts banned/deleted accounts. |
| B8 L3 | `updateOffer`: every check first, then one versioned UPDATE writes all columns (methods, units, linked account, unit price, tiers, delivery time). |
| B8 staging | `render.yaml`: `SANDBOX_MODE "false"`, `PAYMENT_PROVIDER nowpayments`, `PLATFORM_ACCOUNTS live`, sandbox `NOWPAYMENTS_API_URL` kept; header rewritten; optional payout login and Steam/Riot keys listed. |
| B8 card | `requestWithdrawal` (users.ts), `domain/payouts.ts`, `/seller/payout-account`, the mock onboarding page, `payout_account.updated`, and `payout` / `createPayoutAccount` / `payoutOnboardingLink` / `payoutAccountStatus` on every payment provider removed. A USDT withdrawal request no longer needs NOWPayments configured (sending it does). |

Adjusted existing tests: `helpers.ts` (`makeOffer` gives manual currency listings `deliveryTime: '24h'`),
`buyer-reputation` (the gate is gone), `launch-phase` (featured only on the shop), `round24` (null methods store all),
`round22b`, `risk-and-chargebacks`, `notification-centre`, `onboarding` and the withdrawal setups in `aml`, `clawback`,
`debts`, `exports`, `payout-holds`, `round20`, `seller-currency` (a USDT payout address instead of a Connect account);
`saved-searches.test.ts` deleted.

Suites on this commit: API 84 files / 769 tests green (multinode excluded as before), typecheck clean, `npm audit
--omit=dev` 0 (root, api); image start check: build, runtime imports, migrate through 080, `/readyz` + `/healthz` as
`APP_ENV=staging` with `PAYMENT_PROVIDER=nowpayments`, `SANDBOX_MODE=false`, `PLATFORM_ACCOUNTS=live` (the build needed
the agent proxy CA in a scratch copy of the Dockerfile; the repo Dockerfile is unchanged).

## Round 25b (Oct 28, 2026) — fixes from the independent review of cabbfe5

Migration **081** (`081_round25b.sql`). New test file `test/round25b.test.ts` (one block per finding).

| # | What changed |
|---|---|
| H1 | An order inside a cart can no longer be quoted or paid on its own: `POST /v1/orders/:id/fx-quote` and `/v1/orders/:id/crypto/pay` on a cart order answer **409 `use_checkout`** with `details.checkoutId` (use `/v1/checkouts/:id/…`). Before a cart is captured (card or crypto), `alignCartOrders` checks that every order has the checkout's presentment currency and that the amounts add up; if not (an order re-quoted alone before this fix), the orders are re-synced to the checkout (its currency, its total split by each order's USD charge), logged, and the capture goes through: the buyer's money is always applied. The review's repro (first order re-quoted in EUR, cart paid with a USD invoice) is a test. |
| M1 | EUR invoices: of the gap between the USD credited and the USDT that reached the wallet, only NOWPayments' expected fee is `psp_fee` (its IPN `fee` object, else `NOWPAYMENTS_FEE_BPS`, default 50); the rest is booked `crypto_fx` (gateway ↔ `fx_pnl`, either sign), so the gateway still ends at the wallet's amount. `crypto_payments.fx_gap_cents` / `fx_gap_bps`; Ops alert `crypto_fx_gap` above `FX_ALERT_BPS` (default 100). `FX_SPREAD_BPS` (default 0, CFO decision) applies to EUR quotes. `actually_paid_at_fiat` on an EUR invoice is assumed to be EUR and is cross-checked against the coins sent: a USD value is recognised and credited as USD; an unreadable value, or an IPN whose `price_currency` is not the invoice's, is **held**: nothing credited or captured, `crypto_payments.review_reason` set, Ops alert `crypto_review`. To check on the NOWPayments sandbox: `docs/STAGING-CHECKLIST.md` step 7b. |
| L1 | `offers.stock`, `offers.available`, `offers.min_qty` and `orders.quantity` are bigint; `offer_available` / `offer_available_of` return bigint. A cancel that restocks above 2^31 works. |
| L2 | The unused `offers_attributes_gin` is replaced by `offers_server` and `offers_league` (`lower(game), category_slug, lower(attributes->>'server'|'league')`, active only); the market writes game-field filters with the key as a checked literal so they use them. `gameForSlug` caches the slug → game map for a minute (a miss re-reads it). |
| L3 | `GET /v1/offers/facets` applies `q` like `/v1/offers`. |

Contract changes for the front end: only the new 409 `use_checkout` on the two order-level endpoints for cart orders.

Suites: API 85 files / 778 tests green (multinode excluded), typecheck clean, `npm audit --omit=dev` 0 (root, api);
image start check: build, runtime imports, migrate through 081, `/readyz` + `/healthz` as `APP_ENV=staging` with
`PAYMENT_PROVIDER=nowpayments` and `SANDBOX_MODE=false` (proxy CA in a scratch Dockerfile copy, repo Dockerfile unchanged).

## Suggested next round

1. Handover check for Riot/Steam games without a linked listing: let the buyer link any account of the game's
   platform and show "signed in" to staff in dispute case files.
2. Seller-side view of a buyer's reputation before accepting a buyer request proposal.
3. Retention digest: per-game breakdown and a link to the cohort that moved most.
