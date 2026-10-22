import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadPool, createPool, isConnectionError, withTx } from '../src/db.js';
import { checkIntegrity } from '../src/domain/integrity.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

describe('restore verification', () => {
  it('passes on a healthy database and pinpoints tampering', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h, { tier: 1 });
    const offer = await makeOffer(seller, { categorySlug: 'boosting', deliveryMode: 'manual', stock: 2 });
    const order = await buyAndPay(h, buyer, offer.id);
    const room = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id;
    await buyer.api.post(`/v1/chat/rooms/${room}/messages`, { body: 'Hi, when can you start?' });

    const healthy = await checkIntegrity(h.ctx.db);
    expect(healthy.checks.filter((c) => !c.ok)).toEqual([]);
    expect(healthy.ok).toBe(true);
    expect(healthy.summary.orders).toBeGreaterThan(0);

    // Simulate a bad restore: an edited chat message and a lost migration record.
    await h.ctx.db.query('ALTER TABLE chat_messages DISABLE TRIGGER USER');
    await h.ctx.db.query(`UPDATE chat_messages SET body = 'edited' WHERE room_id = $1 AND seq = 2`, [room]);
    await h.ctx.db.query('ALTER TABLE chat_messages ENABLE TRIGGER USER');
    await h.ctx.db.query(`DELETE FROM schema_migrations WHERE name = '015_retention.sql'`);

    const bad = await checkIntegrity(h.ctx.db);
    expect(bad.ok).toBe(false);
    const failed = Object.fromEntries(bad.checks.filter((c) => !c.ok).map((c) => [c.name, c.detail]));
    expect(Object.keys(failed).sort()).toEqual(['chat_hash_chains', 'migrations_applied']);
    expect(failed.migrations_applied).toEqual({ missing: ['015_retention.sql'] });
    expect(JSON.stringify(failed.chat_hash_chains)).toContain(room);
    await h.ctx.db.query(`INSERT INTO schema_migrations (name) VALUES ('015_retention.sql')`);
  });
});

describe('read replica routing', () => {
  it('uses a caught-up replica and falls back to the primary when it lags or is down', async () => {
    const primary = h.ctx.db;
    // A second connection to the same server stands in for a healthy, caught-up replica.
    const replica = createPool(h.ctx.cfg.DATABASE_URL, 2);
    const reads = new ReadPool(primary, replica, 10);
    await reads.check();
    expect(reads.usingReplica).toBe(true);
    expect((await reads.query('SELECT 1 AS x')).rows[0].x).toBe(1);
    await reads.end();

    // Lagging replica: reads go to the primary.
    const lagging = { query: async () => ({ rows: [{ in_recovery: true, lag: 60 }] }), end: async () => {} };
    const slow = new ReadPool(primary, lagging as any, 10);
    await slow.check();
    expect(slow.usingReplica).toBe(false);
    expect(slow.lagSeconds).toBe(60);
    expect((await slow.query('SELECT 2 AS x')).rows[0].x).toBe(2);
    await slow.end();

    // Unreachable replica: still answers, from the primary.
    const down = new ReadPool(primary, createPool('postgres://market:market@127.0.0.1:1/market', 1), 10);
    await down.check();
    expect(down.usingReplica).toBe(false);
    expect((await down.query('SELECT 3 AS x')).rows[0].x).toBe(3);
    await down.end();
  });

  it('reports replica state on /readyz only when one is configured', async () => {
    const res = await client(h.app).get('/readyz');
    expect(res.body.ok).toBe(true);
    expect(res.body.replica).toBeUndefined();
  });
});

describe('database connection loss', () => {
  it('retries a transaction once when its connection dies before commit, and survives the dropped client', async () => {
    let attempts = 0;
    const id = await withTx(h.ctx.db, async (tx) => {
      attempts++;
      const { rows } = await tx.query(`INSERT INTO csp_reports (payload) VALUES ('{"drill":true}') RETURNING id`);
      // First attempt: the server kills this very connection mid-transaction.
      if (attempts === 1) await tx.query('SELECT pg_terminate_backend(pg_backend_pid())');
      return rows[0].id;
    });
    expect(attempts).toBe(2);
    const { rows } = await h.ctx.db.query(`SELECT count(*)::int AS n FROM csp_reports WHERE payload->>'drill' = 'true'`);
    expect(rows[0].n).toBe(1); // the first attempt rolled back; exactly one row committed
    expect(id).toBeTruthy();
    expect((await h.ctx.db.query('SELECT 1 AS ok')).rows[0].ok).toBe(1); // pool still healthy
  });

  it('does not retry ordinary SQL errors', async () => {
    let attempts = 0;
    await expect(
      withTx(h.ctx.db, async (tx) => {
        attempts++;
        await tx.query('SELECT * FROM no_such_table');
      }),
    ).rejects.toThrow(/no_such_table/);
    expect(attempts).toBe(1);
    expect(isConnectionError({ code: '57P01' })).toBe(true);
    expect(isConnectionError({ code: '23505' })).toBe(false);
    expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('stays ready when Redis is down (only the database decides readiness)', async () => {
    const realPing = h.ctx.pubsub.ping.bind(h.ctx.pubsub);
    h.ctx.pubsub.ping = async () => false;
    const res = await client(h.app).get('/readyz');
    h.ctx.pubsub.ping = realPing;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, checks: { database: true, pubsub: false } });
  });
});

