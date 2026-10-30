import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grossMicros, grossUp } from '../src/domain/unitPrice.js';
import { client, makeUser, setup, type Harness } from './helpers.js';
import { grossUp as grossUpCents } from '../src/domain/commission.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

type Seller = Awaited<ReturnType<typeof makeUser>>;
async function silver(seller: Seller, over: Record<string, unknown> = {}) {
  const res = await seller.api.post('/v1/offers', {
    categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 50_000_000,
    unitPrice: '0.000123', deliveryMethods: ['f2f', 'market'], deliveryTime: '1h', attributes: { server: 'Europe' }, description: 'Meet me at the bank. Deliver within the hour.', ...over,
  });
  if (res.status !== 201) throw new Error(`silver offer failed: ${JSON.stringify(res.body)}`);
  return res.body;
}
const delivery = { deliveryMethod: 'f2f', deliveryInfo: { character: 'Buyer1' } };

describe('Round 26 B — listing features', () => {
  it('B1: a maximum per order is checked on quotes, orders and cart lines; never below the minimum', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    expect((await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 5_000_000, unitPrice: '0.0005', deliveryMethods: ['f2f'], deliveryTime: '1h', attributes: { server: 'Europe' }, minQty: 10_000, maxQty: 9_999 })).body.error.code).toBe('invalid_unit');
    const offer = await silver(seller, { minQty: 10_000, maxQty: 1_000_000 });
    expect(offer).toMatchObject({ min_qty: 10_000, max_qty: 1_000_000 });
    const over = await buyer.api.post('/v1/orders/quote', { offerId: offer.id, quantity: 1_000_001 });
    expect(over.body.error).toMatchObject({ code: 'above_maximum', details: { maxQty: 1_000_000 } });
    expect((await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1_000_001, acceptTos: true, ...delivery })).body.error.code).toBe('above_maximum');
    expect((await buyer.api.post('/v1/orders/cart', { items: [{ offerId: offer.id, quantity: 1_000_001, ...delivery }], acceptTos: true })).body.error.code).toBe('above_maximum');
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id, quantity: 1_000_000 })).status).toBe(200);
    // The cap can be edited and removed.
    const v = (await seller.api.get(`/v1/offers/${offer.id}`)).body.version;
    expect((await seller.api.patch(`/v1/offers/${offer.id}`, { version: v, maxQty: 5_000 })).body.error.code).toBe('invalid_unit'); // below the minimum
    expect((await seller.api.patch(`/v1/offers/${offer.id}`, { version: v, maxQty: null })).body.max_qty).toBeNull();
    expect((await buyer.api.post('/v1/orders/quote', { offerId: offer.id, quantity: 1_000_001 })).status).toBe(200);
  });

  it('B2: pause, resume and soft delete; a listing with open orders can only be paused', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await silver(seller);
    expect((await seller.api.post(`/v1/offers/${offer.id}/pause`)).body).toMatchObject({ status: 'paused', listing_state: 'paused' });
    expect((await client(h.app).get(`/v1/offers?game=Albion%20Online&category=currency`)).body.items.some((o: any) => o.id === offer.id)).toBe(false);
    expect((await seller.api.post(`/v1/offers/${offer.id}/pause`)).body.error.code).toBe('not_active');
    expect((await seller.api.post(`/v1/offers/${offer.id}/resume`)).body).toMatchObject({ status: 'active', listing_state: 'active' });
    expect((await seller.api.post(`/v1/offers/${offer.id}/resume`)).body.error.code).toBe('not_paused');
    // An open (paid) order blocks deletion, with the count; pausing still works.
    const created = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 20_000, acceptTos: true, ...delivery });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body.order;
    await client(h.app).post(`/v1/payments/mock/checkout/${order.payment_ref}/pay`, {}, { accept: 'application/json' });
    const del = await seller.api.del(`/v1/offers/${offer.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatchObject({ code: 'has_open_orders', details: { openOrders: 1 } });
    const v = (await seller.api.get(`/v1/offers/${offer.id}`)).body.version;
    expect((await seller.api.patch(`/v1/offers/${offer.id}`, { version: v, status: 'removed' })).body.error.code).toBe('has_open_orders');
    expect((await seller.api.post(`/v1/offers/${offer.id}/pause`)).status).toBe(200);
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'done' });
    await buyer.api.post(`/v1/orders/${order.id}/confirm`);
    const gone = await seller.api.del(`/v1/offers/${offer.id}`);
    expect(gone.status).toBe(200);
    expect(gone.body.status).toBe('removed');
    expect((await h.ctx.db.query('SELECT removed_at FROM offers WHERE id = $1', [offer.id])).rows[0].removed_at).toBeTruthy();
    expect((await seller.api.get('/v1/seller/offers')).body.some((o: any) => o.id === offer.id)).toBe(false);
    expect((await seller.api.post(`/v1/offers/${offer.id}/resume`)).body.error.code).toBe('listing_removed');
    // The order still shows the listing's title.
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.offer_title).toBe(offer.title);
  });

  it('B3: duplicate to another server copies everything, rebuilds the title, and starts at the stock given', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const src = await silver(seller, { volumeDiscounts: [{ minQty: 2_000_000, percentOff: 5 }], minQty: 1_000, maxQty: 10_000_000, unitLabel: 'k', unitSize: 1000 });
    const copy = await seller.api.post(`/v1/offers/${src.id}/duplicate`, { attributes: { server: 'Americas' }, stock: 7_000_000 });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(copy.body).toMatchObject({
      id: expect.not.stringMatching(src.id), game: 'Albion Online', category_slug: 'currency', attributes: { server: 'Americas' }, title: 'Albion Online · Americas',
      description: src.description, unit_price_micros: src.unit_price_micros, volume_discounts: src.volume_discounts, delivery_methods: src.delivery_methods,
      delivery_time: '1h', min_qty: 1000, max_qty: 10_000_000, unit_label: 'k', stock: 7_000_000,
    });
    expect(copy.body.public_id).not.toBe(src.public_id);
    expect((await h.ctx.db.query('SELECT duplicated_from FROM offers WHERE id = $1', [copy.body.id])).rows[0].duplicated_from).toBe(src.id);
    expect((await seller.api.get(`/v1/offers/${copy.body.id}`)).body.seller_unit_price_micros).toBe(123);
    // Someone else's listing can't be duplicated.
    const other = await makeUser(h, { tier: 2 });
    expect((await other.api.post(`/v1/offers/${src.id}/duplicate`, { attributes: { server: 'Asia' } })).status).toBe(404);
  });

  it('B4/B5: currency titles are built by the API (game · server · faction), other categories need a title; faction only for Aion', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const albion = await silver(seller, { title: 'ignored by the API' });
    expect(albion.title).toBe('Albion Online · Europe');
    expect(albion.description).toContain('Deliver within the hour');
    // Aion needs a faction; Albion and Path of Exile refuse one.
    const noFaction = await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Aion', deliveryMode: 'manual', stock: 1_000_000, unitPrice: '0.001', deliveryMethods: ['f2f', 'mail'], deliveryTime: '3h', attributes: { server: 'Siel', region: 'Europe' } });
    expect(noFaction.body.error.code).toBe('invalid_attributes');
    expect(noFaction.body.error.message).toMatch(/Faction/);
    const aion = await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Aion 2', deliveryMode: 'manual', stock: 1_000_000, unitPrice: '0.001', deliveryMethods: ['f2f', 'mail'], deliveryTime: '3h', attributes: { server: 'Siel', region: 'Europe', faction: 'elyos' } });
    expect(aion.status, JSON.stringify(aion.body)).toBe(201);
    expect(aion.body.title).toBe('Aion 2 · Siel · Elyos');
    expect(aion.body.attributes).toMatchObject({ faction: 'Elyos' });
    expect((await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 1000, unitPrice: '0.001', deliveryMethods: ['f2f'], deliveryTime: '1h', attributes: { server: 'Europe', faction: 'Elyos' } })).body.error.code).toBe('invalid_attributes');
    // The title follows an edit of the server/faction; a hand-written title is ignored.
    const v = aion.body.version;
    const moved = await seller.api.patch(`/v1/offers/${aion.body.id}`, { version: v, title: 'My kinah shop', attributes: { server: 'Nezekan', region: 'Europe', faction: 'Asmodian' } });
    expect(moved.body.title).toBe('Aion 2 · Nezekan · Asmodian');
    expect((await seller.api.patch(`/v1/offers/${aion.body.id}`, { version: moved.body.version, title: 'My kinah shop' })).body.title).toBe('Aion 2 · Nezekan · Asmodian');
    // Non-currency: the title is the seller's and required.
    expect((await seller.api.post('/v1/offers', { categorySlug: 'keys', game: 'Test Game', priceCents: 500, deliveryMode: 'auto' })).body.error.code).toBe('title_required');
    expect((await seller.api.post('/v1/offers', { categorySlug: 'keys', game: 'Test Game', title: 'Steam key EU', priceCents: 500, deliveryMode: 'auto', description: 'Key by chat' })).body).toMatchObject({ title: 'Steam key EU', description: 'Key by chat' });
    // The catalogue's attribute definitions carry the faction for Aion only.
    const defs = (await client(h.app).get('/v1/catalog/attributes?game=Aion&category=currency')).body;
    expect(JSON.stringify(defs)).toMatch(/Asmodian/);
    expect(JSON.stringify((await client(h.app).get('/v1/catalog/attributes?game=Albion%20Online&category=currency')).body)).not.toMatch(/Asmodian/);
  });

  it('B8: out of stock delists by itself and relists on restock, without touching "paused"; concurrent buys never oversell', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await silver(seller, { stock: 30_000, minQty: 10_000 });
    const market = async () => (await client(h.app).get('/v1/offers?game=Albion%20Online&category=currency')).body.items.some((o: any) => o.id === offer.id);
    expect(await market()).toBe(true);
    // Three buyers race for 30,000 units in orders of 10,000 + 10,000 + 20,000: only 30,000 can sell.
    const buyers = await Promise.all([makeUser(h), makeUser(h), makeUser(h)]);
    const results = await Promise.all([10_000, 10_000, 20_000].map((q, i) => buyers[i]!.api.post('/v1/orders', { offerId: offer.id, quantity: q, acceptTos: true, ...delivery })));
    const sold = results.filter((r) => r.status === 201).reduce((s, r) => s + Number(r.body.order.quantity), 0);
    expect(sold).toBeLessThanOrEqual(30_000);
    expect(results.some((r) => r.status !== 201 && r.body.error.code === 'out_of_stock')).toBe(true);
    const view = async () => (await seller.api.get(`/v1/offers/${offer.id}`)).body;
    if (sold === 30_000) {
      expect(await view()).toMatchObject({ status: 'active', listing_state: 'out_of_stock', stock: 0 });
      expect(await market()).toBe(false);
      expect((await seller.api.get('/v1/seller/offers')).body.find((o: any) => o.id === offer.id).listing_state).toBe('out_of_stock');
      // Not "paused by the seller": resume says so, and a restock relists without any other action.
      expect((await seller.api.post(`/v1/offers/${offer.id}/resume`)).body.error.code).toBe('not_paused');
    }
    const v = (await view()).version;
    const restocked = await seller.api.patch(`/v1/offers/${offer.id}`, { version: v, stock: 50_000 });
    expect(restocked.status, JSON.stringify(restocked.body)).toBe(200);
    expect(restocked.body.listing_state).toBe('active');
    expect(await market()).toBe(true);
    // A seller-paused listing stays paused through a restock.
    await seller.api.post(`/v1/offers/${offer.id}/pause`);
    const v2 = (await view()).version;
    expect((await seller.api.patch(`/v1/offers/${offer.id}`, { version: v2, stock: 60_000 })).body.listing_state).toBe('paused');
    expect(await market()).toBe(false);
  });

  it('B10: POST /offers/preview validates like create and shows the buyer price, writing nothing', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const before = (await h.ctx.db.query('SELECT count(*)::int AS n FROM offers WHERE seller_id = $1', [seller.id])).rows[0].n;
    const bad = await seller.api.post('/v1/offers/preview', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 1000, unitPrice: '0.000123', deliveryMethods: ['f2f'], deliveryTime: '1h' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_attributes'); // Server is required for Albion
    expect((await seller.api.post('/v1/offers/preview', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 1000, unitPrice: '0.000123', deliveryMethods: ['boat'], deliveryTime: '1h', attributes: { server: 'Europe' } })).body.error.code).toBe('invalid_delivery_method');
    const ok = await seller.api.post('/v1/offers/preview', { categorySlug: 'currency', game: 'Albion Online', deliveryMode: 'manual', stock: 5_000_000, unitPrice: '0.000123', deliveryMethods: ['f2f', 'market'], deliveryTime: '1h', attributes: { server: 'Europe' }, minQty: 10_000, maxQty: 1_000_000, volumeDiscounts: [{ minQty: 1_000_000, percentOff: 10 }], description: 'Bank trade' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const rate = ok.body.seller.commission_bps as number;
    expect(ok.body).toMatchObject({
      valid: true, would_need_review: false,
      listing: { title: 'Albion Online · Europe', description: 'Bank trade', attributes: { server: 'Europe' }, delivery_time: '1h', delivery_methods: ['f2f', 'market'], min_qty: 10_000, max_qty: 1_000_000, unit_price_micros: grossMicros(123, rate), unit_price: expect.stringMatching(/^0\.0001/), listing_state: 'active', volume_discounts: [{ minQty: 1_000_000, percentOff: 10 }] },
      seller: { unit_price_micros: 123, unit_price: '0.000123' },
      buyer: { unit_price_micros: grossMicros(123, rate), currency: 'USD' },
    });
    expect(ok.body.buyer.min_order_cents).toBe(grossUpCents(Math.ceil((123 * 10_000) / 10_000), rate)); // 10,000 units × 0.000123 = $1.23, grossed up
    expect((await h.ctx.db.query('SELECT count(*)::int AS n FROM offers WHERE seller_id = $1', [seller.id])).rows[0].n).toBe(before);
    // The real listing then matches the preview.
    const real = await silver(seller, { minQty: 10_000, maxQty: 1_000_000, volumeDiscounts: [{ minQty: 1_000_000, percentOff: 10 }], description: 'Bank trade' });
    expect(real.unit_price_micros).toBe(ok.body.listing.unit_price_micros);
    expect(real.title).toBe(ok.body.listing.title);
    void grossUp;
  });
});
