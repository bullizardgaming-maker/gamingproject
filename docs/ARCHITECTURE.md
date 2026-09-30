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
- Every money movement is a balanced posting in a **double-entry ledger** (`ledger_entries`, append-only via trigger). Accounts: `gateway_clearing`, `escrow`, `treasury`, `reserve`, `seller_available`, `payouts`, `platform_withdrawals`, `user_credit`, `fx_pnl`. Balances are derived, never stored.
- State machine: `awaiting_payment → paid → delivered → completed`, with `disputed`, `refunded`, `cancelled`, `charged_back`. Every transition is guarded by the expected current status and recorded in `order_events` (append-only).
- Windows: `inspection_72h` for standard categories, `insurance_14d` for `risk_class = 'high'` (accounts). The worker releases escrow when the window lapses without a dispute and the order is not frozen.
- Split: commission is computed at order time from the seller's tier and locked on the order; 10% of each commission funds the chargeback reserve.
- Unpaid orders expire after `ORDER_PAYMENT_TTL_MINUTES` and return reserved stock. A payment that arrives after expiry is recorded and refunded.

**Web3 (`contracts/contracts/MarketEscrow.sol`, `apps/api/src/domain/web3.ts`, `indexer.ts`)**
- The API issues **EIP-712 terms signed by the platform** (seller, amount, fee, release schedule, deadlines). The contract only accepts deposits carrying that signature, so buyers cannot change the fee or recipient.
- Milestones: accounts release 30% on credential delivery and 70% after 14 days; boosting releases in four stages; everything else releases after 72h. Buyer can approve early; buyer can reclaim if nothing is delivered by the deadline.
- Disputes: either party freezes unreleased funds. A panel of 5 **bonded validators** is drawn from a future block hash, votes with **commit-reveal**, and the contract executes the majority (tie → 50/50 split). Majority voters share a 2% arbitration fee; validators who don't reveal lose 10% of their bond. Bonds are locked while assigned. No admin function can move escrowed funds.
- The indexer mirrors `EscrowCreated / DisputeOpened / EscrowSettled` into orders after 3 confirmations (auto-delivery runs off-chain on `EscrowCreated`).

