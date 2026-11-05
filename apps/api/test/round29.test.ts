import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsError, NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { depositUsd, paymentState } from '../src/domain/cryptoPayments.js';
import { grossUp, refreshSellerRate } from '../src/domain/commission.js';
import { dispatchEmails } from '../src/domain/notifications.js';
import { detectOpsAlerts } from '../src/domain/opsAlerts.js';
import { allowedWebOrigins } from '../src/server.js';
import { cleanIdentifier, withdrawalFeeTable } from '../src/domain/withdrawalMethods.js';
import { FakeNow } from './fakeNowPayments.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

const IPN_SECRET = 'ipn-secret-for-tests';
let h: Harness;
let fake: FakeNow;
/** The next /v1/auth (payout login) answer: ok, or the provider's 403 for a server IP that is not whitelisted. */
let authMode: 'ok' | 'ip_not_whitelisted' = 'ok';
let providerDown = false;
const sent: Array<{ to: string; subject?: string; body: string }> = [];

beforeAll(async () => {
  fake = new FakeNow();
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (providerDown) return new Response(JSON.stringify({ message: 'down' }), { status: 500 });
    if (path === '/v1/auth' && authMode === 'ip_not_whitelisted') return new Response(JSON.stringify({ statusCode: 403, code: 'FORBIDDEN', message: 'Your IP is not whitelisted' }), { status: 403 });
    return fake.fetch(url, init);
  };
  const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: IPN_SECRET, apiUrl: 'https://np.test', email: 'e', password: 'p', twoFactorSecret: 'JBSWY3DPEHPK3PXP', fetch: fetch as any, timeoutMs: 2_000 });
  h = await setup({
    PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET, NOWPAYMENTS_FEE_BPS: 0, GEO_COUNTRY_HEADER: 'cf-ipcountry',
    WITHDRAWAL_FEES_JSON: '{"wallet":{"bps":300,"minCents":100},"instapay":{"bps":200,"minCents":100}}',
    NEW_ACCOUNT_MAX_PAID_ORDERS_PER_DAY: '2', NEW_ACCOUNT_MAX_PAID_USD_PER_DAY: '50',
  }, { payments });
  const orig = h.messenger.send.bind(h.messenger);
  h.messenger.send = async (m: any) => {
    sent.push(m);
    return orig(m);
  };
});
afterAll(async () => h.close());

