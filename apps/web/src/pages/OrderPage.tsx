import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, money, realtime } from '../api';
import { Chat } from '../components/Chat';
import { EscrowTrack, formatRemaining, type TrackVariant } from '../components/EscrowTrack';
import { useSession } from '../session';
import { usePageMeta } from '@/lib/seo';

interface OrderDetail {
  id: string;
  buyer_id: string;
  seller_id: string;
  buyer_name: string;
  seller_name: string;
  offer_id: string;
  offer_title: string;
  game: string;
  category_kind: string;
  delivery_mode: string;
  quantity: number;
  amount_cents: number;
  currency: string;
  commission_bps: number;
  seller_net_cents: number;
  seller_tier: string;
  rail: 'fiat' | 'crypto';
  status: string;
  protection: 'inspection_72h' | 'insurance_14d';
  protection_ends_at: string | null;
  delivered_at: string | null;
  escrow_frozen: boolean;
  seller_protected: boolean;
  room_id: string;
  checklist: { items: Array<{ key: string; label: string; done: boolean }>; completed_at: string | null } | null;
  dispute: { reason: string; status: string } | null;
  review: { rating: number; comment: string; seller_reply: string | null } | null;
  events: Array<{ from_status: string | null; to_status: string; reason: string; created_at: string }>;
}

const STATUS_TEXT: Record<string, string> = {
  awaiting_payment: 'Waiting for payment',
  paid: 'Paid, awaiting delivery',
  delivered: 'Delivered, in protection window',
  completed: 'Completed',
  disputed: 'Dispute open',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
  charged_back: 'Charged back',
};

