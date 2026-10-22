import type { Ctx } from '../context.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { accountId, balance } from './ledger.js';
import { enqueueEmail } from './notifications.js';

/**
 * Daily money reconciliation.
 *
 * Hard checks (any failure => status "mismatch" and an alert to every admin):
 *  - every ledger transaction sums to zero
 *  - each fiat order's escrow holding matches its state (full amount while
 *    paid/delivered/disputed, zero otherwise)
 *  - the balance the PSP reports equals what our ledger says it should hold:
 *    captured - refunds - PSP fees - chargebacks - seller payouts
 *
 * Warnings (reported, not alerted): negative seller balances, withdrawals stuck
 * in "pending", paid auto-delivery orders not delivered after an hour (and not
 * under review), dead webhooks and failed emails in the last 24h.
 */
export interface ReconReport {
  currency: string;
  issues: Array<{ check: string; detail: unknown }>;
  warnings: Array<{ check: string; detail: unknown }>;
  totals: Record<string, number>;
  psp: { expected: number; actual: number | null; difference: number | null };
}

export async function runReconciliation(ctx: Ctx, currency = 'USD', existingRunId?: string): Promise<{ id: string; status: string; report: ReconReport }> {
  const run = existingRunId
    ? { id: existingRunId }
    : await one<{ id: string }>(ctx.db, `INSERT INTO reconciliation_runs (status) VALUES ('running') RETURNING id`);
  try {
    const report = await buildReport(ctx, currency);
    const status = report.issues.length ? 'mismatch' : 'ok';
    await ctx.db.query(`UPDATE reconciliation_runs SET status = $2, report = $3, finished_at = now() WHERE id = $1`, [run.id, status, JSON.stringify(report)]);
    if (status !== 'ok') await alertAdmins(ctx, run.id, status, report);
    return { id: run.id, status, report };
  } catch (err) {
    const report = { error: (err as Error).message };
    await ctx.db.query(`UPDATE reconciliation_runs SET status = 'error', report = $2, finished_at = now() WHERE id = $1`, [run.id, JSON.stringify(report)]);
    await alertAdmins(ctx, run.id, 'error', { issues: [{ check: 'run_failed', detail: report.error }] } as any);
    throw err;
  }
}

