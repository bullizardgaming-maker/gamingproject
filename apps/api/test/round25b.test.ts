import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { detectOpsAlerts } from '../src/domain/opsAlerts.js';
import { depositUsd } from '../src/domain/cryptoPayments.js';
import { forgetGameSlugs, gameForSlug } from '../src/domain/search.js';
import { userCredit } from '../src/domain/ledger.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { FakeNow } from './fakeNowPayments.js';

/** Round 25b: fixes from the independent review of cabbfe5 (H1, M1, L1–L3). */
const IPN_SECRET = 'ipn-secret-for-tests';
let h: Harness;
let fake: FakeNow;

beforeAll(async () => {
  fake = new FakeNow();
  const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', fetch: fake.fetch as any });
  h = await setup({ PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET }, { payments });
});
afterAll(async () => h.close());

async function ipn(body: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: JSON.stringify(sortDeep(body)) });
}
const finished = (p: any, over: Record<string, unknown>) => ({
  payment_id: Number(p.payment_id), payment_status: 'finished', pay_address: p.pay_address, price_amount: p.price_amount, price_currency: 'usd',
  pay_amount: p.pay_amount, actually_paid: p.pay_amount, actually_paid_at_fiat: p.price_amount, pay_currency: p.pay_currency, order_id: p.order_id,
  purchase_id: p.purchase_id, outcome_amount: p.price_amount, outcome_currency: 'usdttrc20', ...over,
});
const ledger = async (orderId: string, memo: string) =>
  (await h.ctx.db.query(`SELECT a.kind, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.order_id = $1 AND e.memo = $2 ORDER BY a.kind`, [orderId, memo])).rows;
