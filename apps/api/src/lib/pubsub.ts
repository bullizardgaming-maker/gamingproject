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
  async close() {
    this.emitter.removeAllListeners();
  }
}

export class RedisPubSub implements PubSub {
  private pub: Redis;
  private sub: Redis;
  private handlers: Array<(channel: string, payload: any) => void> = [];

  constructor(url: string) {
    this.pub = new Redis(url);
    this.sub = new Redis(url);
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
  async close() {
    this.sub.disconnect();
    this.pub.disconnect();
  }
}

export function createPubSub(redisUrl?: string): PubSub {
  return redisUrl ? new RedisPubSub(redisUrl) : new MemoryPubSub();
}
