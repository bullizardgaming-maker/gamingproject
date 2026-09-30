import { isIP } from 'node:net';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, one } from '../db.js';
import type { TxScope } from './events.js';

export type SignalKind = 'device' | 'ip_subnet' | 'wallet' | 'card';

/** Loopback, private, link-local and CGNAT addresses (our own network, not a client's). */
function isInternalAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** Collapse an IP to its /24 (IPv4) or /48 (IPv6) — the granularity at which proxy farms cluster. */
export function subnetOf(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  // Loopback/private addresses carry no signal (local dev, internal proxies).
  if (isInternalAddress(clean)) return null;
  if (isIP(clean) === 4) return clean.split('.').slice(0, 3).join('.') + '.0/24';
  if (isIP(clean) === 6) {
    const parts = clean.split(':');
    return parts.slice(0, 3).join(':') + '::/48';
  }
  return null;
}

export async function recordSignals(q: Queryable, userId: string, signals: Partial<Record<SignalKind, string | null | undefined>>) {
  for (const [kind, value] of Object.entries(signals)) {
    if (!value) continue;
    await q.query(
      `INSERT INTO risk_signals (user_id, kind, value) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, kind, value) DO UPDATE SET last_seen = now()`,
      [userId, kind, value],
    );
  }
}

export interface RiskAssessment {
  score: number;
  reasons: Array<{ code: string; weight: number; detail?: unknown }>;
  source: 'heuristic' | 'gnn' | 'combined';
}

/** Union-find over users joined by shared infrastructure. */
class DisjointSet {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string) {
    this.parent.set(this.find(a), this.find(b));
  }
}

/**
 * Real-time "Syndicate Risk Score".
 *
 * Builds the local heterogeneous graph around the order — the seller, every
 * buyer who paid that seller in the last 72h, and the devices / IP subnets /
 * cards / wallets they touch — then looks for tightly connected buyer clusters
 * funnelling money into one (often new) seller. Signals are combined with a
 * noisy-OR so independent weak evidence compounds.
 *
 * This runs inline on every payment. The offline HGT model in
 * services/fraud-gnn scores the same graph with learned attention weights; when
 * FRAUD_GNN_URL is set its score is blended in (max of the two).
 */
export async function heuristicScore(q: Queryable, orderId: string): Promise<RiskAssessment> {
  const order = await one<{ buyer_id: string; seller_id: string; amount_cents: number; seller_created: string; buyer_created: string }>(
    q,
    `SELECT o.buyer_id, o.seller_id, o.amount_cents, s.created_at AS seller_created, b.created_at AS buyer_created
       FROM orders o JOIN users s ON s.id = o.seller_id JOIN users b ON b.id = o.buyer_id WHERE o.id = $1`,
    [orderId],
  );
  const reasons: RiskAssessment['reasons'] = [];
  const hoursSince = (t: string) => (Date.now() - new Date(t).getTime()) / 3_600_000;

  // 1. Buyer and seller share infrastructure -> self-dealing / wash trading / card testing.
  const shared = await many<{ kind: string }>(
    q,
    `SELECT DISTINCT a.kind FROM risk_signals a JOIN risk_signals b ON a.kind = b.kind AND a.value = b.value
      WHERE a.user_id = $1 AND b.user_id = $2`,
    [order.buyer_id, order.seller_id],
  );
  // A shared device/card/wallet is strong evidence; a shared /24 alone (CGNAT, campus networks) is weak.
  if (shared.length) {
    const strong = shared.some((s) => s.kind !== 'ip_subnet');
    reasons.push({ code: 'buyer_seller_shared_infra', weight: strong ? 0.6 : 0.2, detail: shared.map((s) => s.kind) });
  }

  // 2. Buyer cluster around this seller.
  const buyers = await many<{ buyer_id: string }>(
    q,
    `SELECT DISTINCT buyer_id FROM orders
      WHERE seller_id = $1 AND paid_at > now() - interval '72 hours' AND status NOT IN ('awaiting_payment', 'cancelled')
     UNION SELECT $2::uuid`,
    [order.seller_id, order.buyer_id],
  );
  const buyerIds = buyers.map((b) => b.buyer_id);
  const edges = await many<{ a: string; b: string }>(
    q,
    `SELECT DISTINCT x.user_id AS a, y.user_id AS b FROM risk_signals x
       JOIN risk_signals y ON x.kind = y.kind AND x.value = y.value AND x.user_id < y.user_id
      WHERE x.user_id = ANY($1::uuid[]) AND y.user_id = ANY($1::uuid[])`,
    [buyerIds],
  );
  const ds = new DisjointSet();
  for (const e of edges) ds.union(e.a, e.b);
  const root = ds.find(order.buyer_id);
  const clusterSize = buyerIds.filter((b) => ds.find(b) === root).length;
  if (clusterSize >= 3) {
    reasons.push({ code: 'buyer_syndicate_cluster', weight: Math.min(0.85, 0.2 * (clusterSize - 1)), detail: { clusterSize, buyersLast72h: buyerIds.length } });
  }

  // 3. New seller receiving concentrated volume.
  if (hoursSince(order.seller_created) < 24 * 7) {
    reasons.push({ code: 'new_seller', weight: buyerIds.length >= 5 ? 0.35 : 0.1, detail: { buyersLast72h: buyerIds.length } });
  }

  // 4. Fresh buyer account making a large purchase.
  if (hoursSince(order.buyer_created) < 24 && order.amount_cents >= 200_00) {
    reasons.push({ code: 'new_buyer_high_value', weight: 0.25 });
  }

  // 5. Buyer velocity.
  const velocity = await one<{ n: number }>(
    q,
    `SELECT count(*)::int AS n FROM orders WHERE buyer_id = $1 AND created_at > now() - interval '1 hour'`,
    [order.buyer_id],
  );
  if (velocity.n > 5) reasons.push({ code: 'buyer_velocity', weight: Math.min(0.4, 0.05 * velocity.n), detail: { ordersLastHour: velocity.n } });

  // 6. Infrastructure previously linked to confirmed fraud, chargebacks or suspended accounts.
  const tainted = await one<{ n: number }>(
    q,
    `SELECT count(DISTINCT other.user_id)::int AS n
       FROM risk_signals mine
       JOIN risk_signals other ON other.kind = mine.kind AND other.value = mine.value AND other.user_id <> mine.user_id
       JOIN users u ON u.id = other.user_id
      WHERE mine.user_id = $1
        AND (u.status = 'suspended'
             OR EXISTS (SELECT 1 FROM risk_flags f WHERE f.user_id = u.id AND f.status = 'confirmed')
             OR EXISTS (SELECT 1 FROM orders o2 WHERE o2.buyer_id = u.id AND o2.status = 'charged_back'))`,
    [order.buyer_id],
  );
  if (tainted.n > 0) reasons.push({ code: 'linked_to_bad_actor', weight: 0.5, detail: { linkedAccounts: tainted.n } });

  const score = 1 - reasons.reduce((p, r) => p * (1 - r.weight), 1);
  return { score: Math.round(score * 10_000) / 10_000, reasons, source: 'heuristic' };
}

