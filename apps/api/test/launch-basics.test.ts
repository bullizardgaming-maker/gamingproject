import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchEmails } from '../src/domain/notifications.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { MockPaymentProvider } from '../src/providers/payments/mock.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const PASSWORD = 'correct horse battery';
const emailsTo = async (email: string) => {
  await dispatchEmails(h.ctx);
  return (h.messenger.outbox as any[]).filter((m) => m.channel === 'email' && m.to === email);
};

describe('password reset', () => {
  it('resets via a single-use emailed link and signs out every device', async () => {
    const u = await makeUser(h, { tier: 1 });
    const anon = client(h.app);
    // Same response whether or not the account exists.
    expect((await anon.post('/v1/auth/password/forgot', { email: 'nobody@example.com' })).status).toBe(202);
    expect((await anon.post('/v1/auth/password/forgot', { email: u.email })).status).toBe(202);

    const mail = (await emailsTo(u.email)).find((m) => m.subject === 'Reset your Bullizard password');
    const token = new URL(/https?:\/\/\S+reset-password\?token=\S+/.exec(mail.body)![0]).searchParams.get('token')!;

    expect((await anon.post('/v1/auth/password/reset', { token: 'x'.repeat(40), newPassword: 'brand new password' })).status).toBe(400);
    expect((await anon.post('/v1/auth/password/reset', { token, newPassword: 'brand new password' })).status).toBe(200);
    expect((await anon.post('/v1/auth/password/reset', { token, newPassword: 'another new password' })).status).toBe(400);

    expect((await u.api.get('/v1/me')).status).toBe(401); // old session gone
    expect((await anon.post('/v1/auth/login', { email: u.email, password: PASSWORD })).status).toBe(401);
    expect((await anon.post('/v1/auth/login', { email: u.email, password: 'brand new password' })).status).toBe(200);
  });

  it('limits reset emails to 3 per hour per account', async () => {
    const u = await makeUser(h, { tier: 1 });
    for (let i = 0; i < 5; i++) await client(h.app).post('/v1/auth/password/forgot', { email: u.email });
    const n = await h.ctx.db.query('SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1', [u.id]);
    expect(n.rows[0].n).toBe(3);
  });
});

describe('phone verification rules', () => {
  it('rejects VoIP numbers and numbers already verified on another account', async () => {
    const a = await makeUser(h, { tier: 0 });
    const b = await makeUser(h, { tier: 0 });
    expect((await a.api.post('/v1/verify/sms/send', { phone: '+15550001111' })).body.error.code).toBe('phone_not_supported');

    await a.api.post('/v1/verify/sms/send', { phone: '+14155559876' });
    const code = /(\d{6})/.exec(h.messenger.lastTo('+14155559876')!.body)![1];
    expect((await a.api.post('/v1/verify/sms/confirm', { code })).status).toBe(200);
    expect((await b.api.post('/v1/verify/sms/send', { phone: '+14155559876' })).body.error.code).toBe('phone_in_use');
  });
});

describe('reviews and seller ratings', () => {
  it('lets buyers review completed orders once and shows the rating on listings and the seller profile', async () => {
    const seller = await makeUser(h, { tier: 2, device: 'seller-pc' });
    const offer = await makeOffer(seller, { title: 'Reviewed key' });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'A\nB\nC' });

    const ratings = [5, 4];
    for (const rating of ratings) {
      const buyer = await makeUser(h, { tier: 1 });
      const order = await buyAndPay(h, buyer, offer.id);
      expect((await buyer.api.post(`/v1/orders/${order.id}/review`, { rating })).body.error.code).toBe('not_completed');
      await buyer.api.post(`/v1/orders/${order.id}/confirm`);
      const r = await buyer.api.post(`/v1/orders/${order.id}/review`, { rating, comment: 'Instant delivery, worked first time' });
      expect(r.status).toBe(201);
      expect((await buyer.api.post(`/v1/orders/${order.id}/review`, { rating: 1 })).body.error.code).toBe('already_reviewed');
      if (rating === 5) {
        expect((await seller.api.post(`/v1/reviews/${r.body.id}/reply`, { reply: 'Thanks!' })).status).toBe(200);
        expect((await seller.api.post(`/v1/reviews/${r.body.id}/reply`, { reply: 'Again' })).body.error.code).toBe('already_replied');
        expect((await buyer.api.post(`/v1/reviews/${r.body.id}/reply`, { reply: 'x' })).status).toBe(403);
      }
    }

    const listing = (await client(h.app).get(`/v1/offers/${offer.id}`)).body;
    expect(listing.seller_rating).toBe(4.5);
    expect(listing.seller_review_count).toBe(2);
    const profile = (await client(h.app).get(`/v1/sellers/${seller.id}`)).body;
    expect(profile.rating).toMatchObject({ count: 2, average: 4.5, positive_pct: 100 });
    expect(profile.reviews[1].seller_reply).toBe('Thanks!');
    expect((await emailsTo(seller.email)).some((m) => m.subject === 'New 5-star review')).toBe(true);
  });

  it('hides reviews from accounts linked to the seller and rejects contact details', async () => {
    const seller = await makeUser(h, { tier: 2, device: 'shared-laptop' });
    const sock = await makeUser(h, { tier: 1, device: 'shared-laptop' });
    const offer = await makeOffer(seller, { title: 'Sock puppet test' });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'S1\nS2' });
    const order = await buyAndPay(h, sock, offer.id);
    // Shared device freezes the escrow; an admin clears it to let the order complete.
    await h.ctx.db.query('UPDATE orders SET escrow_frozen = false WHERE id = $1', [order.id]);
    if ((await sock.api.get(`/v1/orders/${order.id}`)).body.status === 'paid') await seller.api.post(`/v1/orders/${order.id}/deliver`);
    await sock.api.post(`/v1/orders/${order.id}/confirm`);
    expect((await sock.api.post(`/v1/orders/${order.id}/review`, { rating: 5, comment: 'add me on discord' })).body.error.code).toBe('offplatform_contact');
    const r = await sock.api.post(`/v1/orders/${order.id}/review`, { rating: 5, comment: 'Best seller ever' });
    expect(r.body).toMatchObject({ hidden: true, hidden_reason: 'linked_accounts' });
    expect((await client(h.app).get(`/v1/sellers/${seller.id}`)).body.rating.count).toBe(0);
  });
});

