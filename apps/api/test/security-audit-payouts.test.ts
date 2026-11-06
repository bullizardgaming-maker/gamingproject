/**
 * Security audit (Nov 2026): payout and crypto regression tests, on the NOWPayments fake behind the origin secret
 * (so the connection country header is believed), like round29.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { recheckUnknownPayout } from '../src/domain/cryptoPayouts.js';
import { forgetControlsCache } from '../src/domain/controls.js';
import { FakeNow } from './fakeNowPayments.js';
import { makeOffer, makeUser, setup, type Harness, defaultHeaders } from './helpers.js';

const ORIGIN_SECRET = 'origin-secret-of-at-least-32-characters!';
const IPN_SECRET = 'ipn-secret-for-tests';
let h: Harness;
let fake: FakeNow;

beforeAll(async () => {
  fake = new FakeNow();
  const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', email: 'e', password: 'p', twoFactorSecret: 'JBSWY3DPEHPK3PXP', fetch: ((u: string, i?: RequestInit) => fake.fetch(u, i)) as any, timeoutMs: 2_000 });
  h = await setup({
    PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET, NOWPAYMENTS_FEE_BPS: '0',
    GEO_COUNTRY_HEADER: 'cf-ipcountry', ORIGIN_SHARED_SECRET: ORIGIN_SECRET,
    CRYPTO_UNDERPAY_TOLERANCE_BPS: '0', OVERPAY_TO_BALANCE_ABOVE_CENTS: '0',
  }, { payments });
  defaultHeaders['x-origin-auth'] = ORIGIN_SECRET;
  defaultHeaders['cf-ipcountry'] = 'US'; // Cloudflare always names a country; a missing one counts as unknown (XX)
});
afterAll(async () => {
  delete defaultHeaders['x-origin-auth'];
  delete defaultHeaders['cf-ipcountry'];
  await h.close();
});

async function ipn(body: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: JSON.stringify(sortDeep(body)) });
}
const finished = (p: any, times = 1) => ({
  payment_id: Number(p.payment_id), payment_status: 'finished', pay_address: p.pay_address, price_amount: p.price_amount, price_currency: String(p.price_currency).toLowerCase(),
  pay_amount: p.pay_amount, actually_paid: p.pay_amount * times, actually_paid_at_fiat: 0, pay_currency: p.pay_currency, order_id: p.order_id, purchase_id: p.purchase_id,
  outcome_amount: Math.round(p.price_amount * times * 1e6) / 1e6, outcome_currency: 'usdtbsc', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});
async function agedUser(opts: Parameters<typeof makeUser>[1] = {}) {
  const u = await makeUser(h, { tier: 1, ...opts });
  await h.ctx.db.query(`UPDATE users SET created_at = now() - interval '40 days', payout_address = 'TUserAddr1234567890xyzA', payout_address_currency = 'usdttrc20', payout_country = 'US', payout_hold_days = 0 WHERE id = $1`, [u.id]);
  return u;
}
/** Opens a wallet top-up for `cents` and pays it `times` over. */
async function topUp(user: { api: any }, cents: number, times = 1) {
  const dep = (await user.api.post('/v1/me/wallet/deposits', { method: 'crypto', amountCents: cents })).body;
  const pay = await user.api.post(`/v1/me/wallet/deposits/${dep.id}/crypto/pay`, { coin: 'usdttrc20' });
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  const p = fake.payments.get(pay.body.payment_id)!;
  Object.assign(p, finished(p, times));
  expect((await ipn(finished(p, times))).statusCode).toBe(200);
}
async function pendingWithdrawal() {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await agedUser();
  const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 50_00 });
  const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, deliveryMethod: 'f2f', deliveryInfo: { character: 'Buyer1' } });
  const pay = await buyer.api.post(`/v1/orders/${created.body.order.id}/crypto/pay`, { coin: 'usdttrc20' });
  const p = fake.payments.get(pay.body.payment_id)!;
  Object.assign(p, finished(p));
  await ipn(finished(p));
  await seller.api.post(`/v1/orders/${created.body.order.id}/deliver`, { payload: 'sent' });
  await buyer.api.post(`/v1/orders/${created.body.order.id}/confirm`, {});
  await h.ctx.db.query(`UPDATE users SET payout_address = 'TSellerAddr1234567890xyz', payout_address_currency = 'usdttrc20', payout_country = 'US', payout_hold_days = 0 WHERE id = $1`, [seller.id]);
  const w = await seller.api.post('/v1/seller/withdrawals', { amountCents: 20_00 });
  expect(w.status, JSON.stringify(w.body)).toBe(201);
  return { seller, w: w.body };
}

