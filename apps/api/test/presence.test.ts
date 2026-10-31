import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';
import { withTx } from '../src/db.js';
import { computeResponseTime, refreshResponseTimes } from '../src/domain/presence.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

/** Chat is append-only; tests backdate messages with triggers off for one transaction. */
const backdate = (sql: string, params: unknown[]) =>
  withTx(h.ctx.db, async (tx) => {
    await tx.query('SET LOCAL session_replication_role = replica');
    await tx.query(sql, params);
  });

const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 50 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('seller presence and response time', () => {
  it('shows a seller as online after signed-in activity, unless they hide it', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller);
    await seller.api.get('/v1/me');
    await until(async () => !!(await h.ctx.db.query('SELECT last_seen_at FROM users WHERE id = $1', [seller.id])).rows[0].last_seen_at);

    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.seller_online).toBe(true);
    expect((await client(h.app).get(`/v1/sellers/${seller.id}`)).body.online).toBe(true);

    expect((await seller.api.put('/v1/seller/presence', { showOnline: false })).body).toEqual({ showOnline: false });
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.seller_online).toBe(false);
    expect((await client(h.app).get(`/v1/sellers/${seller.id}`)).body.last_seen_at).toBeNull();
    await seller.api.put('/v1/seller/presence', { showOnline: true });

    await h.ctx.db.query(`UPDATE users SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`, [seller.id]);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.seller_online).toBe(false);
    expect((await seller.api.get('/v1/seller/dashboard')).body.shop.showOnline).toBe(true);
  });

  it('takes the median first-reply time, counting long silences as a day', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller);
    const waits = [10, 20, 30, 45];
    for (const minutes of waits) {
      const buyer = await makeUser(h);
      const room = (await buyer.api.post('/v1/chat/rooms', { offerId: offer.id })).body;
      await buyer.api.post(`/v1/chat/rooms/${room.id}/messages`, { body: 'Is this still available?' });
      await buyer.api.post(`/v1/chat/rooms/${room.id}/messages`, { body: 'Hello?' }); // a follow-up doesn't restart the clock
      await seller.api.post(`/v1/chat/rooms/${room.id}/messages`, { body: 'Yes it is' });
      // Backdate: the buyer asked `minutes` before the reply.
      await backdate(
        `UPDATE chat_messages SET created_at = now() - interval '1 day' - make_interval(mins => $2) + make_interval(secs => seq)
          WHERE room_id = $1 AND sender_id <> $3`,
        [room.id, minutes, seller.id],
      );
      await backdate(`UPDATE chat_messages SET created_at = now() - interval '1 day' WHERE room_id = $1 AND sender_id = $2`, [room.id, seller.id]);
    }
    // One question never answered, asked two days ago: counts as 24 hours.
    const silent = await makeUser(h);
    const room = (await silent.api.post('/v1/chat/rooms', { offerId: offer.id })).body;
    await silent.api.post(`/v1/chat/rooms/${room.id}/messages`, { body: 'Hi?' });
    await backdate(`UPDATE chat_messages SET created_at = now() - interval '2 days' WHERE room_id = $1`, [room.id]);

    const r = await computeResponseTime(h.ctx.db, seller.id);
    expect(r.sample).toBe(5);
    expect(r.minutes).toBe(30); // median of 10, 20, 30, 45, 1440

    await refreshResponseTimes(h.ctx);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.seller_response_minutes).toBe(30);
    expect((await client(h.app).get(`/v1/sellers/${seller.id}`)).body.response_minutes).toBe(30);
  });

  it('shows no figure until there are enough answered questions', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller);
    const buyer = await makeUser(h);
    const room = (await buyer.api.post('/v1/chat/rooms', { offerId: offer.id })).body;
    await buyer.api.post(`/v1/chat/rooms/${room.id}/messages`, { body: 'Hi' });
    await seller.api.post(`/v1/chat/rooms/${room.id}/messages`, { body: 'Hello' });
    await refreshResponseTimes(h.ctx);
    expect((await client(h.app).get(`/v1/offers/${offer.id}`)).body.seller_response_minutes).toBeNull();
  });
});
