import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { useLoad } from './AdminPanels';

const fmt = (d: string) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const hoursAgo = (d: string) => Math.floor((Date.now() - new Date(d).getTime()) / 3_600_000);

// ---------------------------------------------------------------------------
// Payouts: seller withdrawals waiting for the CFO
// ---------------------------------------------------------------------------
export function PayoutsPanel() {
  const { data, error, reload } = useLoad(() => api<any[]>('/admin/withdrawals'));
  const [note, setNote] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const decide = async (id: string, approve: boolean) => {
    setMsg('');
    try {
      const w = await api<any>(`/admin/withdrawals/${id}/decide`, { body: { approve, note: note[id] || undefined } });
      setMsg(approve ? `Approved: ${money(Number(w.net_cents), w.currency)} is being sent.` : 'Rejected; the amount is back in the seller’s balance.');
      reload();
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  const recheck = async (id: string) => {
    setMsg('');
    try {
      const w = await api<any>(`/admin/withdrawals/${id}/recheck`, { body: {} });
      setMsg(
        w.status === 'processing' ? 'The provider has this payout; waiting for it to finish.'
        : w.status === 'paid' ? 'The provider sent this payout; it is marked paid.'
        : w.status === 'failed' ? 'The provider never created it (checked twice, hours apart); the amount is back in the seller’s balance.'
        : 'Still unknown: the provider has no record yet. It is reversed only after two checks and several hours.',
      );
      reload();
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Seller withdrawals in crypto. Each one waits here until a finance member approves it; the fee (6%, at least $1.50) is booked as revenue on approval and the net is sent
        from the store wallet. Rejecting returns the whole amount to the seller.
      </p>
      {error && <div className="alert" role="alert">{error}</div>}
      {msg && <div className="notice" role="status">{msg}</div>}
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="data">
          <thead><tr><th>Seller</th><th>Requested</th><th>Fee</th><th>Sends</th><th>To</th><th>Asked</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={8} className="muted">Loading…</td></tr>
            ) : data.length === 0 ? (
              <tr><td colSpan={8} className="muted">Nothing waiting.</td></tr>
            ) : (
              data.map((w) => (
                <tr key={w.id}>
                  <td>{w.display_name}<div className="small muted">{w.email} · KYC {w.kyc_tier} · {w.trust_level}</div></td>
                  <td className="mono">{money(Number(w.amount_cents), w.currency)}</td>
                  <td className="mono muted">{money(Number(w.fee_cents), w.currency)}</td>
                  <td className="mono">{money(Number(w.net_cents), w.currency)}</td>
                  <td className="small"><code className="mono" style={{ wordBreak: 'break-all' }}>{w.destination_address}</code><div className="muted">{String(w.destination_currency).toUpperCase()}</div></td>
                  <td className="small">{fmt(w.created_at)}</td>
                  <td><span className={`chip ${w.status === 'processing' ? 'held' : w.status === 'unknown' ? 'disputed' : ''}`}>{w.status === 'processing' ? 'sending' : w.status === 'unknown' ? 'provider did not answer' : 'awaiting approval'}</span></td>
                  <td>
                    {w.status === 'unknown' && (
                      <div className="stack" style={{ gap: 6, minWidth: 200 }}>
                        <span className="small muted">The payout call timed out. Nothing is reversed until NOWPayments says whether it exists (checked hourly).</span>
                        <button className="btn ghost" onClick={() => recheck(w.id)}>Check with provider now</button>
                      </div>
                    )}
                    {w.status === 'pending_approval' && (
                      <div className="stack" style={{ gap: 6, minWidth: 200 }}>
                        <input placeholder="Note (optional)" value={note[w.id] ?? ''} onChange={(e) => setNote({ ...note, [w.id]: e.target.value })} aria-label={`Note for withdrawal ${w.id.slice(0, 8)}`} />
                        <div className="row" style={{ gap: 6 }}>
                          <button className="btn release" onClick={() => decide(w.id, true)}>Approve</button>
                          <button className="btn ghost" onClick={() => decide(w.id, false)}>Reject</button>
                        </div>
                      </div>
                    )}
                  </td>
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
// Crypto refunds: sent by hand from the store wallet
// ---------------------------------------------------------------------------
export function CryptoRefundsPanel() {
  const [status, setStatus] = useState<'pending' | 'awaiting_address' | 'sent'>('pending');
  const { data, error, reload } = useLoad(() => api<any[]>('/admin/crypto/refunds'));
  const [hash, setHash] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const rows = (data ?? []).filter((r) => r.status === status);
  const sent = async (id: string) => {
    setMsg('');
    try {
      await api(`/admin/crypto/refunds/${id}/sent`, { body: { txHash: hash[id] } });
      setMsg('Recorded; the buyer gets an email with the transaction.');
      reload();
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Refunds on crypto orders are sent by hand: the buyer gives an address, you send the coins from the store wallet and paste the transaction hash here. Until then the
        amount sits in the refunds-payable account.
      </p>
      <div className="filters" role="group" aria-label="Refund status" style={{ margin: 0 }}>
        <button aria-pressed={status === 'pending'} onClick={() => setStatus('pending')}>To send</button>
        <button aria-pressed={status === 'awaiting_address'} onClick={() => setStatus('awaiting_address')}>Waiting for an address</button>
        <button aria-pressed={status === 'sent'} onClick={() => setStatus('sent')}>Sent</button>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {msg && <div className="notice" role="status">{msg}</div>}
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="data">
          <thead><tr><th>Buyer</th><th>Order</th><th>Amount</th><th>Reason</th><th>Send to</th><th>Since</th><th></th></tr></thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={7} className="muted">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="muted">Nothing here.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.buyer_name}<div className="small muted">{r.buyer_email}</div></td>
                  <td className="small"><Link to={`/orders/${r.order_id}`}>{r.order_id.slice(0, 8)}</Link></td>
                  <td className="mono">{money(Number(r.amount_cents), r.currency)}</td>
                  <td className="small">{r.reason}</td>
                  <td className="small">{r.refund_address ? <><code className="mono" style={{ wordBreak: 'break-all' }}>{r.refund_address}</code><div className="muted">{String(r.refund_currency).toUpperCase()}</div></> : <span className="muted">—</span>}</td>
                  <td className="small">{fmt(r.created_at)}</td>
                  <td>
                    {r.status === 'pending' && (
                      <div className="row" style={{ gap: 6 }}>
                        <input placeholder="Transaction hash" value={hash[r.id] ?? ''} onChange={(e) => setHash({ ...hash, [r.id]: e.target.value })} aria-label={`Transaction hash for refund ${r.id.slice(0, 8)}`} style={{ minWidth: 180 }} />
                        <button className="btn" disabled={!(hash[r.id] ?? '').trim()} onClick={() => sent(r.id)}>Mark sent</button>
                      </div>
                    )}
                    {r.status === 'sent' && <code className="mono small" style={{ wordBreak: 'break-all' }}>{r.tx_hash}</code>}
                  </td>
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
// Releases: delivered orders the buyer never confirmed
// ---------------------------------------------------------------------------
export function ReleasesPanel() {
  const { data, error, reload } = useLoad(() => api<any[]>('/admin/orders/unconfirmed'));
  const [note, setNote] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const release = async (id: string) => {
    setMsg('');
    try {
      await api(`/admin/orders/${id}/release`, { body: { note: note[id] } });
      setMsg('Released to the seller.');
      reload();
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Orders delivered more than 24 hours ago that the buyer has not confirmed. Open the order, check the seller’s delivery proof in the chat and the buyer’s last message, then
        release with a note. Orders with an open dispute are not listed; a frozen order can’t be released.
      </p>
      {error && <div className="alert" role="alert">{error}</div>}
      {msg && <div className="notice" role="status">{msg}</div>}
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="data">
          <thead><tr><th>Order</th><th>Buyer</th><th>Seller</th><th>Amount</th><th>Delivered</th><th>Buyer last wrote</th><th>Tickets</th><th></th></tr></thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={8} className="muted">Loading…</td></tr>
            ) : data.length === 0 ? (
              <tr><td colSpan={8} className="muted">Nothing waiting for a release.</td></tr>
            ) : (
              data.map((o) => (
                <tr key={o.id}>
                  <td><Link to={`/orders/${o.id}`}>{o.title}</Link><div className="small muted">{o.game}{o.protection === 'insurance_14d' ? ' · account, 14-day window' : ''}</div></td>
                  <td className="small">{o.buyer_name}</td>
                  <td className="small">{o.seller_name}</td>
                  <td className="mono">{money(Number(o.amount_cents), o.currency)}</td>
                  <td className="small">{hoursAgo(o.delivered_at)} h ago</td>
                  <td className="small">{o.buyer_last_message_at ? fmt(o.buyer_last_message_at) : <span className="muted">never</span>}</td>
                  <td className="mono">{o.open_tickets}</td>
                  <td>
                    <div className="stack" style={{ gap: 6, minWidth: 220 }}>
                      <input placeholder="What you checked" value={note[o.id] ?? ''} onChange={(e) => setNote({ ...note, [o.id]: e.target.value })} aria-label={`Release note for ${o.title}`} />
                      <button className="btn release" disabled={(note[o.id] ?? '').trim().length < 3} onClick={() => release(o.id)}>Release to seller</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
