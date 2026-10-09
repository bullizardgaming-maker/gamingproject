import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, Check, Download, ShieldAlert, UserCog } from 'lucide-react';
import { api, download, money } from '../api';
import { useSession } from '../session';
import { cn } from '@/lib/utils';

const fmt = (d: string) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const label = (s: string) => s.replace(/_/g, ' ');

export function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setError('');
    try {
      setData(await fn());
    } catch (e: any) {
      setError(e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, reload, setError };
}

// ---------------------------------------------------------------------------
// Compliance (AML)
// ---------------------------------------------------------------------------
const STATUS_CHIP: Record<string, string> = { open: 'held', escalated: 'disputed', cleared: 'released', reported: 'disputed' };

export function AmlPanel() {
  const [status, setStatus] = useState('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [cases, setCases] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setCases(null);
    try {
      setCases(await api<any[]>(`/admin/aml/cases${status ? `?status=${status}` : ''}`));
    } catch (e: any) {
      setError(e.message);
      setCases([]);
    }
  }, [status]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="stack">
      <div className="notice small">
        Never tell a user they are under review or why: their payouts show as a “routine review”. Everything you do here is in the audit log.
      </div>
      <div className="filters" role="group" aria-label="Case status">
        {['open', 'escalated', 'reported', 'cleared'].map((s) => (
          <button key={s} aria-pressed={status === s} onClick={() => (setStatus(s), setSelected(null))}>{label(s)}</button>
        ))}
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <div className="card table-wrap" style={{ padding: 0 }}>
          {cases === null ? (
            <p className="muted" style={{ padding: 20 }}>Loading…</p>
          ) : cases.length === 0 ? (
            <p className="muted" style={{ padding: 20 }}>No {status} cases.</p>
          ) : (
            <table className="data">
              <thead><tr><th>User</th><th>Rule</th><th>Opened</th></tr></thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id} onClick={() => setSelected(c.id)} className={cn('cursor-pointer hover:bg-secondary/60', selected === c.id && 'bg-secondary')}>
                    <td>
                      {c.display_name}
                      {c.holds_payouts && <span className="chip disputed" style={{ marginInlineStart: 6 }}>payouts paused</span>}
                    </td>
                    <td className="small">
                      <span className={cn('me-1.5 inline-block size-2 rounded-full', c.severity === 'high' ? 'bg-disputed' : 'bg-held')} />
                      {label(c.rule)}
                    </td>
                    <td className="small muted">{fmt(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {selected ? <CaseDetail id={selected} onChanged={load} /> : <div className="card muted small">Select a case to review it.</div>}
      </div>
    </div>
  );
}

function CaseDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { can } = useSession();
  const { data, error, reload, setError } = useLoad(() => api<any>(`/admin/aml/cases/${id}`));
  const [note, setNote] = useState('');
  const [sar, setSar] = useState('');
  useEffect(() => {
    reload();
  }, [id, reload]);
  if (!data) return <div className="card muted">{error || 'Loading case…'}</div>;
  const c = data.case;
  const closed = ['cleared', 'reported'].includes(c.status);

  const decide = async (decision: string) => {
    setError('');
    try {
      await api(`/admin/aml/cases/${id}/decide`, { body: { decision, note, sarReference: decision === 'report' ? sar : undefined } });
      setNote('');
      await reload();
      onChanged();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const addNote = async () => {
    await api(`/admin/aml/cases/${id}/notes`, { body: { note } });
    setNote('');
    reload();
  };

  return (
    <div className="card stack">
      <div className="row spread">
        <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2">
          <ShieldAlert className={cn('size-5', c.severity === 'high' ? 'text-disputed' : 'text-held')} /> {label(c.rule)}
        </h3>
        <span className={`chip ${STATUS_CHIP[c.status] ?? ''}`}>{c.status}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 small">
        <div>
          <b>{data.user.display_name}</b>
          <div className="muted">{data.user.email}</div>
          <div className="muted">Legal name: {data.user.legal_name ?? '—'} · level {data.user.kyc_tier}</div>
          {data.user.wallet_address && <div className="mono muted">{data.user.wallet_address.slice(0, 18)}…</div>}
        </div>
        <div className="mono">
          <div>Sales 90d {money(Number(data.money.sales_90d_cents))}</div>
          <div>Bought 90d {money(Number(data.money.purchases_90d_cents))}</div>
          <div>Paid out 90d {money(Number(data.money.withdrawn_90d_cents))}</div>
        </div>
      </div>
      <details open={c.source === 'sanctions'}>
        <summary className="cursor-pointer small"><b>Why this case exists</b></summary>
        {c.details?.why && <p className="small">{c.details.why}</p>}
        {Array.isArray(c.details?.matches) && c.details.matches.length > 0 && (
          <table className="data" style={{ marginTop: 8 }}>
            <thead><tr><th>Listed name</th><th>List</th><th>Score</th></tr></thead>
            <tbody>
              {c.details.matches.slice(0, 5).map((m: any, i: number) => (
                <tr key={i}><td>{m.name}<div className="small muted">{m.program}</div></td><td className="mono small">{m.list} #{m.ref}</td><td className="mono">{Number(m.score).toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        <pre className="secret" style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8 }}>{JSON.stringify(Object.fromEntries(Object.entries(c.details ?? {}).filter(([k]) => !['matches', 'why'].includes(k))), null, 2)}</pre>
      </details>
      {c.notes?.length > 0 && (
        <div className="small stack" style={{ gap: 6 }}>
          {c.notes.map((n: any, i: number) => (
            <div key={i} style={{ borderInlineStart: '2px solid var(--rule)', paddingInlineStart: 10 }}>
              {n.decision && <b>{label(n.decision)} · </b>}{n.note}
              <div className="muted">{fmt(n.at)}</div>
            </div>
          ))}
        </div>
      )}
      {c.sar_reference && <div className="notice small">Suspicious activity report filed: <span className="mono">{c.sar_reference}</span></div>}
      {!closed && (
        <>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note or reason for your decision" style={{ minHeight: 70 }} />
          <div className="row">
            <button className="btn ghost" disabled={note.trim().length < 3} onClick={addNote}>Add note</button>
            <button className="btn release" disabled={note.trim().length < 3} onClick={() => decide('clear')}><Check className="size-4" /> Clear</button>
            {c.status !== 'escalated' && <button className="btn ghost" disabled={note.trim().length < 3} onClick={() => decide('escalate')}>Escalate</button>}
            {!c.holds_payouts && <button className="btn dispute" disabled={note.trim().length < 3} onClick={() => decide('hold')}>Pause payouts</button>}
          </div>
          {can('aml.sar') && (
            <div className="row">
              <input className="mono" placeholder="FIU reference of the filed report" value={sar} onChange={(e) => setSar(e.target.value)} style={{ maxWidth: 280 }} />
              <button className="btn dispute" disabled={!sar.trim() || note.trim().length < 3} onClick={() => decide('report')}>Record report filed</button>
            </div>
          )}
        </>
      )}
      {error && <div className="alert">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Treasury
// ---------------------------------------------------------------------------
export function TreasuryPanel() {
  const { user, can } = useSession();
  const { data, error, reload, setError } = useLoad(() => api<any>('/admin/treasury'));
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [source, setSource] = useState<'treasury' | 'tax_payable'>('treasury');
  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const b = data.balance;
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      setAmount('');
      setNote('');
      await reload();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="stack">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Platform revenue available', b.availableCents, 'released'],
          ['Chargeback reserve', b.reserveCents, ''],
          ['Tax collected (owed)', b.taxPayableCents ?? 0, 'held'],
          ['Moved out to date', b.withdrawnToDateCents, ''],
        ].map(([l, v, tone]) => (
          <div key={l as string} className={cn('card', tone === 'released' && 'border-released/40', tone === 'held' && 'border-held/40')}>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{l}</div>
            <div className="mt-1 font-mono text-xl font-semibold">{money(Number(v), b.currency)}</div>
          </div>
        ))}
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2"><ArrowDownToLine className="size-5" /> Move money to the company bank</h3>
        <p className="small muted" style={{ margin: 0 }}>A second admin must approve. Seller balances, escrow and the reserve can never be moved from here.</p>
        <div className="row">
          <select value={source} onChange={(e) => setSource(e.target.value as any)} style={{ width: 200 }} aria-label="Source">
            <option value="treasury">Platform revenue</option>
            <option value="tax_payable">Collected tax (to pay it over)</option>
          </select>
          <input type="number" min={0} step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ maxWidth: 140 }} />
          <input placeholder="Note (e.g. October revenue)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <button
            className="btn"
            disabled={!amount || note.trim().length < 3}
            onClick={() => run(() => api('/admin/treasury/withdrawals', { body: { amountCents: Math.round(Number(amount) * 100), note, source } }))}
          >
            Request
          </button>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="card table-wrap">
        <table className="data">
          <thead><tr><th>Requested</th><th>From</th><th>Amount</th><th>Note</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.withdrawals.length === 0 && <tr><td colSpan={6} className="muted">No withdrawals yet.</td></tr>}
            {data.withdrawals.map((w: any) => (
              <tr key={w.id}>
                <td className="small">{fmt(w.created_at)}<div className="muted">{w.requested_by_name}</div></td>
                <td className="small">{w.source === 'tax_payable' ? 'Collected tax' : 'Revenue'}</td>
                <td className="mono">{money(Number(w.amount_cents), w.currency)}</td>
                <td className="small">{w.note}</td>
                <td><span className={`chip ${w.status === 'paid' ? 'released' : w.status === 'pending_approval' ? 'held' : 'disputed'}`}>{label(w.status)}</span>{w.decided_by_name && <div className="small muted">by {w.decided_by_name}</div>}</td>
                <td>
                  {w.status === 'pending_approval' && can('treasury.approve') && w.requested_by !== user?.id && (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn release" onClick={() => run(() => api(`/admin/treasury/withdrawals/${w.id}/decide`, { body: { approve: true } }))}>Approve</button>
                      <button className="btn ghost" onClick={() => run(() => api(`/admin/treasury/withdrawals/${w.id}/decide`, { body: { approve: false } }))}>Reject</button>
                    </div>
                  )}
                  {w.status === 'pending_approval' && w.requested_by === user?.id && <span className="small muted">Waiting for another admin</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tax report
// ---------------------------------------------------------------------------
export function TaxPanel() {
  const today = new Date();
  const [from, setFrom] = useState(`${today.getFullYear()}-${String(Math.floor(today.getMonth() / 3) * 3 + 1).padStart(2, '0')}-01`);
  const [to, setTo] = useState(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await api<any[]>(`/admin/tax/report?from=${from}&to=${to}`));
    } catch (e: any) {
      setError(e.message);
    }
  }, [from, to]);
  useEffect(() => {
    load();
  }, [load]);
  const total = (k: string) => (rows ?? []).reduce((s, r) => s + Number(r[k] ?? 0), 0);
  return (
    <div className="stack">
      <div className="row">
        <label className="row small" style={{ gap: 6 }}>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} /></label>
        <label className="row small" style={{ gap: 6 }}>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} /></label>
        <button className="btn ghost" onClick={() => download(`/admin/tax/report?from=${from}&to=${to}&format=csv`, `tax-${from}-${to}.csv`)}><Download className="size-4" /> CSV for the return</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>VAT/GST on our commission by country and treatment, net of credit notes. The basis for OSS and local returns.</p>
      {error && <div className="alert">{error}</div>}
      <div className="card table-wrap">
        <table className="data">
          <thead><tr><th>Country</th><th>Treatment</th><th>Rate</th><th>Orders</th><th>Credit notes</th><th>Commission</th><th>Tax</th></tr></thead>
          <tbody>
            {rows === null ? (
              <tr><td colSpan={7} className="muted">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="muted">No commission earned in this period.</td></tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.country}</td>
                  <td className="small">{label(r.treatment)}</td>
                  <td className="mono">{(r.rate_bps / 100).toFixed(2)}%</td>
                  <td className="mono">{r.orders}</td>
                  <td className="mono">{r.credit_notes ?? 0}</td>
                  <td className="mono">{money(Number(r.commission_gross_cents), r.currency)}</td>
                  <td className="mono">{money(Number(r.tax_cents), r.currency)}</td>
                </tr>
              ))
            )}
          </tbody>
          {rows && rows.length > 0 && (
            <tfoot>
              <tr><td colSpan={5}><b>Total</b></td><td className="mono"><b>{money(total('commission_gross_cents'))}</b></td><td className="mono"><b>{money(total('tax_cents'))}</b></td></tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff & roles
// ---------------------------------------------------------------------------
const ROLES = ['arbiter', 'support', 'finance', 'compliance', 'admin'] as const;
const ROLE_HINT: Record<string, string> = {
  arbiter: 'Disputes, owner proofs, reviews, refunds after release',
  support: 'Read orders and chats, post status-page incidents; no money movement',
  finance: 'Treasury, chargebacks, tax, invoices, ledger corrections',
  compliance: 'Fraud and AML review, suspensions, audit log',
  admin: 'Everything, including staff access',
};

export function StaffPanel() {
  const { user } = useSession();
  const { data, error, reload, setError } = useLoad(() => api<any[]>('/admin/staff'));
  const [editing, setEditing] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  return (
    <div className="stack">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {ROLES.map((r) => (
          <div key={r} className="card small"><b className="capitalize">{r}</b><div className="muted">{ROLE_HINT[r]}</div></div>
        ))}
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="card table-wrap">
        <table className="data">
          <thead><tr><th>Person</th><th>Roles</th><th>2FA</th><th /></tr></thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>{s.display_name}<div className="small muted">{s.email}</div></td>
                <td>
                  {editing === s.id ? (
                    <RoleEditor
                      current={[s.role, ...(s.staff_roles ?? [])].filter((r: string) => r !== 'user')}
                      onCancel={() => setEditing(null)}
                      onSave={async (roles, reason) => {
                        setError('');
                        try {
                          await api(`/admin/staff/${s.id}`, { method: 'PUT', body: { roles, reason } });
                          setEditing(null);
                          await reload();
                        } catch (e: any) {
                          setError(e.message);
                        }
                      }}
                    />
                  ) : (
                    <div className="row" style={{ gap: 6 }}>
                      {[s.role, ...(s.staff_roles ?? [])].filter((r: string) => r !== 'user').map((r: string) => <span key={r} className="chip">{r}</span>)}
                    </div>
                  )}
                </td>
                <td>{s.totp_enabled ? <Check className="size-4 text-released" /> : <AlertTriangle className="size-4 text-held" aria-label="No two-factor login" />}</td>
                <td>{s.id !== user?.id && editing !== s.id && <button className="btn ghost" onClick={() => setEditing(s.id)}><UserCog className="size-4" /> Change</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Give someone staff access</h3>
        <div className="row">
          <input className="mono" placeholder="User id" value={userId} onChange={(e) => setUserId(e.target.value.trim())} style={{ flex: 1, minWidth: 260 }} />
          <button className="btn ghost" disabled={!/^[0-9a-f-]{36}$/i.test(userId) && !userId.startsWith('u-')} onClick={() => setEditing(userId)}>Choose roles</button>
        </div>
        {editing && !data.some((s) => s.id === editing) && (
          <RoleEditor
            current={[]}
            onCancel={() => setEditing(null)}
            onSave={async (roles, reason) => {
              setError('');
              try {
                await api(`/admin/staff/${editing}`, { method: 'PUT', body: { roles, reason } });
                setEditing(null);
                setUserId('');
                await reload();
              } catch (e: any) {
                setError(e.message);
              }
            }}
          />
        )}
        <p className="small muted" style={{ margin: 0 }}>Changes apply immediately, are emailed to the person and recorded in the audit log. Nobody can change their own access.</p>
      </div>
    </div>
  );
}

function RoleEditor({ current, onSave, onCancel }: { current: string[]; onSave: (roles: string[], reason: string) => void; onCancel: () => void }) {
  const [roles, setRoles] = useState<string[]>(current);
  const [reason, setReason] = useState('');
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 10 }}>
        {ROLES.map((r) => (
          <label key={r} className="row small" style={{ gap: 4 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
            {r}
          </label>
        ))}
      </div>
      <div className="row">
        <input placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <button className="btn" disabled={reason.trim().length < 3} onClick={() => onSave(roles, reason)}>Save</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
