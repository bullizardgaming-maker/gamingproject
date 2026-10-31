/**
 * Round 28: when the stock left is below the seller's minimum per order, the minimum becomes the stock left (the
 * seller's own minimum comes back when they restock). At 0 the listing is sold out and leaves the market.
 */
export function effectiveMin(o: { min_qty?: number | string | null; stock?: number | string | null; effective_min_qty?: number | string | null }): number {
  if (o.effective_min_qty != null) return Math.max(1, Number(o.effective_min_qty));
  const min = Math.max(1, Number(o.min_qty ?? 1));
  const stock = Number(o.stock ?? 0);
  return stock > 0 ? Math.min(min, stock) : min;
}
export const soldOut = (o: { stock?: number | string | null }) => Number(o.stock ?? 0) <= 0;
