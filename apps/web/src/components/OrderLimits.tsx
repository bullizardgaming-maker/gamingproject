import { t } from '../i18n';

/** Min (default 1) and optional max per order (B1), shared by both listing forms. */
export function OrderLimits({ min, max, onMin, onMax }: { min: string; max: string; onMin: (v: string) => void; onMax: (v: string) => void }) {
  return (
    <>
      <label className="field">
        {t('lst.minPerOrder')}
        <input name="minQty" className="num" type="number" inputMode="numeric" min={1} max={2_000_000_000} step={1} required value={min} onChange={(e) => onMin(e.target.value)} />
      </label>
      <label className="field">
        {t('lst.maxPerOrder')} ({t('sell.f.optional')})
        <input name="maxQty" className="num" type="number" inputMode="numeric" min={Math.max(1, Number(min) || 1)} max={2_000_000_000} step={1} value={max} onChange={(e) => onMax(e.target.value)} />
      </label>
    </>
  );
}

/** Checks min/max per order against each other and the stock; returns an error message or ''. */
export function limitsError(min: string, max: string, stock?: number): string {
  const lo = Math.floor(Number(min));
  if (!(lo >= 1)) return t('lst.minInvalid');
  if (max.trim() && !(Math.floor(Number(max)) >= lo)) return t('lst.maxBelowMin');
  if (stock != null && stock >= 1 && lo > stock) return t('lst.minAboveStock');
  return '';
}
