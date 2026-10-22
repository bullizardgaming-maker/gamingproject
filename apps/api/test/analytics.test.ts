import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('seller analytics', () => {
  it('reports sales, views, conversion, repeat buyers and a daily series against the previous period', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const a = await makeUser(h);
    const b = await makeUser(h);
    const offer = await makeOffer(seller, { title: 'Analytics key', priceCents: 10_00, deliveryMode: 'manual', stock: 50 });
    const other = await makeOffer(seller, { title: 'Quiet key', priceCents: 5_00, deliveryMode: 'manual', stock: 50 });

    // Views: four visitors, one of them twice in the hour, plus the seller (not counted).
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.4']) await client(h.app, undefined, { 'x-forwarded-for': ip }).get(`/v1/offers/${offer.id}`);
    await seller.api.get(`/v1/offers/${offer.id}`);
    await new Promise((r) => setTimeout(r, 100)); // views are written in the background

    const o1 = await buyAndPay(h, a, offer.id);
    const o2 = await buyAndPay(h, a, offer.id); // repeat buyer
    const o3 = await buyAndPay(h, b, offer.id);
    // Spread over the period, and one sale in the previous 30 days.
    await h.ctx.db.query('UPDATE orders SET paid_at = $2 WHERE id = $1', [o1.id, daysAgo(3)]);
    await h.ctx.db.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [o3.id]);
    await h.ctx.db.query(`INSERT INTO disputes (order_id, opened_by, reason) VALUES ($1, $2, 'not received')`, [o2.id, a.id]);
    const old = await buyAndPay(h, b, other.id);
    await h.ctx.db.query('UPDATE orders SET paid_at = $2 WHERE id = $1', [old.id, daysAgo(40)]);

    const res = await seller.api.get('/v1/seller/analytics?days=30');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = res.body;
    expect(r.bucket).toBe('day');
    expect(r.series).toHaveLength(30);
    expect(r.totals).toMatchObject({
      orders: 3,
      grossCents: 30_00,
      views: 4,
      conversionPct: 75,
      buyers: 2,
      repeatBuyers: 2, // a bought twice; b also bought 40 days ago
      repeatBuyerPct: 100,
      refundRatePct: 33.33,
      disputeRatePct: 33.33,
      avgOrderCents: 10_00,
    });
    expect(r.totals.netCents).toBeLessThan(20_00); // two non-refunded sales, after commission
    expect(r.previous).toMatchObject({ orders: 1, grossCents: 5_00 });

    const sum = (k: string) => r.series.reduce((s: number, x: any) => s + x[k], 0);
    expect(sum('orders')).toBe(3);
    expect(sum('views')).toBe(4);
    // Buyer a's first order is new, the second is returning; buyer b is returning (bought 40 days ago).
    expect(sum('new_buyers')).toBe(1);
    expect(sum('returning_buyers')).toBe(2);
    expect(r.series.find((x: any) => x.date === daysAgo(3).slice(0, 10))).toMatchObject({ orders: 1, gross_cents: 10_00 });

    expect(r.offers[0]).toMatchObject({ id: offer.id, orders: 3, views: 4, conversion_pct: 75 });
    expect(r.offers.find((o: any) => o.id === other.id)).toBeUndefined(); // nothing this period

    const year = await seller.api.get('/v1/seller/analytics?days=365');
    expect(year.body.bucket).toBe('week');
    expect(year.body.totals.orders).toBe(4);
    expect((await seller.api.get('/v1/seller/analytics?days=12')).status).toBe(400);
    expect((await a.api.get('/v1/seller/analytics')).status).toBe(403);
  });
});

describe('business dashboard', () => {
  it('reports GMV, take rate, dispute and chargeback rates for staff with the permission', async () => {
    const support = await makeUser(h, { tier: 2, role: 'support' });
    expect((await support.api.get('/v1/admin/analytics')).status).toBe(403);
    const finance = await makeUser(h, { tier: 2, role: 'finance' });
    const res = await finance.api.get('/v1/admin/analytics?days=30');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const t = res.body.totals;
    // From the seller test above: three orders paid in the last 30 days.
    expect(t).toMatchObject({ orders: 3, gmvCents: 30_00, disputes: 1, disputeRatePct: 33.33, refunds: 1, chargebacks: 0, chargebackRatePct: 0, sellers: 1, buyers: 2, newBuyers: 1, newSellers: 0 });
    expect(t.takeCents).toBeGreaterThan(0);
    expect(t.takeRatePct).toBeCloseTo((t.takeCents / t.gmvCents) * 100, 1);
    expect(res.body.previous).toMatchObject({ orders: 1, newSellers: 1, newBuyers: 1 });
    expect(res.body.categories[0]).toMatchObject({ category_slug: 'keys', orders: 3 });
    expect(res.body.games[0]).toMatchObject({ game: 'Test Game', orders: 3 });
    expect(res.body.series.reduce((s: number, x: any) => s + x.orders, 0)).toBe(3);

    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    expect((await admin.api.get('/v1/admin/analytics?days=7')).status).toBe(200);
  });
});
