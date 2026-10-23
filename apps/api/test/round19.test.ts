import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { detectOffPlatform as scan, detectSplit, isInstantBan } from '../src/domain/safety.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('legal documents', () => {
  it('serves every document with a version, keeps history, and sign-up records the Terms version', async () => {
    for (const doc of ['terms', 'privacy', 'seller-agreement', 'refunds', 'restricted-countries']) {
      const r = await client(h.app).get(`/v1/legal/${doc}`);
      expect(r.status, doc).toBe(200);
      expect(r.body).toMatchObject({ doc, locale: 'en', version: '2026-10-24' });
      expect(r.body.sha256).toHaveLength(64);
    }
    expect((await client(h.app).get('/v1/legal/cookies')).status).toBe(400);
    expect((await client(h.app).get('/v1/legal/terms?lang=ar')).body.locale).toBe('en');

    // Sign-up without the checkbox is refused; with it, the current version is stored.
    const email = `tos_${Date.now()}@example.com`;
    const refused = await client(h.app).post('/v1/auth/register', { email, password: 'correct horse battery', displayName: 'No box' });
    expect(refused.status).toBe(400);
    const u = await makeUser(h);
    const mine = (await u.api.get('/v1/me/legal')).body;
    expect(mine).toMatchObject({ tosVersion: '2026-10-24', currentVersion: '2026-10-24', reacceptanceRequired: false });
    expect(mine.acceptedAt).toBeTruthy();
    expect((await client(h.app).get('/v1/features')).body.legal).toEqual({ tosVersion: '2026-10-24', notice: null });

    // Staff publish a material change: 14 days' notice is enforced, the banner appears, users are emailed once.
    const admin = await makeUser(h, { role: 'admin' });
    const soon = await admin.api.put('/v1/admin/legal/terms', { version: '2026-11-01', title: 'Terms', contentMd: '# Terms v2\n\nLonger body text.', material: true, effectiveAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(soon.body.error.code).toBe('notice_required');
    const effectiveAt = new Date(Date.now() + 15 * 86_400_000).toISOString();
    const pub = await admin.api.put('/v1/admin/legal/terms', { version: '2026-11-08', title: 'Terms', contentMd: '# Terms v2\n\nLonger body text.', material: true, effectiveAt });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect((await client(h.app).get('/v1/features')).body.legal.notice).toMatchObject({ version: '2026-11-08' });
    expect((await client(h.app).get('/v1/legal/terms')).body.version).toBe('2026-10-24'); // not in force yet
    const history = (await client(h.app).get('/v1/legal/terms/history')).body;
    expect(history.map((v: any) => v.version)).toEqual(['2026-11-08', '2026-10-24']);
    expect((await client(h.app).get('/v1/legal/terms/versions/2026-11-08')).body.content_md).toBe('# Terms v2\n\nLonger body text.');
    const emails = await h.ctx.db.query(`SELECT count(*)::int AS n FROM notifications WHERE template = 'legal_change' AND user_id = $1`, [u.id]);
    expect(emails.rows[0].n).toBe(1);

    // Once in force, users who accepted the old version must accept again; orders carry the version.
    await h.ctx.db.query(`UPDATE legal_documents SET effective_at = now() WHERE version = '2026-11-08'`);
    expect((await u.api.get('/v1/me/legal')).body).toMatchObject({ currentVersion: '2026-11-08', reacceptanceRequired: true });
    expect((await u.api.post('/v1/me/legal/accept', {})).body.tosVersion).toBe('2026-11-08');
    expect((await u.api.get('/v1/me/legal')).body.reacceptanceRequired).toBe(false);
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, u, offer.id);
    expect((await u.api.get(`/v1/orders/${order.id}`)).body.tos_version).toBe('2026-11-08');
    const paid = await h.ctx.db.query(`SELECT data FROM notifications WHERE template = 'order_paid' AND user_id = $1`, [u.id]);
    expect(paid.rows[0].data.tos_version).toBe('2026-11-08');
  });
});

