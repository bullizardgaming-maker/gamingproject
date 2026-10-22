import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grossUp } from '../src/domain/commission.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

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
    expect(p.buyerIn).toEqual({ USD: 105_27, EUR: Math.round(105_27 * 0.92 * 1.01), EGP: Math.round(105_27 * 48.5 * 1.01) });
    // A EUR-priced listing is previewed from its settlement value.
    const eur = (await seller.api.get('/v1/seller/price-preview?priceCents=9200&currency=EUR')).body;
    expect(eur).toMatchObject({ listingCurrency: 'EUR', settlementCents: 100_00, buyerCents: 105_27 });
    // Small amounts pay the minimum withdrawal fee.
    expect((await seller.api.get('/v1/seller/price-preview?priceCents=1000')).body).toMatchObject({ withdrawalFeeCents: 1_50, afterWithdrawalCents: 8_50 });
  });

  it('shows the public rank table, and the dashboard reports rank, rate and promo', async () => {
    const ranks = (await client(h.app).get('/v1/ranks')).body;
    expect(ranks.ranks.map((r: any) => r.name)).toEqual(['Hatchling', 'Scale', 'Fang', 'Basilisk', 'Dragon']);
    expect(ranks.settings).toEqual({ promoRateBps: 500, promoDays: 60 });
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
