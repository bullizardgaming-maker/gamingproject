/**
 * Security audit (Nov 2026): one regression test per fixed finding. Each test reproduces the attack against the
 * local harness (dummy users, mock providers) and asserts the boundary now holds.
 */
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
let wsUrl: string;
beforeAll(async () => {
  h = await setup({ WS_PING_SECONDS: '1' });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  wsUrl = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/v1/ws`;
});
afterAll(async () => h.close());

async function orderRoom() {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 100 });
  const order = await buyAndPay(h, buyer, offer.id);
  const roomId = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id as string;
  return { seller, buyer, roomId, order, offer };
}

function connect(token: string) {
  return new Promise<{ ws: WebSocket; next: (pred: (m: any) => boolean, ms?: number) => Promise<any>; closed: Promise<number> }>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const inbox: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const w = waiters.findIndex((x) => x.pred(m));
      if (w >= 0) waiters.splice(w, 1)[0]!.resolve(m);
      else inbox.push(m);
    });
    const next = (pred: (m: any) => boolean, ms = 5_000) =>
      new Promise<any>((res, rej) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        waiters.push({ pred, resolve: res });
        setTimeout(() => rej(new Error('timeout waiting for ws frame')), ms);
      });
    ws.on('open', async () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      try {
        await next((m) => m.type === 'ready');
        resolve({ ws, next, closed });
      } catch (e) {
        reject(e);
      }
    });
    ws.on('error', reject);
  });
}

describe('WebSocket sessions (H-AUTH-1)', () => {
  it('a revoked session cannot subscribe or sync on a socket opened before the revocation', async () => {
    const { buyer, roomId } = await orderRoom();
    const s = await connect(buyer.token);
    s.ws.send(JSON.stringify({ type: 'subscribe', roomId }));
    await s.next((m) => m.type === 'history');
    // "Sign out everywhere" / password reset: every session row is revoked.
    await h.ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [buyer.id]);
    s.ws.send(JSON.stringify({ type: 'sync', roomId, afterSeq: 0 }));
    expect(await s.closed).toBe(4401);
  });

  it('the keep-alive tick closes a socket whose session was revoked (no more live messages)', async () => {
    const { buyer, roomId } = await orderRoom();
    const s = await connect(buyer.token);
    s.ws.send(JSON.stringify({ type: 'subscribe', roomId }));
    await s.next((m) => m.type === 'history');
    await h.ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [buyer.id]);
    expect(await s.closed).toBe(4401);
  });
});

describe('staff powers outside requirePermission (H-AUTH-2)', () => {
  it('orders.view_any reads need a two-factor session when staff 2FA is required, and an active account', async () => {
    const { order, roomId } = await orderRoom();
    const support = await makeUser(h, { role: 'support' });
    const cfg = h.ctx.cfg as any;
    const before = cfg.STAFF_MFA_REQUIRED;
    cfg.STAFF_MFA_REQUIRED = 'true';
    try {
      // The harness session was opened with a password only (mfa = false).
      expect((await support.api.get(`/v1/orders/${order.id}`)).status).toBe(404);
      expect((await support.api.get(`/v1/chat/rooms/${roomId}/messages`)).status).toBe(403);
      await h.ctx.db.query('UPDATE sessions SET mfa = true WHERE user_id = $1', [support.id]);
      expect((await support.api.get(`/v1/orders/${order.id}`)).status).toBe(200);
    } finally {
      cfg.STAFF_MFA_REQUIRED = before;
    }
    // A suspended staff account keeps no staff reads either.
    await h.ctx.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [support.id]);
    expect((await support.api.get(`/v1/orders/${order.id}`)).status).toBe(404);
  });
});

describe('staff self-dealing (AUTHZ-1, AUTHZ-5, AUTHZ-6)', () => {
  it('a staff member cannot release, refund or decide the dispute of an order they sold or bought', async () => {
    const seller = await makeUser(h, { tier: 2, role: 'support' });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 10 });
    const order = await buyAndPay(h, buyer, offer.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent' });
    await h.ctx.db.query(`UPDATE orders SET delivered_at = now() - interval '2 days' WHERE id = $1`, [order.id]);
    const res = await seller.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'Releasing my own sale' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('own_order');
    expect((await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status).toBe('delivered');
    // Another support member can.
    const other = await makeUser(h, { role: 'support' });
    expect((await other.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'Delivery checked' })).status).toBe(200);
    // The buyer side: an arbiter who bought cannot refund their own completed order.
    const arbiter = await makeUser(h, { tier: 1, role: 'arbiter' });
    const o2 = await buyAndPay(h, arbiter, offer.id);
    await seller.api.post(`/v1/orders/${o2.id}/deliver`, { payload: 'sent' });
    await arbiter.api.post(`/v1/orders/${o2.id}/confirm`, {});
    const refund = await arbiter.api.post(`/v1/admin/orders/${o2.id}/refund-after-release`, { paidBy: 'seller', reason: 'Refunding myself after release' });
    expect(refund.status).toBe(403);
    expect(refund.body.error.code).toBe('own_order');
  });

  it('listing bans follow the rank rule: no self-unban, no banning a higher rank', async () => {
    const support = await makeUser(h, { tier: 2, role: 'support' });
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    await h.ctx.db.query(`UPDATE users SET listing_banned_at = now() WHERE id = $1`, [support.id]);
    expect((await support.api.post(`/v1/admin/users/${support.id}/listing-ban`, { on: false, reason: 'lifting my own' })).status).toBe(403);
    expect((await support.api.post(`/v1/admin/users/${admin.id}/listing-ban`, { on: true, reason: 'banning the admin' })).status).toBe(403);
    const user = await makeUser(h, { tier: 2 });
    expect((await support.api.post(`/v1/admin/users/${user.id}/listing-ban`, { on: true, reason: 'misdescribed items' })).status).toBe(200);
  });

  it('nobody sets their own payout hold, clears their own risk flag or AML case, or approves an adjustment paying themselves', async () => {
    const finance = await makeUser(h, { tier: 2, role: 'finance' });
    expect((await finance.api.put(`/v1/admin/users/${finance.id}/payout-hold`, { days: 0, reason: 'my own hold' })).status).toBe(403);
    const compliance = await makeUser(h, { tier: 2, role: 'compliance' });
    const flag = await h.ctx.db.query(`INSERT INTO risk_flags (user_id, score, reasons, status) VALUES ($1, 0.9, '{}'::jsonb, 'open') RETURNING id`, [compliance.id]);
    expect((await compliance.api.post(`/v1/admin/risk-flags/${flag.rows[0].id}/review`, { decision: 'clear' })).status).toBe(403);
    const amlCase = await h.ctx.db.query(`INSERT INTO aml_cases (user_id, source, rule, severity, holds_payouts, details) VALUES ($1, 'manual', 'test', 'high', true, '{}') RETURNING id`, [compliance.id]);
    expect((await compliance.api.post(`/v1/admin/aml/cases/${amlCase.rows[0].id}/decide`, { decision: 'clear', note: 'all fine' })).status).toBe(403);
    const f2 = await makeUser(h, { tier: 2, role: 'finance' });
    const req = await finance.api.post('/v1/admin/ledger/adjustments', {
      reason: 'Goodwill credit for a test', lines: [{ kind: 'treasury', currency: 'USD', amountCents: -1_00 }, { kind: 'seller_available', currency: 'USD', ownerId: f2.id, amountCents: 1_00 }],
    });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const decide = await f2.api.post(`/v1/admin/ledger/adjustments/${req.body.id}/decide`, { approve: true });
    expect(decide.status).toBe(403);
    expect(decide.body.error.code).toBe('own_account');
  });
});

describe('listing-ban bypasses (CRIT-1, CRIT-2, AUTHZ-4)', () => {
  it('a listing-banned seller cannot relist an expired listing or get one through an accepted request proposal', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 10 });
    const r = await buyer.api.post('/v1/requests', { game: 'Test Game', categorySlug: 'keys', title: 'Need a rare key', budgetCents: 30_00 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const p = await seller.api.post(`/v1/requests/${r.body.id}/proposals`, { priceCents: 20_00, deliveryHours: 4 });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    await h.ctx.db.query(`UPDATE offers SET status = 'expired', expired_reason = 'league_ended:X' WHERE id = $1`, [offer.id]);
    await h.ctx.db.query(`UPDATE users SET listing_banned_at = now() WHERE id = $1`, [seller.id]);
    expect((await seller.api.post(`/v1/offers/${offer.id}/relist`, { league: 'standard' })).status).toBe(403);
    expect((await h.ctx.db.query('SELECT status FROM offers WHERE id = $1', [offer.id])).rows[0].status).toBe('expired');
    const view = await buyer.api.get(`/v1/requests/${r.body.id}`);
    const acc = await buyer.api.post(`/v1/requests/${r.body.id}/proposals/${view.body.proposal_list[0].id}/accept`);
    expect(acc.status).toBe(409);
    expect(acc.body.error.code).toBe('seller_unavailable');
  });

  it('ID approval does not bring back listings while the seller is listing-banned', async () => {
    const { liftIdRestriction } = await import('../src/domain/onboarding.js');
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 10 });
    await h.ctx.db.query(`UPDATE offers SET status = 'paused', expired_reason = 'id_overdue' WHERE id = $1`, [offer.id]);
    await h.ctx.db.query(`UPDATE users SET selling_restricted_at = now(), listing_banned_at = now() WHERE id = $1`, [seller.id]);
    await liftIdRestriction(h.ctx.db, seller.id);
    expect((await h.ctx.db.query('SELECT status FROM offers WHERE id = $1', [offer.id])).rows[0].status).toBe('paused');
  });
});

describe('FX overrides (AUTHZ-3)', () => {
  it('a chain of small self-applied overrides cannot move a rate more than 2 % without a second approver', async () => {
    const finance = await makeUser(h, { tier: 2, role: 'finance' });
    await h.ctx.db.query(`INSERT INTO fx_rates (currency, rate, source, fetched_at) VALUES ('EUR', 1.0, 'ecb', now()) ON CONFLICT (currency) DO UPDATE SET rate = 1.0, source = 'ecb', fetched_at = now(), override_until = NULL`);
    const first = await finance.api.put('/v1/admin/fx/rates/EUR', { rate: 1.019, note: 'step one' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ applied: true });
    const second = await finance.api.put('/v1/admin/fx/rates/EUR', { rate: 1.038, note: 'step two' });
    expect(second.body).toMatchObject({ applied: false, needs_second_approver: true });
    expect(Number((await h.ctx.db.query(`SELECT rate FROM fx_rates WHERE currency = 'EUR'`)).rows[0].rate)).toBeCloseTo(1.019, 6);
  });
});

describe('sign-in takes JSON only (EDGE-5)', () => {
  it('a cross-site form post to /auth/login is refused before any cookie is set', async () => {
    const user = await makeUser(h);
    const res = await h.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `email=${encodeURIComponent(user.email)}&password=${encodeURIComponent('correct horse battery')}` });
    expect(res.statusCode).toBe(415);
    expect(res.headers['set-cookie']).toBeUndefined();
    // The app's own empty-body refresh call still works (no content type).
    expect((await h.app.inject({ method: 'POST', url: '/v1/auth/refresh' })).statusCode).not.toBe(415);
  });
});

describe('kill switches cover top-ups and chat files (EDGE-6)', () => {
  it('pause orders stops new wallet top-ups; pause chat stops attachments', async () => {
    const { forgetControlsCache } = await import('../src/domain/controls.js');
    const { buyer, roomId } = await orderRoom();
    await h.ctx.db.query('UPDATE platform_controls SET pause_orders = true, pause_chat = true');
    forgetControlsCache();
    try {
      const dep = await buyer.api.post('/v1/me/wallet/deposits', { method: 'crypto', amountCents: 10_00 });
      expect(dep.body.error?.code).toBe('orders_paused');
      const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
      const up = await h.app.inject({ method: 'POST', url: `/v1/chat/rooms/${roomId}/attachments`, headers: { authorization: `Bearer ${buyer.token}`, 'content-type': 'image/png', 'x-filename': 'a.png' }, payload: png });
      expect(up.json().error.code).toBe('chat_paused');
    } finally {
      await h.ctx.db.query('UPDATE platform_controls SET pause_orders = false, pause_chat = false');
      forgetControlsCache();
    }
  });
});

describe('money (C1, C2)', () => {
  it('an order settled by a split dispute cannot be refunded again after release (no double refund)', async () => {
    const { buyer, order } = await orderRoom();
    expect((await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Only half of it arrived', category: 'not_as_described' })).status).toBeLessThan(300);
    const d = (await h.ctx.db.query('SELECT id FROM disputes WHERE order_id = $1', [order.id])).rows[0];
    const arbiter = await makeUser(h, { role: 'admin' });
    const split = await arbiter.api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome: 'split', refundCents: Math.floor(order.amount_cents / 2), note: 'Half delivered' });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    const again = await arbiter.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { paidBy: 'seller', reason: 'Refund the rest after release' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('dispute_split_settled');
  });

  it('with card payments on, an order below the card minimum is refused instead of getting a negative discount', async () => {
    const cfg = h.ctx.cfg as any;
    cfg.CARD_PAYMENTS_ENABLED = true;
    try {
      const seller = await makeUser(h, { tier: 2 });
      const buyer = await makeUser(h, { tier: 1 });
      const offer = await makeOffer(seller, { priceCents: 1, deliveryMode: 'manual', stock: 5 });
      const res = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('amount_too_small');
    } finally {
      cfg.CARD_PAYMENTS_ENABLED = false;
    }
  });
});

describe('off-platform filter on every text the other side sees (HCHAT-1..4)', () => {
  it('Round 29e (M-A): texts between the parties with a contact attempt are accepted and flagged for staff; public texts refuse real contact details only; product talk passes everywhere', async () => {
    const { buyer, seller, order } = await orderRoom();
    const lead = await makeUser(h, { role: 'lead' });
    // product talk that names an app or brand is not a contact attempt — anywhere
    for (const reason of ['Discord Nitro gift card didn\'t work', 'The Telegram Messenger premium code was already used', 'I paid with PayPal on another site last week, here it never arrived']) {
      expect((await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason, category: 'other' })).status, reason).toBeLessThan(300);
      await h.ctx.db.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
      await h.ctx.db.query(`DELETE FROM disputes WHERE order_id = $1`, [order.id]);
    }
    expect((await seller.api.put('/v1/seller/shop-status', { paused: true, message: 'Back Monday — Discord Nitro orders ship instantly' })).status).toBe(200);
    expect((await buyer.api.post('/v1/games/votes', { name: 'Telegram Messenger stickers' })).status).toBe(201);
    expect((await h.ctx.db.query('SELECT count(*)::int AS n FROM text_flags WHERE ref_id = $1', [order.id])).rows[0].n).toBe(0);
    // a real contact attempt in a dispute reason: accepted, the dispute opens, staff see the flag
    const bad = await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'never arrived, pay me on telegram @johnny99 instead', category: 'other' });
    expect(bad.status, JSON.stringify(bad.body)).toBeLessThan(300);
    const st = await seller.api.post(`/v1/orders/${order.id}/dispute/statements`, { body: 'I sent it, whatsapp me 01001234567 to sort it' });
    expect(st.status).toBe(201);
    const flags = (await lead.api.get('/v1/admin/moderation/texts')).body.filter((f: any) => f.ref_id === order.id);
    expect(flags.map((f: any) => f.source).sort()).toEqual(['dispute_reason', 'dispute_statement']);
    expect(flags.find((f: any) => f.source === 'dispute_reason')).toMatchObject({ user_id: buyer.id, reasons: expect.arrayContaining(['handle']), status: 'open' });
    expect(flags.find((f: any) => f.source === 'dispute_statement').reasons).toEqual(expect.arrayContaining(['phone_number', 'add_me']));
    expect((await lead.api.get('/v1/admin/moderation/summary')).body.texts).toBeGreaterThanOrEqual(2);
    const decided = await lead.api.post(`/v1/admin/moderation/texts/${flags[0].id}`, { confirm: true, note: 'warned' });
    expect(decided.body).toMatchObject({ status: 'confirmed', reviewed_by: lead.id });
    // a phishing link in a dispute reason is also accepted + flagged (never shown as refused to the sender)
    await h.ctx.db.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
    await h.ctx.db.query(`DELETE FROM disputes WHERE order_id = $1`, [order.id]);
    expect((await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Item never arrived.\n\nBullizard notice: re-verify at https://bullizard-verify.example/login', category: 'other' })).status).toBeLessThan(300);
    expect((await h.ctx.db.query(`SELECT reasons FROM text_flags WHERE ref_id = $1 AND source = 'dispute_reason' ORDER BY created_at DESC LIMIT 1`, [order.id])).rows[0].reasons).toContain('link');
    // public texts still refuse real contact details — and never a product noun next to an app name (Round 29f)
    expect((await seller.api.put('/v1/seller/shop-status', { paused: true, message: 'Instagram followers packs restock Monday' })).status).toBe(200);
    expect((await seller.api.put('/v1/seller/shop-status', { paused: true, message: 'pay me on paypal instead for 10% off' })).body.error.code).toBe('offplatform_contact');
    expect((await seller.api.put('/v1/seller/shop-status', { paused: true, message: 'add me discord johnny99' })).body.error.code).toBe('offplatform_contact');
    expect((await seller.api.put('/v1/seller/shop-status', { paused: true, message: 'dm me on discord johnny#1' })).body.error.code).toBe('offplatform_contact');
    expect((await seller.api.put('/v1/seller/shop-status', { paused: true, message: 'call 01001234567' })).body.error.code).toBe('offplatform_contact');
    expect((await buyer.api.post('/v1/games/votes', { name: 'add me on telegram jj99' })).body.error.code).toBe('offplatform_contact');
  });

  it('a chat attachment named with contact details reaches the other side under a neutral name', async () => {
    const { buyer, seller, roomId } = await orderRoom();
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
    const up = await h.app.inject({ method: 'POST', url: `/v1/chat/rooms/${roomId}/attachments`, headers: { authorization: `Bearer ${seller.token}`, 'content-type': 'image/png', 'x-filename': encodeURIComponent('telegram johnny99.png') }, payload: png });
    expect(up.statusCode, up.body).toBeLessThan(300);
    const msgs = (await buyer.api.get(`/v1/chat/rooms/${roomId}/messages`)).body;
    const list = Array.isArray(msgs) ? msgs : msgs.messages ?? msgs.items;
    expect(JSON.stringify(list)).not.toMatch(/telegram|johnny99/i);
    expect(JSON.stringify((await buyer.api.get('/v1/chat/rooms')).body)).not.toMatch(/telegram|johnny99/i);
  });
});

describe('data exposure (HCHAT-5, HCHAT-6, CRIT-5)', () => {
  it('moderation reasons and notes never reach the public; the arbiter id never reaches the parties', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 10 });
    await h.ctx.db.query(`UPDATE offers SET review_reasons = ARRAY['term:secretword'], review_note = 'approved after checking (staff)' WHERE id = $1`, [offer.id]);
    const anon = await h.app.inject({ method: 'GET', url: '/v1/offers?game=Test%20Game' });
    expect(anon.body).not.toMatch(/secretword|approved after checking/);
    expect(JSON.stringify((await seller.api.get(`/v1/sellers/${seller.id}`)).body)).not.toMatch(/approved after checking/);

    const { buyer, order } = await orderRoom();
    await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'The gold never arrived in game', category: 'other' });
    const d = (await h.ctx.db.query('SELECT id FROM disputes WHERE order_id = $1', [order.id])).rows[0];
    const arbiter = await makeUser(h, { role: 'admin' });
    expect((await arbiter.api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome: 'buyer', note: 'Not delivered' })).status).toBe(200);
    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.dispute).toBeTruthy();
    expect(view.dispute).not.toHaveProperty('resolved_by');
  });

  it('a watch cannot reveal a listing reserved for another buyer or still in review', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const someone = await makeUser(h, { tier: 1 });
    const stranger = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 10 });
    await h.ctx.db.query('UPDATE offers SET reserved_for = $2 WHERE id = $1', [offer.id, someone.id]);
    expect((await stranger.api.post('/v1/me/watches', { offerId: offer.id })).status).toBe(404);
    const o2 = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 10 });
    await h.ctx.db.query(`UPDATE offers SET status = 'review' WHERE id = $1`, [o2.id]);
    expect((await stranger.api.post('/v1/me/watches', { offerId: o2.id })).status).toBe(404);
  });
});

describe('error details (HF-3) and import metering (HF-2)', () => {
  it('the CSV import is metered per user', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await seller.api.post('/v1/seller/listings/import', { csv: 'title\nx', dryRun: true })).status);
    expect(codes).toContain(429);
  });
});

describe('Steam/Riot linking is bound to the browser that started it (H-AUTH-3)', () => {
  it('a callback without the starter’s cookie links nothing; Steam’s signed state must match', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const start = await seller.api.post('/v1/seller/linked-accounts/steam/start', { mockAccount: '76561198000009999' });
    expect(start.status).toBe(200);
    expect(start.body).not.toHaveProperty('binding');
    const u = new URL(start.body.url);
    // The victim's browser (no bz_link cookie) completes the sign-in the attacker started.
    const res = await h.app.inject({ method: 'GET', url: `${u.pathname}${u.search}` });
    expect(String(res.headers.location)).toMatch(/link_error=link_not_started_here/);
    expect((await seller.api.get('/v1/seller/linked-accounts')).body).toEqual([]);

    const { LivePlatformAccounts } = await import('../src/providers/platformAccounts.js');
    const cb = 'https://api.example.com/v1/linked-accounts/steam/callback';
    const live = new LivePlatformAccounts({}, (async () => new Response('is_valid:true\n')) as any);
    const q = { state: 'attacker', 'openid.mode': 'id_res', 'openid.return_to': `${cb}?state=victim`, 'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561197960435530', 'openid.signed': 'claimed_id,identity,return_to,response_nonce' };
    await expect(live.complete('steam', q, cb)).rejects.toThrow(/not completed/);
  });
});

describe('remaining decisions (Nov 6 follow-up)', () => {
  it('raising a four-eyes threshold or payout cap needs an admin; Finance can still tighten', async () => {
    const finance = await makeUser(h, { tier: 2, role: 'finance' });
    // The harness runs at the maximum; an admin lowers it first, then Finance tries to raise it again.
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    expect((await admin.api.put('/v1/admin/controls', { four_eyes_withdrawal_cents: 500_00 })).status).toBe(200);
    expect((await finance.api.put('/v1/admin/controls', { four_eyes_withdrawal_cents: 50_000_00 })).status).toBe(403);
    expect((await finance.api.put('/v1/admin/controls', { four_eyes_withdrawal_cents: 400_00 })).status).toBe(200);
    expect((await admin.api.put('/v1/admin/controls', { four_eyes_withdrawal_cents: 100_000_00 })).status).toBe(200);
  });

  it('turning on 2FA needs the current password; wrong ones count toward the lockout', async () => {
    const u = await makeUser(h);
    expect((await u.api.post('/v1/me/2fa/setup', {})).status).toBe(400);
    const wrong = await u.api.post('/v1/me/2fa/setup', { currentPassword: 'not my password' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('wrong_current_password');
    expect(Number((await h.ctx.db.query('SELECT failed_logins FROM users WHERE id = $1', [u.id])).rows[0].failed_logins)).toBe(1);
    expect((await u.api.post('/v1/me/2fa/setup', { currentPassword: 'correct horse battery' })).body.secret).toBeTruthy();
  });

  it('a locked account answers wrong passwords exactly like an unknown email; only the owner learns of the lock', async () => {
    const { client } = await import('./helpers.js');
    const u = await makeUser(h);
    const anon = client(h.app);
    for (let i = 0; i < h.ctx.cfg.LOGIN_MAX_FAILURES; i++) await anon.post('/v1/auth/login', { email: u.email, password: 'wrong password!' });
    const locked = await anon.post('/v1/auth/login', { email: u.email, password: 'wrong password!' });
    const unknown = await anon.post('/v1/auth/login', { email: `nobody_${Date.now()}@example.com`, password: 'wrong password!' });
    expect([locked.status, locked.body.error.code]).toEqual([unknown.status, unknown.body.error.code]);
    expect((await anon.post('/v1/auth/login', { email: u.email, password: 'correct horse battery' })).body.error.code).toBe('account_locked');
  });

  it('an account under a penalty cannot delete itself (and re-register clean)', async () => {
    const u = await makeUser(h, { tier: 2 });
    await h.ctx.db.query('UPDATE users SET listing_banned_at = now() WHERE id = $1', [u.id]);
    const res = await u.api.post('/v1/me/delete', { password: 'correct horse battery' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('cannot_close_now');
    expect((await h.ctx.db.query('SELECT deleted_at FROM users WHERE id = $1', [u.id])).rows[0].deleted_at).toBeNull();
  });

  it('rewards paid from an order’s commission are taken back when it is refunded after release', async () => {
    const { buyer, seller, order } = await orderRoom();
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent' });
    await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
    const referrer = await makeUser(h, { tier: 2 });
    // A referral reward and a creator share as they are booked on completion.
    const { accountId, post } = await import('../src/domain/ledger.js');
    const { withTx } = await import('../src/db.js');
    await withTx(h.ctx.db, async (tx) => {
      await tx.query(`INSERT INTO referral_rewards (referrer_id, referee_id, order_id, amount_cents, status) VALUES ($1, $2, $3, 40, 'granted')`, [referrer.id, buyer.id, order.id]);
      await post(tx, [{ account: await accountId(tx, 'treasury', 'USD'), amountCents: -40 }, { account: await accountId(tx, 'seller_available', 'USD', referrer.id), amountCents: 40 }], 'referral_reward', order.id);
    });
    const balance = async () => Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'seller_available' AND a.owner_id = $1`, [referrer.id])).rows[0].b);
    expect(await balance()).toBe(40);
    const admin = await makeUser(h, { role: 'admin' });
    const r = await admin.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { paidBy: 'platform', reason: 'Goodwill refund after release' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await balance()).toBe(0);
  });

  it('an ID check rejected after approval lowers the ID level and freezes withdrawals', async () => {
    const { applyKycResult } = await import('../src/domain/users.js');
    const u = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`INSERT INTO kyc_verifications (user_id, provider, external_id, level, status) VALUES ($1, $2, 'ext-revoke-1', 'tier2_individual', 'approved')`, [u.id, h.ctx.kyc.name]);
    await applyKycResult(h.ctx, { externalId: 'ext-revoke-1', status: 'rejected', raw: {} });
    const row = (await h.ctx.db.query('SELECT kyc_tier, withdrawals_frozen FROM users WHERE id = $1', [u.id])).rows[0];
    expect(row).toMatchObject({ kyc_tier: 1, withdrawals_frozen: true });
    expect((await h.ctx.db.query(`SELECT 1 FROM risk_flags WHERE user_id = $1 AND status = 'open'`, [u.id])).rowCount).toBe(1);
  });

  it('the rules test never says which answers were wrong, and pauses after three failed tries in an hour', async () => {
    const u = await makeUser(h, { tier: 1 });
    const test = (await u.api.get('/v1/seller/rules-test')).body;
    const wrong = Object.fromEntries(test.questions.map((q: any) => [q.id, 0]));
    for (let i = 0; i < 3; i++) {
      const r = await u.api.post('/v1/seller/rules-test', { answers: wrong });
      expect(r.body.passed).toBe(false);
      expect(r.body.results.some((x: any) => 'correct' in x)).toBe(false);
    }
    const fourth = await u.api.post('/v1/seller/rules-test', { answers: wrong });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('rules_test_cooldown');
  });
});

