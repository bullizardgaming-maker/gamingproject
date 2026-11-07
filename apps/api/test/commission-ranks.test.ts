import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grossUp } from '../src/domain/commission.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('commission gross-up and seller ranks', () => {
  it('previews the buyer price in every supported currency and what the seller keeps after the withdrawal fee', async () => {
    const seller = await makeUser(h, { tier: 2 });
    // Before any listing there is no promo: the first rank's rate applies.
    const fresh = (await seller.api.get('/v1/seller/price-preview?priceCents=10000')).body;
    expect(fresh).toMatchObject({ sellerCents: 100_00, rateBps: 1399, promo: null, rank: 'Hatchling', buyerCents: grossUp(100_00, 1399), commissionCents: grossUp(100_00, 1399) - 100_00 });

    await makeOffer(seller, { priceCents: 50_00 });
    const p = (await seller.api.get('/v1/seller/price-preview?priceCents=10000')).body;
    expect(p).toMatchObject({ rateBps: 500, rank: 'Hatchling', buyerCents: 105_27, commissionCents: 5_27, withdrawalFeeBps: 600, withdrawalFeeCents: 6_00, afterWithdrawalCents: 94_00 });
    expect(p.promo.rateBps).toBe(500);
    expect(new Date(p.promo.endsAt).getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    // Buyers in EUR/EGP see the grossed-up price at the checkout rate (mid-market plus the 1% spread).
    expect(p.buyerIn).toEqual({ USD: 105_27, EUR: Math.round(105_27 * 0.92), EGP: Math.round(105_27 * 48.5) });
    // A EUR-priced listing is previewed from its settlement value.
    const eur = (await seller.api.get('/v1/seller/price-preview?priceCents=9200&currency=EUR')).body;
    expect(eur).toMatchObject({ listingCurrency: 'EUR', settlementCents: 100_00, buyerCents: 105_27 });
    // Small amounts pay the minimum withdrawal fee.
    expect((await seller.api.get('/v1/seller/price-preview?priceCents=1000')).body).toMatchObject({ withdrawalFeeCents: 1_50, afterWithdrawalCents: 8_50 });
  });

  it('L1 (29d): an order that crosses the $1,500 promo cap pays the promo rate only on the part under the cap', async () => {
    const { grossUpForSeller } = await import('../src/domain/commission.js');
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { priceCents: 400_00, stock: 10 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'L1-A\nL1-B\nL1-C' });
    // $1,400 of promo sales already booked: $100 of the next $400 order is under the cap, $300 over it
    await h.ctx.db.query(`UPDATE users SET seller_since = now() - interval '1 day' WHERE id = $1`, [seller.id]);
    const o = await buyAndPay(h, buyer, offer.id);
    await h.ctx.db.query(`UPDATE orders SET seller_net_cents = 1400_00 WHERE id = $1`, [o.id]);
    const split = await grossUpForSeller(h.ctx.db, seller.id, 400_00);
    expect(split.split).toEqual({ underCapCents: 100_00, promoRateBps: 500, overCapCents: 300_00, rankRateBps: 1399 });
    expect(split.amount).toBe(grossUp(100_00, 500) + grossUp(300_00, 1399));
    const q = (await buyer.api.post('/v1/orders/quote', { offerId: offer.id })).body;
    expect(q.amountCents).toBe(grossUp(100_00, 500) + grossUp(300_00, 1399)); // 105.27 + 348.79, not 421.06 at the promo rate
    expect(q.amountCents).toBeGreaterThan(grossUp(400_00, 500));
    expect(q.amountCents).toBeLessThan(grossUp(400_00, 1399));
    // Round 29e (L): the listing shows that real price too, not the promo price
    const { refreshSellerRate } = await import('../src/domain/commission.js');
    await refreshSellerRate(h.ctx.db, seller.id);
    const shown = (await client(h.app).get(`/v1/offers/${offer.id}`)).body;
    expect(shown.price_cents).toBe(grossUp(100_00, 500) + grossUp(300_00, 1399));
    expect((await client(h.app).get(`/v1/offers?game=${encodeURIComponent(offer.game)}`)).body.items.find((x: any) => x.id === offer.id).price_cents).toBe(shown.price_cents);
    // an order created but not yet paid counts toward the remaining promo: the next quote and the listing price move at once
    const buyer2 = await makeUser(h, { tier: 1 });
    const unpaid = await buyer2.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true });
    expect(unpaid.status, JSON.stringify(unpaid.body)).toBe(201);
    expect((await grossUpForSeller(h.ctx.db, seller.id, 400_00))).toMatchObject({ amount: grossUp(400_00, 1399), rateBps: 1399, split: null }); // the $100 left went to the unpaid order
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.price_cents).toBe(grossUp(400_00, 1399));
    await buyer2.api.post(`/v1/orders/${unpaid.body.order.id}/cancel`);
    await refreshSellerRate(h.ctx.db, seller.id);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.price_cents).toBe(shown.price_cents); // cancelled: the promo slice is back
    // fully over the cap: the rank rate on everything
    await h.ctx.db.query(`UPDATE orders SET seller_net_cents = 1500_00 WHERE id = $1`, [o.id]);
    expect((await grossUpForSeller(h.ctx.db, seller.id, 400_00))).toMatchObject({ amount: grossUp(400_00, 1399), rateBps: 1399, split: null });
  });

  it('shows the public rank table, and the dashboard reports rank, rate and promo', async () => {
    const ranks = (await client(h.app).get('/v1/ranks')).body;
    expect(ranks.ranks.map((r: any) => r.name)).toEqual(['Hatchling', 'Scale', 'Fang', 'Basilisk', 'Dragon']);
    expect(ranks.settings).toEqual({ promoRateBps: 500, promoDays: 60, promoMaxSalesCents: 150_000 }); // CFO (5 Nov): promo capped at $1,500
    const seller = await makeUser(h, { tier: 2 });
    await makeOffer(seller);
    const dash = (await seller.api.get('/v1/seller/dashboard')).body;
    expect(dash).toMatchObject({ rateBps: 500, rank: { name: 'Hatchling', rateBps: 1399 }, next: { rank: { name: 'Scale' } } });
    expect(dash.promo.rateBps).toBe(500);
    expect(dash.tiers).toHaveLength(5);
  });

  it('lets an admin edit the rank table; listings re-price at once and the promo can be switched off', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const support = await makeUser(h, { role: 'support' });
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { priceCents: 100_00 });
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.price_cents).toBe(105_27);

    expect((await support.api.get('/v1/admin/ranks')).status).toBe(403);
    const current = (await admin.api.get('/v1/admin/ranks')).body.ranks;
    // Thresholds must rise and rates must not: a bad table is refused whole.
    const bad = current.map((r: any) => ({ ...r, minMonthlySalesCents: 0 }));
    expect((await admin.api.put('/v1/admin/ranks', { ranks: bad })).body.error.code).toBe('invalid_ranks');

    const edited = current.map((r: any) => (r.position === 1 ? { ...r, name: 'Egg', rateBps: 1500 } : r));
    const res = await admin.api.put('/v1/admin/ranks', { ranks: edited, settings: { promoDays: 0 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ranks[0]).toMatchObject({ name: 'Egg', rateBps: 1500 });
    expect(res.body.settings.promoDays).toBe(0);
    // No promo any more: the seller is on the (edited) first rank's rate, and the public price follows.
    expect((await seller.api.get('/v1/seller/price-preview?priceCents=10000')).body).toMatchObject({ rateBps: 1500, promo: null, rank: 'Egg', buyerCents: grossUp(100_00, 1500) });
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.price_cents).toBe(grossUp(100_00, 1500));
    expect((await client(h.app).get('/v1/tiers')).body[0]).toMatchObject({ name: 'Egg', rate: 15 });

    // Restore the defaults for the other tests.
    await admin.api.put('/v1/admin/ranks', { ranks: current, settings: { promoDays: 60 } });
  });
});
