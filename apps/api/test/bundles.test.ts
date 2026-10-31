import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('bundles', () => {
  it('sells several instant listings as one, delivering from their stock', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const other = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const game = await makeOffer(seller, { title: 'Base game key', priceCents: 30_00 });
    const dlc = await makeOffer(seller, { title: 'DLC key', priceCents: 15_00 });
    const manual = await makeOffer(seller, { title: 'Manual thing', deliveryMode: 'manual', stock: 5 });
    const theirs = await makeOffer(other, { title: 'Not mine' });
    await seller.api.post(`/v1/offers/${game.id}/inventory`, { format: 'txt', content: 'G-1\nG-2\nG-3' });
    await seller.api.post(`/v1/offers/${dlc.id}/inventory`, { format: 'txt', content: 'D-1\nD-2\nD-3\nD-4\nD-5' });

    const base = { categorySlug: 'keys', game: 'Test Game', title: 'Complete edition', priceCents: 39_00, deliveryMode: 'auto' };
    expect((await seller.api.post('/v1/offers', { ...base, bundle: [{ offerId: game.id, quantity: 1 }] })).status).toBe(400); // one part
    expect((await seller.api.post('/v1/offers', { ...base, bundle: [{ offerId: game.id, quantity: 1 }, { offerId: theirs.id, quantity: 1 }] })).status).toBe(400);
    expect((await seller.api.post('/v1/offers', { ...base, bundle: [{ offerId: game.id, quantity: 1 }, { offerId: manual.id, quantity: 1 }] })).status).toBe(400);

    const b = await seller.api.post('/v1/offers', { ...base, bundle: [{ offerId: game.id, quantity: 1 }, { offerId: dlc.id, quantity: 2 }] });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body).toMatchObject({ is_bundle: true, stock: 2 }); // 3 games, 5 DLC keys / 2 per set
    expect(b.body.bundle.map((p: any) => [p.title, p.quantity, p.price_cents])).toEqual([['Base game key', 1, 30_00], ['DLC key', 2, 15_00]]);
    expect((await seller.api.post(`/v1/offers/${b.body.id}/inventory`, { format: 'txt', content: 'X' })).status).toBe(400);

    const order = await buyAndPay(h, buyer, b.body.id);
    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.status).toBe('delivered');
    const items = (await buyer.api.get(`/v1/orders/${order.id}/items`)).body;
    expect(items.map((i: any) => i.content).sort()).toEqual(['D-1', 'D-2', 'G-1']);

    // The parts' stock moved; the bundle's sets follow.
    expect((await client(h.app).get(`/v1/offers/${game.id}`)).body.stock).toBe(2);
    expect((await client(h.app).get(`/v1/offers/${dlc.id}`)).body.stock).toBe(3);
    expect((await client(h.app).get(`/v1/offers/${b.body.id}`)).body.stock).toBe(1);
    expect((await buyer.api.post('/v1/orders', { offerId: b.body.id, quantity: 2, acceptTos: true })).status).toBe(409);

    // A paused part makes the bundle unavailable.
    await seller.api.patch(`/v1/offers/${dlc.id}`, { version: (await client(h.app).get(`/v1/offers/${dlc.id}`)).body.version, status: 'paused' });
    expect((await client(h.app).get(`/v1/offers/${b.body.id}`)).body.stock).toBe(0);
  });
});
