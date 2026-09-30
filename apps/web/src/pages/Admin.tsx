import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiBlob, money } from '../api';
import { useSession } from '../session';

type Tab = 'disputes' | 'risk' | 'proofs' | 'chargebacks' | 'ledger';

const TABS: Array<{ id: Tab; label: string; adminOnly?: boolean }> = [
  { id: 'disputes', label: 'Disputes' },
  { id: 'proofs', label: 'Owner proofs' },
  { id: 'risk', label: 'Fraud review', adminOnly: true },
  { id: 'chargebacks', label: 'Chargebacks', adminOnly: true },
  { id: 'ledger', label: 'Ledger', adminOnly: true },
];

const fmt = (d: string) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Admin() {
  const { user } = useSession();
  const [tab, setTab] = useState<Tab>('disputes');
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [mfaNeeded, setMfaNeeded] = useState(false);

  const path: Record<Tab, string> = {
    disputes: '/admin/disputes',
    risk: '/admin/risk-flags',
    proofs: '/admin/owner-proofs',
    chargebacks: '/admin/chargebacks',
    ledger: '/admin/ledger/summary',
  };

  const load = useCallback(async () => {
    setRows(null);
    setError('');
    try {
      setRows(await api<any[]>(path[tab]));
    } catch (e: any) {
      if (e.code === 'mfa_required') setMfaNeeded(true);
      else setError(e.message);
      setRows([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (user && user.role !== 'user') load();
  }, [user, load]);

  if (!user || user.role === 'user') return <div className="card"><h2>Staff only</h2><p className="muted">This area is for arbiters and admins.</p></div>;
  if (mfaNeeded) {
    return (
      <div className="notice" style={{ maxWidth: 640 }}>
        Staff tools need a session signed in with two-factor login. <Link to="/account">Turn on two-factor login</Link>, then sign out and back in.
      </div>
    );
  }

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const openPdf = async (id: string) => {
    try {
      const url = URL.createObjectURL(await apiBlob(`/admin/chargebacks/${id}/packet.pdf`));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const visible = TABS.filter((t) => !t.adminOnly || user.role === 'admin');

  return (
    <div className="stack">
      <h1 style={{ fontSize: 40 }}>Operations</h1>
      <div className="filters" role="tablist">
        {visible.map((t) => (
          <button key={t.id} role="tab" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {error && <div className="alert">{error}</div>}
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card"><p className="muted">Nothing waiting here.</p></div>
      ) : tab === 'disputes' ? (
        <div className="stack">
          {rows.map((d) => <DisputeCard key={d.id} d={d} onResolve={(outcome, note) => act(() => api(`/admin/disputes/${d.id}/resolve`, { body: { outcome, note } }))} />)}
        </div>
      ) : tab === 'risk' ? (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>Account</th><th>Score</th><th>Why</th><th /></tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td>{f.display_name}<div className="small muted">{f.email}{f.withdrawals_frozen ? ' · payouts frozen' : ''}</div></td>
                  <td className="mono">{Number(f.score).toFixed(2)}</td>
                  <td className="small">{(f.reasons as any[]).map((r) => r.code.replace(/_/g, ' ')).join(', ')}{f.order_id && <> · <Link to={`/orders/${f.order_id}`}>order</Link></>}</td>
                  <td>
                    <div className="row">
                      <button className="btn ghost" onClick={() => act(() => api(`/admin/risk-flags/${f.id}/review`, { body: { decision: 'clear' } }))}>Clear and unfreeze</button>
                      <button className="btn dispute" onClick={() => confirm(`Suspend ${f.display_name}?`) && act(() => api(`/admin/risk-flags/${f.id}/review`, { body: { decision: 'confirm' } }))}>Confirm fraud</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === 'proofs' ? (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>Listing</th><th>Registration</th><th>Billing name vs verified ID</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => {
                const match = !p.billing_name || !p.seller_legal_name || p.billing_name.trim().toLowerCase() === p.seller_legal_name.trim().toLowerCase();
                return (
                  <tr key={p.id}>
                    <td>{p.title}</td>
                    <td className="small">{p.registration_email}<div className="muted">{p.registration_date?.slice(0, 10)}</div></td>
                    <td className="small">{p.billing_name ?? '—'} / {p.seller_legal_name ?? '—'} {!match && <span className="chip disputed">mismatch</span>}</td>
                    <td>
                      <div className="row">
                        <button className="btn release" disabled={!match} onClick={() => act(() => api(`/admin/owner-proofs/${p.id}/review`, { body: { approve: true } }))}>Verify</button>
                        <button className="btn ghost" onClick={() => act(() => api(`/admin/owner-proofs/${p.id}/review`, { body: { approve: false, note: 'Evidence insufficient' } }))}>Reject</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : tab === 'chargebacks' ? (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>Order</th><th>Code</th><th>Amount</th><th>Respond by</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((c) => {
                const days = Math.ceil((new Date(c.respond_by).getTime() - Date.now()) / 86_400_000);
                return (
                  <tr key={c.id}>
                    <td><Link to={`/orders/${c.order_id}`} className="mono">{c.order_id.slice(0, 8)}</Link></td>
                    <td className="mono">{c.network} {c.reason_code}<div className="small muted">{c.category.replace(/_/g, ' ')}</div></td>
                    <td className="mono">{money(c.amount_cents)}</td>
                    <td className="small">{fmt(c.respond_by)}<div className={days <= 5 ? '' : 'muted'} style={days <= 5 ? { color: 'var(--disputed)' } : undefined}>{days} days left</div></td>
                    <td><span className={`chip ${c.status === 'won' ? 'released' : c.status === 'lost' ? 'disputed' : 'held'}`}>{c.status.replace('_', ' ')}</span></td>
                    <td>{c.packet_sha256 && <button className="btn ghost" onClick={() => openPdf(c.id)}>Evidence PDF</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>Platform account</th><th>Balance</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.kind + r.currency}>
                  <td>{r.kind.replace(/_/g, ' ')}</td>
                  <td className="mono">{money(r.balance_cents, r.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 12 }}>Gateway clearing is negative by the amount the payment partner holds for us. Escrow is buyer money awaiting release.</p>
        </div>
      )}
    </div>
  );
}

function DisputeCard({ d, onResolve }: { d: any; onResolve: (outcome: 'buyer' | 'seller', note: string) => void }) {
  const [note, setNote] = useState('');
  return (
    <div className="card stack">
      <div className="row spread">
        <div>
          <b>{money(d.amount_cents, d.currency)}</b> <span className="muted small">opened {fmt(d.created_at)}</span>
        </div>
        <Link to={`/orders/${d.order_id}`}>Read order and chat</Link>
      </div>
      <p>“{d.reason}”</p>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Decision note (shared in the order record)" style={{ minHeight: 70 }} />
      <div className="row">
        <button className="btn ghost" disabled={note.trim().length < 3} onClick={() => onResolve('buyer', note)}>Refund buyer</button>
        <button className="btn release" disabled={note.trim().length < 3} onClick={() => onResolve('seller', note)}>Release to seller</button>
      </div>
    </div>
  );
}
