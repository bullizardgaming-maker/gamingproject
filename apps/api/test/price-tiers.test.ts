import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, makeUser, setup, type Harness } from './helpers.js';
import { unitPriceFor } from '../src/domain/offers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('quantity price tiers', () => {
  it('picks the best tier reached and never charges above the base price', () => {
    const offer = { price_cents: 500, price_tiers: [{ minQty: 10, priceCents: 450 }, { minQty: 50, priceCents: 400 }] };
    expect([1, 9, 10, 49, 50, 500].map((q) => unitPriceFor(offer, q))).toEqual([500, 500, 450, 450, 400, 400]);
    // A later base-price cut below a tier wins over the tier.
    expect(unitPriceFor({ ...offer, price_cents: 420 }, 10)).toBe(420);
  });

  it('validates tiers and charges orders the tier price', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const base = { categorySlug: 'currency', game: 'Tier Game', title: '1k Gold', priceCents: 5_00, deliveryMode: 'manual', stock: 500 };
    const bad = [
      [{ minQty: 1, priceCents: 4_00 }],
      [{ minQty: 10, priceCents: 5_00 }],
      [{ minQty: 10, priceCents: 4_00 }, { minQty: 20, priceCents: 4_50 }],
      [{ minQty: 10, priceCents: 4_00 }, { minQty: 10, priceCents: 3_00 }],
    ];
    for (const priceTiers of bad) expect((await seller.api.post('/v1/offers', { ...base, priceTiers })).status, JSON.stringify(priceTiers)).toBe(400);
    expect((await seller.api.post('/v1/offers', { ...base, categorySlug: 'accounts', deliveryMode: 'manual', priceTiers: [{ minQty: 2, priceCents: 1_00 }] })).status).toBe(400);

    const created = await seller.api.post('/v1/offers', { ...base, priceTiers: [{ minQty: 50, priceCents: 4_00 }, { minQty: 10, priceCents: 4_50 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.seller_price_tiers).toEqual([{ minQty: 10, priceCents: 4_50 }, { minQty: 50, priceCents: 4_00 }]);
    // Buyers see each tier grossed up by the seller's 5% launch-promo commission.
    expect(created.body.price_tiers).toEqual([{ minQty: 10, priceCents: 4_74 }, { minQty: 50, priceCents: 4_22 }]);

    const quote = await buyer.api.post('/v1/orders/quote', { offerId: created.body.id, quantity: 20 });
    expect(quote.body).toMatchObject({ unitPriceCents: 4_74, listingUnitPriceCents: 4_50, sellerAmountCents: 90_00, amountCents: 94_74 });
    expect((await buyer.api.post('/v1/orders/quote', { offerId: created.body.id, quantity: 3 })).body.amountCents).toBe(15_79);

    const order = await buyAndPay(h, buyer, created.body.id, 60);
    expect(order.amount_cents).toBe(252_64);
    const row = (await h.ctx.db.query('SELECT unit_price_cents, listing_unit_price_cents FROM orders WHERE id = $1', [order.id])).rows[0];
    expect(row).toMatchObject({ unit_price_cents: 4_21, listing_unit_price_cents: 4_00 });

    // Edit: replace and remove tiers; a new base price is checked against the tiers sent with it.
    const v = (await seller.api.get(`/v1/offers/${created.body.id}`)).body.version;
    expect((await seller.api.patch(`/v1/offers/${created.body.id}`, { version: v, priceCents: 4_00, priceTiers: [{ minQty: 10, priceCents: 4_50 }] })).status).toBe(400);
    const edited = await seller.api.patch(`/v1/offers/${created.body.id}`, { version: v, priceTiers: [{ minQty: 5, priceCents: 4_80 }] });
    expect(edited.body.seller_price_tiers).toEqual([{ minQty: 5, priceCents: 4_80 }]);
    const cleared = await seller.api.patch(`/v1/offers/${created.body.id}`, { version: edited.body.version, priceTiers: [] });
    expect(cleared.body.price_tiers).toEqual([]);
    expect(cleared.body.seller_price_tiers).toEqual([]);
  });
});
