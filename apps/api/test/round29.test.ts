import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsError, NowPaymentsProvider, ipnSignature, sortDeep } from '../src/providers/payments/nowpayments.js';
import { depositUsd, paymentState } from '../src/domain/cryptoPayments.js';
import { grossUp, refreshSellerRate } from '../src/domain/commission.js';
import { dispatchEmails } from '../src/domain/notifications.js';
import { detectOpsAlerts } from '../src/domain/opsAlerts.js';
import { allowedWebOrigins, legacyCookieDomain, refreshCookieDomain } from '../src/server.js';
import { cleanIdentifier, withdrawalFeeTable } from '../src/domain/withdrawalMethods.js';
import { FakeNow } from './fakeNowPayments.js';
import { client, makeOffer, makeUser, setup, type Harness, defaultHeaders } from './helpers.js';

const ORIGIN_SECRET = 'origin-secret-of-at-least-32-characters!';
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
    PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: IPN_SECRET, NOWPAYMENTS_FEE_BPS: 50,
    // Round 29d (H2): the country header is believed only behind the Cloudflare origin secret; every harness request carries it.
    GEO_COUNTRY_HEADER: 'cf-ipcountry', ORIGIN_SHARED_SECRET: ORIGIN_SECRET,
    // CFO defaults (5 Nov): 3.99 % + $1 (min $5 / $10), wallet 6 % + EGP 10, InstaPay 6 % + EGP 5; EGP at 48.5 (static test rate) less the 1 % margin.
    WITHDRAWAL_FEES_JSON: '', CRYPTO_UNDERPAY_TOLERANCE_BPS: '0', OVERPAY_TO_BALANCE_ABOVE_CENTS: '300', PAYOUT_HOLD_DAYS_BY_RANK: '{"hatchling":3,"scale":2,"fang":1,"basilisk":1,"dragon":0}', FX_SPREAD_BPS: '100',
    NEW_ACCOUNT_MAX_PAID_ORDERS_PER_DAY: '2', NEW_ACCOUNT_MAX_PAID_USD_PER_DAY: '50', FX_STATIC_RATES: '{"EUR":0.92,"EGP":48.5}',
  }, { payments });
  defaultHeaders['x-origin-auth'] = ORIGIN_SECRET;
  defaultHeaders['cf-ipcountry'] = 'US'; // Cloudflare always names a country; a missing one counts as unknown (XX)
  const orig = h.messenger.send.bind(h.messenger);
  h.messenger.send = async (m: any) => {
    sent.push(m);
    return orig(m);
  };
});
afterAll(async () => {
  delete defaultHeaders['x-origin-auth'];
  delete defaultHeaders['cf-ipcountry'];
  await h.close();
});

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

