import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hmacSha256 } from '../src/lib/crypto.js';
import { MockPaymentProvider } from '../src/providers/payments/mock.js';
import { TEMPLATES } from '../src/domain/notifications.js';
import { confirmVerificationCode, getUser } from '../src/domain/users.js';
import { isLeadOrder } from '../src/domain/orders.js';
import { paymentMethodsFor } from '../src/domain/paymentMethods.js';
import { checkVolumeDiscounts, formatUnitPrice, grossMicros, parseUnitPrice, totalCentsFor, unitMicrosFor } from '../src/domain/unitPrice.js';
import { grossUp } from '../src/domain/commission.js';
import { sellerAvailable, userCredit } from '../src/domain/ledger.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

/** Round 25: B1–B8 (currency unit prices, market search, payments and FX, review fixes). One block per item. */
let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
const read = (p: string) => readFileSync(repo(p), 'utf8');

type Seller = Awaited<ReturnType<typeof makeUser>>;
/** An Albion silver listing in the Round 25 shape. */
async function silver(seller: Seller, over: Record<string, unknown> = {}) {
  const res = await seller.api.post('/v1/offers', {
    categorySlug: 'currency', game: 'Albion Online', title: 'Silver, fast', deliveryMode: 'manual', stock: 50_000_000,
    unitPrice: '0.000123', deliveryMethods: ['f2f', 'market'], deliveryTime: '1h', attributes: { server: 'Europe' }, ...over,
  });
  if (res.status !== 201) throw new Error(`silver offer failed: ${JSON.stringify(res.body)}`);
  return res.body;
}
const delivery = { deliveryMethod: 'f2f', deliveryInfo: { character: 'Buyer1' } };

describe('B1 server summary', () => {
  it('lists every server of the game with active offers, up to four sellers, sold and the lowest unit price', async () => {
    const sellers = await Promise.all([0, 1, 2, 3, 4].map((i) => makeUser(h, { tier: 2, name: `Silver seller ${i}` })));
    for (const [i, s] of sellers.entries()) await silver(s, { unitPrice: `0.00${200 + i}` });
    const paused = await silver(sellers[0]!, { unitPrice: '0.0001' });
    await sellers[0]!.api.patch(`/v1/offers/${paused.id}`, { version: paused.version, status: 'paused' });
    const asia = await makeUser(h, { tier: 2 });
    await silver(asia, { attributes: { server: 'Asia' }, unitPrice: '0.0005' });

    const res = await client(h.app).get('/v1/games/albion-online/servers?category=currency');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((r: any) => r.name)).toEqual(['Americas', 'Europe', 'Asia']);
    const [americas, europe, asiaRow] = res.body;
    expect(americas).toMatchObject({ offers: 0, sellers: [], sellers_count: 0, sold: 0, from_unit_price: null });
    // Active offers only (the paused 0.0001 listing doesn't count), five sellers but four shown.
    expect(europe).toMatchObject({ offers: 5, sellers_count: 5, sold: 0 });
    expect(europe.sellers).toHaveLength(4);
    expect(europe.sellers[0]).toEqual({ id: expect.any(String), name: expect.stringMatching(/^Silver seller/), avatar: null });
    // The lowest buyer unit price: 0.002 grossed up by the 5% launch-promo commission.
    expect(europe.from_unit_price).toBe(formatUnitPrice(grossMicros(2000, 500)));
    expect(europe.from_unit_price_micros).toBe(grossMicros(2000, 500));
    expect(asiaRow).toMatchObject({ offers: 1, sellers_count: 1 });
    expect((await client(h.app).get('/v1/games/no-such-game/servers')).status).toBe(404);
  });
});

