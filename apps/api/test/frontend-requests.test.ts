import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NowPaymentsProvider } from '../src/providers/payments/nowpayments.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

/** The shapes the new screens asked for (docs/frontend-requests, 2026-10-23). */
let h: Harness;
const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const u = new URL(url);
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/v1/merchant/coins') return json({ selectedCurrencies: ['usdttrc20', 'btc'] });
  if (u.pathname === '/v1/min-amount') return json({ min_amount: 1, fiat_equivalent: u.searchParams.get('currency_from') === 'btc' ? 8 : 1 });
  if (u.pathname === '/v1/payment' && init?.method === 'POST') {
    const b = JSON.parse(String(init.body));
    return json({ payment_id: 7001, payment_status: 'waiting', pay_address: 'addr', price_amount: b.price_amount, price_currency: 'usd', pay_amount: b.price_amount, pay_currency: b.pay_currency, order_id: b.order_id, purchase_id: '1', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, 201);
  }
  return json({ error: `unexpected ${init?.method ?? 'GET'} ${u.pathname}` }, 500);
};
beforeAll(async () => {
  const payments = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: 's', apiUrl: 'https://np.test', fetch: fakeFetch as any });
  h = await setup({ PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: 's', CRYPTO_NETWORK_FEES_JSON: '{"btc":2.5}' }, { payments });
});
afterAll(async () => h.close());

