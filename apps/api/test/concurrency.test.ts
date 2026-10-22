import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('optimistic locking under flash-sale concurrency', () => {
  it('sells a single auto-delivery item to exactly one of 25 simultaneous buyers', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { title: 'Rare key', priceCents: 999_00 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'THE-ONLY-KEY' });
    const buyers = await Promise.all(Array.from({ length: 25 }, () => makeUser(h, { tier: 1 })));

    const results = await Promise.all(buyers.map((b) => b.api.post('/v1/orders', { offerId: offer.id, acceptTos: true })));
    const ok = results.filter((r) => r.status === 201);
    const sold = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(sold).toHaveLength(24);
    expect(sold.every((r) => r.body.error.code === 'out_of_stock')).toBe(true);

    const reserved = await h.ctx.db.query(`SELECT count(*)::int AS n, count(DISTINCT order_id)::int AS orders FROM inventory_items WHERE offer_id = $1 AND status = 'reserved'`, [offer.id]);
    expect(reserved.rows[0]).toEqual({ n: 1, orders: 1 });
    // Losers' order rows were rolled back with their transaction.
    const orders = await h.ctx.db.query('SELECT count(*)::int AS n FROM orders WHERE offer_id = $1', [offer.id]);
    expect(orders.rows[0].n).toBe(1);
  });

  it('never oversells a multi-unit auto-delivery pool', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller);
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: Array.from({ length: 10 }, (_, i) => `K-${i}`).join('\n') });
    const buyers = await Promise.all(Array.from({ length: 12 }, () => makeUser(h, { tier: 1 })));
    const results = await Promise.all(buyers.map((b) => b.api.post('/v1/orders', { offerId: offer.id, quantity: 2, acceptTos: true })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    const dup = await h.ctx.db.query(`SELECT order_id, count(*)::int AS n FROM inventory_items WHERE offer_id = $1 AND status = 'reserved' GROUP BY order_id`, [offer.id]);
    expect(dup.rows.every((r) => r.n === 2)).toBe(true);
  });

  it('guards manual stock with the offer version column', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', title: 'Rank boost', deliveryMode: 'manual', stock: 3 });
    const buyers = await Promise.all(Array.from({ length: 10 }, () => makeUser(h, { tier: 1 })));
    const results = await Promise.all(buyers.map((b) => b.api.post('/v1/orders', { offerId: offer.id, acceptTos: true })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const after = (await seller.api.get(`/v1/offers/${offer.id}`)).body;
    expect(after.stock).toBe(0);
  });

  it('rejects stale offer edits with 409', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller);
    const a = await seller.api.patch(`/v1/offers/${offer.id}`, { version: offer.version, priceCents: 11_00 });
    expect(a.status).toBe(200);
    const b = await seller.api.patch(`/v1/offers/${offer.id}`, { version: offer.version, priceCents: 12_00 });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('version_conflict');
  });
});
