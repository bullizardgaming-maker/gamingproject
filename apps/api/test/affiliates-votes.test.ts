import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sellerAvailable } from '../src/domain/ledger.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('creator affiliate codes', () => {
  it('pays the creator a share of the commission on every order by a buyer who used their code', async () => {
    const finance = await makeUser(h, { role: 'finance' });
    const creator = await makeUser(h, { tier: 1 });
    const made = await finance.api.post('/v1/admin/affiliates', { userId: creator.id, code: 'streamer-x', rateBps: 2000, note: 'Twitch, 40k followers' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ code: 'STREAMER-X', rate_bps: 2000, status: 'active' });
    expect((await finance.api.post('/v1/admin/affiliates', { userId: creator.id, code: 'STREAMER-X', rateBps: 100 })).body.error.code).toBe('code_taken');

    // A buyer signs up with the code (one `code` field: invite or creator). Nothing attaches a code later (CEO, Oct 24).
    const reg = await client(h.app).post('/v1/auth/register', { email: `fan_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Fan', acceptTerms: true, code: 'streamer-x' });
    expect(reg.status).toBe(201);
    expect(reg.body.codeApplied).toBe('creator');
    const fan = { id: reg.body.user.id, api: client(h.app, reg.body.token) };
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1`, [fan.id]);
    expect((await fan.api.post('/v1/me/affiliate', { code: 'STREAMER-X' })).status).toBe(410);
    expect((await (await makeUser(h)).api.post('/v1/me/affiliate', { code: 'NOPE-1' })).status).toBe(410);
    // Two different codes at sign-up are refused; the creator's own code is ignored.
    expect((await client(h.app).post('/v1/auth/register', { email: `two_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Two', acceptTerms: true, code: 'streamer-x', referralCode: 'OTHER1' })).body.error.code).toBe('one_code_only');
    // The share is capped at half the commission.
    expect((await finance.api.patch(`/v1/admin/affiliates/${made.body.id}`, { rateBps: 6000 })).status).toBe(400);

    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { priceCents: 100_00 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'K-1\nK-2' });
    const order = await buyAndPay(h, fan, offer.id);
    await fan.api.post(`/v1/orders/${order.id}/confirm`);
    // 100.00 grossed up by 5% = 5.27 commission; the creator's 20% share is 1.05, paid from the treasury.
    expect(await sellerAvailable(h.ctx.db, creator.id)).toBe(105);
    const mine = (await creator.api.get('/v1/me/affiliate')).body;
    expect(mine).toMatchObject({ code: 'STREAMER-X', buyers: 1, orders: 1, earned_cents: 105 });
    expect(mine.recent[0]).toMatchObject({ order_id: order.id, commission_cents: 527, earned_cents: 105 });
    expect((await finance.api.get('/v1/admin/affiliates')).body.find((a: any) => a.code === 'STREAMER-X')).toMatchObject({ buyers: 1, earned_cents: 105 });

    // Paused: later orders pay nothing. Someone without a code sees null.
    await finance.api.patch(`/v1/admin/affiliates/${made.body.id}`, { status: 'paused' });
    const again = await buyAndPay(h, fan, offer.id);
    await fan.api.post(`/v1/orders/${again.id}/confirm`);
    expect(await sellerAvailable(h.ctx.db, creator.id)).toBe(105);
    expect((await seller.api.get('/v1/me/affiliate')).body).toBeNull();
  });
});

describe('game voting', () => {
  it('lets people suggest and vote for games, de-duplicates names, and lets staff mark what is planned', async () => {
    const a = await makeUser(h, { tier: 1 });
    const b = await makeUser(h, { tier: 1 });
    const mod = await makeUser(h, { role: 'support' });
    const first = await a.api.post('/v1/games/votes', { name: '  Lost   Ark ' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ name: 'Lost Ark', votes: 1, voted: true, status: 'open' });
    // Same game, different spacing/case: one entry, one more vote.
    const dup = (await b.api.post('/v1/games/votes', { name: 'lost ark' })).body;
    expect(dup.id).toBe(first.body.id);
    expect(dup.votes).toBe(2);
    expect((await b.api.post(`/v1/games/votes/${first.body.id}/vote`, { on: true })).body.votes).toBe(2); // idempotent
    expect((await b.api.post(`/v1/games/votes/${first.body.id}/vote`, { on: false })).body.votes).toBe(1);
    expect((await a.api.post('/v1/games/votes', { name: 'Test Game' })).body.error.code).toBe('already_listed');

    const board = (await client(h.app).get('/v1/games/votes')).body;
    expect(board.find((s: any) => s.id === first.body.id)).toMatchObject({ votes: 1, voted: false });
    expect((await a.api.get('/v1/games/votes')).body.find((s: any) => s.id === first.body.id).voted).toBe(true);
    expect((await mod.api.patch(`/v1/admin/games/votes/${first.body.id}`, { status: 'planned', note: 'Coming with the next wave' })).body.status).toBe('planned');
    expect((await client(h.app).get('/v1/games/votes?status=planned')).body.map((s: any) => s.name)).toEqual(['Lost Ark']);
    for (const n of ['Throne and Liberty', 'Tarisland', 'New World']) await a.api.post('/v1/games/votes', { name: n });
    expect((await a.api.post('/v1/games/votes', { name: 'One too many' })).status).toBe(429);
  });
});
