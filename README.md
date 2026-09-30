# Gaming Marketplace ("Vaultline")

A peer-to-peer marketplace for game accounts, keys, in-game currency, items and boosting, built around one idea: **the buyer's money waits in escrow until the goods are really theirs.**

| Protection | Applies to | Rule |
|---|---|---|
| 72-hour inspection window | keys, gift cards, currency, items, boosting | Funds auto-release 72h after delivery unless the buyer disputes |
| 14-day asset insurance | game accounts | Funds auto-release 14 days after delivery; buyer completes a Security Changeover checklist; listings without Original Owner Proof are flagged *High risk · secondary market* |

## What's in the repo

| Path | What it is | Stack |
|---|---|---|
| `apps/api` | Marketplace backend: escrow, ledger, orders, auto-delivery, chat, merchant API, webhooks, fraud scoring, chargebacks, eKYC | Node 22, Fastify 5, PostgreSQL 16, Redis |
| `apps/web` | Buyer / seller web app | React 19, Vite |
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

Demo logins: `buyer@demo.test` (level 1), `seller@demo.test` (level 2 seller), `admin@demo.test` (admin/arbiter).
With `PAYMENT_PROVIDER=mock`, checkout opens a mock hosted payment page that posts a signed webhook back, the same flow as Stripe.

Full stack in containers: `docker compose up --build` (web on :8080). Add `--profile gnn` for the fraud model service.

## Tests

```bash
npm test -w apps/api          # 44 tests, needs Postgres (TEST_DATABASE_URL, default market_test) and Redis for the multi-node test
npm test -w contracts         # 10 Hardhat tests
cd services/fraud-gnn && pip install -r requirements.txt && pytest -q   # 9 tests
npm run build -w apps/web     # includes the payment-page script inventory check
```

Highlights of what the tests prove: exactly one of 25 simultaneous buyers gets a single-stock item; chat sequence numbers stay gapless under 30 concurrent writers; a message sent to one API node reaches a socket on another node through Redis; webhook signatures verify with the merchant's secret and retries keep the same idempotency key; a buyer cluster sharing one device freezes a new seller's escrows and withdrawals; chargebacks produce reason-code-specific PDF packets and move money through the ledger correctly; the escrow contract rejects buyer-tampered terms and executes a commit-reveal validator verdict.

## Key API surfaces

- `POST /v1/orders` → hosted checkout URL (card) or EIP-712 escrow terms (`GET /v1/orders/:id/crypto-terms`, USDC/USDT)
- `POST /v1/orders/:id/{deliver,confirm,dispute,cancel}`, `PATCH /v1/orders/:id/checklist`
- `GET /v1/ws` WebSocket chat and notifications (protocol documented in `apps/api/src/ws/gateway.ts`)
- Merchant API (API-key auth): `GET /v1/merchant/orders`, `POST /v1/merchant/inventory`, `PATCH /v1/merchant/prices`, `POST /v1/merchant/orders/:id/deliver`
- Webhooks: `order.created` (funded), `order.delivered`, `order.completed`, `order.disputed`, `order.refunded`, `order.cancelled`, `offer.low_stock`, `chat.message`, `chargeback.created`, signed with `X-Hook-Signature` = hex HMAC-SHA256 of the raw body

See `docs/ARCHITECTURE.md` for the rest.