async function buildReport(ctx: Ctx, currency: string): Promise<ReconReport> {
  const issues: ReconReport['issues'] = [];
  const warnings: ReconReport['warnings'] = [];

  const unbalanced = await many(ctx.db, `SELECT txn_id, SUM(amount_cents)::bigint AS sum FROM ledger_entries GROUP BY txn_id HAVING SUM(amount_cents) <> 0 LIMIT 50`);
  if (unbalanced.length) issues.push({ check: 'unbalanced_transactions', detail: unbalanced });

  const escrow = await accountId(ctx.db, 'escrow', currency);
  const escrowMismatch = await many(
    ctx.db,
    `SELECT o.id, o.status, o.amount_cents, COALESCE(e.held, 0)::bigint AS held
       FROM orders o
       LEFT JOIN (SELECT order_id, SUM(amount_cents) AS held FROM ledger_entries WHERE account_id = $1 GROUP BY order_id) e ON e.order_id = o.id
      WHERE o.rail = 'fiat' AND o.currency = $2
        AND COALESCE(e.held, 0) <> CASE WHEN o.status IN ('paid', 'delivered', 'disputed') THEN o.amount_cents ELSE 0 END
      LIMIT 50`,
    [escrow, currency],
  );
  if (escrowMismatch.length) issues.push({ check: 'order_escrow_mismatch', detail: escrowMismatch });

  const totals: Record<string, number> = {};
  for (const kind of ['gateway_clearing', 'escrow', 'treasury', 'reserve', 'payouts', 'platform_withdrawals', 'fx_conversion'] as const) {
    totals[kind] = await balance(ctx.db, await accountId(ctx.db, kind, currency));
  }
  totals.seller_balances = (
    await one<{ s: number }>(
      ctx.db,
      `SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'seller_available' AND a.currency = $1`,
      [currency],
    )
  ).s;

  // Money the PSP should be holding for us: everything captured (net of refunds, fees and
  // chargebacks), minus what was paid out to sellers and to the company bank account, adjusted
  // for money converted into or out of this currency.
  const expected = -totals.gateway_clearing! - totals.payouts! - totals.platform_withdrawals! - totals.fx_conversion!;
  const actual = await ctx.payments.platformBalance(currency);
  const difference = actual === null ? null : actual - expected;
  if (difference !== null && Math.abs(difference) > ctx.cfg.RECON_TOLERANCE_CENTS) {
    issues.push({ check: 'psp_balance_mismatch', detail: { expected, actual, difference } });
  }

  // Other currencies the platform holds (sellers paid in EUR/EGP): same equation per currency.
  if (currency === ctx.cfg.SETTLEMENT_CURRENCY) {
    const others = await many<{ currency: string }>(ctx.db, `SELECT DISTINCT currency FROM ledger_accounts WHERE currency <> $1`, [currency]);
    for (const { currency: cur } of others) {
      let exp = 0;
      for (const kind of ['gateway_clearing', 'payouts', 'platform_withdrawals', 'fx_conversion'] as const) exp -= await balance(ctx.db, await accountId(ctx.db, kind, cur));
      const act = await ctx.payments.platformBalance(cur);
      if (act !== null && Math.abs(act - exp) > ctx.cfg.RECON_TOLERANCE_CENTS) {
        issues.push({ check: 'psp_balance_mismatch', detail: { currency: cur, expected: exp, actual: act, difference: act - exp } });
      }
    }
  }

  const negative = await many(
    ctx.db,
    `SELECT a.owner_id AS seller_id, a.currency, SUM(e.amount_cents)::bigint AS balance FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.kind = 'seller_available' GROUP BY a.owner_id, a.currency HAVING SUM(e.amount_cents) < 0`,
    [],
  );
  if (negative.length) warnings.push({ check: 'negative_seller_balances', detail: negative });

  const stuckWithdrawals = await many(ctx.db, `SELECT id, user_id, amount_cents, created_at FROM withdrawals WHERE (status = 'pending' AND created_at < now() - interval '1 hour') OR (status = 'processing' AND updated_at < now() - interval '3 days') OR (status = 'pending_approval' AND created_at < now() - interval '3 days')`);
  if (stuckWithdrawals.length) warnings.push({ check: 'withdrawals_stuck_pending', detail: stuckWithdrawals });

  const undelivered = await many(
    ctx.db,
    `SELECT o.id, o.paid_at FROM orders o JOIN offers f ON f.id = o.offer_id
      WHERE o.status = 'paid' AND f.delivery_mode = 'auto' AND NOT o.escrow_frozen AND o.paid_at < now() - interval '1 hour' LIMIT 50`,
  );
  if (undelivered.length) warnings.push({ check: 'auto_delivery_not_delivered', detail: undelivered });

  const dead = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'dead' AND created_at > now() - interval '24 hours'`);
  if (dead.n) warnings.push({ check: 'dead_webhooks_24h', detail: dead.n });
  const failedEmails = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM notifications WHERE status = 'failed' AND created_at > now() - interval '24 hours'`);
  if (failedEmails.n) warnings.push({ check: 'failed_emails_24h', detail: failedEmails.n });

  return { currency, issues, warnings, totals, psp: { expected, actual, difference } };
}

async function alertAdmins(ctx: Ctx, runId: string, status: string, report: Pick<ReconReport, 'issues'>) {
  const admins = await many<{ id: string }>(ctx.db, `SELECT id FROM users WHERE (role IN ('admin', 'finance') OR staff_roles && ARRAY['admin', 'finance']) AND deleted_at IS NULL AND status = 'active'`);
  const summary = report.issues.map((i) => `- ${i.check}${typeof i.detail === 'object' && i.detail && 'difference' in (i.detail as any) ? ` (difference ${(i.detail as any).difference} cents)` : ''}`);
  for (const a of admins) {
    await enqueueEmail(ctx.db, a.id, 'reconciliation_alert', { status, issues: report.issues.length, summary, started_at: new Date().toISOString().slice(0, 10) }, `recon:${runId}:${a.id}`);
  }
  ctx.log.error({ runId, status, issues: report.issues.map((i) => i.check) }, 'reconciliation found problems');
}

/** Worker hook: run once per RECON_INTERVAL_HOURS across all worker processes. */
export async function maybeRunScheduledReconciliation(ctx: Ctx): Promise<boolean> {
  // Claim the run under a lock so two workers never both start one.
  const runId = await withTx(ctx.db, async (tx) => {
    const { locked } = await one<{ locked: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727275) AS locked');
    if (!locked) return null;
    const recent = await maybeOne(
      tx,
      `SELECT 1 FROM reconciliation_runs WHERE started_at > now() - make_interval(hours => $1) LIMIT 1`,
      [ctx.cfg.RECON_INTERVAL_HOURS],
    );
    if (recent) return null;
    return (await one<{ id: string }>(tx, `INSERT INTO reconciliation_runs (status) VALUES ('running') RETURNING id`)).id;
  });
  if (!runId) return false;
  await runReconciliation(ctx, 'USD', runId).catch((err) => ctx.log.error({ err: (err as Error).message }, 'reconciliation failed'));
  return true;
}
