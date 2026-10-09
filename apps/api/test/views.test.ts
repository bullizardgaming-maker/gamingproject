import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordView } from '../src/domain/analytics.js';
import { MemoryViewDeduper, RedisViewDeduper } from '../src/lib/viewDedupe.js';
import { client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
async function redisAvailable() {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const hasRedis = await redisAvailable();

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const viewsOf = async (offerId: string) => Number((await h.ctx.db.query('SELECT COALESCE(sum(views), 0) AS n FROM offer_views WHERE offer_id = $1', [offerId])).rows[0].n);

describe('listing view counting', () => {
  it('counts each viewer once per listing per hour, never the seller', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller);
    const ctx = { db: h.ctx.db, views: new MemoryViewDeduper() };
    expect(await recordView(ctx, offer.id, seller.id, { userId: seller.id, ip: '1.1.1.1' })).toBe(false);
    expect(await recordView(ctx, offer.id, seller.id, { userId: buyer.id, ip: '2.2.2.2' })).toBe(true);
    expect(await recordView(ctx, offer.id, seller.id, { userId: buyer.id, ip: '3.3.3.3' })).toBe(false); // same account, new network
    expect(await recordView(ctx, offer.id, seller.id, { ip: '2.2.2.2' })).toBe(true); // signed out is a different visitor
    expect(await viewsOf(offer.id)).toBe(2);

    // Through the API too.
    await client(h.app).get(`/v1/offers/${offer.id}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(await viewsOf(offer.id)).toBe(3);
  });

  it('forgets a viewer after the window and stays bounded', async () => {
    const d = new MemoryViewDeduper(3);
    expect(await d.firstView('a')).toBe(true);
    expect(await d.firstView('a')).toBe(false);
    for (const k of ['b', 'c', 'd', 'e']) expect(await d.firstView(k)).toBe(true);
  });

  it('falls back to memory when Redis is unreachable', async () => {
    const d = new RedisViewDeduper(new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null }));
    expect(await d.firstView('x')).toBe(true);
    expect(await d.firstView('x')).toBe(false);
    await d.close();
  });

  it.skipIf(!hasRedis)('is exact across API nodes sharing Redis', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const offer = await makeOffer(seller);
    const nodeA = { db: h.ctx.db, views: new RedisViewDeduper(REDIS_URL) };
    const nodeB = { db: h.ctx.db, views: new RedisViewDeduper(REDIS_URL) };
    const results = await Promise.all([
      recordView(nodeA, offer.id, seller.id, { ip: '9.9.9.9' }),
      recordView(nodeB, offer.id, seller.id, { ip: '9.9.9.9' }),
      recordView(nodeA, offer.id, seller.id, { ip: '9.9.9.9' }),
      recordView(nodeB, offer.id, seller.id, { ip: '8.8.8.8' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await viewsOf(offer.id)).toBe(2);
    const r = new Redis(REDIS_URL);
    expect(await r.ttl(`bz-view:ip:9.9.9.9:${offer.id}`)).toBeGreaterThan(3_500);
    r.disconnect();
    await nodeA.views.close();
    await nodeB.views.close();
  });
});
