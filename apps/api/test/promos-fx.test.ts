import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountId, balance, sellerAvailable, userCredit } from '../src/domain/ledger.js';
import { runReconciliation } from '../src/domain/reconciliation.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
let admin: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => {
  h = await setup();
  admin = await makeUser(h, { tier: 2, role: 'admin' });
});
afterAll(async () => h.close());

const treasury = async () => balance(h.ctx.db, await accountId(h.ctx.db, 'treasury', 'USD'));

/** Create an order with options and pay it through the mock PSP (if a card payment is needed). */
async function order(buyer: { api: any }, offerId: string, opts: Record<string, unknown> = {}, pay: Record<string, string> = {}) {
  const res = await buyer.api.post('/v1/orders', { offerId, acceptTos: true, ...opts });
  if (res.status !== 201) return res;
  if (res.body.checkoutUrl) {
    const paid = await client(h.app).post(`/v1/payments/mock/checkout/${res.body.order.payment_ref}/pay`, pay, { accept: 'application/json' });
    expect(paid.status).toBe(200);
  }
  return res;
}

async function expectBooksBalanced() {
  const r = await runReconciliation(h.ctx);
  expect(r.report.issues).toEqual([]);
}

async function stockedOffer(seller: Awaited<ReturnType<typeof makeUser>>, body: Record<string, unknown> = {}, codes = 20) {
  const offer = await makeOffer(seller, { priceCents: 20_00, ...body } as any);
  await seller.api.post(`/v1/offers/${offer.id}/inventory`, { format: 'txt', content: Array.from({ length: codes }, (_, i) => `C${i}-${offer.id}`).join('\n') });
  return offer;
}

describe('promo codes', () => {
  it('discounts the buyer, not the seller: the platform funds the difference and gets it back on refund', async () => {
    await admin.api.post('/v1/admin/promos', { code: 'LAUNCH25', percentOff: 25, maxDiscountCents: 1_000 });
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await stockedOffer(seller);

    const quote = (await buyer.api.post('/v1/orders/quote', { offerId: offer.id, promoCode: 'launch25' })).body;
    expect(quote).toMatchObject({ amountCents: 20_00, discountCents: 5_00, chargedCents: 15_00, presentmentAmountCents: 15_00 });

    const t0 = await treasury();
    const o = (await order(buyer, offer.id, { promoCode: 'LAUNCH25' })).body.order;
    expect(o).toMatchObject({ amount_cents: 20_00, discount_cents: 5_00, charged_cents: 15_00 });
    expect(await treasury()).toBe(t0 - 5_00);

    // Second use by the same buyer is refused.
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id, promoCode: 'LAUNCH25' })).body.error.code).toBe('promo_used');

    await buyer.api.post(`/v1/orders/${o.id}/confirm`);
    // Seller is paid on the full price.
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(20_00 - 2_00);
    await expectBooksBalanced();
  });

  it('returns the discount to the platform on refund and frees the code for reuse', async () => {
    await admin.api.post('/v1/admin/promos', { code: 'FIVEOFF', amountOffCents: 500 });
    const arbiter = await makeUser(h, { tier: 2, role: 'arbiter' });
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 5, priceCents: 30_00 });
    const t0 = await treasury();
    const o = (await order(buyer, offer.id, { promoCode: 'FIVEOFF' })).body.order;
    const d = await buyer.api.post(`/v1/orders/${o.id}/dispute`, { reason: 'Seller never replied to the chat' });
    await arbiter.api.post(`/v1/admin/disputes/${d.body.id}/resolve`, { outcome: 'buyer', note: 'No delivery' });
    expect(await treasury()).toBe(t0);
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id, promoCode: 'FIVEOFF' })).status).toBe(200);
    await expectBooksBalanced();
  });

  it('enforces limits, dates, minimums, categories and first-order-only', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await stockedOffer(seller, { priceCents: 8_00 });
    await admin.api.post('/v1/admin/promos', { code: 'BIGSPEND', amountOffCents: 300, minOrderCents: 10_00 });
    await admin.api.post('/v1/admin/promos', { code: 'CARDSONLY', percentOff: 10, categories: ['gift-cards'] });
    await admin.api.post('/v1/admin/promos', { code: 'OLDNEWS', percentOff: 10, endsAt: new Date(Date.now() - 1000).toISOString() });
    await admin.api.post('/v1/admin/promos', { code: 'WELCOME', percentOff: 10, firstOrderOnly: true });
    const buyer = await makeUser(h, { tier: 1 });
    const code = async (c: string) => (await buyer.api.post('/v1/orders/quote', { offerId: offer.id, promoCode: c })).body.error?.code;
    expect(await code('NOPE')).toBe('promo_invalid');
    expect(await code('BIGSPEND')).toBe('promo_min_order');
    expect(await code('CARDSONLY')).toBe('promo_category');
    expect(await code('OLDNEWS')).toBe('promo_expired');
    expect(await code('WELCOME')).toBeUndefined();
    await order(buyer, offer.id);
    expect(await code('WELCOME')).toBe('promo_first_order');
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id, promoCode: 'WELCOME', rail: 'crypto' })).body.error.code).toBe('not_for_crypto');
  });

  it('never oversubscribes a limited code under concurrent checkouts', async () => {
    await admin.api.post('/v1/admin/promos', { code: 'FLASH3', percentOff: 50, maxRedemptions: 3 });
    const seller = await makeUser(h, { tier: 2 });
    const offer = await stockedOffer(seller);
    const buyers = await Promise.all(Array.from({ length: 8 }, () => makeUser(h, { tier: 1 })));
    const res = await Promise.all(buyers.map((b) => b.api.post('/v1/orders', { offerId: offer.id, acceptTos: true, promoCode: 'FLASH3' })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(3);
    expect(res.filter((r) => r.body.error?.code === 'promo_exhausted')).toHaveLength(5);
    const stats = (await admin.api.get('/v1/admin/promos')).body.find((p: any) => p.code === 'FLASH3');
    expect(stats.reserved).toBe(3);
  });
});

