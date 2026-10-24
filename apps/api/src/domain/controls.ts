import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { one } from '../db.js';
import { AppError, badRequest } from '../lib/errors.js';

/**
 * Launch gate §4 — damage limits. One staff-editable row (Ops → Controls):
 *  - kill switches: pause withdrawals, new orders, chat, sign-ups (each answers 503 with a code the app shows);
 *  - beta limits: max withdrawal per user per day, max order size, and tighter limits for accounts in their first days.
 * The row is read with a short in-process cache so a switch takes effect within seconds on every API node.
 */
export interface Controls {
  pause_withdrawals: boolean;
  pause_orders: boolean;
  pause_chat: boolean;
  pause_signups: boolean;
  pause_message: string | null;
  max_withdrawal_day_cents: number;
  max_order_cents: number;
  new_account_days: number;
  new_account_max_order_cents: number;
  new_account_max_open_orders: number;
  alert_dispute_hour: number;
  alert_bans_hour: number;
  alert_withdrawal_cents: number;
  four_eyes_withdrawal_cents: number;
  four_eyes_user_day_cents: number;
  max_platform_payout_day_cents: number;
  updated_at: string;
}
const COLS = 'pause_withdrawals, pause_orders, pause_chat, pause_signups, pause_message, max_withdrawal_day_cents::bigint, max_order_cents::bigint, new_account_days, new_account_max_order_cents::bigint, new_account_max_open_orders, alert_dispute_hour, alert_bans_hour, alert_withdrawal_cents::bigint, four_eyes_withdrawal_cents::bigint, four_eyes_user_day_cents::bigint, max_platform_payout_day_cents::bigint, updated_at';
const CACHE_MS = 5_000;
let cached: { at: number; value: Controls } | null = null;

const normalise = (r: any): Controls => ({
  ...r,
  max_withdrawal_day_cents: Number(r.max_withdrawal_day_cents),
  max_order_cents: Number(r.max_order_cents),
  new_account_max_order_cents: Number(r.new_account_max_order_cents),
  alert_withdrawal_cents: Number(r.alert_withdrawal_cents),
  four_eyes_withdrawal_cents: Number(r.four_eyes_withdrawal_cents),
  four_eyes_user_day_cents: Number(r.four_eyes_user_day_cents),
  max_platform_payout_day_cents: Number(r.max_platform_payout_day_cents),
});

export async function controls(q: Queryable, fresh = false): Promise<Controls> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const row = normalise(await one(q, `SELECT ${COLS} FROM platform_controls`));
  cached = { at: Date.now(), value: row };
  return row;
}
export const forgetControlsCache = () => {
  cached = null;
};

export type Switch = 'withdrawals' | 'orders' | 'chat' | 'signups';
const PAUSED: Record<Switch, [keyof Controls, string, string]> = {
  withdrawals: ['pause_withdrawals', 'withdrawals_paused', 'Withdrawals are paused for a short while. Your balance is safe; try again later.'],
  orders: ['pause_orders', 'orders_paused', 'New orders are paused for a short while. Try again later.'],
  chat: ['pause_chat', 'chat_paused', 'Chat is paused for a short while. Your order and its record are safe.'],
  signups: ['pause_signups', 'signups_paused', 'Sign-ups are paused for a short while. Try again later.'],
};
/** Throws 503 when the switch is on. */
export async function assertNotPaused(q: Queryable, what: Switch) {
  const c = await controls(q);
  const [col, code, text] = PAUSED[what];
  if (c[col]) throw new AppError(503, code, c.pause_message || text);
}

export async function updateControls(ctx: Ctx, staffId: string, patch: Partial<Omit<Controls, 'updated_at'>>) {
  const allowed: Array<keyof Omit<Controls, 'updated_at'>> = [
    'pause_withdrawals', 'pause_orders', 'pause_chat', 'pause_signups', 'pause_message', 'max_withdrawal_day_cents', 'max_order_cents',
    'new_account_days', 'new_account_max_order_cents', 'new_account_max_open_orders', 'alert_dispute_hour', 'alert_bans_hour', 'alert_withdrawal_cents',
    'four_eyes_withdrawal_cents', 'four_eyes_user_day_cents', 'max_platform_payout_day_cents',
  ];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    vals.push(patch[k]);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) throw badRequest('nothing_to_change', 'No control given');
  vals.push(staffId);
  await ctx.db.query(`UPDATE platform_controls SET ${sets.join(', ')}, updated_by = $${vals.length}, updated_at = now()`, vals);
  forgetControlsCache();
  return controls(ctx.db, true);
}

/** Beta order limits: a cap for everyone, a tighter one plus an open-order cap for accounts in their first days. */
export async function assertOrderWithinLimits(q: Queryable, buyer: { id: string; created_at: string }, amountCents: number) {
  const c = await controls(q);
  if (amountCents > c.max_order_cents) {
    throw badRequest('order_too_large', `During the beta an order is at most ${(c.max_order_cents / 100).toFixed(2)} USD; split it into smaller orders`, { maxCents: c.max_order_cents });
  }
  const ageDays = (Date.now() - new Date(buyer.created_at).getTime()) / 86_400_000;
  if (ageDays < c.new_account_days) {
    if (amountCents > c.new_account_max_order_cents) {
      throw badRequest('new_account_limit', `New accounts can order up to ${(c.new_account_max_order_cents / 100).toFixed(2)} USD per order for their first ${c.new_account_days} days`, { maxCents: c.new_account_max_order_cents, days: c.new_account_days });
    }
    const open = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM orders WHERE buyer_id = $1 AND status IN ('awaiting_payment', 'paid', 'delivered', 'disputed')`, [buyer.id]);
    if (open.n >= c.new_account_max_open_orders) {
      throw badRequest('new_account_limit', `New accounts can have ${c.new_account_max_open_orders} open orders at a time for their first ${c.new_account_days} days`, { maxOpen: c.new_account_max_open_orders, days: c.new_account_days });
    }
  }
}

/** Per-user daily withdrawal cap: everything requested today (not rejected/failed) plus this request. */
export async function assertWithdrawalWithinLimits(q: Queryable, userId: string, amountCents: number) {
  const c = await controls(q);
  const today = await one<{ s: string }>(q, `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS s FROM withdrawals WHERE user_id = $1 AND status NOT IN ('rejected', 'failed') AND created_at > now() - interval '24 hours'`, [userId]);
  if (Number(today.s) + amountCents > c.max_withdrawal_day_cents) {
    throw badRequest('withdrawal_limit', `Withdrawals are limited to ${(c.max_withdrawal_day_cents / 100).toFixed(2)} USD per day; ${((c.max_withdrawal_day_cents - Number(today.s)) / 100).toFixed(2)} USD is still available today`, {
      maxDayCents: c.max_withdrawal_day_cents, usedCents: Number(today.s),
    });
  }
}
