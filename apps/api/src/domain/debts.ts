import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { PaymentEvent } from '../providers/payments/types.js';
import { withScope } from './events.js';
import { accountId, post } from './ledger.js';
import { notify } from './notifications.js';

/**
 * Seller debt collection. A seller balance goes negative when a refund after release or a
 * chargeback claws back more than they hold. Every negative (seller, currency) balance is a
 * debt case:
 *  - reminders on the DEBT_REMINDER_DAYS schedule (default: at once, day 3, day 7);
 *  - after DEBT_PAUSE_AFTER_DAYS (default 14) the shop is paused and finance is told;
 *  - the case closes when the balance is back at zero or above: from new sales (orders already
 *    paid still release normally), a card repayment, or a write-off (a four-eyes ledger
 *    adjustment). Closing lifts a pause that debt collection caused.
 * Withdrawals are already impossible while any balance is negative (see payout holds).
 */
const DAY = 86_400_000;

interface Negative {
  seller_id: string;
  currency: string;
  owed: number;
}

async function negativeBalances(q: Queryable): Promise<Negative[]> {
  const rows = await many<{ seller_id: string; currency: string; balance: string }>(
    q,
    `SELECT a.owner_id AS seller_id, a.currency, SUM(e.amount_cents)::bigint AS balance
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.kind = 'seller_available' AND a.owner_id IS NOT NULL
      GROUP BY a.owner_id, a.currency HAVING SUM(e.amount_cents) < 0`,
  );
  return rows.map((r) => ({ seller_id: r.seller_id, currency: r.currency, owed: -Number(r.balance) }));
}

async function owedNow(q: Queryable, sellerId: string, currency: string) {
  const r = await one<{ b: string }>(
    q,
    `SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.kind = 'seller_available' AND a.owner_id = $1 AND a.currency = $2`,
    [sellerId, currency],
  );
  return Math.max(0, -Number(r.b));
}

