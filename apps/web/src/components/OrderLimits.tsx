import { t } from '../i18n';

/** Minimum per order (default 1). Round 26b: no max per order; the max is the seller's stock. */
export function MinPerOrder({ min, onMin }: { min: string; onMin: (v: string) => void }) {
  return (
    <label className="field">
      {t('lst.minPerOrder')}
      <input name="minQty" className="num" type="number" inputMode="numeric" min={1} max={2_000_000_000} step={1} required value={min} onChange={(e) => onMin(e.target.value)} />
    </label>
  );
}

/** Checks the minimum per order against the stock; returns an error message or ''. */
export function limitsError(min: string, stock?: number): string {
  const lo = Math.floor(Number(min));
  if (!(lo >= 1)) return t('lst.minInvalid');
  if (stock != null && stock >= 1 && lo > stock) return t('lst.minAboveStock');
  return '';
}
