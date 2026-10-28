import type { Ctx } from './context.js';
import { autoCompleteExpired, cancelUnpaidExpired, handleLateDeliveries } from './domain/orders.js';
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
import { maybeLabelFraudOutcomes } from './domain/fraud.js';
import { dispatchStatusEmails } from './domain/status.js';
import { maybePlanTopUps } from './domain/fxtopups.js';
import { maybeCheckWatches } from './domain/watches.js';
import { autoResolveTickets } from './domain/support.js';
import { expireRequests } from './domain/requests.js';
import { syncSales } from './domain/discounts.js';
import { expireEndedLeagueListings } from './domain/leagues.js';
import { enforceIdDeadlines } from './domain/onboarding.js';
import { sendReferralDigests } from './domain/referrals.js';
import { maybeRefreshTrustLevels } from './domain/trust.js';
import { maybeRepairCounters } from './domain/counters.js';
import { maybeSnapshotMarketPrices } from './domain/priceHistory.js';
import { expireClaims } from './domain/warranty.js';
import { maybeRefreshResponseTimes } from './domain/presence.js';
import { maybeSendRetentionDigest } from './domain/retentionDigest.js';
import { refreshSellerRates } from './domain/commission.js';
import { recheckUnknownPayouts } from './domain/cryptoPayouts.js';
import { sendOpsAlerts } from './domain/opsAlerts.js';
import { syncNewsletter } from './domain/newsletter.js';

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

/** Runs `fn` at most once per `ms` per process (and once across processes through the advisory lock inside the heavier jobs). */
const lastRunAt = new Map<string, number>();
async function every<T>(name: string, ms: number, fn: () => Promise<T>): Promise<T | null> {
  const last = lastRunAt.get(name) ?? 0;
  if (Date.now() - last < ms) return null;
  lastRunAt.set(name, Date.now());
  return fn();
}
const HOUR = 60 * 60_000;

export async function runJobsOnce(ctx: Ctx) {
  const [released, expired, reminders, late] = await Promise.all([
    job(ctx, 'auto_release', () => autoCompleteExpired(ctx), 0), // no longer releases: marks the window as ended (Round 20)
    job(ctx, 'expire_unpaid', () => cancelUnpaidExpired(ctx), 0),
    job(ctx, 'protection_reminders', () => queueProtectionReminders(ctx), 0),
    job(ctx, 'late_deliveries', () => handleLateDeliveries(ctx), { notified: 0, refunded: 0 }),
    job(ctx, 'fx_rates', () => maybeRefreshRates(ctx), 0),
    job(ctx, 'support_auto_resolve', () => autoResolveTickets(ctx), 0),
    job(ctx, 'requests_expire', () => expireRequests(ctx), 0),
    job(ctx, 'sales', () => syncSales(ctx), 0),
    job(ctx, 'trust_levels', () => maybeRefreshTrustLevels(ctx), null),
    job(ctx, 'search_counters', () => maybeRepairCounters(ctx), null),
    job(ctx, 'market_prices', () => maybeSnapshotMarketPrices(ctx), null),
    job(ctx, 'warranty_claims', () => expireClaims(ctx), 0),
    job(ctx, 'response_times', () => maybeRefreshResponseTimes(ctx), null),
  ]);
  const reconciled = await job(ctx, 'reconciliation_scheduler', () => maybeRunScheduledReconciliation(ctx), false);
  await job(ctx, 'retention', () => maybeRunScheduledRetention(ctx), false);
  await job(ctx, 'key_rotation', () => maybeRotateKeys(ctx), null);
  await job(ctx, 'invoices', () => maybeIssueInvoices(ctx), null);
  await job(ctx, 'debt_collection', () => maybeCollectDebts(ctx), null);
  await job(ctx, 'fraud_labels', () => maybeLabelFraudOutcomes(ctx), null);
  await job(ctx, 'fx_topups', () => maybePlanTopUps(ctx), null);
  await job(ctx, 'price_alerts', () => maybeCheckWatches(ctx), null);
  await job(ctx, 'retention_digest', () => maybeSendRetentionDigest(ctx), null);
  await job(ctx, 'seller_rates', () => refreshSellerRates(ctx), null);
  await job(ctx, 'league_expiry', () => expireEndedLeagueListings(ctx), 0);
  // Hourly: ID-deadline reminders, the daily referral digest (dedupe keys keep it to one email per day), payout rechecks.
  await job(ctx, 'id_deadlines', () => every('id_deadlines', HOUR, () => enforceIdDeadlines(ctx)), null);
  await job(ctx, 'referral_digests', () => every('referral_digests', HOUR, () => sendReferralDigests(ctx)), null);
  await job(ctx, 'payouts_unknown', () => every('payouts_unknown', HOUR, () => recheckUnknownPayouts(ctx)), null);
  await job(ctx, 'ops_alerts', () => every('ops_alerts', 15 * 60_000, () => sendOpsAlerts(ctx)), null);
  await job(ctx, 'newsletter_sync', () => every('newsletter_sync', 15 * 60_000, () => syncNewsletter(ctx)), null);
  await job(ctx, 'suspensions', () => every('suspensions', HOUR, () => ctx.db.query(`UPDATE users SET status = 'active', suspended_until = NULL, suspension_reason = NULL WHERE status = 'suspended' AND suspended_until <= now()`).then((r) => r.rowCount ?? 0)), null);
  // Send after the jobs above so emails they queued go out in the same tick.
  const emails = await job(ctx, 'emails', () => dispatchEmails(ctx), 0);
  await job(ctx, 'inbox', () => dispatchInbox(ctx), 0);
  await job(ctx, 'status_emails', () => dispatchStatusEmails(ctx), 0);
  await job(ctx, 'aml', () => maybeRunAml(ctx), null);
  return { released, expired, reminders, late, reconciled, emails };
}

export function startWorker(ctx: Ctx, intervalMs = 2_000) {
  let stopped = false;
  let running = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      const r = await runJobsOnce(ctx);
      if (r.released || r.expired || r.emails) ctx.log.info(r, 'worker tick');
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
