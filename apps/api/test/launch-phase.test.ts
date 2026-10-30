import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('launch phases', () => {
  it('hides closed categories from buyers and refuses new listings in them until staff open the phase', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const seller = await makeUser(h, { tier: 2 });
    const key = await makeOffer(seller, { title: 'Phase key', deliveryMode: 'manual', stock: 1 } as any); // keys: phase 3 (tests run at phase 3)
    const gold = await makeOffer(seller, { categorySlug: 'currency', game: 'Phase Game', title: 'Phase gold', deliveryMode: 'manual', stock: 5 } as any);

    expect((await admin.api.put('/v1/admin/launch', { phase: 1 })).body).toMatchObject({ phase: 1 });
    const cats = (await client(h.app).get('/v1/categories')).body;
    expect(cats.filter((c: any) => c.open).map((c: any) => c.slug).sort()).toEqual(['currency', 'items', 'top-ups']);
    expect(cats.find((c: any) => c.slug === 'accounts')).toMatchObject({ open: false, phase: 2, current_phase: 1 });

    // Search and the game directory leave the key out; its page is gone for buyers, not for its seller.
    const found = (await client(h.app).get('/v1/offers?q=Phase')).body.items.map((o: any) => o.title);
    expect(found).toContain(gold.title); // Round 26: currency titles are built by the API (game · server)
    expect(found).not.toContain('Phase key');
    expect((await client(h.app).get(`/v1/offers/${key.id}`)).status).toBe(404);
    expect((await seller.api.get(`/v1/offers/${key.id}`)).status).toBe(200);
    expect((await client(h.app).get(`/v1/offers/${gold.id}`)).status).toBe(200);
    expect((await client(h.app).get('/v1/catalog/games')).body.find((g: any) => g.game === 'Test Game')).toBeUndefined();

    expect((await seller.api.post('/v1/offers', { categorySlug: 'accounts', game: 'Phase Game', title: 'Main account', priceCents: 50_00, deliveryMode: 'manual' })).body.error.code).toBe('category_not_open');
    expect((await seller.api.post('/v1/offers', { categorySlug: 'items', game: 'Phase Game', title: 'A sword', priceCents: 5_00, deliveryMode: 'manual', stock: 1 })).status).toBe(201);

    // Phase 2 opens accounts and boosting; phase 3 everything.
    await admin.api.put('/v1/admin/launch', { phase: 2 });
    expect((await client(h.app).get('/v1/categories')).body.filter((c: any) => c.open).map((c: any) => c.slug).sort()).toEqual(['accounts', 'boosting', 'currency', 'items', 'top-ups']);
    expect((await seller.api.post('/v1/offers', { categorySlug: 'accounts', game: 'Phase Game', title: 'Main account', priceCents: 50_00, deliveryMode: 'manual' })).status).toBe(201);
    expect((await client(h.app).get(`/v1/offers/${key.id}`)).status).toBe(404);
    await admin.api.put('/v1/admin/launch', { phase: 3 });
    expect((await client(h.app).get(`/v1/offers/${key.id}`)).status).toBe(200);
    expect((await admin.api.put('/v1/admin/launch', { phase: 4 })).status).toBe(400);
  });

  it('refuses listings in games outside the launch list until staff add them (null opens every game)', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const seller = await makeUser(h, { tier: 2 });
    expect((await admin.api.put('/v1/admin/launch', { allowedGames: ['Aion', 'Listed Game'] })).body.allowedGames).toEqual(['Aion', 'Listed Game']);
    expect((await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Phase Game', title: 'Gold', priceCents: 5_00, deliveryMode: 'manual', stock: 1 })).body.error.code).toBe('game_not_open');
    expect((await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'listed game', title: 'Silver', priceCents: 5_00, deliveryMode: 'manual', stock: 1 })).status).toBe(201);
    await admin.api.put('/v1/admin/launch', { allowedGames: null });
    expect((await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Phase Game', title: 'Gold', priceCents: 5_00, deliveryMode: 'manual', stock: 1 })).status).toBe(201);
  });

  it('badges Founding Sellers and gives them free featured spots that lead search while the launch runs', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const founder = await makeUser(h, { tier: 2 });
    const a = await makeOffer(founder, { categorySlug: 'currency', game: 'Founding Game', title: 'Founder gold A', deliveryMode: 'manual', stock: 5 } as any);
    const b = await makeOffer(founder, { categorySlug: 'currency', game: 'Founding Game', title: 'Founder gold B', deliveryMode: 'manual', stock: 5 } as any);
    const c = await makeOffer(founder, { categorySlug: 'currency', game: 'Founding Game', title: 'Founder gold C', deliveryMode: 'manual', stock: 5 } as any);
    const later = await makeUser(h, { tier: 2 });
    const newest = await makeOffer(later, { categorySlug: 'currency', game: 'Founding Game', title: 'Latecomer gold', deliveryMode: 'manual', stock: 5 } as any);

    expect((await client(h.app).get(`/v1/offers/${a.id}`)).body).toMatchObject({ seller_founding: true });
    expect((await client(h.app).get(`/v1/offers/${a.id}`)).body).not.toHaveProperty('featured'); // Round 25: featured shows on the shop only
    const dash = (await founder.api.get('/v1/seller/dashboard')).body.founding;
    expect(dash).toMatchObject({ founding: true, windowOpen: true, featuredSlots: 2, featuredUsed: 0, featuredDays: 7 });
    expect((await client(h.app).get(`/v1/sellers/${founder.id}`)).body.founding).toBe(true);

    // Two free spots; the third needs one freed. Round 25 (CEO): featured listings come first on the seller's own shop
    // only; the market keeps its order with no boost.
    expect((await founder.api.post(`/v1/offers/${a.id}/feature`)).body).toMatchObject({ featuredUsed: 1 });
    expect((await founder.api.post(`/v1/offers/${b.id}/feature`)).body).toMatchObject({ featuredUsed: 2 });
    expect((await founder.api.post(`/v1/offers/${c.id}/feature`)).body.error.code).toBe('no_slots');
    const titles = (await client(h.app).get('/v1/offers?game=Founding%20Game&sort=newest')).body.items.map((o: any) => o.title);
    expect(titles[0]).toBe(newest.title); // Round 26: currency titles come from the API
    const shop = (await client(h.app).get(`/v1/offers?seller=${founder.id}&sort=newest`)).body.items;
    expect(shop.slice(0, 2).map((o: any) => o.id).sort()).toEqual([a.id, b.id].sort());
    expect(shop.map((o: any) => o.featured)).toEqual([true, true, false]);
    expect((await founder.api.del(`/v1/offers/${a.id}/feature`)).body).toMatchObject({ featuredUsed: 1 });
    expect((await founder.api.post(`/v1/offers/${c.id}/feature`)).status).toBe(200);

    // The launch window closes: new sellers are not founding, and free spots stop.
    await admin.api.put('/v1/admin/launch', { foundingUntil: new Date(Date.now() - 60_000).toISOString() });
    const afterwards = await makeUser(h, { tier: 2 });
    const o = await makeOffer(afterwards, { categorySlug: 'currency', game: 'Founding Game', title: 'After gold', deliveryMode: 'manual', stock: 5 } as any);
    expect((await client(h.app).get(`/v1/offers/${o.id}`)).body.seller_founding).toBe(false);
    expect((await afterwards.api.post(`/v1/offers/${o.id}/feature`)).body.error.code).toBe('not_founding');
    expect((await client(h.app).get(`/v1/offers/${newest.id}`)).body.seller_founding).toBe(true); // joined in time: badge for good
    expect((await founder.api.post(`/v1/offers/${b.id}/feature`)).body.error.code).toBe('promo_over');
    expect((await founder.api.get('/v1/seller/dashboard')).body.founding).toMatchObject({ founding: true, windowOpen: false, featuredSlots: 0 });
    await admin.api.put('/v1/admin/launch', { foundingUntil: new Date(Date.now() + 86_400_000).toISOString() });
  });
});