describe('security audit — payouts', () => {
  it('HC-1: /me/credit/withdraw is refused from a sanctioned connection (451), like /me/withdrawals', async () => {
    const buyer = await agedUser();
    await topUp(buyer, 20_00);
    const res = await buyer.api.post('/v1/me/credit/withdraw', { amountCents: 10_00 }, { 'cf-ipcountry': 'IR' });
    expect(res.status).toBe(451);
    expect(res.body.error.code).toBe('country_not_supported');
    expect((await h.ctx.db.query('SELECT 1 FROM withdrawals WHERE user_id = $1', [buyer.id])).rowCount).toBe(0);
  });

  it('HC-2: paying a small top-up far over is reviewed like a large top-up before it can be withdrawn', async () => {
    const buyer = await agedUser();
    await topUp(buyer, 5_00, 400); // a $5 top-up paid with $2,000
    const res = await buyer.api.post('/v1/me/withdrawals', { amountCents: 1_500_00 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending_approval', reason_code: 'under_review' });
    const row = await h.ctx.db.query('SELECT review_reason FROM withdrawals WHERE id = $1', [res.body.id]);
    expect(row.rows[0].review_reason).toBe('topup_withdraw_pattern');
  });

  it('HC-4: a freeze or AML hold placed after the request stops the approval', async () => {
    const { seller, w } = await pendingWithdrawal();
    await h.ctx.db.query('UPDATE users SET aml_hold = true WHERE id = $1', [seller.id]);
    const cfo = await makeUser(h, { tier: 2, role: 'finance' });
    const res = await cfo.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: true });
    expect(res.status).toBe(423);
    expect((await h.ctx.db.query('SELECT status FROM withdrawals WHERE id = $1', [w.id])).rows[0].status).toBe('pending_approval');
  });

  it('HC-3: the withdrawals kill switch also stops the payout verification retry', async () => {
    const { w } = await pendingWithdrawal();
    await h.ctx.db.query(`UPDATE withdrawals SET status = 'unknown', verify_pending = true, provider_ref = 'batch-1', payout_id = '777', provider_attempted_at = now() - interval '1 hour' WHERE id = $1`, [w.id]);
    const np = h.ctx.payments as NowPaymentsProvider;
    let verified = 0;
    const orig = { get: np.getPayout, verify: np.verifyPayout };
    np.getPayout = async () => ({ id: '777', status: 'WAITING' }) as any;
    np.verifyPayout = async () => ((verified++), true);
    await h.ctx.db.query('UPDATE platform_controls SET pause_withdrawals = true');
    forgetControlsCache();
    try {
      await expect(recheckUnknownPayout(h.ctx, w.id)).rejects.toMatchObject({ code: 'withdrawals_paused' });
      expect(verified).toBe(0);
    } finally {
      np.getPayout = orig.get;
      np.verifyPayout = orig.verify;
      await h.ctx.db.query('UPDATE platform_controls SET pause_withdrawals = false');
      forgetControlsCache();
    }
  });

  it('HC-5: a payout wallet on the sanctions list is refused and opens a compliance case', async () => {
    const user = await agedUser();
    const bad = 'TSanctionedWallet1234567890';
    await h.ctx.db.query(`INSERT INTO sanctions_entries (list, ref, kind, name, name_key, version) VALUES ('ofac_sdn', 'test-1', 'wallet', $1, lower($1), 'v1')`, [bad]);
    const res = await user.api.post('/v1/seller/payout-address', { country: 'US', method: 'usdt', currency: 'usdttrc20', address: bad });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('address_not_allowed');
    const c = await h.ctx.db.query(`SELECT holds_payouts FROM aml_cases WHERE user_id = $1 AND rule = 'sanctions_payout_wallet'`, [user.id]);
    expect(c.rows[0].holds_payouts).toBe(true);
  });

  it('HC-6: a payment held for a sanctioned payer wallet is not applied by a later refresh that names no payer', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await agedUser();
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 30_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, deliveryMethod: 'f2f', deliveryInfo: { character: 'Buyer1' } })).body.order;
    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' });
    const p = fake.payments.get(pay.body.payment_id)!;
    const payer = 'TPayerSanctioned1234567890';
    await h.ctx.db.query(`INSERT INTO sanctions_entries (list, ref, kind, name, name_key, version) VALUES ('ofac_sdn', 'test-2', 'wallet', $1, lower($1), 'v1')`, [payer]);
    expect((await ipn({ ...finished(p), payment_status: 'confirmed', payer_address: payer })).statusCode).toBe(200);
    expect((await h.ctx.db.query('SELECT review_reason FROM crypto_payments WHERE payment_id = $1', [String(p.payment_id)])).rows[0].review_reason).toBe('sanctioned_wallet');
    // The provider's own answer (no payer fields) on the buyer's refresh.
    Object.assign(p, finished(p));
    await buyer.api.post(`/v1/orders/${order.id}/crypto/payments/${p.payment_id}/refresh`, {});
    expect((await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status).toBe('awaiting_payment');
  });

  it('EDGE-1: every way onto the market runs the sanctions sell check (duplicate, CSV import, restock, request proposals)', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5 });
    const ir = { 'cf-ipcountry': 'IR' };
    const buyer = await agedUser();
    const r = await buyer.api.post('/v1/requests', { game: 'Test Game', categorySlug: 'keys', title: 'Need a rare key', budgetCents: 30_00 });
    const before = Number((await h.ctx.db.query('SELECT count(*)::int AS n FROM offers WHERE seller_id = $1', [seller.id])).rows[0].n);
    expect((await seller.api.post(`/v1/offers/${offer.id}/duplicate`, {}, ir)).status).toBe(451);
    expect((await seller.api.post('/v1/seller/listings/import', { csv: 'title\nx', dryRun: false }, ir)).status).toBe(451);
    expect((await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'CODE-1' }, ir)).status).toBe(451);
    expect((await seller.api.post(`/v1/requests/${r.body.id}/proposals`, { priceCents: 20_00, deliveryHours: 4 }, ir)).status).toBe(451);
    expect(Number((await h.ctx.db.query('SELECT count(*)::int AS n FROM offers WHERE seller_id = $1', [seller.id])).rows[0].n)).toBe(before);
  });

  it('Tor (T1) is treated like a sanctioned country; an unknown country (XX, or no header through Cloudflare) cannot withdraw', async () => {
    const { client } = await import('./helpers.js');
    const reg = (country: string) => client(h.app, undefined, { 'cf-ipcountry': country }).post('/v1/auth/register', { email: `t1_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'correct horse battery', displayName: 'Tor Tester', acceptTerms: true });
    expect((await reg('T1')).status).toBe(451);
    expect((await reg('XX')).status).toBe(201); // signing up and browsing stay open
    const buyer = await agedUser();
    await topUp(buyer, 20_00);
    expect((await buyer.api.post('/v1/me/withdrawals', { amountCents: 10_00 }, { 'cf-ipcountry': 'XX' })).status).toBe(451);
    const noHeader = await h.app.inject({ method: 'POST', url: '/v1/me/withdrawals', headers: { authorization: `Bearer ${(buyer as any).token}`, 'x-origin-auth': ORIGIN_SECRET, 'content-type': 'application/json' }, payload: JSON.stringify({ amountCents: 10_00 }) });
    expect(noHeader.statusCode).toBe(451);
    const methods = (await buyer.api.get('/v1/payment-methods', { 'cf-ipcountry': 'T1' })).body;
    expect(JSON.stringify(methods)).not.toMatch(/"crypto"/);
  });

  it('pause orders also stops new crypto payment addresses for existing orders', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await agedUser();
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 30_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, deliveryMethod: 'f2f', deliveryInfo: { character: 'Buyer1' } })).body.order;
    await h.ctx.db.query('UPDATE platform_controls SET pause_orders = true');
    forgetControlsCache();
    try {
      const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' });
      expect(pay.status).toBe(503);
      expect(pay.body.error.code).toBe('orders_paused');
    } finally {
      await h.ctx.db.query('UPDATE platform_controls SET pause_orders = false');
      forgetControlsCache();
    }
  });
});
