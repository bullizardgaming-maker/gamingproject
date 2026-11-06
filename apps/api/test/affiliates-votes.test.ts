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
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'K-1\nK-2\nK-3' });
    // CFO (5 Nov): the creator earns from the buyer's 2nd order on — the first order pays nothing.
    const first = await buyAndPay(h, fan, offer.id);
    await fan.api.post(`/v1/orders/${first.id}/confirm`);
    expect(await sellerAvailable(h.ctx.db, creator.id)).toBe(0);
    // Round 29d (M5, CFO 16): the first order of $10+ earns a $2.50 bounty instead — paid after 7 dispute-free days.
    const { payCreatorBounties } = await import('../src/domain/affiliates.js');
    const bounty = (await h.ctx.db.query('SELECT * FROM creator_bounties WHERE order_id = $1', [first.id])).rows[0];
    expect(bounty).toMatchObject({ status: 'pending', amount_cents: 250, creator_id: creator.id });
    expect((await creator.api.get('/v1/me/affiliate')).body).toMatchObject({ bounties_pending_cents: 250, bounties_paid_cents: 0 });
    expect(await payCreatorBounties(h.ctx)).toEqual({ paid: 0, voided: 0 }); // not yet: 7 days
    await h.ctx.db.query(`UPDATE creator_bounties SET eligible_at = now() - interval '1 minute' WHERE id = $1`, [bounty.id]);
    expect(await payCreatorBounties(h.ctx)).toEqual({ paid: 1, voided: 0 });
    expect(await sellerAvailable(h.ctx.db, creator.id)).toBe(250);
    expect((await creator.api.get('/v1/me/affiliate')).body).toMatchObject({ bounties_pending_cents: 0, bounties_paid_cents: 250 });
    const order = await buyAndPay(h, fan, offer.id);
    await fan.api.post(`/v1/orders/${order.id}/confirm`);
    // 100.00 grossed up by 5% = 5.27 commission; the creator's 20% share is 1.05, paid from the treasury (on top of the bounty).
    expect(await sellerAvailable(h.ctx.db, creator.id)).toBe(250 + 105);
    expect((await h.ctx.db.query('SELECT 1 FROM creator_bounties WHERE order_id = $1', [order.id])).rowCount).toBe(0); // a 2nd order earns no bounty
    const mine = (await creator.api.get('/v1/me/affiliate')).body;
    expect(mine).toMatchObject({ code: 'STREAMER-X', buyers: 1, orders: 1, earned_cents: 105 }); // orders = earning orders
    expect(mine.recent[0]).toMatchObject({ order_id: order.id, commission_cents: 527, earned_cents: 105 });
    expect((await finance.api.get('/v1/admin/affiliates')).body.find((a: any) => a.code === 'STREAMER-X')).toMatchObject({ buyers: 1, earned_cents: 105 });

    // Paused: later orders pay nothing. Someone without a code sees null.
    await finance.api.patch(`/v1/admin/affiliates/${made.body.id}`, { status: 'paused' });
    const again = await buyAndPay(h, fan, offer.id);
    await fan.api.post(`/v1/orders/${again.id}/confirm`);
    expect(await sellerAvailable(h.ctx.db, creator.id)).toBe(250 + 105);
    expect((await seller.api.get('/v1/me/affiliate')).body).toBeNull();
  });
});

describe('creator first-order bounty (Round 29d, M5)', () => {
  it('needs a $10+ first order, a creator in their first 90 days and no dispute; the monthly caps void the rest', async () => {
    const finance = await makeUser(h, { role: 'finance' });
    const creator = await makeUser(h, { tier: 2 });
    await finance.api.post('/v1/admin/affiliates', { userId: creator.id, code: 'bounty-c', rateBps: 2000 });
    const seller = await makeUser(h, { tier: 2 });
    const cheap = await makeOffer(seller, { priceCents: 5_00, stock: 5 });
    const offer = await makeOffer(seller, { priceCents: 20_00, stock: 5 });
    await seller.api.post(`/v1/offers/${cheap.id}/inventory`, { format: 'txt', content: 'C-1\nC-2' });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'B-1\nB-2\nB-3\nB-4\nB-5' });
    const fanOf = async (code = 'bounty-c') => {
      const reg = await client(h.app).post('/v1/auth/register', { email: `fan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`, password: 'correct horse battery', displayName: 'Fan', acceptTerms: true, code });
      await h.ctx.db.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1`, [reg.body.user.id]);
      return { id: reg.body.user.id, api: client(h.app, reg.body.token) };
    };
    const { payCreatorBounties } = await import('../src/domain/affiliates.js');
    const bountyOf = async (orderId: string) => (await h.ctx.db.query('SELECT status, void_reason FROM creator_bounties WHERE order_id = $1', [orderId])).rows[0];
    // under $10: nothing
    const f1 = await fanOf();
    const small = await buyAndPay(h, f1, cheap.id);
    await f1.api.post(`/v1/orders/${small.id}/confirm`);
    expect(await bountyOf(small.id)).toBeUndefined();
    // disputed within the 7 days: void
    const f2 = await fanOf();
    const disputed = await buyAndPay(h, f2, offer.id);
    await f2.api.post(`/v1/orders/${disputed.id}/confirm`);
    expect((await bountyOf(disputed.id)).status).toBe('pending');
    await h.ctx.db.query(`INSERT INTO disputes (order_id, opened_by, reason) VALUES ($1, $2, 'not as described')`, [disputed.id, f2.id]);
    await h.ctx.db.query(`UPDATE creator_bounties SET eligible_at = now() - interval '1 minute' WHERE order_id = $1`, [disputed.id]);
    expect(await payCreatorBounties(h.ctx)).toEqual({ paid: 0, voided: 1 });
    expect(await bountyOf(disputed.id)).toEqual({ status: 'void', void_reason: 'disputed' });
    // the creator's monthly cap ($150) and the platform cap ($250): a bounty past the cap is voided, not paid
    const f3 = await fanOf();
    const ok = await buyAndPay(h, f3, offer.id);
    await f3.api.post(`/v1/orders/${ok.id}/confirm`);
    await h.ctx.db.query(`UPDATE creator_bounties SET eligible_at = now() - interval '1 minute' WHERE order_id = $1`, [ok.id]);
    const saved = h.ctx.cfg.CREATOR_BOUNTY_CREATOR_MONTH_CAP_CENTS;
    (h.ctx.cfg as any).CREATOR_BOUNTY_CREATOR_MONTH_CAP_CENTS = 200;
    try {
      expect(await payCreatorBounties(h.ctx)).toEqual({ paid: 0, voided: 1 });
      expect(await bountyOf(ok.id)).toEqual({ status: 'void', void_reason: 'creator_month_cap' });
    } finally {
      (h.ctx.cfg as any).CREATOR_BOUNTY_CREATOR_MONTH_CAP_CENTS = saved;
    }
    // a creator past their first 90 days earns no bounty
    await h.ctx.db.query(`UPDATE affiliates SET created_at = now() - interval '91 days' WHERE code = 'BOUNTY-C'`);
    const f4 = await fanOf();
    const late = await buyAndPay(h, f4, offer.id);
    await f4.api.post(`/v1/orders/${late.id}/confirm`);
    expect(await bountyOf(late.id)).toBeUndefined();
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
