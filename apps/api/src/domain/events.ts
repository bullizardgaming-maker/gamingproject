import type { Ctx } from '../context.js';
import type { Tx } from '../db.js';
import { withTx } from '../db.js';

/**
 * Realtime notifications must only be published after the transaction that
 * produced them commits. Domain code queues them on a TxScope; withScope()
 * flushes the queue to pub/sub on successful commit and drops it on rollback.
 */
export class TxScope {
  readonly realtime: Array<{ channel: string; payload: unknown }> = [];
  readonly afterCommit: Array<() => Promise<void>> = [];

  constructor(readonly tx: Tx) {}

  notifyUser(userId: string, event: string, data: unknown) {
    this.realtime.push({ channel: `user:${userId}`, payload: { type: 'notification', event, data } });
  }

  publishRoom(roomId: string, payload: unknown) {
    this.realtime.push({ channel: `room:${roomId}`, payload });
  }

  defer(fn: () => Promise<void>) {
    this.afterCommit.push(fn);
  }
}

export async function withScope<T>(ctx: Ctx, fn: (s: TxScope) => Promise<T>): Promise<T> {
  let scope!: TxScope;
  const result = await withTx(ctx.db, async (tx) => {
    scope = new TxScope(tx);
    return fn(scope);
  });
  for (const m of scope.realtime) {
    await ctx.pubsub.publish(m.channel, m.payload).catch((err) => ctx.log.error({ err }, 'pubsub publish failed'));
  }
  for (const fn of scope.afterCommit) {
    await fn().catch((err) => ctx.log.error({ err }, 'after-commit hook failed'));
  }
  return result;
}