async function gnnScore(ctx: Ctx, orderId: string): Promise<RiskAssessment | null> {
  if (!ctx.cfg.FRAUD_GNN_URL) return null;
  try {
    const res = await fetch(`${ctx.cfg.FRAUD_GNN_URL}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId }),
      signal: AbortSignal.timeout(400),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { score: number; reasons?: RiskAssessment['reasons'] };
    return { score: body.score, reasons: body.reasons ?? [{ code: 'gnn_syndicate_score', weight: body.score }], source: 'gnn' };
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'GNN scorer unavailable, using heuristic only');
    return null;
  }
}

export async function assessOrder(ctx: Ctx, q: Queryable, orderId: string): Promise<RiskAssessment> {
  const [h, g] = await Promise.all([heuristicScore(q, orderId), gnnScore(ctx, orderId)]);
  if (!g) return h;
  return { score: Math.max(h.score, g.score), reasons: [...h.reasons, ...g.reasons], source: 'combined' };
}

/**
 * Act on a score. Above the review threshold the order's escrow is frozen and
 * flagged. Above the freeze threshold the seller's withdrawals and *all* their
 * open escrows are frozen, stopping cash-out before chargebacks land.
 */
export async function applyRiskActions(ctx: Ctx, s: TxScope, order: { id: string; buyer_id: string; seller_id: string }, risk: RiskAssessment) {
  await s.tx.query('UPDATE orders SET risk_score = $2 WHERE id = $1', [order.id, risk.score]);
  if (risk.score < ctx.cfg.FRAUD_REVIEW_THRESHOLD) return { action: 'none' as const };

  await s.tx.query('UPDATE orders SET escrow_frozen = true WHERE id = $1', [order.id]);
  await s.tx.query(
    'INSERT INTO risk_flags (user_id, order_id, score, reasons) VALUES ($1, $2, $3, $4), ($5, $2, $3, $4)',
    [order.buyer_id, order.id, risk.score, JSON.stringify(risk.reasons), order.seller_id],
  );
  if (risk.score < ctx.cfg.FRAUD_FREEZE_THRESHOLD) return { action: 'review' as const };

  await s.tx.query('UPDATE users SET withdrawals_frozen = true WHERE id = $1', [order.seller_id]);
  await s.tx.query(
    `UPDATE orders SET escrow_frozen = true WHERE seller_id = $1 AND status IN ('paid', 'delivered', 'disputed')`,
    [order.seller_id],
  );
  ctx.log.warn({ orderId: order.id, score: risk.score }, 'syndicate risk threshold breached: seller frozen');
  return { action: 'freeze' as const };
}