/** A buyer past the first-week velocity limits. */
async function agedBuyer() {
  const buyer = await makeUser(h, { tier: 1 });
  await h.ctx.db.query(`UPDATE users SET created_at = now() - interval '8 days' WHERE id = $1`, [buyer.id]);
  return buyer;
}
async function sellerWithBalance(cents = 50_00) {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await agedBuyer();
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
    expect(res.body.error.code).toBe('payout_provider_error');
    expect(res.body.error.details.provider_error).toMatchObject({ status: 403, step: 'auth' });
    expect(res.body.error.details.reversed).toBe(true);
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
    // Round 29d (L4): the withdrawals kill switch stops a manual send too
    const w2 = (await seller.api.post('/v1/seller/withdrawals', { amountCents: 10_00 })).body;
    fake.payoutMode = 'timeout'; // the fake resets to ok after each payout call
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w2.id}/decide`, { approve: true })).body.error.code).toBe('payout_unknown');
    const admin = await makeUser(h, { role: 'admin' });
    const { forgetControlsCache } = await import('../src/domain/controls.js');
    await admin.api.put('/v1/admin/controls', { pause_withdrawals: true, pause_message: 'Payouts paused for a check.' });
    forgetControlsCache();
    try {
      expect((await cfo.api.post(`/v1/admin/withdrawals/${w2.id}/mark-sent`, { hash: '0xmanual2', note: 'sent' })).body.error.code).toBe('withdrawals_paused');
    } finally {
      await admin.api.put('/v1/admin/controls', { pause_withdrawals: false, pause_message: null });
      forgetControlsCache();
    }
    expect((await cfo.api.post(`/v1/admin/withdrawals/${w2.id}/mark-sent`, { hash: '0xmanual2', note: 'sent' })).status).toBe(200);
    fake.payoutMode = 'ok';
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

  it('H2 (29d). the country header counts only behind the Cloudflare origin check: EG → no crypto, IR → 451, a spoofed header without origin auth is ignored; GEO_COUNTRY_HEADER needs ORIGIN_SHARED_SECRET', async () => {
    const buyer = await makeUser(h, { tier: 1 });
    // through Cloudflare (x-origin-auth from defaultHeaders)
    const egypt = (await buyer.api.get('/v1/payment-methods', { 'cf-ipcountry': 'EG' })).body;
    expect(egypt.some((m: any) => m.id === 'crypto')).toBe(false);
    expect((await buyer.api.get('/v1/payment-methods', { 'cf-ipcountry': 'US' })).body.some((m: any) => m.id === 'crypto')).toBe(true);
    expect((await client(h.app, undefined, { 'cf-ipcountry': 'IR' }).post('/v1/auth/register', { email: `ir_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Nope', acceptTerms: true })).status).toBe(451);
    // the same headers straight at the origin (no x-origin-auth): refused outright, so the header can never be spoofed
    const direct = await h.app.inject({ method: 'GET', url: '/v1/payment-methods', headers: { authorization: `Bearer ${buyer.token}`, 'cf-ipcountry': 'EG' } });
    expect(direct.statusCode).toBe(403);
    expect(direct.json().error.code).toBe('origin_forbidden');
    // a webhook path is exempt from the origin check: its country header is NOT believed (ipCountry undefined), so nothing is hidden or blocked there
    const { requestMeta, originVerified } = await import('../src/server.js');
    const fakeReq: any = { headers: { 'cf-ipcountry': 'IR' }, ip: '1.2.3.4' };
    expect(originVerified(fakeReq)).toBe(false);
    expect(requestMeta(fakeReq).ipCountry).toBeUndefined();
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ ...process.env, GEO_COUNTRY_HEADER: 'cf-ipcountry', ORIGIN_SHARED_SECRET: '' } as any)).toThrow(/GEO_COUNTRY_HEADER needs ORIGIN_SHARED_SECRET/);
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
    const token = (await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: us.email, password: 'correct horse battery' }, headers: { 'x-origin-auth': ORIGIN_SECRET, 'x-token-delivery': 'body' } })).json().token;
    const fromIran = client(h.app, token, { 'cf-ipcountry': 'KP' });
    expect((await fromIran.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery })).status).toBe(451);
    expect((await fromIran.post('/v1/offers', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 10, unitPrice: '1', deliveryMethods: ['f2f'], deliveryMinutes: 30, attributes: { server: 'Europe' } })).status).toBe(451);
    expect((await client(h.app, token, { 'cf-ipcountry': 'US' }).post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery })).status).toBe(201);
    // Round 29d (L3): editing / resuming a listing and withdrawing are refused from a sanctioned connection too
    const mine = await client(h.app, token, { 'cf-ipcountry': 'US' }).post('/v1/offers', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 10, unitPrice: '1', deliveryMethods: ['f2f'], deliveryMinutes: 30, attributes: { server: 'Europe' } });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect((await fromIran.patch(`/v1/offers/${mine.body.id}`, { version: mine.body.version, stock: 11 })).status).toBe(451);
    await client(h.app, token, { 'cf-ipcountry': 'US' }).post(`/v1/offers/${mine.body.id}/pause`);
    expect((await fromIran.post(`/v1/offers/${mine.body.id}/resume`)).status).toBe(451);
    expect((await client(h.app, token, { 'cf-ipcountry': 'US' }).post(`/v1/offers/${mine.body.id}/resume`)).status).toBe(200);
    expect((await fromIran.post('/v1/seller/withdrawals', { amountCents: 10_00 })).body.error).toMatchObject({ code: 'country_not_supported', details: { action: 'withdraw' } });
    expect((await fromIran.post('/v1/me/withdrawals', { amountCents: 10_00 })).body.error).toMatchObject({ code: 'country_not_supported', details: { action: 'withdraw' } });
    // The seller profile shows the region, never a country.
    const profile = (await client(h.app).get(`/v1/sellers/${seller.id}`)).body;
    expect(profile.region).toBe('global');
    expect(JSON.stringify(profile)).not.toMatch(/"country"/);
    // Staff see the connection countries (sign-up and latest) on the account.
    const admin = await makeUser(h, { role: 'admin' });
    await client(h.app, token, { 'cf-ipcountry': 'BR' }).get('/v1/me');
    await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: us.email, password: 'correct horse battery' }, headers: { 'x-origin-auth': ORIGIN_SECRET, 'x-token-delivery': 'body', 'cf-ipcountry': 'BR' } });
    const view = await admin.api.get(`/v1/admin/users/${us.id}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body).toMatchObject({ region: 'global', last_ip_country: 'BR' });
    // Round 29d (M3): the read goes through requirePermission — a suspended staff account loses it, a buyer never had it
    expect((await client(h.app, token).get(`/v1/admin/users/${us.id}`)).body.error.code).toBe('insufficient_permission');
    const support = await makeUser(h, { role: 'support' });
    expect((await support.api.get(`/v1/admin/users/${us.id}`)).status).toBe(200);
    await h.ctx.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [support.id]);
    expect((await support.api.get(`/v1/admin/users/${us.id}`)).body.error.code).toBe('account_restricted');
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
    const mid = await makeOffer(seller, { deliveryMode: 'manual', stock: 20, categorySlug: 'currency', title: 'Gold', priceCents: 38_00 });
    const huge = await makeOffer(seller, { deliveryMode: 'manual', stock: 20, categorySlug: 'currency', title: 'Gold', priceCents: 120_00 });
    const buyer = await makeUser(h, { tier: 1 });
    await buyCrypto(buyer, cheap.id);
    await buyCrypto(buyer, cheap.id);
    const third = await buyer.api.post('/v1/orders', { offerId: cheap.id, quantity: 1, ...delivery });
    expect(third.status).toBe(429);
    expect(third.body.error).toMatchObject({ code: 'velocity_limit', details: { limit: 'orders', max: 2 } });
    const rich = await makeUser(h, { tier: 1 });
    // Round 29d (L2): this order counts too — $60 alone is over the $50 day, and an unpaid order counts like a paid one
    expect((await rich.api.post('/v1/orders', { offerId: dear.id, quantity: 1, ...delivery })).body.error).toMatchObject({ code: 'velocity_limit', details: { limit: 'usd', max: 50 } });
    const unpaid = await rich.api.post('/v1/orders', { offerId: mid.id, quantity: 1, ...delivery }); // $40, left unpaid
    expect(unpaid.status).toBe(201);
    expect((await rich.api.post('/v1/orders', { offerId: mid.id, quantity: 1, ...delivery })).body.error).toMatchObject({ code: 'velocity_limit', details: { limit: 'usd', max: 50 } }); // 40 + 40 > 50
    const cancelled = await rich.api.post(`/v1/orders/${unpaid.body.order.id}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const after = await rich.api.post('/v1/orders', { offerId: mid.id, quantity: 1, ...delivery });
    expect(after.status, JSON.stringify(after.body)).toBe(201); // a cancelled order no longer counts
    // CFO: $100 per order and 3 open orders in the first week are the Ops controls (new_account_max_order_cents / new_account_max_open_orders).
    const fresh = await makeUser(h, { tier: 1 });
    await h.ctx.db.query('UPDATE platform_controls SET new_account_days = 7'); // the test harness turns the first-week controls off; on here
    const { forgetControlsCache } = await import('../src/domain/controls.js');
    forgetControlsCache();
    const savedVelocity = h.ctx.cfg.NEW_ACCOUNT_MAX_PAID_ORDERS_PER_DAY;
    (h.ctx.cfg as any).NEW_ACCOUNT_MAX_PAID_ORDERS_PER_DAY = 10; // the orders/day velocity (2 in this suite) would fire first
    try {
      expect((await fresh.api.post('/v1/orders', { offerId: huge.id, quantity: 1, ...delivery })).body.error).toMatchObject({ code: 'new_account_limit', details: { maxCents: 10_000 } });
      for (let i = 0; i < 3; i++) expect((await fresh.api.post('/v1/orders', { offerId: cheap.id, quantity: 1, ...delivery })).status).toBe(201);
      expect((await fresh.api.post('/v1/orders', { offerId: cheap.id, quantity: 1, ...delivery })).body.error).toMatchObject({ code: 'new_account_limit', details: { maxOpen: 3 } });
    } finally {
      (h.ctx.cfg as any).NEW_ACCOUNT_MAX_PAID_ORDERS_PER_DAY = savedVelocity;
      await h.ctx.db.query('UPDATE platform_controls SET new_account_days = 0');
      forgetControlsCache();
    }
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
    const buyer = await agedBuyer();
    const big = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 16_000_00 });
    const order = await buyCrypto(buyer, big.id);
    const delivered = await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'sent' });
    if (delivered.status !== 200) throw new Error(`deliver: ${JSON.stringify(delivered.body)} ${JSON.stringify((await h.ctx.db.query('SELECT status, escrow_frozen, risk_score FROM orders WHERE id = $1', [order.id])).rows[0])}`);
    // Orders above $200 are released by the Support Lead (permanent rule).
    const lead = await makeUser(h, { role: 'lead' });
    await h.ctx.db.query(`UPDATE orders SET delivered_at = now() - interval '2 days' WHERE id = $1`, [order.id]); // past the 24 h staff-release wait
    const released = await lead.api.post(`/v1/admin/orders/${order.id}/release`, { note: 'Delivery verified' });
    if (released.status !== 200) throw new Error(`release failed: ${JSON.stringify(released.body)} order=${JSON.stringify((await h.ctx.db.query('SELECT status, rail, escrow_frozen, delivered_at FROM orders WHERE id = $1', [order.id])).rows[0])}`);
    const t = await refreshSellerRate(h.ctx.db, seller.id);
    expect(t.rank.name).toBe('Dragon');
    expect(t.rateBps).toBe(799);
    const listing = await makeOffer(seller, { deliveryMode: 'manual', stock: 5, categorySlug: 'currency', title: 'Gold', priceCents: 100_00 });
    expect((await client(h.app).get(`/v1/offers/${listing.id}`)).body.price_cents).toBe(108_69);
    expect((await seller.api.get(`/v1/offers/${listing.id}`)).body.seller_rate_bps).toBe(799);
    expect((await seller.api.get('/v1/seller/dashboard')).body.rank).toMatchObject({ name: 'Dragon', rateBps: 799 });
  });

  it('2. withdrawal methods ask for what they need: a wallet phone (encrypted, masked), confirmed by the emailed code, its own fee, sent by Finance by hand', async () => {
    // CFO table (5 Nov): USDT 3.99 % + $1 (BEP-20 min $5, TRC-20 min $10, max $5,000); wallet 6 % + EGP 10; InstaPay 6 % + EGP 5.
    expect(withdrawalFeeTable(h.ctx)).toEqual({
      usdt_bep20: { pctBps: 399, fixedCents: 100, minCents: 500, maxCents: 500_000, currency: 'USD' },
      usdt_trc20: { pctBps: 399, fixedCents: 100, minCents: 1_000, maxCents: 500_000, currency: 'USD' },
      wallet: { pctBps: 600, fixedCents: 1_000, minCents: 10_000, maxCents: 3_000_000, currency: 'EGP' },
      instapay: { pctBps: 600, fixedCents: 500, minCents: 10_000, maxCents: 5_000_000, currency: 'EGP' },
    });
    expect(cleanIdentifier('wallet', '0101 234 5678')).toEqual({ value: '01012345678', hint: '•••• 5678' });
    expect(cleanIdentifier('instapay', 'Eslam.Jetli@CIB')).toEqual({ value: 'eslam.jetli@cib', hint: 'E•••@cib' });
    expect(() => cleanIdentifier('wallet', 'abc')).toThrow();
    const { seller } = await sellerWithBalance(50_00);
    const methods = (await seller.api.get('/v1/seller/withdrawal-methods?country=EG')).body.methods;
    expect(methods.map((m: any) => m.id)).toEqual(['usdt', 'wallet', 'instapay']);
    expect(methods[1]).toMatchObject({ fields: ['phone'], fee: { pct_bps: 600, fixed_cents: 1_000, min_cents: 10_000, currency: 'EGP' }, sent_by: 'finance' });
    expect(methods[0].networks.map((n: any) => [n.coin, n.fee.min_cents])).toEqual([['usdtbsc', 500], ['usdttrc20', 1_000]]);
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
    // CFO: 6 % + EGP 10, min EGP 100, paid in EGP at 48.5 less the 1 % margin (48.015 EGP per USD).
    const rate = 48.5 * 0.99;
    const fixedUsd = Math.ceil(1_000 / rate); // EGP 10 in USD cents
    const quote = (await seller.api.get('/v1/seller/withdrawals/quote?amountCents=2000')).body;
    expect(quote).toMatchObject({ method: 'wallet', feeCents: 120 + fixedUsd, netCents: 2000 - 120 - fixedUsd, feeBps: 600, feeFixedCents: 1_000, payoutCurrency: 'EGP', feeMinCents: Math.ceil(10_000 / rate) });
    expect(quote.payoutAmountCents).toBe(Math.floor((2000 - 120 - fixedUsd) * rate));
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 150 })).body.error).toMatchObject({ code: 'below_minimum', details: { currency: 'EGP', minMethodCents: 10_000 } });
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 2000, method: 'usdt' })).body.error.code).toBe('method_not_confirmed');
    const w = await seller.api.post('/v1/seller/withdrawals', { amountCents: 20_00, method: 'wallet', details: { phone: '•••• 5678' } });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body).toMatchObject({ method: 'wallet', country: 'EG', fee_cents: 120 + fixedUsd, net_cents: 2000 - 120 - fixedUsd, payout_currency: 'EGP', details: { phone: '•••• 5678' } });
    expect(Number(w.body.payout_amount_cents)).toBe(quote.payoutAmountCents);
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

  it('29b. add funds: crypto only for now (hidden where the connection is Egypt), 0 % + the processing fee on top, credited to the wallet on the IPN, the fee never refunded', async () => {
    const buyer = await agedBuyer();
    const here = (await buyer.api.get('/v1/me/wallet/deposit-methods')).body.methods;
    expect(here.map((m: any) => [m.id, m.enabled])).toEqual([['crypto', true], ['card_egypt', false], ['wallet', false], ['instapay', false]]);
    expect(here[0]).toMatchObject({ fee: { pct_bps: 0, fixed_cents: 0 }, min_cents: 500, max_cents: 200_000, currency: 'USD' });
    const egypt = (await client(h.app, buyer.token, { 'cf-ipcountry': 'EG' }).get('/v1/me/wallet/deposit-methods')).body.methods;
    expect(egypt.find((m: any) => m.id === 'crypto')).toBeUndefined();
    expect((await buyer.api.get('/v1/me/wallet/deposit-quote?method=crypto&amountCents=100')).body.error.code).toBe('below_minimum');
    expect((await buyer.api.post('/v1/me/wallet/deposits', { method: 'wallet', amountCents: 1_000 })).body.error.code).toBe('method_coming_soon');
    const dep = (await buyer.api.post('/v1/me/wallet/deposits', { method: 'crypto', amountCents: 20_00 })).body;
    expect(dep).toMatchObject({ status: 'awaiting_payment', amount_cents: 20_00, fee_cents: 0, total_cents: 20_00, currency: 'USD' });
    const pay = await buyer.api.post(`/v1/me/wallet/deposits/${dep.id}/crypto/pay`, { coin: 'usdttrc20' });
    expect(pay.status).toBe(201);
    expect(Number(pay.body.price_usd)).toBeCloseTo(20.1, 2); // + 0.5 % processing fee
    const p = fake.payments.get(pay.body.payment_id)!;
    Object.assign(p, finished(p));
    await ipn(finished(p));
    const after = (await buyer.api.get(`/v1/me/wallet/deposits/${dep.id}`)).body;
    expect(after.status).toBe('credited');
    const w = (await buyer.api.get('/v1/me/wallet')).body;
    expect(w.breakdown.USD.credit_cents).toBe(20_00);
    const mail = await h.ctx.db.query(`SELECT template, data FROM notifications WHERE user_id = $1 AND template = 'wallet_deposit_credited'`, [buyer.id]);
    expect(mail.rows[0].data).toMatchObject({ amount_cents: 20_00, processing_fee_cents: 10 });
    // the Egyptian connection cannot start the crypto payment either
    const dep2 = (await buyer.api.post('/v1/me/wallet/deposits', { method: 'crypto', amountCents: 10_00 })).body;
    expect((await client(h.app, buyer.token, { 'cf-ipcountry': 'EG' }).post(`/v1/me/wallet/deposits/${dep2.id}/crypto/pay`, { coin: 'usdttrc20' })).body.error.code).toBe('method_unavailable_here');
  });

  it('M1 (29d). a top-up that arrives short is told with a wallet link; after the window the reaper expires it and credits what arrived to the wallet', async () => {
    const buyer = await agedBuyer();
    const dep = (await buyer.api.post('/v1/me/wallet/deposits', { method: 'crypto', amountCents: 20_00 })).body;
    const pay = await buyer.api.post(`/v1/me/wallet/deposits/${dep.id}/crypto/pay`, { coin: 'usdttrc20' });
    const p = fake.payments.get(pay.body.payment_id)!;
    // 20.10 due; 15.00 reaches the wallet
    const short = finished(p, { actually_paid: Math.round(p.pay_amount * (15 / 20.1) * 1e12) / 1e12, outcome_amount: 15, actually_paid_at_fiat: 15 });
    Object.assign(p, short);
    await ipn(short);
    expect((await buyer.api.get(`/v1/me/wallet/deposits/${dep.id}`)).body.status).toBe('awaiting_payment');
    const underpaid = await h.ctx.db.query(`SELECT data FROM notifications WHERE user_id = $1 AND template = 'crypto_underpaid'`, [buyer.id]);
    expect(underpaid.rows[0].data).toMatchObject({ kind: 'deposit', order_id: `deposit:${dep.id}` });
    for (let i = 0; i < 6; i++) await dispatchEmails(h.ctx);
    const mail = sent.filter((m) => m.to === buyer.email && /short/.test(m.subject ?? '')).at(-1)!;
    expect(mail.body).toContain(`/account/wallet?deposit=${dep.id}`);
    expect(mail.body).not.toContain('/orders/');
    // still inside the window: nothing happens
    const { expireUnpaidDeposits } = await import('../src/domain/walletDeposits.js');
    expect(await expireUnpaidDeposits(h.ctx)).toBe(0);
    await h.ctx.db.query(`UPDATE wallet_deposits SET created_at = now() - interval '3 hours' WHERE id = $1`, [dep.id]);
    const before = (await buyer.api.get('/v1/me/wallet')).body.breakdown.USD.credit_cents;
    expect(await expireUnpaidDeposits(h.ctx)).toBe(1);
    expect((await buyer.api.get(`/v1/me/wallet/deposits/${dep.id}`)).body.status).toBe('expired');
    expect((await buyer.api.get('/v1/me/wallet')).body.breakdown.USD.credit_cents).toBe(before + 15_00);
    const kept = await h.ctx.db.query(`SELECT data FROM notifications WHERE user_id = $1 AND template = 'crypto_kept_in_balance'`, [buyer.id]);
    expect(kept.rows[0].data).toMatchObject({ kind: 'deposit', amount_cents: 15_00 });
    // a new top-up can start; the expired one is not touched again
    expect((await buyer.api.post('/v1/me/wallet/deposits', { method: 'crypto', amountCents: 10_00 })).status).toBe(201);
    expect(await expireUnpaidDeposits(h.ctx)).toBe(0);
  });

  it('29b. top-up → withdraw without spending: allowed once, held for staff with the reason in words when repeated (3 in 30 days, under 20 % spent)', async () => {
    const buyer = await agedBuyer();
    await h.ctx.db.query(`UPDATE users SET payout_address = 'TBuyerAddr1234567890xyz', payout_address_currency = 'usdttrc20', payout_country = 'US', payout_hold_days = 0 WHERE id = $1`, [buyer.id]);
    const topUp = async (cents: number) => {
      const dep = (await buyer.api.post('/v1/me/wallet/deposits', { method: 'crypto', amountCents: cents })).body;
      const pay = await buyer.api.post(`/v1/me/wallet/deposits/${dep.id}/crypto/pay`, { coin: 'usdttrc20' });
      const p = fake.payments.get(pay.body.payment_id)!;
      Object.assign(p, finished(p));
      await ipn(finished(p));
    };
    await topUp(20_00);
    const first = await buyer.api.post('/v1/me/withdrawals', { amountCents: 15_00, method: 'usdt', details: { network: 'usdttrc20', address: 'TBuyerAddr1234567890xyz' } });
    expect(first.status).toBe(201);
    expect(first.body.reason_code).toBe('awaiting_approval');
    // Round 29d (M2): the owner's view is a projection — no staff ids, notes, review texts or provider wording
    for (const k of ['review_reason', 'review_reasons_text', 'decided_by', 'decision_note', 'failure_reason', 'provider_error', 'manual_send_requested_by', 'manual_send_note', 'destination_ciphertext', 'first_approved_by']) expect(first.body, k).not.toHaveProperty(k);
    await topUp(20_00);
    await topUp(20_00);
    const third = await buyer.api.post('/v1/me/withdrawals', { amountCents: 15_00 });
    expect(third.status).toBe(201);
    expect(third.body).toMatchObject({ status: 'pending_approval', reason_code: 'under_review' });
    expect(JSON.stringify(third.body)).not.toMatch(/top-ups in 30 days|topup_withdraw_pattern/);
    const mine = (await buyer.api.get('/v1/me/withdrawals')).body.find((x: any) => x.id === third.body.id);
    expect(mine).toMatchObject({ reason_code: 'under_review', method: 'usdt' });
    expect(mine.details.address).toMatch(/^TBuyer…0xyz$/);
    expect(mine).not.toHaveProperty('review_reasons_text');
    const flag = await h.ctx.db.query('SELECT reasons FROM risk_flags WHERE withdrawal_id = $1', [third.body.id]);
    expect(flag.rows[0].reasons.kind).toBe('topup_withdraw_pattern');
    const lead = await makeUser(h, { role: 'lead' });
    const pending = (await lead.api.get('/v1/admin/withdrawals')).body.find((x: any) => x.id === third.body.id);
    expect(pending.review_reasons_text).toHaveLength(1);
    expect(pending.review_reasons_text[0]).toMatch(/3 top-ups in 30 days/);
    expect(pending.review_reason).toBe('topup_withdraw_pattern');
  });

  it('29c. security emails are readable: "Chrome on Android", the region (never a country), the IP on its own line, the time in the user’s timezone, one "This wasn’t me" button; no "18+ only" footer', async () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
    const us = await reg({}, { 'cf-ipcountry': 'SA' });
    expect(us.status).toBe(201);
    const api = client(h.app, us.body.token);
    expect((await api.put('/v1/me/timezone', { timezone: 'Mars/Olympus' })).body.error.code).toBe('invalid_timezone');
    expect((await api.put('/v1/me/timezone', { timezone: 'Asia/Riyadh' })).body).toEqual({ timezone: 'Asia/Riyadh' });
    // a second device signs in
    await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: us.body.user.email, password: 'correct horse battery' }, headers: { 'x-origin-auth': ORIGIN_SECRET, 'x-token-delivery': 'body', 'cf-ipcountry': 'SA', 'user-agent': ua, 'x-forwarded-for': '203.0.113.9', 'x-device-fingerprint': 'phone-2' } });
    for (let i = 0; i < 6; i++) await dispatchEmails(h.ctx);
    const mail = sent.filter((m) => m.to === us.body.user.email && m.subject === 'New sign-in to your Bullizard account').at(-1)!;
    expect(mail).toBeTruthy();
    expect(mail.body).toContain('Device: Chrome on Android');
    expect(mail.body).toContain('Region: Middle East');
    expect(mail.body).not.toMatch(/Saudi|Mozilla|AppleWebKit/);
    expect(mail.body).toMatch(/\nIP: 203\.0\.113\.9/);
    expect(mail.body).toMatch(/Time: (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} (AM|PM)/);
    expect(mail.body).not.toMatch(/UTC/);
    expect(mail.body).toContain('This wasn’t me — secure my account'.replace('’', "'"));
    expect(mail.body).toContain('/account/secure');
    expect(mail.body).not.toContain('18+');
    // Arabic, same shape
    await api.put('/v1/me/locale', { locale: 'ar' });
    await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: us.body.user.email, password: 'correct horse battery' }, headers: { 'x-origin-auth': ORIGIN_SECRET, 'x-token-delivery': 'body', 'cf-ipcountry': 'SA', 'user-agent': ua, 'x-device-fingerprint': 'phone-3' } });
    for (let i = 0; i < 6; i++) await dispatchEmails(h.ctx);
    const ar = sent.filter((m) => m.to === us.body.user.email && /Bullizard/.test(m.subject ?? '') && /تسجيل دخول/.test(m.subject ?? '')).at(-1)!;
    expect(ar.body).toContain('الجهاز: Chrome on Android');
    expect(ar.body).toContain('المنطقة: الشرق الأوسط');
    expect(ar.body).toContain('/account/secure');
    expect(ar.body).not.toContain('18+');
  });

  it('12b. the refresh cookie is bz_rt2, host-only; both stale Round 29 `bz_rt` cookies (host-only + .bullizard.com) are ignored and cleared, so the user stays signed in', async () => {
    const r = await client(h.app).post('/v1/auth/register', { email: `cookie_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Cookie Tester', acceptTerms: true });
    expect(r.status).toBe(201);
    const setCookies = ([] as string[]).concat(r.headers['set-cookie'] as any);
    const fresh = setCookies.find((c) => c.startsWith('bz_rt2='))!;
    expect(fresh).not.toMatch(/Domain=/);
    expect(setCookies.filter((c) => c.startsWith('bz_rt=') && c.includes('Max-Age=0')).length).toBeGreaterThanOrEqual(1);
    const valid = decodeURIComponent(fresh.split(';')[0]!.slice('bz_rt2='.length));
    // a browser that still carries the old cookie twice (host-only on the API host + Domain=.bullizard.com) sends both, stale, first
    const ok = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { 'x-origin-auth': ORIGIN_SECRET, cookie: `bz_rt=stale-host-only; bz_rt=stale-apex-domain; bz_rt2=${encodeURIComponent(valid)}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTruthy();
    const rotated = ([] as string[]).concat(ok.headers['set-cookie'] as any);
    expect(rotated.some((c) => c.startsWith('bz_rt2=rt_') && !c.includes('Max-Age=0') && !/Domain=/.test(c))).toBe(true);
    expect(rotated.some((c) => c.startsWith('bz_rt=') && c.includes('Max-Age=0'))).toBe(true);
    // the old cookie alone, still valid from before the rename, is accepted once (and replaced by bz_rt2)
    const newValid = decodeURIComponent(rotated.find((c) => c.startsWith('bz_rt2=rt_'))!.split(';')[0]!.slice('bz_rt2='.length));
    const legacy = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { 'x-origin-auth': ORIGIN_SECRET, cookie: `bz_rt=${encodeURIComponent(newValid)}` } });
    expect(legacy.statusCode).toBe(200);
    // only stale values → signed out, every variant cleared
    const bad = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { 'x-origin-auth': ORIGIN_SECRET, cookie: `bz_rt=stale; bz_rt2=stale-too` } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('session_expired');
    expect(([] as string[]).concat(bad.headers['set-cookie'] as any).filter((c) => /^bz_rt2?=/.test(c) && c.includes('Max-Age=0')).length).toBeGreaterThanOrEqual(2);
    // no Domain unless COOKIE_DOMAIN is set explicitly; the legacy clear targets the apex of PUBLIC_WEB_URL
    expect(refreshCookieDomain({ PUBLIC_WEB_URL: 'https://staging.bullizard.com' })).toBeUndefined();
    expect(refreshCookieDomain({ PUBLIC_WEB_URL: 'https://bullizard.com', COOKIE_DOMAIN: '.bullizard.com' })).toBe('.bullizard.com');
    expect(legacyCookieDomain({ PUBLIC_WEB_URL: 'https://api-staging.bullizard.com' })).toBe('.bullizard.com');
    expect(legacyCookieDomain({ PUBLIC_WEB_URL: 'http://localhost:5173' })).toBeUndefined();
  });

  it('12. support.bullizard.com may call the API with cookies', () => {
    expect(allowedWebOrigins({ PUBLIC_WEB_URL: 'https://bullizard.com' })).toEqual(['https://bullizard.com', 'https://support.bullizard.com']);
    expect(allowedWebOrigins({ PUBLIC_WEB_URL: 'https://www.bullizard.com', EXTRA_WEB_ORIGINS: 'https://staging.bullizard.com/, https://ops.bullizard.com' })).toEqual(['https://www.bullizard.com', 'https://support.bullizard.com', 'https://staging.bullizard.com', 'https://ops.bullizard.com']);
    expect(allowedWebOrigins({ PUBLIC_WEB_URL: 'http://localhost:5173' })).toEqual(['http://localhost:5173']);
  });
});
