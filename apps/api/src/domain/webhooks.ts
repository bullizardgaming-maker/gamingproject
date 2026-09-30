import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, withTx } from '../db.js';
import { hmacSha256, randomToken } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { fetchPublic, isPrivateAddress } from '../lib/netguard.js';

export const WEBHOOK_EVENTS = [
  'order.created', // order funded: buyer payment captured and locked in escrow
  'order.delivered',
  'order.completed',
  'order.disputed',
  'order.refunded',
  'order.cancelled',
  'offer.low_stock',
  'chat.message',
  'chargeback.created',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const MAX_ATTEMPTS = 12;
const LEASE_SECONDS = 120;

/** Exponential backoff: 30s, 1m, 2m, 4m ... capped at 6h, with +/-20% jitter. */
export function backoffSeconds(attempt: number, random = Math.random): number {
  const base = Math.min(30 * 2 ** (attempt - 1), 6 * 3600);
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Signature merchants must verify: hex HMAC-SHA256 of the exact raw request body. */
export function signPayload(secret: string, rawBody: string): string {
  return hmacSha256(secret, rawBody);
}

// ---------------------------------------------------------------------------
// Endpoint management
// ---------------------------------------------------------------------------
export async function createEndpoint(ctx: Ctx, userId: string, url: string, events: string[]) {
  assertSafeUrlShape(url, ctx.cfg.NODE_ENV === 'production');
  const unknown = events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (unknown.length) throw badRequest('unknown_event', `Unknown webhook events: ${unknown.join(', ')}`);
  const secret = `whsec_${randomToken(32)}`;
  const { rows } = await ctx.db.query(
    `INSERT INTO webhook_endpoints (user_id, url, secret_ciphertext, events) VALUES ($1, $2, $3, $4)
       RETURNING id, url, events, active, created_at`,
    [userId, url, ctx.keyring.encrypt(secret, 'webhook'), events],
  );
  // The secret is shown exactly once.
  return { ...rows[0], secret };
}

function assertSafeUrlShape(raw: string, production: boolean) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('invalid_url', 'Webhook URL is not a valid URL');
  }
  if (production && url.protocol !== 'https:') throw badRequest('invalid_url', 'Webhook URL must use https');
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('invalid_url', 'Webhook URL must be http(s)');
}

// SSRF guard lives in lib/netguard (re-exported for existing callers).
export { isPrivateAddress };

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------
/** Queue an event for every endpoint of `userId` subscribed to it. Call inside the business transaction. */
export async function enqueueWebhook(q: Queryable, userId: string, type: WebhookEvent, data: unknown): Promise<number> {
  const endpoints = await many<{ id: string }>(
    q,
    'SELECT id FROM webhook_endpoints WHERE user_id = $1 AND active AND $2 = ANY(events)',
    [userId, type],
  );
  // One event id per logical event: it is the idempotency key merchants de-duplicate on.
  const eventId = `evt_${randomUUID()}`;
  for (const ep of endpoints) {
    const payload = { id: eventId, type, created_at: new Date().toISOString(), data };
    await q.query('INSERT INTO webhook_deliveries (endpoint_id, event_type, payload) VALUES ($1, $2, $3)', [ep.id, type, payload]);
  }
  return endpoints.length;
}

// ---------------------------------------------------------------------------
// Dispatcher (safe to run on many workers concurrently: rows are claimed with SKIP LOCKED + a lease)
// ---------------------------------------------------------------------------
interface ClaimedDelivery {
  id: string;
  event_type: string;
  payload: { id: string; [k: string]: unknown };
  attempts: number;
  url: string;
  secret_ciphertext: string;
}

type FetchLike = (url: string, init: { method: string; redirect: 'manual'; signal: AbortSignal; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

export async function dispatchDueWebhooks(ctx: Ctx, opts: { limit?: number; fetchImpl?: FetchLike } = {}): Promise<number> {
  // Production deliveries may only reach public addresses, checked at connect time.
  const fetchImpl: FetchLike = opts.fetchImpl ?? (ctx.cfg.NODE_ENV === 'production' ? fetchPublic : fetch);
  const claimed = await withTx(ctx.db, (tx) =>
    many<ClaimedDelivery>(
      tx,
      `UPDATE webhook_deliveries d
          SET attempts = d.attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
         FROM webhook_endpoints e
        WHERE d.endpoint_id = e.id
          AND d.id IN (SELECT id FROM webhook_deliveries
                        WHERE status = 'pending' AND next_attempt_at <= now()
                        ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING d.id, d.event_type, d.payload, d.attempts, e.url, e.secret_ciphertext`,
      [opts.limit ?? 25, LEASE_SECONDS],
    ),
  );

  await Promise.all(claimed.map((d) => deliver(ctx, d, fetchImpl)));
  return claimed.length;
}

async function deliver(ctx: Ctx, d: ClaimedDelivery, fetchImpl: FetchLike) {
  const body = JSON.stringify(d.payload);
  const secret = ctx.keyring.decrypt(d.secret_ciphertext, 'webhook');
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetchImpl(d.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Bullizard-Webhooks/1.0',
        'X-Hook-Signature': signPayload(secret, body),
        'X-Hook-Event': d.event_type,
        'X-Hook-Delivery': d.id,
        'X-Hook-Attempt': String(d.attempts),
        'Idempotency-Key': d.payload.id,
      },
      body,
    });
    statusCode = res.status;
    if (res.status >= 200 && res.status < 300) {
      await ctx.db.query(
        `UPDATE webhook_deliveries SET status = 'succeeded', delivered_at = now(), last_status_code = $2, last_error = NULL WHERE id = $1`,
        [d.id, statusCode],
      );
      return;
    }
    error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message;
  }
  const dead = d.attempts >= MAX_ATTEMPTS;
  await ctx.db.query(
    `UPDATE webhook_deliveries
        SET status = $2, last_status_code = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5)
      WHERE id = $1`,
    [d.id, dead ? 'dead' : 'pending', statusCode, error, backoffSeconds(d.attempts)],
  );
}

