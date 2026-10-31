import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { paymentState } from '../src/domain/cryptoPayments.js';
import { riskReasonText } from '../src/domain/fraud.js';
import { render, renderCodeEmail, type TemplateName } from '../src/domain/notifications.js';
import { PACKS } from '../src/domain/locales/index.js';
import { TEMPLATE_DATA } from './fixtures/template-data.js';
import { FakeNow } from './fakeNowPayments.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

const IPN_SECRET = 'ipn-secret-for-tests';
let h: Harness;
let fake: FakeNow;
/** Per-call delay for /v1/min-amount, so the coins step can be made slow. */
let minDelayMs = 0;
let minCalls = 0;

beforeAll(async () => {
  fake = new FakeNow();
  const fetch = async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === '/v1/min-amount') {
      minCalls++;
      if (minDelayMs) await new Promise((r) => setTimeout(r, minDelayMs));
    }
    return fake.fetch(url, init);
  };
  const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', fetch: fetch as any, timeoutMs: 8_000, coinsDeadlineMs: 1_000 });
  h = await setup({ PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET }, { payments });
});
afterAll(async () => h.close());

async function ipn(body: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: JSON.stringify(sortDeep(body)) });
}
const sandboxFinished = (p: any, over: Record<string, unknown> = {}) => ({
  payment_id: Number(p.payment_id), parent_payment_id: null, invoice_id: null, payment_status: 'finished', pay_address: p.pay_address, payin_extra_id: null,
  price_amount: p.price_amount, price_currency: String(p.price_currency).toLowerCase(), pay_amount: p.pay_amount, actually_paid: p.pay_amount, actually_paid_at_fiat: 0,
  pay_currency: p.pay_currency, order_id: p.order_id, order_description: 'Bullizard order', purchase_id: p.purchase_id,
  outcome_amount: Math.round(p.price_amount * 0.995 * 1e6) / 1e6, outcome_currency: 'usdtbsc', payment_extra_ids: null,
  fee: { currency: p.pay_currency, depositFee: 0.0000012, withdrawalFee: 0, serviceFee: 0.0000025 }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
});
const delivery = { acceptTos: true, deliveryMethod: 'f2f', deliveryInfo: { character: 'Buyer1' } };

async function payCrypto(buyer: { api: any }, orderId: string) {
  const pay = await buyer.api.post(`/v1/orders/${orderId}/crypto/pay`, { coin: 'usdttrc20' });
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  const p = fake.payments.get(pay.body.payment_id)!;
  Object.assign(p, sandboxFinished(p));
  expect((await ipn(sandboxFinished(p))).statusCode).toBe(200);
  return pay.body.payment_id as string;
}
async function newOrder(buyerOpts: Parameters<typeof makeUser>[1] = { tier: 1 }, sellerOpts: Parameters<typeof makeUser>[1] = { tier: 2 }, priceCents = 20_00) {
  const seller = await makeUser(h, sellerOpts);
  const buyer = await makeUser(h, buyerOpts);
  const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 100k', priceCents });
  const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { seller, buyer, offer, order: created.body.order };
}