describe('dispute decisions', () => {
  it('splits an order: part to the buyer’s balance, the rest to the seller', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const arbiter = await makeUser(h, { tier: 2, role: 'arbiter' });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 2, priceCents: 100_00 });
    const order = await buyAndPay(h, buyer, offer.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'half of it' });
    const d = (await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Only half arrived', category: 'not_as_described' })).body;
    expect((await arbiter.api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome: 'split', note: 'Half delivered' })).status).toBe(400);
    const res = await arbiter.api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome: 'split', refundCents: 40_00, note: 'Half delivered, half refunded' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(40_00);
    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.status).toBe('completed');
    expect(view.dispute).toMatchObject({ status: 'resolved_split', refund_cents: 40_00 });
    const sellerBal = await h.ctx.db.query(
      `SELECT COALESCE(SUM(e.amount_cents), 0)::int AS cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'seller_available' AND a.owner_id = $1`, [seller.id],
    );
    // The released 60% of the gross carries its share of the commission; the seller gets the rest.
    const full = (await h.ctx.db.query('SELECT commission_cents FROM orders WHERE id = $1', [order.id])).rows[0];
    const released = order.amount_cents - 40_00;
    expect(sellerBal.rows[0].cents).toBe(released - Math.round((Number(full.commission_cents) * released) / order.amount_cents));
    expect((await buyer.api.get(`/v1/chat/rooms/${view.room_id}/messages`)).body.some((m: any) => m.code === 'dispute_buyer' && m.params?.split)).toBe(true);
    // Both sides get the decision email with their own wording.
    const mails = await h.ctx.db.query(`SELECT user_id, data FROM notifications WHERE template = 'dispute_resolved' AND data->>'order_id' = $1`, [order.id]);
    expect(mails.rowCount).toBe(2);
  });

  it('flags orders above $200 for the Lead in staff lists', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const arbiter = await makeUser(h, { tier: 2, role: 'arbiter' });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 2, priceCents: 250_00 });
    const order = await buyAndPay(h, buyer, offer.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
    await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Not received', category: 'not_delivered' });
    const row = (await arbiter.api.get('/v1/admin/disputes')).body.find((x: any) => x.order_id === order.id);
    expect(row.lead_review).toBe(true);
    expect((await arbiter.api.get(`/v1/orders/${order.id}`)).body.lead_review).toBe(true);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body).not.toHaveProperty('lead_review');
  });
});

describe('listing ban and appeals', () => {
  it('stops a listing-banned seller from listing until staff lift it; users can open an appeal ticket', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const support = await makeUser(h, { role: 'support' });
    const offer = await makeOffer(seller, { stock: 3 });
    const ban = await support.api.post(`/v1/admin/users/${seller.id}/listing-ban`, { on: true, reason: 'Repeated misdescribed items' });
    expect(ban.status, JSON.stringify(ban.body)).toBe(200);
    expect((await seller.api.post('/v1/offers', { categorySlug: 'keys', game: 'Test Game', title: 'Another', priceCents: 5_00, deliveryMode: 'auto' })).body.error.code).toBe('listing_banned');
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.status).toBe('paused'); // existing listings come down too
    expect((await seller.api.get('/v1/me')).body.user.listing_banned_at).toBeTruthy();
    const t = await seller.api.post('/v1/support/tickets', { category: 'appeal', subject: 'Appeal my listing ban', body: 'I have fixed the listings; please review.' });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.category).toBe('appeal');
    expect((await support.api.post(`/v1/admin/users/${seller.id}/listing-ban`, { on: false, reason: 'Appeal accepted' })).status).toBe(200);
    expect((await seller.api.get('/v1/me')).body.user.listing_banned_at).toBeNull();
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.status).toBe('active');
  });
});