describe('B2 precise unit prices', () => {
  it('pure rules: parse/format, totals rounded up to the cent, volume discounts rounded up', () => {
    expect(parseUnitPrice('0.000123')).toBe(123);
    expect(parseUnitPrice('1.5')).toBe(1_500_000);
    expect(parseUnitPrice('0.0000001')).toBeNull();
    expect(parseUnitPrice('-1')).toBeNull();
    expect(formatUnitPrice(123)).toBe('0.000123');
    expect(totalCentsFor(123, 1_234_567)).toBe(15_186); // 151.851741 → 151.86
    expect(totalCentsFor(10_000, 3)).toBe(3);
    expect(totalCentsFor(123, 2_000_000_000)).toBe(24_600_000); // no float error at large quantities
    expect(unitMicrosFor(123, [{ minQty: 2_000_000, percentOff: 5 }], 2_000_000)).toBe(117); // 116.85 → 117
    expect(unitMicrosFor(123, [{ minQty: 2_000_000, percentOff: 5 }], 1_999_999)).toBe(123);
    expect(checkVolumeDiscounts([{ minQty: 10, percentOff: 5 }, { minQty: 20, percentOff: 5 }]).ok).toBe(false);
  });

  it('charges qty × unit price rounded up, grosses the commission up on it, stores both prices and keeps every money path right', async () => {
    const seller = await makeUser(h, { tier: 2 });
    await h.ctx.db.query('UPDATE users SET payout_hold_days = 0 WHERE id = $1', [seller.id]);
    const buyer = await makeUser(h);
    const offer = await silver(seller, { volumeDiscounts: [{ minQty: 2_000_000, percentOff: 5 }] });
    expect(offer).toMatchObject({ unit_price_micros: grossMicros(123, 500), volume_discounts: [{ minQty: 2_000_000, percentOff: 5 }], delivery_time: '1h', delivery_minutes: 60 });
    expect(offer.seller_unit_price_micros).toBe(123); // the owner sees their own price

    // Minimum $1.00: 1,000 units are 0.12 + commission.
    const small = await buyer.api.post('/v1/orders/quote', { offerId: offer.id, quantity: 1000 });
    expect(small.body.error).toMatchObject({ code: 'below_minimum_order', details: { minCents: 100 } });

    const q = (await buyer.api.post('/v1/orders/quote', { offerId: offer.id, quantity: 1_234_567 })).body;
    expect(q).toMatchObject({ sellerAmountCents: 15_186, amountCents: grossUp(15_186, 500), listingUnitPriceMicros: 123, volumePercentOff: 0, commissionBps: 500 });
    const bulk = (await buyer.api.post('/v1/orders/quote', { offerId: offer.id, quantity: 2_000_000 })).body;
    expect(bulk).toMatchObject({ listingUnitPriceMicros: 117, volumePercentOff: 5, sellerAmountCents: 23_400, amountCents: grossUp(23_400, 500) });

    const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1_234_567, acceptTos: true, ...delivery });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body.order;
    expect(Number(order.amount_cents)).toBe(grossUp(15_186, 500));
    expect(Number(order.amount_usd_cents)).toBe(Number(order.amount_cents));
    const row = (await h.ctx.db.query('SELECT unit_price_micros, listing_unit_price_micros, unit_price_cents, commission_cents, seller_net_cents FROM orders WHERE id = $1', [order.id])).rows[0];
    expect(row).toMatchObject({ listing_unit_price_micros: 123, seller_net_cents: 15_186, commission_cents: grossUp(15_186, 500) - 15_186 });
    expect(Number(row.unit_price_micros)).toBe(Math.round((grossUp(15_186, 500) * 10_000) / 1_234_567));
    const snap = (await h.ctx.db.query('SELECT snapshot FROM offer_snapshots WHERE order_id = $1', [order.id])).rows[0].snapshot;
    expect(snap.offer).toMatchObject({ unit_price_micros: 123, price_cents: 1, volume_discounts: [{ minQty: 2_000_000, percentOff: 5 }], delivery_minutes: 60 });
    expect(snap.price).toMatchObject({ listingUnitPriceMicros: 123, listingUnitPriceCents: 0, sellerAmountCents: 15_186 });

    // Paid, delivered, confirmed: the seller receives exactly their price, the rest is commission.
    await client(h.app).post(`/v1/payments/mock/checkout/${order.payment_ref}/pay`, {}, { accept: 'application/json' });
    const before = await sellerAvailable(h.ctx.db, seller.id);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'traded at Martlock' });
    expect((await buyer.api.post(`/v1/orders/${order.id}/confirm`)).status).toBe(200);
    expect((await sellerAvailable(h.ctx.db, seller.id)) - before).toBe(15_186);

    // A refund goes to the buyer's balance in full (the buyer price).
    const order2 = (await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1_000_000, acceptTos: true, ...delivery })).body.order;
    await client(h.app).post(`/v1/payments/mock/checkout/${order2.payment_ref}/pay`, {}, { accept: 'application/json' });
    expect((await buyer.api.post(`/v1/orders/${order2.id}/dispute`, { reason: 'Seller never came to trade', category: 'not_delivered' })).status).toBe(200);
    const d = (await h.ctx.db.query('SELECT id FROM disputes WHERE order_id = $1', [order2.id])).rows[0];
    const arbiter = await makeUser(h, { role: 'arbiter' });
    const credit0 = await userCredit(h.ctx.db, buyer.id, 'USD');
    expect((await arbiter.api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome: 'buyer', note: 'No delivery' })).status).toBe(200);
    expect((await userCredit(h.ctx.db, buyer.id, 'USD')) - credit0).toBe(Number(order2.amount_cents));
    expect(Number(order2.amount_cents)).toBe(grossUp(totalCentsFor(123, 1_000_000), 500));
  });

  it('migration 080 backfilled micros = cents × 10,000 on currency listings and orders', async () => {
    const r = (await h.ctx.db.query(`SELECT count(*)::int AS n FROM offers f JOIN categories c ON c.slug = f.category_slug WHERE c.kind = 'currency' AND f.unit_price_micros IS NULL`)).rows[0];
    expect(r.n).toBe(0);
    expect(read('apps/api/migrations/080_round25.sql')).toMatch(/unit_price_micros = f\.price_cents \* 10000/);
    expect(read('apps/api/migrations/080_round25.sql')).toMatch(/unit_price_micros = unit_price_cents \* 10000/);
  });
});

