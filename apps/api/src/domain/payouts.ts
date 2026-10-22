import type { Ctx } from '../context.js';
import { one } from '../db.js';
import { forbidden } from '../lib/errors.js';
import type { User } from './users.js';

/**
 * Seller payout accounts. The PSP (Stripe Connect Express) hosts onboarding and
 * collects bank details and its own identity checks, so none of that data
 * touches our servers. We only store the account reference and whether payouts
 * are enabled, kept current by `account.updated` webhooks.
 */
export async function startPayoutOnboarding(ctx: Ctx, user: User) {
  if (user.kyc_tier < 2) throw forbidden('kyc_required', 'Verify your identity before setting up payouts');
  let accountRef = user.stripe_account_id;
  if (!accountRef) {
    accountRef = (await ctx.payments.createPayoutAccount({ id: user.id, email: user.email })).accountRef;
    await ctx.db.query('UPDATE users SET stripe_account_id = $2 WHERE id = $1', [user.id, accountRef]);
  }
  const back = `${ctx.cfg.PUBLIC_WEB_URL}/sell?payouts=return`;
  return ctx.payments.payoutOnboardingLink(accountRef, back, `${ctx.cfg.PUBLIC_WEB_URL}/sell?payouts=refresh`);
}

export async function payoutStatus(ctx: Ctx, user: User) {
  if (!user.stripe_account_id) return { connected: false, payoutsEnabled: false, requirementsDue: [] as string[] };
  const status = await ctx.payments.payoutAccountStatus(user.stripe_account_id);
  if (status.payoutsEnabled !== user.payouts_enabled) {
    await ctx.db.query('UPDATE users SET payouts_enabled = $2 WHERE id = $1', [user.id, status.payoutsEnabled]);
  }
  return { connected: true, ...status };
}

export async function applyPayoutAccountUpdate(ctx: Ctx, accountRef: string, payoutsEnabled: boolean) {
  const row = await one<{ n: number }>(
    ctx.db,
    `WITH u AS (UPDATE users SET payouts_enabled = $2 WHERE stripe_account_id = $1 RETURNING 1) SELECT count(*)::int AS n FROM u`,
    [accountRef, payoutsEnabled],
  );
  return row.n;
}