describe('referrals and store credit', () => {
  it('pays the referrer credit after the friend’s first qualifying order, which they can spend at checkout', async () => {
    const referrer = await makeUser(h, { tier: 1, device: 'referrer-phone' });
    const { code, link } = (await referrer.api.get('/v1/me/referral')).body;
    expect(link).toContain(code);

    const reg = await client(h.app, undefined, { 'x-device-fingerprint': 'friend-laptop' }).post('/v1/auth/register', {
      email: `friend_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Friend', referralCode: code,
    });
    const friend = { id: reg.body.user.id, api: client(h.app, reg.body.token) };
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1`, [friend.id]);
    const seller = await makeUser(h, { tier: 2 });
    const offer = await stockedOffer(seller, { priceCents: 25_00 });

    const o1 = (await order(friend, offer.id)).body.order;
    await friend.api.post(`/v1/orders/${o1.id}/confirm`);
    expect(await userCredit(h.ctx.db, referrer.id)).toBe(5_00);
    const o2 = (await order(friend, offer.id)).body.order;
    await friend.api.post(`/v1/orders/${o2.id}/confirm`);
    expect(await userCredit(h.ctx.db, referrer.id)).toBe(5_00); // first order only

    // Referrer spends the credit.
    const quote = (await referrer.api.post('/v1/orders/quote', { offerId: offer.id, useCredit: true })).body;
    expect(quote).toMatchObject({ amountCents: 25_00, creditCents: 5_00, chargedCents: 20_00 });
    const o3 = (await order(referrer, offer.id, { useCredit: true })).body.order;
    expect(o3.credit_cents).toBe(5_00);
    expect(await userCredit(h.ctx.db, referrer.id)).toBe(0);
    expect((await referrer.api.get('/v1/me/credit')).body).toMatchObject({ balanceCents: 0, availableCents: 0 });
    await expectBooksBalanced();
  });

  it('blocks rewards between linked accounts', async () => {
    const referrer = await makeUser(h, { tier: 1, device: 'same-pc' });
    const { code } = (await referrer.api.get('/v1/me/referral')).body;
    const reg = await client(h.app, undefined, { 'x-device-fingerprint': 'same-pc' }).post('/v1/auth/register', {
      email: `sock_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Sock', referralCode: code,
    });
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1`, [reg.body.user.id]);
    const sock = { api: client(h.app, reg.body.token, { 'x-device-fingerprint': 'same-pc' }) };
    const seller = await makeUser(h, { tier: 2 });
    const offer = await stockedOffer(seller, { priceCents: 25_00 });
    const o = (await order(sock, offer.id)).body.order;
    await h.ctx.db.query('UPDATE orders SET escrow_frozen = false WHERE id = $1', [o.id]);
    await sock.api.post(`/v1/orders/${o.id}/confirm`);
    expect(await userCredit(h.ctx.db, referrer.id)).toBe(0);
    const r = (await referrer.api.get('/v1/me/referral')).body.rewards[0];
    expect(r).toMatchObject({ status: 'blocked', reason: 'linked_accounts' });
  });

  it('funds an order fully covered by credit without a card, and refunds credit back', async () => {
    const buyer = await makeUser(h, { tier: 1 });
    // Give the buyer 30.00 of credit (as a referral reward would).
    const { post } = await import('../src/domain/ledger.js');
    const { withTx } = await import('../src/db.js');
    await withTx(h.ctx.db, async (tx) =>
      post(tx, [
        { account: await accountId(tx, 'treasury', 'USD'), amountCents: -30_00 },
        { account: await accountId(tx, 'user_credit', 'USD', buyer.id), amountCents: 30_00 },
      ], 'test_credit'),
    );
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 5, priceCents: 20_00 });

    const res = await order(buyer, offer.id, { useCredit: true });
    expect(res.body.checkoutUrl).toBeNull();
    expect(res.body.order).toMatchObject({ status: 'paid', charged_cents: 0, credit_cents: 20_00, payment_provider: 'none' });
    // Credit already promised to an unpaid order can't be spent twice.
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id, useCredit: true })).body.creditCents).toBe(10_00);

    await h.ctx.db.query(`UPDATE orders SET delivery_due_at = now() - interval '1 minute' WHERE id = $1`, [res.body.order.id]);
    await buyer.api.post(`/v1/orders/${res.body.order.id}/cancel-late`);
    expect(await userCredit(h.ctx.db, buyer.id)).toBe(30_00);
    await expectBooksBalanced();
  });

  it('keeps a minimum card charge when credit would leave a few cents', async () => {
    const buyer = await makeUser(h, { tier: 1 });
    const { post } = await import('../src/domain/ledger.js');
    const { withTx } = await import('../src/db.js');
    await withTx(h.ctx.db, async (tx) =>
      post(tx, [
        { account: await accountId(tx, 'treasury', 'USD'), amountCents: -19_80 },
        { account: await accountId(tx, 'user_credit', 'USD', buyer.id), amountCents: 19_80 },
      ], 'test_credit'),
    );
    const seller = await makeUser(h, { tier: 2 });
    const offer = await stockedOffer(seller, { priceCents: 20_00 });
    const q = (await buyer.api.post('/v1/orders/quote', { offerId: offer.id, useCredit: true })).body;
    expect(q).toMatchObject({ chargedCents: 50, creditCents: 19_50 });
  });
});

