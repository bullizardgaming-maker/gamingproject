import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { FakeNow } from './fakeNowPayments.js';
import { ACCOUNT_R22B, DEPOSIT_R22B, OWN_DEPOSIT_DELIVERED, OWN_DEPOSIT_WITH_CONTACT } from './fixtures/chat-phrases.js';
import { recheckUnknownPayouts } from '../src/domain/cryptoPayouts.js';
import { decideTreasuryWithdrawal } from '../src/domain/treasury.js';
import { forgetControlsCache } from '../src/domain/controls.js';
import { withTx } from '../src/db.js';
import { accountId, post } from '../src/domain/ledger.js';

/** Round 22b: follow-ups to Round 22 (double payout, false automatic bans, unsupported coins, minor money items). */
const IPN_SECRET = 'ipn-secret-round22b';
const MIGRATION = readFileSync(new URL('../migrations/070_round22b.sql', import.meta.url), 'utf8');
let h: Harness;
let fake: FakeNow;

beforeAll(async () => {
  fake = new FakeNow();
  const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', email: 'e', password: 'p', twoFactorSecret: 'JBSWY3DPEHPK3PXP', fetch: fake.fetch as any });
  h = await setup({ PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET }, { payments });
});
afterAll(async () => h.close());

async function ipn(body: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: JSON.stringify(sortDeep(body)) });
}
const paidIpn = (p: any) => ({
  payment_id: Number(p.payment_id), payment_status: 'finished', pay_address: p.pay_address, price_amount: p.price_amount, price_currency: 'usd',
  pay_amount: p.pay_amount, actually_paid: p.pay_amount, actually_paid_at_fiat: p.price_amount, pay_currency: p.pay_currency, order_id: p.order_id,
  purchase_id: p.purchase_id, outcome_amount: p.price_amount, outcome_currency: 'usdttrc20',
});
const available = async (userId: string) =>
  Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'seller_available' AND a.owner_id = $1`, [userId])).rows[0].s);
const row = async (id: string) => (await h.ctx.db.query('SELECT * FROM withdrawals WHERE id = $1', [id])).rows[0];

async function cryptoOrder(buyer: { api: any }, offerId: string, pay = true) {
  const order = (await buyer.api.post('/v1/orders', { offerId, quantity: 1, acceptTos: true })).body.order;
  const p = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
  const raw = fake.payments.get(p.payment_id);
  if (pay) expect((await ipn(paidIpn(raw))).statusCode).toBe(200);
  return { order, raw };
}
async function sellerWithSales(n = 1, priceCents = 100_00) {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 20, categorySlug: 'currency', title: 'Gold', priceCents });
  for (let i = 0; i < n; i++) {
    const { order } = await cryptoOrder(buyer, offer.id);
    await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
  }
  await h.ctx.db.query(`UPDATE users SET payout_hold_days = 0, payout_address = 'TRound22bSeller123456789a', payout_address_currency = 'usdttrc20', payout_address_set_at = now() WHERE id = $1`, [seller.id]);
  return { seller, buyer, offer };
}
/** Books an approval the way decideWithdrawal does, without handing it to the provider (a deferred send). */
async function approveWithoutSending(id: string, over = '') {
  await withTx(h.ctx.db, async (tx) => {
    const w = (await tx.query(`UPDATE withdrawals SET status = 'processing', decided_at = now() - interval '1 hour', updated_at = now() - interval '1 hour'${over} WHERE id = $1 RETURNING *`, [id])).rows[0];
    await post(tx, [
      { account: await accountId(tx, 'withdrawals_pending', w.currency), amountCents: -Number(w.amount_cents) },
      { account: await accountId(tx, 'payouts', w.currency), amountCents: Number(w.net_cents) },
      { account: await accountId(tx, 'treasury', w.currency), amountCents: Number(w.fee_cents) },
    ], `withdrawal_approved:${id}`);
  });
}

describe('1. a payout is never sent twice', () => {
  it('the migration backfills the attempt for withdrawals with provider ids, and the job polls them instead of sending', async () => {
    const { seller } = await sellerWithSales(1);
    const cfo = await makeUser(h, { role: 'finance' });
    const w = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 20_00 })).body;
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: true })).body.status).toBe('processing');
    expect(fake.payoutPosts.filter((x) => x === w.id)).toHaveLength(1);
    // A row from before Round 22: provider ids stored, no attempt recorded.
    await h.ctx.db.query(`UPDATE withdrawals SET provider_attempted_at = NULL, decided_at = now() - interval '1 hour', updated_at = now() - interval '1 hour', last_polled_at = NULL WHERE id = $1`, [w.id]);
    await h.ctx.db.query(MIGRATION);
    expect((await row(w.id)).provider_attempted_at).toBeTruthy();
    // Even without the backfill, provider ids alone stop a send: the job polls the payout.
    await h.ctx.db.query(`UPDATE withdrawals SET provider_attempted_at = NULL, last_polled_at = NULL WHERE id = $1`, [w.id]);
    await recheckUnknownPayouts(h.ctx);
    expect(fake.payoutPosts.filter((x) => x === w.id)).toHaveLength(1);
    expect(fake.payoutGets).toContain(String((await row(w.id)).payout_id));
  });

  it('two job runs at once never both send or both poll the same withdrawal', async () => {
    const { seller } = await sellerWithSales(1);
    const cfo = await makeUser(h, { role: 'finance' });
    // A: approved but never handed over (deferred). B: handed over, its IPN never came (polled).
    const a = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 11_00 })).body;
    await approveWithoutSending(a.id);
    const b = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 12_00 })).body;
    expect((await cfo.api.post(`/v1/admin/withdrawals/${b.id}/decide`, { approve: true })).body.status).toBe('processing');
    await h.ctx.db.query(`UPDATE withdrawals SET provider_attempted_at = now() - interval '1 hour', last_polled_at = NULL WHERE id = $1`, [b.id]);
    const bPayout = String((await row(b.id)).payout_id);
    const getsBefore = fake.payoutGets.filter((x) => x === bPayout).length;
    await Promise.all([recheckUnknownPayouts(h.ctx), recheckUnknownPayouts(h.ctx), recheckUnknownPayouts(h.ctx)]);
    expect(fake.payoutPosts.filter((x) => x === a.id)).toHaveLength(1);
    expect(fake.payoutGets.filter((x) => x === bPayout).length - getsBefore).toBe(1);
    expect((await row(a.id)).status).toBe('processing');
    // And a later run doesn't send A again (it has an attempt and provider ids now).
    await h.ctx.db.query(`UPDATE withdrawals SET last_polled_at = NULL, provider_attempted_at = now() - interval '1 hour' WHERE id = $1`, [a.id]);
    await recheckUnknownPayouts(h.ctx);
    expect(fake.payoutPosts.filter((x) => x === a.id)).toHaveLength(1);
  });
});

describe('2-5. false automatic bans', () => {
  it('a message with our own deposit address is delivered (the rest still checked); an unknown address is queued; only an offered own wallet bans', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 10_00 });
    const { order } = await cryptoOrder(buyer, offer.id, false);
    await h.ctx.db.query('UPDATE crypto_payments SET pay_address = $2 WHERE order_id = $1', [order.id, DEPOSIT_R22B]);
    const room = (await buyer.api.post('/v1/chat/rooms', { offerId: offer.id })).body.id;
    for (const body of OWN_DEPOSIT_DELIVERED) {
      const r = await buyer.api.post(`/v1/chat/rooms/${room}/messages`, { body });
      expect(r.status, `${body}: ${JSON.stringify(r.body)}`).toBe(201);
    }
    const q = await buyer.api.post(`/v1/chat/rooms/${room}/messages`, { body: 'Should I send USDT to 0x52908400098527886E0F7030069857D2E4169EE7?' });
    expect(q.status).toBe(422);
    expect(q.body.error.details.action).toBe('queue');
    expect((await h.ctx.db.query('SELECT status, offplatform_strikes FROM users WHERE id = $1', [buyer.id])).rows[0]).toMatchObject({ status: 'active', offplatform_strikes: 0 });
    const other = await makeUser(h, { tier: 1 });
    const { order: o2 } = await cryptoOrder(other, offer.id, false); // before the seller's ban takes the listing down
    const r = await seller.api.post(`/v1/chat/rooms/${room}/messages`, { body: 'pay me at 0x52908400098527886E0F7030069857D2E4169EE7' });
    expect(r.body.error.details.action).toBe('ban');
    // The rest of the message is still checked: our address plus a messenger and a phone number bans as usual.
    await h.ctx.db.query('UPDATE crypto_payments SET pay_address = $2 WHERE order_id = $1', [o2.id, DEPOSIT_R22B]);
    const room2 = (await other.api.post('/v1/chat/rooms', { offerId: offer.id })).body.id;
    const c = await other.api.post(`/v1/chat/rooms/${room2}/messages`, { body: OWN_DEPOSIT_WITH_CONTACT[0] });
    expect(c.status).toBe(422);
    expect(c.body.error.details.action).toBe('ban');
  });

  it('account details in an account room (login method, labelled UID) are delivered, never banned', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { categorySlug: 'accounts', title: 'Main account', priceCents: 50_00, deliveryMode: 'manual' });
    const buyer = await makeUser(h, { tier: 1 });
    const room = (await buyer.api.post('/v1/chat/rooms', { offerId: offer.id })).body.id;
    for (const body of ACCOUNT_R22B) {
      const r = await seller.api.post(`/v1/chat/rooms/${room}/messages`, { body });
      expect(r.status, `${body}: ${JSON.stringify(r.body)}`).toBe(201);
    }
    expect((await h.ctx.db.query('SELECT status FROM users WHERE id = $1', [seller.id])).rows[0].status).toBe('active');
  });

  it('digits spaced out are a phone number: blocked and queued, no strike', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 10_00 });
    const buyer = await makeUser(h, { tier: 1 });
    const room = (await buyer.api.post('/v1/chat/rooms', { offerId: offer.id })).body.id;
    const r = await buyer.api.post(`/v1/chat/rooms/${room}/messages`, { body: 'my numbr is 0 1 0 1 2 3 4 5 6 7 8' });
    expect(r.status).toBe(422);
    expect(r.body.error.details.action).toBe('queue');
  });

  it('dismissing the flag behind an automatic ban lifts it (audited), unless a confirmed offence remains', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 10_00 });
    const flagOf = async (userId: string) => (await h.ctx.db.query(`SELECT id FROM chat_flags WHERE user_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0].id;

    const u = await makeUser(h, { tier: 1 });
    const room = (await u.api.post('/v1/chat/rooms', { offerId: offer.id })).body.id;
    expect((await u.api.post(`/v1/chat/rooms/${room}/messages`, { body: 'whatsapp 0101234567' })).body.error.details.action).toBe('ban');
    const flag = await flagOf(u.id);
    const d = await admin.api.post(`/v1/admin/moderation/chats/${flag}`, { confirm: false, note: 'a player ID' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toMatchObject({ banLifted: true, restoredStatus: 'active' });
    expect((await h.ctx.db.query('SELECT status, suspension_reason, offplatform_strikes FROM users WHERE id = $1', [u.id])).rows[0]).toMatchObject({ status: 'active', suspension_reason: null, offplatform_strikes: 0 });
    expect(Number((await h.ctx.db.query(`SELECT count(*) FROM admin_audit_log WHERE action = 'user.auto_ban_lifted' AND target_id = $1`, [u.id])).rows[0].count)).toBe(1);

    // A confirmed offence before the ban: dismissing the ban's flag keeps the ban.
    const v = await makeUser(h, { tier: 1 });
    const room2 = (await v.api.post('/v1/chat/rooms', { offerId: offer.id })).body.id;
    expect((await v.api.post(`/v1/chat/rooms/${room2}/messages`, { body: 'pay me on paypal' })).body.error.details.action).toBe('queue');
    expect((await admin.api.post(`/v1/admin/moderation/chats/${await flagOf(v.id)}`, { confirm: true })).status).toBe(200);
    expect((await h.ctx.db.query('SELECT status FROM users WHERE id = $1', [v.id])).rows[0].status).toBe('active'); // first offence: warn
    expect((await v.api.post(`/v1/chat/rooms/${room2}/messages`, { body: 'telegram @cheapgold' })).body.error.details.action).toBe('ban');
    const d2 = await admin.api.post(`/v1/admin/moderation/chats/${await flagOf(v.id)}`, { confirm: false });
    expect(d2.body.banLifted).toBe(false);
    expect((await h.ctx.db.query('SELECT status FROM users WHERE id = $1', [v.id])).rows[0].status).toBe('banned');
  });
});

