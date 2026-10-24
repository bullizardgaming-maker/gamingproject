import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { FakeNow } from './fakeNowPayments.js';
import { BAN, NORMAL_R22, QUEUE_R22 } from './fixtures/chat-phrases.js';
import { ROLE_PERMISSIONS } from '../src/domain/permissions.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { recheckUnknownPayouts } from '../src/domain/cryptoPayouts.js';
import { applyCryptoPayment } from '../src/domain/cryptoPayments.js';
import { autoCompleteExpired, cancelOrder, cancelUnpaidExpired, handlePaymentCaptured } from '../src/domain/orders.js';
import { moneyCosts } from '../src/domain/analytics.js';
import { forgetControlsCache } from '../src/domain/controls.js';

/** Round 22 (claude/round-22-fixes.md): one test (or more) per item; the money paths run on a fake NOWPayments. */
const IPN_SECRET = 'ipn-secret-round22';
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
const paidIpn = (p: any, over: Record<string, unknown> = {}) => ({
  payment_id: Number(p.payment_id), payment_status: 'finished', pay_address: p.pay_address, price_amount: p.price_amount, price_currency: 'usd',
  pay_amount: p.pay_amount, actually_paid: p.pay_amount, actually_paid_at_fiat: p.price_amount, pay_currency: p.pay_currency, order_id: p.order_id,
  purchase_id: p.purchase_id, outcome_amount: p.price_amount, outcome_currency: 'usdttrc20', ...over,
});
const sumKind = async (kind: string, ownerId?: string, memo?: string) =>
  Number((await h.ctx.db.query(
    `SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = $1 AND ($2::uuid IS NULL OR a.owner_id = $2) AND ($3::text IS NULL OR e.memo = $3)`,
    [kind, ownerId ?? null, memo ?? null],
  )).rows[0].s);

/** A NOWPayments order: created, crypto payment started, optionally paid by IPN. */
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
  await h.ctx.db.query(`UPDATE users SET payout_hold_days = 0, payout_address = 'TRound22Seller1234567890a', payout_address_currency = 'usdttrc20', payout_address_set_at = now() WHERE id = $1`, [seller.id]);
  return { seller, buyer, offer };
}

describe('1 + 20. chat filter decision through the API', () => {
  it('delivers normal top-up talk, blocks disguised contacts without a strike, and bans only the unambiguous ones (sessions revoked)', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'top-ups', title: '1000 UC', priceCents: 10_00 });
    const { order } = await cryptoOrder(buyer, offer.id);
    const { room_id } = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    for (const phrase of NORMAL_R22) {
      const r = await buyer.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: phrase });
      expect(r.status, `${phrase}: ${JSON.stringify(r.body)}`).toBe(201);
    }
    // A labelled player ID that looks like an Egyptian mobile is a delivery detail in a top-up room.
    expect((await buyer.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'my UID: 0101234567' })).status).toBe(201);
    for (const phrase of QUEUE_R22) {
      const r = await buyer.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: phrase });
      expect(r.status, phrase).toBe(422);
      expect(r.body.error.details.action, phrase).toBe('queue');
    }
    const b = (await h.ctx.db.query('SELECT status, offplatform_strikes FROM users WHERE id = $1', [buyer.id])).rows[0];
    expect(b).toMatchObject({ status: 'active', offplatform_strikes: 0 });
    expect(Number((await h.ctx.db.query('SELECT count(*) FROM chat_flags WHERE user_id = $1 AND NOT strike', [buyer.id])).rows[0].count)).toBe(QUEUE_R22.length);

    for (const phrase of BAN.slice(0, 4)) {
      const u = await makeUser(h, { tier: 1 });
      const inq = await u.api.post('/v1/chat/rooms', { offerId: offer.id });
      const roomId = inq.body.id;
      expect(roomId, JSON.stringify(inq.body)).toBeTruthy();
      const r = await u.api.post(`/v1/chat/rooms/${roomId}/messages`, { body: phrase });
      expect(r.body.error?.details?.action, phrase).toBe('ban');
      expect((await h.ctx.db.query('SELECT status FROM users WHERE id = $1', [u.id])).rows[0].status).toBe('banned');
      // Item 20: like the admin ban, every session is revoked.
      expect(Number((await h.ctx.db.query('SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [u.id])).rows[0].count)).toBe(0);
    }
  });
});