describe('rate limits and chat counts (Nov 6 follow-up)', () => {
  it('sign-in keeps a per-process limit while the shared (Redis) limiter is unreachable', async () => {
    const { createContext } = await import('../src/context.js');
    const { buildApp } = await import('../src/server.js');
    const { MemoryPubSub } = await import('../src/lib/pubsub.js');
    const silent = { info() {}, warn() {}, error() {} } as any;
    const app = await buildApp(createContext({ ...h.ctx.cfg, REDIS_URL: 'redis://127.0.0.1:1', AUTH_RATE_LIMIT_PER_MINUTE: 3 } as any, silent, { db: h.ctx.db, dbRead: h.ctx.dbRead, pubsub: new MemoryPubSub(), views: h.ctx.views }));
    await app.ready();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'nobody@example.com', password: 'wrong password!' }) })).statusCode);
      expect(codes.slice(0, 3).every((c) => c === 401)).toBe(true);
      expect(codes.slice(3)).toEqual([429, 429]);
    } finally {
      await app.close().catch(() => {});
    }
  });

  it('the parties’ chain check counts only messages they can read (no trace of blocked ones)', async () => {
    const { buyer, seller, roomId } = await orderRoom();
    const before = (await buyer.api.get(`/v1/chat/rooms/${roomId}/verify`)).body.messages;
    const blocked = await seller.api.post(`/v1/chat/rooms/${roomId}/messages`, { body: 'add me on telegram johnny99' });
    expect(blocked.body.hidden_for_safety).toBe(true);
    const after = (await buyer.api.get(`/v1/chat/rooms/${roomId}/verify`)).body;
    expect(after.valid).toBe(true);
    expect(after.messages).toBe(before);
  });
});

