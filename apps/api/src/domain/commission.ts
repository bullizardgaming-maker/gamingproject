import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { getRate, supportedCurrencies } from './fx.js';

/**
 * Commission (migration 055). A gross-up on top of the seller's price: the buyer pays
 * seller price / (1 - rate); the seller receives their price in full and the difference is the
 * commission. The rate is the seller's rank rate, or the launch promo rate during a new seller's
 * first `promo_days` (counted from their first listing). Ranks are rows staff can edit.
 */
export interface SellerRank {
  position: number;
  name: string;
  minMonthlySalesCents: number;
  rateBps: number;
  perks: string[];
}
/** Kept for callers that still speak in "tiers": a rank with the old field names. */
export type SellerTier = SellerRank & { minMonthlySalesCents: number; accountRateBps: number; otherRateBps: number };

export const DEFAULT_RATE_BPS = 1399;

const toRank = (r: any): SellerRank => ({ position: Number(r.position), name: r.name, minMonthlySalesCents: Number(r.min_monthly_sales_cents), rateBps: Number(r.rate_bps), perks: r.perks ?? [] });
const asTier = (r: SellerRank): SellerTier => ({ ...r, accountRateBps: r.rateBps, otherRateBps: r.rateBps });

export async function listRanks(q: Queryable): Promise<SellerRank[]> {
  return (await many(q, 'SELECT * FROM seller_ranks ORDER BY position')).map(toRank);
}

export async function commissionSettings(q: Queryable) {
  const r = await one<{ promo_rate_bps: number; promo_days: number }>(q, 'SELECT promo_rate_bps, promo_days FROM commission_settings');
  return { promoRateBps: Number(r.promo_rate_bps), promoDays: Number(r.promo_days) };
}

/** Staff set the rank table (names fixed to five positions; thresholds must rise with position). */
export async function updateRanks(ctx: Ctx, ranks: Array<{ position: number; name: string; minMonthlySalesCents: number; rateBps: number; perks?: string[] }>, settings?: { promoRateBps?: number; promoDays?: number }) {
  const sorted = [...ranks].sort((a, b) => a.position - b.position);
  if (sorted.length !== 5 || sorted.some((r, i) => r.position !== i + 1)) throw badRequest('invalid_ranks', 'Send all five ranks, positions 1 to 5');
  if (sorted[0]!.minMonthlySalesCents !== 0) throw badRequest('invalid_ranks', 'The first rank starts at 0');
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.minMonthlySalesCents <= sorted[i - 1]!.minMonthlySalesCents) throw badRequest('invalid_ranks', 'Thresholds must increase with each rank');
    if (sorted[i]!.rateBps > sorted[i - 1]!.rateBps) throw badRequest('invalid_ranks', 'Rates must not rise with rank');
  }
  await ctx.db.query('BEGIN');
  try {
    for (const r of sorted) {
      await ctx.db.query('UPDATE seller_ranks SET name = $2, min_monthly_sales_cents = $3, rate_bps = $4, perks = $5, updated_at = now() WHERE position = $1', [r.position, r.name.trim(), r.minMonthlySalesCents, r.rateBps, r.perks ?? []]);
    }
    if (settings) {
      await ctx.db.query('UPDATE commission_settings SET promo_rate_bps = COALESCE($1, promo_rate_bps), promo_days = COALESCE($2, promo_days), updated_at = now()', [settings.promoRateBps ?? null, settings.promoDays ?? null]);
    }
    await ctx.db.query('COMMIT');
  } catch (err) {
    await ctx.db.query('ROLLBACK');
    throw err;
  }
  // Rates follow the new table on the next refresh; force it now so listings change at once.
  await refreshSellerRates(ctx, { all: true });
  return { ranks: await listRanks(ctx.db), settings: await commissionSettings(ctx.db) };
}

export function rankForVolume(ranks: SellerRank[], monthlySalesCents: number): SellerRank {
  let rank = ranks[0]!;
  for (const r of ranks) if (monthlySalesCents >= r.minMonthlySalesCents) rank = r;
  return rank;
}

export function nextRank(ranks: SellerRank[], rank: SellerRank): SellerRank | null {
  return ranks.find((r) => r.position === rank.position + 1) ?? null;
}

/** Buyer price for a seller price at a rate: ceil so the seller never receives less than their price. */
export function grossUp(sellerCents: number, rateBps: number): number {
  return Math.ceil((sellerCents * 10_000) / (10_000 - rateBps));
}