describe('Round 27 — CEO staging test fixes', () => {
  it('1. a payment is `paid` as soon as its order is funded, whatever the provider row still says; order_status comes with it', async () => {
    const row = { status: 'confirming', applied_at: null, credited_cents: null, review_reason: null, expires_at: null };
    expect(paymentState(row, 'awaiting_payment')).toBe('confirming');
    expect(paymentState(row, 'paid')).toBe('paid');
    expect(paymentState({ ...row, status: 'waiting' }, 'delivered')).toBe('paid');
    expect(paymentState({ ...row, status: 'finished' }, 'awaiting_payment')).toBe('received_applying');
    expect(paymentState({ ...row, status: 'finished' }, 'paid')).toBe('paid');
    expect(paymentState({ ...row, review_reason: 'syndicate' }, 'paid')).toBe('held_for_review');
    expect(paymentState({ ...row, status: 'waiting' }, 'cancelled')).toBe('waiting');
    // End to end with a sandbox-shaped IPN: the order is paid; even if the row is left behind at "confirming", the web sees paid.
    const { buyer, order } = await newOrder();
    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const p = fake.payments.get(pay.body.payment_id)!;
    Object.assign(p, sandboxFinished(p));
    expect((await ipn(sandboxFinished(p))).statusCode).toBe(200);
    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.status).toBe('paid');
    expect(view.crypto_payments[0]).toMatchObject({ state: 'paid', order_status: 'paid' });
    await h.ctx.db.query(`UPDATE crypto_payments SET status = 'confirming', applied_at = NULL WHERE payment_id = $1`, [pay.body.payment_id]);
    const list = (await buyer.api.get(`/v1/orders/${order.id}/crypto/payments`)).body;
    expect(list[0]).toMatchObject({ status: 'confirming', state: 'paid', order_status: 'paid' });
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.crypto_payments[0].state).toBe('paid');
  });

  it('2. fraud review says why, in plain words; a first purchase on different devices is not frozen, a shared device is', async () => {
    expect(riskReasonText({ code: 'buyer_seller_shared_infra', weight: 0.6, detail: ['device', 'ip_subnet'] })).toBe('Buyer and seller share a device and an IP network (60 %)');
    expect(riskReasonText({ code: 'new_seller', weight: 0.1, detail: { buyersLast72h: 1 } })).toBe("The seller's account is under 7 days old (10 %)");
    expect(riskReasonText({ code: 'new_buyer_high_value', weight: 0.25 })).toBe("The buyer's account is under 24 h old and this order is $200 or more (25 %)");
    // Both accounts new, different devices and networks: not frozen, no flag.
    const clean = await newOrder({ tier: 1, device: 'buyer-laptop', ip: '10.1.1.1' }, { tier: 2, device: 'seller-pc', ip: '10.2.2.2' });
    await payCrypto(clean.buyer, clean.order.id); // risk is scored when the money lands
    const cleanRow = (await h.ctx.db.query('SELECT escrow_frozen, risk_score FROM orders WHERE id = $1', [clean.order.id])).rows[0];
    expect(cleanRow.escrow_frozen).toBe(false);
    expect(Number(cleanRow.risk_score)).toBeLessThan(h.ctx.cfg.FRAUD_REVIEW_THRESHOLD);
    // Same PC for buyer and seller (the CEO's own test accounts): frozen, and the reason is spelled out.
    const same = await newOrder({ tier: 1, device: 'ceo-pc', ip: '10.9.9.9' }, { tier: 2, device: 'ceo-pc', ip: '10.9.9.9' });
    await payCrypto(same.buyer, same.order.id);
    expect((await h.ctx.db.query('SELECT escrow_frozen FROM orders WHERE id = $1', [same.order.id])).rows[0].escrow_frozen).toBe(true);
    const compliance = await makeUser(h, { role: 'compliance' });
    const queue = (await compliance.api.get('/v1/admin/risk-flags')).body;
    const flag = queue.find((f: any) => f.order_id === same.order.id && f.user_id === same.buyer.id);
    expect(flag, JSON.stringify(queue.slice(0, 2))).toBeTruthy();
    expect(flag).toMatchObject({ order_ref: same.order.ref, order_status: 'paid' });
    expect(flag.reasons_text.some((t: string) => t.startsWith('Buyer and seller share a device'))).toBe(true);
    expect(flag.reasons_text.some((t: string) => t.startsWith("The seller's account is under 7 days old"))).toBe(true);
    const staffView = (await compliance.api.get(`/v1/orders/${same.order.id}`)).body;
    expect(staffView.risk_reasons).toEqual(flag.reasons_text);
    expect(staffView.risk_flags).toHaveLength(2);
    // The parties never see the reasons.
    const buyerView = (await same.buyer.api.get(`/v1/orders/${same.order.id}`)).body;
    expect(buyerView.risk_reasons).toBeUndefined();
    expect(buyerView.risk_flags).toBeUndefined();
  });

  it('3. /crypto/coins answers within the deadline from cache; a cold cache fills in the background and is marked partial', async () => {
    const { buyer, order } = await newOrder();
    (h.ctx.payments as any).coins = null;
    (h.ctx.payments as any).minAmounts.clear();
    minDelayMs = 3_000;
    minCalls = 0;
    let t0 = Date.now();
    const cold = await buyer.api.get(`/v1/orders/${order.id}/crypto/coins`);
    expect(cold.status, JSON.stringify(cold.body)).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(cold.body).toMatchObject({ partial: true, coins: [] });
    expect(minCalls).toBe(Object.keys(fake.minUsd).length); // all minimums were asked for at once
    await new Promise((r) => setTimeout(r, 3_200)); // the background fetches land in the cache
    minDelayMs = 3_000;
    t0 = Date.now();
    const warm = await buyer.api.get(`/v1/orders/${order.id}/crypto/coins`);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(warm.body.partial).toBe(false);
    expect(warm.body.coins.map((c: any) => c.coin).sort()).toEqual(Object.keys(fake.minUsd).sort());
    expect(minCalls).toBe(Object.keys(fake.minUsd).length); // served from cache, nothing refetched
    minDelayMs = 0;
  });

  it('4. the seller profile carries rating, positive %, review count and recent reviews after a completed, rated order', async () => {
    const { seller, buyer, order } = await newOrder();
    await payCrypto(buyer, order.id);
    expect((await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'Traded at the bank' })).status).toBe(200);
    expect((await buyer.api.post(`/v1/orders/${order.id}/confirm`)).status).toBe(200);
    const r = await buyer.api.post(`/v1/orders/${order.id}/review`, { rating: 5, comment: 'Fast and friendly' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const profile = (await client(h.app).get(`/v1/sellers/${seller.id}`)).body;
    expect(profile).toMatchObject({ rating: { count: 1, average: 5, positive_pct: 100 }, rating_average: 5, review_count: 1, positive_pct: 100, positive_pct_90d: 100 });
    expect(typeof profile.rating.average).toBe('number');
    expect(profile.reviews).toHaveLength(1);
    expect(profile.reviews[0]).toMatchObject({ rating: 5, comment: 'Fast and friendly' });
    expect(profile.reviews[0].offer_title).toMatch(/Test Game/);
    expect(profile.reviews[0].buyer_name).toMatch(/^.\.$/);
  });

  it('5. every email signs off "Bullizard Team" (AR «فريق Bullizard») and its footer says 18+ only, in every language', () => {
    const locales = ['en', ...Object.keys(PACKS)] as const;
    for (const locale of locales) {
      const names = Object.keys(PACKS[locale === 'en' ? 'es' : (locale as keyof typeof PACKS)].templates) as TemplateName[];
      const signoff = locale === 'ar' ? 'فريق Bullizard' : 'Bullizard Team';
      for (const name of names) {
        const r = render(h.ctx, name, TEMPLATE_DATA, locale as any);
        expect(r.text, `${locale}:${name}`).toContain(`\n\n${signoff}\n\n`);
        expect(r.text, `${locale}:${name}`).toContain('18+ only');
        expect(r.html, `${locale}:${name}`).toContain(signoff);
        expect(r.html, `${locale}:${name}`).toContain('18+ only');
        expect(r.text).not.toMatch(/The Bullizard team|Bullizard-Team|equipo de Bullizard|équipe Bullizard|Equipe Bullizard/);
      }
      const code = renderCodeEmail(h.ctx, '123456', 10, locale as any);
      expect(code.text).toContain(signoff);
      expect(code.text).toContain('18+ only');
    }
  });
});
