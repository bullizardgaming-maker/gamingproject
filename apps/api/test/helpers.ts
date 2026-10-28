import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createContext, type Ctx } from '../src/context.js';
import { createPool, migrate } from '../src/db.js';
import { MemoryPubSub } from '../src/lib/pubsub.js';
import { ConsoleMessenger } from '../src/providers/messaging.js';
import { MockKycProvider } from '../src/providers/kyc/mock.js';
import { forgetControlsCache } from '../src/domain/controls.js';
import { buildApp } from '../src/server.js';

export interface Harness {
  app: FastifyInstance;
  ctx: Ctx;
  messenger: ConsoleMessenger;
  close(): Promise<void>;
}

const silent = { info() {}, warn() {}, error: (o: unknown, m?: string) => console.error(m, o) };

export async function setup(overrides: Record<string, string> = {}, ctxOverrides: Partial<Ctx> = {}): Promise<Harness> {
  // Tests simulate clients on different IPs through X-Forwarded-For, as if behind a trusted proxy.
  // VIDEO_METADATA_STRIP off: the streaming tests use synthetic MP4 bytes; round23d.test.ts turns ffmpeg on.
  const cfg = loadConfig({ TRUST_PROXY: 'true', RATE_LIMIT_PER_MINUTE: '100000', AUTH_RATE_LIMIT_PER_MINUTE: '100000', VIDEO_METADATA_STRIP: 'off', ...overrides } as any);
  const db = createPool(cfg.DATABASE_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await db.query('UPDATE launch_settings SET phase = 3, allowed_games = NULL'); // tests cover every category and game; launch-phase.test.ts checks the gating
  // Beta limits off for the suite (round20.test.ts turns them on to check them); the controls cache is per process.
  await db.query('UPDATE platform_controls SET max_order_cents = 100000000, max_withdrawal_day_cents = 100000000, new_account_days = 0, four_eyes_withdrawal_cents = 100000000, four_eyes_user_day_cents = 100000000, max_platform_payout_day_cents = 100000000');
  forgetControlsCache();
  const messenger = new ConsoleMessenger(() => {});
  const ctx = createContext(cfg, silent, { db, pubsub: new MemoryPubSub(), messenger, ...ctxOverrides });
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    messenger,
    async close() {
      await app.close();
      await ctx.views.close();
      await db.end();
    },
  };
}

export type Api = ReturnType<typeof client>;

export function client(app: FastifyInstance, token?: string, headers: Record<string, string> = {}) {
  const call = async (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) => {
    // Round 23e (item 9): orders must name the Terms version the buyer saw. Like the web app (which sends the version it
    // loaded with the page), the harness sends the version in force unless the test sets `tosVersion` itself (even to
    // undefined, to send none).
    if (method === 'POST' && (url === '/v1/orders' || url === '/v1/orders/cart') && payload && typeof payload === 'object' && !('tosVersion' in payload)) {
      const terms = await app.inject({ method: 'GET', url: '/v1/legal/terms', headers: { ...headers, ...extra } });
      if (terms.statusCode === 200) payload = { ...(payload as object), tosVersion: terms.json().version };
    }
    const res: LightMyRequestResponse = await app.inject({
      method: method as any,
      url,
      payload: payload as any,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers, ...extra },
    });
    let body: any = res.body;
    try {
      body = res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.statusCode, body, headers: res.headers };
  };
  return {
    get: (url: string, extra?: Record<string, string>) => call('GET', url, undefined, extra),
    post: (url: string, payload?: unknown, extra?: Record<string, string>) => call('POST', url, payload ?? {}, extra),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload),
    put: (url: string, payload?: unknown) => call('PUT', url, payload),
    del: (url: string) => call('DELETE', url),
  };
}

let seq = 0;