describe('front-end requests', () => {
  it('1. currency sold by amount: unit fields, minimum order, totals per unit and the game-page sorts', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const silver = (await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Albion Online', title: 'Silver', priceCents: 2_00, deliveryMode: 'manual', stock: 500, unitLabel: 'M', unitSize: 1_000_000, minQty: 10, attributes: { server: 'Europe' } })).body;
    expect(silver).toMatchObject({ unit_label: 'M', unit_size: 1_000_000, min_qty: 10, price_per_unit_cents: 2_11, stock_qty: 500, seller_badges: [] });
    expect(silver.seller_last_seen_at === null || typeof silver.seller_last_seen_at === 'string').toBe(true);

    // Units are only for currency; the minimum can't exceed the stock.
    expect((await seller.api.post('/v1/offers', { categorySlug: 'items', game: 'Amount Game', title: 'Sword', priceCents: 5_00, deliveryMode: 'manual', stock: 1, unitLabel: 'k' })).body.error.code).toBe('invalid_unit');
    expect((await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Amount Game', title: 'Gold', priceCents: 1_00, deliveryMode: 'manual', stock: 5, minQty: 10 })).body.error.code).toBe('invalid_unit');

    // Buyers order any amount from the minimum up; the total is per unit, grossed up as usual.
    expect((await buyer.api.post('/v1/orders', { offerId: silver.id, quantity: 5, acceptTos: true, characterName: 'Kael' })).body.error.code).toBe('below_minimum');
    const quote = (await buyer.api.post('/v1/orders/quote', { offerId: silver.id, quantity: 25 })).body;
    expect(quote).toMatchObject({ sellerAmountCents: 50_00, amountCents: 52_64 });
    const created = await buyer.api.post('/v1/orders', { offerId: silver.id, quantity: 25, acceptTos: true, characterName: 'Kael' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body.order;
    expect(order).toMatchObject({ quantity: 25, amount_cents: 52_64 });

    // Editing the unit keeps the same checks.
    const v = (await seller.api.get(`/v1/offers/${silver.id}`)).body.version;
    const upd = await seller.api.patch(`/v1/offers/${silver.id}`, { version: v, minQty: 20 });
    expect(upd.body.min_qty, JSON.stringify(upd.body)).toBe(20);

    const cheap = (await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Albion Online', title: 'Silver cheap', priceCents: 1_00, deliveryMode: 'manual', stock: 500, unitLabel: 'M', unitSize: 1_000_000, minQty: 50, attributes: { server: 'Europe' } })).body;
    const list = async (sort: string) => (await client(h.app).get(`/v1/offers?game=${encodeURIComponent('Albion Online')}&category=currency&attr.server=Europe&sort=${sort}`)).body.items.map((o: any) => o.id);
    expect(await list('price_asc')).toEqual([cheap.id, silver.id]);
    expect(await list('min_qty_asc')).toEqual([silver.id, cheap.id]);
    expect((await list('recommended')).length).toBe(2);
    expect((await list('delivery')).length).toBe(2);
  });

  it('2+3. badges shown next to the name, presence and the richer seller profile', async () => {
    const seller = await makeUser(h, { tier: 2 });
    await h.ctx.db.query(`UPDATE users SET founding = true, trust_level = 'top' WHERE id = $1`, [seller.id]);
    const earned = (await seller.api.get('/v1/seller/badges')).body.earned.map((b: any) => b.key);
    expect(earned).toEqual(['rank:hatchling', 'founding', 'id_verified', 'top_seller']);
    expect((await seller.api.put('/v1/seller/badges', { badges: ['founding', 'id_verified', 'top_seller'] })).status).toBe(400);
    expect((await seller.api.put('/v1/seller/badges', { badges: ['rank:dragon'] })).body.error.code).toBe('badge_not_earned');
    expect((await seller.api.put('/v1/seller/badges', { badges: ['founding', 'top_seller'] })).body.badges).toEqual(['founding', 'top_seller']);

    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5 });
    const pub = (await client(h.app).get(`/v1/offers/${offer.id}`)).body;
    expect(pub.seller_badges).toEqual(['founding', 'top_seller']);
    expect(pub).toHaveProperty('seller_last_seen_at');
    expect(pub).toHaveProperty('seller_online');

    const profile = (await seller.api.put('/v1/seller/storefront', { intro: 'Trading since the beta.', pinned: [offer.id], languages: ['en', 'AR', 'pt-BR'] })).body;
    expect(profile.languages).toEqual(['en', 'ar', 'pt-br']);
    const p = (await client(h.app).get(`/v1/sellers/${seller.id}`)).body;
    expect(p).toMatchObject({ about: 'Trading since the beta.', languages: ['en', 'ar', 'pt-br'], featured_offer_ids: [offer.id], orders_sold: 0, seller_badges: ['founding', 'top_seller'] });
    expect(p.positive_pct_90d).toBeNull(); // no reviews yet
    expect(p.delivered_pct).toBeNull();
    expect(typeof p.member_since).toBe('string');
  });

  it('4+5. coins carry network and fee; the buyer can confirm before the seller marks delivered', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5, priceCents: 20_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true })).body.order;
    const coins = (await buyer.api.get(`/v1/orders/${order.id}/crypto/coins`)).body;
    expect(coins.owedCents).toBe(21_06);
    expect(coins.coins).toEqual([
      expect.objectContaining({ coin: 'usdttrc20', network: 'TRC-20', fee_cents: 1_00, total_cents: 22_06, disabled: false, reason: null }),
      expect.objectContaining({ coin: 'btc', network: 'Bitcoin', fee_cents: 2_50, total_cents: 23_56, disabled: false }), // fee from CRYPTO_NETWORK_FEES_JSON
    ]);

    // A second order funded from the buyer's balance, confirmed while it is still "paid".
    const { post, accountId } = await import('../src/domain/ledger.js');
    const { withTx } = await import('../src/db.js');
    await withTx(h.ctx.db, async (tx) =>
      post(tx, [
        { account: await accountId(tx, 'treasury', 'USD'), amountCents: -25_00 },
        { account: await accountId(tx, 'user_credit', 'USD', buyer.id), amountCents: 25_00 },
      ], 'referral_reward'),
    );
    const paid = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, useCredit: true })).body.order;
    expect(paid.status).toBe('paid');
    expect((await seller.api.post(`/v1/orders/${paid.id}/confirm`, {})).status).toBe(403);
    const done = await buyer.api.post(`/v1/orders/${paid.id}/confirm`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const after = (await buyer.api.get(`/v1/orders/${paid.id}`)).body;
    expect(after.status).toBe('completed');
    expect(after.delivered_at).toBeTruthy();
    expect(after.events.map((e: any) => e.reason)).toContain('buyer_confirmed_early');
    // The chat log carries the event as a code the app can translate.
    const msgs = (await buyer.api.get(`/v1/chat/rooms/${after.room_id}/messages`)).body;
    expect(msgs.map((m: any) => m.code).filter(Boolean)).toEqual(['order_created', 'payment_received', 'completed_early']);
    expect(msgs.find((m: any) => m.code === 'completed_early').params).toEqual({ reason: 'buyer_confirmed_early' });
  });

  it('6. one wallet: balances, entries (held → completed) and buyer withdrawals', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const { post, accountId } = await import('../src/domain/ledger.js');
    const { withTx } = await import('../src/db.js');
    await withTx(h.ctx.db, async (tx) =>
      post(tx, [
        { account: await accountId(tx, 'treasury', 'USD'), amountCents: -30_00 },
        { account: await accountId(tx, 'user_credit', 'USD', buyer.id), amountCents: 30_00 },
      ], 'referral_reward'),
    );
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5, priceCents: 10_00 });
    const order = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, acceptTos: true, useCredit: true })).body.order;
    expect(order).toMatchObject({ status: 'paid', credit_cents: 10_53 });

    let w = (await buyer.api.get('/v1/me/wallet')).body;
    expect(w.balances).toEqual({ USD: 19_47, EUR: 0 });
    expect(w.breakdown.USD).toMatchObject({ credit_cents: 19_47, credit_available_cents: 19_47, sales_cents: 0 });
    expect(w.entries.map((e: any) => [e.kind, e.status, e.amount_cents])).toEqual([['order', 'held', -10_53], ['credit', 'completed', 30_00]]);
    expect(w.entries[0].ref).toMatch(/^order#[A-Z0-9]{7}$/);
    expect(w.next).toBeNull();

    await buyer.api.post(`/v1/orders/${order.id}/confirm`, {});
    w = (await buyer.api.get('/v1/me/wallet')).body;
    expect(w.entries[0]).toMatchObject({ kind: 'order', status: 'completed' });
    const sw = (await seller.api.get('/v1/me/wallet')).body;
    expect(sw.entries[0]).toMatchObject({ kind: 'sale', status: 'completed', amount_cents: 10_00 });
    expect(sw.balances.USD).toBe(10_00);

    // Withdraw the rest of the buyer balance: same rules as sellers (6%, min $1.50), needs a confirmed address.
    expect((await buyer.api.post('/v1/me/withdrawals', { amountCents: 5_00 })).body.error.code).toBe('no_payout_address');
    await h.ctx.db.query(`UPDATE users SET payout_address = 'TQdemo1234567890', payout_address_currency = 'usdttrc20', payout_address_set_at = now(), payouts_enabled = true WHERE id = $1`, [buyer.id]);
    const wd = await buyer.api.post('/v1/me/withdrawals', { amountCents: 5_00 });
    expect(wd.status, JSON.stringify(wd.body)).toBe(201);
    expect(wd.body).toMatchObject({ source: 'credit', fee_cents: 1_50, net_cents: 3_50 });
    w = (await buyer.api.get('/v1/me/wallet?limit=2')).body;
    expect(w.entries[0]).toMatchObject({ kind: 'withdrawal', status: 'pending', amount_cents: -5_00, coin: 'usdttrc20', address: 'TQdemo1234567890' });
    expect(w.next).toBeTruthy(); // more pages
    expect((await buyer.api.get('/v1/me/withdrawals')).body).toHaveLength(1);
  });

  it('8. site texts per locale with an English fallback', async () => {
    const support = await makeUser(h, { role: 'support' });
    const en = (await client(h.app).get('/v1/texts/chat_safety?lang=ar')).body;
    expect(en.locale).toBe('en'); // nothing in Arabic yet
    const ar = await support.api.put('/v1/admin/texts/chat_safety', { body: 'أبقِ الصفقة كاملة داخل هذه المحادثة.', linkLabel: 'القواعد', linkHref: '/help/rules', lang: 'ar' });
    expect(ar.status, JSON.stringify(ar.body)).toBe(200);
    expect((await client(h.app).get('/v1/texts/chat_safety?lang=ar')).body).toMatchObject({ locale: 'ar', link_label: 'القواعد' });
    expect((await client(h.app).get('/v1/texts/chat_safety?lang=ar-EG')).body.locale).toBe('ar');
    expect((await client(h.app).get('/v1/texts/chat_safety')).body.locale).toBe('en');
    expect((await support.api.get('/v1/admin/texts/chat_safety')).body.map((t: any) => t.locale)).toEqual(['en', 'ar']);
  });
});
