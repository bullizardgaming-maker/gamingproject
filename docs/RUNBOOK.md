# Operations runbook

What happens when a dependency fails, what users notice, and what to do. The behaviour
described here is measured by `apps/api/scripts/failover-drill.ts`, which runs steady traffic
(browse → buy → pay → check notifications) through a real API and worker while breaking
one thing at a time. It then checks the books (integrity checks, reconciliation, no oversold
stock, no balance changes from failed payouts).

```bash
DATABASE_URL=postgres://.../market_drill REDIS_URL=redis://127.0.0.1:6379 npx tsx apps/api/scripts/failover-drill.ts
```

## Latest drill (16 concurrent users, 12 s per phase)

| Phase | Requests | Failed | p95 ms | Notes |
|---|---|---|---|---|
| baseline | 2888 | 0 | 237 | |
| Redis down | 2608 | 0 | 280 | live updates and shared rate limits pause; nothing else |
| Redis back | 2828 | 0 | 249 | |
| read replica down | 3048 | 0 | 221 | reads fall back to the primary |
| replica back | 2844 | 0 | 228 | |
| all DB connections killed | 2761 | 6 | 235 | queries outside a transaction that were running at the cut; transactions are retried |
| recovery | 2732 | 0 | 239 | |
| PSP rejects payouts | 10 payouts | 10 × 502 | – | balances unchanged, sellers notified |

There were no process crashes, and integrity and reconciliation were clean afterwards.

**What the first run found, and what was fixed:**
- **Redis down made requests hang for 10 seconds.** Publishes were queued until Redis came back. They now fail fast and are treated as best-effort.
- **A dropped database connection crashed the process.** The pg pool and checked-out clients had no error listeners. Broken clients are now discarded, and a transaction whose connection dies before COMMIT is retried once. One that dies *during* COMMIT is never retried, because its outcome is unknown.
- **A refused replica connection failed searches** instead of falling back. Any non-SQL error now falls back to the primary.
- **`/readyz` reported "not ready" when Redis was down.** A load balancer would have pulled every node, turning a Redis blip into a full outage. Readiness now depends on the database only.
- **A 5-second pool timeout was too tight.** The flash-sale load test showed it also caps queueing for a free connection, so a burst of 200 sign-ins failed. The primary now allows 30s; the replica keeps a short timeout because its reads can fall back.

Re-run the drill after infrastructure changes, and at least every quarter.

## Playbooks

### Redis unavailable
- **Users:** no live chat or notification push to open tabs on other nodes. The bell catches up on the next refresh or poll, and Web Push and email still go out. Rate limits fall back to "allow", so there are no per-IP limits until Redis is back.
- **Alerts:** `/readyz` shows `pubsub: false`. The API logs "redis unavailable; realtime fan-out paused".
- **Do:** restore Redis. Nothing needs replaying: notifications live in the database. If the outage is long, consider lowering the edge (CDN/WAF) rate limits, because the app's own limits are off.

### Read replica lagging or down
- **Users:** nothing visible. Search, listings, profiles and metrics move to the primary.
- **Alerts:** `ReplicaLagging`, plus `bullizard_db_replica_in_use` = 0.
- **Do:** fix replication, or rebuild the replica from the primary (`pg_basebackup`, see `deploy/backup/docker-compose.backup.yml`). Watch primary CPU while it carries the read load.

### Primary database restart or failover
- **Users:** requests in flight during the cut mostly succeed (they are retried once). A handful may get a 500. Clients should retry `POST /v1/orders` with the same `Idempotency-Key`, which is safe.
- **Do:** check the job heartbeats (`WorkerJobStalled`) and run `POST /v1/admin/reconciliation/run`. A transaction that died exactly during COMMIT has an unknown outcome. Reconciliation and the order's event history show whether it applied.
- **Data loss** (restore needed): follow `deploy/backup/restore-drill.sh` against the production bucket with a `recovery_target_time` just before the incident. Run `npm run verify-restore -w apps/api` before switching traffic.

### Payment provider (PSP) outage
- **Checkout:** buyers can't pay. Unpaid orders expire after `ORDER_PAYMENT_TTL_MINUTES` and stock returns automatically. Payments that arrive late are recorded and refunded.
- **PSP webhooks:** if our side fails, the PSP retries delivery. Webhook processing is idempotent.
- **Payouts:** each fails with `payout_failed` (502). The money goes straight back to the seller's balance, and they get an email and an inbox item. Nothing to clean up: they can retry later.
- **Refunds after release:** fail with `refund_failed`, and nothing is booked (the transaction rolls back).
- **Do:** check the PSP status page. When it's back, run reconciliation to confirm the PSP balance matches.

### Worker stopped
- **Symptoms:** escrow doesn't auto-release; emails and notifications queue; unpaid orders don't expire. `WorkerJobStalled` fires after 5 minutes.
- **Do:** restart it. Every job resumes from database state; nothing is lost, only delayed.

### Sanctions match or AML case
- Compliance gets an inbox item (`aml_case_opened`). Strong matches pause payouts automatically.
- **Never tell the user why** (no tipping off). The user-facing message is always "routine review".
- Record decisions in the case (clear, escalate, pause, report with the FIU reference). Everything is audited.

### Suspected key compromise
- **Data key:** append a new key to `DATA_ENCRYPTION_KEYS`, deploy, and watch `GET /v1/admin/keys` until nothing is left under the old key. Then remove it.
- **Escrow signer:** disable the KMS key, create a new one, update the contract's signer and set `ESCROW_KMS_KEY_ID`.
- **JWT secret:** rotating it signs everyone out.

## Escalation
1. **On-call engineer:** alerts marked `severity: page`.
2. **Finance:** reconciliation mismatch, PSP balance differences, failed treasury payouts.
3. **Compliance:** AML cases, data requests, suspected fraud rings.
4. **Security:** key compromise, the `session_reuse_detected` spike, the CSP report spike.
