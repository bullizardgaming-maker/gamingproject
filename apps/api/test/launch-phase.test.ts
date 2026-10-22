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
    expect(found).toContain('Phase gold');
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

  it('badges Founding Sellers and gives them free featured spots that lead search while the launch runs', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const founder = await makeUser(h, { tier: 2 });
    const a = await makeOffer(founder, { categorySlug: 'currency', game: 'Founding Game', title: 'Founder gold A', deliveryMode: 'manual', stock: 5 } as any);
    const b = await makeOffer(founder, { categorySlug: 'currency', game: 'Founding Game', title: 'Founder gold B', deliveryMode: 'manual', stock: 5 } as any);
    const c = await makeOffer(founder, { categorySlug: 'currency', game: 'Founding Game', title: 'Founder gold C', deliveryMode: 'manual', stock: 5 } as any);
    const later = await makeUser(h, { tier: 2 });
    const newest = await makeOffer(later, { categorySlug: 'currency', game: 'Founding Game', title: 'Latecomer gold', deliveryMode: 'manual', stock: 5 } as any);

    expect((await client(h.app).get(`/v1/offers/${a.id}`)).body).toMatchObject({ seller_founding: true, featured: false });
    const dash = (await founder.api.get('/v1/seller/dashboard')).body.founding;
    expect(dash).toMatchObject({ founding: true, windowOpen: true, featuredSlots: 2, featuredUsed: 0, featuredDays: 7 });
    expect((await client(h.app).get(`/v1/sellers/${founder.id}`)).body.founding).toBe(true);

    // Two free spots; the third needs one freed. Featured listings come first regardless of age.
    expect((await founder.api.post(`/v1/offers/${a.id}/feature`)).body).toMatchObject({ featuredUsed: 1 });
    expect((await founder.api.post(`/v1/offers/${b.id}/feature`)).body).toMatchObject({ featuredUsed: 2 });
    expect((await founder.api.post(`/v1/offers/${c.id}/feature`)).body.error.code).toBe('no_slots');
    const titles = (await client(h.app).get('/v1/offers?game=Founding%20Game&sort=newest')).body.items.map((o: any) => o.title);
    expect(titles.slice(0, 2).sort()).toEqual(['Founder gold A', 'Founder gold B']);
    expect(titles[2]).toBe('Latecomer gold');
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