// ---------------------------------------------------------------------------
// Merchant self-service: inspect failures, redeliver, replay, re-enable
// ---------------------------------------------------------------------------
export const DELIVERY_FILTERS = ['failing', 'dead', 'pending', 'succeeded', 'all'] as const;

/** `failing` = still retrying after at least one failed attempt. */
export async function listDeliveries(
  ctx: Ctx,
  userId: string,
  f: { endpointId?: string; status?: (typeof DELIVERY_FILTERS)[number]; limit?: number },
) {
  const status = f.status ?? 'all';
  return many(
    ctx.db,
    `SELECT d.id, d.endpoint_id, e.url, d.event_type, d.status, d.attempts, d.last_status_code, d.last_error,
            d.next_attempt_at, d.created_at, d.delivered_at, d.payload
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE e.user_id = $1 AND ($2::uuid IS NULL OR e.id = $2)
        AND CASE $3 WHEN 'all' THEN true
                    WHEN 'failing' THEN d.status = 'pending' AND d.last_error IS NOT NULL
                    ELSE d.status = $3 END
      ORDER BY d.created_at DESC LIMIT $4`,
    [userId, f.endpointId ?? null, status, Math.min(f.limit ?? 100, 500)],
  );
}

/**
 * Send one delivery again now with a fresh retry budget. The payload, and so the
 * event id merchants de-duplicate on, is unchanged.
 */
export async function redeliver(ctx: Ctx, userId: string, deliveryId: string) {
  const row = await maybeOne(
    ctx.db,
    `UPDATE webhook_deliveries d
        SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, last_status_code = NULL
       FROM webhook_endpoints e
      WHERE d.id = $1 AND e.id = d.endpoint_id AND e.user_id = $2 AND e.active
      RETURNING d.id, d.event_type, d.status`,
    [deliveryId, userId],
  );
  if (!row) throw notFound('Delivery (or its endpoint is disabled)');
  return row;
}

/** Re-queue every dead delivery of an endpoint (optionally since a time), e.g. after fixing an outage. */
export async function replayDead(ctx: Ctx, userId: string, endpointId: string, since?: string) {
  const { rowCount } = await ctx.db.query(
    `UPDATE webhook_deliveries d
        SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, last_status_code = NULL
       FROM webhook_endpoints e
      WHERE e.id = d.endpoint_id AND e.id = $1 AND e.user_id = $2 AND e.active
        AND d.status = 'dead' AND ($3::timestamptz IS NULL OR d.created_at >= $3)
        AND d.id IN (SELECT id FROM webhook_deliveries WHERE endpoint_id = $1 AND status = 'dead' ORDER BY created_at DESC LIMIT 5000)`,
    [endpointId, userId, since ?? null],
  );
  return { requeued: rowCount ?? 0 };
}

export async function setEndpointActive(ctx: Ctx, userId: string, endpointId: string, active: boolean) {
  const row = await maybeOne(ctx.db, 'UPDATE webhook_endpoints SET active = $3 WHERE id = $1 AND user_id = $2 RETURNING id, url, events, active', [endpointId, userId, active]);
  if (!row) throw notFound('Webhook endpoint');
  return row;
}

/** New signing secret, shown once. Deliveries already queued are signed with it too. */
export async function rotateSecret(ctx: Ctx, userId: string, endpointId: string) {
  const secret = `whsec_${randomToken(32)}`;
  const row = await maybeOne(ctx.db, 'UPDATE webhook_endpoints SET secret_ciphertext = $3 WHERE id = $1 AND user_id = $2 RETURNING id', [endpointId, userId, ctx.keyring.encrypt(secret, 'webhook')]);
  if (!row) throw notFound('Webhook endpoint');
  return { id: endpointId, secret };
}
