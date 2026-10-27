import { useCallback, useEffect, useState } from 'react';
import { Warning as AlertTriangle, DownloadSimple as ArrowDownToLine, Check, DownloadSimple as Download, ShieldWarning as ShieldAlert, UserGear as UserCog } from '@phosphor-icons/react';
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
      {error && <div className="alert" role="alert">{error}</div>}
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
                  <tr key={c.id} onClick={() => setSelected(c.id)} tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSelected(c.id))} className={cn('cursor-pointer hover:bg-secondary/60', selected === c.id && 'bg-secondary')}>
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
      {error && <div className="alert" role="alert">{error}</div>}
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
      {error && <div className="alert" role="alert">{error}</div>}
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
      {error && <div className="alert" role="alert">{error}</div>}
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
const ROLES = ['arbiter', 'support', 'lead', 'finance', 'compliance', 'marketing', 'admin'] as const;
const ROLE_HINT: Record<string, string> = {
  arbiter: 'Disputes, owner proofs, reviews, refunds after release',
  support: 'Read orders and chats, post status-page incidents; no money movement',
  finance: 'Treasury, chargebacks, tax, invoices, ledger corrections',
  compliance: 'Fraud and AML review, suspensions, audit log',
  marketing: 'Newsletter subscriber list (CSV); nothing else',
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
      {error && <div className="alert" role="alert">{error}</div>}
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

/** Launch phase: which categories are on sale (1 currency/items/top-ups, 2 + accounts/boosting, 3 everything). */
function LaunchPhase() {
  const { data, error, reload, setError } = useLoad(() => api<{ phase: number; allowedGames: string[] | null; categories: Array<{ slug: string; name: string; phase: number }> }>('/admin/launch'));
  const [msg, setMsg] = useState('');
  const [games, setGames] = useState<string | null>(null);
  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const gamesText = games ?? (data.allowedGames ?? []).join('\n');
  const saveGames = async () => {
    setError('');
    setMsg('');
    const list = gamesText.split('\n').map((g) => g.trim()).filter(Boolean);
    try {
      await api('/admin/launch', { method: 'PUT', body: { allowedGames: list.length ? list : null } });
      // Reload first, so the box shows the saved list before the confirmation appears.
      await reload();
      setGames(null);
      setMsg(list.length ? `Sellers can list in ${list.length} game${list.length === 1 ? '' : 's'}.` : 'Every game is open for listing.');
    } catch (e: any) {
      setError(e.message);
    }
  };
  const set = async (phase: number) => {
    setError('');
    setMsg('');
    try {
      await api('/admin/launch', { method: 'PUT', body: { phase } });
      setMsg(`Phase ${phase} is live: ${data.categories.filter((c) => c.phase <= phase).map((c) => c.name).join(', ')}.`);
      reload();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="card stack" data-testid="launch-phase">
      <div className="row spread">
        <b>Launch phase</b>
        <span className="chip">Phase {data.phase}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Closed categories are hidden from buyers and cannot be listed in. Moving forward opens them at once; moving back hides their listings again.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      {msg && <div className="ok" role="status">{msg}</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {[1, 2, 3].map((p) => (
          <button key={p} className={`btn ${data.phase === p ? '' : 'ghost'}`} aria-pressed={data.phase === p} onClick={() => set(p)}>
            Phase {p}: {data.categories.filter((c) => c.phase === p).map((c) => c.name).join(', ')}
          </button>
        ))}
      </div>
      <label className="stack" style={{ gap: 6 }}>
        <b>Games sellers can list</b>
        <span className="small muted">One per line. Leave empty to open every game. Winners of the game vote go here.</span>
        <textarea rows={6} value={gamesText} onChange={(e) => setGames(e.target.value)} data-testid="allowed-games" />
      </label>
      <div className="row">
        <button className="btn ghost" onClick={saveGames}>Save games</button>
      </div>
    </div>
  );
}

/** Seller ranks: names, 30-day sales thresholds and commission rates, plus the launch promo (admin only). */
export function RanksPanel() {
  const { data, error, reload, setError } = useLoad(() => api<{ ranks: Array<{ position: number; name: string; minMonthlySalesCents: number; rateBps: number; perks: string[] }>; settings: { promoRateBps: number; promoDays: number } }>('/admin/ranks'));
  const [draft, setDraft] = useState<typeof data | null>(null);
  const [saved, setSaved] = useState('');
  useEffect(() => setDraft(data), [data]);
  if (!draft) return <p className="muted">{error || 'Loading…'}</p>;
  const set = (i: number, patch: Partial<(typeof draft.ranks)[number]>) => setDraft({ ...draft, ranks: draft.ranks.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const save = async () => {
    setError('');
    setSaved('');
    try {
      await api('/admin/ranks', { method: 'PUT', body: { ranks: draft.ranks, settings: draft.settings } });
      setSaved('Saved. Listings show the new rates right away.');
      reload();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="stack">
      <LaunchPhase />
      <p className="muted small">
        Sellers set their price and receive it in full; the rank rate is added on top for the buyer. A seller's rank follows their completed sales over the last 30 days. Thresholds must rise and rates must not with each rank.
      </p>
      {error && <div className="alert" role="alert">{error}</div>}
      {saved && <div className="ok" role="status">{saved}</div>}
      <div className="card table-wrap">
        <table className="data" aria-label="Seller ranks">
          <thead><tr><th>#</th><th>Name</th><th>From (30-day sales, USD)</th><th>Commission %</th></tr></thead>
          <tbody>
            {draft.ranks.map((r, i) => (
              <tr key={r.position}>
                <td className="mono">{r.position}</td>
                <td><input aria-label={`Rank ${r.position} name`} value={r.name} maxLength={30} onChange={(e) => set(i, { name: e.target.value })} /></td>
                <td><input aria-label={`Rank ${r.position} threshold`} type="number" min={0} step={1} disabled={i === 0} value={r.minMonthlySalesCents / 100} onChange={(e) => set(i, { minMonthlySalesCents: Math.round(Number(e.target.value) * 100) })} /></td>
                <td><input aria-label={`Rank ${r.position} rate`} type="number" min={0} max={50} step={0.01} value={r.rateBps / 100} onChange={(e) => set(i, { rateBps: Math.round(Number(e.target.value) * 100) })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card stack">
        <b>Launch promo for new sellers</b>
        <div className="row" style={{ gap: 16 }}>
          <label className="field">Rate %<input aria-label="Promo rate" type="number" min={0} max={50} step={0.01} value={draft.settings.promoRateBps / 100} onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, promoRateBps: Math.round(Number(e.target.value) * 100) } })} /></label>
          <label className="field">Days from first listing<input aria-label="Promo days" type="number" min={0} max={365} value={draft.settings.promoDays} onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, promoDays: Number(e.target.value) } })} /></label>
        </div>
        <span className="small muted">0 days switches the promo off. The promo never charges more than the seller's rank rate.</span>
      </div>
      <div className="row">
        <button className="btn" onClick={save}>Save ranks</button>
        <button className="btn ghost" onClick={() => setDraft(data)}>Reset</button>
      </div>
    </div>
  );
}

/** Challenge leagues (Path of Exile 1 & 2): open one when it is announced, close it when it ends. */
export function LeaguesPanel() {
  const { data, error, reload, setError } = useLoad(() => api<{ leagues: Array<{ id: string; game: string; name: string; starts_at: string | null; ends_at: string | null }>; games: string[]; inactiveSellerDays: number }>('/admin/leagues'));
  const [game, setGame] = useState('path of exile');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const title = (g: string) => g.replace(/\b\w/g, (c) => c.toUpperCase());
  const call = async (fn: () => Promise<unknown>, ok: string) => {
    setError('');
    setMsg('');
    try {
      await fn();
      setMsg(ok);
      reload();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="stack">
      <p className="muted small">
        Standard and Hardcore are always open. A challenge league you open here becomes a choice on the sell form at once. Once it ends, listings in it from sellers not seen for {data.inactiveSellerDays} days expire (the worker runs this hourly); active sellers keep theirs and can move them.
      </p>
      {error && <div className="alert" role="alert">{error}</div>}
      {msg && <div className="ok" role="status">{msg}</div>}
      <form
        className="card row"
        style={{ gap: 12, alignItems: 'end', flexWrap: 'wrap' }}
        onSubmit={(e) => {
          e.preventDefault();
          call(() => api('/admin/leagues', { body: { game, name: name.trim(), startsAt: new Date().toISOString() } }), `${name.trim()} is open for ${title(game)}.`).then(() => setName(''));
        }}
      >
        <label className="field">Game<select value={game} onChange={(e) => setGame(e.target.value)}>{data.games.map((g) => <option key={g} value={g}>{title(g)}</option>)}</select></label>
        <label className="field">League name<input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={60} required placeholder="e.g. the new challenge league" /></label>
        <button className="btn" disabled={name.trim().length < 2}>Open league</button>
      </form>
      <div className="card table-wrap">
        <table className="data" aria-label="Challenge leagues">
          <thead><tr><th>Game</th><th>League</th><th>Started</th><th>Ends</th><th /></tr></thead>
          <tbody>
            {data.leagues.length === 0 && <tr><td colSpan={5} className="muted">No challenge leagues yet.</td></tr>}
            {data.leagues.map((l) => {
              const ended = !!l.ends_at && new Date(l.ends_at) <= new Date();
              return (
                <tr key={l.id}>
                  <td>{title(l.game)}</td>
                  <td><b>{l.name}</b> {ended ? <span className="chip disputed">Ended</span> : <span className="chip released">Open</span>}</td>
                  <td className="mono">{l.starts_at ? new Date(l.starts_at).toLocaleDateString() : '—'}</td>
                  <td className="mono">{l.ends_at ? new Date(l.ends_at).toLocaleDateString() : '—'}</td>
                  <td>
                    {ended ? (
                      <button className="btn ghost small" onClick={() => call(() => api(`/admin/leagues/${l.id}`, { method: 'PATCH', body: { endsAt: null } }), `${l.name} reopened.`)}>Reopen</button>
                    ) : (
                      <button className="btn ghost small" onClick={() => call(() => api(`/admin/leagues/${l.id}`, { method: 'PATCH', body: { endsAt: new Date().toISOString() } }), `${l.name} ended. Inactive sellers' listings in it expire on the next worker run.`)}>End now</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button className="btn ghost" onClick={() => call(() => api('/admin/leagues/expire', { body: {} }).then((r: any) => setMsg(`Expired ${r.expired} listing(s).`)), '')}>Run expiry now</button>
    </div>
  );
}

/** The seller rules test: questions, the right answer, the pass mark and the ID deadline (support). */
export function RulesTestPanel() {
  type Q = { id?: string; position: number; question: string; options: string[]; correct: number; explanation: string; active: boolean; question_ar?: string | null; options_ar?: string[] | null; explanation_ar?: string | null };
  const { data, error, reload, setError } = useLoad(() => api<{ questions: Q[]; settings: { passMarkPct: number; idDueDays: number } }>('/admin/rules-test'));
  const [qs, setQs] = useState<Q[]>([]);
  const [settings, setSettings] = useState({ passMarkPct: 100, idDueDays: 30 });
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (data) {
      setQs(data.questions.filter((q) => q.active));
      setSettings(data.settings);
    }
  }, [data]);
  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const set = (i: number, patch: Partial<Q>) => setQs((all) => all.map((q, k) => (k === i ? { ...q, ...patch } : q)));
  const save = async () => {
    setError('');
    setMsg('');
    try {
      await api('/admin/rules-test', { method: 'PUT', body: { questions: qs.map((q, i) => ({ ...q, position: i + 1, options_ar: q.options_ar?.every((o) => o?.trim()) ? q.options_ar : null })), settings } });
      setMsg('Saved. New sellers get the updated test at once.');
      reload();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="stack">
      <p className="muted small">Every seller passes this test before their first listing. Questions you remove are retired, not deleted. The ID deadline counts from a seller's first listing; the worker reminds them at 7 and 1 days and pauses listings once it passes.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      {msg && <div className="ok" role="status">{msg}</div>}
      <div className="card row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <label className="field">Pass mark %<input aria-label="Pass mark" type="number" min={1} max={100} value={settings.passMarkPct} onChange={(e) => setSettings({ ...settings, passMarkPct: Number(e.target.value) })} /></label>
        <label className="field">ID due (days after first listing)<input aria-label="ID due days" type="number" min={1} max={365} value={settings.idDueDays} onChange={(e) => setSettings({ ...settings, idDueDays: Number(e.target.value) })} /></label>
      </div>
      {qs.map((q, i) => (
        <div key={q.id ?? `new-${i}`} className="card stack" data-testid="rules-question">
          <div className="row spread">
            <b>Question {i + 1}</b>
            <button className="btn ghost small" onClick={() => setQs((all) => all.filter((_, k) => k !== i))}>Remove</button>
          </div>
          <label className="field">Question<textarea aria-label={`Question ${i + 1}`} value={q.question} rows={2} onChange={(e) => set(i, { question: e.target.value })} /></label>
          <div className="stack" style={{ gap: 6 }}>
            {q.options.map((o, k) => (
              <label key={k} className="row" style={{ gap: 8 }}>
                <input type="radio" name={`correct-${i}`} style={{ width: 'auto' }} checked={q.correct === k} onChange={() => set(i, { correct: k })} aria-label={`Question ${i + 1} correct answer ${k + 1}`} />
                <input aria-label={`Question ${i + 1} option ${k + 1}`} value={o} onChange={(e) => set(i, { options: q.options.map((x, j) => (j === k ? e.target.value : x)) })} style={{ flex: 1 }} />
                {q.options.length > 2 && <button className="btn ghost small" aria-label={`Remove option ${k + 1}`} onClick={() => set(i, { options: q.options.filter((_, j) => j !== k), correct: Math.min(q.correct, q.options.length - 2) })}>×</button>}
              </label>
            ))}
            {q.options.length < 6 && <button className="btn ghost small" style={{ alignSelf: 'start' }} onClick={() => set(i, { options: [...q.options, ''] })}>Add option</button>}
          </div>
          <label className="field">Explanation shown when missed<input value={q.explanation} onChange={(e) => set(i, { explanation: e.target.value })} /></label>
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>Arabic (shown to sellers using the app in Arabic){q.question_ar ? ' ✓' : ' — not yet'}</summary>
            <div className="stack" style={{ marginTop: 8 }} dir="rtl">
              <label className="field">السؤال<textarea aria-label={`Question ${i + 1} (Arabic)`} value={q.question_ar ?? ''} rows={2} onChange={(e) => set(i, { question_ar: e.target.value || null })} /></label>
              {q.options.map((_, k) => (
                <input key={k} aria-label={`Question ${i + 1} option ${k + 1} (Arabic)`} placeholder={`الخيار ${k + 1}`} value={q.options_ar?.[k] ?? ''} onChange={(e) => set(i, { options_ar: q.options.map((__, j) => (j === k ? e.target.value : (q.options_ar?.[j] ?? ''))) })} />
              ))}
              <label className="field">الشرح عند الخطأ<input value={q.explanation_ar ?? ''} onChange={(e) => set(i, { explanation_ar: e.target.value || null })} /></label>
            </div>
          </details>
        </div>
      ))}
      <div className="row">
        <button className="btn ghost" onClick={() => setQs((all) => [...all, { position: all.length + 1, question: '', options: ['', ''], correct: 0, explanation: '', active: true }])}>Add question</button>
        <button className="btn" onClick={save} disabled={qs.some((q) => q.question.trim().length < 10 || q.options.some((o) => !o.trim()))}>Save test</button>
      </div>
    </div>
  );
}

/** Creator affiliate codes (finance): give a streamer a code and a share of the commission. */
export function AffiliatesPanel() {
  const { data, error, reload, setError } = useLoad(() => api<any[]>('/admin/affiliates'));
  const [form, setForm] = useState({ userId: '', code: '', rate: '20', note: '' });
  const [msg, setMsg] = useState('');
  if (!data) return <p className="muted">{error || 'Loading…'}</p>;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setError('');
    setMsg('');
    try {
      await fn();
      setMsg(ok);
      reload();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="stack">
      <p className="muted small">A creator's code pays them a share of the commission on every order by a buyer who entered it (at signup or on their account page), on top of the referral reward. Earnings go to the creator's balance.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      {msg && <div className="ok" role="status">{msg}</div>}
      <form
        className="card grid two"
        onSubmit={(e) => {
          e.preventDefault();
          act(() => api('/admin/affiliates', { body: { userId: form.userId.trim(), code: form.code.trim(), rateBps: Math.round(Number(form.rate) * 100), note: form.note.trim() } }), `${form.code.trim().toUpperCase()} is live.`).then(() => setForm({ userId: '', code: '', rate: '20', note: '' }));
        }}
      >
        <label className="field">Creator's user ID<input value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} required placeholder="uuid" /></label>
        <label className="field">Code<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required minLength={3} maxLength={20} placeholder="STREAMER-X" /></label>
        <label className="field">Share of commission %<input type="number" min={0} max={50} step={1} value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} /></label>
        <label className="field">Note<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={300} placeholder="Twitch, 40k followers" /></label>
        <button className="btn" style={{ alignSelf: 'end' }}>Create code</button>
      </form>
      <div className="card table-wrap">
        <table className="data" aria-label="Creator codes">
          <thead><tr><th>Code</th><th>Creator</th><th>Share</th><th>Buyers</th><th>Orders</th><th>Earned</th><th /></tr></thead>
          <tbody>
            {data.length === 0 && <tr><td colSpan={7} className="muted">No creator codes yet.</td></tr>}
            {data.map((a) => (
              <tr key={a.id}>
                <td className="mono"><b>{a.code}</b>{a.status === 'paused' && <span className="chip held" style={{ marginInlineStart: 6 }}>Paused</span>}</td>
                <td>{a.display_name}<div className="small muted">{a.email}{a.note ? ` · ${a.note}` : ''}</div></td>
                <td className="mono">{(Number(a.rate_bps) / 100).toFixed(0)}%</td>
                <td className="mono">{a.buyers}</td>
                <td className="mono">{a.orders}</td>
                <td className="mono">{money(Number(a.earned_cents))}</td>
                <td>
                  <button className="btn ghost small" onClick={() => act(() => api(`/admin/affiliates/${a.id}`, { method: 'PATCH', body: { status: a.status === 'active' ? 'paused' : 'active' } }), `${a.code} ${a.status === 'active' ? 'paused' : 'active'}.`)}>
                    {a.status === 'active' ? 'Pause' : 'Resume'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
