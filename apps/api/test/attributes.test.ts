import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, makeUser, setup, type Harness } from './helpers.js';
import { cleanAttributes } from '../src/domain/attributeSets.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('game-specific listing fields', () => {
  it('validates against the game set, falls back to the category default and normalises case', () => {
    expect(cleanAttributes('League of Legends', 'boosting', { server: 'euw', rank_from: 'gold' })).toEqual({ ok: true, value: { server: 'EUW', rank_from: 'Gold' } });
    expect(cleanAttributes('League of Legends', 'boosting', {})).toMatchObject({ ok: false, error: expect.stringContaining('Server is required') });
    expect(cleanAttributes('League of Legends', 'boosting', { server: 'Mars' })).toMatchObject({ ok: false, error: expect.stringContaining('one of') });
    expect(cleanAttributes('League of Legends', 'boosting', { server: 'EUW', colour: 'red' })).toMatchObject({ ok: false });
    // Unknown game: the category default applies and nothing is required.
    expect(cleanAttributes('Some Indie Game', 'keys', { platform: 'steam', region: '' })).toEqual({ ok: true, value: { platform: 'Steam' } });
    expect(cleanAttributes('Some Indie Game', 'keys', undefined)).toEqual({ ok: true, value: {} });
  });

  it('stores fields on create and update, and filters the market by them with per-value counts', async () => {
    const s = await makeUser(h, { tier: 2 });
    const mk = async (title: string, attributes: Record<string, string>, priceCents = 20_00) => {
      const res = await s.api.post('/v1/offers', { categorySlug: 'boosting', game: 'League of Legends', title, priceCents, deliveryMode: 'manual', stock: 3, attributes });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body;
    };
    const missing = await s.api.post('/v1/offers', { categorySlug: 'boosting', game: 'League of Legends', title: 'No server', priceCents: 10_00, deliveryMode: 'manual' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('invalid_attributes');

    const a = await mk('EUW Gold to Plat', { server: 'EUW', rank_from: 'Gold', rank_to: 'Platinum' });
    expect(a.attributes).toEqual({ server: 'EUW', rank_from: 'Gold', rank_to: 'Platinum' });
    await mk('EUW Silver to Gold', { server: 'EUW', rank_from: 'Silver', rank_to: 'Gold' });
    const c = await mk('NA Gold to Plat', { server: 'NA', rank_from: 'Gold', rank_to: 'Platinum' });

    const anon = client(h.app);
    const euw = await anon.get('/v1/offers?game=League%20of%20Legends&attr.server=euw');
    expect(euw.status).toBe(200);
    expect(euw.body.items.map((o: any) => o.title).sort()).toEqual(['EUW Gold to Plat', 'EUW Silver to Gold']);

    const both = await anon.get('/v1/offers?game=League%20of%20Legends&category=boosting&attr.server=EUW&attr.rank_from=Gold');
    expect(both.body.items.map((o: any) => o.title)).toEqual(['EUW Gold to Plat']);
    const facet = (key: string) => Object.fromEntries(both.body.facets.attributes.filter((f: any) => f.key === key).map((f: any) => [f.value, f.count]));
    // Server counts ignore the server filter but keep rank_from=Gold; rank counts keep server=EUW.
    expect(facet('server')).toEqual({ EUW: 1, NA: 1 });
    expect(facet('rank_from')).toEqual({ Gold: 1, Silver: 1 });
    expect(facet('rank_to')).toEqual({ Platinum: 1 });

    expect((await anon.get('/v1/offers?attr.Server=EUW')).status).toBe(400);
    expect((await anon.get('/v1/offers?attr.server=')).status).toBe(400);
    // No game chosen: no per-field counts.
    expect((await anon.get('/v1/offers?attr.server=EUW')).body.facets.attributes).toEqual([]);

    const upd = await s.api.patch(`/v1/offers/${c.id}`, { version: c.version, attributes: { server: 'EUW', rank_from: 'Gold' } });
    expect(upd.status).toBe(200);
    expect(upd.body.attributes).toEqual({ server: 'EUW', rank_from: 'Gold' });
    const bad = await s.api.patch(`/v1/offers/${c.id}`, { version: upd.body.version, attributes: { server: 'Moon' } });
    expect(bad.status).toBe(400);
    expect((await anon.get('/v1/offers?game=League%20of%20Legends&attr.server=EUW')).body.total).toBe(3);
  });

  it('serves the definitions for the sell form', async () => {
    const one = await client(h.app).get('/v1/catalog/attributes?game=valorant&category=accounts');
    expect(one.body.fields.map((f: any) => f.key)).toEqual(['region', 'rank']);
    const all = await client(h.app).get('/v1/catalog/attributes');
    expect(all.body.defaults.keys.map((f: any) => f.key)).toEqual(['platform', 'region']);
    expect(Object.keys(all.body.games)).toContain('world of warcraft');
  });
});
