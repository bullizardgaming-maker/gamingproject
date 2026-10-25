import type { Ctx } from '../context.js';
import { many, one } from '../db.js';
import { controls } from './controls.js';
import { enqueueEmail } from './notifications.js';

/**
 * Launch gate §4 — alerts to admins and finance (email + an error log line that Sentry picks up), checked every
 * 15 minutes, one email per condition per hour:
 *  - failed or unknown payouts in the last hour;
 *  - unusual withdrawals: a single request above the threshold, or a user asking three or more times in a day;
 *  - spikes: disputes opened or accounts banned in the last hour above the thresholds (Ops → Controls).
 */
export interface OpsAlert {
  key: string;
  title: string;
  detail: string;
  action: string;
}

export async function detectOpsAlerts(ctx: Ctx): Promise<OpsAlert[]> {
  const c = await controls(ctx.db, true);
  const alerts: OpsAlert[] = [];

  const payouts = await one<{ failed: number; unknown: number }>(
    ctx.db,
    `SELECT count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '1 hour')::int AS failed,
            count(*) FILTER (WHERE status = 'unknown')::int AS unknown FROM withdrawals`,
  );
  if (payouts.failed > 0) alerts.push({ key: 'payouts_failed', title: `${payouts.failed} payout(s) failed in the last hour`, detail: `NOWPayments refused or failed ${payouts.failed} withdrawal(s); the money is back in the sellers' balances.`, action: 'Open Ops → Payouts, read the failure reasons, check the store wallet balance and the payout address formats.' });
  if (payouts.unknown > 0) alerts.push({ key: 'payouts_unknown', title: `${payouts.unknown} payout(s) waiting on the provider`, detail: `${payouts.unknown} withdrawal(s) are in the "unknown" state: the provider did not answer the payout call. Nothing is reversed until it confirms.`, action: 'Ops → Payouts → "Check with provider now", or wait for the hourly recheck. If it persists, check NOWPayments status.' });

  // Round 22b: coins sent for a withdrawal already reversed (the seller got the balance back too). Repeats until Finance acts.
  const late = await many<{ id: string; user_id: string; net_cents: string }>(ctx.db, `SELECT id, user_id, net_cents FROM withdrawals WHERE paid_after_reversal_at > now() - interval '7 days'`);
  if (late.length) alerts.push({ key: 'payout_after_reversal', title: `${late.length} payout(s) sent after they were reversed`, detail: late.map((w) => `withdrawal ${w.id}: ${(Number(w.net_cents) / 100).toFixed(2)} USD to user ${w.user_id}`).join('; '), action: 'Freeze the seller\'s withdrawals and recover the amount from their balance (Ops → Payouts), or write it off.' });

  // Round 22b: withdrawals are USD only. Any seller/buyer balance left in another currency is listed for Finance to convert by a
  // manual ledger adjustment (never converted automatically).
  const foreign = await many<{ owner_id: string; kind: string; currency: string; cents: string }>(
    ctx.db,
    `SELECT a.owner_id, a.kind, a.currency, SUM(e.amount_cents)::bigint AS cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.kind IN ('seller_available', 'user_credit') AND a.currency <> 'USD' AND a.owner_id IS NOT NULL
      GROUP BY a.owner_id, a.kind, a.currency HAVING SUM(e.amount_cents) <> 0 ORDER BY a.currency, a.owner_id LIMIT 50`,
  );
  if (foreign.length) alerts.push({ key: 'non_usd_balances', title: `${foreign.length} balance(s) not in USD`, detail: foreign.map((b) => `user ${b.owner_id}: ${(Number(b.cents) / 100).toFixed(2)} ${b.currency} (${b.kind})`).join('; '), action: 'Withdrawals are USD only: convert each balance to USD with a manual ledger adjustment (Ops → Ledger) at the day\'s rate, and note the rate used.' });

  const big = await many<{ id: string; user_id: string; amount_cents: string }>(ctx.db, `SELECT id, user_id, amount_cents FROM withdrawals WHERE created_at > now() - interval '1 hour' AND amount_cents >= $1`, [c.alert_withdrawal_cents]);
  if (big.length) alerts.push({ key: 'withdrawals_large', title: `${big.length} large withdrawal request(s)`, detail: big.map((w) => `${(Number(w.amount_cents) / 100).toFixed(2)} USD by user ${w.user_id}`).join('; '), action: 'Finance checks the seller\'s recent sales and disputes before approving (Ops → Payouts).' });
  const repeat = await many<{ user_id: string; n: number }>(ctx.db, `SELECT user_id, count(*)::int AS n FROM withdrawals WHERE created_at > now() - interval '24 hours' GROUP BY user_id HAVING count(*) >= 3`);
  if (repeat.length) alerts.push({ key: 'withdrawals_repeat', title: `${repeat.length} user(s) withdrawing repeatedly`, detail: repeat.map((r) => `user ${r.user_id}: ${r.n} requests in 24h`).join('; '), action: 'Look for balance draining after a dispute or a compromised account; freeze withdrawals for the user if in doubt.' });

  const disputes = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM disputes WHERE created_at > now() - interval '1 hour'`);
  if (disputes.n >= c.alert_dispute_hour) alerts.push({ key: 'disputes_spike', title: `${disputes.n} disputes opened in the last hour`, detail: `The threshold is ${c.alert_dispute_hour} per hour.`, action: 'Check for one seller or one game behind them (Ops → Disputes); consider pausing new orders if a scam wave is running.' });
  const bans = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM users WHERE banned_at > now() - interval '1 hour'`);
  if (bans.n >= c.alert_bans_hour) alerts.push({ key: 'bans_spike', title: `${bans.n} accounts banned in the last hour`, detail: `The threshold is ${c.alert_bans_hour} per hour.`, action: 'Read the flagged chats (Ops → Moderation): a filter bug bans innocents, a real wave needs the chat kill switch.' });
  return alerts;
}

/** Sends each alert once per hour to admins and finance; logs an error line for Sentry. */
export async function sendOpsAlerts(ctx: Ctx) {
  const alerts = await detectOpsAlerts(ctx);
  if (!alerts.length) return 0;
  const staff = await many<{ id: string }>(ctx.db, `SELECT id FROM users WHERE (role IN ('admin', 'finance') OR staff_roles && ARRAY['admin', 'finance']) AND deleted_at IS NULL AND status = 'active'`);
  const hour = new Date().toISOString().slice(0, 13);
  let sent = 0;
  for (const a of alerts) {
    ctx.log.error({ alert: a.key, title: a.title, detail: a.detail }, 'ops alert');
    for (const s of staff) {
      await enqueueEmail(ctx.db, s.id, 'ops_alert', { title: a.title, detail: a.detail, action: a.action }, `ops_alert:${a.key}:${hour}:${s.id}`);
      sent++;
    }
  }
  return sent;
}
