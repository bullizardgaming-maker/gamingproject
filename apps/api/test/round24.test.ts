import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { attributesFor } from '../src/domain/attributeSets.js';
import { allowedMethods, cleanDeliveryChoice, levelFromOrders, offeredMethods } from '../src/domain/delivery.js';
import { stripInternalFields } from '../src/server.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

/** Round 24 (claude/round-24-backend-brief.md): one test per item, each failing on b5d47b0. */
let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const albion = (extra: Record<string, unknown> = {}) => ({
  categorySlug: 'currency', game: 'Albion Online', title: '10M silver', priceCents: 5_00, deliveryMode: 'manual', stock: 50, attributes: { server: 'Europe' }, ...extra,
});
const pay = async (ref: string) => {
  const r = await client(h.app).post(`/v1/payments/mock/checkout/${ref}/pay`, {}, { accept: 'application/json' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

describe('§1 listing fields', () => {
  it('level from completed orders, positive share, sold count on the listing, a stable BZO public ID', async () => {
    expect([0, 1, 100, 3000].map(levelFromOrders)).toEqual([1, 3, 21, 110]);
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 10 });
    const other = await makeOffer(seller, { deliveryMode: 'manual', stock: 10, title: 'Other key' });
    expect(offer.public_id).toMatch(/^BZO[0-9A-Z]{12}$/);
    expect(offer.public_id).not.toContain('-');
    expect(offer.public_id).not.toBe(other.public_id);
    expect(offer).toMatchObject({ seller_level: 1, seller_positive_pct: null, sold_count: 0, delivery_methods: null });

    // Three completed orders on this listing (two reviews: 5 and 2 stars), one on the other.
    const ratings = [5, 2, null, null];
    for (const [i, rating] of ratings.entries()) {
      const o = await buyAndPay(h, buyer, i < 3 ? offer.id : other.id);
      await seller.api.post(`/v1/orders/${o.id}/deliver`, { payload: 'here' });
      expect((await buyer.api.post(`/v1/orders/${o.id}/confirm`, {})).status).toBe(200);
      if (rating) expect((await buyer.api.post(`/v1/orders/${o.id}/review`, { rating, comment: 'ok' })).status).toBe(201);
    }
    const one = (await client(h.app).get(`/v1/offers/${offer.id}`)).body;
    expect(one).toMatchObject({ public_id: offer.public_id, seller_level: levelFromOrders(4), seller_positive_pct: 50, sold_count: 3 });
    const list = (await client(h.app).get('/v1/offers?q=key&limit=50')).body;
    const rows = (list.items ?? list) as any[];
    const row = rows.find((r) => r.id === other.id);
    expect(row).toMatchObject({ public_id: other.public_id, seller_level: 5, sold_count: 1 });
    // Every listing has one (migration 079 backfills; the column is NOT NULL and unique).
    const cols = (await h.ctx.db.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'offers' AND column_name = 'public_id'`)).rows[0];
    expect(cols.is_nullable).toBe('NO');
    await expect(h.ctx.db.query('UPDATE offers SET public_id = $2 WHERE id = $1', [other.id, offer.public_id])).rejects.toThrow(/unique|duplicate/i);
  });
});

describe('§2 delivery methods per game', () => {
  it('the fixed list: Albion f2f + market, PoE f2f, Aion mail, other handover games f2f or UID', () => {
    expect(allowedMethods('Albion Online', 'character')).toEqual(['f2f', 'market']);
    expect(allowedMethods('Path of Exile 2', 'character')).toEqual(['f2f']);
    expect(allowedMethods('Aion 2', 'character')).toEqual(['f2f', 'mail']);
    expect(allowedMethods('Genshin Impact', 'uid')).toEqual(['uid']);
    expect(allowedMethods('World of Warcraft', 'character')).toEqual(['f2f']);
    expect(allowedMethods('Albion Online', null)).toEqual([]);
    expect(offeredMethods('Albion Online', 'character', ['market'])).toEqual(['market']);
    expect(offeredMethods('Albion Online', 'character', null)).toEqual(['f2f', 'market']);
    // The web uses the same module (one source of truth).
    expect(readFileSync(new URL('../../web/src/lib/delivery.ts', import.meta.url), 'utf8')).toMatch(/api\/src\/domain\/delivery/);
    expect(readFileSync(new URL('../src/domain/delivery.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m);
  });

  it('POST /offers and PATCH take deliveryMethods: a non-empty subset of the game’s list', async () => {
    const seller = await makeUser(h, { tier: 2 });
    expect((await seller.api.post('/v1/offers', albion({ deliveryMethods: ['mail'] }))).body.error.code).toBe('invalid_delivery_method');
    expect((await seller.api.post('/v1/offers', albion({ deliveryMethods: [] }))).body.error.code).toBe('invalid_delivery_method');
    const made = await seller.api.post('/v1/offers', albion({ deliveryMethods: ['market'] }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.delivery_methods).toEqual(['market']);
    const patched = await seller.api.patch(`/v1/offers/${made.body.id}`, { version: made.body.version, deliveryMethods: ['f2f', 'market'] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.delivery_methods).toEqual(['f2f', 'market']);
    expect((await seller.api.patch(`/v1/offers/${made.body.id}`, { version: patched.body.version, deliveryMethods: ['uid'] })).body.error.code).toBe('invalid_delivery_method');
    const reset = await seller.api.patch(`/v1/offers/${made.body.id}`, { version: patched.body.version, deliveryMethods: null });
    // Round 25: null stores every method of the game (the market filters on the stored list).
    expect(reset.body.delivery_methods).toEqual(['f2f', 'market']);
    expect((await client(h.app).get(`/v1/offers/${made.body.id}`)).body.delivery_methods).toEqual(['f2f', 'market']);
  });
});

describe('§3 the buyer’s delivery choice on the order', () => {
  it('validates method and fields (city from the list), stores them, and remembers the name only with saveInfo', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const stranger = await makeUser(h);
    const support = await makeUser(h, { role: 'support' });
    const offer = (await seller.api.post('/v1/offers', albion({ deliveryMethods: ['market'] }))).body;
    const order = (b: Record<string, unknown>) => buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, ...b });

    expect((await order({ deliveryMethod: 'f2f', deliveryInfo: { character: 'Hero' } })).body.error.code).toBe('invalid_delivery_method');
    expect((await order({ deliveryMethod: 'market', deliveryInfo: { character: 'Hero' } })).body.error).toMatchObject({ code: 'delivery_info_required', details: { field: 'city' } });
    expect((await order({ deliveryMethod: 'market', deliveryInfo: { character: 'Hero', city: 'Atlantis' } })).body.error.code).toBe('delivery_info_invalid');
    expect((await order({ deliveryMethod: 'market', deliveryInfo: { city: 'Martlock' } })).body.error.code).toBe('delivery_info_required');
    expect((await order({})).body.error.code).toBe('character_name_required');

    const ok = await order({ deliveryMethod: 'market', deliveryInfo: { character: 'Hero', city: 'Martlock', uid: 'ignored' }, saveInfo: false });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.order).toMatchObject({ delivery_method: 'market', delivery_info: { character: 'Hero', city: 'Martlock' }, character_name: 'Hero' });
    expect((await buyer.api.get('/v1/me')).body.user.handover_names).toEqual({}); // saveInfo false: not remembered
    const id = ok.body.order.id;
    for (const viewer of [buyer, seller, support]) {
      expect((await viewer.api.get(`/v1/orders/${id}`)).body).toMatchObject({ delivery_method: 'market', delivery_info: { character: 'Hero', city: 'Martlock' } });
    }
    expect((await stranger.api.get(`/v1/orders/${id}`)).status).toBe(404);
    // The per-viewer serializer drops them from any order row that isn't the viewer's own.
    const row = { buyer_id: buyer.id, seller_id: seller.id, delivery_method: 'market', delivery_info: { city: 'Martlock' }, character_name: 'Hero' };
    expect(stripInternalFields(row, stranger.id)).toEqual({ buyer_id: buyer.id, seller_id: seller.id });
    expect(stripInternalFields(row, null)).toEqual({ buyer_id: buyer.id, seller_id: seller.id });
    expect(stripInternalFields(row, seller.id)).toEqual(row);

    // saveInfo true remembers it; the older characterName alone still works (first offered method that fits).
    expect((await order({ deliveryMethod: 'market', deliveryInfo: { character: 'Hero2', city: 'Caerleon' }, saveInfo: true })).status).toBe(201);
    expect((await buyer.api.get('/v1/me')).body.user.handover_names).toEqual({ 'albion online': 'Hero2' });
    const poe = (await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Path of Exile', title: 'Divines', priceCents: 2_00, deliveryMode: 'manual', stock: 9, attributes: { league: 'Standard', mode: 'Softcore' } })).body;
    const legacy = await buyer.api.post('/v1/orders', { offerId: poe.id, acceptTos: true, characterName: 'OldClient' });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);
    expect(legacy.body.order).toMatchObject({ delivery_method: 'f2f', delivery_info: { character: 'OldClient' }, character_name: 'OldClient' });

    // UID games: the uid field; carts carry the choice per item.
    const server = attributesFor('Genshin Impact', 'top-ups')[0]!.options![0]!;
    const gi = (await seller.api.post('/v1/offers', { categorySlug: 'top-ups', game: 'Genshin Impact', title: 'Crystals', priceCents: 3_00, deliveryMode: 'manual', stock: 9, attributes: { server } })).body;
    expect(gi.id, JSON.stringify(gi)).toBeTruthy();
    const cart = await buyer.api.post('/v1/orders/cart', { acceptTos: true, items: [{ offerId: gi.id, quantity: 1, deliveryMethod: 'uid', deliveryInfo: { uid: '800123456' } }] });
    expect(cart.status, JSON.stringify(cart.body)).toBe(201);
    expect(cart.body.orders[0]).toMatchObject({ delivery_method: 'uid', delivery_info: { uid: '800123456' }, character_name: '800123456' });
    expect(cleanDeliveryChoice(['uid'], 'uid', {}, null)).toMatchObject({ ok: false, code: 'delivery_info_required', field: 'uid' });
  });
});

describe('§4 staff open a dispute from a support ticket', () => {
  it('on the ticket user’s paid order, reason and statement from the ticket, linked both ways, audited, same rules', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const someoneElse = await makeUser(h);
    const support = await makeUser(h, { role: 'support' }); // no disputes.manage
    const arbiter = await makeUser(h, { role: 'arbiter' });
    const lead = await makeUser(h, { role: 'lead' });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, priceCents: 250_00 });
    const order = await buyAndPay(h, buyer, offer.id);
    const unpaid = (await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true })).body.order;
    const ticket = (await buyer.api.post('/v1/support/tickets', { category: 'order', subject: 'Seller never delivered my key', body: 'Paid two hours ago, nothing in the chat since.', orderId: order.id })).body;
    const url = `/v1/admin/support/tickets/${ticket.id}/dispute`;

    expect((await support.api.post(url, {})).status).toBe(403);
    expect((await buyer.api.post(url, {})).status).toBe(403);
    // A ticket without an order: the order must be the customer's own and paid/delivered.
    const loose = (await buyer.api.post('/v1/support/tickets', { category: 'order', subject: 'Problem with an order', body: 'Help please, something went wrong.' })).body;
    expect((await lead.api.post(`/v1/admin/support/tickets/${loose.id}/dispute`, {})).body.error.code).toBe('order_required');
    const elseOrder = await buyAndPay(h, someoneElse, offer.id);
    expect((await lead.api.post(`/v1/admin/support/tickets/${loose.id}/dispute`, { orderId: elseOrder.id })).body.error.code).toBe('not_ticket_order');
    expect((await lead.api.post(`/v1/admin/support/tickets/${loose.id}/dispute`, { orderId: unpaid.id })).body.error.code).toBe('invalid_state');

    const opened = await arbiter.api.post(url, { category: 'not_delivered' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.dispute).toMatchObject({ order_id: order.id, ticket_id: ticket.id, opened_by: buyer.id, opened_by_staff: arbiter.id, reason: 'Seller never delivered my key', category: 'not_delivered', lead_review: true });
    expect(opened.body.ticket).toBeNull(); // arbiters don't read the support queue
    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.status).toBe('disputed');
    expect(view.dispute.statements.map((s: any) => [s.role, s.body])).toEqual([['buyer', 'Paid two hours ago, nothing in the chat since.']]);
    expect(view.dispute).not.toHaveProperty('opened_by_staff');
    expect((await buyer.api.get(`/v1/support/tickets/${ticket.id}`)).body.dispute).toMatchObject({ id: opened.body.dispute.id, status: 'open' });
    const staffTicket = (await lead.api.get(`/v1/admin/support/tickets/${ticket.id}`)).body;
    expect(staffTicket).toMatchObject({ dispute_id: opened.body.dispute.id, priority: 'high' });
    expect(staffTicket.messages.some((m: any) => m.internal && /Dispute opened/.test(m.body))).toBe(true);
    const audit = (await h.ctx.db.query(`SELECT actor_id FROM admin_audit_log WHERE action = 'dispute.open_from_ticket' AND target_id = $1`, [opened.body.dispute.id])).rows;
    expect(audit).toEqual([{ actor_id: arbiter.id }]);
    expect((await lead.api.get('/v1/admin/disputes')).body.find((d: any) => d.id === opened.body.dispute.id)).toMatchObject({ ticket_id: ticket.id, lead_review: true });

    // Once only; escrow frozen like any dispute, and above $200 only the Lead decides.
    expect((await lead.api.post(url, {})).body.error.code).toBe('ticket_has_dispute');
    expect((await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'late' })).status).toBe(409);
    expect((await arbiter.api.post(`/v1/admin/disputes/${opened.body.dispute.id}/resolve`, { outcome: 'buyer', note: 'No delivery' })).status).toBe(403);
    expect((await lead.api.post(`/v1/admin/disputes/${opened.body.dispute.id}/resolve`, { outcome: 'buyer', note: 'No delivery' })).status).toBe(200);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('refunded');
    // The buyer endpoint still works for older clients.
    const o2 = await buyAndPay(h, buyer, offer.id);
    expect((await buyer.api.post(`/v1/orders/${o2.id}/dispute`, { reason: 'Still not delivered after hours', category: 'not_delivered' })).status).toBe(200);
  });

  it('the chat "Stay safe" text says to contact support (EN and AR)', async () => {
    const en = (await client(h.app).get('/v1/texts/chat_safety?lang=en')).body.body;
    const ar = (await client(h.app).get('/v1/texts/chat_safety?lang=ar')).body.body;
    expect(en).toContain('If something is wrong, contact support.');
    expect(en).not.toMatch(/open a dispute/i);
    expect(ar).toContain('في مشكلة؟ تواصل مع الدعم.');
    expect(ar).not.toContain('افتح نزاعًا');
  });

  it('the withdrawal fee quote answers an empty or zero amount with a clear 400', async () => {
    const seller = await makeUser(h, { tier: 2 });
    for (const q of ['', '?amountCents=', '?amountCents=0', '?amountCents=abc', '?amountCents=-5']) {
      const r = await seller.api.get(`/v1/seller/withdrawals/quote${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code, q).toBe('amount_required');
    }
    expect((await seller.api.get('/v1/seller/withdrawals/quote?amountCents=10000')).body).toMatchObject({ amountCents: 10000 });
  });
});

describe('§6 no phone anywhere', () => {
  it('sign up, verify the email, then buy, pass the rules test, sell and post a request with no phone', async () => {
    const email = `nophone_${Date.now()}@example.com`;
    const reg = await client(h.app).post('/v1/auth/register', { email, password: 'correct horse battery', displayName: 'No Phone', acceptTerms: true });
    expect(reg.status).toBe(201);
    const api = client(h.app, reg.body.token);
    const blocked = await api.post('/v1/orders', { offerId: '00000000-0000-0000-0000-000000000000', acceptTos: true });
    expect(blocked.body.error).toMatchObject({ code: 'kyc_required', message: 'Verify your email first.' });
    await api.post('/v1/verify/email/send');
    const code = /(\d{6})/.exec(h.messenger.lastTo(email)!.body)![1];
    const confirmed = await api.post('/v1/verify/email/confirm', { code });
    expect(confirmed.body.user).toMatchObject({ kyc_tier: 1, phone_verified_at: null });

    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 3 });
    expect((await api.post('/v1/orders', { offerId: offer.id, acceptTos: true })).status).toBe(201);
    expect((await api.post('/v1/requests', { game: 'Albion Online', categorySlug: 'currency', title: 'Need 50M silver', description: 'Europe server please', budgetCents: 20_00 })).status).not.toBe(403);

    const support = await makeUser(h, { role: 'support' });
    const right = Object.fromEntries((await support.api.get('/v1/admin/rules-test')).body.questions.filter((q: any) => q.active).map((q: any) => [q.id, q.correct]));
    expect((await api.post('/v1/seller/rules-test', { answers: right })).body.passed).toBe(true);
    const listed = await api.post('/v1/offers', albion());
    expect(listed.status, JSON.stringify(listed.body)).toBe(201);
    expect((await api.get('/v1/seller/onboarding')).body).toMatchObject({ tier1: true });
  });

  it('every tier-1 error says email only; migration 079 makes every verified email level 1', async () => {
    const u = await makeUser(h, { tier: 0 });
    expect((await u.api.post('/v1/seller/rules-test', { answers: {} })).body.error).toMatchObject({ code: 'tier1_required', message: 'Verify your email first.' });
    expect((await u.api.post('/v1/kyc/start', { level: 'tier2_individual' })).body.error.message).toBe('Verify your email first.');
    for (const f of ['src/domain/orders.ts', 'src/domain/offers.ts', 'src/domain/onboarding.ts', 'src/domain/requests.ts', 'src/domain/users.ts']) {
      expect(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), f).not.toMatch(/email and phone|email \+ phone/);
    }
    await h.ctx.db.query('UPDATE users SET kyc_tier = 0, email_verified_at = now(), phone_verified_at = NULL WHERE id = $1', [u.id]);
    const sql = readFileSync(new URL('../migrations/079_round24.sql', import.meta.url), 'utf8');
    await h.ctx.db.query(sql.split('\n').filter((l) => l.startsWith('UPDATE users SET kyc_tier = 1')).join('\n'));
    expect((await h.ctx.db.query('SELECT kyc_tier FROM users WHERE id = $1', [u.id])).rows[0].kyc_tier).toBe(1);
  });

  it('production starts with no SMS settings (SMS off, nothing logged); console stays refused', async () => {
    const prod = {
      NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), DATA_ENCRYPTION_KEYS: 'v1:Y2ktb25seS1kYXRhLWtleS0zMi1ieXRlcy0tLS0tLS0=', FINGERPRINT_KEY: 'fp',
      CRYPTO_INDEXER_SECRET: 'idx', PLATFORM_ACCOUNTS: 'live', MALWARE_SCANNER: 'clamd', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test',
      TURNSTILE_SECRET: '1x0000000000000000000000000000000AA', ORIGIN_SHARED_SECRET: 'origin-secret-of-at-least-32-characters!',
    } as any;
    const cfg = loadConfig(prod);
    expect(cfg.SMS_PROVIDER).toBe('none');
    expect(() => loadConfig({ ...prod, SMS_PROVIDER: 'console' })).toThrow(/SMS_PROVIDER=console/);
    expect(loadConfig({} as any).SMS_PROVIDER).toBe('console'); // development and tests
    const lines: string[] = [];
    const ctx = createContext(cfg, { info: (o: any, m?: string) => lines.push(String(m ?? o)), warn() {}, error() {} } as any, { db: h.ctx.db, dbRead: h.ctx.dbRead, pubsub: h.ctx.pubsub, views: h.ctx.views });
    await expect(ctx.messenger.send({ channel: 'sms', to: '+14155550123', body: 'Your code is 123456' })).rejects.toThrow(/SMS is not configured/);
    expect(lines.join('\n')).not.toContain('123456');

    // With SMS off the dormant phone path answers clearly; nothing else asks for a phone.
    const cfgNow = h.ctx.cfg as { SMS_PROVIDER: string };
    cfgNow.SMS_PROVIDER = 'none';
    try {
      const u = await makeUser(h);
      expect((await u.api.post('/v1/verify/sms/send', { phone: '+14155550123' })).body.error.code).toBe('sms_unavailable');
    } finally {
      cfgNow.SMS_PROVIDER = 'console';
    }
  });

  it('a payout address is confirmed by email link + emailed code even with a verified phone (never SMS)', async () => {
    const seller = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`UPDATE users SET phone = '+201012345678', phone_verified_at = now() WHERE id = $1`, [seller.id]);
    const before = h.messenger.outbox.length;
    expect((await seller.api.post('/v1/seller/payout-address', { address: 'TNoSmsAddress1234567890', currency: 'usdttrc20' })).status).toBe(200);
    expect(h.messenger.outbox.slice(before).some((m) => m.channel === 'sms')).toBe(false);
    const row = (await h.ctx.db.query('SELECT code_via FROM payout_address_changes WHERE user_id = $1', [seller.id])).rows[0];
    expect(row.code_via).toBe('email');
  });
});