describe('B3 currency listing create/update', () => {
  it('requires server, stock, unit price, delivery methods from the game and a delivery time from the list; up to 4 volume tiers', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const base = { categorySlug: 'currency', game: 'Albion Online', title: 'Silver', deliveryMode: 'manual', stock: 1_000_000, unitPrice: '0.0002', deliveryMethods: ['f2f'], deliveryTime: '3h', attributes: { server: 'Asia' } };
    const err = async (body: Record<string, unknown>) => (await seller.api.post('/v1/offers', body)).body.error?.code;
    expect(await err({ ...base, attributes: {} })).toBe('invalid_attributes'); // Albion's server is a required field
    expect(await err({ ...base, stock: undefined })).toBe('stock_required');
    expect(await err({ ...base, unitPrice: undefined })).toBe('unit_price_required');
    expect(await err({ ...base, unitPrice: '0.0000001' })).toBe('invalid_unit_price');
    expect(await err({ ...base, deliveryMethods: undefined })).toBe('invalid_delivery_method');
    expect(await err({ ...base, deliveryMethods: ['mail'] })).toBe('invalid_delivery_method'); // Albion: f2f, market
    expect(await err({ ...base, deliveryTime: undefined })).toBe('delivery_time_required');
    expect(await err({ ...base, deliveryTime: '2h' })).toBe('validation_error');
    expect(await err({ ...base, volumeDiscounts: [1, 2, 3, 4, 5].map((i) => ({ minQty: i * 10, percentOff: i })) })).toBe('validation_error');
    expect(await err({ ...base, volumeDiscounts: [{ minQty: 10, percentOff: 51 }] })).toBe('validation_error');
    expect(await err({ ...base, volumeDiscounts: [{ minQty: 10, percentOff: 10 }, { minQty: 20, percentOff: 5 }] })).toBe('invalid_volume_discounts');
    expect(await err({ ...base, priceTiers: [{ minQty: 2, priceCents: 1 }] })).toBe('invalid_tiers');
    // Non-currency listings have no micro-unit price.
    expect(await err({ categorySlug: 'keys', game: 'Test Game', title: 'Key', deliveryMode: 'auto', unitPrice: '0.5' })).toBe('invalid_unit');

    // "Established buyers only" is ignored if sent (both spellings); nothing stores or gates on it.
    const ok = await seller.api.post('/v1/offers', { ...base, volumeDiscounts: [{ minQty: 2_000_000, percentOff: 3 }, { minQty: 5_000_000, percentOff: 8 }], minBuyerReputation: 'good', establishedBuyersOnly: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).not.toHaveProperty('min_buyer_reputation');
    expect((await h.ctx.db.query('SELECT min_buyer_reputation FROM offers WHERE id = $1', [ok.body.id])).rows[0].min_buyer_reputation).toBeNull();
    expect(ok.body).toMatchObject({ delivery_methods: ['f2f'], delivery_time: '3h', seller_unit_price_micros: 200, price_cents: grossUp(1, ok.body.seller_rate_bps) });

    // Update: unit price and tiers, delivery time; bad values refused.
    const patched = await seller.api.patch(`/v1/offers/${ok.body.id}`, { version: ok.body.version, unitPriceMicros: 150, deliveryTime: '15m', volumeDiscounts: [] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body).toMatchObject({ seller_unit_price_micros: 150, delivery_time: '15m', volume_discounts: [] });
    expect((await seller.api.patch(`/v1/offers/${ok.body.id}`, { version: patched.body.version, deliveryHours: 2 })).body.error.code).toBe('invalid_delivery_time');
  });

  it('featured_until reaches only the owner and staff', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller);
    await h.ctx.db.query(`UPDATE offers SET featured_until = now() + interval '3 days' WHERE id = $1`, [offer.id]);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body).not.toHaveProperty('featured_until');
    expect((await (await makeUser(h)).api.get(`/v1/offers/${offer.id}`)).body).not.toHaveProperty('featured_until');
    expect((await seller.api.get(`/v1/offers/${offer.id}`)).body.featured_until).toBeTruthy();
    const staff = await makeUser(h, { role: 'support' });
    expect((await staff.api.get(`/v1/offers/${offer.id}`)).body.featured_until).toBeTruthy();
  });
});

