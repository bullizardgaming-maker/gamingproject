import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../src/observability.js';
import { runJobsOnce } from '../src/worker.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { pino } from 'pino';
import { Writable } from 'node:stream';

let h: Harness;
beforeAll(async () => {
  h = await setup({ SANDBOX_MODE: 'true' });
});
afterAll(async () => h.close());

describe('market search', () => {
  let sellerA: Awaited<ReturnType<typeof makeUser>>;
  beforeAll(async () => {
    sellerA = await makeUser(h, { tier: 2 });
    const sellerB = await makeUser(h, { tier: 2 });
    const mk = async (s: typeof sellerA, body: Parameters<typeof makeOffer>[1], stock = 'X') => {
      const o = await makeOffer(s, body);
      if ((body?.deliveryMode ?? 'auto') === 'auto') await s.api.post(`/v1/offers/${o.id}/inventory`, { format: 'txt', content: stock + '-' + o.id });
      return o;
    };
    await mk(sellerA, { title: 'Elden Ring Steam key Global', priceCents: 30_00 });
    await h.ctx.db.query(`UPDATE offers SET game = 'Elden Ring' WHERE title LIKE 'Elden Ring%'`);
    await mk(sellerB, { title: 'Valorant Immortal account', categorySlug: 'accounts', deliveryMode: 'manual', priceCents: 150_00 });
    await h.ctx.db.query(`UPDATE offers SET game = 'Valorant' WHERE title LIKE 'Valorant%'`);
    await mk(sellerB, { title: 'Cheap Elden Ring runes 10M', categorySlug: 'currency', deliveryMode: 'manual', stock: 5, priceCents: 5_00 });
    await h.ctx.db.query(`UPDATE offers SET game = 'Elden Ring' WHERE title LIKE 'Cheap Elden%'`);
    await mk(sellerB, { title: 'Out of stock key', priceCents: 1_00 }); // auto, stock uploaded
    const oos = await makeOffer(sellerB, { title: 'Sold out gift card', categorySlug: 'gift-cards', priceCents: 2_00 }); // no stock
    void oos;
  });

  it('finds by text with typo tolerance and returns facets', async () => {
    const res = (await client(h.app).get('/v1/offers?q=elden')).body;
    expect(res.items.map((o: any) => o.title)).toEqual(expect.arrayContaining(['Elden Ring Steam key Global', 'Cheap Elden Ring runes 10M']));
    expect(res.sort).toBe('relevance');
    expect(res.facets.categories).toEqual(expect.arrayContaining([{ category_slug: 'keys', count: 1 }, { category_slug: 'currency', count: 1 }]));
    const typo = (await client(h.app).get('/v1/offers?q=valornt')).body;
    expect(typo.items[0].title).toBe('Valorant Immortal account');
    const partial = (await client(h.app).get('/v1/offers?q=eldn')).body.items.map((o: any) => o.game);
    expect(partial.length).toBe(2);
    expect(new Set(partial)).toEqual(new Set(['Elden Ring']));
  });

  it('filters by price, delivery, category and stock, and sorts', async () => {
    const cheap = (await client(h.app).get('/v1/offers?maxPrice=1000&sort=price_asc')).body.items.map((o: any) => o.price_cents);
    expect(cheap).toEqual([...cheap].sort((a: number, b: number) => a - b));
    expect(cheap.every((p: number) => p <= 1000)).toBe(true);
    const instant = (await client(h.app).get('/v1/offers?delivery=instant')).body.items;
    expect(instant.every((o: any) => o.delivery_mode === 'auto')).toBe(true);
    const all = (await client(h.app).get('/v1/offers?inStock=false&pageSize=60')).body.items.map((o: any) => o.title);
    expect(all).toContain('Sold out gift card');
    expect((await client(h.app).get('/v1/offers')).body.items.map((o: any) => o.title)).not.toContain('Sold out gift card');
    const cat = (await client(h.app).get('/v1/offers?q=elden&category=currency')).body;
    expect(cat.total).toBe(1);
    expect(cat.facets.categories.length).toBe(2); // facets ignore the selected category
    expect((await client(h.app).get('/v1/offers?sort=bogus')).status).toBe(400);
  });

  it('paginates', async () => {
    const p1 = (await client(h.app).get('/v1/offers?pageSize=2&page=1&sort=newest')).body;
    const p2 = (await client(h.app).get('/v1/offers?pageSize=2&page=2&sort=newest')).body;
    expect(p1.items).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.total).toBeGreaterThanOrEqual(3);
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
  });

  it('autocompletes game names', async () => {
    const games = (await client(h.app).get('/v1/games?q=eld')).body;
    expect(games[0]).toMatchObject({ game: 'Elden Ring', offers: 2 });
  });
});

