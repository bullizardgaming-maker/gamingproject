# Architecture

This maps each requirement in the product spec to where and how it is implemented, and lists what is deliberately left for production hardening.

```
            ┌───────────── web (React) ─────────────┐
            │  REST /v1/*           WebSocket /v1/ws│
            └──────────────┬────────────────────────┘
                           │  (load balancer, any node)
        ┌──────────────────┼──────────────────┐
   ┌────▼────┐        ┌────▼────┐        ┌────▼────┐      ┌──────────────┐
   │ API #1  │◄──────►│  Redis  │◄──────►│ API #2  │─────►│ fraud-gnn    │ (HGT, optional)
   └────┬────┘ pub/sub└─────────┘        └────┬────┘      └──────────────┘
        │                                      │
   ┌────▼──────────────────────────────────────▼────┐     ┌──────────────┐
   │ PostgreSQL: orders, double-entry ledger,       │◄────│ worker(s):   │ auto-release, expiry,
   │ hash-chained chat, outbox, fraud graph         │     │ webhooks     │ webhook dispatch
   └────────────────────────────────────────────────┘     └──────────────┘
        ▲ PSP webhooks (Stripe)   ▲ KYC webhooks (Sumsub)   ▲ chain indexer (MarketEscrow events)
```

## 1. Escrow and payment orchestration

**Fiat (`apps/api/src/domain/orders.ts`, `ledger.ts`, `providers/payments/stripe.ts`)**
- Stripe Connect *separate charges and transfers*: the platform captures the payment through a Stripe-hosted Checkout Session; funds sit in the platform balance (escrow); on release a Transfer of the seller's net amount goes to their connected account. Commission never leaves the platform balance.
- Every money movement is a balanced posting in a **double-entry ledger** (`ledger_entries`, append-only via trigger). Accounts: `gateway_clearing`, `escrow`, `treasury`, `reserve`, `seller_available`, `payouts`. Balances are derived, never stored.
- State machine: `awaiting_payment → paid → delivered → completed`, with `disputed`, `refunded`, `cancelled`, `charged_back`. Every transition is guarded by the expected current status and recorded in `order_events` (append-only).
- Windows: `inspection_72h` for standard categories, `insurance_14d` for `risk_class = 'high'` (accounts). The worker releases escrow when the window lapses without a dispute and the order is not frozen.
- Split: commission is computed at order time from the seller's tier and locked on the order; 10% of each commission funds the chargeback reserve.
- Unpaid orders expire after `ORDER_PAYMENT_TTL_MINUTES` and return reserved stock. A payment that arrives after expiry is recorded and refunded.

**Web3 (`contracts/contracts/MarketEscrow.sol`, `apps/api/src/domain/web3.ts`, `indexer.ts`)**
- The API issues **EIP-712 terms signed by the platform** (seller, amount, fee, release schedule, deadlines). The contract only accepts deposits carrying that signature, so buyers cannot change the fee or recipient.
- Milestones: accounts release 30% on credential delivery and 70% after 14 days; boosting releases in four stages; everything else releases after 72h. Buyer can approve early; buyer can reclaim if nothing is delivered by the deadline.
- Disputes: either party freezes unreleased funds. A panel of 5 **bonded validators** is drawn from a future block hash, votes with **commit-reveal**, and the contract executes the majority (tie → 50/50 split). Majority voters share a 2% arbitration fee; validators who don't reveal lose 10% of their bond. Bonds are locked while assigned. No admin function can move escrowed funds.
- The indexer mirrors `EscrowCreated / DisputeOpened / EscrowSettled` into orders after 3 confirmations (auto-delivery runs off-chain on `EscrowCreated`).

## 2. Marketplace mechanics

- **Tiered commission** (`domain/commission.ts`): Normal 12.99/9.99% → Legendary 7.99/4.99% by trailing-30-day completed sales; gift cards, top-ups and video games are a flat 4.99%.
- **Auto-delivery** (`domain/inventory.ts`): bulk `.txt` / JSON upload (≤10,000 items per upload), each item AES-256-GCM encrypted with the offer id as AAD, de-duplicated by a keyed HMAC fingerprint. On payment capture items are delivered in the same transaction and both parties are notified over WebSocket.
- **Original Owner Proof + Security Changeover** (`domain/offers.ts`, `orders.ts`): sellers submit registration email/date/billing name; approval requires the billing name to match the eKYC legal name. Account deliveries create a six-step checklist that must be completed before the buyer can release early. Unverified account listings are shown as *High risk · secondary market* and lose Chargeback Shield coverage.

## 3. Chat and real-time

- `chat_messages` has a **server-assigned, gapless, monotonic `seq`** per room: the append runs `UPDATE chat_rooms SET last_seq = last_seq + 1 … RETURNING`, whose row lock serializes writers across all nodes.
- Each message stores `hash = sha256(prev_hash | seq | sender | kind | body | created_at)`. The table is append-only (trigger), and `GET /v1/chat/rooms/:id/verify` recomputes the chain, so even a DBA edit is detectable. This log is embedded in arbitration and in chargeback packets.
- **Off-platform detection** flags Discord/Telegram/WhatsApp/external-payment mentions and phone numbers, posts a warning, and suspends after `OFFPLATFORM_SUSPEND_STRIKES` (default 3).
- **WebSocket gateway** (`ws/gateway.ts`): first-frame auth (tokens never in URLs), history replay by `afterSeq` on (re)subscribe, per-socket rate limiting, Redis pattern pub/sub for cross-node fan-out.