describe('2. Lead permissions', () => {
  it('Finance approves first; the Lead only co-signs large withdrawals and never approves treasury withdrawals or refunds', async () => {
    expect(ROLE_PERMISSIONS.lead).not.toContain('treasury.approve');
    expect(ROLE_PERMISSIONS.lead).toContain('withdrawals.second_approve');
    expect(ROLE_PERMISSIONS.finance).toContain('treasury.approve');
    const lead = await makeUser(h, { role: 'lead' });
    const finance = await makeUser(h, { role: 'finance' });
    const finance2 = await makeUser(h, { role: 'finance' });
    const { seller } = await sellerWithSales(1);
    const small = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 20_00 })).body;
    expect((await lead.api.post(`/v1/admin/withdrawals/${small.id}/decide`, { approve: true })).body.error.code).toBe('finance_first');
    expect((await lead.api.get('/v1/admin/withdrawals')).status).toBe(200); // the Lead sees the queue to co-sign
    // Treasury (company) withdrawals: requested by one finance member, approved by another; never by the Lead.
    const tw = await h.ctx.db.query(`INSERT INTO treasury_withdrawals (amount_cents, currency, note, requested_by, source) VALUES (100, 'USD', 'test', $1, 'treasury') RETURNING id`, [finance2.id]);
    const twId = tw.rows[0].id;
    expect((await lead.api.post(`/v1/admin/treasury/withdrawals/${twId}/decide`, { approve: true })).status).toBe(403);
    expect((await lead.api.post(`/v1/admin/crypto/refunds/00000000-0000-0000-0000-000000000000/sent`, { txHash: '0xabcdef0123' })).status).toBe(403);
    expect((await finance.api.post(`/v1/admin/withdrawals/${small.id}/decide`, { approve: true })).body.status).toBe('processing');
  });
});

describe('3. reconciliation fails when NOWPayments cannot be read', () => {
  it('records psp_balance_unreadable, is not ok, and alerts finance', async () => {
    await makeUser(h, { role: 'finance' });
    fake.balanceStatus = 500;
    const r = await runReconciliation(h.ctx);
    fake.balanceStatus = null;
    expect(r.status).not.toBe('ok');
    expect(r.report.issues.map((i) => i.check)).toContain('psp_balance_unreadable');
    expect(Number((await h.ctx.db.query(`SELECT count(*) FROM notifications WHERE template = 'reconciliation_alert' AND dedupe_key LIKE $1`, [`recon:${r.id}:%`])).rows[0].count)).toBeGreaterThan(0);
    // A balance that can't be read as a number fails the run too.
    fake.extraBalance = { weirdcoin: { amount: 'n/a' as any } }; // a balance the provider can't express as a number
    const v = await runReconciliation(h.ctx);
    fake.extraBalance = null;
    expect(v.report.issues.map((i) => i.check)).toContain('psp_balance_unreadable');
  });
});

