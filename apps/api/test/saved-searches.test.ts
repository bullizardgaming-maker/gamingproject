import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, setup, type Harness } from './helpers.js';
import { sendDigests } from '../src/domain/savedSearches.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const digests = async (userId: string) =>
  (await h.ctx.db.query(`SELECT data FROM notifications WHERE user_id = $1 AND template = 'saved_search_digest' ORDER BY created_at`, [userId])).rows.map((r) => r.data);

describe('saved searches', () => {
  it('sends a digest of new matching listings once due, and nothing when there is nothing new', async () => {
    const game = `Digest Game ${Date.now()}`;
    const buyer = await makeUser(h);
    const seller = await makeUser(h, { tier: 2 });
    const before = (await seller.api.post('/v1/offers', { categorySlug: 'currency', game, title: 'Old gold', priceCents: 5_00, deliveryMode: 'manual', stock: 5 })).body;

    expect((await buyer.api.post('/v1/me/saved-searches', { name: 'Nothing', params: {} })).status).toBe(400);
    const s = await buyer.api.post('/v1/me/saved-searches', { name: 'Cheap gold', params: { game, category: 'currency', maxPriceCents: 20_00 }, frequency: 'hourly' });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.path).toContain('/market?');
    expect(s.body.path).toContain('maxPrice=2000');

    // Not due yet.
    expect(await sendDigests(h.ctx)).toBe(0);
    await h.ctx.db.query(`UPDATE saved_searches SET last_checked_at = now() - interval '2 hours' WHERE id = $1`, [s.body.id]);
    await h.ctx.db.query(`UPDATE offers SET created_at = now() - interval '3 hours' WHERE id = $1`, [before.id]);
    // Due, but only the old listing exists: nothing to send.
    expect(await sendDigests(h.ctx)).toBe(0);

    await seller.api.post('/v1/offers', { categorySlug: 'currency', game, title: 'New gold A', priceCents: 9_00, deliveryMode: 'manual', stock: 5 });
    await seller.api.post('/v1/offers', { categorySlug: 'currency', game, title: 'New gold B', priceCents: 7_00, deliveryMode: 'manual', stock: 5 });
    await seller.api.post('/v1/offers', { categorySlug: 'currency', game, title: 'Too pricey', priceCents: 50_00, deliveryMode: 'manual', stock: 5 });
    await h.ctx.db.query(`UPDATE saved_searches SET last_checked_at = now() - interval '61 minutes' WHERE id = $1`, [s.body.id]);
    expect(await sendDigests(h.ctx)).toBe(1);
    const [d] = await digests(buyer.id);
    expect(d).toMatchObject({ name: 'Cheap gold', count: 2 });
    expect(d.top.map((o: any) => o.title)).toEqual(['New gold B', 'New gold A']);
    // The same listings are never sent twice.
    await h.ctx.db.query(`UPDATE saved_searches SET last_checked_at = now() - interval '61 minutes' WHERE id = $1`, [s.body.id]);
    await h.ctx.db.query(`UPDATE offers SET created_at = now() - interval '2 hours' WHERE game = $1`, [game]);
    expect(await sendDigests(h.ctx)).toBe(0);

    expect((await buyer.api.patch(`/v1/me/saved-searches/${s.body.id}`, { frequency: 'daily' })).body.frequency).toBe('daily');
    expect((await buyer.api.get('/v1/me/saved-searches')).body).toHaveLength(1);
    expect((await buyer.api.del(`/v1/me/saved-searches/${s.body.id}`)).status).toBe(204);
    expect((await buyer.api.get('/v1/me/saved-searches')).body).toHaveLength(0);
  });
});
