import { Redis } from 'ioredis';

/**
 * "Has this viewer already been counted for this listing in the last hour?" With several API
 * nodes behind a load balancer each node's memory only sees its own traffic, so the same visitor
 * could be counted once per node; Redis (SET NX with a TTL) makes the count exact across nodes.
 * If Redis is unreachable we fall back to this node's memory rather than drop or block the view.
 */
export const VIEW_WINDOW_SECONDS = 3_600;

export interface ViewDeduper {
  /** True the first time `key` is seen in the window (count the view), false after. */
  firstView(key: string): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryViewDeduper implements ViewDeduper {
  private seen = new Map<string, number>(); // key → expiry (ms)
  constructor(private max = 50_000) {}
  async firstView(key: string) {
    const now = Date.now();
    const until = this.seen.get(key);
    if (until && until > now) return false;
    if (this.seen.size >= this.max) {
      for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
      if (this.seen.size >= this.max) this.seen.clear(); // still full: start over (may over-count, never blocks)
    }
    this.seen.set(key, now + VIEW_WINDOW_SECONDS * 1_000);
    return true;
  }
  async close() {}
}

export class RedisViewDeduper implements ViewDeduper {
  private redis: Redis;
  private fallback = new MemoryViewDeduper();
  constructor(urlOrClient: string | Redis) {
    this.redis =
      typeof urlOrClient === 'string'
        ? // Commands wait briefly for a (re)connection, then time out to the memory fallback. Views are
          // recorded off the request path, so the wait never slows a page.
          new Redis(urlOrClient, { maxRetriesPerRequest: 1, connectTimeout: 1_000, commandTimeout: 1_000 })
        : urlOrClient;
    this.redis.on('error', () => {}); // reported via the fallback path, not as unhandled errors
  }
  async firstView(key: string) {
    try {
      return (await this.redis.set(`bz-view:${key}`, '1', 'EX', VIEW_WINDOW_SECONDS, 'NX')) === 'OK';
    } catch {
      return this.fallback.firstView(key);
    }
  }
  async close() {
    this.redis.disconnect();
  }
}

export const createViewDeduper = (redisUrl?: string): ViewDeduper => (redisUrl ? new RedisViewDeduper(redisUrl) : new MemoryViewDeduper());