/** Splits a buyer total: the seller receives their price exactly; the rest is commission. */
export function splitGross(buyerCents: number, sellerCents: number) {
  return { commissionCents: buyerCents - sellerCents, sellerNetCents: sellerCents };
}

/** SQL for the buyer price of an expression in seller cents, given the seller row alias `u`. */
export const GROSS_SQL = (expr: string, userAlias = 'u') => `CEIL((${expr}) * 10000.0 / (10000 - ${userAlias}.commission_rate_bps))::bigint`;

export async function monthlySalesCents(q: Queryable, sellerId: string): Promise<number> {
  const row = await one<{ total: number }>(
    q,
    `SELECT COALESCE(SUM(seller_net_cents), 0)::bigint AS total FROM orders
      WHERE seller_id = $1 AND status = 'completed' AND completed_at > now() - interval '30 days'`,
    [sellerId],
  );
  return Number(row.total);
}

/** The seller's rank, rate (promo-aware) and progress to the next rank. */
export async function sellerTier(q: Queryable, sellerId: string) {
  const [ranks, settings, volume, u] = await Promise.all([
    listRanks(q),
    commissionSettings(q),
    monthlySalesCents(q, sellerId),
    one<{ seller_since: string | null }>(q, 'SELECT seller_since FROM users WHERE id = $1', [sellerId]),
  ]);
  const rank = rankForVolume(ranks, volume);
  const next = nextRank(ranks, rank);
  const promoEndsAt = u.seller_since ? new Date(new Date(u.seller_since).getTime() + settings.promoDays * 86_400_000) : null;
  const promo = !!promoEndsAt && promoEndsAt > new Date();
  const rateBps = promo ? Math.min(settings.promoRateBps, rank.rateBps) : rank.rateBps;
  return {
    tier: asTier(rank),
    rank,
    rateBps,
    promo: promo ? { rateBps: settings.promoRateBps, endsAt: promoEndsAt!.toISOString() } : null,
    monthlySalesCents: volume,
    next: next ? { tier: asTier(next), rank: next, remainingCents: next.minMonthlySalesCents - volume } : null,
  };
}

/** Stores the seller's current rate and rank on the user row (listings read it in SQL). */
export async function refreshSellerRate(q: Queryable, sellerId: string) {
  const t = await sellerTier(q, sellerId);
  await q.query(
    `UPDATE users SET commission_rate_bps = $2, seller_rank = $3, commission_computed_at = now(),
            badges = COALESCE((SELECT array_agg(b) FROM unnest(badges) b WHERE b NOT LIKE 'rank:%' OR b = 'rank:' || lower($3)), '{}')
      WHERE id = $1`,
    [sellerId, t.rateBps, t.rank.name],
  );
  return t;
}

let lastRefresh = 0;
/** Worker: refresh sellers whose rate is stale (hourly), or everyone after a rank change. */
export async function refreshSellerRates(ctx: Ctx, opts: { all?: boolean } = {}) {
  if (!opts.all && Date.now() - lastRefresh < 10 * 60_000) return null;
  lastRefresh = Date.now();
  const sellers = await many<{ id: string }>(
    ctx.db,
    opts.all
      ? `SELECT id FROM users WHERE seller_since IS NOT NULL OR kyc_tier >= 2`
      : `SELECT id FROM users WHERE (seller_since IS NOT NULL OR kyc_tier >= 2) AND (commission_computed_at IS NULL OR commission_computed_at < now() - interval '1 hour') LIMIT 2000`,
  );
  let n = 0;
  for (const s of sellers) {
    await refreshSellerRate(ctx.db, s.id);
    n++;
  }
  return n;
}

/** Called when a user lists for the first time: starts the promo clock and sets the promo rate. */
export async function markSellerSince(q: Queryable, sellerId: string) {
  // The first listing starts the promo clock and, inside the launch window, makes a Founding Seller.
  const r = await q.query('UPDATE users SET seller_since = now(), founding = now() <= (SELECT founding_until FROM launch_settings) WHERE id = $1 AND seller_since IS NULL', [sellerId]);
  if (r.rowCount) await refreshSellerRate(q, sellerId);
}

