import type { Queryable } from '../db.js';
import { one } from '../db.js';
import { badRequest } from '../lib/errors.js';

/**
 * Seller badges: the ones a seller has earned, and the two they chose to show next to their
 * name on listings and their profile (`users.badges`). Earned = rank (always), Founding
 * Seller, ID verified (KYC tier 2) and Top seller (trust level "top").
 */
export const MAX_SHOWN_BADGES = 2;

export interface Badge {
  key: string;
  label: string;
}

export async function earnedBadges(q: Queryable, sellerId: string): Promise<Badge[]> {
  const u = await one<{ seller_rank: string; founding: boolean; kyc_tier: number; trust_level: string }>(
    q,
    'SELECT seller_rank, founding, kyc_tier, trust_level FROM users WHERE id = $1',
    [sellerId],
  );
  const out: Badge[] = [{ key: `rank:${u.seller_rank.toLowerCase()}`, label: u.seller_rank }];
  if (u.founding) out.push({ key: 'founding', label: 'Founding Seller' });
  if (u.kyc_tier >= 2) out.push({ key: 'id_verified', label: 'ID verified' });
  if (u.trust_level === 'top') out.push({ key: 'top_seller', label: 'Top seller' });
  return out;
}

/** The badges the seller shows, pruned to what they still hold (a lost rank drops off on its own). */
export async function shownBadges(q: Queryable, sellerId: string): Promise<string[]> {
  const [earned, u] = await Promise.all([earnedBadges(q, sellerId), one<{ badges: string[] }>(q, 'SELECT badges FROM users WHERE id = $1', [sellerId])]);
  const keys = new Set(earned.map((b) => b.key));
  return u.badges.filter((b) => keys.has(b)).slice(0, MAX_SHOWN_BADGES);
}

export async function setShownBadges(q: Queryable, sellerId: string, badges: string[]) {
  const keys = [...new Set(badges)];
  if (keys.length > MAX_SHOWN_BADGES) throw badRequest('too_many_badges', `Show up to ${MAX_SHOWN_BADGES} badges`);
  const earned = new Set((await earnedBadges(q, sellerId)).map((b) => b.key));
  const bad = keys.find((k) => !earned.has(k));
  if (bad) throw badRequest('badge_not_earned', `You haven’t earned the "${bad}" badge`);
  await q.query('UPDATE users SET badges = $2 WHERE id = $1', [sellerId, keys]);
  return { badges: keys, earned: await earnedBadges(q, sellerId) };
}