describe('4. payouts in unknown', () => {
  it('stores our id before the call and matches an IPN that arrives while the withdrawal is unknown', async () => {
    const { seller } = await sellerWithSales(1);
    const cfo = await makeUser(h, { role: 'finance' });
    const w = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 30_00 })).body;
    fake.payoutMode = 'timeout';
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: true })).body.error.code).toBe('payout_unknown');
    const row = (await h.ctx.db.query('SELECT status, external_id, payout_id FROM withdrawals WHERE id = $1', [w.id])).rows[0];
    expect(row).toMatchObject({ status: 'unknown', external_id: w.id, payout_id: null });
    const p = fake.payouts.find((x) => x.unique_external_id === w.id)!;
    await ipn({ id: p.id, batch_withdrawal_id: p.batch_withdrawal_id, unique_external_id: w.id, status: 'FINISHED', error: null, currency: 'usdttrc20', amount: p.amount, address: p.address, hash: '0xpaid-while-unknown' });
    expect((await h.ctx.db.query('SELECT status, tx_hash, payout_id FROM withdrawals WHERE id = $1', [w.id])).rows[0]).toMatchObject({ status: 'paid', tx_hash: '0xpaid-while-unknown', payout_id: String(p.id) });
  });

  it('a failed 2FA verify keeps the batch ids, never reverses, and the job retries the verification', async () => {
    const { seller } = await sellerWithSales(1);
    const cfo = await makeUser(h, { role: 'finance' });
    const w = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 25_00 })).body;
    fake.payoutMode = 'verify_fail';
    const r = await cfo.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: true });
    expect(r.body.error.code).toBe('payout_unknown');
    let row = (await h.ctx.db.query('SELECT status, verify_pending, payout_id, provider_ref FROM withdrawals WHERE id = $1', [w.id])).rows[0];
    expect(row).toMatchObject({ status: 'unknown', verify_pending: true });
    expect(row.payout_id).toBeTruthy();
    expect(row.provider_ref).toBeTruthy();
    expect(await sumKind('payouts', undefined, `withdrawal_failed:${w.id}`)).toBe(0);
    await h.ctx.db.query(`UPDATE withdrawals SET updated_at = now() - interval '5 minutes' WHERE id = $1`, [w.id]);
    await recheckUnknownPayouts(h.ctx);
    row = (await h.ctx.db.query('SELECT status, verify_pending FROM withdrawals WHERE id = $1', [w.id])).rows[0];
    expect(row).toMatchObject({ status: 'processing', verify_pending: false });
    expect(fake.verifies).toContain(String((await h.ctx.db.query('SELECT provider_ref FROM withdrawals WHERE id = $1', [w.id])).rows[0].provider_ref));
    expect(fake.payouts.filter((x) => x.unique_external_id === w.id)).toHaveLength(1);
  });

  it('polls processing payouts whose IPN never came', async () => {
    const { seller } = await sellerWithSales(1);
    const cfo = await makeUser(h, { role: 'finance' });
    const w = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 22_00 })).body;
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: true })).body.status).toBe('processing');
    const p = fake.payouts.find((x) => x.unique_external_id === w.id)!;
    Object.assign(p, { status: 'FINISHED', hash: '0xpolled' });
    await h.ctx.db.query(`UPDATE withdrawals SET provider_attempted_at = now() - interval '1 hour' WHERE id = $1`, [w.id]);
    await recheckUnknownPayouts(h.ctx);
    expect((await h.ctx.db.query('SELECT status, tx_hash FROM withdrawals WHERE id = $1', [w.id])).rows[0]).toMatchObject({ status: 'paid', tx_hash: '0xpolled' });
  });
});

describe('5. withdrawals kill switch', () => {
  it('also stops staff approvals and treasury withdrawals (rejections still work)', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const finance = await makeUser(h, { role: 'finance' });
    const { seller } = await sellerWithSales(1);
    const w = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 15_00 })).body;
    await admin.api.put('/v1/admin/controls', { pause_withdrawals: true });
    forgetControlsCache();
    try {
      const before = fake.payouts.length;
      expect((await finance.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: true })).body.error.code).toBe('withdrawals_paused');
      expect(fake.payouts.length).toBe(before);
      expect((await finance.api.post('/v1/admin/treasury/withdrawals', { amountCents: 100, note: 'office rent' })).body.error.code).toBe('withdrawals_paused');
      const tw = await h.ctx.db.query(`INSERT INTO treasury_withdrawals (amount_cents, currency, note, requested_by, source) VALUES (100, 'USD', 'test', $1, 'treasury') RETURNING id`, [admin.id]);
      expect((await finance.api.post(`/v1/admin/treasury/withdrawals/${tw.rows[0].id}/decide`, { approve: true })).body.error.code).toBe('withdrawals_paused');
      expect((await finance.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: false, note: 'paused' })).body.status).toBe('rejected');
    } finally {
      await admin.api.put('/v1/admin/controls', { pause_withdrawals: false });
      forgetControlsCache();
    }
  });
});

