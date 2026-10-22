import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, client, makeUser, setup, type Harness } from './helpers.js';
import { syncSales } from '../src/domain/discounts.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const listing = async (seller: Awaited<ReturnType<typeof makeUser>>, priceCents = 20_00) =>
  (await seller.api.post('/v1/offers', { categorySlug: 'currency', game: `Discount Game ${Date.now()}`, title: 'Gold pack', priceCents, deliveryMode: 'manual', stock: 100 })).body;

describe('seller-funded discounts', () => {
  it('runs a timed sale: buyers see and pay the sale price, search sorts by it, commission is on it', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await listing(seller);

    expect((await seller.api.put(`/v1/offers/${offer.id}/sale`, { salePriceCents: 25_00, endsAt: inDays(3) })).status).toBe(400); // not lower
    expect((await seller.api.put(`/v1/offers/${offer.id}/sale`, { salePriceCents: 15_00, endsAt: inDays(40) })).status).toBe(400); // too long
    expect((await buyer.api.put(`/v1/offers/${offer.id}/sale`, { salePriceCents: 15_00, endsAt: inDays(3) })).status).toBe(403);
    const sale = await seller.api.put(`/v1/offers/${offer.id}/sale`, { salePriceCents: 15_00, endsAt: inDays(3) });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    expect(sale.body).toMatchObject({ price_cents: 15_00, regular_price_cents: 20_00 });
    expect(sale.body.sale_ends_at).toBeTruthy();
    const found = (await client(h.app).get(`/v1/offers?game=${encodeURIComponent(offer.game)}`)).body.items[0];
    expect(found).toMatchObject({ price_cents: 15_00, price_settlement_cents: 15_00 });

    const order = await buyAndPay(h, buyer, offer.id, 2);
    const row = (await h.ctx.db.query('SELECT amount_cents, commission_cents, commission_bps FROM orders WHERE id = $1', [order.id])).rows[0];
    expect(Number(row.amount_cents)).toBe(30_00);
    expect(Number(row.commission_cents)).toBe(Math.round((30_00 * row.commission_bps) / 10_000));

    // The window closes: price and search go back.
    await h.ctx.db.query(`UPDATE offers SET sale_starts_at = now() - interval '2 days', sale_ends_at = now() - interval '1 minute' WHERE id = $1`, [offer.id]);
    await syncSales(h.ctx);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body).toMatchObject({ price_cents: 20_00, sale_ends_at: null });
    expect(Number((await h.ctx.db.query('SELECT price_settlement_cents FROM offers WHERE id = $1', [offer.id])).rows[0].price_settlement_cents)).toBe(20_00);

    // A sale scheduled for later doesn't apply yet; ending it clears it.
    await seller.api.put(`/v1/offers/${offer.id}/sale`, { salePriceCents: 10_00, startsAt: inDays(1), endsAt: inDays(2) });
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.price_cents).toBe(20_00);
    expect((await seller.api.del(`/v1/offers/${offer.id}/sale`)).body.price_cents).toBe(20_00);
  });

  it('applies a seller code to that seller’s listings only, within its limits', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const other = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const buyer2 = await makeUser(h);
    const offer = await listing(seller);
    const otherOffer = await listing(other);

    const c = await seller.api.post('/v1/seller/codes', { code: 'SPRING10', percentOff: 10, minOrderCents: 30_00, maxUses: 2 });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await seller.api.post('/v1/seller/codes', { code: 'spring10', percentOff: 5 })).status).toBe(409);

    const q = await buyer.api.post('/v1/orders/quote', { offerId: offer.id, quantity: 2, sellerCode: 'spring10' });
    expect(q.body).toMatchObject({ sellerDiscountCents: 4_00, amountCents: 36_00 });
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id, quantity: 1, sellerCode: 'SPRING10' })).body.error.code).toBe('code_min_order');
    expect((await buyer.api.post('/v1/orders/quote', { offerId: otherOffer.id, quantity: 2, sellerCode: 'SPRING10' })).body.error.code).toBe('code_invalid');

    const res = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 2, acceptTos: true, sellerCode: 'SPRING10' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.order).toMatchObject({ amount_cents: 36_00, seller_discount_cents: 4_00, seller_code_id: c.body.id });
    expect((await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 2, acceptTos: true, sellerCode: 'SPRING10' })).body.error.code).toBe('code_used');
    await buyer2.api.post('/v1/orders', { offerId: offer.id, quantity: 2, acceptTos: true, sellerCode: 'SPRING10' });
    expect((await (await makeUser(h)).api.post('/v1/orders', { offerId: offer.id, quantity: 2, acceptTos: true, sellerCode: 'SPRING10' })).body.error.code).toBe('code_exhausted');

    // Paid orders count as uses in the seller's list; switching it off stops it.
    await client(h.app).post(`/v1/payments/mock/checkout/${res.body.order.payment_ref}/pay`, {}, { accept: 'application/json' });
    expect((await seller.api.get('/v1/seller/codes')).body[0]).toMatchObject({ code: 'SPRING10', uses: 1 });
    await seller.api.patch(`/v1/seller/codes/${c.body.id}`, { active: false });
    expect((await (await makeUser(h)).api.post('/v1/orders/quote', { offerId: offer.id, quantity: 3, sellerCode: 'SPRING10' })).body.error.code).toBe('code_invalid');
  });
});
