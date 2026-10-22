import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { dispatchEmails } from '../src/domain/notifications.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { currentStep, totpAt } from '../src/domain/mfa.js';
import { runJobsOnce } from '../src/worker.js';

/**
 * A fake NOWPayments: records calls, answers like the real API, and lets the test "pay" by
 * posting a signed IPN exactly as the real one would.
 */
class FakeNow {
  payments = new Map<string, any>();
  payouts: any[] = [];
  minUsd: Record<string, number> = { btc: 8, usdttrc20: 1, eth: 12, ltc: 2 };
  nextId = 5000;
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/v1/merchant/coins') return json({ selectedCurrencies: Object.keys(this.minUsd) });
    if (u.pathname === '/v1/min-amount') {
      const from = u.searchParams.get('currency_from')!;
      return json({ currency_from: from, currency_to: 'usdttrc20', min_amount: 0.0001, fiat_equivalent: this.minUsd[from] ?? 999 });
    }
    if (u.pathname === '/v1/payment' && init?.method === 'POST') {
      const id = String(this.nextId++);
      const p = {
        payment_id: id, payment_status: 'waiting', pay_address: `addr_${body.pay_currency}_${id}`, price_amount: body.price_amount, price_currency: 'usd',
        pay_amount: body.price_amount / 50_000, pay_currency: body.pay_currency, order_id: body.order_id, purchase_id: body.purchase_id ?? `pur_${id}`,
        expiration_estimate_date: new Date(Date.now() + 20 * 60_000).toISOString(),
      };
      this.payments.set(id, p);
      return json(p, 201);
    }
    const m = u.pathname.match(/^\/v1\/payment\/(\w+)$/);
    if (m) return json(this.payments.get(m[1]!));
    if (u.pathname === '/v1/auth') return json({ token: 'jwt-test' });
    if (u.pathname === '/v1/payout' && init?.method === 'POST') {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer jwt-test' });
      const id = String(this.nextId++);
      const w = { id, batch_withdrawal_id: `batch_${id}`, status: 'WAITING', ...body.withdrawals[0] };
      this.payouts.push(w);
      return json({ id: `batch_${id}`, withdrawals: [w] });
    }
    if (/^\/v1\/payout\/.*\/verify$/.test(u.pathname)) {
      expect(body.verification_code).toMatch(/^\d{6}$/);
      return json('OK');
    }
    if (u.pathname === '/v1/balance') return json({ usdttrc20: { amount: 1000, pendingAmount: 0 } });
    return json({ message: `unexpected ${init?.method ?? 'GET'} ${u.pathname}` }, 404);
  };
}

const IPN_SECRET = 'ipn-secret-for-tests';
let h: Harness;
let fake: FakeNow;
const sent: Array<{ to: string; subject?: string; body: string }> = [];

beforeAll(async () => {
  fake = new FakeNow();
  const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', email: 'e', password: 'p', twoFactorSecret: 'JBSWY3DPEHPK3PXP', fetch: fake.fetch as any });
  h = await setup({ PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET }, { payments });
  const orig = h.messenger.send.bind(h.messenger);
  h.messenger.send = async (m: any) => {
    sent.push(m);
    return orig(m);
  };
});
afterAll(async () => h.close());

/** Posts an IPN the way NOWPayments does: JSON body, HMAC-SHA512 of the sorted body in x-nowpayments-sig. */
async function ipn(body: Record<string, unknown>) {
  const raw = JSON.stringify(sortDeep(body));
  return h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: raw });
}
const paidIpn = (p: any, over: Record<string, unknown> = {}) => ({
  payment_id: Number(p.payment_id), payment_status: 'finished', pay_address: p.pay_address, price_amount: p.price_amount, price_currency: 'usd',
  pay_amount: p.pay_amount, actually_paid: p.pay_amount, actually_paid_at_fiat: p.price_amount, pay_currency: p.pay_currency, order_id: p.order_id,
  purchase_id: p.purchase_id, outcome_amount: p.price_amount * 0.995, outcome_currency: 'usdttrc20', fee: { currency: 'usdttrc20', depositFee: 0, withdrawalFee: 0, serviceFee: p.price_amount * 0.005 }, ...over,
});

