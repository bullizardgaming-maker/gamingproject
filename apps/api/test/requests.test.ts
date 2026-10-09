import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, makeUser, setup, type Harness } from './helpers.js';
import { expireRequests } from '../src/domain/requests.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const sent = async (userId: string, template: string) =>
  (await h.ctx.db.query('SELECT data FROM notifications WHERE user_id = $1 AND template = $2 ORDER BY created_at', [userId, template])).rows.map((r) => r.data);

describe('buyer requests', () => {
  it('runs a request from post to proposal to a reserved listing bought in escrow', async () => {
    const game = `Request Game ${Date.now()}`;
    const buyer = await makeUser(h, { name: 'Wanting Buyer' });
    const sellerA = await makeUser(h, { tier: 2, name: 'Seller A' });
    const sellerB = await makeUser(h, { tier: 2, name: 'Seller B' });
    const stranger = await makeUser(h);
    // Seller A already lists in this game, so hears about new requests in it.
    expect((await sellerA.api.post('/v1/offers', { categorySlug: 'keys', game, title: 'Some key', priceCents: 5_00, deliveryMode: 'manual', stock: 2 })).status).toBe(201);

    expect((await (await makeUser(h, { tier: 0 })).api.post('/v1/requests', { game, categorySlug: 'keys', title: 'Need a rare key' })).status).toBe(403);
    const created = await buyer.api.post('/v1/requests', { game, categorySlug: 'keys', title: 'Need a rare key', description: 'Global region please', budgetCents: 30_00 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const req = created.body;
    expect(req).toMatchObject({ status: 'open', open: true, mine: true, budget_cents: 30_00, currency: 'USD', proposals: 0 });
    expect(await sent(sellerA.id, 'request_posted')).toEqual([expect.objectContaining({ request_id: req.id, game })]);
    expect(await sent(sellerB.id, 'request_posted')).toEqual([]);

    // The board is public.
    const board = await client(h.app).get(`/v1/requests?game=${encodeURIComponent(game)}`);
    expect(board.body.map((r: any) => r.id)).toEqual([req.id]);

    // Only verified sellers propose, and never on their own request.
    expect((await stranger.api.post(`/v1/requests/${req.id}/proposals`, { priceCents: 20_00, deliveryHours: 4 })).status).toBe(403);
    expect((await sellerA.api.post(`/v1/requests/${req.id}/proposals`, { priceCents: 28_00, deliveryHours: 12, message: 'Have it in stock' })).status).toBe(201);
    const b = await sellerB.api.post(`/v1/requests/${req.id}/proposals`, { priceCents: 26_00, deliveryHours: 2 });
    expect(b.body.proposal_list).toHaveLength(1); // a seller sees only their own proposal
    // Revising keeps one proposal per seller.
    await sellerB.api.post(`/v1/requests/${req.id}/proposals`, { priceCents: 25_00, deliveryHours: 2 });
    expect(await sent(buyer.id, 'request_proposal')).toHaveLength(3);
    expect((await sent(buyer.id, 'request_proposal'))[2]).toMatchObject({ revised: true, price_cents: 25_00, seller_name: 'Seller B' });

    const view = await buyer.api.get(`/v1/requests/${req.id}`);
    expect(view.body.proposals).toBe(2);
    expect(view.body.proposal_list.map((p: any) => [p.seller_name, p.price_cents])).toEqual([['Seller B', 25_00], ['Seller A', 28_00]]);
    expect((await client(h.app).get(`/v1/requests/${req.id}`)).body.proposal_list).toEqual([]);

    // Accepting turns the proposal into a listing only this buyer can see and buy.
    const pB = view.body.proposal_list[0];
    expect((await stranger.api.post(`/v1/requests/${req.id}/proposals/${pB.id}/accept`)).status).toBe(404);
    const acc = await buyer.api.post(`/v1/requests/${req.id}/proposals/${pB.id}/accept`);
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.request.status).toBe('accepted');
    expect(acc.body.request.proposal_list.map((p: any) => p.status)).toEqual(['accepted', 'declined']);
    expect(await sent(sellerB.id, 'request_accepted')).toHaveLength(1);
    const offerId = acc.body.offerId;

    const asBuyer = await buyer.api.get(`/v1/offers/${offerId}`);
    expect(asBuyer.body).toMatchObject({ price_cents: 25_00, delivery_mode: 'manual', stock: 1, reserved_for: buyer.id, delivery_hours: 2, game });
    expect((await stranger.api.get(`/v1/offers/${offerId}`)).status).toBe(404);
    expect((await client(h.app).get(`/v1/offers/${offerId}`)).status).toBe(404);
    expect((await sellerB.api.get(`/v1/offers/${offerId}`)).status).toBe(200);
    const search = await client(h.app).get(`/v1/offers?game=${encodeURIComponent(game)}`);
    expect(search.body.items.map((o: any) => o.id)).not.toContain(offerId);
    expect((await stranger.api.post('/v1/orders', { offerId, quantity: 1, acceptTos: true })).status).toBe(404);
    // The agreed price can't be changed afterwards.
    expect((await sellerB.api.patch(`/v1/offers/${offerId}`, { version: asBuyer.body.version, priceCents: 99_00 })).status).toBe(409);

    const order = await buyer.api.post('/v1/orders', { offerId, quantity: 1, acceptTos: true });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.order).toMatchObject({ seller_id: sellerB.id, amount_cents: 25_00, status: 'awaiting_payment' });

    // Closed requests take no more proposals.
    expect((await sellerA.api.post(`/v1/requests/${req.id}/proposals`, { priceCents: 1_00, deliveryHours: 1 })).status).toBe(409);
    expect((await client(h.app).get(`/v1/requests?game=${encodeURIComponent(game)}`)).body).toEqual([]);
    expect((await sellerA.api.get('/v1/requests/proposals/mine')).body[0]).toMatchObject({ request_id: req.id, status: 'declined' });
  });

  it('withdraws, closes and expires requests', async () => {
    const game = `Expiring Game ${Date.now()}`;
    const buyer = await makeUser(h);
    const seller = await makeUser(h, { tier: 2 });
    const r1 = (await buyer.api.post('/v1/requests', { game, categorySlug: 'keys', title: 'First request' })).body;
    const r2 = (await buyer.api.post('/v1/requests', { game, categorySlug: 'keys', title: 'Second request' })).body;

    await seller.api.post(`/v1/requests/${r1.id}/proposals`, { priceCents: 10_00, deliveryHours: 24 });
    expect((await seller.api.del(`/v1/requests/${r1.id}/proposals/mine`)).body.proposal_list[0].status).toBe('withdrawn');
    expect((await buyer.api.get(`/v1/requests/${r1.id}`)).body.proposal_list).toEqual([]);
    // A withdrawn proposal can be sent again.
    expect((await seller.api.post(`/v1/requests/${r1.id}/proposals`, { priceCents: 9_00, deliveryHours: 24 })).body.proposal_list[0].status).toBe('pending');

    expect((await buyer.api.post(`/v1/requests/${r1.id}/close`)).body.status).toBe('closed');
    expect((await seller.api.get(`/v1/requests/${r1.id}`)).body.proposal_list[0].status).toBe('declined');
    expect((await client(h.app).get(`/v1/requests/${r1.id}`)).status).toBe(404);

    await h.ctx.db.query(`UPDATE buyer_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r2.id]);
    expect(await expireRequests(h.ctx)).toBeGreaterThanOrEqual(1);
    expect((await buyer.api.get('/v1/requests/mine')).body.map((r: any) => r.status).sort()).toEqual(['closed', 'expired']);
  });

  it('checks the game fields given but lets buyers leave fields open', async () => {
    const buyer = await makeUser(h);
    const bad = await buyer.api.post('/v1/requests', { game: 'League of Legends', categorySlug: 'accounts', title: 'Smurf account', attributes: { server: 'Mars' } });
    expect(bad.status).toBe(400);
    const ok = await buyer.api.post('/v1/requests', { game: 'League of Legends', categorySlug: 'accounts', title: 'Smurf account', attributes: { server: 'euw' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.attributes).toEqual({ server: 'EUW' });
  });
});
