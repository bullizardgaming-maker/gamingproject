import { useState } from 'react';
import { Pulse as Activity, Coins, Eraser, Gauge, Megaphone, ArrowsClockwise as RefreshCw } from '@phosphor-icons/react';
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

// ---------------------------------------------------------------------------
// Legal documents (Legal pack, Oct 24): publish a version of the Terms, Privacy Policy, Seller Agreement,
// Refund & Dispute Policy or restricted-countries list. A material change needs 14 days' notice.
// ---------------------------------------------------------------------------
const LEGAL_DOC_LABEL: Record<string, string> = { terms: 'Terms of Service', privacy: 'Privacy Policy', 'seller-agreement': 'Seller Agreement', refunds: 'Refund & Dispute Policy', 'restricted-countries': 'Restricted Countries' };
export function LegalPanel() {
  const { data, error, reload, setError } = useLoad(() => api<any[]>('/admin/legal'));
  const [form, setForm] = useState({ doc: 'terms', lang: 'en', version: '', effectiveAt: '', title: '', contentMd: '', material: false });
  const [msg, setMsg] = useState('');
  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const publish = async () => {
    setError(''); setMsg('');
    try {
      const body: any = { ...form, effectiveAt: form.effectiveAt ? new Date(form.effectiveAt).toISOString() : undefined };
      await api(`/admin/legal/${form.doc}`, { method: 'PUT', body });
      setMsg(form.material ? 'Published. Every active user gets the notice email now; the banner shows until it takes effect.' : 'Published.');
      setForm((f) => ({ ...f, version: '', contentMd: '' }));
      reload();
    } catch (e: any) { setError(e.message); }
  };
  return (
    <div className="stack">
      <p className="muted small">Every version is kept with its hash. The current Terms version is what sign-ups and orders record. A <b>material</b> change must take effect at least 14 days after publishing: users are emailed, the app shows a banner, and they accept the new Terms at their next sign-in.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      {msg && <div className="ok" role="status">{msg}</div>}
      <table className="table">
        <thead><tr><th>Document</th><th>Language</th><th>Version</th><th>In force since</th><th>Material</th><th>SHA-256</th></tr></thead>
        <tbody>
          {data.map((r: any) => (
            <tr key={`${r.doc}-${r.locale}-${r.version}`}>
              <td>{LEGAL_DOC_LABEL[r.doc] ?? r.doc}</td><td>{String(r.locale).toUpperCase()}</td><td>{r.version}</td>
              <td>{new Date(r.effective_at).toLocaleString()}</td><td>{r.material ? 'yes' : ''}</td><td className="mono small">{String(r.sha256).slice(0, 12)}…</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card stack" style={{ maxWidth: 760 }}>
        <h3 style={{ margin: 0 }}>Publish a version</h3>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="field">Document
            <select value={form.doc} onChange={(e) => setForm({ ...form, doc: e.target.value })}>{Object.entries(LEGAL_DOC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
          <label className="field">Language<select value={form.lang} onChange={(e) => setForm({ ...form, lang: e.target.value })}><option value="en">English</option><option value="ar">Arabic</option></select></label>
          <label className="field">Version<input value={form.version} placeholder="2026-11-15" onChange={(e) => setForm({ ...form, version: e.target.value })} /></label>
          <label className="field">Takes effect<input type="datetime-local" value={form.effectiveAt} onChange={(e) => setForm({ ...form, effectiveAt: e.target.value })} /></label>
        </div>
        <label className="field">Title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label className="field">Text (Markdown)<textarea value={form.contentMd} rows={14} onChange={(e) => setForm({ ...form, contentMd: e.target.value })} /></label>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={form.material} onChange={(e) => setForm({ ...form, material: e.target.checked })} /> Material change (14-day notice, users accept again)</label>
        <button className="btn" onClick={publish} disabled={!form.version.trim() || form.title.trim().length < 2 || form.contentMd.trim().length < 20}>Publish</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Listing ban (penalty ladder: warning → listing ban → account ban → frozen balance)
// ---------------------------------------------------------------------------
export function ListingBanPanel() {
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);
  const set = async (on: boolean) => {
    setMsg(null);
    try {
      await api(`/admin/users/${userId.trim()}/listing-ban`, { body: { on, reason } });
      setMsg({ kind: 'ok', text: on ? 'Listing ban set: their listings are paused and they cannot list until it is lifted.' : 'Listing ban lifted: their paused listings are back.' });
      setUserId(''); setReason('');
    } catch (e: any) { setMsg({ kind: 'alert', text: e.message }); }
  };
  return (
    <div className="card stack" style={{ maxWidth: 640 }}>
      <h3 style={{ margin: 0 }}>Listing ban</h3>
      <p className="small muted" style={{ margin: 0 }}>The step between a warning and an account ban. The seller keeps their account and balance but cannot create or relist offers; their active listings are paused. They can appeal through a support ticket (category “Appeal”).</p>
      <label className="field">User ID<input value={userId} onChange={(e) => setUserId(e.target.value)} className="mono" /></label>
      <label className="field">Reason (kept in the audit log)<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {msg && <div className={msg.kind} role={msg.kind === 'ok' ? 'status' : 'alert'}>{msg.text}</div>}
      <div className="row">
        <button className="btn dispute" disabled={!userId.trim() || reason.trim().length < 3} onClick={() => set(true)}>Set listing ban</button>
        <button className="btn ghost" disabled={!userId.trim()} onClick={() => set(false)}>Lift listing ban</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kill switches and beta limits (launch gate §4)
// ---------------------------------------------------------------------------
type Controls = {
  pause_withdrawals: boolean; pause_orders: boolean; pause_chat: boolean; pause_signups: boolean; pause_message: string | null;
  max_withdrawal_day_cents: number; max_order_cents: number; new_account_days: number; new_account_max_order_cents: number; new_account_max_open_orders: number;
  alert_dispute_hour: number; alert_bans_hour: number; alert_withdrawal_cents: number;
  four_eyes_withdrawal_cents: number; four_eyes_user_day_cents: number; max_platform_payout_day_cents: number; updated_at: string;
};
export function ControlsPanel() {
  const { data, error, reload, setError } = useLoad(() => api<Controls>('/admin/controls'));
  const [form, setForm] = useState<Partial<Controls>>({});
  const [msg, setMsg] = useState('');
  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const cur = { ...data, ...form };
  const save = async (patch: Partial<Controls>, ok: string) => {
    setError(''); setMsg('');
    try {
      await api('/admin/controls', { method: 'PUT', body: patch });
      setMsg(ok); setForm({}); reload();
    } catch (e: any) { setError(e.message); }
  };
  const Switch = ({ k, label, hint }: { k: 'pause_withdrawals' | 'pause_orders' | 'pause_chat' | 'pause_signups'; label: string; hint: string }) => (
    <div className="row spread" style={{ gap: 12, alignItems: 'center' }}>
      <div><b>{label}</b><div className="small muted">{hint}</div></div>
      <button className={`btn ${data[k] ? 'dispute' : 'ghost'}`} data-testid={`switch-${k}`} onClick={() => (data[k] || confirm(`Pause ${label.toLowerCase()} for everyone now?`)) && save({ [k]: !data[k] }, data[k] ? `${label}: resumed.` : `${label}: PAUSED.`)}>
        {data[k] ? 'PAUSED — resume' : 'Pause'}
      </button>
    </div>
  );
  const Num = ({ k, label, cents = true }: { k: keyof Controls; label: string; cents?: boolean }) => (
    <label className="field">{label}
      <input type="number" min={0} step={cents ? 0.01 : 1} value={cents ? (Number(cur[k]) / 100).toFixed(2) : String(cur[k])} onChange={(e) => setForm({ ...form, [k]: cents ? Math.round(Number(e.target.value) * 100) : Number(e.target.value) })} />
    </label>
  );
  return (
    <div className="stack">
      {error && <div className="alert" role="alert">{error}</div>}
      {msg && <div className="ok" role="status">{msg}</div>}
      <div className="card stack" data-testid="kill-switches">
        <h3 style={{ margin: 0 }}>Kill switches</h3>
        <p className="small muted" style={{ margin: 0 }}>Each switch stops one thing for everyone within seconds; existing orders keep moving and balances stay where they are. Every change is in the audit log.</p>
        <Switch k="pause_withdrawals" label="Withdrawals" hint="No new withdrawal requests; approved payouts in flight still finish." />
        <Switch k="pause_orders" label="New orders" hint="Nobody can start an order or a cart; paid orders continue to delivery and release." />
        <Switch k="pause_chat" label="Chat" hint="Users cannot send messages; staff still can and all records stay." />
        <Switch k="pause_signups" label="Sign-ups" hint="No new accounts; sign-in keeps working." />
        <label className="field">Message shown to users while something is paused (optional)
          <input value={cur.pause_message ?? ''} onChange={(e) => setForm({ ...form, pause_message: e.target.value || null })} placeholder="Back in 10 minutes." />
        </label>
        <button className="btn ghost" onClick={() => save({ pause_message: cur.pause_message ?? null }, 'Message saved.')}>Save message</button>
      </div>
      <div className="card stack" data-testid="beta-limits">
        <h3 style={{ margin: 0 }}>Beta limits</h3>
        <div className="grid three">
          <Num k="max_order_cents" label="Max order (USD)" />
          <Num k="max_withdrawal_day_cents" label="Max withdrawals per user per day (USD)" />
          <Num k="new_account_days" label="New account: first N days" cents={false} />
          <Num k="new_account_max_order_cents" label="New account: max order (USD)" />
          <Num k="new_account_max_open_orders" label="New account: max open orders" cents={false} />
          <Num k="max_platform_payout_day_cents" label="Platform payouts per day, all users (USD)" />
        </div>
        <h3 style={{ margin: 0 }}>Four-eyes on payouts (second approver must be a Lead)</h3>
        <div className="grid three">
          <Num k="four_eyes_withdrawal_cents" label="Single withdrawal above (USD)" />
          <Num k="four_eyes_user_day_cents" label="User's withdrawals in a day above (USD)" />
        </div>
        <h3 style={{ margin: 0 }}>Alert thresholds (email to admins + finance, checked every 15 minutes)</h3>
        <div className="grid three">
          <Num k="alert_dispute_hour" label="Disputes opened per hour" cents={false} />
          <Num k="alert_bans_hour" label="Bans per hour" cents={false} />
          <Num k="alert_withdrawal_cents" label="Single withdrawal above (USD)" />
        </div>
        <button className="btn" disabled={!Object.keys(form).length} onClick={() => save(form, 'Limits saved.')}>Save limits</button>
        <p className="small muted" style={{ margin: 0 }}>Last change: {new Date(data.updated_at).toLocaleString()}</p>
      </div>
    </div>
  );
}