describe('crypto checkout (NOWPayments)', () => {
  it('signs IPNs over the sorted body and rejects bad signatures', async () => {
    expect(ipnSignature('s', { b: 1, a: { d: 2, c: 3 } })).toBe(ipnSignature('s', { a: { c: 3, d: 2 }, b: 1 }));
    const res = await h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': 'nope' }, payload: '{"payment_id":1,"payment_status":"finished"}' });
    expect(res.statusCode).toBe(401);
  });

  it('offers only coins whose minimum fits, funds the order on a finished payment, and settles at what reached the wallet', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 100k', priceCents: 10_00 });
    const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body.order;
    expect(order.payment_provider).toBe('nowpayments');
    expect(created.body.checkoutUrl).toMatch(new RegExp(`/orders/${order.id}\\?pay=crypto$`));

    // $10: BTC (min $8) and USDT fit; ETH (min $12) is left out.
    const coins = (await buyer.api.get(`/v1/orders/${order.id}/crypto/coins`)).body;
    expect(coins.owedCents).toBe(10_53); // the seller's 10.00 plus the 5% launch-promo commission
    expect(coins.coins.map((c: any) => c.coin)).toEqual(['btc', 'ltc', 'usdttrc20']);
    expect((await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'eth' })).body.error.code).toBe('coin_unavailable');

    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'btc' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body).toMatchObject({ pay_currency: 'btc', pay_currency_name: 'Bitcoin', status: 'waiting', price_usd: '10.53' });
    expect(pay.body.pay_address).toMatch(/^addr_btc_/);
    // One open payment at a time.
    expect((await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'btc' })).body.error.code).toBe('payment_open');
    const detail = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(detail.crypto_payments).toHaveLength(1);
    expect(new Date(detail.payment_expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    const p = fake.payments.get(pay.body.payment_id);
    // confirming: nothing funded yet
    expect((await ipn(paidIpn(p, { payment_status: 'confirming', actually_paid: 0, actually_paid_at_fiat: 0, outcome_amount: null }))).statusCode).toBe(200);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('awaiting_payment');
    // finished: funded, settled at 99.5% (the provider's fee), replay is idempotent
    expect((await ipn(paidIpn(p))).statusCode).toBe(200);
    expect((await ipn(paidIpn(p))).statusCode).toBe(200);
    const paid = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(paid.status).toBe('paid');
    expect(paid.crypto_payments[0]).toMatchObject({ status: 'finished', actually_paid_usd: '10.53' });
    const legs = (await h.ctx.db.query(`SELECT a.kind, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.order_id = $1 AND e.memo = 'payment_captured' ORDER BY a.kind`, [order.id])).rows;
    expect(legs).toEqual([
      { kind: 'escrow', amount_cents: 1053 },
      { kind: 'fx_pnl', amount_cents: -5 },
      { kind: 'gateway_clearing', amount_cents: -1048 },
    ]);
    const fee = (await h.ctx.db.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE order_id = $1 AND memo = 'psp_fee'`, [order.id])).rows[0].n;
    expect(fee).toBeGreaterThan(0);
  });

  it('handles an underpayment with a top-up that shares the purchase id', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 200k', priceCents: 20_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
    const first = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    const p1 = fake.payments.get(first.payment_id);
    // Only $15 of $21.06 arrived.
    await ipn(paidIpn(p1, { payment_status: 'partially_paid', actually_paid: 15, actually_paid_at_fiat: 15, outcome_amount: 14.9 }));
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('awaiting_payment');
    await dispatchEmails(h.ctx);
    expect(sent.some((m) => m.to === buyer.email && /\$6\.06 short/.test(m.subject ?? ''))).toBe(true);

    // The coin list is now for the $6.06 shortfall: BTC's $8 minimum no longer fits.
    const coins = (await buyer.api.get(`/v1/orders/${order.id}/crypto/coins`)).body;
    expect(coins.owedCents).toBe(6_06);
    expect(coins.coins.map((c: any) => c.coin)).toEqual(['ltc', 'usdttrc20']);
    const second = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    expect(second.price_usd).toBe('6.06');
    const p2 = fake.payments.get(second.payment_id);
    expect(p2.purchase_id).toBe(p1.purchase_id);
    await ipn(paidIpn(p2, { actually_paid: 6.06, actually_paid_at_fiat: 6.06, outcome_amount: 6.03 }));
    const paid = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(paid.status).toBe('paid');
    expect(paid.crypto_payments).toHaveLength(2);
    // Settled at what reached the wallet across both payments: 14.90 + 6.03.
    const gw = (await h.ctx.db.query(`SELECT e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.order_id = $1 AND e.memo = 'payment_captured' AND a.kind = 'gateway_clearing'`, [order.id])).rows[0];
    expect(Number(gw.amount_cents)).toBe(-2093);
  });

  it('refunds are queued for the treasury: the buyer gives an address, the CFO records the transaction', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 50k', priceCents: 10_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
    const pay = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    await ipn(paidIpn(fake.payments.get(pay.payment_id)));
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent' });
    await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Nothing arrived in game', category: 'not_delivered' });
    const arbiter = await makeUser(h, { tier: 2, role: 'admin' });
    const dispute = (await buyer.api.get(`/v1/orders/${order.id}`)).body.dispute;
    const decided = await arbiter.api.post(`/v1/admin/disputes/${dispute.id}/resolve`, { outcome: 'buyer', note: 'Seller never delivered' });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    let detail = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(detail.status).toBe('refunded');
    expect(detail.crypto_refund).toMatchObject({ status: 'awaiting_address', amount_cents: 1053 });
    // The liability sits in refunds_payable, not in the gateway, until the coins are sent.
    const bal = async (kind: string) => Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = $1 AND e.order_id = $2`, [kind, order.id])).rows[0].s);
    expect(await bal('refunds_payable')).toBe(1053);
    expect(await bal('escrow')).toBe(0);

    await buyer.api.put(`/v1/orders/${order.id}/refund-address`, { address: 'TXYZabc1234567890refund', currency: 'usdttrc20' });
    detail = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(detail.crypto_refund.status).toBe('pending');
    const queue = (await arbiter.api.get('/v1/admin/crypto/refunds?status=pending')).body;
    expect(queue.find((r: any) => r.order_id === order.id)).toMatchObject({ refund_address: 'TXYZabc1234567890refund' });
    const sentRes = await arbiter.api.post(`/v1/admin/crypto/refunds/${detail.crypto_refund.id}/sent`, { txHash: '0xdeadbeefdeadbeef' });
    expect(sentRes.status, JSON.stringify(sentRes.body)).toBe(200);
    expect(await bal('refunds_payable')).toBe(0);
    expect(await bal('gateway_clearing')).toBe(10); // captured −1048, provider fee +5 (paid from revenue), refund +1053
    await dispatchEmails(h.ctx);
    expect(sent.some((m) => m.to === buyer.email && /Refund of \$10\.53 sent/.test(m.subject ?? ''))).toBe(true);
  });

  it('seller payouts: address confirmed by email link and 2FA, 6% fee with a $1.50 floor, CFO approval, paid by IPN', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 1M', priceCents: 100_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
    const pay = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    await ipn(paidIpn(fake.payments.get(pay.payment_id)));
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent' });
    await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
    await h.ctx.db.query(`UPDATE users SET payout_hold_days = 0 WHERE id = $1`, [seller.id]); // no payout hold, to keep the test about payouts
    const dash = (await seller.api.get('/v1/seller/dashboard')).body;
    expect(dash.balances.withdrawableCents).toBeGreaterThan(0);

    // Fee quote: 6% with a $1.50 floor.
    expect((await seller.api.get('/v1/seller/withdrawals/quote?amountCents=1000')).body).toMatchObject({ feeCents: 150, netCents: 850 });
    expect((await seller.api.get('/v1/seller/withdrawals/quote?amountCents=5000')).body).toMatchObject({ feeCents: 300, netCents: 4700 });

    // No address yet.
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 2000 })).body.error.code).toBe('no_payout_address');
    // Set one: the email carries a link; with 2FA on, the code is needed too.
    const setupRes = await seller.api.post('/v1/me/2fa/setup');
    const secret = new URL(setupRes.body.otpauthUri).searchParams.get('secret')!;
    await seller.api.post('/v1/me/2fa/enable', { code: totpAt(secret, currentStep()) });
    expect((await seller.api.post('/v1/seller/payout-address', { address: 'bad address with spaces!', currency: 'usdttrc20' })).body.error.code).toBe('invalid_address');
    expect((await seller.api.post('/v1/seller/payout-address', { address: 'TSellerAddress1234567890', currency: 'shib' })).body.error.code).toBe('unsupported_coin');
    const req = await seller.api.post('/v1/seller/payout-address', { address: 'TSellerAddress1234567890', currency: 'usdttrc20' });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    expect(req.body.pending).toMatchObject({ address: 'TSellerAddress1234567890' });
    expect(req.body.address).toBeNull();
    await dispatchEmails(h.ctx);
    const mail = sent.filter((m) => m.to === seller.email && m.subject === 'Confirm your new payout address').at(-1)!;
    expect(mail).toBeTruthy();
    const token = mail.body.match(/confirm-payout-address=([A-Za-z0-9_-]+)/)![1]!;
    expect((await seller.api.post('/v1/seller/payout-address/confirm', { token })).body.error.code).toBe('mfa_code_required');
    expect((await seller.api.post('/v1/seller/payout-address/confirm', { token, code: '000000' })).status).toBe(401);
    const confirmed = await seller.api.post('/v1/seller/payout-address/confirm', { token, code: totpAt(secret, currentStep() + 1) });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ address: 'TSellerAddress1234567890', currency: 'usdttrc20', currencyName: 'Tether (TRC-20)', pending: null });
    expect((await seller.api.post('/v1/seller/payout-address/confirm', { token, code: totpAt(secret, currentStep() + 2) })).body.error.code).toBe('link_expired');

    // Withdraw $20: gross leaves the balance now, waits for the CFO.
    const w = await seller.api.post('/v1/seller/withdrawals', { amountCents: 2000 });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body).toMatchObject({ status: 'pending_approval', fee_cents: 150, net_cents: 1850, destination_address: 'TSellerAddress1234567890', destination_currency: 'usdttrc20' });
    expect((await seller.api.get('/v1/seller/dashboard')).body.balances.availableCents).toBe(dash.balances.availableCents - 2000);
    const bal = async (kind: string) => Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = $1 AND e.memo LIKE $2`, [kind, `%:${w.body.id}`])).rows[0].s);
    expect(await bal('withdrawals_pending')).toBe(2000);

    // The CFO (finance role) sees it; a seller can't decide their own; rejection returns everything.
    const cfo = await makeUser(h, { tier: 2, role: 'finance' });
    expect((await cfo.api.get('/v1/admin/withdrawals')).body.map((x: any) => x.id)).toContain(w.body.id);
    expect((await seller.api.post(`/v1/admin/withdrawals/${w.body.id}/decide`, { approve: true })).status).toBe(403);
    const approved = await cfo.api.post(`/v1/admin/withdrawals/${w.body.id}/decide`, { approve: true, note: 'ok' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'processing' });
    expect(approved.body.payout_id).toBeTruthy();
    expect(fake.payouts.at(-1)).toMatchObject({ address: 'TSellerAddress1234567890', currency: 'usdttrc20', amount: 18.5 });
    expect(await bal('withdrawals_pending')).toBe(0);
    expect(await bal('payouts')).toBe(1850);
    expect(await bal('treasury')).toBe(150);

    // NOWPayments reports it sent.
    const done = await ipn({ id: approved.body.payout_id, batch_withdrawal_id: approved.body.provider_ref, status: 'FINISHED', error: null, currency: 'usdttrc20', amount: '18.5', address: 'TSellerAddress1234567890', hash: '0xhash1', ipn_callback_url: 'x', created_at: 'x', requested_at: 'x', updated_at: 'x' });
    expect(done.statusCode).toBe(200);
    const mine = (await seller.api.get('/v1/seller/withdrawals')).body;
    expect(mine.find((x: any) => x.id === w.body.id)).toMatchObject({ status: 'paid', tx_hash: '0xhash1' });

    // A second one, rejected: balance restored.
    const w2 = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 1000 })).body;
    const rejected = await cfo.api.post(`/v1/admin/withdrawals/${w2.id}/decide`, { approve: false, note: 'odd pattern' });
    expect(rejected.body.status).toBe('rejected');
    expect((await seller.api.get('/v1/seller/dashboard')).body.balances.availableCents).toBe(dash.balances.availableCents - 2000);

    // A failed payout after approval: fee and net back to the seller.
    const w3 = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 1000 })).body;
    const ap3 = (await cfo.api.post(`/v1/admin/withdrawals/${w3.id}/decide`, { approve: true })).body;
    await ipn({ id: ap3.payout_id, batch_withdrawal_id: ap3.provider_ref, status: 'FAILED', error: 'invalid address', currency: 'usdttrc20', amount: '8.5', address: 'TSellerAddress1234567890', hash: null });
    expect((await seller.api.get('/v1/seller/withdrawals')).body.find((x: any) => x.id === w3.id)).toMatchObject({ status: 'failed', failure_reason: 'invalid address' });
    expect((await seller.api.get('/v1/seller/dashboard')).body.balances.availableCents).toBe(dash.balances.availableCents - 2000);
  });

  it('a cart pays several orders with one crypto payment', async () => {
    const s1 = await makeUser(h, { tier: 2 });
    const s2 = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const a = await makeOffer(s1, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold A', priceCents: 7_00 });
    const b = await makeOffer(s2, { deliveryMode: 'manual', stock: 5, categorySlug: 'items', title: 'Item B', priceCents: 9_00 });
    const cart = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: a.id, quantity: 1 }, { offerId: b.id, quantity: 1 }], acceptTos: true });
    expect(cart.status, JSON.stringify(cart.body)).toBe(201);
    const checkoutId = cart.body.checkout.id;
    expect(cart.body.checkoutUrl).toMatch(new RegExp(`/checkouts/${checkoutId}/pay$`));
    const coins = (await buyer.api.get(`/v1/checkouts/${checkoutId}/crypto/coins`)).body;
    expect(coins.owedCents).toBe(16_85); // 7.37 + 9.48
    const pay = await buyer.api.post(`/v1/checkouts/${checkoutId}/crypto/pay`, { coin: 'btc' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.price_usd).toBe('16.85');
    await ipn(paidIpn(fake.payments.get(pay.body.payment_id)));
    const view = (await buyer.api.get(`/v1/checkouts/${checkoutId}`)).body;
    expect(view.checkout.status).toBe('paid');
    expect(view.orders.map((o: any) => o.status)).toEqual(['paid', 'paid']);
    expect((await buyer.api.get(`/v1/checkouts/${checkoutId}/crypto/payments`)).body[0].status).toBe('finished');
  });

  it('the on-chain escrow rail is off unless enabled', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 1, categorySlug: 'currency', title: 'Gold 1k', priceCents: 5_00 });
    const cfg = h.ctx.cfg as { ONCHAIN_ESCROW_ENABLED: boolean };
    const was = cfg.ONCHAIN_ESCROW_ENABLED;
    cfg.ONCHAIN_ESCROW_ENABLED = false;
    const res = await buyer.api.post('/v1/orders', { offerId: offer.id, rail: 'crypto', walletAddress: '0x1111111111111111111111111111111111111111', acceptTos: true });
    cfg.ONCHAIN_ESCROW_ENABLED = was;
    expect(res.body.error.code).toBe('rail_unavailable');
  });

  it('reconciles the store wallet balance against the ledger', async () => {
    // The fake wallet holds $1000; the ledger expects what was captured minus what was refunded. Match the fake to the books.
    const r = await runReconciliation(h.ctx);
    const mismatch = r.report.issues.find((i: any) => i.check === 'psp_balance_mismatch') as any;
    expect(mismatch, 'balance check ran').toBeTruthy();
    expect(mismatch.detail.actual).toBe(100_000);
    expect(mismatch.detail.expected).toBeGreaterThan(0);
  });

  it('keeps an underpayment that never got its top-up in the buyer’s balance, spendable or withdrawable, never refunded', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 300k', priceCents: 20_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
    const first = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    await ipn(paidIpn(fake.payments.get(first.payment_id), { payment_status: 'partially_paid', actually_paid: 12, actually_paid_at_fiat: 12, outcome_amount: 11.94 }));
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('awaiting_payment');
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(0);

    // The window lapses: the order is cancelled, the 11.94 that reached the wallet is the buyer's credit.
    await h.ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '2 hours' WHERE id = $1`, [order.id]);
    await runJobsOnce(h.ctx);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('cancelled');
    expect((await buyer.api.get('/v1/me/credit')).body).toMatchObject({ balanceCents: 1194, availableCents: 1194 });
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.crypto_payments[0]).toMatchObject({ status: 'credited' });
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.crypto_refund).toBeNull();
    await dispatchEmails(h.ctx);
    expect(sent.some((m) => m.to === buyer.email && /kept in your balance/.test(m.subject ?? ''))).toBe(true);
    // Idempotent: cancelling again (or re-running the reaper) credits nothing more.
    await runJobsOnce(h.ctx);
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(1194);

    // Spent at checkout like any credit...
    const quote = (await buyer.api.post('/v1/orders/quote', { offerId: offer.id, useCredit: true })).body;
    expect(quote).toMatchObject({ creditCents: 1194 });
    // ...or withdrawn to a confirmed payout address under the usual fee (no payout hold on credit).
    expect((await buyer.api.post('/v1/me/credit/withdraw', { amountCents: 1000 })).body.error.code).toBe('no_payout_address');
    await h.ctx.db.query(`UPDATE users SET payout_address = 'TBuyerAddress1234567890', payout_address_currency = 'usdttrc20', payout_address_set_at = now(), payouts_enabled = true WHERE id = $1`, [buyer.id]);
    expect((await buyer.api.post('/v1/me/credit/withdraw', { amountCents: 2000 })).body.error.code).toBe('insufficient_funds');
    const w = await buyer.api.post('/v1/me/credit/withdraw', { amountCents: 1000 });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body).toMatchObject({ status: 'pending_approval', source: 'credit', fee_cents: 150, net_cents: 850 });
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(194);
    const finance = await makeUser(h, { role: 'finance' });
    expect((await finance.api.post(`/v1/admin/withdrawals/${w.body.id}/decide`, { approve: false, note: 'test' })).status).toBe(200);
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(1194); // a rejected withdrawal goes back to credit
    // Every posting balanced: the credit came out of the gateway and went back on rejection.
    const unbalanced = (await h.ctx.db.query('SELECT txn_id FROM ledger_entries GROUP BY txn_id HAVING SUM(amount_cents) <> 0')).rows;
    expect(unbalanced).toEqual([]);
  });
});
