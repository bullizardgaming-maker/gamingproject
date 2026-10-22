import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, dispatchDueWebhooks } from '../src/domain/webhooks.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('merchant REST API (API keys)', () => {
  it('lets a bot poll orders, push inventory, reprice and deliver', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const key = await seller.api.post('/v1/developer/api-keys', { name: 'bot', scopes: ['orders:read', 'orders:write', 'inventory:write', 'offers:write'] });
    expect(key.status).toBe(201);
    const bot = client(h.app, key.body.key);

    const auto = await makeOffer(seller);
    const inv = await bot.post('/v1/merchant/inventory', { offerId: auto.id, format: 'json', content: JSON.stringify(['A-1', 'A-2']) });
    expect(inv.body.added).toBe(2);

    const prices = await bot.patch('/v1/merchant/prices', { updates: [{ offerId: auto.id, priceCents: 7_77, version: auto.version }, { offerId: auto.id, priceCents: 8_88, version: auto.version }] });
    expect(prices.body.results.map((r: any) => r.ok)).toEqual([true, false]);

    const manual = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 5 });
    const order = await buyAndPay(h, buyer, manual.id);
    const list = await bot.get('/v1/merchant/orders?status=paid');
    expect(list.body.map((o: any) => o.id)).toContain(order.id);
    expect((await bot.post(`/v1/merchant/orders/${order.id}/deliver`, { payload: 'Boost done: Diamond II' })).status).toBe(200);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('delivered');
  });

  it('enforces scopes, revocation and Tier 2', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const key = await seller.api.post('/v1/developer/api-keys', { name: 'ro', scopes: ['orders:read'] });
    const bot = client(h.app, key.body.key);
    expect((await bot.patch('/v1/merchant/prices', { updates: [{ offerId: '00000000-0000-0000-0000-000000000000', priceCents: 1 }] })).status).toBe(403);
    expect((await bot.get('/v1/merchant/orders')).status).toBe(200);
    await seller.api.del(`/v1/developer/api-keys/${key.body.id}`);
    expect((await bot.get('/v1/merchant/orders')).status).toBe(401);
    expect((await client(h.app, 'mk_abcdefgh_forgedforgedforgedforged').get('/v1/merchant/orders')).status).toBe(401);

    const tier1 = await makeUser(h, { tier: 1 });
    expect((await tier1.api.post('/v1/developer/api-keys', { name: 'x', scopes: ['orders:read'] })).status).toBe(400);
  });
});

describe('webhook delivery reliability', () => {
  it('retries with exponential backoff, then dead-letters', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const ep = await seller.api.post('/v1/developer/webhooks', { url: 'https://down.example/hook', events: ['order.created'] });
    await seller.api.post(`/v1/developer/webhooks/${ep.body.id}/test`);

    let calls = 0;
    const failing = (async () => {
      calls++;
      return new Response('nope', { status: 503 });
    }) as typeof fetch;

    await dispatchDueWebhooks(h.ctx, { fetchImpl: failing });
    let d = (await seller.api.get(`/v1/developer/webhooks/${ep.body.id}/deliveries`)).body[0];
    expect(d).toMatchObject({ status: 'pending', attempts: 1, last_status_code: 503 });
    const wait = (new Date(d.next_attempt_at).getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(20);
    expect(wait).toBeLessThan(40);

    // Not due yet: no redelivery.
    await dispatchDueWebhooks(h.ctx, { fetchImpl: failing });
    expect(calls).toBe(1);

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await h.ctx.db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE endpoint_id = $1`, [ep.body.id]);
      await dispatchDueWebhooks(h.ctx, { fetchImpl: failing });
    }
    d = (await seller.api.get(`/v1/developer/webhooks/${ep.body.id}/deliveries`)).body[0];
    expect(d).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS });
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it('keeps the same idempotency key across retries', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const ep = await seller.api.post('/v1/developer/webhooks', { url: 'https://flaky.example/hook', events: ['order.created'] });
    await seller.api.post(`/v1/developer/webhooks/${ep.body.id}/test`);
    const keys: string[] = [];
    let n = 0;
    const flaky = (async (_u: string, init: any) => {
      keys.push(init.headers['Idempotency-Key']);
      return new Response('', { status: ++n === 1 ? 500 : 200 });
    }) as typeof fetch;
    await dispatchDueWebhooks(h.ctx, { fetchImpl: flaky });
    await h.ctx.db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE endpoint_id = $1`, [ep.body.id]);
    await dispatchDueWebhooks(h.ctx, { fetchImpl: flaky });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect((await seller.api.get(`/v1/developer/webhooks/${ep.body.id}/deliveries`)).body[0].status).toBe('succeeded');
  });

  it('rejects unknown event types', async () => {
    const seller = await makeUser(h, { tier: 2 });
    expect((await seller.api.post('/v1/developer/webhooks', { url: 'https://x.example', events: ['order.exploded'] })).status).toBe(400);
  });
});
