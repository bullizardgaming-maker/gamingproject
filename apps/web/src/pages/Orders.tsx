import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, money } from '../api';
import { Chat } from '../components/Chat';
import { useSession } from '../session';
import { t } from '../i18n';
import { usePageMeta } from '@/lib/seo';
import { StatusEye } from '../components/StatusEye';

const STATUSES = ['awaiting_payment', 'paid', 'delivered', 'completed', 'disputed', 'refunded', 'cancelled'] as const;
const statusText = (s: string) => ((STATUSES as readonly string[]).includes(s) ? t(`orders.status.${s as (typeof STATUSES)[number]}`) : s.replace('_', ' '));

export function Orders() {
  usePageMeta({ title: t('orders.meta'), noindex: true });
  const [params, setParams] = useSearchParams();
  const as = params.get('as') === 'seller' ? 'seller' : 'buyer';
  const [orders, setOrders] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const { user, loading } = useSession();

  // Round 25c: wait for the session (a reload restores it from the refresh cookie) before asking for the orders.
  useEffect(() => {
    if (loading || !user) return;
    setOrders(null);
    setError('');
    api<any[]>(`/orders?as=${as}`).then(setOrders).catch((e) => (setError(e.message), setOrders([])));
  }, [as, loading, user?.id]);

  if (!loading && !user) return <p className="muted"><Link to="/login?next=/orders">{t('nav.signIn')}</Link></p>;

  return (
    <div className="stack">
      <h1 style={{ fontSize: 40 }}>{t('nav.orders')}</h1>
      <div className="filters" role="group" aria-label={t('orders.role')}>
        <button aria-pressed={as === 'buyer'} onClick={() => setParams({ as: 'buyer' })}>{t('orders.buying')}</button>
        <button aria-pressed={as === 'seller'} onClick={() => setParams({ as: 'seller' })}>{t('orders.selling')}</button>
      </div>
      {orders === null ? (
        <p className="muted">{t('common.loading')}</p>
      ) : error ? (
        <div className="alert" role="alert">{error}</div>
      ) : orders.length === 0 ? (
        <div className="card"><p className="muted">{t('orders.empty')} {as === 'buyer' ? <Link to="/market">{t('orders.browse')}</Link> : <Link to="/sell">{t('orders.create')}</Link>}</p></div>
      ) : (
        <div className="card table-wrap">
          <table className="data orders-table">
            <thead><tr><th>{t('orders.col.listing')}</th><th>{t('orders.col.amount')}</th><th>{t('orders.col.status')}</th><th>{t('orders.col.placed')}</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td><Link to={`/orders/${o.id}`}>{o.offer_title}</Link><div className="small muted">{o.ref ? <span className="mono">{o.ref} · </span> : null}{o.game}</div></td>
                  <td className="mono">{money(o.amount_cents, o.currency)}</td>
                  <td><StatusEye status={o.status} label={statusText(o.status)} /></td>
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
  usePageMeta({ title: t('orders.chatMeta'), noindex: true });
  const { id } = useParams();
  const { user } = useSession();
  const [room, setRoom] = useState<any>(null);
  useEffect(() => {
    api(`/chat/rooms/${id}`).then(setRoom).catch(() => {});
  }, [id]);
  if (!room || !user) return <p className="muted">{t('orders.chatLoading')}</p>;
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <Link to={`/offers/${room.offer_id}`} className="small">{t('orders.backToListing')}</Link>
      <Chat roomId={room.id} meId={user.id} names={{ [room.buyer_id]: room.buyer_name, [room.seller_id]: room.seller_name }} />
    </div>
  );
}
