import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { FakeNow } from './fakeNowPayments.js';
import { createContext } from '../src/context.js';
import { MemoryPubSub } from '../src/lib/pubsub.js';
import { buildApp } from '../src/server.js';

const IPN_SECRET = 'ipn-secret-for-tests';
let h: Harness;
let fake: FakeNow;

beforeAll(async () => {
  fake = new FakeNow();
  const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', email: 'e', password: 'p', twoFactorSecret: 'JBSWY3DPEHPK3PXP', fetch: fake.fetch as any });
  h = await setup({ PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET, NOWPAYMENTS_FEE_BPS: 0 /* Round 28: these tests predate the buyer-paid fee; round28.test.ts covers it */, FX_STATIC_RATES: '{"EUR":0.92,"EGP":48.5}' }, { payments });
});
afterAll(async () => h.close());

async function ipn(body: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: JSON.stringify(sortDeep(body)) });
}

/**
 * What the NOWPayments sandbox (and production without fiat conversion) really sends on a finished payment — the
 * shape from the IPN documentation: `actually_paid_at_fiat` is 0, the fee object is in the PAY coin, price_currency is
 * lower case, the outcome is the merchant's settlement coin (usdtbsc here).
 */
const sandboxFinished = (p: any, over: Record<string, unknown> = {}) => ({
  payment_id: Number(p.payment_id),
  parent_payment_id: null,
  invoice_id: null,
  payment_status: 'finished',
  pay_address: p.pay_address,
  payin_extra_id: null,
  price_amount: p.price_amount,
  price_currency: String(p.price_currency).toLowerCase(),
  pay_amount: p.pay_amount,
  actually_paid: p.pay_amount,
  actually_paid_at_fiat: 0,
  pay_currency: p.pay_currency,
  order_id: p.order_id,
  order_description: 'Bullizard order',
  purchase_id: p.purchase_id,
  outcome_amount: Math.round(p.price_amount * 0.995 * 1e6) / 1e6,
  outcome_currency: 'usdtbsc',
  payment_extra_ids: null,
  fee: { currency: p.pay_currency, depositFee: 0.0000012, withdrawalFee: 0, serviceFee: 0.0000025 },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

async function newOrder(priceCents = 20_00) {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 100k', priceCents });
  const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { seller, buyer, order: created.body.order };
}

describe('Round 26 A1 — the sandbox "finished" IPN funds the order', () => {
  it('USD invoice, usdtbsc outcome, actually_paid_at_fiat 0 (the documented IPN shape): the order is paid, not left waiting', async () => {
    const { buyer, order } = await newOrder();
    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'btc', priceCurrency: 'USD' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const p = fake.payments.get(pay.body.payment_id);
    const res = await ipn(sandboxFinished(p));
    expect(res.statusCode).toBe(200);
    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.status).toBe('paid');
    expect(view.crypto_payments).toHaveLength(1);
    expect(view.crypto_payments[0]).toMatchObject({ status: 'finished', state: 'paid', order_status: 'paid' });
    // What funded the order is what reached the wallet (USDT BEP-20), and the fee is NOWPayments' share of the invoice.
    const row = (await h.ctx.db.query('SELECT applied_cents, actually_paid_usd::text AS paid FROM crypto_payments WHERE payment_id = $1', [pay.body.payment_id])).rows[0];
    expect(Number(row.applied_cents)).toBe(Math.round(p.price_amount * 0.995 * 100));
    expect(Number(row.paid)).toBeCloseTo(p.price_amount, 2);
  });

  it('the same payload through the poll (/crypto/payments/:id/refresh) funds the order too, and a finished row that was never applied is re-applied', async () => {
    const { buyer, order } = await newOrder();
    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' });
    const p = fake.payments.get(pay.body.payment_id);
    Object.assign(p, sandboxFinished(p)); // the provider now reports it finished, sandbox-style
    const polled = await buyer.api.post(`/v1/orders/${order.id}/crypto/payments/${pay.body.payment_id}/refresh`);
    expect(polled.status, JSON.stringify(polled.body)).toBe(200);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('paid');

    // A row stuck as 'finished' but never applied (what staging had): a poll does not skip it.
    const { buyer: b2, order: o2 } = await newOrder();
    const pay2 = await b2.api.post(`/v1/orders/${o2.id}/crypto/pay`, { coin: 'usdttrc20' });
    const p2 = fake.payments.get(pay2.body.payment_id);
    Object.assign(p2, sandboxFinished(p2));
    await h.ctx.db.query(`UPDATE crypto_payments SET status = 'finished', actually_paid_usd = NULL WHERE payment_id = $1`, [pay2.body.payment_id]);
    await b2.api.post(`/v1/orders/${o2.id}/crypto/payments/${pay2.body.payment_id}/refresh`);
    expect((await b2.api.get(`/v1/orders/${o2.id}`)).body.status).toBe('paid');
  });

  it('EUR invoice with the sandbox shape: valued in proportion to the invoice, the order is paid for exactly the USD owed', async () => {
    const { buyer, order } = await newOrder(20_00);
    const quote = await buyer.api.post(`/v1/orders/${order.id}/fx-quote`, { currency: 'EUR' });
    expect(quote.status).toBe(200);
    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'btc', priceCurrency: 'EUR' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.price_currency).toBe('EUR');
    const p = fake.payments.get(pay.body.payment_id);
    await ipn(sandboxFinished({ ...p, price_currency: 'eur' }, { outcome_amount: Number(order.charged_cents ?? order.amount_cents) / 100 }));
    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.status).toBe('paid');
    expect(view.crypto_payments[0].state).toBe('paid');
    const row = (await h.ctx.db.query('SELECT actually_paid_usd::text AS paid, review_reason FROM crypto_payments WHERE payment_id = $1', [pay.body.payment_id])).rows[0];
    expect(row.review_reason).toBeNull();
    expect(Number(row.paid)).toBeCloseTo(Number(order.charged_cents ?? order.amount_cents) / 100, 2);
  });

  it('a fee object in the pay coin is not mistaken for USD', async () => {
    const { buyer, order } = await newOrder(20_00);
    await buyer.api.post(`/v1/orders/${order.id}/fx-quote`, { currency: 'EUR' });
    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'btc', priceCurrency: 'EUR' });
    const p = fake.payments.get(pay.body.payment_id);
    // A BTC fee of 0.0000037 is worth cents, not $0.0000037 and not 0.0000037 USD cents → the psp_fee leg must be tiny, not the whole gap.
    await ipn(sandboxFinished({ ...p, price_currency: 'eur' }, { fee: { currency: 'btc', depositFee: 0.000002, withdrawalFee: 0, serviceFee: 0.0000017 } }));
    const legs = (await h.ctx.db.query(`SELECT e.memo, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.order_id = $1 AND a.kind = 'treasury' AND e.memo IN ('psp_fee', 'crypto_fx')`, [order.id])).rows;
    const fee = legs.find((l: any) => l.memo === 'psp_fee');
    // The fee is NOWPayments' default share of the invoice (NOWPAYMENTS_FEE_BPS), never the raw coin figure.
    const paidCents = Number(order.charged_cents ?? order.amount_cents);
    expect(Math.abs(Number(fee?.amount_cents ?? 0))).toBeLessThanOrEqual(Math.ceil((paidCents * h.ctx.cfg.NOWPAYMENTS_FEE_BPS) / 10_000) + 1);
  });

  it('A2/A3: every payment carries a buyer state; staff see the list and can re-check with the provider (audited)', async () => {
    const { buyer, order } = await newOrder();
    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' });
    const p = fake.payments.get(pay.body.payment_id);
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.crypto_payments[0]).toMatchObject({ state: 'waiting', order_status: 'awaiting_payment' });
    await ipn(sandboxFinished(p, { payment_status: 'confirming', actually_paid: 0, outcome_amount: null }));
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.crypto_payments[0].state).toBe('confirming');
    await ipn(sandboxFinished(p, { payment_status: 'partially_paid', actually_paid: p.pay_amount / 2, outcome_amount: p.price_amount / 2 }));
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.crypto_payments[0].state).toBe('underpaid');
    // Staff list: finds it by payment id and by order ref; nobody without ledger.view sees it.
    const finance = await makeUser(h, { role: 'finance' });
    const arbiter = await makeUser(h, { role: 'arbiter' });
    expect((await arbiter.api.get('/v1/admin/crypto/payments')).status).toBe(403);
    const list = await finance.api.get(`/v1/admin/crypto/payments?q=${pay.body.payment_id}`);
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({ payment_id: pay.body.payment_id, order_id: order.id, status: 'partially_paid', state: 'underpaid', buyer_id: buyer.id });
    expect(list.body[0].last_ipn_at).toBeTruthy();
    const ref = (await h.ctx.db.query('SELECT ref FROM orders WHERE id = $1', [order.id])).rows[0].ref;
    expect((await finance.api.get(`/v1/admin/crypto/payments?q=${encodeURIComponent(ref)}`)).body[0].payment_id).toBe(pay.body.payment_id);
    // The provider now says finished (the IPN never arrived): re-check applies it and is audited.
    Object.assign(p, sandboxFinished(p));
    const re = await finance.api.post(`/v1/admin/crypto/payments/${pay.body.payment_id}/recheck`);
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body).toMatchObject({ before: 'partially_paid', provider_status: 'finished' });
    expect(re.body.payment).toMatchObject({ status: 'finished', state: 'paid', order_status: 'paid' });
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('paid');
    const audit = await h.ctx.db.query(`SELECT details FROM admin_audit_log WHERE action = 'crypto_payment.recheck' AND target_id = $1`, [pay.body.payment_id]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].details).toMatchObject({ before: 'partially_paid', providerStatus: 'finished', state: 'paid' });
    // Held for review shows as such to both.
    const { buyer: b2, order: o2 } = await newOrder(20_00);
    await b2.api.post(`/v1/orders/${o2.id}/fx-quote`, { currency: 'EUR' });
    const pay2 = await b2.api.post(`/v1/orders/${o2.id}/crypto/pay`, { coin: 'btc', priceCurrency: 'EUR' });
    await ipn(sandboxFinished({ ...fake.payments.get(pay2.body.payment_id), price_currency: 'usd' }));
    expect((await b2.api.get(`/v1/orders/${o2.id}`)).body.crypto_payments[0].state).toBe('held_for_review');
    expect((await finance.api.get(`/v1/admin/crypto/payments?q=${pay2.body.payment_id}`)).body[0]).toMatchObject({ state: 'held_for_review', review_reason: 'ipn_price_currency_usd' });
  });

  it('A1: the IPN route is reachable at the origin without the Cloudflare header (the signature is its authentication)', async () => {
    const silent = { info() {}, warn() {}, error() {} } as any;
    const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', email: 'e', password: 'p', twoFactorSecret: 'JBSWY3DPEHPK3PXP', fetch: fake.fetch as any });
    const guarded = await buildApp(createContext({ ...h.ctx.cfg, ORIGIN_SHARED_SECRET: 'origin-secret-of-at-least-32-characters!' } as any, silent, { db: h.ctx.db, pubsub: new MemoryPubSub(), payments }));
    await guarded.ready();
    try {
      expect((await guarded.inject({ method: 'GET', url: '/v1/games' })).statusCode).toBe(403);
      const body = { payment_id: 1, payment_status: 'finished' };
      const res = await guarded.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: JSON.stringify(body) });
      expect(res.statusCode).toBe(200); // unknown payment: logged and acknowledged, never a 403
      expect((await guarded.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': 'bad' }, payload: JSON.stringify(body) })).statusCode).toBe(401);
    } finally {
      await guarded.close();
    }
  });
});
