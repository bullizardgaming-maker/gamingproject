import type { Ctx } from '../context.js';
import { many, maybeOne, one, withTx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { getRate } from './fx.js';
import { notify } from './notifications.js';
import { bookConversion, fxPosition } from './sellerfx.js';

/**
 * Automated FX top-ups. Sellers can be paid in EUR or GBP, so the platform must hold enough of
 * each. The planner compares what sellers are owed in every non-settlement currency with what
 * the PSP should hold there (domain/sellerfx.ts fxPosition) and proposes buying the shortfall
 * plus FX_TOPUP_BUFFER_BPS, from the settlement currency, rounded up to a whole unit.
 *  - Proposals costing up to FX_TOPUP_AUTO_APPROVE_CENTS execute at once.
 *  - Others wait for someone with fx.manage; one a person proposed needs a different person.
 *  - Execution goes through the FX exchange (Wise, or the mock), and the amounts it actually
 *    spent and received are booked as a conversion, so the position and reconciliation follow.
 * One open proposal per currency; a newer plan replaces an older proposal that wasn't decided.
 */
const roundUpToUnit = (cents: number) => Math.ceil(cents / 100) * 100;

export async function planTopUps(ctx: Ctx, requestedBy: string | null = null) {
  const settlement = ctx.cfg.SETTLEMENT_CURRENCY;
  const created = [];
  for (const p of await fxPosition(ctx)) {
    if (p.currency === settlement || p.shortfallCents <= 0) continue;
    const toCents = roundUpToUnit(p.shortfallCents * (1 + ctx.cfg.FX_TOPUP_BUFFER_BPS / 10_000));
    const rate = await getRate(ctx, ctx.db, p.currency); // units of p.currency per 1 settlement unit
    const estFrom = Math.ceil(toCents / rate);
    if (estFrom < ctx.cfg.FX_TOPUP_MIN_CENTS) continue;
    const row = await withTx(ctx.db, async (tx) => {
      const open = await maybeOne<{ id: string; status: string; to_cents: string }>(tx, `SELECT id, status, to_cents FROM fx_topups WHERE to_currency = $1 AND status IN ('proposed', 'executing') FOR UPDATE`, [p.currency]);
      if (open?.status === 'executing' || (open && Number(open.to_cents) >= toCents)) return null;
      if (open) await tx.query(`UPDATE fx_topups SET status = 'superseded', decided_at = now() WHERE id = $1`, [open.id]);
      return one(
        tx,
        `INSERT INTO fx_topups (from_currency, to_currency, to_cents, est_from_cents, reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [settlement, p.currency, toCents, estFrom, `Sellers are owed ${p.sellerBalancesCents} ${p.currency} cents; holdings cover ${p.pspExpectedCents}`, requestedBy],
      );
    });
    if (!row) continue;
    created.push(row);
    if (ctx.fxExchange && estFrom <= ctx.cfg.FX_TOPUP_AUTO_APPROVE_CENTS) {
      await execute(ctx, row.id, null);
    } else {
      const finance = await many<{ id: string }>(
        ctx.db,
        `SELECT id FROM users WHERE (role IN ('finance', 'admin') OR staff_roles && ARRAY['finance', 'admin']) AND status = 'active' AND deleted_at IS NULL`,
      );
      for (const f of finance) {
        await notify(ctx.db, f.id, 'fx_topup_proposed', { topup_id: row.id, to_cents: toCents, currency: p.currency, est_from_cents: estFrom, from_currency: settlement }, `fx_topup:${row.id}:${f.id}`);
      }
    }
  }
  return Promise.all(created.map((r) => getTopUp(ctx, r.id)));
}

export async function getTopUp(ctx: Ctx, id: string) {
  const row = await maybeOne(ctx.db, `SELECT * FROM fx_topups WHERE id = $1`, [id]);
  if (!row) throw notFound('Top-up');
  return row;
}

export async function listTopUps(ctx: Ctx) {
  return many(
    ctx.db,
    `SELECT t.*, r.display_name AS requested_by_name, d.display_name AS decided_by_name
       FROM fx_topups t LEFT JOIN users r ON r.id = t.requested_by LEFT JOIN users d ON d.id = t.decided_by
      ORDER BY t.created_at DESC LIMIT 100`,
  );
}

export async function decideTopUp(ctx: Ctx, staffId: string, id: string, approve: boolean) {
  const t = await getTopUp(ctx, id);
  if (t.status !== 'proposed') throw conflict('already_decided', `This top-up is ${t.status}`);
  if (t.requested_by === staffId) throw forbidden('four_eyes', 'Someone else must approve a top-up you proposed');
  if (!approve) {
    await ctx.db.query(`UPDATE fx_topups SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'proposed'`, [id, staffId]);
    return getTopUp(ctx, id);
  }
  if (!ctx.fxExchange) throw badRequest('no_fx_exchange', 'No FX provider is configured; convert at your bank and record the conversion instead');
  return execute(ctx, id, staffId);
}

async function execute(ctx: Ctx, id: string, decidedBy: string | null) {
  const exchange = ctx.fxExchange!;
  // Claim it: only one executor, even if two people approve at once.
  const claimed = await maybeOne<any>(
    ctx.db,
    `UPDATE fx_topups SET status = 'executing', decided_by = $2, decided_at = now(), provider = $3 WHERE id = $1 AND status = 'proposed' RETURNING *`,
    [id, decidedBy, exchange.name],
  );
  if (!claimed) throw conflict('already_decided', 'This top-up was already decided');
  let r: Awaited<ReturnType<typeof exchange.buy>>;
  try {
    r = await exchange.buy({ from: claimed.from_currency, to: claimed.to_currency, toCents: Number(claimed.to_cents), idempotencyKey: claimed.id });
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    await ctx.db.query(`UPDATE fx_topups SET status = 'failed', error = $2 WHERE id = $1`, [id, message]);
    ctx.log.error({ err: message, topup: id }, 'fx top-up failed');
    return getTopUp(ctx, id);
  }
  // The money has moved: record the provider's reference first, so a booking failure leaves
  // the top-up visibly "executing" with its reference rather than looking like it never ran.
  await ctx.db.query(`UPDATE fx_topups SET provider_ref = $2, from_cents = $3, rate = $4 WHERE id = $1`, [id, r.ref, r.fromCents, r.rate]);
  try {
    await withTx(ctx.db, async (tx) => {
      const conv = await bookConversion(tx, decidedBy, { fromCurrency: claimed.from_currency, fromCents: r.fromCents, toCurrency: claimed.to_currency, toCents: r.toCents, reference: `${exchange.name}:${r.ref}` });
      await tx.query(
        `UPDATE fx_topups SET status = 'completed', provider_ref = $2, from_cents = $3, rate = $4, conversion_id = $5, executed_at = now() WHERE id = $1`,
        [id, r.ref, r.fromCents, r.rate, conv.id],
      );
    });
  } catch (err) {
    const message = `converted but not booked: ${(err as Error).message}`.slice(0, 500);
    await ctx.db.query(`UPDATE fx_topups SET error = $2 WHERE id = $1`, [id, message]);
    ctx.log.error({ err: message, topup: id }, 'fx top-up booking failed');
  }
  return getTopUp(ctx, id);
}

let lastPlan = 0;
/** Worker: plan once a day. */
export async function maybePlanTopUps(ctx: Ctx) {
  if (Date.now() - lastPlan < 24 * 3_600_000) return null;
  lastPlan = Date.now();
  const locked = await withTx(ctx.db, async (tx) => (await one<{ l: boolean }>(tx, 'SELECT pg_try_advisory_xact_lock(727292) AS l')).l);
  if (!locked) return null;
  return (await planTopUps(ctx)).length;
}
