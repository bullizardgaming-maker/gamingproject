import type { Ctx } from './context.js';
import { autoCompleteExpired, cancelUnpaidExpired } from './domain/orders.js';
import { dispatchDueWebhooks } from './domain/webhooks.js';
import { dispatchEmails, queueProtectionReminders } from './domain/notifications.js';

/**
 * Background jobs. Every job is safe to run on several worker processes at
 * once: rows are claimed with row locks / SKIP LOCKED and state transitions are
 * guarded by the expected current status.
 */
export async function runJobsOnce(ctx: Ctx) {
  const [released, expired, webhooks, reminders] = await Promise.all([
    autoCompleteExpired(ctx),
    cancelUnpaidExpired(ctx),
    dispatchDueWebhooks(ctx),
    queueProtectionReminders(ctx),
  ]);
  // Send after the jobs above so emails they queued go out in the same tick.
  const emails = await dispatchEmails(ctx);
  return { released, expired, webhooks, reminders, emails };
}

export function startWorker(ctx: Ctx, intervalMs = 2_000) {
  let stopped = false;
  let running = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      const r = await runJobsOnce(ctx);
      if (r.released || r.expired || r.webhooks || r.emails) ctx.log.info(r, 'worker tick');
    } catch (err) {
      ctx.log.error({ err: (err as Error).message }, 'worker tick failed');
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Standalone entrypoint: `node dist/worker.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('./config.js');
  const { createContext } = await import('./context.js');
  const cfg = loadConfig();
  const log = { info: console.log, warn: console.warn, error: console.error };
  const ctx = createContext(cfg, log);
  startWorker(ctx);
  log.info('worker started');
}