describe('B4 market search and facets', () => {
  it('filters by game, server, unit price, delivery method, delivery time, online and level; sorts; counts facets', async () => {
    const game = 'Albion Online';
    const a = await makeUser(h, { tier: 2, name: 'Fast Fred' });
    const b = await makeUser(h, { tier: 2, name: 'Slow Sam' });
    const fast = await silver(a, { attributes: { server: 'Americas' }, deliveryMethods: ['market'], deliveryTime: '15m', unitPrice: '0.0003' });
    const slow = await silver(b, { attributes: { server: 'Americas' }, deliveryMethods: ['f2f'], deliveryTime: '24h', unitPrice: '0.0001' });
    await h.ctx.db.query('UPDATE users SET completed_orders = 100, show_online = true, last_seen_at = now() WHERE id = $1', [a.id]);
    await h.ctx.db.query('UPDATE users SET show_online = false WHERE id = $1', [b.id]);
    await h.ctx.db.query('UPDATE offers SET sold_count = 7 WHERE id = $1', [fast.id]);
    const ids = async (qs: string) => (await client(h.app).get(`/v1/offers?game=${encodeURIComponent(game)}&category=currency&server=Americas&${qs}`)).body.items.map((o: any) => o.id);

    expect(await ids('sort=price_asc')).toEqual([slow.id, fast.id]);
    expect(await ids('sort=price_desc')).toEqual([fast.id, slow.id]);
    expect(await ids('sort=most_sold')).toEqual([fast.id, slow.id]);
    expect(await ids('sort=fastest_delivery')).toEqual([fast.id, slow.id]);
    expect(await ids('sort=newest')).toEqual([slow.id, fast.id]);
    expect((await ids('sort=recommended')).sort()).toEqual([fast.id, slow.id].sort());
    expect(await ids('deliveryMethod=market')).toEqual([fast.id]);
    expect(await ids('maxDeliveryTime=1h')).toEqual([fast.id]);
    expect(await ids('online=true')).toEqual([fast.id]);
    expect(await ids('minLevel=21')).toEqual([fast.id]); // 100 orders = level 21
    expect(await ids('minLevel=22')).toEqual([]);
    expect(await ids('maxUnitPrice=0.0002')).toEqual([slow.id]); // buyer unit price 0.000106 vs 0.000316
    expect(await ids('minUnitPrice=0.0002')).toEqual([fast.id]);
    expect((await client(h.app).get('/v1/offers?server=Americas')).body.error.code).toBe('invalid_attribute_filter');
    expect((await client(h.app).get('/v1/offers?pageSize=100')).status).toBe(400);

    const f = (await client(h.app).get(`/v1/offers/facets?game=${encodeURIComponent(game)}&category=currency&server=Americas&deliveryMethod=market`)).body;
    expect(f.servers.key).toBe('server');
    // Server counts ignore the server filter (but keep the market-method filter): one market listing in the Americas.
    expect(f.servers.values.find((v: any) => v.name === 'Americas')).toEqual({ name: 'Americas', count: 1 });
    expect(f.servers.values.map((v: any) => v.name)).toEqual(['Americas', 'Europe', 'Asia']);
    // Method counts ignore the method filter.
    expect(f.delivery_methods).toEqual(expect.arrayContaining([{ method: 'market', count: 1 }, { method: 'f2f', count: 1 }]));
    expect(f.games.find((g: any) => g.game === game)).toMatchObject({ count: 1 });
  });

  it('featured: pinned and marked on the seller’s own shop only, no boost or badge anywhere else', async () => {
    const founder = await makeUser(h, { tier: 2 });
    const one = await makeOffer(founder, { title: 'Featured key', priceCents: 99_00, deliveryMode: 'manual', stock: 3 });
    const two = await makeOffer(founder, { title: 'Cheap key', priceCents: 1_00, deliveryMode: 'manual', stock: 3 });
    await h.ctx.db.query(`UPDATE offers SET featured_until = now() + interval '3 days' WHERE id = $1`, [one.id]);
    const market = (await client(h.app).get('/v1/offers?game=Test%20Game&sort=price_asc&pageSize=60')).body.items;
    expect(market.every((o: any) => !('featured' in o) && !('featured_until' in o))).toBe(true);
    const mine = market.filter((o: any) => [one.id, two.id].includes(o.id)).map((o: any) => o.id);
    expect(mine).toEqual([two.id, one.id]); // price order, no featured boost
    const shop = (await client(h.app).get(`/v1/offers?seller=${founder.id}&sort=price_asc`)).body.items;
    expect(shop.map((o: any) => [o.id, o.featured])).toEqual([[one.id, true], [two.id, false]]);
    expect(shop[0]).not.toHaveProperty('featured_until');
    expect((await client(h.app).get(`/v1/offers/${one.id}`)).body).not.toHaveProperty('featured');
  });
});