/** One pass of debt collection. `now` is injectable for tests. */
export async function collectDebts(ctx: Ctx, now = new Date()) {
  const stats = { opened: 0, reminded: 0, paused: 0, closed: 0 };
  const schedule = ctx.cfg.DEBT_REMINDER_DAYS;
  const negatives = await negativeBalances(ctx.db);
  const owing = new Set(negatives.map((n) => `${n.seller_id}:${n.currency}`));

  for (const n of negatives) {
    await withTx(ctx.db, async (tx) => {
      let debt = await maybeOne<any>(tx, `SELECT * FROM seller_debts WHERE seller_id = $1 AND currency = $2 AND closed_at IS NULL FOR UPDATE`, [n.seller_id, n.currency]);
      if (!debt) {
        debt = await one(
          tx,
          `INSERT INTO seller_debts (seller_id, currency, opened_at, peak_cents, owed_cents) VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (seller_id, currency) WHERE closed_at IS NULL DO UPDATE SET owed_cents = EXCLUDED.owed_cents RETURNING *`,
          [n.seller_id, n.currency, now, n.owed],
        );
        stats.opened++;
      } else {
        await tx.query(`UPDATE seller_debts SET owed_cents = $2, peak_cents = GREATEST(peak_cents, $2) WHERE id = $1`, [debt.id, n.owed]);
      }
      const age = now.getTime() - new Date(debt.opened_at).getTime();
      const pauseAt = new Date(new Date(debt.opened_at).getTime() + ctx.cfg.DEBT_PAUSE_AFTER_DAYS * DAY);

      // Reminders: send the latest one now due (never a burst of missed ones).
      let due = debt.reminders_sent;
      while (due < schedule.length && age >= schedule[due]! * DAY) due++;
      if (due > debt.reminders_sent && !debt.paused_at) {
        await notify(
          tx,
          n.seller_id,
          'debt_reminder',
          { amount_cents: n.owed, currency: n.currency, pause_at: pauseAt.toISOString(), first: debt.reminders_sent === 0 },
          `debt:${debt.id}:reminder:${due}`,
        );
        await tx.query(`UPDATE seller_debts SET reminders_sent = $2, last_reminder_at = $3 WHERE id = $1`, [debt.id, due, now]);
        stats.reminded++;
      }

      if (!debt.paused_at && now >= pauseAt) {
        // A shop the seller already paused stays as they set it; we only mark the debt pause.
        const { rows } = await tx.query(
          `UPDATE users SET shop_paused = true, shop_paused_until = NULL, shop_pause_message = 'This shop is temporarily unavailable.', shop_paused_for_debt = true
            WHERE id = $1 AND NOT (shop_paused AND (shop_paused_until IS NULL OR shop_paused_until > now())) RETURNING id`,
          [n.seller_id],
        );
        await tx.query(`UPDATE seller_debts SET paused_at = $2, escalated_at = $2 WHERE id = $1`, [debt.id, now]);
        await notify(tx, n.seller_id, 'debt_shop_paused', { amount_cents: n.owed, currency: n.currency, already_paused: rows.length === 0 }, `debt:${debt.id}:paused`);
        const finance = await many<{ id: string }>(
          tx,
          `SELECT id FROM users WHERE (role IN ('finance', 'admin') OR staff_roles && ARRAY['finance', 'admin']) AND status = 'active' AND deleted_at IS NULL AND id <> $1`,
          [n.seller_id],
        );
        for (const f of finance) {
          await notify(tx, f.id, 'debt_escalated', { debt_id: debt.id, seller_id: n.seller_id, amount_cents: n.owed, currency: n.currency }, `debt:${debt.id}:escalated:${f.id}`);
        }
        stats.paused++;
      }
    });
  }

  // Close cases whose balance is back at zero or above.
  const open = await many<{ id: string; seller_id: string; currency: string }>(ctx.db, `SELECT id, seller_id, currency FROM seller_debts WHERE closed_at IS NULL`);
  for (const d of open.filter((o) => !owing.has(`${o.seller_id}:${o.currency}`))) {
    await withTx(ctx.db, async (tx) => {
      const debt = await maybeOne<any>(tx, `SELECT * FROM seller_debts WHERE id = $1 AND closed_at IS NULL FOR UPDATE`, [d.id]);
      if (!debt || (await owedNow(tx, d.seller_id, d.currency)) > 0) return;
      const writtenOff = await maybeOne(
        tx,
        `SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.kind = 'seller_available' AND a.owner_id = $1 AND a.currency = $2 AND e.memo LIKE 'adjustment:%' AND e.amount_cents > 0 AND e.created_at >= $3 LIMIT 1`,
        [d.seller_id, d.currency, debt.opened_at],
      );
      const reason = writtenOff ? 'written_off' : 'repaid';
      await tx.query(`UPDATE seller_debts SET closed_at = $2, closed_reason = $3, owed_cents = 0 WHERE id = $1`, [d.id, now, reason]);
      const stillPaused = await maybeOne(tx, `SELECT 1 FROM seller_debts WHERE seller_id = $1 AND closed_at IS NULL AND paused_at IS NOT NULL`, [d.seller_id]);
      let resumed = false;
      if (!stillPaused) {
        const { rowCount } = await tx.query(
          `UPDATE users SET shop_paused = false, shop_paused_until = NULL, shop_pause_message = NULL, shop_paused_for_debt = false WHERE id = $1 AND shop_paused_for_debt`,
          [d.seller_id],
        );
        resumed = !!rowCount;
      }
      await notify(tx, d.seller_id, 'debt_cleared', { currency: d.currency, reason, resumed }, `debt:${d.id}:closed`);
      stats.closed++;
    });
  }
  return stats;
}

