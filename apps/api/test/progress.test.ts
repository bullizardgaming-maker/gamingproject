import sharp from 'sharp';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyAndPay, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup({ STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'bz-progress-')) });
});
afterAll(async () => h.close());

const png = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#22aa55' } }).png().toBuffer();

describe('boosting progress milestones', () => {
  it('the seller posts milestones with a screenshot; the buyer sees them and is notified', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 2, title: 'Gold → Platinum' });
    const order = await buyAndPay(h, buyer, offer.id);
    const roomId = (await seller.api.get(`/v1/orders/${order.id}`)).body.room_id;

    // Only the seller posts, and percent never goes backwards.
    expect((await buyer.api.post(`/v1/orders/${order.id}/progress`, { percent: 10 })).body.error.code).toBe('not_seller');
    expect((await seller.api.post(`/v1/orders/${order.id}/progress`, { percent: 25, note: 'Gold II, 6 wins in a row' })).status).toBe(201);
    expect((await seller.api.post(`/v1/orders/${order.id}/progress`, { percent: 20 })).body.error.code).toBe('progress_backwards');

    // A screenshot must be one the seller uploaded to this order's chat.
    const shot = await seller.api.post(`/v1/chat/rooms/${roomId}/attachments`, await png(), { 'content-type': 'image/png', 'x-filename': 'rank.png' });
    expect(shot.status).toBe(201);
    const fromBuyer = await buyer.api.post(`/v1/chat/rooms/${roomId}/attachments`, await png(), { 'content-type': 'image/png', 'x-filename': 'x.png' });
    expect((await seller.api.post(`/v1/orders/${order.id}/progress`, { percent: 60, attachmentId: fromBuyer.body.id })).body.error.code).toBe('invalid_attachment');
    expect((await seller.api.post(`/v1/orders/${order.id}/progress`, { percent: 60, note: 'Platinum IV reached', attachmentId: shot.body.id })).status).toBe(201);

    const view = (await buyer.api.get(`/v1/orders/${order.id}`)).body;
    expect(view.progress.map((p: any) => p.percent)).toEqual([25, 60]);
    expect(view.progress[1]).toMatchObject({ note: 'Platinum IV reached', attachment_id: shot.body.id, width: 40 });
    const msgs = (await buyer.api.get(`/v1/chat/rooms/${roomId}/messages`)).body;
    expect(msgs.map((m: any) => m.body)).toContain('Progress: 60% · Platinum IV reached (screenshot attached)');
    const inbox = (await buyer.api.get('/v1/me/notifications')).body.items;
    expect(inbox.filter((i: any) => i.template === 'order_progress')).toHaveLength(2);

    // Delivered: no more updates.
    await seller.api.post(`/v1/orders/${order.id}/deliver`, { payload: 'Done, Platinum IV' });
    expect((await seller.api.post(`/v1/orders/${order.id}/progress`, { percent: 100 })).body.error.code).toBe('invalid_state');
  });

  it('is only for boosting orders', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 5 });
    const order = await buyAndPay(h, buyer, offer.id);
    expect((await seller.api.post(`/v1/orders/${order.id}/progress`, { percent: 50 })).body.error.code).toBe('not_boosting');
    expect((await buyer.api.get(`/v1/orders/${order.id}`)).body.progress).toEqual([]);
  });
});
