import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';

/**
 * Cross-node fan-out for WebSocket events. With REDIS_URL set, every API node
 * publishes to and pattern-subscribes on Redis so a message accepted by node A
 * reaches sockets held by node B. Without Redis (single node / tests) an
 * in-process emitter is used.
 */
export interface PubSub {
  publish(channel: string, payload: unknown): Promise<void>;
  onMessage(handler: (channel: string, payload: any) => void): void;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

const PREFIX = 'mkt:';

export class MemoryPubSub implements PubSub {
  private emitter = new EventEmitter();
  async publish(channel: string, payload: unknown) {
    // Round-trip through JSON so behaviour matches Redis.
    this.emitter.emit('msg', channel, JSON.parse(JSON.stringify(payload)));
  }
  onMessage(handler: (channel: string, payload: any) => void) {
    this.emitter.on('msg', handler);
  }
  async ping() {
    return true;
  }
  async close() {
    this.emitter.removeAllListeners();
  }
}

export class RedisPubSub implements PubSub {
  private pub: Redis;
  private sub: Redis;
  private handlers: Array<(channel: string, payload: any) => void> = [];

  constructor(url: string) {
    // Publishing is best-effort: if Redis is down, fail fast instead of queueing, so API requests
    // never wait on it (callers already treat a failed publish as non-fatal). The subscriber
    // reconnects on its own and re-subscribes.
    this.pub = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2_000 });
    this.sub = new Redis(url);
    let warned = false;
    const onError = (err: Error) => {
      if (!warned) console.error(JSON.stringify({ level: 'warn', msg: 'redis unavailable; realtime fan-out paused', err: err.message }));
      warned = true;
    };
    this.pub.on('error', onError).on('ready', () => (warned = false));
    this.sub.on('error', onError);
    this.sub.psubscribe(`${PREFIX}*`);
    this.sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      const payload = JSON.parse(message);
      for (const h of this.handlers) h(channel.slice(PREFIX.length), payload);
    });
  }
  async publish(channel: string, payload: unknown) {
    await this.pub.publish(PREFIX + channel, JSON.stringify(payload));
  }
  onMessage(handler: (channel: string, payload: any) => void) {
    this.handlers.push(handler);
  }
  async ping() {
    return (await this.pub.ping().catch(() => null)) === 'PONG';
  }
  async close() {
    this.sub.disconnect();
    this.pub.disconnect();
  }
}

export function createPubSub(redisUrl?: string): PubSub {
  return redisUrl ? new RedisPubSub(redisUrl) : new MemoryPubSub();
}