describe('6. refund after release on a NOWPayments order', () => {
  it('goes to the buyer’s balance, never to the crypto-refund queue', async () => {
    const { buyer, offer } = await sellerWithSales(0);
    const { order } = await cryptoOrder(buyer, offer.id);
    await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
    const admin = await makeUser(h, { role: 'admin' });
    const before = await sumKind('user_credit', buyer.id);
    const r = await admin.api.post(`/v1/admin/orders/${order.id}/refund-after-release`, { paidBy: 'platform', reason: 'Account reclaimed by the original owner' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await sumKind('user_credit', buyer.id)).toBe(before + order.amount_cents);
    expect(Number((await h.ctx.db.query('SELECT count(*) FROM crypto_refunds WHERE order_id = $1', [order.id])).rows[0].count)).toBe(0);
    expect(await sumKind('refunds_payable')).toBe(0);
  });
});

describe('7. IPN vs the unpaid-order reaper', () => {
  it('the same deposit is either funding or credit, never both, however the two interleave', async () => {
    const { buyer, offer } = await sellerWithSales(0);
    for (let i = 0; i < 4; i++) {
      const { order, raw } = await cryptoOrder(buyer, offer.id, false);
      await h.ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '2 hours' WHERE id = $1`, [order.id]);
      // A partial deposit first (so the reaper has something to credit), then the IPN with the full amount races the reaper.
      await ipn(paidIpn(raw, { payment_status: 'partially_paid', actually_paid: raw.pay_amount / 2, actually_paid_at_fiat: raw.price_amount / 2, outcome_amount: raw.price_amount / 2 }));
      const gatewayBefore = await sumKind('gateway_clearing');
      const ev = { type: 'crypto.payment' as const, paymentId: String(raw.payment_id), orderId: order.id, purchaseId: null, status: 'finished' as const, payCurrency: 'usdttrc20', payAmount: raw.pay_amount, actuallyPaid: raw.pay_amount, actuallyPaidUsd: raw.price_amount, priceUsd: raw.price_amount, outcomeAmount: raw.price_amount, outcomeCurrency: 'usdttrc20', raw: {} };
      await Promise.allSettled([applyCryptoPayment(h.ctx, ev), cancelUnpaidExpired(h.ctx)]);
      await applyCryptoPayment(h.ctx, ev); // a replay settles whatever is left
      const o = (await h.ctx.db.query('SELECT status, amount_cents FROM orders WHERE id = $1', [order.id])).rows[0];
      const escrow = Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'escrow' AND e.order_id = $1`, [order.id])).rows[0].s);
      const came = gatewayBefore - (await sumKind('gateway_clearing'));
      if (o.status === 'paid') expect(escrow).toBe(Number(o.amount_cents));
      else expect(o.status).toBe('cancelled');
      // Every cent of the deposit is accounted for exactly once (escrow or credit), whichever won.
      expect(came).toBe(Math.round(raw.price_amount * 100));
    }
  });
});

describe('8. a second transfer to an address that already funded the order', () => {
  it('is credited to the buyer’s balance with its own ledger entry, once', async () => {
    const { buyer, offer } = await sellerWithSales(0);
    const { order, raw } = await cryptoOrder(buyer, offer.id);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('paid');
    const before = await sumKind('user_credit', buyer.id);
    const twice = paidIpn(raw, { actually_paid: raw.pay_amount * 2, actually_paid_at_fiat: raw.price_amount * 2, outcome_amount: raw.price_amount * 2 });
    await ipn(twice);
    await ipn(twice); // replay
    expect(await sumKind('user_credit', buyer.id)).toBe(before + Math.round(raw.price_amount * 100));
    expect(Number((await h.ctx.db.query(`SELECT count(DISTINCT txn_id) FROM ledger_entries WHERE order_id = $1 AND memo = 'crypto_extra_deposit'`, [order.id])).rows[0].count)).toBe(1);
  });
});

