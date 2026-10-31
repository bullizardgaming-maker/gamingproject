import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { snapshotMarketPrices } from '../src/domain/priceHistory.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('price history', () => {
  it('records each price change and sale, and keeps daily market lows and medians', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { title: 'History key', priceCents: 20_00, deliveryMode: 'manual', stock: 5 });
    const v = () => client(h.app).get(`/v1/offers/${offer.id}`).then((r) => r.body.version);
    await seller.api.patch(`/v1/offers/${offer.id}`, { version: await v(), priceCents: 18_00 });
    await seller.api.patch(`/v1/offers/${offer.id}`, { version: await v(), title: 'History key, renamed' }); // not a price change
    await seller.api.put(`/v1/offers/${offer.id}/sale`, { salePriceCents: 15_00, endsAt: new Date(Date.now() + 86_400_000).toISOString() });

    const hist = (await client(h.app).get(`/v1/offers/${offer.id}/price-history?days=30`)).body;
    expect(hist.currency).toBe('USD');
    expect(hist.points.map((p: any) => p.price_cents)).toEqual([20_00, 18_00, 15_00]);
    expect((await client(h.app).get(`/v1/offers/${offer.id}/price-history?days=3`)).status).toBe(400);

    await seller.api.del(`/v1/offers/${offer.id}/sale`);
    expect((await client(h.app).get(`/v1/offers/${offer.id}/price-history`)).body.points.at(-1).price_cents).toBe(18_00);

    // Market: lowest and median live price for the game and category, today.
    await makeOffer(seller, { title: 'Second key', priceCents: 10_00, deliveryMode: 'manual', stock: 1 });
    await makeOffer(seller, { title: 'Third key', priceCents: 30_00, deliveryMode: 'manual', stock: 1 });
    await makeOffer(seller, { title: 'Sold out', priceCents: 1_00, deliveryMode: 'manual', stock: 0 }).catch(() => null);
    await snapshotMarketPrices(h.ctx);
    const market = (await client(h.app).get('/v1/catalog/price-history?game=test%20game&category=keys')).body;
    const today = market.points.at(-1);
    expect(today).toMatchObject({ min_cents: 10_00 });
    expect(today.listings).toBeGreaterThanOrEqual(3);
    // Re-running the same day updates the row instead of adding one.
    await snapshotMarketPrices(h.ctx);
    expect((await client(h.app).get('/v1/catalog/price-history?game=Test%20Game&category=keys')).body.points).toHaveLength(market.points.length);
  });

  it('keeps private listings private', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const stranger = await makeUser(h);
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 1 });
    await h.ctx.db.query('UPDATE offers SET reserved_for = $2 WHERE id = $1', [offer.id, seller.id]);
    expect((await stranger.api.get(`/v1/offers/${offer.id}/price-history`)).status).toBe(404);
    expect((await stranger.api.get(`/v1/offers/${offer.id}/also-bought`)).status).toBe(404);
    expect((await seller.api.get(`/v1/offers/${offer.id}/price-history`)).status).toBe(200);
  });
});

describe('buyers also bought', () => {
  it('shows co-purchases made by at least two buyers, then fills with the same game', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const other = { categorySlug: 'items', game: 'Other Game', priceCents: 5_00, deliveryMode: 'manual', stock: 50 };
    const main = await makeOffer(seller, { title: 'Main', deliveryMode: 'manual', stock: 50 });
    const pair = (await seller.api.post('/v1/offers', { ...other, title: 'Bought together' })).body;
    const once = (await seller.api.post('/v1/offers', { ...other, title: 'Bought by one buyer' })).body;
    const sameGame = await makeOffer(seller, { title: 'Same game', deliveryMode: 'manual', stock: 5 });

    for (let i = 0; i < 2; i++) {
      const b = await makeUser(h);
      await buyAndPay(h, b, main.id);
      await buyAndPay(h, b, pair.id);
      if (i === 0) await buyAndPay(h, b, once.id);
    }
    const res = (await client(h.app).get(`/v1/offers/${main.id}/also-bought`)).body.items;
    expect(res[0]).toMatchObject({ id: pair.id, reason: 'also_bought' });
    expect(res.some((o: any) => o.id === once.id)).toBe(false); // one buyer's purchase never shows
    expect(res.some((o: any) => o.id === main.id)).toBe(false);
    expect(res.find((o: any) => o.id === sameGame.id)).toMatchObject({ reason: 'same_game' });
  });
});