let lastRun = 0;
/** Worker: one worker runs collection every DEBT_CHECK_MINUTES. */
export async function maybeCollectDebts(ctx: Ctx) {
  if (Date.now() - lastRun < ctx.cfg.DEBT_CHECK_MINUTES * 60_000) return null;
  lastRun = Date.now();
  const locked = await withTx(ctx.db, async (tx) => (await one<{ l: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727291) AS l')).l);
  if (!locked) return null;
  return collectDebts(ctx);
}

/** A seller's open debts, for their dashboard. */
export async function sellerDebts(ctx: Ctx, sellerId: string) {
  const rows = await many<any>(ctx.db, `SELECT * FROM seller_debts WHERE seller_id = $1 AND closed_at IS NULL ORDER BY opened_at`, [sellerId]);
  const out = [];
  for (const d of rows) {
    out.push({
      id: d.id,
      currency: d.currency,
      owedCents: await owedNow(ctx.db, sellerId, d.currency),
      openedAt: d.opened_at,
      shopPausedAt: d.paused_at,
      pausesAt: d.paused_at ? null : new Date(new Date(d.opened_at).getTime() + ctx.cfg.DEBT_PAUSE_AFTER_DAYS * DAY).toISOString(),
    });
  }
  return out;
}

/** Staff list for finance: open (or recently closed) debt cases with the seller. */
export async function listDebts(ctx: Ctx, status: 'open' | 'closed' = 'open') {
  return many(
    ctx.db,
    `SELECT d.*, u.display_name, u.email FROM seller_debts d JOIN users u ON u.id = d.seller_id
      WHERE ${status === 'open' ? 'd.closed_at IS NULL' : `d.closed_at > now() - interval '90 days'`}
      ORDER BY ${status === 'open' ? 'd.opened_at' : 'd.closed_at DESC'} LIMIT 200`,
  );
}

/** True while a debt pause holds the shop; the seller can't lift it from holiday mode. */
export async function shopHeldForDebt(q: Queryable, sellerId: string) {
  return !!(await maybeOne(q, `SELECT 1 FROM seller_debts WHERE seller_id = $1 AND closed_at IS NULL AND paused_at IS NOT NULL`, [sellerId]));
}

/** Start a card repayment of a debt through the PSP's hosted checkout. */
export async function startDebtPayment(ctx: Ctx, seller: { id: string; email: string }, debtId: string, amountCents?: number) {
  const debt = await maybeOne<any>(ctx.db, `SELECT * FROM seller_debts WHERE id = $1 AND seller_id = $2`, [debtId, seller.id]);
  if (!debt) throw notFound('Debt');
  if (debt.closed_at) throw conflict('debt_closed', 'This balance is already settled');
  const owed = await owedNow(ctx.db, seller.id, debt.currency);
  if (owed === 0) throw conflict('debt_closed', 'This balance is already settled');
  const amount = amountCents ?? owed;
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > owed) throw badRequest('invalid_amount', `Pay between 100 and ${owed} cents`);

  const id = (await one<{ id: string }>(ctx.db, 'SELECT gen_random_uuid() AS id')).id;
  const session = await ctx.payments.createCheckout({
    orderId: id,
    amountCents: amount,
    currency: debt.currency,
    description: 'Bullizard balance repayment',
    buyerEmail: seller.email,
    successUrl: `${ctx.cfg.PUBLIC_WEB_URL}/sell/money?repaid=1`,
    cancelUrl: `${ctx.cfg.PUBLIC_WEB_URL}/sell/money`,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  await ctx.db.query(
    `INSERT INTO debt_payments (id, seller_id, debt_id, currency, amount_cents, payment_provider, payment_ref) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, seller.id, debt.id, debt.currency, amount, session.provider, session.ref],
  );
  return { paymentId: id, amountCents: amount, currency: debt.currency, checkoutUrl: session.redirectUrl };
}

export async function debtPaymentByRef(q: Queryable, ref: string) {
  return maybeOne<any>(q, `SELECT * FROM debt_payments WHERE payment_ref = $1`, [ref]);
}

/** PSP webhook: a debt repayment was captured. Credits the seller's balance (idempotent). */
export async function handleDebtPaymentCaptured(ctx: Ctx, ev: Extract<PaymentEvent, { type: 'payment.captured' }>) {
  const result = await withScope(ctx, async (s) => {
    const p = await maybeOne<any>(s.tx, `SELECT * FROM debt_payments WHERE payment_ref = $1 FOR UPDATE`, [ev.ref]);
    if (!p) throw notFound('Debt payment');
    if (p.id !== ev.orderId || Number(p.amount_cents) !== ev.amountCents || p.currency !== ev.currency) {
      throw badRequest('amount_mismatch', 'Captured amount does not match the repayment');
    }
    if (p.status === 'paid') return p; // replay
    const cur = p.currency;
    await post(
      s.tx,
      [
        { account: await accountId(s.tx, 'gateway_clearing', cur), amountCents: -Number(p.amount_cents) },
        { account: await accountId(s.tx, 'seller_available', cur, p.seller_id), amountCents: Number(p.amount_cents) },
      ],
      'debt_payment',
    );
    const fee = ev.details.feeCents ?? 0;
    if (fee > 0) {
      await post(
        s.tx,
        [
          { account: await accountId(s.tx, 'gateway_clearing', cur), amountCents: fee },
          { account: await accountId(s.tx, 'treasury', cur), amountCents: -fee },
        ],
        'psp_fee',
      );
    }
    return one(s.tx, `UPDATE debt_payments SET status = 'paid', paid_at = now() WHERE id = $1 RETURNING *`, [p.id]);
  });
  // Close the case (and lift the pause) right away rather than at the next scheduled run.
  await collectDebts(ctx).catch((err) => ctx.log.error({ err }, 'debt collection after repayment failed'));
  return result;
}
