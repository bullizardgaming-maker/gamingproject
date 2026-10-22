import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { runJobsOnce } from '../src/worker.js';
import { expireClaims } from '../src/domain/warranty.js';
import { withdrawable } from '../src/domain/payoutholds.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

/** An account sale with a warranty, delivered and released (escrow's 14 days fast-forwarded). */
async function soldAccount(warrantyDays = 30) {
  const seller = await makeUser(h, { tier: 2 });
  const buyer = await makeUser(h, { tier: 1 });
  const res = await seller.api.post('/v1/offers', { categorySlug: 'accounts', game: 'Test Game', title: 'Main account', priceCents: 100_00, deliveryMode: 'manual', warrantyDays });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = await buyAndPay(h, buyer, res.body.id);
  await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'login:pass' });
  await h.ctx.db.query(`UPDATE orders SET protection_ends_at = now() - interval '1 minute' WHERE id = $1`, [order.id]);
  await runJobsOnce(h.ctx);
  return { seller, buyer, offer: res.body, order: (await buyer.api.get(`/v1/orders/${order.id}`)).body };
}

describe('account warranty', () => {
  it('is offered on account listings only and starts when escrow releases', async () => {
    const seller = await makeUser(h, { tier: 2 });
    expect((await seller.api.post('/v1/offers', { categorySlug: 'keys', game: 'Test Game', title: 'A key', priceCents: 5_00, deliveryMode: 'auto', warrantyDays: 30 })).status).toBe(400);
    expect((await seller.api.post('/v1/offers', { categorySlug: 'accounts', game: 'Test Game', title: 'Bad term', priceCents: 5_00, deliveryMode: 'manual', warrantyDays: 45 })).status).toBe(400);

    const { offer, order, seller: s } = await soldAccount(30);
    expect(offer.warranty_days).toBe(30);
    expect(order.status).toBe('completed');
    const days = (new Date(order.warranty_ends_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    // While it runs, the order's payout is held even for a seller with no payout hold.
    await h.ctx.db.query('UPDATE users SET payout_hold_days = 0 WHERE id = $1', [s.id]);
    const w = await withdrawable(h.ctx, h.ctx.db, s.id);
    expect(w.heldCents).toBe(order.seller_net_cents);
    expect(w.withdrawableCents).toBe(0);
    await h.ctx.db.query(`UPDATE orders SET warranty_ends_at = now() - interval '1 minute' WHERE id = $1`, [order.id]);
    expect((await withdrawable(h.ctx, h.ctx.db, s.id)).heldCents).toBe(0);
  });

  it('runs a claim: seller says fixed, buyer disagrees, an arbiter refunds from the held payout', async () => {
    const { seller, buyer, order } = await soldAccount();
    const arbiter = await makeUser(h, { tier: 2, role: 'arbiter' });
    expect((await seller.api.post(`/v1/orders/${order.id}/warranty-claims`, { reason: 'recovered', details: 'not the buyer here' })).status).toBe(403);
    const c = await buyer.api.post(`/v1/orders/${order.id}/warranty-claims`, { reason: 'recovered', details: 'The original owner reset the email yesterday.' });
    expect(c.status).toBe(201);
    expect((await buyer.api.post(`/v1/orders/${order.id}/warranty-claims`, { reason: 'banned', details: 'And now it is banned too.' })).status).toBe(409);

    // Payout stays held while the claim is open, even past the warranty's end.
    await h.ctx.db.query('UPDATE users SET payout_hold_days = 0 WHERE id = $1', [seller.id]);
    await h.ctx.db.query(`UPDATE orders SET warranty_ends_at = now() - interval '1 minute' WHERE id = $1`, [order.id]);
    const held = await withdrawable(h.ctx, h.ctx.db, seller.id);
    expect(held.heldCents).toBe(order.seller_net_cents);
    expect(held.upcoming[0]!.unlocksAt).toBeNull();

    expect((await buyer.api.post(`/v1/warranty-claims/${c.body.id}/seller`, { action: 'fixed' })).status).toBe(403);
    const fixed = await seller.api.post(`/v1/warranty-claims/${c.body.id}/seller`, { action: 'fixed', message: 'Secured it again, new email sent.' });
    expect(fixed.body.status).toBe('seller_fixed');
    expect((await buyer.api.post(`/v1/warranty-claims/${c.body.id}/buyer`, { action: 'escalate' })).body.status).toBe('escalated');

    const queue = (await arbiter.api.get('/v1/admin/warranty-claims')).body;
    expect(queue.find((x: any) => x.id === c.body.id)).toMatchObject({ reason: 'recovered', buyer_name: expect.any(String) });
    expect((await buyer.api.post(`/v1/admin/warranty-claims/${c.body.id}/decide`, { outcome: 'refund', note: 'Recovered again' })).status).toBe(403);
    const d = await arbiter.api.post(`/v1/admin/warranty-claims/${c.body.id}/decide`, { outcome: 'refund', note: 'Chat shows the original owner recovered it' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.status).toBe('refunded');

    const after = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(after.warranty_claims[0]).toMatchObject({ status: 'refunded', decision_note: 'Chat shows the original owner recovered it' });
    const refunded = await h.ctx.db.query('SELECT paid_by, amount_cents FROM post_release_refunds WHERE order_id = $1', [order.id]);
    expect(refunded.rows[0]).toMatchObject({ paid_by: 'seller', amount_cents: 100_00 });
    // The chat records every step.
    const msgs = (await buyer.api.get(`/v1/chat/rooms/${after.room_id}/messages`)).body;
    const text = JSON.stringify(msgs);
    expect(text).toContain('Warranty claim: the buyer says the account was taken back');
    expect(text).toContain('An arbiter will decide');
  });

  it('lets the seller refund straight away, and handles silence on both sides', async () => {
    const a = await soldAccount();
    const c1 = (await a.buyer.api.post(`/v1/orders/${a.order.id}/warranty-claims`, { reason: 'banned', details: 'Banned for an old cheat flag.' })).body;
    const r = await a.seller.api.post(`/v1/warranty-claims/${c1.id}/seller`, { action: 'refund' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('refunded');

    // Seller silent for 48 hours → arbiter.
    const b = await soldAccount();
    const c2 = (await b.buyer.api.post(`/v1/orders/${b.order.id}/warranty-claims`, { reason: 'locked', details: 'Locked after a login check.' })).body;
    await h.ctx.db.query(`UPDATE warranty_claims SET respond_by = now() - interval '1 minute' WHERE id = $1`, [c2.id]);
    await expireClaims(h.ctx);
    expect((await b.buyer.api.get(`/v1/orders/${b.order.id}`)).body.warranty_claims[0].status).toBe('escalated');

    // Buyer silent for 72 hours after a fix → resolved. Then they can withdraw nothing more.
    const c = await soldAccount();
    const c3 = (await c.buyer.api.post(`/v1/orders/${c.order.id}/warranty-claims`, { reason: 'other', details: 'Can’t sign in at all.' })).body;
    await c.seller.api.post(`/v1/warranty-claims/${c3.id}/seller`, { action: 'fixed' });
    await h.ctx.db.query(`UPDATE warranty_claims SET confirm_by = now() - interval '1 minute' WHERE id = $1`, [c3.id]);
    await expireClaims(h.ctx);
    expect((await c.buyer.api.get(`/v1/orders/${c.order.id}`)).body.warranty_claims[0].status).toBe('resolved');
    expect((await c.buyer.api.post(`/v1/warranty-claims/${c3.id}/buyer`, { action: 'withdraw' })).status).toBe(409);

    // No claims once the warranty has ended.
    await h.ctx.db.query(`UPDATE orders SET warranty_ends_at = now() - interval '1 minute' WHERE id = $1`, [c.order.id]);
    expect((await c.buyer.api.post(`/v1/orders/${c.order.id}/warranty-claims`, { reason: 'other', details: 'Broken again, sorry.' })).body.error.code).toBe('warranty_expired');
  });
});