**Money on an order.** `amount_cents` is the full order value in the settlement currency and is exactly what escrow holds. It is funded from up to three sources: a promo discount (`discount_cents`, paid by treasury), store credit (`credit_cents`, from the buyer's `user_credit` account) and the card (`charged_cents`, the rest). A database CHECK keeps the parts summing to the whole. Orders fully covered by credit/promo skip the PSP. Refunds send each part back where it came from.

**Currencies** (`domain/fx.ts`): everything internal (escrow, ledger, balances, commission) is in `SETTLEMENT_CURRENCY` (USD). Buyers can see and pay in EUR or GBP; sellers can price in any of them (a trigger keeps a settlement-currency price for search and sorting). At order time the rate, including an `FX_SPREAD_BPS` spread, is locked on the order with the presentment amount, so the buyer pays exactly what they were quoted. Differences between what the PSP settles and what was expected go to `fx_pnl`. Rates come from the ECB daily feed (`FX_PROVIDER=ecb`) or static config; stale rates (> `FX_MAX_AGE_HOURS`) stop foreign-currency checkout rather than guess.

**Promo codes & referrals** (`domain/promos.ts`, `referrals.ts`): admin-created codes (percent with an optional cap, or fixed amount; minimum order, first-order-only, per-user and total limits, validity window, optional category scope). A code is reserved at order creation under a row lock on the code, so a limited code can't be over-redeemed by concurrent checkouts; it is redeemed on capture and released on cancel/refund. The discount is platform-funded: sellers are paid on the full price. Referrals grant store credit to the referrer after the referee's first completed order above `REFERRAL_MIN_ORDER_CENTS`, never between accounts sharing a device, card or wallet, and at most `REFERRAL_MONTHLY_CAP` per month.

**Treasury withdrawals** (`domain/treasury.ts`): platform earnings leave through a four-eyes flow: one admin requests, a different admin approves (enforced by a DB CHECK), then a PSP payout is made and booked to `platform_withdrawals`. The amount is limited to treasury minus the chargeback reserve. With withdrawals modelled, reconciliation checks the PSP balance for real.

## 2. Marketplace mechanics

- **Tiered commission** (`domain/commission.ts`): Normal 12.99/9.99% → Legendary 7.99/4.99% by trailing-30-day completed sales; gift cards, top-ups and video games are a flat 4.99%.
- **Auto-delivery** (`domain/inventory.ts`): bulk `.txt` / JSON upload (≤10,000 items per upload), each item AES-256-GCM encrypted with the offer id as AAD, de-duplicated by a keyed HMAC fingerprint. On payment capture items are delivered in the same transaction and both parties are notified over WebSocket.
- **Holiday mode** (`PUT /v1/seller/shop-status`): pausing hides the shop's listings from search and blocks new orders (optionally until a date, with a message on the listings); orders already paid still have to be delivered.
- **Delivery deadlines**: manual listings promise a delivery time (`delivery_hours`); the deadline is set when the order is paid. Past it, both parties are emailed, the buyer can cancel for a full refund (`POST /v1/orders/:id/cancel-late`), and after `LATE_AUTO_REFUND_HOURS` more the worker refunds automatically. Seller profiles show their on-time delivery rate.
- **Original Owner Proof + Security Changeover** (`domain/offers.ts`, `orders.ts`): sellers submit registration email/date/billing name; approval requires the billing name to match the eKYC legal name. Account deliveries create a six-step checklist that must be completed before the buyer can release early. Unverified account listings are shown as *High risk · secondary market* and lose Chargeback Shield coverage.

## 3. Chat and real-time

- `chat_messages` has a **server-assigned, gapless, monotonic `seq`** per room: the append runs `UPDATE chat_rooms SET last_seq = last_seq + 1 … RETURNING`, whose row lock serializes writers across all nodes.
- Each message stores `hash = sha256(prev_hash | seq | sender | kind | body | created_at)`. The table is append-only (trigger), and `GET /v1/chat/rooms/:id/verify` recomputes the chain, so even a DBA edit is detectable. This log is embedded in arbitration and in chargeback packets.
- **Off-platform detection** flags Discord/Telegram/WhatsApp/external-payment mentions and phone numbers, posts a warning, and suspends after `OFFPLATFORM_SUSPEND_STRIKES` (default 3).
- **Screenshot evidence** (`domain/attachments.ts`, `providers/files.ts`): buyers and sellers can attach PNG/JPEG/WebP images to an order chat (8 MB, 20 per hour). The real type is sniffed from the bytes, the file is scanned with ClamAV (`MALWARE_SCANNER=clamd`, required in production; an infected upload is refused and flags the uploader), then decoded and re-encoded with sharp, which strips EXIF/GPS metadata and anything hidden after the image data. Files are stored encrypted on disk or in S3; the chat message records the SHA-256, so the hash chain proves evidence wasn't swapped later. Attachments are served with `nosniff` and a sandbox CSP, staff views are audited, and they are embedded in chargeback evidence packets.
- **WebSocket gateway** (`ws/gateway.ts`): first-frame auth (tokens never in URLs), history replay by `afterSeq` on (re)subscribe, per-socket rate limiting, Redis pattern pub/sub for cross-node fan-out.

## 4. Concurrency

- Unique/limited stock uses **optimistic locking**: candidate inventory rows are read without locks and claimed with `UPDATE … WHERE id = $1 AND version = $2 AND status = 'available'`. Manual-stock offers use the offer's `version` column the same way. Seller edits must send the version they read (409 on conflict). Tested with 25 concurrent buyers for one item.
- **Flash-sale load test** (`apps/api/scripts/loadtest-flash-sale.ts`, `npm run loadtest -w apps/api`): real HTTP, N buyers racing for M items, then database checks. 2,000 buyers for 200 codes at 200 concurrent requests on one API process and one Postgres: exactly 200 sold, no code delivered twice, books balanced; create-order p95 ≈ 1.1s, payment + delivery p95 ≈ 1.0s. The run found that upserting shared ledger accounts took a row lock held for the whole payment transaction, serializing payments (p95 was 3.5–6s); accounts are now read first and only inserted when missing.
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

**Sessions** (`domain/sessions.ts`): 15-minute access tokens carrying a session id that is checked on every request, so sign-out is immediate. Refresh tokens are opaque, stored as HMACs, rotate on every use, and are delivered to browsers only as an `httpOnly; SameSite=Strict; Path=/v1/auth` cookie (native clients opt into body delivery with `X-Token-Delivery: body`). Replaying an already-rotated refresh token revokes that device's whole session family and emails the user; a 10-second grace window absorbs two tabs refreshing at once. Users can list devices, sign out one or all others; changing the password or 2FA signs out every other device. Open WebSockets are closed with code 4401 when their session ends.

**Email** (`domain/notifications.ts`): transactional outbox written in the same transaction as the event, dispatched by the worker with retries, rendered as text + escaped HTML, sent through Postmark (`EMAIL_PROVIDER=postmark`) or logged in development. Templates cover payment, delivery, refunds, seller sales and payouts, disputes, chargebacks, verification, 24-hour protection-window reminders (sent once), and security alerts (new-device sign-in, password and 2FA changes, stolen refresh token). Users can turn off marketing-style categories; disputes, account and security emails are always on.

**Password reset** (`domain/users.ts`): single-use links valid 30 minutes, stored as HMACs, at most 3 per hour per account; the request endpoint answers identically whether or not the email exists. A reset burns all other outstanding links and signs out every device; two-factor login stays on.

**Phone verification** (`providers/messaging.ts`): SMS via Twilio; Twilio Lookup line-type intelligence rejects VoIP/virtual numbers; one verified number per live account (unique index), which makes farming seller accounts more expensive.

**Reviews** (`domain/reviews.ts`): only buyers of completed orders, one per order, within 30 days; sellers get one public reply; contact details are rejected. Reviews where buyer and seller share a device, card or wallet are stored hidden (sock-puppet pattern) and don't count. Ratings (average, count, % positive) appear on listings and `GET /v1/sellers/:id`. Staff can hide abusive reviews.

**Reconciliation** (`domain/reconciliation.ts`): runs once a day across all workers (advisory-lock guarded) or on demand from `POST /v1/admin/reconciliation/run`. Hard checks: every ledger transaction balances; each fiat order's escrow holding matches its state; the PSP's reported balance equals captured − refunds − PSP fees − chargebacks − seller payouts (PSP processing fees are booked from the capture webhook against treasury). Any mismatch emails every admin. Warnings: negative seller balances, stuck withdrawals, undelivered auto-delivery orders, dead webhooks, failed emails. Platform withdrawals of treasury funds are part of the PSP balance equation.

**Privacy / GDPR** (`domain/privacy.ts`): `GET /v1/me/export` returns the user's data as JSON. `POST /v1/me/delete` (password + 2FA code) requires no open orders and a zero balance, then anonymises the account: name, email, phone, legal name, wallet, 2FA, API keys, webhooks, listings, unsold stock, owner-proof evidence and review text are removed; all sessions are revoked. Orders, ledger, payouts, chargebacks, chat logs and fraud signals are retained without identity for legal-obligation and legal-claims reasons (the chat hash chain stays verifiable). Retention periods for those still need to be set in the privacy policy and enforced by a purge job.

**Market search** (`domain/search.ts`): weighted Postgres full-text search (title > game > description) plus trigram word-similarity so typos and partial words ("eldn", "valornt") still match; filters for category, game, price range, instant delivery, owner-verified accounts, minimum seller rating, in stock and seller; sorts by relevance, newest, price, rating or best-selling; page-based pagination with totals and per-category facet counts; `GET /v1/games?q=` for autocomplete. Stock and rating are computed per query; move them to write-maintained counters if listings pass ~100k.

**Staff audit log** (`domain/audit.ts`): every staff action (dispute decisions, fraud reviews, owner-proof reviews, suspensions, review moderation, manual chargebacks, reconciliation runs) and every staff view of someone else's order, chat or chargeback PDF is written to `admin_audit_log`, which triggers make append-only. Admins browse it in Operations > Audit log or `GET /v1/admin/audit`.

**Seller API docs & sandbox** (`openapi.ts`, `api-schemas.ts`, `routes/sandbox.ts`): the OpenAPI 3.1 document (merchant endpoints and all webhook payloads) is generated from the same zod schemas the routes validate with, served at `/v1/openapi.json` and browsable at `/v1/docs`. A test checks every documented path exists. Sandbox deployments (`SANDBOX_MODE=true`, which refuses to start unless payments and KYC are mocked) add `/v1/sandbox/*`: mark yourself verified, have a simulated buyer purchase your listing, confirm, dispute, skip to the end of the protection window, trigger a chargeback, and flush webhooks.

**Monitoring** (`observability.ts`, `deploy/monitoring/alerts.yml`): JSON logs (pino) with passwords, tokens, cookies and delivery payloads redacted; request ids accepted from `X-Request-Id` and echoed on every response and in 500 errors; Sentry error tracking when `SENTRY_DSN` is set (no headers, cookies or bodies sent); `/metrics` in Prometheus format (protected by `METRICS_TOKEN`, disabled in production without one) with HTTP latency/errors plus business gauges: escrow held, open disputes and their age, chargebacks near deadline, fraud-review backlog, undelivered paid orders, pending/dead webhooks, failed emails, last reconciliation result and age, and per-job worker heartbeats; `/healthz` (liveness) and `/readyz` (database + Redis). Alert rules cover error rate, latency, reconciliation, stalled jobs, chargeback deadlines, dispute backlog, dead webhooks and failing emails.

**Two-factor login** (`domain/mfa.ts`): TOTP (RFC 6238, verified against the RFC test vectors) with ±1 step drift, replay protection (last accepted step is stored), secrets AES-256-GCM encrypted, and 10 single-use recovery codes stored as HMACs. With 2FA on, the password step only returns a 5-minute challenge token that is useless as a session. **Staff actions** (arbiter/admin routes) require a session established with a second factor (PCI DSS 8.4); on by default in production, controlled by `STAFF_MFA_REQUIRED`.

**Payout accounts** (`domain/payouts.ts`): sellers onboard through Stripe Connect Express's hosted flow (bank and identity details never reach our servers). `account.updated` webhooks keep `payouts_enabled` current; withdrawals require it.

**Operations console** (`apps/web/src/pages/Admin.tsx`, `/admin`): dispute queue with links to the order chat, fraud-flag review (clear/unfreeze or confirm/suspend), Original Owner Proof review with the billing-name vs verified-ID check, chargeback deadlines and evidence PDFs, and platform ledger balances. Arbiters see disputes and owner proofs; admins see everything.

**Fraud** (`domain/fraud.ts`, `services/fraud-gnn`)
- Every login/registration/order records graph edges in `risk_signals` (device fingerprint, IP /24 or /48, card fingerprint, wallet). Private/loopback IPs are ignored.
- On payment capture the API computes a **Syndicate Risk Score** inline: shared infrastructure between buyer and seller, connected buyer clusters funnelling into one seller within 72h (union-find over shared signals), new-seller concentration, buyer velocity, links to suspended/charged-back accounts; combined by noisy-OR.
- If `FRAUD_GNN_URL` is set, the **HGT model** (`services/fraud-gnn`) scores the same heterogeneous graph with learned relation-specific attention; the API takes the max of the two and falls back to the heuristic within 400ms.
- ≥ 0.5: that order's escrow is frozen, auto-delivery withheld, both parties flagged. ≥ 0.8: the seller's withdrawals and all open escrows are frozen. Admins clear (unfreeze) or confirm (suspend) flags.

**Chargebacks** (`domain/chargebacks.ts`)
- Reason-code map: Visa 10.4 / MC 4837 → fraud evidence (AVS, CVV, IP country vs billing country, prior undisputed orders on the same device/card); Visa 13.3 / MC 4853 → listing snapshot + hash, chat log, whether the buyer ever disputed on-platform, ToS acceptance; Visa 13.6 → refund ledger proof or cancellation policy.
- The PDF packet is generated and submitted to the PSP automatically; response deadlines are 30 days (Visa) / 45 days (Mastercard).
- **Chargeback Shield**: for protected sellers the reserve absorbs the loss; for *High risk · secondary market* listings the seller's balance is debited first. A won chargeback reverses the exact original allocation.

**Webhooks** (`domain/webhooks.ts`): transactional outbox, `X-Hook-Signature` (hex HMAC-SHA256 of the raw body), `Idempotency-Key` stable across retries, exponential backoff (30s → 6h cap, ±20% jitter, 12 attempts, then dead-lettered). SSRF guard in production (`lib/netguard.ts`): the address check runs inside the socket's DNS lookup, so the address checked is the one connected to (no DNS-rebinding window); blocked ranges include private, loopback, link-local, CGNAT, multicast/reserved and IPv6 forms that embed IPv4 (mapped, NAT64, 6to4); redirects are never followed.

**Hardening from the internal security review**
- Client IPs come from `X-Forwarded-For` only when the hop is a configured proxy (`TRUST_PROXY`); trusting any caller would let attackers pick their IP and dodge per-IP rate limits and fraud signals. Country headers are read only from the configured edge header (`GEO_COUNTRY_HEADER`).
- Per-account sign-in lockout: `LOGIN_MAX_FAILURES` wrong passwords or 2FA codes pause sign-in for `LOGIN_LOCK_MINUTES`, doubling on each repeat (24h cap), with an email to the owner; a successful sign-in resets the counter and a password reset lifts the lock. This stops guessing spread over many IPs, including brute-forcing the 6-digit code behind a stolen password.
- Caller-supplied `X-Request-Id` values are accepted only as plain tokens (no log forging); LIKE wildcards in search input are escaped; malformed upload filenames no longer cause a 500.
- Reviewed and found sound: every admin route checks role (and 2FA for staff), order/chat/attachment reads check participation, JWTs pin HS256, the refresh cookie is `SameSite=Strict`, all SQL is parameterized.

## Known limitations / production hardening

- **External reviews still needed before launch**: a third-party penetration test of the API and web app, an audit of `MarketEscrow.sol`, a PCI QSA/ASV engagement, and legal review of the ToS, refund policy, promo/referral terms, data-retention periods and the per-publisher legality of account trading. The internal review above does not replace them.

- **Fraud model training data.** The shipped model is bootstrapped on synthetic graphs (`fraud_gnn/synthetic.py`). The synthetic task is easy (validation AUC ≈ 1.0), so that number says nothing about production accuracy. Retrain on labelled production data (`python -m fraud_gnn.train --dsn …`) and evaluate on a time-based holdout before enabling `FRAUD_GNN_URL` in enforcement mode. The inline heuristic works without it.
- **Validator randomness.** The panel seed is a future block hash, which a block proposer can bias. Use a VRF (e.g. Chainlink VRF) before mainnet, and get the contract **externally audited**; it has unit tests, not an audit.
- **Escrow signer key** should live in a KMS/HSM, not an environment variable.
- **Chat retention**: the log is append-only by design. Check this against GDPR erasure obligations in your jurisdiction (e.g. crypto-shredding per-user message keys).
- The legality of trading game accounts varies by publisher ToS; category policies are a business decision, not something code can settle.
