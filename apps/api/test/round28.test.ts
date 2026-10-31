import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { depositUsd, processingFeeFor } from '../src/domain/cryptoPayments.js';
import { cancelUnpaidExpired } from '../src/domain/orders.js';
import { FakeNow } from './fakeNowPayments.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

const IPN_SECRET = 'ipn-secret-for-tests';
let h: Harness;
let fake: FakeNow;
let providerDown = false;

beforeAll(async () => {
  fake = new FakeNow();
  const fetch = async (url: string, init?: RequestInit) => {
    if (providerDown) return new Response(JSON.stringify({ message: 'down' }), { status: 500 });
    return fake.fetch(url, init);
  };
  const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', fetch: fetch as any, timeoutMs: 2_000 });
  h = await setup({ PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET, FX_STATIC_RATES: '{"EUR":0.92}' }, { payments });
});
afterAll(async () => h.close());

async function ipn(body: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: JSON.stringify(sortDeep(body)) });
}
/** The sandbox IPN shape: `finished`, actually_paid_at_fiat 0, a fee object in the pay coin. */
const sandbox = (p: any, over: Record<string, unknown> = {}) => ({
  payment_id: Number(p.payment_id), parent_payment_id: null, invoice_id: null, payment_status: 'finished', pay_address: p.pay_address, payin_extra_id: null,
  price_amount: p.price_amount, price_currency: String(p.price_currency).toLowerCase(), pay_amount: p.pay_amount, actually_paid: p.pay_amount, actually_paid_at_fiat: 0,
  pay_currency: p.pay_currency, order_id: p.order_id, order_description: 'Bullizard order', purchase_id: p.purchase_id,
  outcome_amount: Math.round(p.price_amount * 0.995 * 1e6) / 1e6, outcome_currency: 'usdtbsc', payment_extra_ids: null,
  fee: { currency: p.pay_currency, depositFee: 0.0000012, withdrawalFee: 0, serviceFee: 0.0000025 }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
});
const delivery = { acceptTos: true, deliveryMethod: 'f2f', deliveryInfo: { character: 'Buyer1' } };
const ledger = async (kind: string, orderId: string, memo?: string) =>
  Number((await h.ctx.db.query(`SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = $1 AND e.order_id = $2 AND ($3::text IS NULL OR e.memo = $3)`, [kind, orderId, memo ?? null])).rows[0].s);

