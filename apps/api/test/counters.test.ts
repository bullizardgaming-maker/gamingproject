import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { repairCounters } from '../src/domain/counters.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const stored = async (id: string) => (await h.ctx.db.query('SELECT available, offer_available(id) AS live FROM offers WHERE id = $1', [id])).rows[0];
const seller = async (id: string) => (await h.ctx.db.query('SELECT completed_orders, rating_avg, review_count FROM users WHERE id = $1', [id])).rows[0];

describe('search counters', () => {
  it('keeps listing stock current through uploads, sales, edits and bundles', async () => {
    const s = await makeUser(h, { tier: 2 });
    const a = await makeOffer(s, { title: 'Key A', priceCents: 10_00 });
    const b = await makeOffer(s, { title: 'Key B', priceCents: 10_00 });
    const manual = await makeOffer(s, { title: 'Manual', deliveryMode: 'manual', stock: 4 });
    expect(await stored(manual.id)).toEqual({ available: 4, live: 4 });

    await s.api.post(`/v1/offers/${a.id}/inventory`, { format: 'txt', content: 'A1\nA2\nA3\nA4' });
    await s.api.post(`/v1/offers/${b.id}/inventory`, { format: 'txt', content: 'B1\nB2' });
    expect(await stored(a.id)).toEqual({ available: 4, live: 4 });

    const bundle = await s.api.post('/v1/offers', {
      categorySlug: 'keys', game: 'Test Game', title: 'A and B together', priceCents: 18_00, deliveryMode: 'auto',
      bundle: [{ offerId: a.id, quantity: 2 }, { offerId: b.id, quantity: 1 }],
    });
    expect(await stored(bundle.body.id)).toEqual({ available: 2, live: 2 });

    // A sale takes items from the parts; the bundle follows.
    const buyer = await makeUser(h);
    await buyAndPay(h, buyer, b.id);
    expect(await stored(b.id)).toEqual({ available: 1, live: 1 });
    expect(await stored(bundle.body.id)).toEqual({ available: 1, live: 1 });

    // Pausing a part empties the bundle; resuming restores it.
    const v = (await client(h.app).get(`/v1/offers/${a.id}`)).body.version;
    await s.api.patch(`/v1/offers/${a.id}`, { version: v, status: 'paused' });
    expect(await stored(bundle.body.id)).toEqual({ available: 0, live: 0 });
    await s.api.patch(`/v1/offers/${a.id}`, { version: v + 1, status: 'active' });
    expect(await stored(bundle.body.id)).toEqual({ available: 1, live: 1 });

    // Manual stock edits.
    await s.api.patch(`/v1/offers/${manual.id}`, { version: (await client(h.app).get(`/v1/offers/${manual.id}`)).body.version, stock: 9 });
    expect(await stored(manual.id)).toEqual({ available: 9, live: 9 });

    // Search filters on the stored stock.
    const found = (await client(h.app).get(`/v1/offers?sellerId=${s.id}`)).body.items.map((o: any) => o.title).sort();
    expect(found).toEqual(['A and B together', 'Key A', 'Key B', 'Manual']);
    await h.ctx.db.query(`UPDATE inventory_items SET status = 'revoked' WHERE offer_id = $1 AND status = 'available'`, [b.id]);
    expect(await stored(b.id)).toEqual({ available: 0, live: 0 });
    const after = (await client(h.app).get(`/v1/offers?sellerId=${s.id}`)).body.items.map((o: any) => o.title).sort();
    expect(after).toEqual(['Key A', 'Manual']);
  });

  it('keeps seller completed orders and rating current, and repairs drift', async () => {
    const s = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(s, { title: 'Rated key' });
    await s.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'K1\nK2\nK3' });
    const reviews: string[] = [];
    for (const rating of [5, 4, 2]) {
      const buyer = await makeUser(h);
      const order = await buyAndPay(h, buyer, offer.id);
      await buyer.api.post(`/v1/orders/${order.id}/confirm`);
      reviews.push((await buyer.api.post(`/v1/orders/${order.id}/review`, { rating })).body.id);
    }
    expect(await seller(s.id)).toEqual({ completed_orders: 3, rating_avg: 3.67, review_count: 3 });
    const listed = (await client(h.app).get(`/v1/offers/${offer.id}`)).body;
    expect(listed).toMatchObject({ seller_completed_orders: 3, seller_rating: 3.67, seller_review_count: 3 });

    // A hidden review stops counting.
    await h.ctx.db.query('UPDATE reviews SET hidden = true WHERE id = $1', [reviews[2]]);
    expect(await seller(s.id)).toMatchObject({ rating_avg: 4.5, review_count: 2 });
    expect((await client(h.app).get(`/v1/offers?sellerId=${s.id}&minRating=4.5&inStock=false`)).body.total).toBe(1);
    expect((await client(h.app).get(`/v1/offers?sellerId=${s.id}&minRating=4.6&inStock=false`)).body.total).toBe(0);

    // Drift (here: a write that bypassed the triggers) is repaired by the worker job.
    await h.ctx.db.query(`ALTER TABLE offers DISABLE TRIGGER offers_available`);
    await h.ctx.db.query('UPDATE offers SET available = 50 WHERE id = $1', [offer.id]);
    await h.ctx.db.query(`ALTER TABLE offers ENABLE TRIGGER offers_available`);
    await h.ctx.db.query('UPDATE users SET completed_orders = 0 WHERE id = $1', [s.id]);
    const fixed = await repairCounters(h.ctx);
    expect(fixed.listings).toBeGreaterThanOrEqual(1);
    expect(fixed.sellers).toBeGreaterThanOrEqual(1);
    expect(await stored(offer.id)).toEqual({ available: 0, live: 0 });
    expect(await seller(s.id)).toMatchObject({ completed_orders: 3 });
    expect(await repairCounters(h.ctx)).toEqual({ listings: 0, sellers: 0 });
  });
});
