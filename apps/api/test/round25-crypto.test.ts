import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { FakeNow } from './fakeNowPayments.js';

/** Round 25 B5/B6 on the crypto rail: invoices in USD or EUR at the locked quote, and a clean 503 when NOWPayments fails. */
const IPN_SECRET = 'ipn-secret-for-tests';
let h: Harness;
let fake: FakeNow;
/** What the next provider calls do: answer normally, fail with a 500, or never answer (the client's deadline fires). */
let mode: 'ok' | 'down' | 'hang' = 'ok';
const warnings: any[] = [];

beforeAll(async () => {
  fake = new FakeNow();
  const fetch = async (url: string, init?: RequestInit) => {
    if (mode === 'down') return new Response(JSON.stringify({ message: 'Internal error' }), { status: 500 });
    if (mode === 'hang') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    }
    return fake.fetch(url, init);
  };
  const payments = new NowPaymentsProvider({ apiKey: 'secret-api-key', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', fetch: fetch as any, timeoutMs: 300 });
  h = await setup({ PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET }, { payments });
  const warn = h.ctx.log.warn.bind(h.ctx.log);
  (h.ctx.log as any).warn = (o: unknown, m?: string) => {
    warnings.push({ o, m });
    return warn(o as any, m);
  };
});
afterAll(async () => h.close());

async function ipn(body: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: JSON.stringify(sortDeep(body)) });
}
const finished = (p: any, fiat: number, usdt: number) => ({
  payment_id: Number(p.payment_id), payment_status: 'finished', pay_address: p.pay_address, price_amount: p.price_amount, price_currency: p.price_currency,
  pay_amount: p.pay_amount, actually_paid: p.pay_amount, actually_paid_at_fiat: fiat, pay_currency: p.pay_currency, order_id: p.order_id,
  purchase_id: p.purchase_id, outcome_amount: usdt, outcome_currency: 'usdttrc20',
});

describe('B5/B6 crypto invoices in USD or EUR', () => {
  it('EUR: the locked checkout price is what NOWPayments is asked for; paying it settles the USD owed; the rate is recorded', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { priceCents: 50_00 });
    await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: 'KEY-1\nKEY-2' });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true, currency: 'EUR' })).body.order;
    expect(order).toMatchObject({ presentment_currency: 'EUR', currency: 'USD' });
    const usdCents = Number(order.charged_cents);
    const eurCents = Number(order.presentment_amount_cents);
    expect(eurCents).toBe(Math.round(usdCents * 0.92));

    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20', priceCurrency: 'EUR' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body).toMatchObject({ price_currency: 'EUR', price_amount: (eurCents / 100).toFixed(2), fx_rate: '0.92000000', price_usd: (usdCents / 100).toFixed(2) });
    const p = fake.payments.get(pay.body.payment_id);
    expect(p.price_amount).toBe(eurCents / 100);

    // NOWPayments reports the deposit in the invoice currency (EUR): it covers the USD owed exactly.
    expect((await ipn(finished({ ...p, price_currency: 'eur' }, eurCents / 100, usdCents / 100))).statusCode).toBe(200);
    const paid = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(['paid', 'delivered']).toContain(paid.status);
    expect(paid.crypto_payments[0]).toMatchObject({ status: 'finished', actually_paid_usd: (usdCents / 100).toFixed(2) });
    expect(Number(paid.charged_cents)).toBe(usdCents); // settlement stays USD
  });

  it('a lapsed quote is refreshed and shown (409 fx_quote_expired) before anything is charged; /fx-quote locks for 15 minutes', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { priceCents: 20_00, deliveryMode: 'manual', stock: 5 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true, currency: 'EUR' })).body.order;
    await h.ctx.db.query(`UPDATE orders SET fx_locked_at = now() - interval '16 minutes' WHERE id = $1`, [order.id]);
    await h.ctx.db.query(`UPDATE fx_rates SET rate = 0.95 WHERE currency = 'EUR'`);
    const calls = fake.payments.size;
    const expired = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20', priceCurrency: 'EUR' });
    expect(expired.status).toBe(409);
    expect(expired.body.error).toMatchObject({ code: 'fx_quote_expired', details: { currency: 'EUR', rate: 0.95, amountCents: Math.round(Number(order.charged_cents) * 0.95), usdCents: Number(order.charged_cents) } });
    expect(fake.payments.size).toBe(calls); // nothing created at NOWPayments
    const ok = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20', priceCurrency: 'EUR' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ price_currency: 'EUR', fx_rate: '0.95000000', price_amount: (Math.round(Number(order.charged_cents) * 0.95) / 100).toFixed(2) });

    const other = (await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true })).body.order;
    const q = await buyer.api.post(`/v1/orders/${other.id}/fx-quote`, { currency: 'EUR' });
    expect(q.body).toMatchObject({ currency: 'EUR', rate: 0.95, fresh: true, usdCents: Number(other.charged_cents) });
    expect(new Date(q.body.lockedUntil).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect((await buyer.api.post(`/v1/orders/${other.id}/fx-quote`, { currency: 'EUR' })).body.fresh).toBe(false);
    await h.ctx.db.query(`UPDATE fx_rates SET rate = 0.92 WHERE currency = 'EUR'`);
  });

  it('an EGP viewer pays in USD; EGP is not an invoice currency', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { priceCents: 10_00, deliveryMode: 'manual', stock: 5 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true, currency: 'EGP' })).body.order;
    expect((await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20', priceCurrency: 'EGP' })).status).toBe(400);
    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' });
    expect(pay.body).toMatchObject({ price_currency: 'USD', price_usd: (Number(order.charged_cents) / 100).toFixed(2), fx_rate: '1.00000000' });
  });
});

describe('B5 provider failure', () => {
  it('coins and pay answer 503 payment_provider_unavailable when NOWPayments errors or hangs; the log has the status, never the key', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { priceCents: 30_00, deliveryMode: 'manual', stock: 5 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true })).body.order;
    // A fresh provider has no cached coin list, so the failure is real.
    (h.ctx.payments as any).coins = null;
    (h.ctx.payments as any).minAmounts.clear();
    for (const m of ['down', 'hang'] as const) {
      mode = m;
      warnings.length = 0;
      const t0 = Date.now();
      const coins = await buyer.api.get(`/v1/orders/${order.id}/crypto/coins`);
      expect(coins.status, m).toBe(503);
      expect(coins.body.error.code).toBe('payment_provider_unavailable');
      expect(Date.now() - t0).toBeLessThan(5_000);
      const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' });
      expect(pay.status, m).toBe(503);
      expect(pay.body.error.code).toBe('payment_provider_unavailable');
      const logged = warnings.filter((w) => w.m === 'payment provider unavailable');
      expect(logged.length).toBeGreaterThan(0);
      expect(logged[0].o).toMatchObject({ provider: 'nowpayments', providerStatus: m === 'down' ? 500 : 0 });
      expect(JSON.stringify(warnings)).not.toContain('secret-api-key');
    }
    mode = 'ok';
    expect((await buyer.api.get(`/v1/orders/${order.id}/crypto/coins`)).status).toBe(200);
  });
});
