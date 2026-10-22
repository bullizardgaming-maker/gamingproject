import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { PriceChart } from './PriceChart';
import { categoryLabel } from '@/lib/catalog';
import { t } from '../i18n';

const DAYS = 90;

/** A listing's price over the last 90 days, or one line when it hasn't changed. */
export function OfferPriceHistory({ offerId, game }: { offerId: string; game: string }) {
  const [data, setData] = useState<{ currency: string | null; points: Array<{ at: string; price_cents: number }> } | null>(null);
  useEffect(() => {
    setData(null);
    api<typeof data>(`/offers/${offerId}/price-history?days=${DAYS}`).then(setData).catch(() => {});
  }, [offerId]);
  if (!data?.currency || !data.points.length) return null;
  const pts = data.points.map((p) => ({ t: Date.parse(p.at), v: p.price_cents }));
  const now = pts.at(-1)!.v;
  const low = Math.min(...pts.map((p) => p.v));
  return (
    <section className="card stack" aria-labelledby="price-history-title" style={{ gap: 10 }}>
      <div>
        <h3 id="price-history-title" style={{ margin: 0 }}>{t('history.offerTitle')}</h3>
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          {pts.length < 2
            ? t('history.unchanged', { date: new Date(pts[0]!.t).toLocaleDateString() })
            : now <= low
              ? t('history.atLow', { days: DAYS })
              : t('history.lowWas', { days: DAYS, price: money(low, data.currency) })}
        </p>
      </div>
      {pts.length > 1 && (
        <PriceChart
          series={[{ key: 'price', label: t('history.price'), color: 'var(--viz-1)', points: pts, step: true }]}
          currency={data.currency}
          from={Date.now() - DAYS * 86_400_000}
          to={Date.now()}
          label={t('history.offerAria', { game, now: money(now, data.currency), low: money(low, data.currency), days: DAYS })}
        />
      )}
    </section>
  );
}

/** Lowest and median price per day in one game and category. */
export function MarketPriceHistory({ game, category }: { game: string; category: string }) {
  const [data, setData] = useState<{ currency: string; points: Array<{ day: string; min_cents: number; median_cents: number }> } | null>(null);
  useEffect(() => {
    setData(null);
    api<typeof data>(`/catalog/price-history?${new URLSearchParams({ game, category, days: String(DAYS) })}`).then(setData).catch(() => {});
  }, [game, category]);
  if (!data || data.points.length < 2) return null;
  const at = (d: string) => Date.parse(`${d}T12:00:00Z`);
  const min = data.points.map((p) => ({ t: at(p.day), v: p.min_cents }));
  const median = data.points.map((p) => ({ t: at(p.day), v: p.median_cents }));
  const what = `${game} · ${categoryLabel(category)}`;
  return (
    <details className="card" style={{ padding: '12px 16px' }}>
      <summary className="cursor-pointer font-medium">{t('history.marketTitle', { what })}</summary>
      <div style={{ marginTop: 12 }}>
        <PriceChart
          series={[
            { key: 'min', label: t('history.lowest'), color: 'var(--viz-1)', points: min },
            { key: 'median', label: t('history.median'), color: 'var(--viz-2)', points: median },
          ]}
          currency={data.currency}
          from={min[0]!.t}
          to={min.at(-1)!.t}
          label={t('history.marketAria', { what, low: money(min.at(-1)!.v, data.currency), median: money(median.at(-1)!.v, data.currency) })}
        />
      </div>
    </details>
  );
}