/** Preview for the sell form: what the buyer pays and what the seller keeps after the withdrawal fee. */
export async function pricePreview(ctx: Ctx, sellerId: string, sellerCents: number, listingCurrency = ctx.cfg.SETTLEMENT_CURRENCY) {
  const t = await sellerTier(ctx.db, sellerId);
  // The seller's price in the settlement currency, as priceOrder() will compute it.
  const listingRate = await getRate(ctx, ctx.db, listingCurrency);
  const settlementCents = Math.round(sellerCents / listingRate);
  const buyer = grossUp(settlementCents, t.rateBps);
  const fee = Math.min(settlementCents, Math.max(ctx.cfg.WITHDRAWAL_FEE_MIN_CENTS, Math.ceil((settlementCents * ctx.cfg.WITHDRAWAL_FEE_BPS) / 10_000)));
  // What buyers in each supported currency see: the grossed-up price converted with the checkout spread.
  const buyerIn: Record<string, number> = {};
  for (const c of supportedCurrencies(ctx)) {
    try {
      const rate = c === ctx.cfg.SETTLEMENT_CURRENCY ? 1 : (await getRate(ctx, ctx.db, c)) * (1 + ctx.cfg.FX_SPREAD_BPS / 10_000);
      buyerIn[c] = Math.round(buyer * rate);
    } catch {
      // a stale rate just leaves that currency out of the preview
    }
  }
  return {
    sellerCents, listingCurrency, settlementCurrency: ctx.cfg.SETTLEMENT_CURRENCY, settlementCents, rateBps: t.rateBps, promo: t.promo, rank: t.rank.name,
    buyerCents: buyer, buyerIn, commissionCents: buyer - settlementCents,
    withdrawalFeeBps: ctx.cfg.WITHDRAWAL_FEE_BPS, withdrawalFeeCents: fee, afterWithdrawalCents: settlementCents - fee,
  };
}

/** Founding Sellers: joined during the launch window; free featured spots while it runs. */
export async function foundingSettings(q: Queryable) {
  const r = await one<{ founding_until: string; founding_featured_slots: number; featured_days: number }>(q, 'SELECT founding_until, founding_featured_slots, featured_days FROM launch_settings');
  return { foundingUntil: r.founding_until, featuredSlots: Number(r.founding_featured_slots), featuredDays: Number(r.featured_days) };
}

export async function foundingStatus(q: Queryable, sellerId: string) {
  const [s, u] = await Promise.all([foundingSettings(q), one<{ founding: boolean; featured: number }>(q, `SELECT founding, (SELECT count(*)::int FROM offers f WHERE f.seller_id = users.id AND f.featured_until > now()) AS featured FROM users WHERE id = $1`, [sellerId])]);
  const windowOpen = new Date(s.foundingUntil) > new Date();
  return { founding: u.founding, foundingUntil: s.foundingUntil, windowOpen, featuredSlots: u.founding && windowOpen ? s.featuredSlots : 0, featuredUsed: Number(u.featured), featuredDays: s.featuredDays };
}

/** A founding seller puts one of their listings in a free featured spot for `featured_days`. */
export async function featureListing(ctx: Ctx, sellerId: string, offerId: string) {
  const st = await foundingStatus(ctx.db, sellerId);
  if (!st.founding) throw badRequest('not_founding', 'Featured spots are free for Founding Sellers during the launch; paid spots come later');
  if (!st.windowOpen) throw badRequest('promo_over', 'The launch promo has ended, so free featured spots are closed');
  const offer = await one<{ id: string; featured_until: string | null }>(ctx.db, `SELECT id, featured_until FROM offers WHERE id = $1 AND seller_id = $2 AND status = 'active'`, [offerId, sellerId]).catch(() => {
    throw badRequest('invalid_offer', 'Feature one of your active listings');
  });
  const live = offer.featured_until && new Date(offer.featured_until) > new Date();
  if (!live && st.featuredUsed >= st.featuredSlots) throw badRequest('no_slots', `You can feature ${st.featuredSlots} listing${st.featuredSlots === 1 ? '' : 's'} at a time; unfeature one first`);
  await ctx.db.query(`UPDATE offers SET featured_until = now() + make_interval(days => $2), version = version + 1, updated_at = now() WHERE id = $1`, [offerId, st.featuredDays]);
  return foundingStatus(ctx.db, sellerId);
}

export async function unfeatureListing(ctx: Ctx, sellerId: string, offerId: string) {
  await ctx.db.query(`UPDATE offers SET featured_until = NULL, version = version + 1, updated_at = now() WHERE id = $1 AND seller_id = $2`, [offerId, sellerId]);
  return foundingStatus(ctx.db, sellerId);
}