describe('9. cancelled, then captured', () => {
  it('books the provider fee on the late capture', async () => {
    const { buyer, offer } = await sellerWithSales(0);
    const { order } = await cryptoOrder(buyer, offer.id, false);
    await cancelOrder(h.ctx, order.id, null, 'payment_window_expired');
    await handlePaymentCaptured(h.ctx, { type: 'payment.captured', ref: order.payment_ref, orderId: order.id, amountCents: order.presentment_amount_cents, currency: order.presentment_currency, details: { settledAmountCents: order.charged_cents + 50, feeCents: 50 } } as any);
    const fee = (await h.ctx.db.query(`SELECT count(*) FROM ledger_entries WHERE order_id = $1 AND memo = 'psp_fee'`, [order.id])).rows[0].count;
    expect(Number(fee)).toBeGreaterThan(0);
    const unbalanced = await h.ctx.db.query(`SELECT txn_id FROM ledger_entries WHERE order_id = $1 GROUP BY txn_id HAVING SUM(amount_cents) <> 0`, [order.id]);
    expect(unbalanced.rows).toEqual([]);
  });
});

describe('10. payout coins', () => {
  it('refuses a withdrawal to a non-USDT address and the migration clears such addresses', async () => {
    const { seller } = await sellerWithSales(1);
    await h.ctx.db.query(`UPDATE users SET payout_address = 'bc1qround22legacyaddress000000000000', payout_address_currency = 'btc' WHERE id = $1`, [seller.id]);
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 10_00 })).body.error.code).toBe('unsupported_coin');
    const sql = readFileSync(new URL('../migrations/069_round22.sql', import.meta.url), 'utf8');
    await h.ctx.db.query(sql);
    expect((await h.ctx.db.query('SELECT payout_address, payouts_enabled FROM users WHERE id = $1', [seller.id])).rows[0]).toMatchObject({ payout_address: null, payouts_enabled: false });
  });
});

describe('11. per-user daily cap at approval', () => {
  it('re-checks the user’s 24h total when approving', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const finance = await makeUser(h, { role: 'finance' });
    const { seller } = await sellerWithSales(1);
    const a = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 30_00 })).body;
    const b = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 30_00 })).body;
    await admin.api.put('/v1/admin/controls', { max_withdrawal_day_cents: 50_00 });
    forgetControlsCache();
    try {
      expect((await finance.api.post(`/v1/admin/withdrawals/${a.id}/decide`, { approve: true })).body.status).toBe('processing');
      expect((await finance.api.post(`/v1/admin/withdrawals/${b.id}/decide`, { approve: true })).body.error.code).toBe('withdrawal_limit');
    } finally {
      await admin.api.put('/v1/admin/controls', { max_withdrawal_day_cents: 100000000 });
      forgetControlsCache();
    }
  });
});

describe('12. audit when the payout call fails', () => {
  it('writes the approval audit entry even though the provider refused', async () => {
    const { seller } = await sellerWithSales(1);
    const finance = await makeUser(h, { role: 'finance' });
    const w = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 12_00 })).body;
    fake.payoutMode = 'reject';
    expect((await finance.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: true })).body.error.code).toBe('payout_failed');
    const rows = (await h.ctx.db.query(`SELECT action, details FROM admin_audit_log WHERE target_id = $1`, [w.id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'withdrawal.approve' });
    expect(rows[0].details.payout).toBe('payout_failed');
  });
});

describe('13. creator codes: linked accounts', () => {
  it('pays nothing when the creator and the buyer share a device', async () => {
    const finance = await makeUser(h, { role: 'finance' });
    const creator = await makeUser(h, { tier: 1, device: 'dev-r22-shared' });
    const made = await finance.api.post('/v1/admin/affiliates', { userId: creator.id, code: 'R22-LINKED', rateBps: 2000 });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const reg = await client(h.app, undefined, { 'x-device-fingerprint': 'dev-r22-shared' }).post('/v1/auth/register', { email: `r22fan_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Fan', acceptTerms: true, code: 'R22-LINKED' });
    expect(reg.body.codeApplied).toBe('creator');
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1`, [reg.body.user.id]);
    const fan = { id: reg.body.user.id, api: client(h.app, reg.body.token, { 'x-device-fingerprint': 'dev-r22-shared' }) };
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 3, categorySlug: 'currency', title: 'Gold', priceCents: 50_00 });
    const { order } = await cryptoOrder(fan, offer.id);
    expect((await fan.api.post(`/v1/orders/${order.id}/confirm`, {})).status).toBe(200);
    expect(Number((await h.ctx.db.query('SELECT count(*) FROM affiliate_earnings WHERE order_id = $1', [order.id])).rows[0].count)).toBe(0);
    expect(await sumKind('seller_available', creator.id)).toBe(0);
  });
});

