import { useEffect, useState } from 'react';
import { api } from '../api';
import { Kpi, Legend, LineChart } from '../components/Charts';
import { pctText } from './SellerAnalytics';

interface Cohort { cohort: string; size: number; retained: number[] }
interface Month {
  month: string;
  active_buyers: number;
  returning_buyers: number;
  returning_pct: number | null;
  active_sellers: number;
  new_sellers: number;
  sellers_last_month: number;
  /** The running month: counts so far, and no churn figure until it ends. */
  partial: boolean;
  churned_sellers: number | null;
  seller_churn_pct: number | null;
}
interface Retention {
  months: number;
  buyerCohorts: Cohort[];
  sellerCohorts: Cohort[];
  series: Month[];
  repeat: Array<{ cohort: string; buyers: number; repeat_90d: number; repeat_pct: number | null; complete: boolean }>;
  repeat90dPct: number | null;
}

const RANGES = [6, 12, 24] as const;
const monthName = (ym: string) => new Date(`${ym.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

/** One hue, stronger for higher retention; the number is always printed, so colour is never the only cue. */
function Cell({ n, size }: { n: number; size: number }) {
  const pct = size ? (n / size) * 100 : 0;
  const strong = pct >= 55;
  return (
    <td
      className="mono text-center"
      style={{ background: size ? `color-mix(in srgb, var(--viz-1) ${Math.round(8 + pct * 0.8)}%, transparent)` : undefined, color: strong ? '#fff' : undefined, minWidth: 52 }}
      title={size ? `${n} of ${size}` : undefined}
    >
      {size ? `${Math.round(pct)}%` : ''}
    </td>
  );
}

function CohortTable({ cohorts, who, repeat }: { cohorts: Cohort[]; who: 'buyers' | 'sellers'; repeat?: Retention['repeat'] }) {
  const width = cohorts[0]?.retained.length ?? 0;
  const rep = new Map(repeat?.map((r) => [r.cohort, r]));
  return (
    <div className="table-wrap">
      <table className="data" aria-label={`${who === 'buyers' ? 'Buyer' : 'Seller'} cohorts: share still active each month after their first ${who === 'buyers' ? 'purchase' : 'sale'}`}>
        <thead>
          <tr>
            <th scope="col">First {who === 'buyers' ? 'purchase' : 'sale'}</th>
            <th scope="col">{who === 'buyers' ? 'Buyers' : 'Sellers'}</th>
            {Array.from({ length: width }, (_, k) => <th key={k} scope="col" className="text-center">{k === 0 ? 'M0' : `+${k}`}</th>)}
            {repeat && <th scope="col" title="Placed a second order within 90 days of the first">Repeat ≤90d</th>}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => {
            const r = rep.get(c.cohort);
            return (
              <tr key={c.cohort}>
                <th scope="row" className="font-normal">{monthName(c.cohort)}</th>
                <td className="mono">{c.size}</td>
                {Array.from({ length: width }, (_, k) => (k < c.retained.length ? <Cell key={k} n={c.retained[k]!} size={c.size} /> : <td key={k} />))}
                {repeat && <td className="mono">{r?.buyers ? `${pctText(r.repeat_pct)}${r.complete ? '' : ' *'}` : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Operations → Retention: monthly cohorts, returning buyers, repeat rate and seller churn. */
export function RetentionPanel() {
  const [months, setMonths] = useState<number>(12);
  const [who, setWho] = useState<'buyers' | 'sellers'>('buyers');
  const [data, setData] = useState<Retention | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    setError('');
    api<Retention>(`/admin/analytics/retention?months=${months}`).then(setData).catch((e) => setError(e.message));
  }, [months]);

  // The current month is still running, so headline numbers use the last full month.
  const full = data?.series.at(-2);
  const before = data?.series.at(-3);

  return (
    <div className="stack">
      <div className="row spread">
        <p className="muted small" style={{ margin: 0 }}>Paid orders by calendar month (UTC). A cohort is everyone whose first purchase, or first sale, was in that month.</p>
        <div className="filters" role="group" aria-label="Range" style={{ margin: 0 }}>
          {RANGES.map((m) => <button key={m} aria-pressed={months === m} onClick={() => setMonths(m)}>{m} months</button>)}
        </div>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {!data ? (
        <p className="muted">{error ? '' : 'Loading…'}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Repeat within 90 days" value={pctText(data.repeat90dPct)} now={null} before={null} />
            <Kpi label={`Returning buyers, ${full ? monthName(full.month) : '—'}`} value={pctText(full?.returning_pct ?? null)} now={full?.returning_pct ?? null} before={before?.returning_pct ?? null} unit="pts" />
            <Kpi label={`Seller churn, ${full ? monthName(full.month) : '—'}`} value={pctText(full?.seller_churn_pct ?? null)} now={full?.seller_churn_pct ?? null} before={before?.seller_churn_pct ?? null} unit="pts" invert />
            <Kpi label={`Active sellers, ${full ? monthName(full.month) : '—'}`} value={(full?.active_sellers ?? 0).toLocaleString()} now={full?.active_sellers ?? null} before={before?.active_sellers ?? null} />
          </div>


          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card stack" style={{ gap: 10 }}>
              <div className="row spread">
                <b>Returning buyers and seller churn per month</b>
                <Legend series={[{ key: 'r', label: 'Returning buyers', color: 'var(--viz-1)' }, { key: 'c', label: 'Seller churn', color: 'var(--disputed)' }]} />
              </div>
              <LineChart
                data={data.series.map(({ partial: _p, ...m }) => ({ ...m, date: `${m.month}-01` }))}
                series={[{ key: 'returning_pct', label: 'Returning buyers', color: 'var(--viz-1)' }, { key: 'seller_churn_pct', label: 'Seller churn', color: 'var(--disputed)' }]}
                format={(v) => `${v.toFixed(0)}%`}
                xLabel={monthName}
                label="Share of each month's buyers who had bought before, and share of last month's sellers with no sale this month"
              />
            </section>
            <section className="card" style={{ padding: 0, maxHeight: 340, overflow: 'auto' }}>
              <b style={{ display: 'block', padding: '14px 16px 6px' }}>Sellers per month</b>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Month</th><th>Active</th><th>New</th><th>Churned</th><th>Churn rate</th><th>Active buyers</th><th>Returning</th></tr></thead>
                  <tbody>
                    {[...data.series].reverse().map((m) => (
                      <tr key={m.month}>
                        <td style={{ whiteSpace: 'nowrap' }}>{monthName(m.month)}{m.partial && <span className="small muted"> (so far)</span>}</td>
                        <td className="mono">{m.active_sellers}</td>
                        <td className="mono">{m.new_sellers}</td>
                        <td className="mono">{m.churned_sellers ?? '—'}</td>
                        <td className="mono">{pctText(m.seller_churn_pct)}</td>
                        <td className="mono">{m.active_buyers}</td>
                        <td className="mono">{pctText(m.returning_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="card stack" style={{ gap: 10 }}>
            <div className="row spread">
              <b>Cohorts: still active each month after joining</b>
              <div className="filters" role="group" aria-label="Cohorts" style={{ margin: 0 }}>
                <button aria-pressed={who === 'buyers'} onClick={() => setWho('buyers')}>Buyers</button>
                <button aria-pressed={who === 'sellers'} onClick={() => setWho('sellers')}>Sellers</button>
              </div>
            </div>
            {who === 'buyers' ? <CohortTable cohorts={data.buyerCohorts} who="buyers" repeat={data.repeat} /> : <CohortTable cohorts={data.sellerCohorts} who="sellers" />}
            <p className="small muted" style={{ margin: 0 }}>
              M0 is the joining month (always 100%); +1 is the month after, and so on. {who === 'buyers' && '* Cohort is under 90 days old, so its repeat rate can still rise.'}
            </p>
          </section>

        </>
      )}
    </div>
  );
}