describe('chargebacks after a refund to balance (C3)', () => {
  it('the bank paying the buyer back again is taken from the buyer’s balance, not the seller or the reserve', async () => {
    const { receiveChargeback } = await import('../src/domain/chargebacks.js');
    const cfg = h.ctx.cfg as any;
    const before = cfg.CARD_REFUNDS_ENABLED;
    cfg.CARD_REFUNDS_ENABLED = false; // the launch policy: refunds go to the Bullizard balance
    try {
      const { buyer, order } = await orderRoom();
      await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'The gold never arrived in game', category: 'other' });
      const d = (await h.ctx.db.query('SELECT id FROM disputes WHERE order_id = $1', [order.id])).rows[0];
      const admin = await makeUser(h, { role: 'admin' });
      expect((await admin.api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome: 'buyer', note: 'Not delivered' })).status).toBe(200);
      const sum = async (kind: string, owner: string | null) =>
        Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = $1 AND a.owner_id IS NOT DISTINCT FROM $2`, [kind, owner])).rows[0].b);
      const credit = await sum('user_credit', buyer.id);
      const reserve = await sum('reserve', null);
      const cb = await receiveChargeback(h.ctx, { orderId: order.id, network: 'visa', reasonCode: '13.1', amountCents: order.amount_cents });
      expect(cb.amount_cents).toBeGreaterThan(0);
      expect(await sum('user_credit', buyer.id)).toBe(credit - Number(cb.amount_cents));
      expect(await sum('reserve', null)).toBe(reserve);
      expect((await h.ctx.db.query('SELECT withdrawals_frozen FROM users WHERE id = $1', [buyer.id])).rows[0].withdrawals_frozen).toBe(true);
    } finally {
      cfg.CARD_REFUNDS_ENABLED = before;
    }
  });

  it('Round 29e (M-B): after a PARTIAL refund to balance, a full chargeback takes only the refunded part from the buyer; the rest follows the normal rules', async () => {
    const { receiveChargeback } = await import('../src/domain/chargebacks.js');
    const { cardRefundedToBalance } = await import('../src/domain/rewardReversal.js');
    const cfg = h.ctx.cfg as any;
    const before = cfg.CARD_REFUNDS_ENABLED;
    cfg.CARD_REFUNDS_ENABLED = false;
    try {
      const seller = await makeUser(h, { tier: 2 });
      const buyer = await makeUser(h, { tier: 1 });
      const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 100, priceCents: 100_00 });
      const order = await buyAndPay(h, buyer, offer.id);
      await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Only part of the gold arrived in game', category: 'other' });
      const d = (await h.ctx.db.query('SELECT id FROM disputes WHERE order_id = $1', [order.id])).rows[0];
      const admin = await makeUser(h, { role: 'admin' });
      // $30 of the order back to the buyer's balance, the rest released to the seller
      expect((await admin.api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome: 'split', refundCents: 30_00, note: 'Partly delivered' })).status).toBe(200);
      const sum = async (kind: string, owner: string | null) =>
        Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = $1 AND a.owner_id IS NOT DISTINCT FROM $2`, [kind, owner])).rows[0].b);
      expect(await sum('user_credit', buyer.id)).toBe(30_00);
      await h.ctx.db.query('BEGIN');
      try {
        expect(await cardRefundedToBalance(h.ctx.db as any, { id: order.id, charged_cents: order.amount_cents })).toBe(30_00);
      } finally {
        await h.ctx.db.query('ROLLBACK');
      }
      const sellerBefore = await sum('seller_available', seller.id);
      const reserveBefore = await sum('reserve', null);
      const cb = await receiveChargeback(h.ctx, { orderId: order.id, network: 'visa', reasonCode: '13.1', amountCents: order.amount_cents });
      expect(Number(cb.amount_cents)).toBe(order.amount_cents);
      // $30 from the buyer's balance (now 0), the remaining $70 from the seller's balance / the reserve as usual
      expect(await sum('user_credit', buyer.id)).toBe(0);
      const fromSeller = sellerBefore - (await sum('seller_available', seller.id));
      const fromReserve = reserveBefore - (await sum('reserve', null));
      expect(fromSeller + fromReserve).toBe(order.amount_cents - 30_00);
      expect(cb.allocation ?? cb).toBeTruthy();
    } finally {
      cfg.CARD_REFUNDS_ENABLED = before;
    }
  });
});
