import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, setup, type Harness } from './helpers.js';
import { checkWatches } from '../src/domain/watches.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const sent = async (userId: string, template: string) =>
  (await h.ctx.db.query('SELECT data FROM notifications WHERE user_id = $1 AND template = $2 ORDER BY created_at', [userId, template])).rows.map((r) => r.data);

describe('watchlists and price alerts', () => {
  it('alerts once per new low on a watched listing, and on restock', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const make = await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Watch Quest', title: '10k gold', priceCents: 20_00, deliveryMode: 'manual', stock: 2 });
    let offer = make.body;

    expect((await seller.api.post('/v1/me/watches', { offerId: offer.id })).status).toBe(400); // own listing
    const w = await buyer.api.post('/v1/me/watches', { offerId: offer.id, targetCents: 15_00 });
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ kind: 'offer', targetCents: 15_00, currentCents: 20_00, startCents: 20_00, available: true, reached: false });
    expect((await buyer.api.post('/v1/me/watches', { offerId: offer.id })).status).toBe(409);

    const price = async (cents: number) => (offer = (await seller.api.patch(`/v1/offers/${offer.id}`, { version: offer.version, priceCents: cents })).body);
    await price(16_00);
    await checkWatches(h.ctx);
    expect(await sent(buyer.id, 'watch_price_drop')).toHaveLength(0); // above target

    await price(14_00);
    await checkWatches(h.ctx);
    await checkWatches(h.ctx);
    expect(await sent(buyer.id, 'watch_price_drop')).toEqual([expect.objectContaining({ price_cents: 14_00, target_cents: 15_00, offer_id: offer.id })]);

    await price(14_50); // up a little: no alert
    await checkWatches(h.ctx);
    await price(12_00); // new low: alert again
    await checkWatches(h.ctx);
    expect((await sent(buyer.id, 'watch_price_drop')).map((d) => d.price_cents)).toEqual([14_00, 12_00]);

    // Sold out, then restocked.
    offer = (await seller.api.patch(`/v1/offers/${offer.id}`, { version: offer.version, stock: 0 })).body;
    await checkWatches(h.ctx);
    expect((await buyer.api.get('/v1/me/watches')).body[0]).toMatchObject({ available: false, reached: false });
    offer = (await seller.api.patch(`/v1/offers/${offer.id}`, { version: offer.version, stock: 5 })).body;
    await checkWatches(h.ctx);
    expect(await sent(buyer.id, 'watch_back_in_stock')).toHaveLength(1);
    const inbox = (await buyer.api.get('/v1/me/notifications')).body;
    expect(JSON.stringify(inbox)).toContain('Back in stock');

    // A new target re-arms the alert; then the watch can be removed.
    const upd = await buyer.api.patch(`/v1/me/watches/${w.body.id}`, { targetCents: 13_00 });
    expect(upd.body).toMatchObject({ targetCents: 13_00, reached: true });
    expect((await buyer.api.del(`/v1/me/watches/${w.body.id}`)).status).toBe(204);
    expect((await buyer.api.get('/v1/me/watches')).body).toEqual([]);
  });

  it('without a target, alerts on any drop below the starting price', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    let offer = (await seller.api.post('/v1/offers', { categorySlug: 'items', game: 'Watch Quest', title: 'Sword', priceCents: 9_00, deliveryMode: 'manual', stock: 1 })).body;
    await buyer.api.post('/v1/me/watches', { offerId: offer.id });
    await checkWatches(h.ctx);
    expect(await sent(buyer.id, 'watch_price_drop')).toHaveLength(0);
    offer = (await seller.api.patch(`/v1/offers/${offer.id}`, { version: offer.version, priceCents: 8_99 })).body;
    await checkWatches(h.ctx);
    expect(await sent(buyer.id, 'watch_price_drop')).toEqual([expect.objectContaining({ price_cents: 8_99, target_cents: null })]);
  });

  it('watches a slice of a game market by category and game-specific fields', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const list = (server: string, priceCents: number) =>
      seller.api.post('/v1/offers', { categorySlug: 'boosting', game: 'League of Legends', title: `${server} boost ${priceCents}`, priceCents, deliveryMode: 'manual', stock: 1, attributes: { server } });

    expect((await buyer.api.post('/v1/me/watches', { game: 'League of Legends', category: 'boosting', attributes: { server: 'Mars' } })).status).toBe(400);
    expect((await buyer.api.post('/v1/me/watches', { game: 'League of Legends', attributes: { server: 'EUW' } })).status).toBe(400);
    const w = await buyer.api.post('/v1/me/watches', { game: 'league of legends', category: 'boosting', attributes: { server: 'euw' }, targetCents: 15_00 });
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ kind: 'game', category: 'boosting', attributes: { server: 'EUW' }, available: false, currentCents: null });

    await list('EUW', 20_00);
    await list('NA', 10_00);
    await checkWatches(h.ctx);
    expect(await sent(buyer.id, 'watch_game_low')).toHaveLength(0);

    const hit = await list('EUW', 14_00);
    await checkWatches(h.ctx);
    expect(await sent(buyer.id, 'watch_game_low')).toEqual([expect.objectContaining({ offer_id: hit.body.id, price_cents: 14_00, game: 'League of Legends' })]);
    expect((await buyer.api.get('/v1/me/watches')).body[0]).toMatchObject({ reached: true, currentCents: 14_00, cheapest: { id: hit.body.id } });

    // A game with nothing listed and no target: the first listing is announced.
    await buyer.api.post('/v1/me/watches', { game: 'Brand New Game' });
    await checkWatches(h.ctx);
    expect(await sent(buyer.id, 'watch_game_low')).toHaveLength(1);
    await seller.api.post('/v1/offers', { categorySlug: 'keys', game: 'Brand New Game', title: 'Launch key', priceCents: 30_00, deliveryMode: 'manual', stock: 1 });
    await checkWatches(h.ctx);
    expect((await sent(buyer.id, 'watch_game_low')).map((d) => d.game)).toEqual(['League of Legends', 'Brand New Game']);
  });

  it('shows targets and prices in the buyer’s currency', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = (await seller.api.post('/v1/offers', { categorySlug: 'items', game: 'Watch Quest', title: 'Shield', priceCents: 10_00, deliveryMode: 'manual', stock: 1 })).body;
    const w = await buyer.api.post('/v1/me/watches', { offerId: offer.id, targetCents: 5_00, currency: 'eur' });
    expect(w.body.currency).toBe('EUR');
    expect(w.body.currentCents).not.toBe(10_00);
    expect((await buyer.api.post('/v1/me/watches', { offerId: offer.id, currency: 'XXX' })).status).toBe(400);
  });
});