describe('chat filter additions', () => {
  it('catches local phones, wallets, Egyptian wallets, other marketplaces, look-alikes and split messages', () => {
    expect(scan('call me 01012345678')).toContain('phone_number');
    expect(scan('رقمي ٠١٠١٢٣٤٥٦٧٨')).toContain('phone_number');
    expect(scan('send to 0x52908400098527886E0F7030069857D2E4169EE7')).toContain('wallet_address');
    expect(scan('TRX: TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9')).toContain('wallet_address');
    expect(scan('ابعت فودافون كاش')).toContain('external_payment');
    expect(scan('fawry or instapay is fine')).toContain('external_payment');
    expect(scan('cheaper on g2g, same item')).toContain('other_marketplace');
    expect(scan('whаtsаpp me')).toContain('whatsapp'); // Cyrillic а
    expect(detectSplit(['what', 'sa'], 'pp me')).toContain('whatsapp');
    expect(detectSplit(['hello'], 'thanks')).toEqual([]);
    expect(isInstantBan(['external_payment'])).toBe(true);
    expect(isInstantBan(['whatsapp'])).toBe(false);
    expect(scan('the EU version ships Monday')).toEqual([]);
  });

  it('bans at once for payment details and suspends after the ladder for contact sharing', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, buyer, offer.id);
    const { room_id } = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    const blocked = await seller.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'Pay me on instapay next time, no fee' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.action).toBe('ban');
    const u = await h.ctx.db.query('SELECT status, suspension_reason FROM users WHERE id = $1', [seller.id]);
    expect(u.rows[0]).toMatchObject({ status: 'suspended', suspension_reason: 'off_platform_ban' });
    // A split platform name across two messages is caught on the second one.
    expect((await buyer.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'you on wh' })).status).toBe(201);
    const second = await buyer.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'atsapp later' });
    expect(second.status).toBe(422);
  });
});

describe('rules test in Arabic', () => {
  it('serves the 13 deck questions in Arabic with a 90% pass mark', async () => {
    const u = await makeUser(h, { tier: 1 });
    const en = (await u.api.get('/v1/seller/rules-test')).body;
    expect(en.passMarkPct).toBe(90);
    expect(en.questions).toHaveLength(13);
    const ar = (await u.api.get('/v1/seller/rules-test?lang=ar')).body;
    expect(ar.locale).toBe('ar');
    expect(ar.questions[0].question).not.toBe(en.questions[0].question);
    expect(/[؀-ۿ]/.test(ar.questions[0].question)).toBe(true);
    const support = await makeUser(h, { role: 'support' });
    const admin = (await support.api.get('/v1/admin/rules-test')).body;
    const right = Object.fromEntries(admin.questions.filter((q: any) => q.active).map((q: any) => [q.id, q.correct]));
    // One wrong out of 13 is 92% → pass; two wrong is 84% → fail.
    const ids = Object.keys(right);
    const oneWrong = { ...right, [ids[0]]: (right[ids[0]] + 1) % 3 };
    const twoWrong = { ...oneWrong, [ids[1]]: (right[ids[1]] + 1) % 3 };
    const failed = (await u.api.post('/v1/seller/rules-test', { answers: twoWrong, lang: 'ar' })).body;
    expect(failed.passed).toBe(false);
    expect(/[؀-ۿ]/.test(failed.results.find((r: any) => !r.correct).explanation)).toBe(true);
    expect((await u.api.post('/v1/seller/rules-test', { answers: oneWrong })).body.passed).toBe(true);
  });
});

describe('money rules', () => {
  it('a referral pays only after the friend’s first completed order', async () => {
    const referrer = await makeUser(h, { tier: 1 });
    const { code } = (await referrer.api.get('/v1/me/referral')).body;
    const reg = await client(h.app).post('/v1/auth/register', { email: `ref_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Referred', referralCode: code, acceptTerms: true });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const friend = { id: reg.body.user.id, api: client(h.app, reg.body.token) };
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1`, [friend.id]);
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, priceCents: 50_00 });
    const first = await buyAndPay(h, friend, offer.id);
    await seller.api.post(`/v1/orders/${first.id}/deliver`, { payload: 'one' });
    await buyer_confirm(friend, first.id);
    const rewards = () => h.ctx.db.query(`SELECT count(*)::int AS n FROM referral_rewards WHERE referrer_id = $1 AND status = 'granted'`, [referrer.id]).then((r) => r.rows[0].n);
    expect(await rewards()).toBe(0);
    const second = await buyAndPay(h, friend, offer.id);
    await seller.api.post(`/v1/orders/${second.id}/deliver`, { payload: 'two' });
    await buyer_confirm(friend, second.id);
    expect(await rewards()).toBe(1);
  });
});

async function buyer_confirm(buyer: { api: ReturnType<typeof client> }, orderId: string) {
  const r = await buyer.api.post(`/v1/orders/${orderId}/confirm`);
  if (r.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(r.body)}`);
}
