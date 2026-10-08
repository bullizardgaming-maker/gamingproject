import type { Ctx } from './context.js';
import { autoCompleteExpired, cancelUnpaidExpired, handleLateDeliveries } from './domain/orders.js';
import { dispatchDueWebhooks } from './domain/webhooks.js';
import { dispatchEmails, queueProtectionReminders } from './domain/notifications.js';
import { maybeRunScheduledReconciliation } from './domain/reconciliation.js';
import { heartbeat } from './observability.js';
import { maybeRefreshRates } from './domain/fx.js';
import { maybeRunScheduledRetention } from './domain/retention.js';
import { maybeRotateKeys } from './domain/keyrotation.js';
import { maybeIssueInvoices } from './domain/invoices.js';
import { dispatchInbox } from './domain/inbox.js';
import { maybeRunAml } from './domain/aml.js';
import { maybeCollectDebts } from './domain/debts.js';

/**
 * Background jobs. Every job is safe to run on several worker processes at
 * once: rows are claimed with row locks / SKIP LOCKED and state transitions are
 * guarded by the expected current status.
 */
/** Runs a job, records its heartbeat (or error) so monitoring can alert on stalled jobs. */
async function job<T>(ctx: Ctx, name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    const r = await fn();
    await heartbeat(ctx, name).catch(() => {});
    return r;
  } catch (err) {
    ctx.log.error({ err, job: name }, 'background job failed');
    await heartbeat(ctx, name, err).catch(() => {});
    return fallback;
  }
}

export async function runJobsOnce(ctx: Ctx) {
  const [released, expired, webhooks, reminders, late] = await Promise.all([
    job(ctx, 'auto_release', () => autoCompleteExpired(ctx), 0),
    job(ctx, 'expire_unpaid', () => cancelUnpaidExpired(ctx), 0),
    job(ctx, 'webhooks', () => dispatchDueWebhooks(ctx), 0),
    job(ctx, 'protection_reminders', () => queueProtectionReminders(ctx), 0),
    job(ctx, 'late_deliveries', () => handleLateDeliveries(ctx), { notified: 0, refunded: 0 }),
    job(ctx, 'fx_rates', () => maybeRefreshRates(ctx), 0),
  ]);
  const reconciled = await job(ctx, 'reconciliation_scheduler', () => maybeRunScheduledReconciliation(ctx), false);
  await job(ctx, 'retention', () => maybeRunScheduledRetention(ctx), false);
  await job(ctx, 'key_rotation', () => maybeRotateKeys(ctx), null);
  await job(ctx, 'invoices', () => maybeIssueInvoices(ctx), null);
  await job(ctx, 'debt_collection', () => maybeCollectDebts(ctx), null);
  // Send after the jobs above so emails they queued go out in the same tick.
  const emails = await job(ctx, 'emails', () => dispatchEmails(ctx), 0);
  await job(ctx, 'inbox', () => dispatchInbox(ctx), 0);
  await job(ctx, 'aml', () => maybeRunAml(ctx), null);
  return { released, expired, webhooks, reminders, late, reconciled, emails };
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
  const { asCtxLogger, createLogger, initSentry } = await import('./observability.js');
  const cfg = loadConfig();
  initSentry(cfg);
  const log = asCtxLogger(createLogger(cfg).child({ component: 'worker' }));
  const ctx = createContext(cfg, log);
  startWorker(ctx);
  log.info({}, 'worker started');
}
