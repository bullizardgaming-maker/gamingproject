import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, money } from '../api';
import { Chat } from '../components/Chat';
import { useSession } from '../session';

const CHIP: Record<string, string> = { completed: 'released', delivered: 'held', paid: 'held', disputed: 'disputed', charged_back: 'disputed' };

export function Orders() {
  const [params, setParams] = useSearchParams();
  const as = params.get('as') === 'seller' ? 'seller' : 'buyer';
  const [orders, setOrders] = useState<any[] | null>(null);

  useEffect(() => {
    setOrders(null);
    api<any[]>(`/orders?as=${as}`).then(setOrders).catch(() => setOrders([]));
  }, [as]);

  return (
    <div className="stack">
      <h1 style={{ fontSize: 40 }}>Orders</h1>
      <div className="filters" role="group" aria-label="Role">
        <button aria-pressed={as === 'buyer'} onClick={() => setParams({ as: 'buyer' })}>Buying</button>
        <button aria-pressed={as === 'seller'} onClick={() => setParams({ as: 'seller' })}>Selling</button>
      </div>
      {orders === null ? (
        <p className="muted">Loading…</p>
      ) : orders.length === 0 ? (
        <div className="card"><p className="muted">No orders yet. {as === 'buyer' ? <Link to="/market">Browse the market</Link> : <Link to="/sell">Create a listing</Link>}</p></div>
      ) : (
        <div className="card table-wrap">
          <table className="data">
            <thead><tr><th>Listing</th><th>Amount</th><th>Status</th><th>Placed</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td><Link to={`/orders/${o.id}`}>{o.offer_title}</Link><div className="small muted">{o.game}</div></td>
                  <td className="mono">{money(o.amount_cents, o.currency)}</td>
                  <td><span className={`chip ${CHIP[o.status] ?? ''}`}>{o.status.replace('_', ' ')}</span></td>
                  <td className="small muted">{new Date(o.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Pre-sale inquiry chat between a buyer and a seller. */
export function InquiryChat() {
  const { id } = useParams();
  const { user } = useSession();
  const [room, setRoom] = useState<any>(null);
  useEffect(() => {
    api(`/chat/rooms/${id}`).then(setRoom).catch(() => {});
  }, [id]);
  if (!room || !user) return <p className="muted">Loading chat…</p>;
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <Link to={`/offers/${room.offer_id}`} className="small">Back to listing</Link>
      <Chat roomId={room.id} meId={user.id} names={{ [room.buyer_id]: room.buyer_name, [room.seller_id]: room.seller_name }} />
    </div>
  );
}
