import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attributesFor, handoverFieldFor, LEAGUES } from '../src/domain/attributeSets.js';
import { runJobsOnce } from '../src/worker.js';
import { buyAndPay, client, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup({ STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'bz-proof-')), DELIVERY_PROOF_REQUIRED: 'true' });
});
afterAll(async () => h.close());

/** A minimal WebM: the EBML header the sniffer looks for, then padding. */
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2_000, 1)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(2_000, 2)]);

const poeOffer = (seller: any, league = 'Standard', extra: Record<string, unknown> = {}) =>
  seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Path of Exile', title: `100 Divine Orbs — ${league}`, priceCents: 20_00, deliveryMode: 'manual', stock: 10, attributes: { league, mode: 'Softcore' }, ...extra });

describe('launch games', () => {
  it('has the listing fields each launch game uses, and a character name only where the game delivers in-game', async () => {
    expect(attributesFor('Aion', 'currency').map((d) => [d.key, d.required])).toEqual([['server', true], ['region', true], ['faction', true]]); // Round 26: Elyos / Asmodian
    expect(attributesFor('Aion 2', 'items').map((d) => d.key)).toEqual(['server', 'region', 'faction']);
    expect(attributesFor('Albion Online', 'currency')[0]).toMatchObject({ key: 'server', options: ['Americas', 'Europe', 'Asia'], required: true });
    expect(attributesFor('Path of Exile', 'currency').map((d) => d.key)).toEqual(['league', 'mode']);
    expect(attributesFor('Path of Exile 2', 'items').map((d) => d.key)).toEqual(['league', 'mode']);
    expect(attributesFor('Path of Exile', 'currency')[0]!.options).toEqual(['Standard', 'Hardcore']);
    expect(handoverFieldFor('Path of Exile', 'currency')).toMatchObject({ key: 'character', label: 'Character name' });
    expect(handoverFieldFor('Albion Online', 'items')?.key).toBe('character');
    expect(handoverFieldFor('Genshin Impact', 'top-ups')?.key).toBe('uid');
    expect(handoverFieldFor('Path of Exile', 'accounts')).toBeNull(); // accounts hand over credentials, not a trade
    expect(handoverFieldFor('Elden Ring', 'keys')).toBeNull();
    const seller = await makeUser(h, { tier: 2 });
    expect((await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Albion Online', title: '10M silver', priceCents: 10_00, deliveryMode: 'manual', stock: 5, attributes: { server: 'Mars' } })).body.error.code).toBe('invalid_attributes');
    expect((await seller.api.post('/v1/offers', { categorySlug: 'currency', game: 'Aion 2', title: '1M kinah', priceCents: 10_00, deliveryMode: 'manual', stock: 5, attributes: { server: 'Siel' } })).body.error.message).toMatch(/Region is required/);
    const cat = (await client(h.app).get('/v1/catalog/attributes?game=Path%20of%20Exile&category=currency')).body;
    expect(cat.handover).toMatchObject({ key: 'character' });
  });

  it('lets support open a challenge league, expires an inactive seller’s listings when it ends, and relists in an open league', async () => {
    const support = await makeUser(h, { role: 'support' });
    const quiet = await makeUser(h, { tier: 2 });
    const active = await makeUser(h, { tier: 2 });
    expect((await poeOffer(quiet, 'Settlers')).body.error.code).toBe('invalid_attributes'); // not open yet

    const created = await support.api.post('/v1/admin/leagues', { game: 'Path of Exile', name: 'Settlers', startsAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await support.api.post('/v1/admin/leagues', { game: 'Path of Exile', name: 'settlers' })).body.error.code).toBe('league_exists');
    expect((await support.api.post('/v1/admin/leagues', { game: 'Path of Exile', name: 'Standard' })).body.error.code).toBe('invalid_league');
    expect((await client(h.app).get('/v1/leagues')).body.open['path of exile']).toEqual(['Standard', 'Hardcore', 'Settlers']);
    expect(LEAGUES['path of exile']).toContain('Settlers');

    const quietOffer = (await poeOffer(quiet, 'Settlers')).body;
    const activeOffer = (await poeOffer(active, 'Settlers')).body;
    const standard = (await poeOffer(quiet, 'Standard')).body;
    expect(quietOffer.attributes).toEqual({ league: 'Settlers', mode: 'Softcore' });

    // The league ends; the quiet seller has not been seen for weeks, the active one signed in today.
    await support.api.patch(`/v1/admin/leagues/${created.body.id}`, { endsAt: new Date(Date.now() - 60_000).toISOString() });
    await h.ctx.db.query(`UPDATE users SET last_seen_at = now() - interval '20 days' WHERE id = $1`, [quiet.id]);
    await h.ctx.db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [active.id]);
    await runJobsOnce(h.ctx);
    const rows = Object.fromEntries((await h.ctx.db.query('SELECT id, status, expired_reason FROM offers WHERE id = ANY($1)', [[quietOffer.id, activeOffer.id, standard.id]])).rows.map((r: any) => [r.id, r]));
    expect(rows[quietOffer.id]).toMatchObject({ status: 'expired', expired_reason: 'league_ended:Settlers' });
    expect(rows[activeOffer.id].status).toBe('active');
    expect(rows[standard.id].status).toBe('active');
    expect((await client(h.app).get(`/v1/offers/${quietOffer.id}`)).status).toBe(404);
    expect((await quiet.api.get('/v1/me/notifications')).body.items.map((i: any) => i.template)).toContain('listing_expired_league');
    // The closed league is no longer a choice; the seller moves the listing to Standard.
    expect((await client(h.app).get('/v1/leagues')).body.open['path of exile']).toEqual(['Standard', 'Hardcore']);
    expect((await quiet.api.post(`/v1/offers/${quietOffer.id}/relist`, { league: 'Settlers' })).body.error.code).toBe('invalid_league');
    const back = await quiet.api.post(`/v1/offers/${quietOffer.id}/relist`, { league: 'standard' });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'active', attributes: { league: 'Standard', mode: 'Softcore' } });
  });

  it('asks the buyer for their character name once, remembers it (when asked to), and stores it on the order', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = (await poeOffer(seller)).body;
    const missing = await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: 'character_name_required' });

    const ok = await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true, characterName: 'MyExile_One', saveInfo: true }); // Round 24: remembered only with saveInfo
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.order.character_name).toBe('MyExile_One');
    expect((await buyer.api.get(`/v1/orders/${ok.body.order.id}`)).body).toMatchObject({ character_name: 'MyExile_One', handover_field: { key: 'character' } });
    expect((await buyer.api.get('/v1/me')).body.user.handover_names).toEqual({ 'path of exile': 'MyExile_One' });

    // Carts carry a name per item; a key needs none.
    const key = (await seller.api.post('/v1/offers', { categorySlug: 'keys', game: 'Elden Ring', title: 'Key', priceCents: 10_00, deliveryMode: 'manual', stock: 2 })).body;
    const cart = await buyer.api.post('/v1/orders/cart', { items: [{ offerId: offer.id, quantity: 1, characterName: 'MyExile_Two', saveInfo: true }, { offerId: key.id, quantity: 1 }], acceptTos: true });
    expect(cart.status, JSON.stringify(cart.body)).toBe(201);
    expect(cart.body.orders.map((o: any) => o.character_name)).toEqual(['MyExile_Two', null]);
    expect((await buyer.api.get('/v1/me')).body.user.handover_names).toEqual({ 'path of exile': 'MyExile_Two' });
  });

  it('requires a photo or video proof from the seller before an in-game delivery counts', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = (await poeOffer(seller)).body;
    const res = await buyer.api.post('/v1/orders', { offerId: offer.id, acceptTos: true, characterName: 'Proofy' });
    const order = await buyAndPay(h, buyer, offer.id, 1, {}).catch(() => null);
    const id = order?.id ?? res.body.order.id;
    if (!order) await client(h.app).post(`/v1/payments/mock/checkout/${res.body.order.payment_ref}/pay`, {}, { accept: 'application/json' });
    const view = (await buyer.api.get(`/v1/orders/${id}`)).body;
    expect(view.proof_required).toBe(true);

    expect((await seller.api.post(`/v1/orders/${id}/deliver`, { payload: 'traded' })).body.error.code).toBe('proof_required');
    // The buyer's own upload is not the seller's proof.
    const buyersPic = await buyer.api.post(`/v1/chat/rooms/${view.room_id}/attachments`, webm, { 'content-type': 'video/webm', 'x-filename': 'mine.webm' });
    expect(buyersPic.status).toBe(201);
    expect((await seller.api.post(`/v1/orders/${id}/deliver`, { proofAttachmentId: buyersPic.body.id })).body.error.code).toBe('invalid_proof');

    const proof = await seller.api.post(`/v1/chat/rooms/${view.room_id}/attachments`, mp4, { 'content-type': 'video/mp4', 'x-filename': 'trade window.mp4' });
    expect(proof.status, JSON.stringify(proof.body)).toBe(201);
    expect(proof.body).toMatchObject({ mime: 'video/mp4', width: null });
    const delivered = await seller.api.post(`/v1/orders/${id}/deliver`, { payload: 'traded in Lioneye’s Watch', proofAttachmentId: proof.body.id });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    const after = (await buyer.api.get(`/v1/orders/${id}`)).body;
    expect(after.status).toBe('delivered');
    expect(after.delivery_proof).toMatchObject({ id: proof.body.id, mime: 'video/mp4' });
    // The buyer can play the proof; the bytes are what the seller sent.
    const raw = await h.app.inject({ method: 'GET', url: `/v1/chat/attachments/${proof.body.id}`, headers: { authorization: `Bearer ${buyer.token}` } });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toBe('video/mp4');
    expect(raw.rawPayload.equals(mp4)).toBe(true);
    // Unknown bytes are refused whatever the declared type.
    expect((await seller.api.post(`/v1/chat/rooms/${view.room_id}/attachments`, Buffer.from('not a video'), { 'content-type': 'video/mp4', 'x-filename': 'x.mp4' })).body.error.code).toBe('unsupported_file');
  });
});
