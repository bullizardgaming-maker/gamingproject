# Bullizard

A peer-to-peer marketplace for game accounts, keys, in-game currency, items and boosting, built around one idea: **the buyer's money waits in escrow until the goods are really theirs.**

| Protection | Applies to | Rule |
|---|---|---|
| Held until confirmed | currency, items, top-ups, keys, gift cards, boosting | The seller is paid when the buyer confirms. No deadline: if the buyer goes quiet, support releases it, never before 24 hours after delivery |
| 14-day asset insurance | game accounts | Funds auto-release 14 days after delivery; buyer completes a Security Changeover checklist; listings without Original Owner Proof are flagged *High risk · secondary market* |

## What's in the repo

| Path | What it is | Stack |
|---|---|---|
| `apps/api` | Marketplace backend: escrow, ledger, orders, auto-delivery, chat, merchant API, webhooks, fraud scoring, chargebacks, eKYC | Node 22, Fastify 5, PostgreSQL 16, Redis |
| `apps/web` | Buyer, seller and staff web app (market, checkout, order chat, seller hub, API console, operations console) | React 19, Vite |
| `contracts` | `MarketEscrow.sol`: stablecoin escrow with milestones and a bonded validator panel for disputes | Solidity 0.8.24, OpenZeppelin 5, Hardhat |
| `services/fraud-gnn` | Heterogeneous Graph Transformer (HGT) syndicate-risk model + scoring service | PyTorch, PyTorch Geometric, FastAPI |
| `docs/ARCHITECTURE.md` | How each requirement is implemented, security/compliance notes, known limitations | |

## Run it locally

Requirements: Node 22, PostgreSQL 16, Redis 7 (optional for a single node), Python 3.11 (only for the fraud model).

```bash
npm install
cp .env.example .env          # then set DATA_ENCRYPTION_KEYS (command is in the file)
createdb market               # or: docker compose up postgres redis
npm run migrate
npm run seed -w apps/api      # demo users + listings (password: demo-password-123)
npm run dev:api               # http://localhost:4000  (worker runs in-process)
npm run dev:web               # http://localhost:5173
```

Demo logins: `buyer@demo.test` (level 1), `seller@demo.test` (level 2 seller), `admin@demo.test` (admin/arbiter; the Operations console needs two-factor login when `STAFF_MFA_REQUIRED=true`, the production default).
With `PAYMENT_PROVIDER=mock`, checkout opens a mock hosted payment page that posts a signed webhook back. The launch provider is
`PAYMENT_PROVIDER=nowpayments` (crypto only): the buyer picks a coin on the order page, sends to the address shown, and the IPN funds the
order; underpayments get a top-up; refunds are sent by hand from the treasury queue; seller withdrawals go to a confirmed crypto address
after finance approval (6% fee, $1.50 minimum). The demo build simulates all of it.

Full stack in containers: `docker compose up --build` (web on :8080). Add `--profile gnn` for the fraud model service.

## Preview on Vercel

