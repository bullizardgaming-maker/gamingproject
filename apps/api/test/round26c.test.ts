import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enforceIdDeadlines } from '../src/domain/onboarding.js';
import { makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const delivery = { acceptTos: true, deliveryMethod: 'f2f', deliveryInfo: { character: 'Buyer1' } };

describe('Round 26c — hardening', () => {
  it('H1: a listing-banned seller cannot resume listings staff paused (resume route and PATCH); buyers cannot order them', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const support = await makeUser(h, { role: 'support' });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { stock: 3, deliveryMode: 'manual' });
    expect((await support.api.post(`/v1/admin/users/${seller.id}/listing-ban`, { on: true, reason: 'Repeated misdescribed items' })).status).toBe(200);
    const mine = (await seller.api.get('/v1/seller/offers')).body.find((o: any) => o.id === offer.id);
    expect(mine).toMatchObject({ status: 'paused', expired_reason: 'listing_ban', open_orders: 0 });
    const resume = await seller.api.post(`/v1/offers/${offer.id}/resume`, {});
    expect(resume.status).toBe(403);
    expect(resume.body.error.code).toBe('listing_banned');
    const patch = await seller.api.patch(`/v1/offers/${offer.id}`, { version: mine.version, status: 'active' });
    expect(patch.status).toBe(403);
    expect((await h.ctx.db.query('SELECT status FROM offers WHERE id = $1', [offer.id])).rows[0].status).toBe('paused');
    expect((await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery })).status).toBe(404);
    // Even with the seller flags cleared by hand, a staff pause is not the seller's to undo.
    await h.ctx.db.query('UPDATE users SET listing_banned_at = NULL WHERE id = $1', [seller.id]);
    expect((await seller.api.post(`/v1/offers/${offer.id}/resume`, {})).body.error.code).toBe('paused_by_staff');
    expect((await seller.api.patch(`/v1/offers/${offer.id}`, { version: mine.version, status: 'active' })).body.error.code).toBe('paused_by_staff');
    // Lifting the ban brings it back; the seller's own pause/resume then works as before.
    await h.ctx.db.query('UPDATE users SET listing_banned_at = now() WHERE id = $1', [seller.id]);
    expect((await support.api.post(`/v1/admin/users/${seller.id}/listing-ban`, { on: false, reason: 'Appeal accepted' })).status).toBe(200);
    expect((await seller.api.get(`/v1/offers/${offer.id}`)).body.status).toBe('active');
    expect((await seller.api.post(`/v1/offers/${offer.id}/pause`, {})).body.status).toBe('paused');
    expect((await seller.api.post(`/v1/offers/${offer.id}/resume`, {})).body.status).toBe('active');
  });

  it('H1: a seller past the ID deadline cannot resume the listings the system paused, on either route', async () => {
    const seller = await makeUser(h, { tier: 1, rulesPassed: true });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { stock: 3, deliveryMode: 'manual' });
    await h.ctx.db.query(`UPDATE users SET seller_since = now() - interval '31 days' WHERE id = $1`, [seller.id]);
    await enforceIdDeadlines(h.ctx);
    const row = (await h.ctx.db.query('SELECT status, expired_reason, version FROM offers WHERE id = $1', [offer.id])).rows[0];
    expect(row).toMatchObject({ status: 'paused', expired_reason: 'id_overdue' });
    expect((await seller.api.post(`/v1/offers/${offer.id}/resume`, {})).status).toBe(403);
    expect((await seller.api.patch(`/v1/offers/${offer.id}`, { version: row.version, status: 'active' })).status).toBe(403);
    expect((await h.ctx.db.query('SELECT status FROM offers WHERE id = $1', [offer.id])).rows[0].status).toBe('paused');
    expect((await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery })).status).toBe(404);
    // Other edits (a price change) are still allowed while paused.
    expect((await seller.api.patch(`/v1/offers/${offer.id}`, { version: row.version, priceCents: 7_00 })).status).toBe(200);
  });

  it('L1/L2: a paused listing sells no stock; deleting through PATCH refuses while an order is open and counts it', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { stock: 5, deliveryMode: 'manual' });
    const order = await buyer.api.post('/v1/orders', { offerId: offer.id, quantity: 1, ...delivery });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const mine = (await seller.api.get('/v1/seller/offers')).body.find((o: any) => o.id === offer.id);
    expect(mine.open_orders).toBe(1);
    const del = await seller.api.patch(`/v1/offers/${offer.id}`, { version: mine.version, status: 'removed' });
    expect(del.status).toBe(409);
    expect(del.body.error).toMatchObject({ code: 'has_open_orders', details: { openOrders: 1 } });
    // L1: a listing paused between the quote and the reservation sells nothing.
    await h.ctx.db.query(`UPDATE offers SET status = 'paused' WHERE id = $1`, [offer.id]);
    const { reserveManualStock } = await import('../src/domain/inventory.js');
    const { withTx } = await import('../src/db.js');
    await expect(withTx(h.ctx.db, (tx) => reserveManualStock(tx, offer.id, 1))).rejects.toMatchObject({ code: 'not_found' });
    expect(Number((await h.ctx.db.query('SELECT stock FROM offers WHERE id = $1', [offer.id])).rows[0].stock)).toBe(4);
  });

  it('L4: the crypto payment re-check is limited to 10 a minute per staff member', async () => {
    const finance = await makeUser(h, { role: 'finance' });
    const other = await makeUser(h, { role: 'finance' });
    const id = '00000000-0000-4000-8000-000000000000';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await finance.api.post(`/v1/admin/crypto/payments/${id}/recheck`)).status);
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await other.api.post(`/v1/admin/crypto/payments/${id}/recheck`)).status).not.toBe(429);
  });
});