describe('6. withdrawals in a coin we no longer pay out in', () => {
  it('approval rejects them (unsupported_coin), the job reverses an approved one, and the migration resets EUR/EGP payout currencies', async () => {
    const { seller } = await sellerWithSales(1);
    const cfo = await makeUser(h, { role: 'finance' });
    const before = await available(seller.id);
    const w = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 10_00 })).body;
    await h.ctx.db.query(`UPDATE withdrawals SET destination_currency = 'btc' WHERE id = $1`, [w.id]);
    const r = await cfo.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: true });
    expect(r.body).toMatchObject({ status: 'rejected', refused: 'unsupported_coin' });
    expect(await row(w.id)).toMatchObject({ status: 'rejected', decision_note: 'unsupported_coin' });
    expect(await available(seller.id)).toBe(before);
    expect(fake.payoutPosts).not.toContain(w.id);

    const w2 = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 10_00 })).body;
    await approveWithoutSending(w2.id, `, destination_currency = 'btc'`);
    await recheckUnknownPayouts(h.ctx);
    expect(await row(w2.id)).toMatchObject({ status: 'failed', failure_reason: 'unsupported_coin' });
    expect(await available(seller.id)).toBe(before);
    expect(fake.payoutPosts).not.toContain(w2.id);

    await h.ctx.db.query(`UPDATE users SET payout_currency = 'EGP' WHERE id = $1`, [seller.id]);
    await h.ctx.db.query(MIGRATION);
    expect((await h.ctx.db.query('SELECT payout_currency FROM users WHERE id = $1', [seller.id])).rows[0].payout_currency).toBe('USD');
  });
});

