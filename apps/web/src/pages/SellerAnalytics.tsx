import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { BarChart, Kpi, Legend, LineChart } from '../components/Charts';
import { categoryLabel } from '@/lib/catalog';

interface Totals {
  orders: number;
  grossCents: number;
  netCents: number;
  avgOrderCents: number | null;
  views: number;
  conversionPct: number | null;
  buyers: number;
  repeatBuyers: number;
  repeatBuyerPct: number | null;
  refundRatePct: number | null;
  disputeRatePct: number | null;
}
interface Analytics {
  days: number;
  bucket: 'day' | 'week';
  totals: Totals;
  previous: Totals;
  series: Array<{ date: string; orders: number; gross_cents: number; net_cents: number; views: number; new_buyers: number; returning_buyers: number }>;
  offers: Array<{ id: string; title: string; game: string; category_slug: string; status: string; orders: number; gross_cents: number; views: number; conversion_pct: number | null }>;
}

export const PERIODS = [
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
  [365, '12 months'],
] as const;
export const pctText = (v: number | null) => (v == null ? '—' : `${v.toFixed(v < 10 ? 1 : 0)}%`);

/** Seller hub → Analytics: sales, views and conversion, and new vs returning buyers over time. */
export function SellerAnalytics() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    api<Analytics>(`/seller/analytics?days=${days}`).then(setData).catch((e) => setError(e.message));
  }, [days]);

  const t = data?.totals;
  const p = data?.previous;
  const per = data?.bucket === 'week' ? 'week' : 'day';
  return (
    <div className="stack">
      <div className="row spread">
        <p className="muted small" style={{ margin: 0 }}>Sales count when the buyer pays. Amounts are before refunds unless marked net. Compared with the {days} days before.</p>
        <div className="filters" role="group" aria-label="Period" style={{ margin: 0 }}>
          {PERIODS.map(([d, l]) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{l}</button>)}
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      {!data || !t || !p ? (
        <p className="muted">{error ? '' : 'Loading analytics…'}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Sales" value={money(t.grossCents)} now={t.grossCents} before={p.grossCents} />
            <Kpi label="Orders" value={t.orders.toLocaleString()} now={t.orders} before={p.orders} />
            <Kpi label="Listing views" value={t.views.toLocaleString()} now={t.views} before={p.views} />
            <Kpi label="Conversion" value={pctText(t.conversionPct)} now={t.conversionPct} before={p.conversionPct} unit="pts" />
            <Kpi label="Net earnings" value={money(t.netCents)} now={t.netCents} before={p.netCents} />
            <Kpi label="Average order" value={t.avgOrderCents == null ? '—' : money(t.avgOrderCents)} now={t.avgOrderCents} before={p.avgOrderCents} />
            <Kpi label="Repeat buyers" value={pctText(t.repeatBuyerPct)} now={t.repeatBuyerPct} before={p.repeatBuyerPct} unit="pts" />
            <Kpi label="Refunds · disputes" value={`${pctText(t.refundRatePct)} · ${pctText(t.disputeRatePct)}`} now={null} before={null} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card stack" style={{ gap: 10 }}>
              <div className="row spread"><b>Sales per {per}</b><span className="small muted">{money(t.grossCents)}</span></div>
              <BarChart data={data.series} series={[{ key: 'gross_cents', label: 'Sales', color: 'var(--released)' }]} format={(v) => money(v)} label={`Sales per ${per}`} />
            </section>
            <section className="card stack" style={{ gap: 10 }}>
              <div className="row spread"><b>Conversion per {per}</b><span className="small muted">{t.views.toLocaleString()} views → {t.orders.toLocaleString()} orders</span></div>
              <LineChart
                data={data.series.map((s) => ({ ...s, conversion: s.views ? (s.orders / s.views) * 100 : null }))}
                series={[{ key: 'conversion', label: 'Conversion', color: 'var(--held)' }]}
                format={(v) => `${v.toFixed(1)}%`}
                label={`Orders as a share of listing views, per ${per}`}
              />
            </section>
            <section className="card stack" style={{ gap: 10 }}>
              <div className="row spread">
                <b>New and returning buyers</b>
                <Legend series={[{ key: 'n', label: 'New', color: 'var(--foreground)' }, { key: 'r', label: 'Returning', color: 'var(--released)' }]} />
              </div>
              <BarChart
                data={data.series}
                series={[{ key: 'new_buyers', label: 'New', color: 'var(--foreground)' }, { key: 'returning_buyers', label: 'Returning', color: 'var(--released)' }]}
                label={`New and returning buyers per ${per}`}
              />
              <p className="small muted" style={{ margin: 0 }}>
                {t.buyers ? `${t.repeatBuyers} of ${t.buyers} buyers in this period have bought from you more than once.` : 'No buyers in this period yet.'}
              </p>
            </section>
            <section className="card" style={{ padding: 0 }}>
              <div className="row spread" style={{ padding: '14px 16px 6px' }}><b>Top listings</b><span className="small muted">by sales</span></div>
              {data.offers.length === 0 ? (
                <p className="muted small" style={{ padding: '0 16px 14px' }}>No views or sales in this period.</p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Listing</th><th>Views</th><th>Orders</th><th>Conv.</th><th>Sales</th></tr></thead>
                    <tbody>
                      {data.offers.slice(0, 8).map((o) => (
                        <tr key={o.id}>
                          <td>
                            <Link to={`/offers/${o.id}`}>{o.title}</Link>
                            <div className="small muted">{o.game} · {categoryLabel(o.category_slug)}{o.status !== 'active' ? ` · ${o.status}` : ''}</div>
                          </td>
                          <td className="mono">{o.views}</td>
                          <td className="mono">{o.orders}</td>
                          <td className="mono">{pctText(o.conversion_pct)}</td>
                          <td className="mono">{money(o.gross_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
          <p className="small muted">Views count each visitor once per listing per hour and never include your own visits. Conversion is orders divided by listing views.</p>
        </>
      )}
    </div>
  );
}
