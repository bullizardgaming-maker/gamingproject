import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { dispatchEmails } from '../src/domain/notifications.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { currentStep, totpAt } from '../src/domain/mfa.js';
import { runJobsOnce } from '../src/worker.js';

import { FakeNow } from './fakeNowPayments.js';

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

    // $10: BTC (min $8) and USDT fit; ETH (min $12) is listed greyed out with its minimum.
    const coins = (await buyer.api.get(`/v1/orders/${order.id}/crypto/coins`)).body;
    expect(coins.owedCents).toBe(10_53); // the seller's 10.00 plus the 5% launch-promo commission
    // Popular coins first (USDT, BTC, …, LTC), unavailable ones last with the reason; each carries its network and a fee estimate.
    expect(coins.coins.map((c: any) => [c.coin, c.available])).toEqual([['usdttrc20', true], ['btc', true], ['ltc', true], ['eth', false]]);
    expect(coins.coins.find((c: any) => c.coin === 'eth')).toMatchObject({ minUsd: 12, disabled: true, reason: 'Minimum for this coin is $12.00', network: 'Ethereum' });
    expect(coins.coins[0]).toMatchObject({ network: 'TRC-20', fee_cents: 1_00, total_cents: 11_53 });
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
    // CFO B1: the provider's fee is booked once. The buyer sent 10.53 (gross), 10.48 reached the wallet: gateway shows
    // −10.53 + 5 (psp_fee) = −10.48, the fee is paid from the treasury, nothing in FX gain/loss.
    expect(legs).toEqual([
      { kind: 'escrow', amount_cents: 1053 },
      { kind: 'gateway_clearing', amount_cents: -1053 },
    ]);
    const feeLegs = (await h.ctx.db.query(`SELECT a.kind, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.order_id = $1 AND e.memo = 'psp_fee' ORDER BY a.kind`, [order.id])).rows;
    expect(feeLegs).toEqual([{ kind: 'gateway_clearing', amount_cents: 5 }, { kind: 'treasury', amount_cents: -5 }]);
    const gateway = Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'gateway_clearing' AND e.order_id = $1`, [order.id])).rows[0].s);
    expect(gateway).toBe(-1048); // exactly what is in the wallet for this order
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
    expect(coins.coins.filter((c: any) => c.available).map((c: any) => c.coin)).toEqual(['usdttrc20', 'ltc']);
    const second = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    expect(second.price_usd).toBe('6.06');
    const p2 = fake.payments.get(second.payment_id);
    expect(p2.purchase_id).toBe(p1.purchase_id);
    await ipn(paidIpn(p2, { actually_paid: 6.06, actually_paid_at_fiat: 6.06, outcome_amount: 6.03 }));
    const paid = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(paid.status).toBe('paid');
    expect(paid.crypto_payments).toHaveLength(2);
    // Gross 15.00 + 6.06 = 21.06 captured; 14.90 + 6.03 = 20.93 reached the wallet; the 0.13 fee is booked once (psp_fee).
    const gw = (await h.ctx.db.query(`SELECT e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.order_id = $1 AND e.memo = 'payment_captured' AND a.kind = 'gateway_clearing'`, [order.id])).rows[0];
    expect(Number(gw.amount_cents)).toBe(-2106);
    const gwTotal = Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.order_id = $1 AND a.kind = 'gateway_clearing'`, [order.id])).rows[0].s);
    expect(gwTotal).toBe(-2093);
  });

  it('refunds land in the buyer’s balance; withdrawing it costs 6% with a $1.50 floor', async () => {
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

    const detail = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(detail.status).toBe('refunded');
    expect(detail.crypto_refund).toBeNull(); // nothing goes back on-chain: the money is balance now
    const bal = async (kind: string) => Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = $1 AND e.order_id = $2`, [kind, order.id])).rows[0].s);
    expect(await bal('refunds_payable')).toBe(0);
    expect(await bal('escrow')).toBe(0);
    expect((await buyer.api.get('/v1/me/credit')).body).toMatchObject({ balanceCents: 1053, availableCents: 1053 });
    expect((await buyer.api.get(`/v1/chat/rooms/${detail.room_id}/messages`)).body.some((m: any) => m.code === 'dispute_buyer')).toBe(true);
    await dispatchEmails(h.ctx);
    expect(sent.some((m) => m.to === buyer.email && /back in your Bullizard balance/.test(m.body ?? ''))).toBe(true);

    // Withdrawing the balance: 6% fee, minimum $1.50 → 10.53 costs 1.50, nets 9.03. Needs a confirmed payout address.
    expect((await buyer.api.post('/v1/me/withdrawals', { amountCents: 1053 })).body.error.code).toBe('no_payout_address');
    await h.ctx.db.query(`UPDATE users SET payout_address = 'TXYZabc1234567890refund', payout_address_currency = 'usdttrc20' WHERE id = $1`, [buyer.id]);
    const w = await buyer.api.post('/v1/me/withdrawals', { amountCents: 1053 });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body).toMatchObject({ amount_cents: 1053, fee_cents: 150, net_cents: 903, source: 'credit', status: 'pending_approval' });
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(0);
  });

  it('unverified sellers withdraw during their first 30 days; after the ID deadline their earnings wait for verification', async () => {
    const seller = await makeUser(h, { tier: 1, rulesPassed: true });
    await h.ctx.db.query(`UPDATE users SET payout_address = 'TXYZabc1234567890seller', payout_address_currency = 'usdttrc20', payout_hold_days = 0 WHERE id = $1`, [seller.id]);
    // Day 10: allowed (balance permitting).
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 2000 })).body.error.code).toBe('insufficient_funds');
    // Day 31: restricted until Tier 2 — computed from seller_since even before the worker has flagged the account (Round 20).
    await h.ctx.db.query(`UPDATE users SET seller_since = now() - interval '31 days' WHERE id = $1`, [seller.id]);
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 2000 })).body.error.code).toBe('kyc_overdue');
    expect((await seller.api.post('/v1/offers', { categorySlug: 'keys', game: 'Test Game', title: 'Late key', priceCents: 5_00, deliveryMode: 'auto' })).body.error.code).toBe('kyc_overdue');
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
    const done = await ipn({ id: approved.body.payout_id, batch_withdrawal_id: approved.body.provider_ref, status: 'FINISHED', error: null, currency: 'usdttrc20', amount: '18.5', fee: '1.2', address: 'TSellerAddress1234567890', hash: '0xhash1', ipn_callback_url: 'x', created_at: 'x', requested_at: 'x', updated_at: 'x' });
    expect(done.statusCode).toBe(200);
    const mine = (await seller.api.get('/v1/seller/withdrawals')).body;
    expect(mine.find((x: any) => x.id === w.body.id)).toMatchObject({ status: 'paid', tx_hash: '0xhash1', network_fee_cents: 120 });
    // CFO B2: the network fee the provider took leaves the wallet and is paid by the treasury (treasury → gateway_clearing).
    const netFee = (await h.ctx.db.query(`SELECT a.kind, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.memo = $1 ORDER BY a.kind`, [`payout_network_fee:${w.body.id}`])).rows;
    expect(netFee).toEqual([{ kind: 'gateway_clearing', amount_cents: 120 }, { kind: 'treasury', amount_cents: -120 }]);
    expect((await h.ctx.db.query(`SELECT sum(amount_cents)::int AS s FROM ledger_entries WHERE memo = $1`, [`payout_network_fee:${w.body.id}`])).rows[0].s).toBe(0);
    // USDT only at launch: other coins are refused as payout addresses.
    expect((await seller.api.post('/v1/seller/payout-address', { address: 'bc1qnotallowedatlaunch0000000', currency: 'btc' })).body.error.code).toBe('unsupported_coin');

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

  it('without an authenticator, a payout address needs the emailed link plus a one-time code by email (Round 24: never by SMS, even with a verified phone)', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const req = await seller.api.post('/v1/seller/payout-address', { address: 'TNoTotpAddress1234567890', currency: 'usdttrc20' });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    await dispatchEmails(h.ctx);
    const link = sent.filter((m) => m.to === seller.email && m.subject === 'Confirm your new payout address').at(-1)!;
    expect(link.body).toMatch(/the code in our other email/);
    const token = link.body.match(/confirm-payout-address=([A-Za-z0-9_-]+)/)![1]!;
    const codeMail = sent.filter((m) => m.to === seller.email && /code to confirm the new payout address/.test(m.subject ?? '')).at(-1)!;
    const code = codeMail.body.match(/Your code is (\d{6})/)![1]!;
    expect((await seller.api.post('/v1/seller/payout-address/confirm', { token })).body.error.code).toBe('mfa_code_required');
    expect((await seller.api.post('/v1/seller/payout-address/confirm', { token, code: '000000' })).status).toBe(401);
    const ok = await seller.api.post('/v1/seller/payout-address/confirm', { token, code });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.address).toBe('TNoTotpAddress1234567890');

    // Round 24: a verified phone changes nothing; the code still comes by email.
    const phoneSeller = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`UPDATE users SET phone = '+201012345678', phone_verified_at = now() WHERE id = $1`, [phoneSeller.id]);
    const before = sent.length;
    await phoneSeller.api.post('/v1/seller/payout-address', { address: 'TSmsAddress1234567890xyz', currency: 'usdttrc20' });
    await dispatchEmails(h.ctx);
    expect(sent.slice(before).some((m: any) => m.channel === 'sms')).toBe(false);
    expect(sent.slice(before).find((m: any) => m.to === phoneSeller.email && /code to confirm the new payout address/.test(m.subject ?? ''))?.body).toMatch(/\d{6}/);
  });

  it('four-eyes above $500 (second approval by the Lead), and a platform daily payout cap (CFO B9, B5)', async () => {
    const { forgetControlsCache } = await import('../src/domain/controls.js');
    const admin = await makeUser(h, { tier: 2, role: 'admin' });
    await admin.api.put('/v1/admin/controls', { four_eyes_withdrawal_cents: 500_00, four_eyes_user_day_cents: 1000_00, max_platform_payout_day_cents: 1500_00, max_withdrawal_day_cents: 100000_00 });
    forgetControlsCache();
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 10, categorySlug: 'currency', title: 'Gold 5M', priceCents: 700_00 });
    for (let i = 0; i < 3; i++) {
      const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
      const pay = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
      await ipn(paidIpn(fake.payments.get(pay.payment_id)));
      await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent' });
      await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
    }
    await h.ctx.db.query(`UPDATE users SET payout_hold_days = 0, payout_address = 'TFourEyes1234567890abcd', payout_address_currency = 'usdttrc20', payout_address_set_at = now() WHERE id = $1`, [seller.id]);
    const finance = await makeUser(h, { tier: 2, role: 'finance' });
    const finance2 = await makeUser(h, { tier: 2, role: 'finance' });
    const lead = await makeUser(h, { tier: 2, role: 'lead' });

    // $300: one approval is enough.
    const small = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 300_00 })).body;
    expect((await finance.api.post(`/v1/admin/withdrawals/${small.id}/decide`, { approve: true })).body.status).toBe('processing');
    // $800: the first approval only records; the same person cannot give the second; a second finance member is not the Lead.
    const big = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 800_00 })).body;
    const first = await finance.api.post(`/v1/admin/withdrawals/${big.id}/decide`, { approve: true, note: 'Sales check out' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ status: 'pending_approval', needs_second_approval: true });
    expect(fake.payouts.filter((p) => p.unique_external_id === big.id)).toHaveLength(0);
    expect((await finance.api.post(`/v1/admin/withdrawals/${big.id}/decide`, { approve: true })).body.error.code).toBe('four_eyes');
    expect((await finance2.api.post(`/v1/admin/withdrawals/${big.id}/decide`, { approve: true })).body.error.code).toBe('lead_required');
    // Round 22: the Lead never gives the first approval, never approves a small one alone.
    const leadFirst = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 700_00 })).body;
    expect((await lead.api.post(`/v1/admin/withdrawals/${leadFirst.id}/decide`, { approve: true })).body.error.code).toBe('finance_first');
    await finance.api.post(`/v1/admin/withdrawals/${leadFirst.id}/decide`, { approve: false, note: 'Not now' });
    const second = await lead.api.post(`/v1/admin/withdrawals/${big.id}/decide`, { approve: true });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.status).toBe('processing');
    expect(fake.payouts.filter((p) => p.unique_external_id === big.id)).toHaveLength(1);
    const audit = (await h.ctx.db.query(`SELECT action FROM admin_audit_log WHERE target_id = $1 ORDER BY created_at`, [big.id])).rows.map((r) => r.action);
    expect(audit).toEqual(['withdrawal.first_approve', 'withdrawal.approve']);

    // Platform cap: $1,500 net per day; 282 + 752 already out, another $600 would cross it.
    const third = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 600_00 })).body;
    await finance.api.post(`/v1/admin/withdrawals/${third.id}/decide`, { approve: true });
    const capped = await lead.api.post(`/v1/admin/withdrawals/${third.id}/decide`, { approve: true });
    expect(capped.body.error.code).toBe('platform_payout_cap');
    await admin.api.put('/v1/admin/controls', { four_eyes_withdrawal_cents: 100000_00, four_eyes_user_day_cents: 100000_00, max_platform_payout_day_cents: 100000_00 });
    forgetControlsCache();
  });

  it('a payout call that times out never pays twice: the withdrawal waits as unknown until the provider confirms', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 2M', priceCents: 100_00 });
    for (let i = 0; i < 2; i++) {
      const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
      const pay = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
      await ipn(paidIpn(fake.payments.get(pay.payment_id)));
      await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent' });
      await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
    }
    await h.ctx.db.query(`UPDATE users SET payout_hold_days = 0, payout_address = 'TSellerTimeout1234567890', payout_address_currency = 'usdttrc20', payout_address_set_at = now() WHERE id = $1`, [seller.id]);
    const cfo = await makeUser(h, { tier: 2, role: 'finance' });
    const bal = async (kind: string, id: string) => Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = $1 AND e.memo LIKE $2`, [kind, `%:${id}`])).rows[0].s);
    const available = async () => (await seller.api.get('/v1/seller/dashboard')).body.balances.availableCents;
    const before = await available();

    // 1. The provider created the payout but the answer never came back.
    const w1 = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 2000 })).body;
    fake.payoutMode = 'timeout';
    const r1 = await cfo.api.post(`/v1/admin/withdrawals/${w1.id}/decide`, { approve: true });
    expect(r1.status).toBe(502);
    expect(r1.body.error.code).toBe('payout_unknown');
    let row = (await seller.api.get('/v1/seller/withdrawals')).body.find((x: any) => x.id === w1.id);
    expect(row.status).toBe('unknown');
    expect(await bal('payouts', w1.id)).toBe(1850); // money stays booked as paid out: nothing goes back on a guess
    expect(await available()).toBe(before - 2000);
    expect(fake.payouts.filter((p) => p.unique_external_id === w1.id)).toHaveLength(1);
    // Approving again does not create a second payout (idempotency key = withdrawal id) and is refused anyway.
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w1.id}/decide`, { approve: true })).status).toBe(409);
    // Round 22: Ops can't recheck in the first minutes after the call (the provider may still be creating it).
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w1.id}/recheck`, {})).body.error.code).toBe('too_early');
    await h.ctx.db.query(`UPDATE withdrawals SET provider_attempted_at = now() - interval '15 minutes' WHERE id = $1`, [w1.id]);
    // The recheck finds it at the provider → processing, then the IPN pays it.
    const rechecked = await cfo.api.post(`/v1/admin/withdrawals/${w1.id}/recheck`, {});
    expect(rechecked.status, JSON.stringify(rechecked.body)).toBe(200);
    expect(rechecked.body).toMatchObject({ status: 'processing', payout_id: fake.payouts.find((p) => p.unique_external_id === w1.id)!.id });
    await ipn({ id: rechecked.body.payout_id, batch_withdrawal_id: rechecked.body.provider_ref, status: 'FINISHED', error: null, currency: 'usdttrc20', amount: '18.5', address: 'TSellerTimeout1234567890', hash: '0xhash-late' });
    row = (await seller.api.get('/v1/seller/withdrawals')).body.find((x: any) => x.id === w1.id);
    expect(row).toMatchObject({ status: 'paid', tx_hash: '0xhash-late' });
    expect(fake.payouts.filter((p) => p.unique_external_id === w1.id)).toHaveLength(1);

    // 2. The provider was down (503, nothing created): unknown, then the recheck finds nothing → reversed.
    const w2 = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 1000 })).body;
    fake.payoutMode = 'down';
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w2.id}/decide`, { approve: true })).body.error.code).toBe('payout_unknown');
    expect(await available()).toBe(before - 3000);
    const { recheckUnknownPayouts } = await import('../src/domain/cryptoPayouts.js');
    // Round 22: "not found" reverses only after two answers 30+ minutes apart and PAYOUT_UNKNOWN_REVERSE_HOURS (6) after the call.
    await h.ctx.db.query(`UPDATE withdrawals SET updated_at = now() - interval '5 minutes' WHERE id = $1`, [w2.id]);
    expect(await recheckUnknownPayouts(h.ctx)).toBeGreaterThanOrEqual(1);
    row = (await seller.api.get('/v1/seller/withdrawals')).body.find((x: any) => x.id === w2.id);
    expect(row.status).toBe('unknown'); // one "not found", and too soon anyway
    await h.ctx.db.query(`UPDATE withdrawals SET provider_attempted_at = now() - interval '7 hours', updated_at = now() - interval '5 minutes' WHERE id = $1`, [w2.id]);
    await recheckUnknownPayouts(h.ctx);
    expect((await h.ctx.db.query('SELECT status, not_found_checks FROM withdrawals WHERE id = $1', [w2.id])).rows[0]).toMatchObject({ status: 'unknown', not_found_checks: 1 }); // the second answer came too soon after the first
    await h.ctx.db.query(`UPDATE withdrawals SET last_not_found_at = now() - interval '31 minutes', updated_at = now() - interval '5 minutes' WHERE id = $1`, [w2.id]);
    await recheckUnknownPayouts(h.ctx);
    row = (await seller.api.get('/v1/seller/withdrawals')).body.find((x: any) => x.id === w2.id);
    expect(row.status).toBe('failed');
    expect(await available()).toBe(before - 2000);

    // 3. A definite rejection (400) reverses at once.
    const w3 = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 1000 })).body;
    fake.payoutMode = 'reject';
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w3.id}/decide`, { approve: true })).body.error.code).toBe('payout_failed');
    expect((await seller.api.get('/v1/seller/withdrawals')).body.find((x: any) => x.id === w3.id).status).toBe('failed');
    expect(await available()).toBe(before - 2000);
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

  it('reconciles the store wallet balance against the ledger, valuing every coin in USD, within $1, with a daily snapshot (CFO B7)', async () => {
    // The fake wallet holds $1000 of USDT plus 0.01 BTC (valued at the provider's rate); the ledger expects what was
    // captured minus what was refunded. Match the fake to the books.
    fake.extraBalance = { btc: { amount: 0.01 } };
    const r = await runReconciliation(h.ctx);
    const mismatch = r.report.issues.find((i: any) => i.check === 'psp_balance_mismatch') as any;
    expect(mismatch, 'balance check ran').toBeTruthy();
    expect(mismatch.detail.actual).toBe(100_000 + 600_00);
    expect(mismatch.detail.expected).toBeGreaterThanOrEqual(0);
    for (const k of ['user_credit', 'withdrawals_pending', 'refunds_payable', 'reserve', 'tax_payable']) expect(r.report.totals).toHaveProperty(k);
    // Within the tolerance ($1.00): the same books with the wallet a few cents off is not a mismatch.
    fake.extraBalance = { usdttrc20: { amount: (mismatch.detail.expected + 60) / 100 } };
    const close = await runReconciliation(h.ctx);
    expect(close.report.issues.find((i: any) => i.check === 'psp_balance_mismatch')).toBeUndefined();
    fake.extraBalance = null;
    const snap = (await h.ctx.db.query(`SELECT status, psp_actual_cents FROM reconciliation_snapshots WHERE day = CURRENT_DATE AND currency = 'USD'`)).rows[0];
    expect(snap.status).toBe('ok');
    const admin = await makeUser(h, { role: 'admin' });
    expect((await admin.api.get('/v1/admin/reconciliation/snapshots')).body[0]).toMatchObject({ currency: 'USD', status: 'ok' });
  });

  it('an overpayment above the 0.5% tolerance is the buyer’s credit; within it, Bullizard keeps the difference (CFO B6)', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 900k', priceCents: 100_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order; // 105.27
    const pay = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    const p = fake.payments.get(pay.payment_id);
    // The buyer sends 110.00 instead of 105.27: 4.73 over, beyond the tolerance (0.53).
    await ipn(paidIpn(p, { actually_paid: 110, actually_paid_at_fiat: 110, outcome_amount: 110 * 0.995 }));
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('paid');
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(11000 - order.amount_cents);
    const legs = (await h.ctx.db.query(`SELECT a.kind, SUM(e.amount_cents)::int AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.order_id = $1 GROUP BY a.kind ORDER BY a.kind`, [order.id])).rows;
    const by = Object.fromEntries(legs.map((l) => [l.kind, l.s]));
    expect(by.escrow).toBe(order.amount_cents);
    expect(by.user_credit).toBe(11000 - order.amount_cents);
    expect(by.fx_pnl ?? 0).toBe(0);
    expect(by.gateway_clearing).toBe(-Math.round(110 * 0.995 * 100)); // what is in the wallet
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.events.some((e: any) => e.reason === 'overpayment_credited')).toBe(true);

    // Within the tolerance (0.30 over on 105.27): nothing to the buyer, the difference is FX gain.
    const o2 = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
    const pay2 = (await buyer.api.post(`/v1/orders/${o2.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    await ipn(paidIpn(fake.payments.get(pay2.payment_id), { actually_paid: 105.57, actually_paid_at_fiat: 105.57, outcome_amount: 105.57 * 0.995 }));
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(11000 - order.amount_cents);
    const fx2 = (await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0)::int AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.order_id = $1 AND a.kind = 'fx_pnl'`, [o2.id])).rows[0].s;
    expect(fx2).toBe(30);
  });

  it('a deposit that lands after the order was cancelled is credited to the buyer once, with later IPNs adding only the difference', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 400k', priceCents: 20_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
    const pay = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    // Nothing arrives in time: the order lapses with the payment still 'waiting'.
    await h.ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '2 hours' WHERE id = $1`, [order.id]);
    await runJobsOnce(h.ctx);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('cancelled');
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(0);
    const credit = async () => (await buyer.api.get('/v1/me/credit')).body.balanceCents;
    const clearing = async () => Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'gateway_clearing' AND e.memo = 'crypto_late_deposit' AND e.order_id = $1`, [order.id])).rows[0].s);

    // The coins show up late, in two steps: 8 then the full 21.06 (what reached the wallet counts).
    await ipn(paidIpn(fake.payments.get(pay.payment_id), { payment_status: 'partially_paid', actually_paid: 8, actually_paid_at_fiat: 8, outcome_amount: 7.96 }));
    expect(await credit()).toBe(796);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('cancelled'); // never un-cancelled
    await ipn(paidIpn(fake.payments.get(pay.payment_id)));
    const settled = Math.round(Number(fake.payments.get(pay.payment_id).price_amount) * 0.995 * 100);
    expect(await credit()).toBe(settled); // only the difference was added
    expect(await clearing()).toBe(-settled);
    // The same IPN again, and a 'confirmed' re-send: nothing more, and the row stays 'credited'.
    await ipn(paidIpn(fake.payments.get(pay.payment_id)));
    await ipn(paidIpn(fake.payments.get(pay.payment_id), { payment_status: 'confirmed' }));
    expect(await credit()).toBe(settled);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.crypto_payments[0]).toMatchObject({ status: 'credited' });
    expect(Number((await h.ctx.db.query('SELECT credited_cents FROM crypto_payments WHERE payment_id = $1', [String(pay.payment_id)])).rows[0].credited_cents)).toBe(settled);
    await dispatchEmails(h.ctx);
    expect(sent.filter((m) => m.to === buyer.email && /kept in your balance/.test(m.subject ?? ''))).toHaveLength(2); // one per new amount
  });

  it('a second deposit on an order already funded goes to the balance, and a cart credits a late deposit once across its orders', async () => {
    const s1 = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(s1, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold C', priceCents: 10_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
    const first = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    // The first payment's window lapses at the provider; the buyer opens a second one, then sends both.
    await h.ctx.db.query(`UPDATE crypto_payments SET expires_at = now() - interval '1 minute' WHERE payment_id = $1`, [String(first.payment_id)]);
    const second = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'btc' })).body;
    expect(second.payment_id, JSON.stringify(second)).toBeTruthy();
    await ipn(paidIpn(fake.payments.get(first.payment_id)));
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('paid');
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(0);
    // ...and then paid the second one too. Not lost: it is balance.
    await ipn(paidIpn(fake.payments.get(second.payment_id)));
    const extra = Math.round(Number(fake.payments.get(second.payment_id).price_amount) * 0.995 * 100);
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(extra);
    await ipn(paidIpn(fake.payments.get(second.payment_id)));
    expect((await buyer.api.get('/v1/me/credit')).body.balanceCents).toBe(extra);

    // A cart: both orders lapse, the one payment arrives late → credited once, not once per order.
    const b = await makeOffer(s1, { deliveryMode: 'manual', stock: 5, categorySlug: 'items', title: 'Item D', priceCents: 9_00 });
    const cart = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: offer.id, quantity: 1 }, { offerId: b.id, quantity: 1 }], acceptTos: true });
    const checkoutId = cart.body.checkout.id;
    const pay = (await buyer.api.post(`/v1/checkouts/${checkoutId}/crypto/pay`, { coin: 'btc' })).body;
    await h.ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '2 hours' WHERE checkout_id = $1`, [checkoutId]);
    await runJobsOnce(h.ctx);
    expect((await buyer.api.get(`/v1/checkouts/${checkoutId}`)).body.orders.map((o: any) => o.status)).toEqual(['cancelled', 'cancelled']);
    await ipn(paidIpn(fake.payments.get(pay.payment_id)));
    await ipn(paidIpn(fake.payments.get(pay.payment_id)));
    const cartSettled = Math.round(Number(fake.payments.get(pay.payment_id).price_amount) * 0.995 * 100);
    const bal = (await buyer.api.get('/v1/me/credit')).body.balanceCents;
    expect(bal, JSON.stringify({ extra, cartSettled, price: fake.payments.get(pay.payment_id).price_amount, cart: cart.body })).toBe(extra + cartSettled);
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