## 4. Concurrency

- Unique/limited stock uses **optimistic locking**: candidate inventory rows are read without locks and claimed with `UPDATE … WHERE id = $1 AND version = $2 AND status = 'available'`. Manual-stock offers use the offer's `version` column the same way. Seller edits must send the version they read (409 on conflict). Tested with 25 concurrent buyers for one item.
- Workers claim jobs with `FOR UPDATE SKIP LOCKED` (webhooks) or re-check state under a row lock (releases), so several workers can run safely.

## 5. Security, fraud and compliance

**PCI DSS 4.0.1**
- Card data is only ever entered on the PSP's hosted page (SAQ-A scope). No PAN reaches our servers; we store only brand, last4, PSP card fingerprint and AVS/CVV results.
- 6.4.3 script inventory: `apps/web/payment-scripts.json` lists every script allowed on payment-initiating pages with a justification. `apps/web/scripts/verify-payment-scripts.mjs` runs on every build and fails it on unlisted or inline scripts, logging SHA-384 digests.
- 11.6.1 change/tamper detection: strict CSP (`script-src 'self'`) as a header in `apps/web/nginx.conf`, with violations reported to `POST /v1/security/csp-report` and stored in `csp_reports`.
- MFA for administrative access and quarterly ASV scans are operational controls outside this codebase.

**Encryption and secrets**
- Inventory codes/credentials, webhook secrets and owner-proof evidence: AES-256-GCM with a versioned keyring (`DATA_ENCRYPTION_KEYS`, rotate by appending a key).
- Passwords are **hashed with scrypt**, not encrypted: the spec asked for AES-256 on passwords, but reversible encryption of passwords is weaker than a memory-hard hash, so this is a deliberate deviation.
- API keys are stored as HMACs; OTP codes are stored as HMACs with attempt limits.

**eKYC** (`domain/users.ts`, `providers/kyc/sumsub.ts`): Tier 1 = verified email + SMS OTP (required to buy). Tier 2 = ID document + liveness via Sumsub (required to sell, use the API, and withdraw). Sumsub requests are HMAC-signed and webhooks verified with `X-Payload-Digest`.

**Fraud** (`domain/fraud.ts`, `services/fraud-gnn`)
- Every login/registration/order records graph edges in `risk_signals` (device fingerprint, IP /24 or /48, card fingerprint, wallet). Private/loopback IPs are ignored.
- On payment capture the API computes a **Syndicate Risk Score** inline: shared infrastructure between buyer and seller, connected buyer clusters funnelling into one seller within 72h (union-find over shared signals), new-seller concentration, buyer velocity, links to suspended/charged-back accounts; combined by noisy-OR.
- If `FRAUD_GNN_URL` is set, the **HGT model** (`services/fraud-gnn`) scores the same heterogeneous graph with learned relation-specific attention; the API takes the max of the two and falls back to the heuristic within 400ms.
- ≥ 0.5: that order's escrow is frozen, auto-delivery withheld, both parties flagged. ≥ 0.8: the seller's withdrawals and all open escrows are frozen. Admins clear (unfreeze) or confirm (suspend) flags.

**Chargebacks** (`domain/chargebacks.ts`)
- Reason-code map: Visa 10.4 / MC 4837 → fraud evidence (AVS, CVV, IP country vs billing country, prior undisputed orders on the same device/card); Visa 13.3 / MC 4853 → listing snapshot + hash, chat log, whether the buyer ever disputed on-platform, ToS acceptance; Visa 13.6 → refund ledger proof or cancellation policy.
- The PDF packet is generated and submitted to the PSP automatically; response deadlines are 30 days (Visa) / 45 days (Mastercard).
- **Chargeback Shield**: for protected sellers the reserve absorbs the loss; for *High risk · secondary market* listings the seller's balance is debited first. A won chargeback reverses the exact original allocation.

**Webhooks** (`domain/webhooks.ts`): transactional outbox, `X-Hook-Signature` (hex HMAC-SHA256 of the raw body), `Idempotency-Key` stable across retries, exponential backoff (30s → 6h cap, ±20% jitter, 12 attempts, then dead-lettered), SSRF guard against private destinations in production.

## Known limitations / production hardening

- **Fraud model training data.** The shipped model is bootstrapped on synthetic graphs (`fraud_gnn/synthetic.py`). The synthetic task is easy (validation AUC ≈ 1.0), so that number says nothing about production accuracy. Retrain on labelled production data (`python -m fraud_gnn.train --dsn …`) and evaluate on a time-based holdout before enabling `FRAUD_GNN_URL` in enforcement mode. The inline heuristic works without it.
- **Validator randomness.** The panel seed is a future block hash, which a block proposer can bias. Use a VRF (e.g. Chainlink VRF) before mainnet, and get the contract **externally audited**; it has unit tests, not an audit.
- **Escrow signer key** should live in a KMS/HSM, not an environment variable.
- **Stripe Connect onboarding** (creating connected accounts, `stripe_account_id`) is not implemented in the UI; payouts require it when `PAYMENT_PROVIDER=stripe`.
- **Refresh tokens / MFA for users** are not implemented; sessions are 12-hour JWTs re-validated against the user row on every request.
- **Chat retention**: the log is append-only by design. Check this against GDPR erasure obligations in your jurisdiction (e.g. crypto-shredding per-user message keys).
- The legality of trading game accounts varies by publisher ToS; category policies are a business decision, not something code can settle.