const gateway = async (orderId: string) =>
  Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0) AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'gateway_clearing' AND e.order_id = $1`, [orderId])).rows[0].s);

async function cart() {
  const s1 = await makeUser(h, { tier: 2 });
  const s2 = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h);
  const a = await makeOffer(s1, { deliveryMode: 'manual', stock: 5, categorySlug: 'items', title: 'Item A', priceCents: 7_00 });
  const b = await makeOffer(s2, { deliveryMode: 'manual', stock: 5, categorySlug: 'items', title: 'Item B', priceCents: 9_00 });
  const res = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: a.id, quantity: 1 }, { offerId: b.id, quantity: 1 }], acceptTos: true });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { buyer, checkoutId: res.body.checkout.id as string, orders: res.body.orders as any[] };
}

describe('H1 a cart stays capturable', () => {
  it('refuses order-level fx-quote and crypto/pay on a cart order (409 use_checkout)', async () => {
    const { buyer, checkoutId, orders } = await cart();
    const q = await buyer.api.post(`/v1/orders/${orders[0].id}/fx-quote`, { currency: 'EUR' });
    expect(q.status).toBe(409);
    expect(q.body.error).toMatchObject({ code: 'use_checkout', details: { checkoutId } });
    expect((await buyer.api.post(`/v1/orders/${orders[0].id}/crypto/pay`, { coin: 'usdttrc20' })).body.error.code).toBe('use_checkout');
    // Through the checkout an EUR quote keeps every order in step.
    const cq = await buyer.api.post(`/v1/checkouts/${checkoutId}/fx-quote`, { currency: 'EUR' });
    expect(cq.status, JSON.stringify(cq.body)).toBe(200);
    const rows = (await h.ctx.db.query('SELECT presentment_currency, presentment_amount_cents FROM orders WHERE checkout_id = $1', [checkoutId])).rows;
    expect(rows.every((r: any) => r.presentment_currency === 'EUR')).toBe(true);
    expect(rows.reduce((s: number, r: any) => s + Number(r.presentment_amount_cents), 0)).toBe(cq.body.amountCents);
  });

  it('the review repro: one cart order re-quoted alone in EUR, the cart paid with a USD invoice → captured, nothing left unapplied', async () => {
    const { buyer, checkoutId, orders } = await cart();
    // The state the old order-level endpoint could create: the first order quoted in EUR, the checkout still in USD.
    await h.ctx.db.query(`UPDATE orders SET presentment_currency = 'EUR', presentment_amount_cents = round(charged_cents * 0.92), fx_rate = 0.92 WHERE id = $1`, [orders[0].id]);
    const pay = await buyer.api.post(`/v1/checkouts/${checkoutId}/crypto/pay`, { coin: 'usdttrc20' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.price_currency).toBe('USD');
    const p = fake.payments.get(pay.body.payment_id);
    expect((await ipn(finished(p, {}))).statusCode).toBe(200);
    const view = (await buyer.api.get(`/v1/checkouts/${checkoutId}`)).body;
    expect(view.checkout.status).toBe('paid');
    expect(view.orders.map((o: any) => o.status)).toEqual(['paid', 'paid']);
    expect(view.orders.map((o: any) => o.presentment_currency)).toEqual(['USD', 'USD']);
    // All of the buyer's money funded the two orders: none of it sits unapplied in their balance.
    expect(await userCredit(h.ctx.db, buyer.id, 'USD')).toBe(0);
    const total = view.orders.reduce((s: number, o: any) => s + Number(o.charged_cents), 0);
    expect(Math.round(Number(p.price_amount) * 100)).toBe(total);
  });
});

describe('M1 an EUR invoice: fee and FX booked apart', () => {
  async function eurOrder() {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'items', priceCents: 40_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true, currency: 'EUR' })).body.order;
    const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20', priceCurrency: 'EUR' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    return { buyer, order, payment: pay.body, p: fake.payments.get(pay.body.payment_id) };
  }

  it('books only the expected NOWPayments fee as psp_fee, the rest of the gap as fx_pnl, and alerts above FX_ALERT_BPS', async () => {
    const { order, p } = await eurOrder();
    const usd = Number(order.charged_cents) / 100;
    const eur = Number(order.presentment_amount_cents) / 100;
    // The EUR the buyer sent is worth the USD owed; 97% of it reached the wallet, NOWPayments says its fee was 0.5%.
    const outcome = Math.round(usd * 0.97 * 100) / 100;
    const fee = Math.round(usd * 0.005 * 100) / 100;
    expect((await ipn(finished(p, { price_currency: 'eur', actually_paid_at_fiat: eur, outcome_amount: outcome, fee: { currency: 'usdttrc20', depositFee: 0, withdrawalFee: 0, serviceFee: fee } }))).statusCode).toBe(200);
    expect((await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status).toBe('paid');
    const feeCents = Math.round(fee * 100);
    const gapCents = Number(order.charged_cents) - Math.round(outcome * 100) - feeCents;
    expect(await ledger(order.id, 'psp_fee')).toEqual([{ kind: 'gateway_clearing', amount_cents: feeCents }, { kind: 'treasury', amount_cents: -feeCents }]);
    expect(await ledger(order.id, 'crypto_fx')).toEqual([{ kind: 'fx_pnl', amount_cents: -gapCents }, { kind: 'gateway_clearing', amount_cents: gapCents }]);
    expect(await gateway(order.id)).toBe(-Math.round(outcome * 100)); // the gateway ends at exactly what is in the wallet
    const row = (await h.ctx.db.query('SELECT fx_gap_cents, fx_gap_bps FROM crypto_payments WHERE order_id = $1', [order.id])).rows[0];
    expect(row).toMatchObject({ fx_gap_cents: gapCents, fx_gap_bps: Math.round((gapCents * 10_000) / Number(order.charged_cents)) });
    expect((await detectOpsAlerts(h.ctx)).map((a) => a.key)).toContain('crypto_fx_gap');
  });

  it('a fiat value in USD on an EUR invoice is recognised; an unreadable one is held for review and credits nothing', async () => {
    // Recognised: NOWPayments sent the fiat value in USD.
    const a = await eurOrder();
    const usd = Number(a.order.charged_cents) / 100;
    expect((await ipn(finished(a.p, { price_currency: 'eur', actually_paid_at_fiat: usd, outcome_amount: usd }))).statusCode).toBe(200);
    expect((await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [a.order.id])).rows[0].status).toBe('paid');

    // Unreadable: the coins say "all of it", the fiat value matches neither EUR nor USD. Nothing captured or credited.
    const b = await eurOrder();
    expect((await ipn(finished(b.p, { price_currency: 'eur', actually_paid_at_fiat: usd / 3 }))).statusCode).toBe(200);
    expect((await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [b.order.id])).rows[0].status).toBe('awaiting_payment');
    const held = (await h.ctx.db.query('SELECT review_reason, actually_paid_usd FROM crypto_payments WHERE order_id = $1', [b.order.id])).rows[0];
    expect(held).toEqual({ review_reason: 'fiat_value_currency_unknown', actually_paid_usd: null });
    expect(await userCredit(h.ctx.db, b.buyer.id, 'USD')).toBe(0);
    expect((await detectOpsAlerts(h.ctx)).map((x) => x.key)).toContain('crypto_review');

    // An IPN priced in another currency than our invoice is held too.
    const c = await eurOrder();
    expect((await ipn(finished(c.p, { price_currency: 'usd' }))).statusCode).toBe(200);
    expect((await h.ctx.db.query('SELECT review_reason FROM crypto_payments WHERE order_id = $1', [c.order.id])).rows[0].review_reason).toBe('ipn_price_currency_usd');

    // The pure rule.
    const inv = { price_usd: '10.00', price_amount: '9.20', price_currency: 'EUR', fx_rate: '0.92' };
    expect(depositUsd(inv, { actuallyPaidUsd: 9.2, actuallyPaid: 1, payAmount: 1, priceUsd: 9.2 })).toEqual({ ok: true, usd: 10 });
    expect(depositUsd(inv, { actuallyPaidUsd: 10, actuallyPaid: 1, payAmount: 1, priceUsd: 9.2 })).toEqual({ ok: true, usd: 10 });
    expect(depositUsd(inv, { actuallyPaidUsd: null, actuallyPaid: 0.5, payAmount: 1, priceUsd: 9.2 })).toEqual({ ok: true, usd: 5 });
    expect(depositUsd(inv, { actuallyPaidUsd: 4, actuallyPaid: 1, payAmount: 1, priceUsd: 9.2 }).ok).toBe(false);
  });

  it('FX_SPREAD_BPS applies to EUR quotes (default 0, the CFO decides)', async () => {
    expect(h.ctx.cfg.FX_SPREAD_BPS).toBe(0);
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'items', priceCents: 10_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true })).body.order;
    (h.ctx.cfg as any).FX_SPREAD_BPS = 100;
    try {
      const q = (await buyer.api.post(`/v1/orders/${order.id}/fx-quote`, { currency: 'EUR' })).body;
      expect(q.rate).toBeCloseTo(0.92 * 1.01, 6);
    } finally {
      (h.ctx.cfg as any).FX_SPREAD_BPS = 0;
    }
  });
});

describe('L1 stock and quantities are bigint', () => {
  it('cancelling an order restocks above 2^31 without overflow', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const silver = (await seller.api.post('/v1/offers', {
      categorySlug: 'currency', game: 'Albion Online', title: 'Silver bulk', deliveryMode: 'manual', stock: 2_000_000_000, unitPrice: '0.000001',
      deliveryMethods: ['f2f'], deliveryTime: '1h', attributes: { server: 'Asia' },
    })).body;
    const order = (await buyer.api.post('/v1/orders', { offerId: silver.id, quantity: 1_500_000_000, acceptTos: true, deliveryMethod: 'f2f', deliveryInfo: { character: 'Big' } })).body.order;
    expect(order, 'order').toBeTruthy();
    const cur = (await seller.api.get(`/v1/offers/${silver.id}`)).body;
    expect((await seller.api.patch(`/v1/offers/${silver.id}`, { version: cur.version, stock: 2_000_000_000 })).status).toBe(200);
    expect((await buyer.api.post(`/v1/orders/${order.id}/cancel`)).status).toBe(200);
    const row = (await h.ctx.db.query('SELECT stock, available FROM offers WHERE id = $1', [silver.id])).rows[0];
    expect(row).toEqual({ stock: 3_500_000_000, available: 3_500_000_000 });
    const types = (await h.ctx.db.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE (table_name, column_name) IN (('offers','stock'),('offers','min_qty'),('offers','available'),('orders','quantity')) ORDER BY 1, 2`)).rows;
    expect(types.every((t: any) => t.data_type === 'bigint')).toBe(true);
  });
});

