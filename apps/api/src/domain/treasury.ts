import type { Ctx } from '../context.js';
import { many, maybeOne, one } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { withScope } from './events.js';
import { accountId, balance, post } from './ledger.js';

/**
 * Moving platform revenue (treasury) to the company bank account.
 * Four-eyes: one admin requests, a *different* admin approves (enforced by a
 * DB constraint too). Only treasury money can leave — escrow, seller balances
 * and the chargeback reserve are never touched.
 */
export async function treasuryBalance(ctx: Ctx, currency = 'USD') {
  const [treasury, reserve, withdrawn, pending] = await Promise.all([
    balance(ctx.db, await accountId(ctx.db, 'treasury', currency)),
    balance(ctx.db, await accountId(ctx.db, 'reserve', currency)),
    balance(ctx.db, await accountId(ctx.db, 'platform_withdrawals', currency)),
    one<{ s: number }>(ctx.db, `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS s FROM treasury_withdrawals WHERE status = 'pending_approval' AND currency = $1`, [currency]),
  ]);
  return { currency, treasuryCents: treasury, reserveCents: reserve, withdrawnToDateCents: withdrawn, pendingApprovalCents: pending.s, availableCents: treasury - pending.s };
}

export async function requestTreasuryWithdrawal(ctx: Ctx, adminId: string, amountCents: number, note: string, currency = 'USD') {
  const b = await treasuryBalance(ctx, currency);
  if (amountCents > b.availableCents) throw badRequest('insufficient_treasury', `Only ${b.availableCents} cents of platform revenue is available`);
  return one(
    ctx.db,
    `INSERT INTO treasury_withdrawals (amount_cents, currency, note, requested_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [amountCents, currency, note, adminId],
  );
}

export async function decideTreasuryWithdrawal(ctx: Ctx, id: string, adminId: string, approve: boolean) {
  const w = await withScope(ctx, async (s) => {
    const w = await maybeOne(s.tx, 'SELECT * FROM treasury_withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw notFound('Withdrawal');
    if (w.status !== 'pending_approval') throw conflict('already_decided', `Withdrawal is ${w.status}`);
    if (w.requested_by === adminId) throw forbidden('four_eyes', 'A different admin must approve this withdrawal');
    if (!approve) {
      await s.tx.query(`UPDATE treasury_withdrawals SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`, [id, adminId]);
      return { ...w, status: 'rejected' };
    }
    // Serialize against other approvals and re-check the balance under the lock.
    await s.tx.query('SELECT pg_advisory_xact_lock(727276)');
    const treasury = await balance(s.tx, await accountId(s.tx, 'treasury', w.currency));
    if (w.amount_cents > treasury) throw badRequest('insufficient_treasury', 'Treasury balance is now lower than this withdrawal');
    await post(
      s.tx,
      [
        { account: await accountId(s.tx, 'treasury', w.currency), amountCents: -w.amount_cents },
        { account: await accountId(s.tx, 'platform_withdrawals', w.currency), amountCents: w.amount_cents },
      ],
      `treasury_withdrawal:${w.id}`,
    );
    await s.tx.query(`UPDATE treasury_withdrawals SET status = 'paid', decided_by = $2, decided_at = now() WHERE id = $1`, [id, adminId]);
    return { ...w, status: 'paid' };
  });
  if (w.status !== 'paid') return w;

  try {
    const { ref } = await ctx.payments.platformPayout(w.amount_cents, w.currency, `treasury_${w.id}`);
    return one(ctx.db, `UPDATE treasury_withdrawals SET provider_ref = $2 WHERE id = $1 RETURNING *`, [w.id, ref]);
  } catch (err) {
    // Payout failed at the PSP: put the money back in the books.
    await withScope(ctx, async (s) => {
      await post(
        s.tx,
        [
          { account: await accountId(s.tx, 'platform_withdrawals', w.currency), amountCents: -w.amount_cents },
          { account: await accountId(s.tx, 'treasury', w.currency), amountCents: w.amount_cents },
        ],
        `treasury_withdrawal_failed:${w.id}`,
      );
      await s.tx.query(`UPDATE treasury_withdrawals SET status = 'failed', failure = $2 WHERE id = $1`, [w.id, (err as Error).message.slice(0, 300)]);
    });
    throw new AppError(502, 'payout_failed', 'The payment provider rejected the payout; nothing was moved');
  }
}

export async function listTreasuryWithdrawals(ctx: Ctx) {
  return many(
    ctx.db,
    `SELECT w.*, r.display_name AS requested_by_name, d.display_name AS decided_by_name
       FROM treasury_withdrawals w JOIN users r ON r.id = w.requested_by LEFT JOIN users d ON d.id = w.decided_by
      ORDER BY w.created_at DESC LIMIT 100`,
  );
}
