import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { BarChart, Kpi, Legend, LineChart } from '../components/Charts';
import { categoryLabel } from '@/lib/catalog';
import { PERIODS, pctText, periodLabel } from './SellerAnalytics';

interface Totals {
  orders: number;
  gmvCents: number;
  takeCents: number;
  takeRatePct: number | null;
  avgOrderCents: number | null;
  refunds: number;
  refundedCents: number;
  refundRatePct: number | null;
  disputes: number;
  disputeRatePct: number | null;
  chargebacks: number;
  chargebackRatePct: number | null;
  buyers: number;
  sellers: number;
  newBuyers: number;
  newSellers: number;
}
interface Metrics {
  days: number;
  bucket: 'day' | 'week';
  totals: Totals;
  previous: Totals;
  series: Array<{ date: string; orders: number; gmv_cents: number; take_cents: number; take_rate_pct: number | null; dispute_rate_pct: number | null; chargeback_rate_pct: number | null }>;
  categories: Array<{ category_slug: string; orders: number; gmv_cents: number; take_cents: number; take_rate_pct: number | null; dispute_rate_pct: number | null }>;
  games: Array<{ game: string; orders: number; gmv_cents: number }>;
}

/** Card networks start monitoring merchants at about 0.9% chargebacks (Visa VDMP) / 1% (Mastercard). */
const CB_WATCH = 0.9;

/** Operations → Business: GMV, take rate, dispute and chargeback rates over time. */
export function BusinessPanel() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    setError('');
    api<Metrics>(`/admin/analytics?days=${days}`).then(setData).catch((e) => setError(e.message));
  }, [days]);
  const t = data?.totals;
  const p = data?.previous;
  const per = data?.bucket === 'week' ? 'week' : 'day';

  return (
    <div className="stack">
      <div className="row spread">
        <p className="muted small" style={{ margin: 0 }}>Paid orders, in the settlement currency. Take is commission on orders not refunded or charged back. Compared with the {days} days before.</p>
        <div className="filters" role="group" aria-label="Period" style={{ margin: 0 }}>
          {PERIODS.map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{periodLabel(d)}</button>)}
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      {!data || !t || !p ? (
        <p className="muted">{error ? '' : 'Loading…'}</p>
      ) : (
        <>
          {t.chargebackRatePct != null && t.chargebackRatePct >= CB_WATCH && (
            <div className="alert">Chargeback rate is {pctText(t.chargebackRatePct)} of card orders — at or above the ~{CB_WATCH}% level where card networks start monitoring programmes.</div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="GMV" value={money(t.gmvCents)} now={t.gmvCents} before={p.gmvCents} />
            <Kpi label="Take" value={money(t.takeCents)} now={t.takeCents} before={p.takeCents} />
            <Kpi label="Take rate" value={pctText(t.takeRatePct)} now={t.takeRatePct} before={p.takeRatePct} unit="pts" />
            <Kpi label="Orders" value={t.orders.toLocaleString()} now={t.orders} before={p.orders} />
            <Kpi label="Dispute rate" value={pctText(t.disputeRatePct)} now={t.disputeRatePct} before={p.disputeRatePct} unit="pts" invert />
            <Kpi label="Chargeback rate (card)" value={pctText(t.chargebackRatePct)} now={t.chargebackRatePct} before={p.chargebackRatePct} unit="pts" invert />
            <Kpi label="Refund rate" value={pctText(t.refundRatePct)} now={t.refundRatePct} before={p.refundRatePct} unit="pts" invert />
            <Kpi label="New buyers · sellers" value={`${t.newBuyers} · ${t.newSellers}`} now={t.newBuyers + t.newSellers} before={p.newBuyers + p.newSellers} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card stack" style={{ gap: 10 }}>
              <div className="row spread">
                <b>GMV and take per {per}</b>
                <Legend series={[{ key: 'g', label: 'Seller share', color: 'var(--muted-foreground)' }, { key: 't', label: 'Take', color: 'var(--released)' }]} />
              </div>
              <BarChart
                data={data.series.map((s) => ({ ...s, seller_share: s.gmv_cents - s.take_cents }))}
                series={[{ key: 'take_cents', label: 'Take', color: 'var(--released)' }, { key: 'seller_share', label: 'Seller share', color: 'var(--muted-foreground)' }]}
                format={(v) => money(v)}
                label={`GMV per ${per}`}
              />
            </section>
            <section className="card stack" style={{ gap: 10 }}>
              <div className="row spread">
                <b>Rates per {per}</b>
                <Legend series={[{ key: 't', label: 'Take', color: 'var(--released)' }, { key: 'd', label: 'Disputes', color: 'var(--held)' }, { key: 'c', label: 'Chargebacks', color: 'var(--disputed)' }]} />
              </div>
              <LineChart
                data={data.series}
                series={[
                  { key: 'take_rate_pct', label: 'Take rate', color: 'var(--released)' },
                  { key: 'dispute_rate_pct', label: 'Dispute rate', color: 'var(--held)' },
                  { key: 'chargeback_rate_pct', label: 'Chargeback rate', color: 'var(--disputed)' },
                ]}
                format={(v) => `${v.toFixed(1)}%`}
                label={`Take, dispute and chargeback rates per ${per}`}
              />
            </section>
          </div>
          <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
            <section className="card" style={{ padding: 0 }}>
              <b style={{ display: 'block', padding: '14px 16px 6px' }}>By category</b>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Category</th><th>Orders</th><th>GMV</th><th>Take rate</th><th>Disputes</th></tr></thead>
                  <tbody>
                    {data.categories.map((c) => (
                      <tr key={c.category_slug}>
                        <td>{categoryLabel(c.category_slug)}</td>
                        <td className="mono">{c.orders}</td>
                        <td className="mono">{money(c.gmv_cents)}</td>
                        <td className="mono">{pctText(c.take_rate_pct)}</td>
                        <td className="mono">{pctText(c.dispute_rate_pct)}</td>
                      </tr>
                    ))}
                    {data.categories.length === 0 && <tr><td colSpan={5} className="muted">No paid orders in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card" style={{ padding: 0 }}>
              <b style={{ display: 'block', padding: '14px 16px 6px' }}>Top games</b>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Game</th><th>Orders</th><th>GMV</th></tr></thead>
                  <tbody>
                    {data.games.map((g) => (
                      <tr key={g.game}><td>{g.game}</td><td className="mono">{g.orders}</td><td className="mono">{money(g.gmv_cents)}</td></tr>
                    ))}
                    {data.games.length === 0 && <tr><td colSpan={3} className="muted">No paid orders in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
          <p className="small muted">
            Active in this period: {t.buyers.toLocaleString()} buyers, {t.sellers.toLocaleString()} sellers. Average order {t.avgOrderCents == null ? '—' : money(t.avgOrderCents)}.
            Refunded {money(t.refundedCents)} across {t.refunds} orders.
          </p>
        </>
      )}
    </div>
  );
}
