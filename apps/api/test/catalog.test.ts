import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('game directory', () => {
  it('lists games with live stock, per-category counts and the lowest price', async () => {
    const s = await makeUser(h, { tier: 2 });
    const game = `Directory Quest ${Date.now()}`;
    const make = async (body: object) => {
      const res = await s.api.post('/v1/offers', { game, deliveryMode: 'manual', stock: 3, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body;
    };
    await make({ categorySlug: 'currency', title: '10k gold', priceCents: 5_00 });
    await make({ categorySlug: 'currency', title: '50k gold', priceCents: 20_00 });
    await make({ categorySlug: 'boosting', title: 'Rank boost', priceCents: 40_00 });
    const key = await s.api.post('/v1/offers', { game, categorySlug: 'keys', title: 'Empty key listing', priceCents: 50, deliveryMode: 'auto' });
    expect(key.status).toBe(201); // auto-delivery with no codes uploaded: not in stock

    const res = await client(h.app).get('/v1/catalog/games');
    expect(res.status).toBe(200);
    const row = res.body.find((g: any) => g.game === game);
    expect(row).toMatchObject({ offers: 3, sellers: 1, min_price_cents: 5_27, instant: 0 }); // 5.00 grossed up by the 5% launch-promo commission
    expect(row.categories).toEqual([{ slug: 'currency', count: 2 }, { slug: 'boosting', count: 1 }]);
  });
});