describe('multiple currencies', () => {
  it('converts EUR listings and lets buyers pay in GBP at a rate locked when ordering', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await stockedOffer(seller, { priceCents: 9_20, currency: 'EUR' }); // €9.20 = $10.00 at 0.92
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body).toMatchObject({ currency: 'EUR', price_cents: 9_20, price_settlement_cents: 10_00 });

    const q = (await buyer.api.post('/v1/orders/quote', { offerId: offer.id, currency: 'GBP' })).body;
    // $10.00 × 0.79 GBP/USD × 1.01 spread = £7.98
    expect(q).toMatchObject({ amountCents: 10_00, presentmentCurrency: 'GBP', presentmentAmountCents: 7_98, listingCurrency: 'EUR' });

    // Rates move after the order is placed: the order keeps its price.
    const res = await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true, currency: 'GBP' });
    await h.ctx.db.query(`UPDATE fx_rates SET rate = 0.5 WHERE currency = 'GBP'`);
    expect((await buyer.api.get(`/v1/orders/${res.body.order.id}`)).body).toMatchObject({ presentment_amount_cents: 7_98, presentment_currency: 'GBP' });
    // PSP converts the £7.98 to $10.07 (our spread): the $0.07 is FX gain.
    await client(h.app).post(`/v1/payments/mock/checkout/${res.body.order.payment_ref}/pay`, { settledCents: '1007' }, { accept: 'application/json' });
    expect(await balance(h.ctx.db, await accountId(h.ctx.db, 'fx_pnl', 'USD'))).toBe(7);
    await buyer.api.post(`/v1/orders/${res.body.order.id}/confirm`);
    expect(await sellerAvailable(h.ctx.db, seller.id)).toBe(10_00 - 1_00);
    await h.ctx.db.query(`UPDATE fx_rates SET rate = 0.79 WHERE currency = 'GBP'`);
    await expectBooksBalanced();
  });

  it('shows search prices and filters in the buyer’s currency', async () => {
    const seller = await makeUser(h, { tier: 2 });
    await stockedOffer(seller, { title: 'Currency test item', priceCents: 50_00 });
    const eur = (await client(h.app).get('/v1/offers?q=currency%20test&currency=EUR')).body.items[0];
    expect(eur).toMatchObject({ display_currency: 'EUR', display_price_cents: 46_00 });
    expect((await client(h.app).get('/v1/offers?q=currency%20test&currency=EUR&maxPrice=4500')).body.items).toHaveLength(0);
    expect((await client(h.app).get('/v1/offers?q=currency%20test&currency=EUR&maxPrice=4700')).body.items).toHaveLength(1);
  });

  it('refuses to price in a currency whose rate is stale, and rejects unsupported currencies', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await stockedOffer(seller);
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id, currency: 'JPY' })).body.error.code).toBe('unsupported_currency');
    await h.ctx.db.query(`UPDATE fx_rates SET fetched_at = now() - interval '3 days' WHERE currency = 'EUR'`);
    // The static provider refreshes on demand only when a rate is missing; a stale one is refused.
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id, currency: 'EUR' })).status).toBe(503);
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id })).status).toBe(200); // USD still fine
    await h.ctx.db.query(`UPDATE fx_rates SET fetched_at = now() WHERE currency = 'EUR'`);
  });
});