describe('B5 payment methods and B6 FX rates', () => {
  it('lists enabled methods from config; an EGP viewer pays crypto in USD', async () => {
    expect((await client(h.app).get('/v1/payment-methods?currency=EGP')).body).toEqual([{ id: 'crypto', currencies: ['USD', 'EUR'], enabled: true, pay_currency: 'USD' }]);
    expect((await client(h.app).get('/v1/payment-methods?currency=EUR')).body[0].pay_currency).toBe('EUR');
    expect((await client(h.app).get('/v1/payment-methods?currency=XYZ')).status).toBe(400);
    const cfg = { ...h.ctx.cfg, PAYMENT_METHODS_JSON: JSON.stringify([{ id: 'crypto', currencies: ['USD', 'EUR'], enabled: true }, { id: 'vodafone_cash', currencies: ['EGP'], enabled: true, viewerCurrencies: ['EGP'] }, { id: 'later', currencies: ['USD'], enabled: false }]) };
    expect(paymentMethodsFor({ cfg } as any, 'EGP').map((m) => [m.id, m.pay_currency])).toEqual([['crypto', 'USD'], ['vodafone_cash', 'EGP']]);
    expect(paymentMethodsFor({ cfg } as any, 'USD').map((m) => m.id)).toEqual(['crypto']);
    expect(() => paymentMethodsFor({ cfg: { ...cfg, PAYMENT_METHODS_JSON: '{"id":1}' } } as any)).toThrow(/array/);
  });

  it('/fx/rates gives exact USD→EUR/EGP rates with as_of and the quote hold', async () => {
    await client(h.app).get('/v1/offers?currency=EUR'); // loads the rates (static provider in tests)
    const r = await client(h.app).get('/v1/fx/rates');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ base: 'USD', quote_ttl_seconds: 900, exact: { EUR: '0.92000000', EGP: '48.50000000' } });
    expect(new Date(r.body.as_of).getTime()).toBeGreaterThan(0);
    expect(r.body.rates.find((x: any) => x.currency === 'EUR')).toMatchObject({ rate: '0.92000000', as_of: expect.anything() });
  });

  it('settlement stays USD: any other SETTLEMENT_CURRENCY is refused at start', () => {
    expect(() => loadConfig({ SETTLEMENT_CURRENCY: 'EUR' } as any)).toThrow(/USD/);
  });
});