describe('money reconciliation', () => {
  it('passes when books balance and matches the PSP balance net of fees and payouts', async () => {
    const mock = h.ctx.payments as MockPaymentProvider;
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { title: 'Recon key', priceCents: 100_00 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'R1' });
    const order = await buyAndPay(h, buyer, offer.id, 1, { feeCents: '320' });
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);

    mock.balanceOverride = null;
    const base = await runReconciliation(h.ctx);
    const expected = base.report.psp.expected;

    mock.balanceOverride = expected;
    const ok = await runReconciliation(h.ctx);
    expect(ok.status).toBe('ok');
    expect(ok.report.issues).toEqual([]);

    mock.balanceOverride = expected - 1_500; // money missing at the PSP
    const bad = await runReconciliation(h.ctx);
    expect(bad.status).toBe('mismatch');
    expect(bad.report.issues[0]).toMatchObject({ check: 'psp_balance_mismatch', detail: { difference: -1_500 } });
    mock.balanceOverride = null;
  });

  it('detects an order whose escrow does not match its state and alerts admins', async () => {
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, buyer, offer.id);
    // Corrupt state behind the ledger's back: marked completed but money still in escrow.
    await h.ctx.db.query(`UPDATE orders SET status = 'completed' WHERE id = $1`, [order.id]);
    const run = await runReconciliation(h.ctx);
    expect(run.status).toBe('mismatch');
    expect(run.report.issues.find((i) => i.check === 'order_escrow_mismatch')!.detail).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: order.id, held: 10_00 })]),
    );
    expect((await emailsTo(admin.email)).some((m) => m.subject.startsWith('Reconciliation mismatch'))).toBe(true);
    await h.ctx.db.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
    const list = await admin.api.get('/v1/admin/reconciliation');
    expect(list.body.length).toBeGreaterThan(0);
  });
});

describe('GDPR export and deletion', () => {
  it('exports personal data', async () => {
    const u = await makeUser(h, { tier: 1 });
    const res = await u.api.get('/v1/me/export');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body.profile.email).toBe(u.email);
    expect(res.body.sign_in_history.length).toBeGreaterThan(0);
  });

  it('refuses deletion with open orders or a balance, then anonymises and signs out', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, buyer, offer.id);

    expect((await buyer.api.post('/v1/me/delete', { password: 'wrong' })).status).toBe(401);
    expect((await buyer.api.post('/v1/me/delete', { password: PASSWORD })).body.error.code).toBe('open_orders');
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);
    expect((await seller.api.post('/v1/me/delete', { password: PASSWORD })).body.error.code).toBe('balance_remaining');

    expect((await buyer.api.post('/v1/me/delete', { password: PASSWORD })).status).toBe(200);
    expect((await buyer.api.get('/v1/me')).status).toBe(401);
    expect((await client(h.app).post('/v1/auth/login', { email: buyer.email, password: PASSWORD })).status).toBe(401);
    const row = (await h.ctx.db.query('SELECT email, display_name, phone, deleted_at FROM users WHERE id = $1', [buyer.id])).rows[0];
    expect(row.email).toMatch(/@deleted\.invalid$/);
    expect(row.display_name).toBe('Deleted user');
    // Financial record and chat evidence are retained, linked to the anonymised account.
    expect((await seller.api.get(`/v1/orders/${order.id}`)).body.buyer_name).toBe('Deleted user');
    const chain = await seller.api.get(`/v1/chat/rooms/${(await seller.api.get(`/v1/orders/${order.id}`)).body.room_id}/verify`);
    expect(chain.body.valid).toBe(true);
    // The email address can be registered again.
    expect((await client(h.app).post('/v1/auth/register', { email: buyer.email, password: PASSWORD, displayName: 'Back again' })).status).toBe(201);
  });
});
