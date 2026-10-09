import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';

interface Claim {
  id: string;
  order_id: string;
  title: string;
  reason: 'recovered' | 'banned' | 'locked' | 'other';
  details: string;
  seller_message: string | null;
  amount_cents: number;
  currency: string;
  buyer_name: string;
  seller_name: string;
  created_at: string;
  updated_at: string;
}

const REASON: Record<Claim['reason'], string> = { recovered: 'Taken back by original owner', banned: 'Banned', locked: 'Locked', other: 'Something else' };

/** Staff: account warranty claims the seller contested, ignored, or the buyer says weren't fixed. */
export function WarrantyPanel() {
  const [rows, setRows] = useState<Claim[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<Claim[]>('/admin/warranty-claims').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  if (error) return <div className="alert">{error}</div>;
  if (!rows) return <p className="muted">Loading…</p>;
  if (!rows.length) return <div className="card"><p className="muted">No warranty claims waiting for an arbiter.</p></div>;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Account warranty claims after release. A refund comes from the seller’s balance (this order’s payout was held for the warranty) unless you pick otherwise.
      </p>
      {rows.map((c) => <ClaimCard key={c.id} c={c} onDone={load} />)}
    </div>
  );
}

function ClaimCard({ c, onDone }: { c: Claim; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [paidBy, setPaidBy] = useState<'seller' | 'platform' | 'reserve'>('seller');
  const [error, setError] = useState('');
  const decide = async (outcome: 'refund' | 'reject') => {
    setError('');
    try {
      await api(`/admin/warranty-claims/${c.id}/decide`, { body: { outcome, note, paidBy: outcome === 'refund' ? paidBy : undefined } });
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="card stack">
      <div className="row spread">
        <b>{c.title}</b>
        <span className="mono">{money(c.amount_cents, c.currency)}</span>
      </div>
      <div className="small muted">{REASON[c.reason]} · buyer {c.buyer_name} · seller {c.seller_name} · claimed {new Date(c.created_at).toLocaleDateString()}</div>
      <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.details}</div>
      {c.seller_message && <div className="small muted">Seller: {c.seller_message}</div>}
      <Link to={`/orders/${c.order_id}`} className="small">Open the order and chat</Link>
      <label className="field">Decision note (shown to both)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label>
      <div className="row">
        <select aria-label="Who pays the refund" value={paidBy} onChange={(e) => setPaidBy(e.target.value as typeof paidBy)} style={{ width: 200 }}>
          <option value="seller">Seller pays</option>
          <option value="platform">Platform goodwill</option>
          <option value="reserve">Chargeback reserve</option>
        </select>
        <button className="btn" disabled={note.trim().length < 5} onClick={() => decide('refund')}>Refund buyer</button>
        <button className="btn ghost" disabled={note.trim().length < 5} onClick={() => decide('reject')}>Reject claim</button>
      </div>
      {error && <div className="alert">{error}</div>}
    </div>
  );
}