/** Register a user and fast-path them to the requested tier/role. */
export async function makeUser(h: Harness, opts: { tier?: 0 | 1 | 2; role?: 'user' | 'arbiter' | 'support' | 'lead' | 'finance' | 'compliance' | 'admin'; device?: string; ip?: string; name?: string; /** Tier-1 users who may sell (the rules test passed). */ rulesPassed?: boolean } = {}) {
  seq++;
  const email = `user${seq}_${Date.now()}@example.com`;
  const res = await client(h.app, undefined, {
    ...(opts.device ? { 'x-device-fingerprint': opts.device } : {}),
    ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}),
  }).post('/v1/auth/register', { email, password: 'correct horse battery', displayName: opts.name ?? `User ${seq}`, acceptTerms: true });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  const { user, token } = res.body;
  const tier = opts.tier ?? 1;
  await h.ctx.db.query(
    `UPDATE users SET kyc_tier = $2::smallint, role = $3,
       email_verified_at = CASE WHEN $2::smallint >= 1 THEN now() END, phone_verified_at = CASE WHEN $2::smallint >= 1 THEN now() END,
       legal_name = CASE WHEN $2::smallint >= 2 THEN $4 END,
       rules_passed_at = CASE WHEN $2::smallint >= 2 OR $5::boolean THEN now() END
     WHERE id = $1`,
    [user.id, tier, opts.role ?? 'user', opts.name ?? `User ${seq}`, !!opts.rulesPassed],
  );
  const headers: Record<string, string> = {};
  if (opts.device) headers['x-device-fingerprint'] = opts.device;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  return { id: user.id as string, email, token: token as string, api: client(h.app, token, headers) };
}

export async function makeOffer(
  seller: { api: Api },
  body: Partial<{ categorySlug: string; title: string; priceCents: number; deliveryMode: 'auto' | 'manual'; stock: number; lowStockThreshold: number }> = {},
) {
  const res = await seller.api.post('/v1/offers', {
    categorySlug: 'keys',
    game: 'Test Game',
    title: 'Test Key',
    priceCents: 10_00,
    deliveryMode: 'auto',
    // Round 25: a currency listing names its delivery time from the fixed list.
    ...(body.categorySlug === 'currency' && body.deliveryMode === 'manual' ? { deliveryTime: '24h' } : {}),
    ...body,
  });
  if (res.status !== 201) throw new Error(`offer failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Create an order and pay it through the mock hosted checkout. */
export async function buyAndPay(h: Harness, buyer: { api: Api }, offerId: string, quantity = 1, payExtra: Record<string, string> = {}) {
  const res = await buyer.api.post('/v1/orders', { offerId, quantity, acceptTos: true });
  if (res.status !== 201) throw new Error(`order failed: ${JSON.stringify(res.body)}`);
  const ref = res.body.order.payment_ref;
  const pay = await client(h.app).post(`/v1/payments/mock/checkout/${ref}/pay`, payExtra, { accept: 'application/json' });
  if (pay.status !== 200) throw new Error(`pay failed: ${JSON.stringify(pay.body)}`);
  return res.body.order as { id: string; ref: string; payment_ref: string; amount_cents: number; seller_net_cents: number };
}

export function mockKyc(h: Harness) {
  return h.ctx.kyc as MockKycProvider;
}

/**
 * Round 20: no order releases on its own. For tests that used to wait out the 14-day window, end the window
 * and have a support member release the order (the only way an unconfirmed delivery completes).
 */
export async function endWindowAndRelease(h: Harness, orderId: string) {
  const { runJobsOnce } = await import('../src/worker.js');
  await h.ctx.db.query(`UPDATE orders SET protection_ends_at = now() - interval '1 second', delivered_at = LEAST(delivered_at, now() - interval '2 days') WHERE id = $1`, [orderId]);
  await runJobsOnce(h.ctx); // marks the window as ended; nothing moves
  const amount = Number((await h.ctx.db.query('SELECT amount_cents FROM orders WHERE id = $1', [orderId])).rows[0].amount_cents);
  const staff = await makeUser(h, { role: amount > 200_00 ? 'lead' : 'support' });
  const res = await staff.api.post(`/v1/admin/orders/${orderId}/release`, { note: 'Window over, delivery checked (test)' });
  if (res.status !== 200) throw new Error(`staff release failed: ${JSON.stringify(res.body)}`);
  return res.body;
}
