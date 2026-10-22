import { useState } from 'react';
import { Activity, Coins, Eraser, Gauge, Megaphone, RefreshCw } from 'lucide-react';
import { api, money } from '../api';
import { useSession } from '../session';
import { useLoad } from './AdminPanels';
import { IncidentCard, UPDATE_LABEL, type Incident } from './StatusPage';
import { cn } from '@/lib/utils';

const fmt = (d: string) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

// ---------------------------------------------------------------------------
// Status page incidents
// ---------------------------------------------------------------------------
export function IncidentsPanel() {
  const { data, error, reload, setError } = useLoad(() => api<{ components: Array<{ id: string; name: string }>; incidents: Incident[] }>('/admin/incidents'));
  const [kind, setKind] = useState<'incident' | 'maintenance'>('incident');
  const [form, setForm] = useState({ title: '', impact: 'minor', body: '', start: '', end: '' });
  const [components, setComponents] = useState<string[]>([]);
  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const open = data.incidents.filter((i) => !i.resolved_at);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/admin/incidents', {
        body: {
          kind,
          title: form.title,
          impact: form.impact,
          components,
          body: form.body,
          ...(kind === 'maintenance' ? { scheduledStart: new Date(form.start).toISOString(), scheduledEnd: new Date(form.end).toISOString() } : {}),
        },
      });
      setForm({ title: '', impact: 'minor', body: '', start: '', end: '' });
      setComponents([]);
      await reload();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Posts appear on the public <a href="/status">status page</a> and are emailed to subscribers. Component health is also measured automatically.
      </p>
      {error && <div className="alert" role="alert">{error}</div>}
      <form className="card stack" onSubmit={create}>
        <div className="row spread">
          <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2"><Megaphone className="size-5" /> Post to the status page</h3>
          <div className="filters" role="group" aria-label="Kind" style={{ margin: 0 }}>
            <button type="button" aria-pressed={kind === 'incident'} onClick={() => setKind('incident')}>Incident</button>
            <button type="button" aria-pressed={kind === 'maintenance'} onClick={() => setKind('maintenance')}>Planned maintenance</button>
          </div>
        </div>
        <label className="field">Title<input required minLength={5} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Card checkout failing for some buyers" /></label>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Affected components">
          {data.components.map((c) => (
            <label key={c.id} className={cn('chip cursor-pointer', components.includes(c.id) && 'released')}>
              <input type="checkbox" className="sr-only" checked={components.includes(c.id)} onChange={(e) => setComponents(e.target.checked ? [...components, c.id] : components.filter((x) => x !== c.id))} />
              {c.name}
            </label>
          ))}
        </div>
        {kind === 'incident' ? (
          <label className="field" style={{ maxWidth: 240 }}>
            Impact
            <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })}>
              <option value="minor">Minor: slower or partly affected</option>
              <option value="major">Major: partial outage</option>
              <option value="critical">Critical: down for everyone</option>
            </select>
          </label>
        ) : (
          <div className="row">
            <label className="field">Starts<input type="datetime-local" required value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
            <label className="field">Ends<input type="datetime-local" required value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
          </div>
        )}
        <label className="field">First update<textarea required minLength={5} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} style={{ minHeight: 70 }} placeholder="What customers will notice, and what you’re doing about it." /></label>
        <button className="btn" style={{ alignSelf: 'flex-start' }}>Post {kind}</button>
      </form>

      {open.length === 0 ? <div className="card muted small">Nothing open. All posts are resolved or completed.</div> : open.map((i) => <OpenIncident key={i.id} i={i} onChanged={reload} onError={setError} />)}
      {data.incidents.filter((i) => i.resolved_at).slice(0, 5).map((i) => <IncidentCard key={i.id} i={i} />)}
    </div>
  );
}

