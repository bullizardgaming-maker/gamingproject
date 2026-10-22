import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { BarChart, Kpi, Legend, LineChart } from '../components/Charts';
import { categoryLabel } from '@/lib/catalog';
import { t as tr, type MessageKey } from '../i18n';

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

export const PERIODS = [7, 30, 90, 365] as const;
export const periodLabel = (d: number) => tr(`an.period_${d}` as MessageKey);
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
        <p className="muted small" style={{ margin: 0 }}>{tr('an.intro', { days })}</p>
        <div className="filters" role="group" aria-label={tr('an.period')} style={{ margin: 0 }}>
          {PERIODS.map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{periodLabel(d)}</button>)}
        </div>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {!data || !t || !p ? (
        <p className="muted">{error ? '' : tr('an.loading')}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label={tr('an.sales')} value={money(t.grossCents)} now={t.grossCents} before={p.grossCents} />
            <Kpi label={tr('nav.orders')} value={t.orders.toLocaleString()} now={t.orders} before={p.orders} />
            <Kpi label={tr('an.views')} value={t.views.toLocaleString()} now={t.views} before={p.views} />
            <Kpi label={tr('an.conversion')} value={pctText(t.conversionPct)} now={t.conversionPct} before={p.conversionPct} unit="pts" />
            <Kpi label={tr('an.net')} value={money(t.netCents)} now={t.netCents} before={p.netCents} />
            <Kpi label={tr('an.avg')} value={t.avgOrderCents == null ? '—' : money(t.avgOrderCents)} now={t.avgOrderCents} before={p.avgOrderCents} />
            <Kpi label={tr('an.repeat')} value={pctText(t.repeatBuyerPct)} now={t.repeatBuyerPct} before={p.repeatBuyerPct} unit="pts" />
            <Kpi label={tr('an.refunds')} value={`${pctText(t.refundRatePct)} · ${pctText(t.disputeRatePct)}`} now={null} before={null} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card stack" style={{ gap: 10 }}>
              <div className="row spread"><b>{per === 'week' ? tr('an.salesPerWeek') : tr('an.salesPerDay')}</b><span className="small muted">{money(t.grossCents)}</span></div>
              <BarChart data={data.series} series={[{ key: 'gross_cents', label: tr('an.sales'), color: 'var(--released)' }]} format={(v) => money(v)} label={per === 'week' ? tr('an.salesPerWeek') : tr('an.salesPerDay')} />
            </section>
            <section className="card stack" style={{ gap: 10 }}>
              <div className="row spread"><b>{per === 'week' ? tr('an.convPerWeek') : tr('an.convPerDay')}</b><span className="small muted">{tr('an.viewsToOrders', { views: t.views, orders: t.orders })}</span></div>
              <LineChart
                data={data.series.map((s) => ({ ...s, conversion: s.views ? (s.orders / s.views) * 100 : null }))}
                series={[{ key: 'conversion', label: tr('an.conversion'), color: 'var(--held)' }]}
                format={(v) => `${v.toFixed(1)}%`}
                label={tr('an.convLabel')}
              />
            </section>
            <section className="card stack" style={{ gap: 10 }}>
              <div className="row spread">
                <b>{tr('an.buyers')}</b>
                <Legend series={[{ key: 'n', label: tr('an.new'), color: 'var(--foreground)' }, { key: 'r', label: tr('an.returning'), color: 'var(--released)' }]} />
              </div>
              <BarChart
                data={data.series}
                series={[{ key: 'new_buyers', label: tr('an.new'), color: 'var(--foreground)' }, { key: 'returning_buyers', label: tr('an.returning'), color: 'var(--released)' }]}
                label={tr('an.buyers')}
              />
              <p className="small muted" style={{ margin: 0 }}>
                {t.buyers ? tr('an.repeatLine', { repeat: t.repeatBuyers, buyers: t.buyers }) : tr('an.noBuyers')}
              </p>
            </section>
            <section className="card" style={{ padding: 0 }}>
              <div className="row spread" style={{ padding: '14px 16px 6px' }}><b>{tr('an.top')}</b><span className="small muted">{tr('an.bySales')}</span></div>
              {data.offers.length === 0 ? (
                <p className="muted small" style={{ padding: '0 16px 14px' }}>{tr('an.noTop')}</p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>{tr('sell.col.listing')}</th><th>{tr('an.col.views')}</th><th>{tr('nav.orders')}</th><th>{tr('an.col.conv')}</th><th>{tr('an.sales')}</th></tr></thead>
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
          <p className="small muted">{tr('an.footnote')}</p>
        </>
      )}
    </div>
  );
}