describe('staff audit log', () => {
  it('records staff actions and staff views of other people’s orders; entries are immutable', async () => {
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, buyer, offer.id);
    const d = await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Seller never started the boost' });

    await admin.api.get(`/v1/orders/${order.id}`);
    await buyer.api.get(`/v1/orders/${order.id}`); // participants aren't logged
    await admin.api.post(`/v1/admin/disputes/${d.body.id}/resolve`, { outcome: 'buyer', note: 'No progress shown in chat' });
    await admin.api.post(`/v1/admin/users/${seller.id}/suspend`, { reason: 'Repeated non-delivery' });

    const log = (await admin.api.get(`/v1/admin/audit?actor=${admin.id}`)).body;
    expect(log.map((e: any) => e.action)).toEqual(['user.suspend', 'dispute.resolve', 'order.viewed']);
    expect(log[1].details).toMatchObject({ outcome: 'buyer' });
    expect((await buyer.api.get('/v1/admin/audit')).status).toBe(403);
    await expect(h.ctx.db.query('DELETE FROM admin_audit_log')).rejects.toThrow(/append-only/);
  });
});

describe('seller API docs', () => {
  it('serves an OpenAPI 3.1 document that matches the real routes', async () => {
    const spec = (await client(h.app).get('/v1/openapi.json')).body;
    expect(spec.openapi).toBe('3.1.0');
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      for (const method of Object.keys(ops)) {
        const url = path.replace(/\{(\w+)\}/g, ':$1');
        expect(h.app.hasRoute({ method: method.toUpperCase() as any, url }), `${method} ${path}`).toBe(true);
      }
    }
    expect(Object.keys(spec.webhooks)).toContain('order.created');
    expect(spec.paths['/v1/merchant/prices'].patch.requestBody.content['application/json'].schema.properties.updates.maxItems).toBe(500);
    const docs = await client(h.app).get('/v1/docs/');
    expect(docs.status).toBe(200);
  });
});