function OpenIncident({ i, onChanged, onError }: { i: Incident; onChanged: () => void; onError: (m: string) => void }) {
  const steps = i.kind === 'maintenance' ? ['scheduled', 'in_progress', 'completed'] : ['investigating', 'identified', 'monitoring', 'resolved'];
  const [status, setStatus] = useState(steps[Math.min(steps.indexOf(i.status) + 1, steps.length - 1)]!);
  const [body, setBody] = useState('');
  const post = async () => {
    try {
      await api(`/admin/incidents/${i.id}/updates`, { body: { status, body } });
      setBody('');
      onChanged();
    } catch (e: any) {
      onError(e.message);
    }
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <IncidentCard i={i} />
      <div className="card row" style={{ marginTop: 0 }}>
        <select aria-label="New status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 170 }}>
          {steps.map((s) => <option key={s} value={s}>{UPDATE_LABEL[s]}</option>)}
        </select>
        <input aria-label="Update" placeholder="Update for customers" value={body} onChange={(e) => setBody(e.target.value)} style={{ flex: '1 1 260px' }} />
        <button className="btn ghost" disabled={body.trim().length < 3} onClick={post}>Post update</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seller debts
// ---------------------------------------------------------------------------
export function DebtsPanel() {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const { data, error } = useLoad(() => api<any[]>('/admin/debts?status=open'));
  const closed = useLoad(() => api<any[]>('/admin/debts?status=closed'));
  const rows = status === 'open' ? data : closed.data;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Sellers whose balance went below zero after a refund or chargeback. They get reminders, then their shop pauses until it’s settled. To write a debt off, post a
        ledger adjustment (a second admin approves).
      </p>
      <div className="filters" role="group" aria-label="Debt status" style={{ margin: 0 }}>
        <button aria-pressed={status === 'open'} onClick={() => setStatus('open')}>Open</button>
        <button aria-pressed={status === 'closed'} onClick={() => setStatus('closed')}>Closed (90 days)</button>
      </div>
      {(error || closed.error) && <div className="alert" role="alert">{error || closed.error}</div>}
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="data">
          <thead><tr><th>Seller</th><th>Owed</th><th>Peak</th><th>Opened</th><th>Reminders</th><th>Shop</th>{status === 'closed' && <th>Closed</th>}</tr></thead>
          <tbody>
            {rows === null ? (
              <tr><td colSpan={7} className="muted">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="muted">{status === 'open' ? 'No seller owes anything.' : 'Nothing closed recently.'}</td></tr>
            ) : (
              rows.map((d) => (
                <tr key={d.id}>
                  <td>{d.display_name}<div className="small muted">{d.email}</div></td>
                  <td className="mono">{money(Number(d.owed_cents), d.currency)}</td>
                  <td className="mono muted">{money(Number(d.peak_cents), d.currency)}</td>
                  <td className="small">{fmt(d.opened_at)}</td>
                  <td className="mono">{d.reminders_sent}</td>
                  <td>{d.paused_at ? <span className="chip disputed">paused {fmt(d.paused_at)}</span> : <span className="chip">open</span>}</td>
                  {status === 'closed' && <td className="small">{d.closed_reason === 'written_off' ? 'Written off' : 'Repaid'} · {fmt(d.closed_at)}</td>}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Currency: position and top-ups
// ---------------------------------------------------------------------------
export function CurrencyPanel() {
  const { user } = useSession();
  const position = useLoad(() => api<{ positions: any[] }>('/admin/fx/position'));
  const topups = useLoad(() => api<{ provider: string | null; autoApproveCents: number; topups: any[] }>('/admin/fx/topups'));
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await Promise.all([position.reload(), topups.reload()]);
    } catch (e: any) {
      setError(e.message);
    }
  };
  if (!position.data || !topups.data) return <p className="muted">{position.error || topups.error || 'Loading…'}</p>;
  const t = topups.data;
  return (
    <div className="stack">
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="grid gap-3 sm:grid-cols-3">
        {position.data.positions.map((p) => (
          <div key={p.currency} className={cn('card', p.shortfallCents > 0 && 'border-held/50')}>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{p.currency}</div>
            <div className="mt-1 font-mono text-lg font-semibold">{money(p.sellerBalancesCents, p.currency)}</div>
            <div className="small muted">owed to sellers · held {money(p.pspExpectedCents, p.currency)}</div>
            {p.shortfallCents > 0 && <div className="small text-held">Short {money(p.shortfallCents, p.currency)}</div>}
          </div>
        ))}
      </div>
      <div className="card stack">
        <div className="row spread">
          <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2"><Coins className="size-5" /> Top-ups</h3>
          <button className="btn ghost" onClick={() => run(() => api('/admin/fx/topups/plan', { body: {} }))}><RefreshCw className="size-4" /> Check now</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {t.provider ? `Executed through ${t.provider}.` : 'No exchange connected: approve here, convert at your bank and record the conversion.'}{' '}
          {t.autoApproveCents > 0 ? `Top-ups up to ${money(t.autoApproveCents)} run without approval.` : 'Every top-up needs approval; one you proposed needs someone else.'}
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Proposed</th><th>Buy</th><th>Cost</th><th>Status</th><th /></tr></thead>
            <tbody>
              {t.topups.length === 0 && <tr><td colSpan={5} className="muted">No top-ups yet.</td></tr>}
              {t.topups.map((x) => (
                <tr key={x.id}>
                  <td className="small">{fmt(x.created_at)}<div className="muted">{x.requested_by_name ?? 'Planner'}</div></td>
                  <td className="mono">{money(Number(x.to_cents), x.to_currency)}</td>
                  <td className="mono">{x.from_cents ? money(Number(x.from_cents), x.from_currency) : `≈ ${money(Number(x.est_from_cents), x.from_currency)}`}</td>
                  <td>
                    <span className={cn('chip', x.status === 'completed' ? 'released' : x.status === 'proposed' ? 'held' : x.status === 'failed' ? 'disputed' : '')}>{x.status}</span>
                    {x.error && <div className="small text-disputed">{x.error}</div>}
                    {x.decided_by_name && <div className="small muted">by {x.decided_by_name}</div>}
                  </td>
                  <td>
                    {x.status === 'proposed' && x.requested_by !== user?.id && (
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn release" disabled={!t.provider} onClick={() => run(() => api(`/admin/fx/topups/${x.id}/decide`, { body: { approve: true } }))}>Approve</button>
                        <button className="btn ghost" onClick={() => run(() => api(`/admin/fx/topups/${x.id}/decide`, { body: { approve: false } }))}>Reject</button>
                      </div>
                    )}
                    {x.status === 'proposed' && x.requested_by === user?.id && <span className="small muted">Waiting for someone else</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fraud model report (shadow mode)
// ---------------------------------------------------------------------------
export function FraudModelPanel() {
  const [days, setDays] = useState(180);
  return <FraudReport key={days} days={days} setDays={setDays} />;
}

function FraudReport({ days, setDays }: { days: number; setDays: (d: number) => void }) {
  const { data, error } = useLoad(() => api<any>(`/admin/fraud/model-report?days=${days}`));
  const Row = ({ name, m }: { name: string; m: any }) => (
    <tr>
      <td>{name}</td>
      <td className="mono">{m.auc ?? '—'}</td>
      <td className="mono">{m.flagged}</td>
      <td className="mono">{m.caught}</td>
      <td className="mono">{pct(m.precision)}</td>
      <td className="mono">{pct(m.recall)}</td>
    </tr>
  );
  return (
    <div className="stack">
      <div className="row spread">
        <p className="small muted" style={{ margin: 0, maxWidth: '62ch' }}>
          The graph model scores every order next to the rules. In <b>shadow</b> mode only the rules act. Switch <code>FRAUD_GNN_MODE</code> to <b>enforce</b> once the model
          catches more fraud without flagging more honest orders.
        </p>
        <label className="row small" style={{ gap: 6 }}>
          Window
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 110 }}>
            {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ['Mode', data.mode],
              ['Orders scored', data.scored],
              ['Scored by the model', data.modelScored],
              ['With a known outcome', data.labelled],
            ].map(([l, v]) => (
              <div key={l} className="card">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">{l}</div>
                <div className="mt-1 font-mono text-lg font-semibold">{v}</div>
              </div>
            ))}
          </div>
          {data.models.length === 0 ? (
            <div className="card muted small">
              <Gauge className="mb-2 size-5" /> No labelled orders the model scored yet. Outcomes come from chargebacks, confirmed fraud flags and orders that completed
              {' '}without trouble; they build up over the weeks after launch.
            </div>
          ) : (
            data.models.map((m: any) => (
              <div key={m.modelVersion} className="card stack">
                <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2"><Activity className="size-5" /> Model {m.modelVersion}</h3>
                <p className="small muted" style={{ margin: 0 }}>{m.orders} orders with a known outcome, {m.fraud} of them fraud. Review threshold {data.threshold}.</p>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th /><th>AUC</th><th>Flagged</th><th>Fraud caught</th><th>Precision</th><th>Recall</th></tr></thead>
                    <tbody>
                      <Row name="Rules (heuristic)" m={m.heuristic} />
                      <Row name="Graph model" m={m.model} />
                      <Row name="Both (higher score)" m={m.combined} />
                    </tbody>
                  </table>
                </div>
                <p className="small" style={{ margin: 0 }}>
                  Only the model would have flagged {m.onlyModelFlagged.fraud + m.onlyModelFlagged.legit} orders ({m.onlyModelFlagged.fraud} fraud, {m.onlyModelFlagged.legit} honest);
                  only the rules {m.onlyHeuristicFlagged.fraud + m.onlyHeuristicFlagged.legit} ({m.onlyHeuristicFlagged.fraud} fraud, {m.onlyHeuristicFlagged.legit} honest).
                </p>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Privacy: chat erasure requests
// ---------------------------------------------------------------------------
export function PrivacyPanel() {
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);
  const erase = async () => {
    if (!confirm('Erase everything this user wrote in chat? This cannot be undone.')) return;
    setMsg(null);
    try {
      const r = await api<{ alreadyErased: boolean }>(`/admin/users/${userId}/erase-chat`, { body: { reason } });
      setMsg({ kind: 'ok', text: r.alreadyErased ? 'Already erased.' : 'Erased. Their messages now show as erased to everyone; chat records still verify.' });
      setUserId('');
      setReason('');
    } catch (e: any) {
      setMsg({ kind: 'alert', text: e.message });
    }
  };
  return (
    <div className="card stack" style={{ maxWidth: 640 }}>
      <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2"><Eraser className="size-5" /> Erase a user’s chat messages</h3>
      <p className="small muted" style={{ margin: 0 }}>
        For erasure requests. Destroys the user’s chat key, so everything they wrote becomes unreadable; other people’s messages stay. Refused while they have an open dispute,
        chargeback or compliance case. Deleted accounts are erased automatically after the chargeback window.
      </p>
      {msg && <div className={msg.kind}>{msg.text}</div>}
      <label className="field">User id<input className="mono" value={userId} onChange={(e) => setUserId(e.target.value.trim())} placeholder="00000000-0000-0000-0000-000000000000" /></label>
      <label className="field">Reason (kept in the audit log)<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="GDPR erasure request #1234" /></label>
      <button className="btn dispute" style={{ alignSelf: 'flex-start' }} disabled={!userId || reason.trim().length < 5} onClick={erase}>Erase chat messages</button>
    </div>
  );
}