describe('B7 saved searches removed', () => {
  it('has no routes, job or email; the table stays', async () => {
    const u = await makeUser(h);
    expect((await u.api.get('/v1/me/saved-searches')).status).toBe(404);
    expect((await u.api.post('/v1/me/saved-searches', { name: 'x', params: {} })).status).toBe(404);
    expect(Object.keys(TEMPLATES)).not.toContain('saved_search_digest');
    expect(read('apps/api/src/worker.ts')).not.toMatch(/saved_search|savedSearch/);
    expect((await h.ctx.db.query(`SELECT to_regclass('saved_searches') AS t`)).rows[0].t).toBe('saved_searches');
  });
});

describe('B8 review fixes', () => {
  it('M2: the $200 Lead rule compares the USD amount, not cents of the order currency', async () => {
    expect(isLeadOrder({ amount_cents: 190_00, amount_usd_cents: 206_00, currency: 'EUR' })).toBe(true);
    expect(isLeadOrder({ amount_cents: 210_00, amount_usd_cents: 190_00, currency: 'EUR' })).toBe(false);
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 3, priceCents: 150_00 });
    const order = await buyAndPay(h, buyer, offer.id);
    // Worth more than $200 in USD although its amount_cents is below 200_00.
    await h.ctx.db.query('UPDATE orders SET amount_usd_cents = 250_00 WHERE id = $1', [order.id]);
    expect((await buyer.api.post(`/v1/orders/${order.id}/dispute`, { reason: 'Nothing arrived at all', category: 'not_delivered' })).status).toBe(200);
    const d = (await h.ctx.db.query('SELECT id FROM disputes WHERE order_id = $1', [order.id])).rows[0];
    const arbiter = await makeUser(h, { role: 'arbiter' });
    expect((await arbiter.api.get('/v1/admin/disputes')).body.find((x: any) => x.id === d.id).lead_review).toBe(true);
    expect((await arbiter.api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome: 'buyer', note: 'No delivery' })).body.error.message).toContain('orders.lead');
    const lead = await makeUser(h, { role: 'lead' });
    expect((await lead.api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome: 'buyer', note: 'No delivery' })).status).toBe(200);
  });

  it('L1: banned/deleted accounts promoted by 079 go back to 0, and are never promoted again', async () => {
    const banned = await makeUser(h, { tier: 0 });
    const deleted = await makeUser(h, { tier: 0 });
    const kept = await makeUser(h, { tier: 0 });
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1, email_verified_at = now(), phone_verified_at = NULL, status = 'banned', banned_at = now() WHERE id = $1`, [banned.id]);
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1, email_verified_at = now(), phone_verified_at = NULL, deleted_at = now() WHERE id = $1`, [deleted.id]);
    await h.ctx.db.query(`UPDATE users SET kyc_tier = 1, email_verified_at = now(), phone_verified_at = now(), status = 'banned', banned_at = now() WHERE id = $1`, [kept.id]);
    const sql = read('apps/api/migrations/080_round25.sql');
    await h.ctx.db.query(sql.slice(sql.lastIndexOf('UPDATE users SET kyc_tier = 0')));
    const tiers = async (id: string) => (await h.ctx.db.query('SELECT kyc_tier FROM users WHERE id = $1', [id])).rows[0].kyc_tier;
    expect([await tiers(banned.id), await tiers(deleted.id), await tiers(kept.id)]).toEqual([0, 0, 1]); // kept: level 1 by phone before 079

    // Confirming an email code no longer lifts a banned account.
    const code = '123456';
    await h.ctx.db.query(`INSERT INTO verification_codes (user_id, channel, target, code_hash, expires_at) VALUES ($1, 'email', 'x@example.com', $2, now() + interval '10 minutes')`, [banned.id, hmacSha256(h.ctx.cfg.FINGERPRINT_KEY, `${banned.id}:email:${code}`)]);
    const user = (await getUser(h.ctx.db, banned.id))!;
    await confirmVerificationCode(h.ctx, user, 'email', code).catch(() => null);
    expect(await tiers(banned.id)).toBe(0);
  });

  it('L3: a 409 on PATCH /offers changes nothing (delivery methods and units included)', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await silver(seller);
    const stale = offer.version;
    const fresh = await seller.api.patch(`/v1/offers/${offer.id}`, { version: stale, title: 'Silver, renamed' });
    expect(fresh.status).toBe(200);
    const conflict = await seller.api.patch(`/v1/offers/${offer.id}`, { version: stale, deliveryMethods: ['market'], unitLabel: 'M', unitSize: 1_000_000, minQty: 5, unitPrice: '0.5' });
    expect(conflict.status).toBe(409);
    const row = (await h.ctx.db.query('SELECT delivery_methods, unit_label, unit_size, min_qty, unit_price_micros FROM offers WHERE id = $1', [offer.id])).rows[0];
    expect(row).toEqual({ delivery_methods: ['f2f', 'market'], unit_label: null, unit_size: null, min_qty: 1, unit_price_micros: 123 });
  });

  it('render.yaml staging: real NOWPayments (sandbox URL), live platform accounts, no sandbox mode; and it boots', () => {
    const doc = parseYaml(read('render.yaml'));
    const vars = Object.fromEntries(doc.envVarGroups[0].envVars.filter((v: any) => 'value' in v).map((v: any) => [v.key, String(v.value)]));
    expect(vars).toMatchObject({ SANDBOX_MODE: 'false', PLATFORM_ACCOUNTS: 'live', PAYMENT_PROVIDER: 'nowpayments', NOWPAYMENTS_API_URL: 'https://api-sandbox.nowpayments.io', APP_ENV: 'staging' });
    expect(read('render.yaml').split('\n').slice(0, 6).join('\n')).not.toMatch(/mock payments/);
    const cfg = loadConfig({
      ...vars, JWT_SECRET: 'x'.repeat(40), DATA_ENCRYPTION_KEYS: 'v1:Y2ktb25seS1kYXRhLWtleS0zMi1ieXRlcy0tLS0tLS0=', FINGERPRINT_KEY: 'fp', CRYPTO_INDEXER_SECRET: 'idx',
      RESEND_API_KEY: 're_test', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: 's',
    } as any);
    expect(cfg).toMatchObject({ SANDBOX_MODE: false, PAYMENT_PROVIDER: 'nowpayments', PLATFORM_ACCOUNTS: 'live' });
  });

  it('the card-path withdrawal is gone: no payout account routes, no PSP transfer; withdrawals are USDT requests', async () => {
    const seller = await makeUser(h, { tier: 2 });
    expect((await seller.api.post('/v1/seller/payout-account')).status).toBe(404);
    expect((await seller.api.get('/v1/seller/payout-account')).status).toBe(404);
    expect('payout' in (h.ctx.payments as MockPaymentProvider)).toBe(false);
    expect((await seller.api.post('/v1/seller/withdrawals', { amountCents: 10_00 })).body.error.code).toBe('no_payout_address');
  });
});
