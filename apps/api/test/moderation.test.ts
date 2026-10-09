import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { DEFAULT_TERMS, detectOffPlatform, matchTerms } from '../src/domain/safety.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const sent = async (userId: string, template: string) =>
  (await h.ctx.db.query('SELECT data FROM notifications WHERE user_id = $1 AND template = $2 ORDER BY created_at', [userId, template])).rows.map((r) => r.data);

describe('safety checks', () => {
  it('matches terms on word boundaries and through simple obfuscation', () => {
    const terms = [{ term: 'aimbot', action: 'review' as const }, { term: 'stolen card', action: 'block' as const }, { term: 'hack', action: 'review' as const }];
    expect(matchTerms('Undetected A1MB0T for CS2', terms).map((t) => t.term)).toEqual(['aimbot']);
    expect(matchTerms('Fresh s.t.o.l.e.n card dumps', terms).map((t) => t.action)).toEqual(['block']);
    expect(matchTerms('Shacks and hackney skins', terms)).toEqual([]);
    expect(matchTerms('Hack-proof crosshair pack', terms).map((t) => t.term)).toEqual(['hack']);
    expect(detectOffPlatform('add me on واتساب')).toContain('whatsapp');
    expect(detectOffPlatform('pay me outside the site, cheaper')).toContain('pay_outside');
    expect(detectOffPlatform('friends and family only')).toContain('external_payment');
    expect(detectOffPlatform('Thanks, logged in fine. Changed the password.')).toEqual([]);
  });

  it('seeds the default terms', async () => {
    const rows = (await h.ctx.db.query('SELECT term, action FROM moderation_terms')).rows;
    for (const t of DEFAULT_TERMS) expect(rows).toContainEqual(t);
  });
});

