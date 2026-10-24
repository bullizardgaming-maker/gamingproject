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

## Suggested next round

1. Handover check for Riot/Steam games without a linked listing: let the buyer link any account of the game's
   platform and show "signed in" to staff in dispute case files.
2. Seller-side view of a buyer's reputation before accepting a buyer request proposal.
3. Retention digest: per-game breakdown and a link to the cohort that moved most.