async function newOrder(priceCents = 20_00, over: Record<string, unknown> = {}) {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold 100k', priceCents });
  const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery, ...over });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { seller, buyer, offer, order: created.body.order };
}
const pay = async (buyer: { api: any }, orderId: string, body: Record<string, unknown> = { coin: 'usdttrc20' }) => {
  const r = await buyer.api.post(`/v1/orders/${orderId}/crypto/pay`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { row: r.body, p: fake.payments.get(r.body.payment_id)! };
};

describe('Round 28 — endless "Payment received", fees, sold-out stock', () => {
  it('1a. finished + actually_paid 0 (sandbox) is valued at the full invoice and funds the order', () => {
    const inv = { price_usd: '20.10', price_amount: '20.10', price_currency: 'USD', fx_rate: '1' };
    expect(depositUsd(inv, { status: 'finished', actuallyPaid: 0, actuallyPaidUsd: 0, payAmount: 0.0004, priceUsd: 20.1 })).toEqual({ ok: true, usd: 20.1 });
    expect(depositUsd(inv, { status: 'finished', actuallyPaid: 0.0002, actuallyPaidUsd: 0, payAmount: 0.0004, priceUsd: 20.1 })).toEqual({ ok: true, usd: 10.05 });
    expect(depositUsd(inv, { status: 'waiting', actuallyPaid: 0, actuallyPaidUsd: 0, payAmount: 0.0004, priceUsd: 20.1 })).toEqual({ ok: true, usd: 0 });
    expect(depositUsd(inv, { status: 'partially_paid', actuallyPaid: 0, actuallyPaidUsd: 0, payAmount: 0.0004, priceUsd: 20.1 })).toEqual({ ok: true, usd: 0 });
  });

  it('1b/2. the invoice is the order plus the processing fee; a sandbox "finished" with actually_paid 0 pays it; the fee covers psp_fee', async () => {
    const { buyer, order } = await newOrder(20_00);
    const charged = Number(order.charged_cents);
    const fee = processingFeeFor(h.ctx, charged);
    expect(fee).toBe(Math.ceil(charged * 0.005));
    const coins = (await buyer.api.get(`/v1/orders/${order.id}/crypto/coins`)).body;
    expect(coins).toMatchObject({ owedCents: charged, processing_fee_cents: fee, fee_bps: 50, total_cents: charged + fee });
    expect(coins.coins[0]).toMatchObject({ fee_cents: fee, total_cents: charged + fee });
    expect(coins.coins.every((c: any) => c.fee_cents === fee)).toBe(true); // no per-coin network estimates
    const { row, p } = await pay(buyer, order.id);
    expect(Number(row.price_usd)).toBeCloseTo((charged + fee) / 100, 2);
    expect(Number((await h.ctx.db.query('SELECT processing_fee_cents FROM orders WHERE id = $1', [order.id])).rows[0].processing_fee_cents)).toBe(fee);
    Object.assign(p, sandbox(p, { actually_paid: 0 }));
    expect((await ipn(sandbox(p, { actually_paid: 0 }))).statusCode).toBe(200);
    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.status).toBe('paid');
    expect(Number(view.processing_fee_cents)).toBe(fee);
    expect(view.crypto_payments[0]).toMatchObject({ state: 'paid', order_status: 'paid' });
    // Books: escrow holds the order, treasury got the fee the buyer paid, psp_fee is what NOWPayments kept; seller untouched.
    expect(await ledger('escrow', order.id, 'payment_captured')).toBe(charged);
    expect(await ledger('treasury', order.id, 'payment_captured')).toBe(fee);
    expect(await ledger('treasury', order.id, 'psp_fee')).toBeLessThan(0);
    expect(await ledger('gateway_clearing', order.id, 'payment_captured')).toBe(-(charged + fee));
    const net = (await h.ctx.db.query('SELECT seller_net_cents, amount_cents FROM orders WHERE id = $1', [order.id])).rows[0];
    expect(Number(net.amount_cents)).toBe(charged); // the fee is on top, never inside the order
    expect(Number(net.seller_net_cents)).toBe(20_00);
  });

  it('1c. finished but a few cents short (beyond the tolerance) becomes underpaid — the buyer is told, never "confirming" forever', async () => {
    const { buyer, order } = await newOrder(20_00);
    const { p } = await pay(buyer, order.id);
    const due = Number(order.charged_cents) + processingFeeFor(h.ctx, Number(order.charged_cents));
    // The sandbox says finished but the coins it reports value 50 cents short.
    const shortCoins = Math.round(p.pay_amount * ((due - 50) / due) * 1e12) / 1e12;
    Object.assign(p, sandbox(p, { actually_paid: shortCoins }));
    await ipn(sandbox(p, { actually_paid: shortCoins }));
    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.status).toBe('awaiting_payment');
    expect(view.crypto_payments[0]).toMatchObject({ status: 'partially_paid', state: 'underpaid', order_status: 'awaiting_payment' });
    const chat = (await h.ctx.db.query(`SELECT m.body FROM chat_messages m JOIN chat_rooms r ON r.id = m.room_id WHERE r.order_id = $1 AND m.kind = 'system' ORDER BY m.seq DESC LIMIT 1`, [order.id])).rows[0];
    expect(chat.body).toMatch(/short/);
    // Ops sees the raw numbers and why.
    const finance = await makeUser(h, { role: 'finance' });
    const ops = (await finance.api.get(`/v1/admin/crypto/payments?q=${p.payment_id}`)).body[0];
    expect(ops).toMatchObject({ state: 'underpaid', due_cents: due, charged_cents: Number(order.charged_cents), processing_fee_cents: due - Number(order.charged_cents) });
    expect(ops.paid_so_far_cents).toBeLessThan(due);
    expect(ops.why_not_applied).toMatch(/^short by 0\.5\d USD: paid/);
    expect(Number(ops.pay_amount)).toBeCloseTo(p.pay_amount, 10);
    expect(Number(ops.actually_paid)).toBeCloseTo(shortCoins, 10);
    // Exact within the tolerance (10 cents on ~$21): paid.
    const { buyer: b2, order: o2 } = await newOrder(20_00);
    const { p: p2 } = await pay(b2, o2.id);
    const due2 = Number(o2.charged_cents) + processingFeeFor(h.ctx, Number(o2.charged_cents));
    const nearCoins = Math.round(p2.pay_amount * ((due2 - 8) / due2) * 1e12) / 1e12;
    Object.assign(p2, sandbox(p2, { actually_paid: nearCoins }));
    await ipn(sandbox(p2, { actually_paid: nearCoins }));
    expect((await b2.api.get(`/v1/orders/${o2.id}`)).body.status).toBe('paid');
  });

  it('1d. a finished deposit left unapplied for over a minute is re-asked and decided on the next read; the reaper never cancels over it', async () => {
    const { buyer, order } = await newOrder(20_00);
    const { p } = await pay(buyer, order.id);
    // The provider has it finished but our row is stale (an IPN that never came): the row says finished, nothing applied.
    Object.assign(p, sandbox(p, { actually_paid: 0 }));
    await h.ctx.db.query(`UPDATE crypto_payments SET status = 'finished', updated_at = now() - interval '2 minutes' WHERE payment_id = $1`, [p.payment_id]);
    expect((await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status).toBe('awaiting_payment');
    const list = (await buyer.api.get(`/v1/orders/${order.id}/crypto/payments`)).body;
    expect(list[0]).toMatchObject({ state: 'paid', order_status: 'paid' });
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('paid');
    // Same for the reaper: an expired order whose deposit the provider calls finished is funded, not cancelled;
    // if the provider cannot be asked the order is left alone (never cancelled over money that may have arrived).
    const { buyer: b2, offer: f2, order: o2 } = await newOrder(20_00);
    const { p: p2 } = await pay(b2, o2.id);
    Object.assign(p2, sandbox(p2, { actually_paid: 0 }));
    await h.ctx.db.query(`UPDATE crypto_payments SET status = 'finished', updated_at = now() - interval '2 minutes' WHERE payment_id = $1`, [p2.payment_id]);
    await h.ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '3 hours' WHERE id = $1`, [o2.id]);
    providerDown = true;
    await cancelUnpaidExpired(h.ctx);
    expect((await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [o2.id])).rows[0].status).toBe('awaiting_payment');
    expect(Number((await h.ctx.db.query('SELECT stock FROM offers WHERE id = $1', [f2.id])).rows[0].stock)).toBe(4); // still reserved
    providerDown = false;
    await cancelUnpaidExpired(h.ctx);
    expect((await h.ctx.db.query('SELECT status FROM orders WHERE id = $1', [o2.id])).rows[0].status).toBe('paid');
  });

  it('1e/2. EUR invoice: the locked price plus the fee at the same rate; the sandbox finished shape pays exactly the USD owed', async () => {
    const { buyer, order } = await newOrder(50_00, { currency: 'EUR' });
    const charged = Number(order.charged_cents);
    const fee = processingFeeFor(h.ctx, charged);
    const { row, p } = await pay(buyer, order.id, { coin: 'usdttrc20', priceCurrency: 'EUR' });
    expect(row.price_currency).toBe('EUR');
    expect(Number(row.price_amount) * 100).toBe(Number(order.presentment_amount_cents) + Math.ceil(fee * 0.92));
    Object.assign(p, sandbox(p, { actually_paid: 0, price_currency: 'eur' }));
    await ipn(sandbox(p, { actually_paid: 0, price_currency: 'eur' }));
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.status).toBe('paid');
    expect(await ledger('escrow', order.id, 'payment_captured')).toBe(charged);
    expect(await ledger('treasury', order.id, 'payment_captured')).toBe(fee);
  });

  it('3. sold out: buying the whole stock delists the listing; stock below the minimum lowers the minimum until restock', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const res = await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 30, minQty: 30, unitPrice: '1', deliveryMethods: ['f2f'], deliveryMinutes: 30, attributes: { server: 'Europe' }, description: 'Bank trade' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const offer = res.body;
    const market = async () => (await client(h.app).get(`/v1/offers?game=Albion%20Online&category=currency&seller=${seller.id}`)).body.items.map((o: any) => o.id);
    const servers = async () => (await client(h.app).get('/v1/games/albion-online/servers?category=currency')).body.find((r: any) => r.name === 'Europe');
    expect(await market()).toContain(offer.id);
    const all = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 30, ...delivery });
    expect(all.status, JSON.stringify(all.body)).toBe(201);
    expect(await market()).not.toContain(offer.id);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body).toMatchObject({ stock: 0, listing_state: 'out_of_stock' });
    expect((await servers()).sellers.some((s: any) => s.id === seller.id)).toBe(false);
    expect((await seller.api.get('/v1/seller/offers')).body.find((o: any) => o.id === offer.id)).toMatchObject({ stock: 0, available: 0, listing_state: 'out_of_stock', open_orders: 1 });
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id, quantity: 30 })).body.error.code).toBe('above_maximum');
    // Buy 25 of 30 with a minimum of 10: 5 left, the minimum shown is 5, the saved minimum is still 10.
    const res2 = await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 30, minQty: 10, unitPrice: '1', deliveryMethods: ['f2f'], deliveryMinutes: 30, attributes: { server: 'Asia' }, description: 'Bank trade' });
    const o2 = res2.body;
    expect((await buyer.api.post('/v1/orders', { offerId: o2.id, quantity: 25, ...delivery })).status).toBe(201);
    const pub = (await client(h.app).get(`/v1/offers/${o2.id}`)).body;
    expect(pub).toMatchObject({ stock: 5, min_qty: 5, listing_state: 'active' });
    expect(pub.seller_min_qty).toBeUndefined(); // the saved minimum is the seller's
    expect((await seller.api.get('/v1/seller/offers')).body.find((o: any) => o.id === o2.id)).toMatchObject({ min_qty: 10, effective_min_qty: 5, stock: 5 });
    expect((await buyer.api.post('/v1/orders/quote', { offerId: o2.id, quantity: 4 })).body.error).toMatchObject({ code: 'below_minimum', details: { minQty: 5 } });
    expect((await buyer.api.post('/v1/orders/quote', { offerId: o2.id, quantity: 5 })).status).toBe(200);
    // The seller can still edit the listing while below the minimum; restocking brings the saved minimum back.
    const v = (await seller.api.get(`/v1/offers/${o2.id}`)).body.version;
    expect((await seller.api.patch(`/v1/offers/${o2.id}`, { version: v, minQty: 10, description: 'Bank trade, fast' })).status).toBe(200);
    expect((await seller.api.patch(`/v1/offers/${o2.id}`, { version: v + 1, stock: 40 })).body).toMatchObject({ stock: 40, min_qty: 10 });
    expect((await buyer.api.post('/v1/orders/quote', { offerId: o2.id, quantity: 5 })).body.error.code).toBe('below_minimum');
  });
});