describe('listing review queue', () => {
  it('holds matching listings for review, blocks prohibited goods, and lets staff decide', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const mod = await makeUser(h, { tier: 2, role: 'support' });
    const base = { categorySlug: 'items', game: 'Moderation Game', priceCents: 10_00, deliveryMode: 'manual', stock: 1 };

    const blocked = await seller.api.post('/v1/offers', { ...base, title: 'Carding tutorial + CVV list' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('listing_blocked');

    const clean = await seller.api.post('/v1/offers', { ...base, title: 'Rare skin bundle' });
    expect(clean.body.status).toBe('active');

    const held = await seller.api.post('/v1/offers', { ...base, title: 'Private aimbot, undetected', description: 'DM me on discord for setup' });
    expect(held.status).toBe(201);
    expect(held.body.status).toBe('review');
    expect(held.body.review_reasons).toEqual(['term:aimbot', 'contact:discord']);
    expect(await sent(seller.id, 'listing_review')).toHaveLength(1);
    // Hidden from search, and the seller can't switch it live themselves.
    const search = await client(h.app).get('/v1/offers?game=Moderation%20Game');
    expect(search.body.items.map((o: any) => o.id)).toEqual([clean.body.id]);
    const sneak = await seller.api.patch(`/v1/offers/${held.body.id}`, { version: held.body.version, status: 'active' });
    expect(sneak.body.status).toBe('review');

    // Editing a clean listing into prohibited territory sends it to review too.
    const edited = await seller.api.patch(`/v1/offers/${clean.body.id}`, { version: clean.body.version, description: 'Comes with a wallhack config' });
    expect(edited.body).toMatchObject({ status: 'review', review_reasons: ['term:wallhack'] });

    expect((await seller.api.get('/v1/admin/moderation/listings')).status).toBe(403);
    const queue = await mod.api.get('/v1/admin/moderation/listings');
    expect(queue.body.map((o: any) => o.id)).toEqual(expect.arrayContaining([held.body.id, clean.body.id]));
    expect((await mod.api.get('/v1/admin/moderation/summary')).body.listings).toBeGreaterThanOrEqual(2);

    expect((await mod.api.post(`/v1/admin/moderation/listings/${held.body.id}`, { approve: false })).status).toBe(400); // a reason is required
    expect((await mod.api.post(`/v1/admin/moderation/listings/${held.body.id}`, { approve: false, note: 'Cheats are not allowed.' })).body.status).toBe('removed');
    expect(await sent(seller.id, 'listing_rejected')).toEqual([expect.objectContaining({ note: 'Cheats are not allowed.' })]);
    expect((await mod.api.post(`/v1/admin/moderation/listings/${clean.body.id}`, { approve: true })).body.status).toBe('active');
    expect(await sent(seller.id, 'listing_approved')).toHaveLength(1);
    expect((await mod.api.post(`/v1/admin/moderation/listings/${clean.body.id}`, { approve: true })).status).toBe(409);
    const log = (await h.ctx.db.query(`SELECT action FROM admin_audit_log WHERE target_id = $1 ORDER BY created_at`, [held.body.id])).rows.map((r) => r.action);
    expect(log).toContain('moderation.listing_rejected');
  });

  it('lets staff manage the term list', async () => {
    const mod = await makeUser(h, { tier: 2, role: 'arbiter' });
    const seller = await makeUser(h, { tier: 2 });
    const t = await mod.api.post('/v1/admin/moderation/terms', { term: 'Zorblax', action: 'block' });
    expect(t.status).toBe(201);
    expect((await mod.api.post('/v1/admin/moderation/terms', { term: 'zorblax', action: 'review' })).status).toBe(409);
    expect((await seller.api.post('/v1/offers', { categorySlug: 'keys', game: 'G', title: 'Genuine zorblax key', priceCents: 1_00, deliveryMode: 'auto' })).status).toBe(400);
    expect((await mod.api.del(`/v1/admin/moderation/terms/${t.body.id}`)).status).toBe(204);
    expect((await seller.api.post('/v1/offers', { categorySlug: 'keys', game: 'G', title: 'Genuine zorblax key', priceCents: 1_00, deliveryMode: 'auto' })).body.status).toBe('active');
  });
});

describe('flagged chats', () => {
  it('queues off-platform attempts for staff and refunds a strike on dismissal', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const mod = await makeUser(h, { tier: 2, role: 'support' });
    const offer = await makeOffer(seller, { deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, buyer, offer.id);
    const { room_id } = (await buyer.api.get(`/v1/orders/${order.id}`)).body;

    await buyer.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'Is it the EU version?' });
    await seller.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'Yes. Pay me with friends and family next time, cheaper' });
    await buyer.api.post(`/v1/chat/rooms/${room_id}/messages`, { body: 'my whatsapp is +44 7700 900123' });

    const queue = (await mod.api.get('/v1/admin/moderation/chats')).body.filter((f: any) => f.room_id === room_id);
    expect(queue.map((f: any) => [f.role, f.reasons])).toEqual([
      ['seller', ['external_payment']],
      ['buyer', ['whatsapp', 'phone_number']],
    ]);
    expect(queue[0].order_id).toBe(order.id);
    expect(queue[0].context.map((m: any) => m.body)).toContain('Is it the EU version?');

    const strikes = async (id: string) => (await h.ctx.db.query('SELECT offplatform_strikes FROM users WHERE id = $1', [id])).rows[0].offplatform_strikes;
    expect(await strikes(buyer.id)).toBe(1);
    expect((await mod.api.post(`/v1/admin/moderation/chats/${queue[1].id}`, { confirm: false, note: 'Shared for delivery coordination' })).body.status).toBe('dismissed');
    expect(await strikes(buyer.id)).toBe(0);
    expect((await mod.api.post(`/v1/admin/moderation/chats/${queue[0].id}`, { confirm: true })).body.status).toBe('confirmed');
    expect((await mod.api.post(`/v1/admin/moderation/chats/${queue[0].id}`, { confirm: true })).status).toBe(404);
    const confirmed = (await mod.api.get('/v1/admin/moderation/chats?status=confirmed')).body.find((f: any) => f.id === queue[0].id);
    expect(confirmed).toBeTruthy();
  });

  it('keeps contact details out of buyer requests and proposals', async () => {
    const buyer = await makeUser(h);
    const r = await buyer.api.post('/v1/requests', { game: 'G', categorySlug: 'keys', title: 'Need a key, telegram me' });
    expect(r.body.error.code).toBe('offplatform_contact');
  });
});