The repo is set up for Vercel (`vercel.json` at the root, and `apps/web/vercel.json` if the project's Root Directory is `apps/web`).
Every push builds the web app; with no backend attached, previews run in **demo mode**: an in-browser mock of the API with
sample listings, orders and chats, one-click demo accounts (buyer, seller, admin), a stand-in for the hosted card checkout,
and simulated seller replies. Verification codes in the demo are `123456`; "Reset demo" in the banner restores the sample data.

To point a deployment at a real API instead, set these Vercel environment variables:

| Variable | Value |
|---|---|
| `VITE_DEMO` | `false` |
| `VITE_API_URL` | the API origin, e.g. `https://api.yourdomain.com` (it's added to the page's CSP) |

…and set the API's `PUBLIC_WEB_URL` to the Vercel domain so CORS and the refresh cookie work. A ready-made staging
setup (Render blueprint in `render.yaml`, sandbox payments) is described in [docs/STAGING.md](docs/STAGING.md).

Site structure: home (search, categories, popular games, instant-delivery and owner-verified rails, A–Z index) →
`/games` (A–Z directory) → `/games/:game[/:category]` (category tabs and a seller/delivery/stock/price comparison table) →
`/offers/:id` → order page with escrow and chat. Sellers have public storefronts at `/sellers/:id` (listings by game, reviews).
Game cover art is generated from each game's name; no publisher artwork is used.
Also in the web app:
- A public status page at `/status`, with email subscriptions.
- Light and dark themes, following the system setting until the viewer picks one.
- Prices shown in USD, EUR or GBP; conversions are approximate and checkout shows the exact amount.
- Per-page titles, descriptions and canonical URLs.
- A `sitemap.xml` and `robots.txt` generated at build. Set `VITE_SITE_URL` to the production domain; private pages are excluded and marked noindex.

Staff screens under Operations:
- Status-page incidents and maintenance
- Seller debts
- Currency top-ups
- The fraud model report
- Chat erasure requests

UI components: the web app has Tailwind CSS v4 and a shadcn `components.json` (aliases `@/components`, `@/lib/utils`;
theme tokens mapped to the Bullizard palette in `src/tailwind.css`), so registry components drop in with
`npx shadcn add <component>` (e.g. `npx shadcn add @skiper-ui/skiper40`), run from `apps/web`.

## Tests

```bash
npm test -w apps/api          # 223 tests, needs Postgres (TEST_DATABASE_URL, default market_test) and Redis for the multi-node and view-count tests
npm test -w contracts         # 14 Hardhat tests
cd services/fraud-gnn && pip install -r requirements.txt && pytest -q   # 9 tests
npm run build -w apps/web     # includes the payment-page script inventory check
VITE_DEMO=true npm run build -w apps/web && npm run e2e -w apps/web   # 91 Playwright browser tests (desktop + phone) against the demo build, including axe accessibility scans
npm run loadtest -w apps/api && npm run loadtest:search -w apps/api   # load checks against a running API (CI runs both)
```

The browser tests cover browsing and filters, buying and chatting, price alerts, support requests, buyer requests, quantity prices, the cart, sales and shop codes, bundles, trust badges, saved searches, dispute case files, listing moderation, staff tools, accessibility (axe), keyboard use, price history, account warranty claims, languages (including Arabic right-to-left), the installable app and phone layouts. CI runs them on every push and uploads the report when one fails.

Highlights of what the tests prove: exactly one of 25 simultaneous buyers gets a single-stock item; chat sequence numbers stay gapless under 30 concurrent writers; a message sent to one API node reaches a socket on another node through Redis; webhook signatures verify with the merchant's secret and retries keep the same idempotency key; a buyer cluster sharing one device freezes a new seller's escrows and withdrawals; chargebacks produce reason-code-specific PDF packets and move money through the ledger correctly; the escrow contract rejects buyer-tampered terms and executes a commit-reveal validator verdict.

## Key API surfaces

- `POST /v1/orders` → checkout URL; with NOWPayments: `GET /v1/orders/:id/crypto/coins` (coins whose minimum fits what is owed), `POST /v1/orders/:id/crypto/pay` (`coin` → address and exact amount), `GET /v1/orders/:id/crypto/payments`, `POST /v1/orders/:id/crypto/payments/:pid/refresh`; the same under `/v1/checkouts/:id` for carts; `PUT /v1/orders/:id/refund-address` after a refund is decided
- Release: `POST /v1/orders/:id/confirm` (buyer, instant); staff `GET /v1/admin/orders/unconfirmed`, `POST /v1/admin/orders/:id/release` (24h+ after delivery, `orders.release`); seller `POST /v1/orders/:id/follow-up` opens a support ticket
- Seller payouts (crypto): `GET|POST|DELETE /v1/seller/payout-address`, `POST /v1/seller/payout-address/confirm` (email link + 2FA), `GET /v1/seller/withdrawals/quote?amountCents=`, `POST /v1/seller/withdrawals` (waits for finance); staff `GET /v1/admin/withdrawals`, `POST /v1/admin/withdrawals/:id/decide`; refunds `GET /v1/admin/crypto/refunds`, `POST /v1/admin/crypto/refunds/:id/sent`
- On-chain escrow (off unless `ONCHAIN_ESCROW_ENABLED=true`): EIP-712 escrow terms (`GET /v1/orders/:id/crypto-terms`, USDC/USDT)
- Catalogue: `GET /v1/catalog/games` (game directory with per-category counts), `GET /v1/offers?game=&category=&seller=&sort=&attr.<key>=`, `GET /v1/catalog/attributes` (game-specific fields), `GET /v1/sellers/:id`
- Watchlist and price alerts: `GET|POST /v1/me/watches`, `PATCH|DELETE /v1/me/watches/:id`
- Analytics: seller `GET /v1/seller/analytics?days=7|30|90|365`; staff `GET /v1/admin/analytics` (GMV, take rate, dispute and chargeback rates)
- Support: `GET|POST /v1/support/tickets`, `POST /v1/support/tickets/:id/{messages,resolve}`; staff `GET /v1/admin/support/tickets`, `POST /v1/admin/support/tickets/:id/messages`, `PATCH /v1/admin/support/tickets/:id`
- `POST /v1/orders/quote` (currency, promo code, store credit and quantity-price breakdown)
- Buyer requests: `GET /v1/requests` (public board), `POST /v1/requests`, `GET /v1/requests/:id`, `POST /v1/requests/:id/close`, `POST /v1/requests/:id/proposals`, `DELETE /v1/requests/:id/proposals/mine`, `POST /v1/requests/:id/proposals/:pid/accept` (returns the reserved listing to check out)
- Quantity prices: `priceTiers` on `POST /v1/offers` and `PATCH /v1/offers/:id`
- Cart: `POST /v1/orders/cart` (several listings, one payment, one order per line), `GET /v1/checkouts/:id`
- Seller sales and codes: `PUT|DELETE /v1/offers/:id/sale`, `GET|POST /v1/seller/codes`, `PATCH /v1/seller/codes/:id`; `sellerCode` on `POST /v1/orders` and `/v1/orders/quote`
- Bundles: `bundle: [{ offerId, quantity }]` on `POST /v1/offers`; `bundle` on the listing
- Trust levels: `seller_trust_level` on listings, `sort=trust`; `GET /v1/seller/trust` (progress to the next level)
- Disputes: `POST /v1/orders/:id/dispute/statements`; staff `GET /v1/admin/disputes/:id/case`
- Saved searches: `GET|POST /v1/me/saved-searches`, `PATCH|DELETE /v1/me/saved-searches/:id`
- Price history: `GET /v1/offers/:id/price-history?days=`, `GET /v1/catalog/price-history?game=&category=&days=`; recommendations: `GET /v1/offers/:id/also-bought`
- Storefront: `GET|PUT /v1/seller/storefront`, `POST|DELETE /v1/seller/storefront/banner` (raw image body), `GET /v1/sellers/:id/banner`; staff `POST /v1/admin/sellers/:id/storefront/clear`
- Bulk listings: `GET /v1/seller/listings/export.csv`, `POST /v1/seller/listings/import` (`dryRun` preview first)
- Linked game accounts: `GET /v1/seller/linked-accounts`, `POST /v1/seller/linked-accounts/{steam,riot}/start` (returns the sign-in URL), `DELETE /v1/seller/linked-accounts/:id`; `linkedAccountId` on account listings; listings carry `linked_platform` and `linked_account_created_at`
- Boosting progress: `POST /v1/orders/:id/progress` (`percent`, `note`, optional `attachmentId` from the order chat); `progress` on the order
- Buyer reputation: `POST /v1/orders/:id/buyer-rating` (seller, after completion), `GET /v1/me/buyer-reputation`; `buyer_reputation` on orders for the seller; `minBuyerReputation: "good"` on listings of 100.00 or more sells only to established buyers (`buyer_reputation_required` on `POST /v1/orders`)
- Handover check (account listings with a linked Steam/Riot account): `POST /v1/orders/:id/handover/start` returns the sign-in URL; signing in with the delivered account ticks the `account_linked` checklist step and sets `checklist.handover_at`; `POST /v1/orders/:id/confirm` with `{ "handoverConsent": true }` releases escrow early while the rest of the checklist is open
- Retention (staff, `analytics.view`): `GET /v1/admin/analytics/retention?months=6|12|24`; a weekly digest email goes to the same staff every Monday, flagged "Alert:" when seller churn or the 90-day repeat rate crosses `COHORT_ALERT_*` lines
- Account warranty: `warrantyDays` on account listings; `POST /v1/orders/:id/warranty-claims`, `POST /v1/warranty-claims/:id/{seller,buyer}`; staff `GET /v1/admin/warranty-claims`, `POST /v1/admin/warranty-claims/:id/decide`
- Moderation (staff, `moderation.manage`): `GET /v1/admin/moderation/{summary,listings,chats,terms}`, `POST /v1/admin/moderation/listings/:id`, `POST /v1/admin/moderation/chats/:id`, `POST|DELETE /v1/admin/moderation/terms`
- Presence: `seller_online` / `seller_response_minutes` on listings, `online` / `response_minutes` on seller profiles; `PUT /v1/seller/presence`
- Language: `PUT /v1/me/locale` (emails and notifications follow it)
- `POST /v1/orders/:id/{deliver,confirm,dispute,cancel,cancel-late}`, `PATCH /v1/orders/:id/checklist`
- Chat erasure (per-user keys): staff `POST /v1/admin/users/:id/erase-chat`
- `POST /v1/chat/rooms/:id/attachments` (screenshot evidence, malware-scanned)
- Notifications: `GET /v1/me/notifications`, `GET /v1/push/config`, `POST /v1/me/push-subscriptions`, `PATCH /v1/me/push-preferences`
- Seller reports: `GET /v1/seller/exports/{sales,statement,payouts,invoices,credit_notes}` (CSV/JSON), `GET /v1/seller/credit-notes`
- FX top-ups: `GET /v1/admin/fx/topups`, `POST /v1/admin/fx/topups/plan`, `POST /v1/admin/fx/topups/:id/decide` (Wise or mock exchange)
- Status page: `GET /v1/status` (public), `POST /v1/status/subscribe`; staff `POST /v1/admin/incidents`, `POST /v1/admin/incidents/:id/updates`
- Fraud model evaluation: `GET /v1/admin/fraud/model-report` (heuristic vs graph model on labelled orders; `FRAUD_GNN_MODE=shadow|enforce`)
- Seller debts: `GET /v1/seller/debts`, `POST /v1/seller/debts/:id/pay` (card repayment); staff `GET /v1/admin/debts`
- Seller money: `GET /v1/seller/dashboard` (per-currency balances, payout hold), `PUT /v1/seller/payout-currency`, `PUT /v1/seller/tax-profile`, `GET /v1/seller/invoices[/:id/pdf]`
- `GET /v1/ws` WebSocket chat and notifications (protocol documented in `apps/api/src/ws/gateway.ts`)
- Merchant API (API-key auth): `GET /v1/merchant/orders`, `POST /v1/merchant/inventory`, `PATCH /v1/merchant/prices`, `POST /v1/merchant/orders/:id/deliver`, `GET /v1/merchant/webhooks/deliveries`, `POST /v1/merchant/webhooks/deliveries/:id/redeliver`
- Webhooks: `order.created` (funded), `order.delivered`, `order.completed`, `order.disputed`, `order.refunded`, `order.cancelled`, `offer.low_stock`, `chat.message`, `chargeback.created`, signed with `X-Hook-Signature` = hex HMAC-SHA256 of the raw body

Seller SDKs: `sdks/typescript` (`@bullizard/sdk`) and `sdks/python` (`bullizard`). Both cover orders (with a polling helper), inventory, prices, chat, invoices, reports and webhook deliveries, and both verify webhook signatures. The TypeScript SDK's tests run against the real API in the API suite, and a test checks every path either SDK calls is in the API reference.

Seller API reference: `/v1/docs` (OpenAPI JSON at `/v1/openapi.json`). Run a sandbox with `SANDBOX_MODE=true` (mock payments and KYC only) to get `/v1/sandbox/*` test helpers.

Monitoring: Prometheus metrics at `/metrics` (set `METRICS_TOKEN`), health at `/healthz` and `/readyz`, alert rules in `deploy/monitoring/alerts.yml`, errors to Sentry with `SENTRY_DSN`.

Backups: `deploy/backup/` (WAL-G archiving, daily base backups, `restore-drill.sh` + `npm run verify-restore -w apps/api`); read replica via `DATABASE_READ_URL`.

Failover drill and incident playbooks: `docs/RUNBOOK.md` (`npx tsx apps/api/scripts/failover-drill.ts`).

Load tests: `npm run loadtest -w apps/api` (flash sale) and `npm run loadtest:search -w apps/api` (market search); see the headers of the scripts in `apps/api/scripts/`. Run against a throwaway database with raised rate limits.

Staging (real API, sandbox payments): `render.yaml` and [docs/STAGING.md](docs/STAGING.md).

App-store versions (Android Trusted Web Activity, iOS Capacitor shell, app-link files, store payment rules): [docs/MOBILE.md](docs/MOBILE.md).

See `docs/ARCHITECTURE.md` for the rest.