describe('L2 indexes and the game list cache', () => {
  it('server/league expression indexes replace the jsonb GIN index; the market plans use them', async () => {
    const idx = (await h.ctx.db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'offers'`)).rows.map((r: any) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(['offers_server', 'offers_league']));
    expect(idx).not.toContain('offers_attributes_gin');
    await h.ctx.db.query('SET enable_seqscan = off');
    try {
      const plan = (await h.ctx.db.query(`EXPLAIN SELECT id FROM offers f WHERE f.status = 'active' AND lower(f.game) = 'albion online' AND f.category_slug = 'currency' AND lower(f.attributes->>'server') = lower('Asia')`)).rows.map((r: any) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/offers_server/);
    } finally {
      await h.ctx.db.query('SET enable_seqscan = on');
    }
  });

  it('gameForSlug reads the game list once a minute', async () => {
    forgetGameSlugs();
    let queries = 0;
    const q = { query: async (...args: any[]) => { queries++; return (h.ctx.db as any).query(...args); } } as any;
    expect(await gameForSlug(q, 'albion-online')).toMatch(/^albion online$/i);
    expect(await gameForSlug(q, 'path-of-exile')).toMatch(/^path of exile$/i);
    expect(queries).toBe(1);
  });
});

describe('L3 facets follow the text search', () => {
  it('counts only listings matching q', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const base = { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 10_000_000, unitPrice: '0.0003', deliveryMethods: ['f2f'], deliveryTime: '1h', attributes: { server: 'Americas' } };
    expect((await seller.api.post('/v1/offers', { ...base, title: 'Zephyrine silver' })).status).toBe(201);
    expect((await seller.api.post('/v1/offers', { ...base, title: 'Plain silver' })).status).toBe(201);
    const all = (await client(h.app).get('/v1/offers/facets?game=Albion%20Online&category=currency')).body;
    const some = (await client(h.app).get('/v1/offers/facets?game=Albion%20Online&category=currency&q=Zephyrine')).body;
    const am = (f: any) => f.servers.values.find((v: any) => v.name === 'Americas').count;
    expect(am(all)).toBeGreaterThanOrEqual(2);
    expect(am(some)).toBe(1);
    expect(some.games).toEqual([{ game: 'Albion Online', count: 1 }]);
  });
});
