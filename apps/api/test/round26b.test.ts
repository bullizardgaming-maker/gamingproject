import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grossUp } from '../src/domain/commission.js';
import { checkVolumeDiscounts, formatDeliveryMinutes, formatUnitPriceTrimmed, grossMicros, parseDeliveryMinutes, parseUnitPrice, totalCentsFor, unitMicrosFor, volumePercentFor } from '../src/domain/unitPrice.js';
import { _resetPriceGuideCache } from '../src/domain/offers.js';
import { client, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

type Seller = Awaited<ReturnType<typeof makeUser>>;
async function silver(seller: Seller, over: Record<string, unknown> = {}) {
  const res = await seller.api.post('/v1/offers', {
    categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 50_000_000,
    unitPrice: '0.14', deliveryMethods: ['f2f', 'market'], deliveryMinutes: 45, attributes: { server: 'Europe' }, description: 'Bank trade', ...over,
  });
  return res;
}
const delivery = { deliveryMethod: 'f2f', deliveryInfo: { character: 'Buyer1' } };
const fail = async (seller: Seller, over: Record<string, unknown>) => (await silver(seller, over)).body.error?.code;

describe('Round 26b — create offer (back end)', () => {
  it('pure rules: ".14" parses, trimmed full precision, typed delivery minutes, tier checks and pricing', () => {
    expect(parseUnitPrice('.14')).toBe(140_000);
    expect(parseUnitPrice('0.133')).toBe(133_000);
    expect(parseUnitPrice('.')).toBeNull();
    expect(formatUnitPriceTrimmed(140_000)).toBe('0.14');
    expect(formatUnitPriceTrimmed(123)).toBe('0.000123');
    expect(formatUnitPriceTrimmed(2_000_000)).toBe('2');
    expect(parseDeliveryMinutes('45')).toBe(45);
    expect(parseDeliveryMinutes('2h')).toBe(120);
    expect(parseDeliveryMinutes('72 hours')).toBe(4320);
    expect(parseDeliveryMinutes('73h')).toBeNull();
    expect(parseDeliveryMinutes(0)).toBeNull();
    expect(formatDeliveryMinutes(90)).toBe('1h 30m');
    expect(formatDeliveryMinutes(4320)).toBe('72h');
    // Tiers: percent and fixed, rising quantities, each cheaper than the one before; the old spelling still parses.
    const base = 140_000; // 0.14 per unit
    expect(checkVolumeDiscounts([{ minQty: 100, percentOff: 5 }], 1, base)).toMatchObject({ ok: true, value: [{ minQty: 100, type: 'percent', value: 5 }] });
    expect(checkVolumeDiscounts([{ minQty: 100, type: 'percent', value: 5 }, { minQty: 1000, type: 'fixed', value: 120_000 }], 1, base).ok).toBe(true);
    expect(checkVolumeDiscounts([{ minQty: 100, type: 'fixed', value: 140_000 }], 1, base)).toMatchObject({ ok: false, error: expect.stringMatching(/below the base/) });
    expect(checkVolumeDiscounts([{ minQty: 100, type: 'percent', value: 20 }, { minQty: 1000, type: 'fixed', value: 130_000 }], 1, base)).toMatchObject({ ok: false, error: expect.stringMatching(/cheaper than the one before/) });
    expect(checkVolumeDiscounts([{ minQty: 100, type: 'percent', value: 51 }], 1, base).ok).toBe(false);
    expect(checkVolumeDiscounts([{ minQty: 100, type: 'fixed', value: 0 }], 1, base).ok).toBe(false);
    expect(checkVolumeDiscounts([{ minQty: 1, type: 'percent', value: 5 }], 1, base).ok).toBe(false); // not above the minimum order
    // Pricing: a percent tier rounds up to the micro-unit; a fixed tier is the price itself; quantities × price round up to the cent.
    expect(unitMicrosFor(base, [{ minQty: 100, type: 'percent', value: 5 }], 100)).toBe(133_000);
    expect(unitMicrosFor(333, [{ minQty: 10, type: 'percent', value: 10 }], 10)).toBe(300); // 299.7 → 300
    expect(unitMicrosFor(base, [{ minQty: 100, type: 'fixed', value: 120_000 }], 100)).toBe(120_000);
    expect(unitMicrosFor(base, [{ minQty: 100, type: 'fixed', value: 120_000 }], 99)).toBe(base);
    expect(volumePercentFor([{ minQty: 100, type: 'fixed', value: 105_000 }], 100, base)).toBe(25);
    expect(totalCentsFor(120_000, 7)).toBe(84);
    expect(totalCentsFor(1, 3)).toBe(1); // 0.000003 → 1 cent
  });

  it('delivery speed is typed: any whole number of minutes from 1 to 72 h; the list values still work; filter and sort follow it', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const fast = await silver(seller, { deliveryMinutes: 45 });
    expect(fast.status, JSON.stringify(fast.body)).toBe(201);
    expect(fast.body).toMatchObject({ delivery_minutes: 45, delivery_time: '1h', delivery_hours: 1 });
    const slow = await silver(seller, { deliveryMinutes: 4320, unitPrice: '0.15' });
    expect(slow.body).toMatchObject({ delivery_minutes: 4320, delivery_time: '24h', delivery_hours: 72 });
    expect((await silver(seller, { deliveryTime: '3h', deliveryMinutes: undefined, unitPrice: '0.16' })).body.delivery_minutes).toBe(180); // Round 25 key
    expect((await silver(seller, { deliveryHours: 2, deliveryMinutes: undefined, unitPrice: '0.17' })).body.delivery_minutes).toBe(120);
    expect(await fail(seller, { deliveryMinutes: 0 })).toBe('validation_error');
    expect(await fail(seller, { deliveryMinutes: 4321 })).toBe('validation_error');
    expect(await fail(seller, { deliveryMinutes: undefined })).toBe('delivery_time_required');
    const v = fast.body.version;
    expect((await seller.api.patch(`/v1/offers/${fast.body.id}`, { version: v, deliveryMinutes: 90 })).body).toMatchObject({ delivery_minutes: 90, delivery_time: '3h' });
    // Filter: within 60 minutes finds the 45-minute one and not the 72-hour one; sort fastest first.
    const within = (await client(h.app).get(`/v1/offers?game=Albion%20Online&category=currency&seller=${seller.id}&maxDeliveryMinutes=100`)).body.items.map((o: any) => o.delivery_minutes);
    expect(within).toContain(90);
    expect(within).not.toContain(4320);
    expect((await client(h.app).get(`/v1/offers?game=Albion%20Online&category=currency&seller=${seller.id}&maxDeliveryTime=3h`)).body.items.map((o: any) => o.delivery_minutes)).toEqual(expect.arrayContaining([90, 120, 180]));
    const sorted = (await client(h.app).get(`/v1/offers?game=Albion%20Online&category=currency&seller=${seller.id}&sort=fastest_delivery`)).body.items.map((o: any) => o.delivery_minutes);
    expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
  });

  it('volume tiers: % off or a fixed unit price, grossed up like the base price, ordered and checked; existing percent tiers migrate', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const res = await silver(seller, { minQty: 10, volumeDiscounts: [{ minQty: 100, type: 'percent', value: 5 }, { minQty: 1000, type: 'fixed', value: 120_000 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const offer = res.body;
    const rate = offer.seller_rate_bps as number;
    expect(offer.volume_discounts).toEqual([{ minQty: 100, type: 'percent', value: 5 }, { minQty: 1000, type: 'fixed', value: 120_000 }]);
    expect(offer.unit_price_micros).toBe(grossMicros(140_000, rate));
    // Quotes: the base, the 5 % tier (0.133), the fixed tier (0.12); each the seller's price grossed up and rounded up to the cent.
    const q = async (quantity: number) => (await buyer.api.post('/v1/orders/quote', { offerId: offer.id, quantity })).body;
    expect(await q(50)).toMatchObject({ listingUnitPriceMicros: 140_000, volumePercentOff: 0, volumeTier: null, sellerAmountCents: 700, amountCents: grossUp(700, rate) });
    expect(await q(100)).toMatchObject({ listingUnitPriceMicros: 133_000, volumePercentOff: 5, volumeTier: { minQty: 100, type: 'percent', value: 5 }, sellerAmountCents: 1330, amountCents: grossUp(1330, rate) });
    const fixed = await q(1000);
    expect(fixed).toMatchObject({ listingUnitPriceMicros: 120_000, volumePercentOff: 14.29, volumeTier: { minQty: 1000, type: 'fixed', value: 120_000 }, sellerAmountCents: 120_00, amountCents: grossUp(120_00, rate) });
    expect(fixed.unitPriceMicros).toBe(Math.round((grossUp(120_00, rate) * 10_000) / 1000)); // buyer per unit, micros
    // An order at the fixed tier: the seller's net is exactly 1000 × 0.12.
    const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1000, acceptTos: true, ...delivery });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const row = (await h.ctx.db.query('SELECT seller_net_cents, listing_unit_price_micros, amount_cents FROM orders WHERE id = $1', [created.body.order.id])).rows[0];
    expect(row).toMatchObject({ seller_net_cents: 120_00, listing_unit_price_micros: 120_000, amount_cents: grossUp(120_00, rate) });
    // Checks on input.
    expect(await fail(seller, { unitPrice: '0.2', volumeDiscounts: [{ minQty: 100, type: 'fixed', value: 200_000 }] })).toBe('invalid_volume_discounts'); // not below the base
    expect(await fail(seller, { unitPrice: '0.2', volumeDiscounts: [{ minQty: 100, type: 'percent', value: 30 }, { minQty: 1000, type: 'fixed', value: 150_000 }] })).toBe('invalid_volume_discounts'); // dearer than the previous tier
    expect(await fail(seller, { unitPrice: '0.2', volumeDiscounts: [{ minQty: 100, type: 'percent', value: 0 }] })).toBe('validation_error');
    expect(await fail(seller, { unitPrice: '0.2', volumeDiscounts: [{ minQty: 100, type: 'percent', value: 5 }, { minQty: 100, type: 'percent', value: 10 }] })).toBe('invalid_volume_discounts');
    // The Round 25 spelling is still accepted and stored as a percent tier.
    const old = await silver(seller, { unitPrice: '0.3', volumeDiscounts: [{ minQty: 500, percentOff: 8 }] });
    expect(old.body.volume_discounts).toEqual([{ minQty: 500, type: 'percent', value: 8 }]);
    // Migration 083 converts stored Round 25 tiers in place (idempotent).
    await h.ctx.db.query(`UPDATE offers SET volume_discounts = '[{"minQty": 900, "percentOff": 7}, {"minQty": 200, "percentOff": 3}]' WHERE id = $1`, [old.body.id]);
    const sql = (await import('node:fs')).readFileSync(new URL('../migrations/083_round26b.sql', import.meta.url), 'utf8');
    await h.ctx.db.query(sql);
    await h.ctx.db.query(sql);
    expect((await h.ctx.db.query('SELECT volume_discounts FROM offers WHERE id = $1', [old.body.id])).rows[0].volume_discounts).toEqual([{ minQty: 200, type: 'percent', value: 3 }, { minQty: 900, type: 'percent', value: 7 }]);
    expect((await buyer.api.post('/v1/orders/quote', { offerId: old.body.id, quantity: 950 })).body.volumePercentOff).toBe(7);
  });

  it('preview and quote return micros for full-precision display: 0.133 is never shown as 0.14', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const p = await seller.api.post('/v1/offers/preview', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 1_000_000, unitPrice: '.14', deliveryMethods: ['f2f'], deliveryMinutes: 30, attributes: { server: 'Europe' }, minQty: 10, volumeDiscounts: [{ minQty: 100, type: 'percent', value: 5 }, { minQty: 1000, type: 'fixed', value: 120_000 }] });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const rate = p.body.seller.commission_bps as number;
    expect(p.body.seller).toMatchObject({ unit_price_micros: 140_000, unit_price: '0.14' });
    expect(p.body.buyer).toMatchObject({ unit_price_micros: grossMicros(140_000, rate), unit_price: formatUnitPriceTrimmed(grossMicros(140_000, rate)) });
    expect(p.body.listing).toMatchObject({ delivery_minutes: 30, delivery_minutes_text: '30m', max_qty: null });
    expect(p.body.listing.volume_tiers).toEqual([
      { minQty: 100, type: 'percent', value: 5, seller_unit_micros: 133_000, seller_unit_price: '0.133', unit_price_micros: grossMicros(133_000, rate), unit_price: formatUnitPriceTrimmed(grossMicros(133_000, rate)) },
      { minQty: 1000, type: 'fixed', value: 120_000, seller_unit_micros: 120_000, seller_unit_price: '0.12', unit_price_micros: grossMicros(120_000, rate), unit_price: formatUnitPriceTrimmed(grossMicros(120_000, rate)) },
    ]);
    expect(p.body.listing.volume_tiers[0].seller_unit_price).not.toBe('0.14');
  });

  it('price guide: lowest / median / recommended buyer micros for a game + server, other sellers\' live listings only, cached 60 s', async () => {
    const me = await makeUser(h, { tier: 2 });
    const a = await makeUser(h, { tier: 2 });
    const b = await makeUser(h, { tier: 2 });
    const c = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const over = { game: 'Albion Online', attributes: { server: 'Americas' } };
    expect((await silver(a, { ...over, unitPrice: '0.10' })).status).toBe(201);
    expect((await silver(a, { ...over, unitPrice: '0.30' })).status).toBe(201);
    expect((await silver(b, { ...over, unitPrice: '0.20' })).status).toBe(201);
    const paused = await silver(c, { ...over, unitPrice: '0.01' });
    await c.api.post(`/v1/offers/${paused.body.id}/pause`, {});
    const sold = await silver(c, { ...over, unitPrice: '0.02', stock: 10 });
    await h.ctx.db.query('UPDATE offers SET stock = 0 WHERE id = $1', [sold.body.id]);
    expect((await silver(me, { ...over, unitPrice: '0.001' })).status).toBe(201); // my own: excluded
    expect((await silver(a, { attributes: { server: 'Europe' }, unitPrice: '0.05' })).status).toBe(201); // another server
    _resetPriceGuideCache();
    expect((await buyer.api.get('/v1/offers/price-guide?game=Albion%20Online&server=Americas')).status).toBe(403);
    const g = await me.api.get('/v1/offers/price-guide?game=Albion%20Online&server=Americas');
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const rate = (await me.api.post('/v1/offers/preview', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 1, unitPrice: '1', deliveryMethods: ['f2f'], deliveryMinutes: 30, attributes: { server: 'Europe' } })).body.seller.commission_bps as number;
    const lowest = grossMicros(100_000, rate), median = grossMicros(200_000, rate);
    const recommended = Math.max(Math.round(lowest * 0.99), Math.ceil(median * 0.8));
    expect(g.body).toMatchObject({ sellers: 2, listings: 3, lowest_micros: lowest, median_micros: median, recommended_micros: recommended, seller_net: { commission_bps: rate, lowest_micros: Math.floor((lowest * (10_000 - rate)) / 10_000) } });
    expect(typeof g.body.as_of).toBe('string');
    // Cached: a new listing does not show for 60 s; after the cache is cleared it does.
    expect((await silver(b, { ...over, unitPrice: '0.09' })).status).toBe(201);
    expect((await me.api.get('/v1/offers/price-guide?game=Albion%20Online&server=Americas')).body.lowest_micros).toBe(lowest);
    _resetPriceGuideCache();
    expect((await me.api.get('/v1/offers/price-guide?game=Albion%20Online&server=Americas')).body.lowest_micros).toBe(grossMicros(90_000, rate));
    // No listings → nulls, and the recommended floor: lowest far below the median is lifted to 80 % of the median.
    expect((await me.api.get('/v1/offers/price-guide?game=Albion%20Online&server=Asia')).body).toMatchObject({ sellers: 0, lowest_micros: null, median_micros: null, recommended_micros: null });
    expect((await me.api.get('/v1/offers/price-guide?game=Nope')).status).toBe(200);
  });
});