describe('7. minor money items', () => {
  it('a FINISHED payout IPN for a reversed withdrawal is recorded for Finance and alerted', async () => {
    const { seller } = await sellerWithSales(1);
    const cfo = await makeUser(h, { role: 'finance' });
    const w = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 14_00 })).body;
    fake.payoutMode = 'reject';
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: true })).body.error.code).toBe('payout_failed');
    expect((await row(w.id)).status).toBe('failed');
    await ipn({ id: 'late-1', batch_withdrawal_id: 'batch_late-1', unique_external_id: w.id, status: 'FINISHED', error: null, currency: 'usdttrc20', amount: '12.5', address: 'TRound22bSeller123456789a', hash: '0xsent-after-refund' });
    expect(await row(w.id)).toMatchObject({ status: 'failed', paid_after_reversal_hash: '0xsent-after-refund' });
    expect((await row(w.id)).paid_after_reversal_at).toBeTruthy();
    expect(Number((await h.ctx.db.query(`SELECT count(*) FROM notifications WHERE template = 'ops_alert' AND dedupe_key = $1`, [`paid_after_reversal:${w.id}:${cfo.id}`])).rows[0].count)).toBe(1);
    const { detectOpsAlerts } = await import('../src/domain/opsAlerts.js');
    expect((await detectOpsAlerts(h.ctx)).map((a) => a.key)).toContain('payout_after_reversal');
  });

  it('four-eyes: a withdrawal that needed two approvals at the first step still needs the second', async () => {
    await h.ctx.db.query('UPDATE platform_controls SET four_eyes_user_day_cents = 50_00');
    forgetControlsCache();
    try {
      const { seller } = await sellerWithSales(1);
      const cfo = await makeUser(h, { role: 'finance' });
      const a = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 30_00 })).body;
      const b = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 40_00 })).body; // the user's day is now 70 > 50
      expect((await cfo.api.post(`/v1/admin/withdrawals/${b.id}/decide`, { approve: true })).body).toMatchObject({ status: 'pending_approval', needs_second_approval: true });
      expect((await cfo.api.post(`/v1/admin/withdrawals/${a.id}/decide`, { approve: false, note: 'duplicate' })).body.status).toBe('rejected'); // day back to 40
      expect((await cfo.api.post(`/v1/admin/withdrawals/${b.id}/decide`, { approve: true })).body.error.code).toBe('four_eyes');
      const lead = await makeUser(h, { role: 'lead' });
      expect((await lead.api.post(`/v1/admin/withdrawals/${b.id}/decide`, { approve: true })).body.status).toBe('processing');
    } finally {
      await h.ctx.db.query('UPDATE platform_controls SET four_eyes_user_day_cents = 100000000');
      forgetControlsCache();
    }
  });

  it('treasury withdrawals do not wait on the platform payout cap lock', async () => {
    await sellerWithSales(1); // some revenue in the treasury
    const a1 = await makeUser(h, { role: 'admin' });
    const a2 = await makeUser(h, { role: 'admin' });
    const tw = (await h.ctx.db.query(`INSERT INTO treasury_withdrawals (amount_cents, currency, note, requested_by, source) VALUES (100, 'USD', 'rent', $1, 'treasury') RETURNING id`, [a1.id])).rows[0].id;
    const holder = await h.ctx.db.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(727276)'); // a withdrawal approval holding the payout-cap lock
      const done = decideTreasuryWithdrawal(h.ctx, tw, a2.id, true).then(() => 'done', () => 'done');
      const res = await Promise.race([done, new Promise((r) => setTimeout(() => r('blocked'), 3000))]);
      expect(res).toBe('done');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});
