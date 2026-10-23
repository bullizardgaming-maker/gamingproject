import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createContext, type Ctx } from '../src/context.js';
import { createPool, migrate } from '../src/db.js';
import { MemoryPubSub } from '../src/lib/pubsub.js';
import { ConsoleMessenger } from '../src/providers/messaging.js';
import { MockKycProvider } from '../src/providers/kyc/mock.js';
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
  const cfg = loadConfig({ TRUST_PROXY: 'true', RATE_LIMIT_PER_MINUTE: '100000', AUTH_RATE_LIMIT_PER_MINUTE: '100000', ...overrides } as any);
  const db = createPool(cfg.DATABASE_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await db.query('UPDATE launch_settings SET phase = 3, allowed_games = NULL'); // tests cover every category and game; launch-phase.test.ts checks the gating
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
export async function makeUser(h: Harness, opts: { tier?: 0 | 1 | 2; role?: 'user' | 'arbiter' | 'support' | 'finance' | 'compliance' | 'admin'; device?: string; ip?: string; name?: string; /** Tier-1 users who may sell (the rules test passed). */ rulesPassed?: boolean } = {}) {
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