export function OrderPage() {
  usePageMeta({ title: 'Order', noindex: true });
  const { id } = useParams();
  const { user } = useSession();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [items, setItems] = useState<Array<{ id: string; content: string }>>([]);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState('');
  const [reason, setReason] = useState('');
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const o = await api<OrderDetail>(`/orders/${id}`);
      setOrder(o);
      if (user && o.buyer_id === user.id && ['delivered', 'completed', 'disputed'].includes(o.status)) {
        setItems(await api(`/orders/${id}/items`));
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [id, user]);

  useEffect(() => {
    load();
    const off = realtime.listen((f) => f.type === 'notification' && f.data?.orderId === id && load());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, [id, load]);

  if (!order || !user) return <p className="muted">{error || 'Loading order…'}</p>;
  const isBuyer = user.id === order.buyer_id;
  const isSeller = user.id === order.seller_id;

  const act = async (path: string, body?: unknown) => {
    setError('');
    try {
      await api(`/orders/${order.id}/${path}`, { method: body === undefined ? 'POST' : path === 'checklist' ? 'PATCH' : 'POST', body: body ?? {} });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const windowMs = order.protection === 'insurance_14d' ? 14 * 86_400_000 : 72 * 3_600_000;
  const ends = order.protection_ends_at ? new Date(order.protection_ends_at).getTime() : 0;
  const elapsed = order.status === 'delivered' && ends ? 1 - (ends - now) / windowMs : 0;
  const stage: 0 | 1 | 2 = ['completed'].includes(order.status) ? 2 : ['awaiting_payment', 'cancelled'].includes(order.status) ? 0 : 1;
  const variant: TrackVariant =
    order.status === 'completed' ? 'released' : ['refunded', 'charged_back', 'cancelled'].includes(order.status) ? 'refunded' : order.status === 'disputed' || order.escrow_frozen ? 'disputed' : 'held';
  const clock = order.status === 'delivered' ? formatRemaining(ends - now) : STATUS_TEXT[order.status];
  const checklistDone = !order.checklist || !!order.checklist.completed_at;
  const names = { [order.buyer_id]: order.buyer_name, [order.seller_id]: order.seller_name };

  return (
    <div className="stack">
      <div className="row spread">
        <div>
          <div className="eyebrow">Order {order.id.slice(0, 8)} · {order.game}</div>
          <h1 style={{ fontSize: 36 }}>{order.offer_title}{order.quantity > 1 ? ` ×${order.quantity}` : ''}</h1>
        </div>
        <span className={`chip ${variant}`}>{STATUS_TEXT[order.status]}</span>
      </div>

      <div className="card">
        <EscrowTrack
          amountCents={order.amount_cents}
          stage={stage}
          variant={variant}
          elapsed={elapsed}
          windowLabel={order.protection === 'insurance_14d' ? '14-day asset insurance' : '72-hour inspection'}
          clock={clock}
        />
        <p className="small muted" style={{ marginTop: 12 }}>
          {isSeller
            ? `You receive ${money(order.seller_net_cents, order.currency)} after the ${(order.commission_bps / 100).toFixed(2)}% ${order.seller_tier} tier fee.`
            : `Paid ${money(order.amount_cents, order.currency)} via ${order.rail === 'crypto' ? 'on-chain escrow' : 'card'}.`}
          {order.escrow_frozen && order.status !== 'disputed' && ' This order is in a routine security review; funds stay in escrow until it finishes.'}{' '}
          <Link to={`/support/new?category=order&order=${order.id}`}>Get help with this order</Link>
        </p>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="order-layout">
        <div className="stack">
          {order.status === 'awaiting_payment' && isBuyer && order.rail === 'crypto' && <CryptoDeposit orderId={order.id} />}

          {items.length > 0 && (
            <div className="card stack">
              <h3>Your delivery</h3>
              {items.map((i) => (
                <div key={i.id} className="secret">{i.content}</div>
              ))}
              <p className="small muted">Only you can see this. Save it somewhere safe.</p>
            </div>
          )}

          {isBuyer && order.checklist && order.status === 'delivered' && (
            <div className="card stack checklist">
              <h3>Security changeover</h3>
              <p className="small muted">Secure the account before confirming. Each step takes the account further out of the previous owner's reach.</p>
              <div>
                {order.checklist.items.map((i) => (
                  <label key={i.key}>
                    <input type="checkbox" checked={i.done} onChange={(e) => act('checklist', { key: i.key, done: e.target.checked })} />
                    <span>{i.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {isSeller && order.status === 'paid' && order.delivery_mode === 'manual' && (
            <div className="card stack">
              <h3>Deliver this order</h3>
              <label className="field">
                Delivery details (stored encrypted, visible only to the buyer)
                <textarea value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="Login, password, recovery details or completion notes" />
              </label>
              <button className="btn release" disabled={order.escrow_frozen} onClick={() => act('deliver', { payload: payload || undefined })}>Mark as delivered</button>
            </div>
          )}

          {isBuyer && order.status === 'delivered' && order.rail === 'fiat' && (
            <div className="card stack">
              <h3>Everything working?</h3>
              <p className="small muted">Confirming releases the payment to the seller now. You can't open a dispute after that.</p>
              <button className="btn release" disabled={!checklistDone || order.escrow_frozen} onClick={() => act('confirm')}>Confirm and release payment</button>
              {!checklistDone && <p className="small muted">Finish the security changeover first.</p>}
            </div>
          )}

          {(isBuyer || isSeller) && ['paid', 'delivered'].includes(order.status) && order.rail === 'fiat' && (
            <details className="card">
              <summary style={{ cursor: 'pointer' }}><b>Open a dispute</b></summary>
              <div className="stack" style={{ marginTop: 12 }}>
                <p className="small muted">Escrow freezes and an arbiter reviews this order's chat. Describe what happened and add any proof in the chat.</p>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What went wrong?" />
                <button className="btn dispute" disabled={reason.trim().length < 10} onClick={() => act('dispute', { reason })}>Open dispute</button>
              </div>
            </details>
          )}

          {isBuyer && order.status === 'completed' && !order.review && <ReviewForm orderId={order.id} onDone={load} />}
          {order.review && (
            <div className="card stack">
              <h3>Review</h3>
              <p><span className="mono">{'★'.repeat(order.review.rating)}{'☆'.repeat(5 - order.review.rating)}</span> {order.review.comment}</p>
              {order.review.seller_reply && <p className="small muted">Seller replied: {order.review.seller_reply}</p>}
            </div>
          )}

          {order.dispute && (
            <div className="alert">
              <b>Dispute ({order.dispute.status.replace('_', ' ')}):</b> {order.dispute.reason}
            </div>
          )}

          <div className="card">
            <h3>History</h3>
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {order.events.map((e, i) => (
                    <tr key={i}>
                      <td className="mono small">{new Date(e.created_at).toLocaleString()}</td>
                      <td>{STATUS_TEXT[e.to_status] ?? e.to_status}</td>
                      <td className="small muted">{e.reason.replace(/_/g, ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <Link to="/orders" className="small">All orders</Link>
        </div>
        <Chat roomId={order.room_id} meId={user.id} names={names} />
      </div>
    </div>
  );
}

function CryptoDeposit({ orderId }: { orderId: string }) {
  const [wallet, setWallet] = useState('');
  const [terms, setTerms] = useState<unknown>(null);
  const [error, setError] = useState('');
  const fetchTerms = async () => {
    setError('');
    try {
      setTerms(await api(`/orders/${orderId}/crypto-terms?token=USDC&wallet=${wallet}`));
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="card stack">
      <h3>Deposit USDC into escrow</h3>
      <p className="muted small">
        Get the escrow terms signed for your wallet, then call <span className="mono">createEscrow(terms, signature)</span> on the escrow
        contract. This order updates by itself once the deposit has 3 confirmations.
      </p>
      <div className="row">
        <input className="mono" placeholder="0x… (the wallet you will pay from)" value={wallet} onChange={(e) => setWallet(e.target.value.trim())} style={{ flex: 1 }} />
        <button className="btn ghost" disabled={!/^0x[0-9a-fA-F]{40}$/.test(wallet)} onClick={fetchTerms}>Get signed terms</button>
      </div>
      {error && <div className="alert">{error}</div>}
      {terms !== null && <pre className="secret" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(terms, null, 2)}</pre>}
    </div>
  );
}

function ReviewForm({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    try {
      await api(`/orders/${orderId}/review`, { body: { rating, comment } });
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="card stack">
      <h3>Rate this seller</h3>
      <div className="row" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className={`btn ${n <= rating ? '' : 'ghost'}`} aria-checked={n === rating} role="radio" onClick={() => setRating(n)}>
            {n}★
          </button>
        ))}
      </div>
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What went well or badly? (optional)" maxLength={1000} style={{ minHeight: 70 }} />
      {error && <div className="alert">{error}</div>}
      <button className="btn" onClick={submit}>Post review</button>
    </div>
  );
}