describe('14. warranty refunds above $200 need the Lead', () => {
  it('refuses an arbiter and lets the Lead through to the decision', async () => {
    const { buyer, seller, offer } = await sellerWithSales(0, 250_00);
    const { order } = await cryptoOrder(buyer, offer.id);
    const claim = await h.ctx.db.query(`INSERT INTO warranty_claims (order_id, buyer_id, seller_id, reason, details, respond_by, status) VALUES ($1, $2, $3, 'recovered', 'pulled back', now(), 'escalated') RETURNING id`, [order.id, buyer.id, seller.id]);
    const arbiter = await makeUser(h, { role: 'arbiter' });
    const r = await arbiter.api.post(`/v1/admin/warranty-claims/${claim.rows[0].id}/decide`, { outcome: 'refund', note: 'Original owner took it back', paidBy: 'platform' });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain('orders.lead');
    const lead = await makeUser(h, { role: 'lead' });
    const l = await lead.api.post(`/v1/admin/warranty-claims/${claim.rows[0].id}/decide`, { outcome: 'refund', note: 'Original owner took it back', paidBy: 'platform' });
    expect(l.status).not.toBe(403); // past the permission check (the order is not completed here, so the refund itself is refused)
  });
});

describe('18 + 19. chat texts', () => {
  it('no em dash in the dispute message (API and the ar/fr/pt/de translations)', async () => {
    const { buyer, offer } = await sellerWithSales(0);
    const { order } = await cryptoOrder(buyer, offer.id);
    await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Nothing arrived yet', category: 'not_delivered' });
    const { room_id } = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    const msgs = (await buyer.api.get(`/v1/chat/rooms/${room_id}/messages`)).body;
    const m = msgs.find((x: any) => x.code === 'dispute_opened');
    expect(m.body).not.toContain('—');
    for (const loc of ['ar', 'fr', 'pt', 'de', 'en', 'es']) {
      const src = readFileSync(new URL(`../../web/src/i18n/${loc}.ts`, import.meta.url), 'utf8');
      const line = src.split('\n').find((l) => l.includes('"chat.ev.dispute_opened"'))!;
      expect(line, loc).not.toMatch(/[—–]/);
    }
  });

  it('after the account window the chat note no longer promises a dispute that openDispute refuses', async () => {
    const { buyer, offer } = await sellerWithSales(0);
    const { order } = await cryptoOrder(buyer, offer.id);
    await h.ctx.db.query(`UPDATE orders SET status = 'delivered', delivered_at = now() - interval '15 days', protection_ends_at = now() - interval '1 second' WHERE id = $1`, [order.id]);
    await autoCompleteExpired(h.ctx);
    const { room_id } = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    const note = (await buyer.api.get(`/v1/chat/rooms/${room_id}/messages`)).body.find((x: any) => x.code === 'protection_ended');
    expect(note.body).not.toMatch(/can still confirm or open a dispute/);
    expect(note.body).toMatch(/can no longer be opened/);
    expect((await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Too late to dispute', category: 'other' })).body.error.code).toBe('window_closed');
  });
});

describe('21. ID deadline uses the staff-set days', () => {
  it('blocks earnings withdrawals once id_due_days (not a fixed 30) have passed', async () => {
    const { seller } = await sellerWithSales(1);
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1, seller_since = now() - interval '15 days', selling_restricted_at = NULL WHERE id = $1`, [seller.id]);
    await h.ctx.db.query('UPDATE rules_settings SET id_due_days = 10');
    try {
      const r = await seller.api.post('/v1/seller/withdrawals', { amountCents: 10_00 });
      expect(r.body.error.code).toBe('kyc_overdue');
      expect(r.body.error.message).toContain('10-day');
    } finally {
      await h.ctx.db.query('UPDATE rules_settings SET id_due_days = 30');
    }
  });
});

describe('22. legal materiality', () => {
  it('requires an explicit materiality flag and never lets a material draft skip the notice', async () => {
    const admin = await makeUser(h, { role: 'admin' });
    const effectiveAt = new Date(Date.now() + 15 * 86_400_000).toISOString();
    expect((await admin.api.put('/v1/admin/legal/privacy', { version: 'r22-a', title: 'Privacy', contentMd: '# Privacy\n\nNew data uses explained here.', effectiveAt })).status).toBe(400);
    expect((await admin.api.put('/v1/admin/legal/privacy', { version: 'r22-a', title: 'Privacy', contentMd: '# Privacy\n\nNew data uses explained here.', effectiveAt, material: true })).status).toBe(200);
    const down = await admin.api.put('/v1/admin/legal/privacy', { version: 'r22-a', title: 'Privacy', contentMd: '# Privacy\n\nNew data uses explained here.', material: false });
    expect(down.body.error.code).toBe('material_draft');
    const audit = (await h.ctx.db.query(`SELECT details FROM admin_audit_log WHERE action = 'legal.publish' AND target_id = 'privacy:en:r22-a'`)).rows;
    expect(audit[0].details).toMatchObject({ material: true, previousMaterial: null });
  });
});

describe('23. Ops Business money row', () => {
  it('counts unknown withdrawals as pending, nets promo refunds, and never sums currencies', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const before = await moneyCosts(h.ctx.db, from, to);
    const u = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`INSERT INTO withdrawals (user_id, amount_cents, currency, status, fee_cents, net_cents, source) VALUES ($1, 1000, 'USD', 'unknown', 150, 850, 'balance')`, [u.id]);
    // 5.00 of EUR credit must not appear in the USD figure.
    const { accountId, post } = await import('../src/domain/ledger.js');
    await post(h.ctx.db as any, [
      { account: await accountId(h.ctx.db, 'user_credit', 'EUR', u.id), amountCents: 500 },
      { account: await accountId(h.ctx.db, 'gateway_clearing', 'EUR'), amountCents: -500 },
    ], 'r22_eur_test');
    const after = await moneyCosts(h.ctx.db, from, to);
    expect(after.withdrawalsPending).toBe(before.withdrawalsPending + 1);
    expect(after.withdrawalsPendingCents).toBe(before.withdrawalsPendingCents + 850);
    expect(after.buyerCreditOutstandingCents).toBe(before.buyerCreditOutstandingCents);
    expect(after.byCurrency.EUR!.buyerCreditOutstandingCents).toBe((before.byCurrency.EUR?.buyerCreditOutstandingCents ?? 0) + 500);
    expect(after.promoCents).toBeLessThanOrEqual(after.promoGrossCents);
  });
});

describe('25. referral "active" at order time', () => {
  it('earns when the friend was active when the order was placed, even if it completes later', async () => {
    const referrer = await makeUser(h, { tier: 1 });
    const { code } = (await referrer.api.get('/v1/me/referral')).body;
    const reg = await client(h.app).post('/v1/auth/register', { email: `r22friend_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Friend', code, acceptTerms: true });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1`, [reg.body.user.id]);
    const friend = { id: reg.body.user.id, api: client(h.app, reg.body.token) };
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 40_00 });
    const first = await cryptoOrder(friend, offer.id);
    await friend.api.post(`/v1/orders/${first.order.id}/confirm`, {});
    const second = await cryptoOrder(friend, offer.id);
    // The first completed 35 days ago; the second was placed 15 days ago (20 days after it) and releases today.
    await h.ctx.db.query(`UPDATE orders SET completed_at = now() - interval '35 days' WHERE id = $1`, [first.order.id]);
    await h.ctx.db.query(`UPDATE orders SET created_at = now() - interval '15 days' WHERE id = $1`, [second.order.id]);
    await friend.api.post(`/v1/orders/${second.order.id}/confirm`, {});
    const rewards = (await h.ctx.db.query('SELECT order_id, status, reason FROM referral_rewards WHERE referee_id = $1 ORDER BY created_at', [friend.id])).rows;
    expect(rewards.find((r) => r.order_id === second.order.id)).toMatchObject({ status: 'granted' });
  });
});