async function ipn(body: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url: '/v1/payments/webhook/nowpayments', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': ipnSignature(IPN_SECRET, body) }, payload: JSON.stringify(sortDeep(body)) });
}
const finished = (p: any, over: Record<string, unknown> = {}) => ({
  payment_id: Number(p.payment_id), payment_status: 'finished', pay_address: p.pay_address, price_amount: p.price_amount, price_currency: String(p.price_currency).toLowerCase(),
  pay_amount: p.pay_amount, actually_paid: p.pay_amount, actually_paid_at_fiat: 0, pay_currency: p.pay_currency, order_id: p.order_id, purchase_id: p.purchase_id,
  outcome_amount: Math.round(p.price_amount * 0.995 * 1e6) / 1e6, outcome_currency: 'usdtbsc', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
});
const delivery = { acceptTos: true, deliveryMethod: 'f2f', deliveryInfo: { character: 'Buyer1' } };
/** Buys one unit and pays it with a finished NOWPayments IPN (the mock card route is off with the crypto provider). */
async function buyCrypto(buyer: { api: any }, offerId: string) {
  const created = await buyer.api.post('/v1/orders', { offerId, quantity: 1, ...delivery });
  if (created.status !== 201) throw new Error(`order failed: ${JSON.stringify(created.body)}`);
  const order = created.body.order;
  const pay = await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' });
  if (pay.status !== 201) throw new Error(`pay failed: ${JSON.stringify(pay.body)}`);
  const p = fake.payments.get(pay.body.payment_id)!;
  Object.assign(p, finished(p));
  await ipn(finished(p));
  return order as { id: string };
}
const reg = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  client(h.app, undefined, headers).post('/v1/auth/register', { email: `r29_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'correct horse battery', displayName: 'Country Tester', acceptTerms: true, ...over });

async function sellerWithBalance(cents = 50_00) {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h, { tier: 1 });
  const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: cents });
  const order = await buyCrypto(buyer, offer.id);
  await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent' });
  await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
  await h.ctx.db.query(`UPDATE users SET payout_address = 'TSellerAddr1234567890xyz', payout_address_currency = 'usdttrc20', payout_country = 'US', payout_hold_days = 0 WHERE id = $1`, [seller.id]);
  return { seller, buyer, order };
}

describe('Round 29 — CEO decisions and test findings', () => {
  it('5. a payout login refused by NOWPayments (IP not whitelisted) is reported as such — the real status and message — and the money goes back', async () => {
    const { seller } = await sellerWithBalance();
    const cfo = await makeUser(h, { tier: 2, role: 'finance' });
    const w = await seller.api.post('/v1/seller/withdrawals', { amountCents: 20_00 });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    authMode = 'ip_not_whitelisted';
    const res = await cfo.api.post(`/v1/admin/withdrawals/${w.body.id}/decide`, { approve: true, note: 'ok' });
    authMode = 'ok';
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('payout_auth_failed');
    expect(res.body.error.message).toMatch(/403.*not whitelisted.*whitelisted for payouts/s);
    expect(res.body.error.details).toMatchObject({ provider_status: 403, provider_message: 'Your IP is not whitelisted', step: 'auth' });
    expect(res.body.error.message).not.toMatch(/\bp\b|jwt-test|JBSWY/); // no secret values, ever (the variable names are the fix)
    const row = (await h.ctx.db.query('SELECT status, failure_reason FROM withdrawals WHERE id = $1', [w.body.id])).rows[0];
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toMatch(/not whitelisted/);
    for (let i = 0; i < 6; i++) await dispatchEmails(h.ctx);
    expect(sent.some((m) => m.to === seller.email && /paused on our side/.test(m.body))).toBe(true);
    // The provider's own classification: a 403 on the payout call carries the whitelist hint; missing credentials are a config step.
    const e = new NowPaymentsError('NOWPayments POST /v1/payout failed (403): Forbidden', 403);
    expect(e.staffMessage).toMatch(/not whitelisted for payouts/);
    const noCreds = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: 's', apiUrl: 'https://np.test', fetch: fake.fetch as any });
    expect(noCreds.payoutsConfigured).toBe(false);
    await expect(noCreds.ensurePayoutAuth()).rejects.toMatchObject({ step: 'config' });
  });

  it('5. staging: Finance + Lead (two people) mark a payout as sent by hand when the sandbox cannot send it', async () => {
    const { seller } = await sellerWithBalance();
    const cfo = await makeUser(h, { tier: 2, role: 'finance' });
    const lead = await makeUser(h, { role: 'lead' });
    const w = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 20_00 })).body;
    fake.payoutMode = 'timeout';
    const dec = await cfo.api.post(`/v1/admin/withdrawals/${w.id}/decide`, { approve: true });
    expect(dec.body.error.code).toBe('payout_unknown');
    expect((await h.ctx.db.query('SELECT status FROM withdrawals WHERE id = $1', [w.id])).rows[0].status).toBe('unknown');
    const first = await cfo.api.post(`/v1/admin/withdrawals/${w.id}/mark-sent`, { hash: '0xmanual1', note: 'sent from the dashboard' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ status: 'unknown', manual_send_requested_by: cfo.id });
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w.id}/mark-sent`, { hash: '0xmanual1', note: 'again' })).body.error.code).toBe('second_person_required');
    const second = await lead.api.post(`/v1/admin/withdrawals/${w.id}/mark-sent`, { hash: '0xmanual1', note: 'checked the wallet' });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ status: 'paid', tx_hash: '0xmanual1' });
    const audits = (await h.ctx.db.query(`SELECT action FROM admin_audit_log WHERE target_id = $1 ORDER BY created_at`, [w.id])).rows.map((r: any) => r.action);
    expect(audits).toEqual(expect.arrayContaining(['withdrawal.manual_send_requested', 'withdrawal.manual_sent']));
  });

  it('9. the seller profile carries the rating and every badge the seller holds', async () => {
    const { seller, buyer, order } = await sellerWithBalance();
    await buyer.api.post(`/v1/orders/${order.id}/review`, { rating: 5, comment: 'Great' });
    await h.ctx.db.query(`UPDATE users SET founding = true, kyc_tier = 2, trust_level = 'top' WHERE id = $1`, [seller.id]);
    const p = (await client(h.app).get(`/v1/sellers/${seller.id}`)).body;
    expect(p).toMatchObject({ rating: { count: 1, average: 5, positive_pct: 100 }, rating_average: 5, review_count: 1 });
    expect(p.badges.map((b: any) => b.key)).toEqual(['rank:hatchling', 'founding', 'id_verified', 'top_seller']);
    expect(p.badges[1]).toEqual({ key: 'founding', label: 'Founding Seller' });
  });

  it('7. the cart is gone: no cart or checkout routes; one listing per purchase', async () => {
    const buyer = await makeUser(h, { tier: 1 });
    expect((await buyer.api.post('/v1/orders/cart', { items: [], acceptTos: true })).status).toBe(404);
    expect((await buyer.api.get('/v1/checkouts/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await buyer.api.get('/v1/checkouts/00000000-0000-4000-8000-000000000000/crypto/coins')).status).toBe(404);
  });

  it('1. regions, not countries: a region preference on the account, no country name on any public read; a sanctioned connection cannot sign up, buy or sell', async () => {
    const r = await reg({ region: 'middle_east' }, { 'cf-ipcountry': 'EG' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.user.region).toBe('middle_east');
    expect(JSON.stringify(r.body.user)).not.toMatch(/"country"/);
    expect((await reg({ region: 'moon' })).status).toBe(400);
    expect((await reg({})).body.user.region).toBe('global');
    const api = client(h.app, r.body.token);
    expect((await api.put('/v1/me/region', { region: 'europe' })).body).toEqual({ region: 'europe' });
    expect((await api.get('/v1/me')).body.user.region).toBe('europe');
    // Sanctioned connection: sign-up, buy and sell are refused with the one line; the country is never named.
    const ir = await reg({}, { 'cf-ipcountry': 'IR' });
    expect(ir.status).toBe(451);
    expect(ir.body.error).toEqual({ code: 'country_not_supported', message: "Bullizard isn't available here", details: { action: 'signup' } });
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 10_00 });
    const us = await makeUser(h, { tier: 2 });
    const token = (await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: us.email, password: 'correct horse battery' }, headers: { 'x-token-delivery': 'body' } })).json().token;
    const fromIran = client(h.app, token, { 'cf-ipcountry': 'KP' });
    expect((await fromIran.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery })).status).toBe(451);
    expect((await fromIran.post('/v1/offers', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 10, unitPrice: '1', deliveryMethods: ['f2f'], deliveryMinutes: 30, attributes: { server: 'Europe' } })).status).toBe(451);
    expect((await client(h.app, token, { 'cf-ipcountry': 'US' }).post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery })).status).toBe(201);
    // The seller profile shows the region, never a country.
    const profile = (await client(h.app).get(`/v1/sellers/${seller.id}`)).body;
    expect(profile.region).toBe('global');
    expect(JSON.stringify(profile)).not.toMatch(/"country"/);
    // Staff see the connection countries (sign-up and latest) on the account.
    const admin = await makeUser(h, { role: 'admin' });
    await client(h.app, token, { 'cf-ipcountry': 'BR' }).get('/v1/me');
    await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: us.email, password: 'correct horse battery' }, headers: { 'x-token-delivery': 'body', 'cf-ipcountry': 'BR' } });
    const view = await admin.api.get(`/v1/admin/users/${us.id}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body).toMatchObject({ region: 'global', last_ip_country: 'BR' });
  });

  it('1. crypto is hidden where the connection is from Egypt (never shown as a country); elsewhere it shows; the withdrawal country lists the methods', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 10_00 });
    const b = await reg({});
    await h.ctx.db.query('UPDATE users SET kyc_tier = 1, email_verified_at = now() WHERE id = $1', [b.body.user.id]);
    const fromEgypt = client(h.app, b.body.token, { 'cf-ipcountry': 'EG' });
    const fromElsewhere = client(h.app, b.body.token, { 'cf-ipcountry': 'DE' });
    expect((await fromEgypt.get('/v1/me')).body.crypto_unavailable_here).toBe(true);
    expect((await fromElsewhere.get('/v1/me')).body.crypto_unavailable_here).toBe(false);
    expect((await fromEgypt.get('/v1/payment-methods?currency=USD')).body.some((m: any) => m.id === 'crypto')).toBe(false);
    expect((await client(h.app, undefined, { 'cf-ipcountry': 'EG' }).get('/v1/payment-methods?currency=USD')).body.some((m: any) => m.id === 'crypto')).toBe(false);
    expect((await fromElsewhere.get('/v1/payment-methods?currency=USD')).body.some((m: any) => m.id === 'crypto')).toBe(true);
    const order = await fromEgypt.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery });
    expect(order.status, JSON.stringify(order.body)).toBe(201); // browsing, ordering and selling stay open
    const coins = await fromEgypt.get(`/v1/orders/${order.body.order.id}/crypto/coins`);
    expect(coins.status).toBe(403);
    expect(coins.body.error).toMatchObject({ code: 'method_unavailable_here', message: "This payment method isn't available here yet — you can still browse and sell" });
    expect((await fromEgypt.post(`/v1/orders/${order.body.order.id}/crypto/pay`, { coin: 'usdttrc20' })).body.error.code).toBe('method_unavailable_here');
    // The same account through another connection (a VPN) pays with crypto — the Terms carry it.
    expect((await fromElsewhere.get(`/v1/orders/${order.body.order.id}/crypto/coins`)).status).toBe(200);
    // Withdrawal form: the country picked lists the methods there; a sanctioned one is refused.
    expect((await seller.api.get('/v1/seller/withdrawal-methods?country=EG')).body.methods.map((m: any) => m.id)).toEqual(['usdt', 'wallet', 'instapay']);
    expect((await seller.api.get('/v1/seller/withdrawal-methods?country=DE')).body.methods.map((m: any) => m.id)).toEqual(['usdt']);
    expect((await seller.api.get('/v1/seller/withdrawal-methods?country=SY')).status).toBe(451);
    expect((await seller.api.post('/v1/seller/payout-address', { country: 'DE', method: 'wallet', identifier: '01012345678' })).body.error.code).toBe('method_unavailable_in_country');
    expect((await seller.api.post('/v1/seller/payout-address', { country: 'CU', method: 'usdt', address: 'TSellerAddr1234567890xyz', currency: 'usdttrc20' })).status).toBe(451);
    // A withdrawal country that turns sanctioned later blocks the withdrawal itself.
    await h.ctx.db.query(`UPDATE users SET payout_address = 'TSellerAddr1234567890xyz', payout_address_currency = 'usdttrc20', payout_country = 'IR' WHERE id = $1`, [seller.id]);
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 100 })).status).toBe(451);
  });

  it('1. the order coming from a different country than the account signed up from is a fraud signal (scored, shown to staff), not a block', async () => {
    const seller = await makeUser(h, { tier: 2, ip: '10.5.5.5' });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 10_00 });
    const b = await reg({}, { 'cf-ipcountry': 'DE' });
    await h.ctx.db.query('UPDATE users SET kyc_tier = 1, email_verified_at = now() WHERE id = $1', [b.body.user.id]);
    const buyer = client(h.app, b.body.token, { 'cf-ipcountry': 'BR' });
    const order = (await buyer.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery })).body.order;
    const pay = (await buyer.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    const p = fake.payments.get(pay.payment_id)!;
    Object.assign(p, finished(p));
    await ipn(finished(p));
    const row = (await h.ctx.db.query('SELECT status, escrow_frozen, risk_score FROM orders WHERE id = $1', [order.id])).rows[0];
    expect(row.status).toBe('paid');
    expect(row.escrow_frozen).toBe(false);
    expect(Number(row.risk_score)).toBeGreaterThanOrEqual(0.15);
    const { heuristicScore } = await import('../src/domain/fraud.js');
    expect((await heuristicScore(h.ctx.db, order.id)).reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ip_country_change', detail: { signup: 'DE', order: 'BR' } })]));
    const staff = await makeUser(h, { role: 'support' });
    expect((await staff.api.get(`/v1/orders/${order.id}`)).body.buyer_ip_country).toBe('BR');
    expect((await client(h.app, b.body.token).get(`/v1/orders/${order.id}`)).body.buyer_ip_country).toBeUndefined();
  });

  it('3. fast crypto boundaries: instant when covered; held only for no amounts at all, a settled amount 3 % short, a foreign invoice or a sanctioned wallet', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 20, categorySlug: 'currency', title: 'Gold', priceCents: 10_00 });
    const start = async () => {
      const buyer = await makeUser(h, { tier: 1 });
      const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery })).body.order;
      const pay = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
      return { buyer, order, p: fake.payments.get(pay.payment_id)! };
    };
    const state = async (orderId: string) => (await h.ctx.db.query('SELECT o.status, p.review_reason FROM orders o JOIN crypto_payments p ON p.order_id = o.id WHERE o.id = $1', [orderId])).rows[0];
    // Instant: finished with the sandbox shape (actually_paid 0, outcome present).
    const a = await start();
    Object.assign(a.p, finished(a.p, { actually_paid: 0 }));
    await ipn(finished(a.p, { actually_paid: 0 }));
    expect(await state(a.order.id)).toMatchObject({ status: 'paid', review_reason: null });
    // (a) neither coins nor outcome reported: held.
    const b = await start();
    await ipn(finished(b.p, { actually_paid: 0, outcome_amount: null }));
    expect(await state(b.order.id)).toMatchObject({ status: 'awaiting_payment', review_reason: 'no_amounts_reported' });
    // (b) finished, coins say full, but the wallet got 10 % less: held.
    const c = await start();
    await ipn(finished(c.p, { outcome_amount: Math.round(c.p.price_amount * 0.9 * 1e6) / 1e6 }));
    const cs = await state(c.order.id);
    expect(cs.status).toBe('awaiting_payment');
    expect(cs.review_reason).toMatch(/^settled_short/);
    // (c) the IPN's invoice is not ours: held.
    const d = await start();
    await ipn(finished(d.p, { price_currency: 'eur' }));
    expect((await state(d.order.id)).review_reason).toBe('ipn_price_currency_eur');
    const d2 = await start();
    await ipn(finished(d2.p, { price_amount: d2.p.price_amount * 2 }));
    expect((await state(d2.order.id)).review_reason).toMatch(/^ipn_price_amount_mismatch/);
    // (d) the paying wallet is on a sanctions list: held, case opened.
    await h.ctx.db.query(`INSERT INTO sanctions_lists (list, version, entries) VALUES ('test', 'v1', 1) ON CONFLICT (list) DO NOTHING`);
    await h.ctx.db.query(`INSERT INTO sanctions_entries (list, ref, kind, name, name_key, program, version) VALUES ('test', 'T-1', 'wallet', 'TBadWallet000000000000000000000000', 'tbadwallet000000000000000000000000', 'TEST', 'v1') ON CONFLICT DO NOTHING`);
    const e = await start();
    await ipn(finished(e.p, { payer_address: 'TBadWallet000000000000000000000000' }));
    expect((await state(e.order.id)).review_reason).toBe('sanctioned_wallet');
    expect((await h.ctx.db.query(`SELECT rule FROM aml_cases WHERE user_id = $1`, [e.buyer.id])).rows.map((r: any) => r.rule)).toContain('sanctions_payment_wallet');
    const held = (await detectOpsAlerts(h.ctx)).find((x) => x.key === 'crypto_review');
    expect(held?.detail).toMatch(/sanctioned_wallet/);
    // Unit: the valuation rules behind (a) and (c).
    const inv = { price_usd: '10.00', price_amount: '10.00', price_currency: 'USD', fx_rate: '1' };
    expect(depositUsd(inv, { status: 'finished', actuallyPaid: 0, actuallyPaidUsd: 0, payAmount: 1, priceUsd: 10, raw: { price_currency: 'usd', price_amount: 10 } })).toEqual({ ok: true, usd: 10 });
    expect(depositUsd(inv, { status: 'finished', actuallyPaid: 1, actuallyPaidUsd: 0, payAmount: 1, priceUsd: 10, raw: { price_currency: 'usd', price_amount: 11 } }).ok).toBe(false);
  });

  it('3. per-account velocity for new accounts (config): paid orders and USD per day', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const cheap = await makeOffer(seller, { deliveryMode: 'manual', stock: 20, categorySlug: 'currency', title: 'Gold', priceCents: 10_00 });
    const dear = await makeOffer(seller, { deliveryMode: 'manual', stock: 20, categorySlug: 'currency', title: 'Gold', priceCents: 60_00 });
    const buyer = await makeUser(h, { tier: 1 });
    await buyCrypto(buyer, cheap.id);
    await buyCrypto(buyer, cheap.id);
    const third = await buyer.api.post('/v1/orders', { offerId: cheap.id, quantity: 1, ...delivery });
    expect(third.status).toBe(429);
    expect(third.body.error).toMatchObject({ code: 'velocity_limit', details: { limit: 'orders', max: 2 } });
    const rich = await makeUser(h, { tier: 1 });
    await buyCrypto(rich, dear.id); // $60 paid in a day > $50
    expect((await rich.api.post('/v1/orders', { offerId: cheap.id, quantity: 1, ...delivery })).body.error).toMatchObject({ code: 'velocity_limit', details: { limit: 'usd', max: 50 } });
    // An account older than a week is not limited.
    await h.ctx.db.query(`UPDATE users SET created_at = now() - interval '8 days' WHERE id = $1`, [buyer.id]);
    expect((await buyer.api.post('/v1/orders', { offerId: cheap.id, quantity: 1, ...delivery })).status).toBe(201);
  });

  it('6. Dragon is 7.99 %: the rank table, gross-up and a Dragon seller’s listing price, referral share on the commission', async () => {
    const ranks = (await client(h.app).get('/v1/ranks')).body.ranks;
    expect(ranks.find((r: any) => r.name === 'Dragon')).toMatchObject({ rateBps: 799, minMonthlySalesCents: 15_000_00 });
    expect(ranks.map((r: any) => r.rateBps)).toEqual([1399, 1299, 1199, 1099, 799]);
    expect(grossUp(100_00, 799)).toBe(108_69); // 100 / (1 − 0.0799) rounded up
    const seller = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`UPDATE users SET seller_since = now() - interval '100 days' WHERE id = $1`, [seller.id]); // promo over
    const buyer = await makeUser(h, { tier: 1 });
    const big = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 16_000_00 });
    const order = await buyCrypto(buyer, big.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent' });
    await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
    const t = await refreshSellerRate(h.ctx.db, seller.id);
    expect(t.rank.name).toBe('Dragon');
    expect(t.rateBps).toBe(799);
    const listing = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 100_00 });
    expect((await client(h.app).get(`/v1/offers/${listing.id}`)).body.price_cents).toBe(108_69);
    expect((await seller.api.get(`/v1/offers/${listing.id}`)).body.seller_rate_bps).toBe(799);
    expect((await seller.api.get('/v1/seller/dashboard')).body.rank).toMatchObject({ name: 'Dragon', rateBps: 799 });
  });

  it('2. withdrawal methods ask for what they need: a wallet phone (encrypted, masked), confirmed by the emailed code, its own fee, sent by Finance by hand', async () => {
    expect(withdrawalFeeTable(h.ctx)).toEqual({ usdt: { bps: 600, minCents: 150 }, wallet: { bps: 300, minCents: 100 }, instapay: { bps: 200, minCents: 100 } });
    expect(cleanIdentifier('wallet', '0101 234 5678')).toEqual({ value: '01012345678', hint: '•••• 5678' });
    expect(cleanIdentifier('instapay', 'Eslam.Jetli@CIB')).toEqual({ value: 'eslam.jetli@cib', hint: 'E•••@cib' });
    expect(() => cleanIdentifier('wallet', 'abc')).toThrow();
    const { seller } = await sellerWithBalance(50_00);
    const methods = (await seller.api.get('/v1/seller/withdrawal-methods?country=EG')).body.methods;
    expect(methods.map((m: any) => m.id)).toEqual(['usdt', 'wallet', 'instapay']);
    expect(methods[1]).toMatchObject({ fields: ['phone'], fee: { bps: 300, minCents: 100 }, sent_by: 'finance' });
    expect((await seller.api.post('/v1/seller/payout-address', { country: 'EG', method: 'wallet' })).body.error.code).toBe('invalid_phone');
    const req = await seller.api.post('/v1/seller/payout-address', { country: 'EG', method: 'wallet', identifier: '+20 101 234 5678' });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    expect(req.body.pending).toMatchObject({ method: 'wallet', identifier_hint: '•••• 5678', address: null });
    for (let i = 0; i < 6; i++) await dispatchEmails(h.ctx); // the queue holds earlier tests' mail too
    const link = sent.filter((m) => m.to === seller.email && m.subject === 'Confirm your new payout address').at(-1)!;
    expect(link, JSON.stringify((await h.ctx.db.query('SELECT template, status, last_error FROM notifications WHERE user_id = $1', [seller.id])).rows)).toBeTruthy();
    expect(link.body).not.toMatch(/2010123/); // the number itself is never emailed
    const token = link.body.match(/confirm-payout-address=([A-Za-z0-9_-]+)/)![1]!;
    const code = sent.filter((m) => m.to === seller.email && /code to confirm/.test(m.subject ?? '')).at(-1)!.body.match(/code is (\d{6})/)![1]!;
    const confirmed = await seller.api.post('/v1/seller/payout-address/confirm', { token, code });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ method: 'wallet', country: 'EG', identifier_hint: '•••• 5678', address: null, pending: null });
    const u = (await h.ctx.db.query('SELECT payout_method, payout_identifier_ciphertext, payout_address FROM users WHERE id = $1', [seller.id])).rows[0];
    expect(u.payout_method).toBe('wallet');
    expect(u.payout_identifier_ciphertext).not.toMatch(/2010123/);
    expect(u.payout_address).toBeNull();
    // The fee of the chosen method; the request carries the method and a masked destination, never the number.
    expect((await seller.api.get('/v1/seller/withdrawals/quote?amountCents=2000')).body).toMatchObject({ method: 'wallet', feeCents: 100, netCents: 1900, feeBps: 300 });
    const w = await seller.api.post('/v1/seller/withdrawals', { amountCents: 20_00 });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body).toMatchObject({ method: 'wallet', country: 'EG', fee_cents: 100, net_cents: 1900, destination_hint: '•••• 5678', destination_address: null });
    expect(JSON.stringify(w.body)).not.toMatch(/2010123/);
    // Finance approves: nothing goes to NOWPayments; Finance reads the number (audited) and marks it paid with the Lead.
    const cfo = await makeUser(h, { tier: 2, role: 'finance' });
    const lead = await makeUser(h, { role: 'lead' });
    const before = fake.payoutPosts.length;
    const dec = await cfo.api.post(`/v1/admin/withdrawals/${w.body.id}/decide`, { approve: true });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    expect(dec.body).toMatchObject({ status: 'processing', manual: true });
    expect(fake.payoutPosts.length).toBe(before);
    expect((await lead.api.get(`/v1/admin/withdrawals/${w.body.id}/destination`)).status).toBe(403);
    expect((await cfo.api.get(`/v1/admin/withdrawals/${w.body.id}/destination`)).body).toEqual({ method: 'wallet', destination: '+201012345678', hint: '•••• 5678', status: 'processing' });
    await cfo.api.post(`/v1/admin/withdrawals/${w.body.id}/mark-sent`, { note: 'Vodafone Cash ref 123' });
    const paid = await lead.api.post(`/v1/admin/withdrawals/${w.body.id}/mark-sent`, { hash: 'VC-123', note: 'confirmed' });
    expect(paid.body).toMatchObject({ status: 'paid', tx_hash: 'VC-123' });
    // InstaPay by IPA, and a seller can go back to USDT.
    const ipa = await seller.api.post('/v1/seller/payout-address', { country: 'EG', method: 'instapay', identifier: 'seller@cib' });
    expect(ipa.body.pending).toMatchObject({ method: 'instapay', identifier_hint: 's•••@cib' });
    expect((await seller.api.post('/v1/seller/payout-address', { country: 'US', method: 'usdt', address: 'TSellerAddr1234567890xyz', currency: 'usdttrc20' })).body.pending).toMatchObject({ method: 'usdt', address: 'TSellerAddr1234567890xyz' });
  });

  it('4/11. Ops alerts: a finished deposit stuck unapplied while the provider is unreachable; sanctions lists missing or stale', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 10_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery })).body.order;
    const pay = (await buyer.api.post(`/v1/orders/${order.id}/crypto/pay`, { coin: 'usdttrc20' })).body;
    await h.ctx.db.query(`UPDATE crypto_payments SET status = 'finished', updated_at = now() - interval '10 minutes' WHERE payment_id = $1`, [pay.payment_id]);
    providerDown = true;
    expect((await buyer.api.get(`/v1/orders/${order.id}/crypto/payments`)).body[0].state).toBe('received_applying');
    const alerts = await detectOpsAlerts(h.ctx);
    providerDown = false;
    const stuck = alerts.find((a) => a.key === 'crypto_stuck_finished');
    expect(stuck?.detail).toMatch(new RegExp(String(pay.payment_id)));
    // Sanctions lists: none → missing; old → stale; fresh → neither. The list endpoint carries the age.
    await h.ctx.db.query('DELETE FROM sanctions_entries; DELETE FROM sanctions_lists');
    expect((await detectOpsAlerts(h.ctx)).some((a) => a.key === 'sanctions_missing')).toBe(true);
    await h.ctx.db.query(`INSERT INTO sanctions_lists (list, version, entries, loaded_at) VALUES ('ofac_sdn', 'v', 10, now() - interval '9 days')`);
    expect((await detectOpsAlerts(h.ctx)).find((a) => a.key === 'sanctions_stale')?.title).toMatch(/9 days old/);
    const compliance = await makeUser(h, { role: 'compliance' });
    const lists = await compliance.api.get('/v1/admin/aml/lists');
    expect(lists.body).toMatchObject({ missing: false, stale: true, source: 'none' });
    expect(lists.body.lists[0]).toMatchObject({ list: 'ofac_sdn', entries: 10 });
    await h.ctx.db.query(`UPDATE sanctions_lists SET loaded_at = now()`);
    expect((await detectOpsAlerts(h.ctx)).some((a) => a.key.startsWith('sanctions_'))).toBe(false);
  });

  it('10. on a refunded order an unapplied deposit is failed or credited, never paid', () => {
    const row = { status: 'finished', applied_at: null, credited_cents: null, review_reason: null, expires_at: null };
    expect(paymentState(row, 'refunded')).toBe('failed');
    expect(paymentState({ ...row, credited_cents: '500' }, 'refunded')).toBe('credited_to_balance');
    expect(paymentState({ ...row, applied_at: new Date().toISOString() }, 'refunded')).toBe('paid');
    expect(paymentState(row, 'paid')).toBe('paid');
  });

  it('12. support.bullizard.com may call the API with cookies', () => {
    expect(allowedWebOrigins({ PUBLIC_WEB_URL: 'https://bullizard.com' })).toEqual(['https://bullizard.com', 'https://support.bullizard.com']);
    expect(allowedWebOrigins({ PUBLIC_WEB_URL: 'https://www.bullizard.com', EXTRA_WEB_ORIGINS: 'https://staging.bullizard.com/, https://ops.bullizard.com' })).toEqual(['https://www.bullizard.com', 'https://support.bullizard.com', 'https://staging.bullizard.com', 'https://ops.bullizard.com']);
    expect(allowedWebOrigins({ PUBLIC_WEB_URL: 'http://localhost:5173' })).toEqual(['http://localhost:5173']);
  });
});
