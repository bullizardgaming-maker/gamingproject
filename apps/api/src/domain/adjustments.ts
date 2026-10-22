import type { Ctx } from '../context.js';
import { many, maybeOne, one } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { withScope } from './events.js';
import { accountId, post, type AccountKind } from './ledger.js';

export interface AdjustmentLine {
  kind: AccountKind;
  ownerId: string | null;
  currency: string;
  amountCents: number;
}

/** Account kinds that belong to a user; every other kind is a platform account (no owner). */
const OWNED: AccountKind[] = ['seller_available', 'user_credit'];

/**
 * Manual ledger corrections with four-eyes approval. One admin proposes balanced
 * lines and a reason; a different admin approves, which posts them as one
 * transaction (memo `adjustment:<id>`). Nothing is edited or deleted.
 */
export async function requestAdjustment(ctx: Ctx, adminId: string, input: { reason: string; lines: AdjustmentLine[]; orderId?: string }) {
  const { lines } = input;
  if (lines.length < 2) throw badRequest('invalid_adjustment', 'An adjustment needs at least two lines');
  const byCurrency = new Map<string, number>();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amountCents) || l.amountCents === 0) throw badRequest('invalid_adjustment', 'Amounts must be non-zero whole cents');
    if (OWNED.includes(l.kind) !== !!l.ownerId) {
      throw badRequest('invalid_adjustment', `${l.kind} ${OWNED.includes(l.kind) ? 'needs' : 'cannot have'} an owner`);
    }
    byCurrency.set(l.currency, (byCurrency.get(l.currency) ?? 0) + l.amountCents);
  }
  for (const [cur, sum] of byCurrency) if (sum !== 0) throw badRequest('unbalanced', `${cur} lines sum to ${sum}, not 0`);
  for (const owner of new Set(lines.map((l) => l.ownerId).filter(Boolean))) {
    if (!(await maybeOne(ctx.db, 'SELECT 1 FROM users WHERE id = $1', [owner]))) throw notFound(`User ${owner}`);
  }
  if (input.orderId && !(await maybeOne(ctx.db, 'SELECT 1 FROM orders WHERE id = $1', [input.orderId]))) throw notFound('Order');
  return one(
    ctx.db,
    `INSERT INTO ledger_adjustments (reason, lines, order_id, requested_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.reason, JSON.stringify(lines), input.orderId ?? null, adminId],
  );
}

export async function decideAdjustment(ctx: Ctx, id: string, adminId: string, approve: boolean) {
  return withScope(ctx, async (s) => {
    const a = await maybeOne(s.tx, 'SELECT * FROM ledger_adjustments WHERE id = $1 FOR UPDATE', [id]);
    if (!a) throw notFound('Adjustment');
    if (a.status !== 'pending_approval') throw conflict('already_decided', `Adjustment is ${a.status}`);
    if (a.requested_by === adminId) throw forbidden('four_eyes', 'A different admin must approve this adjustment');
    if (!approve) {
      return one(s.tx, `UPDATE ledger_adjustments SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1 RETURNING *`, [id, adminId]);
    }
    const postings = [];
    for (const l of a.lines as AdjustmentLine[]) postings.push({ account: await accountId(s.tx, l.kind, l.currency, l.ownerId), amountCents: l.amountCents });
    const txnId = await post(s.tx, postings, `adjustment:${id}`, a.order_id);
    return one(
      s.tx,
      `UPDATE ledger_adjustments SET status = 'posted', decided_by = $2, decided_at = now(), txn_id = $3 WHERE id = $1 RETURNING *`,
      [id, adminId, txnId],
    );
  });
}

export async function listAdjustments(ctx: Ctx) {
  return many(
    ctx.db,
    `SELECT a.*, r.display_name AS requested_by_name, d.display_name AS decided_by_name
       FROM ledger_adjustments a JOIN users r ON r.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by
      ORDER BY a.created_at DESC LIMIT 100`,
  );
}

/** Balances of every ledger account a user owns, plus recent entries, for investigating a correction. */
export async function userLedger(ctx: Ctx, userId: string) {
  return many(
    ctx.db,
    `SELECT a.kind, a.currency, COALESCE(SUM(e.amount_cents), 0)::bigint AS balance_cents, count(e.id)::int AS entries
       FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.owner_id = $1 GROUP BY a.id ORDER BY a.kind, a.currency`,
    [userId],
  );
}