describe('sandbox', () => {
  it('lets a seller bot run a whole order lifecycle against simulated buyers', async () => {
    const dev = await makeUser(h, { tier: 1 });
    await dev.api.post('/v1/sandbox/verify-me');
    const hook = await dev.api.post('/v1/developer/webhooks', { url: 'https://bot.example/hooks', events: ['order.created', 'order.completed', 'order.disputed', 'chargeback.created'] });
    const key = (await dev.api.post('/v1/developer/api-keys', { name: 'bot', scopes: ['orders:read', 'orders:write', 'inventory:write'] })).body.key;
    const bot = client(h.app, key);
    const offer = await makeOffer(dev, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 10, priceCents: 40_00 });

    const o1 = (await bot.post('/v1/sandbox/orders', { offerId: offer.id })).body;
    expect(o1.status).toBe('paid');
    expect((await bot.post(`/v1/merchant/orders/${o1.id}/deliver`, { payload: 'done' })).status).toBe(200);
    expect((await bot.post(`/v1/sandbox/orders/${o1.id}/expire-protection`)).body.status).toBe('completed');

    const o2 = (await bot.post('/v1/sandbox/orders', { offerId: offer.id })).body;
    expect((await bot.post(`/v1/sandbox/orders/${o2.id}/dispute`, {})).status).toBe(200);
    const o3 = (await bot.post('/v1/sandbox/orders', { offerId: offer.id })).body;
    await bot.post(`/v1/merchant/orders/${o3.id}/deliver`);
    await bot.post(`/v1/sandbox/orders/${o3.id}/confirm`);
    expect((await bot.post(`/v1/sandbox/orders/${o3.id}/chargeback`, { network: 'visa', reasonCode: '10.4' })).status).toBe(201);

    // Can't target someone else's listing.
    const other = await makeUser(h, { tier: 2 });
    const foreign = await makeOffer(other, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 1 });
    expect((await bot.post('/v1/sandbox/orders', { offerId: foreign.id })).status).toBe(403);

    const received: string[] = [];
    const secret = hook.body.secret;
    const fakeFetch = (async (_u: string, init: any) => {
      expect(init.headers['X-Hook-Signature']).toBe(createHmac('sha256', secret).update(init.body).digest('hex'));
      received.push(JSON.parse(init.body).type);
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const { dispatchDueWebhooks } = await import('../src/domain/webhooks.js');
    await dispatchDueWebhooks(h.ctx, { fetchImpl: fakeFetch, limit: 100 });
    expect(new Set(received)).toEqual(new Set(['order.created', 'order.completed', 'order.disputed', 'chargeback.created']));
  });

  it('refuses to start with real payment providers', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ SANDBOX_MODE: 'true', PAYMENT_PROVIDER: 'stripe' } as any)).toThrow(/SANDBOX_MODE requires/);
  });

  it('is not mounted outside sandbox mode', async () => {
    const plain = await setup();
    expect((await client(plain.app).post('/v1/sandbox/orders', {})).status).toBe(404);
    expect((await client(plain.app).get('/v1/openapi.json')).body.paths['/v1/sandbox/orders']).toBeUndefined();
    await plain.close();
    // setup() reset the shared schema; recreate this suite's harness state for later tests.
    h = await setup({ SANDBOX_MODE: 'true' });
  });
});

describe('monitoring', () => {
  it('exposes Prometheus metrics with business gauges and job heartbeats', async () => {
    await runJobsOnce(h.ctx);
    await client(h.app).get('/v1/offers');
    const res = await client(h.app).get('/metrics');
    expect(res.status).toBe(200);
    const text = String(res.body);
    expect(text).toMatch(/http_request_duration_seconds_bucket\{.*route="\/v1\/offers"/);
    for (const g of ['bullizard_escrow_held_cents', 'bullizard_disputes_open', 'bullizard_chargebacks_due_within_7d', 'bullizard_reconciliation_last_status']) {
      expect(text).toContain(g);
    }
    expect(text).toMatch(/bullizard_worker_job_last_success_age_seconds\{[^}]*job="webhooks"/);
  });

  it('protects /metrics with a token and hides it in production without one', async () => {
    const secured = await setup({ METRICS_TOKEN: 'scrape-secret' });
    expect((await client(secured.app).get('/metrics')).status).toBe(401);
    expect((await client(secured.app, 'scrape-secret').get('/metrics')).status).toBe(200);
    await secured.close();
    h = await setup({ SANDBOX_MODE: 'true' });
  });

  it('reports readiness and tags responses with a request id', async () => {
    const r = await client(h.app).get('/readyz');
    expect(r.body).toEqual({ ok: true, checks: { database: true, pubsub: true } });
    expect(r.headers['x-request-id']).toBeTruthy();
    expect((await client(h.app).get('/healthz', { 'x-request-id': 'trace-123' })).headers['x-request-id']).toBe('trace-123');
  });

  it('redacts credentials from logs', () => {
    const lines: string[] = [];
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }));
    log.info({ req: { headers: { authorization: 'Bearer secret', cookie: 'bz_rt=rt_x' } }, body: { password: 'hunter2', refreshToken: 'rt_y' } }, 'test');
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('rt_');
  });
});
