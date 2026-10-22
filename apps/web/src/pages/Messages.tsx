import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Flag, Search } from 'lucide-react';
import { api } from '../api';
import { Chat } from '../components/Chat';
import { useSession } from '../session';
import { usePageMeta } from '@/lib/seo';
import { t } from '../i18n';
import { STATUS_CHIP, matchesOrder, orderRef, statusLabel } from '@/lib/orderUi';

type Room = {
  id: string;
  order_id: string | null;
  offer_id: string | null;
  buyer_id: string;
  seller_id: string;
  buyer_name?: string;
  seller_name?: string;
  offer_title?: string | null;
  order_status?: string | null;
  order_ref?: string | null;
  last_message?: string | null;
  last_kind?: string | null;
  last_sender_id?: string | null;
  last_at?: string | null;
};

const initials = (n = '?') => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const when = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** Inbox: every order chat and pre-sale question in one place. The thread itself is the order chat. */
export function Messages() {
  usePageMeta({ title: t('nav.messages'), noindex: true });
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'all' | 'orders' | 'questions'>('all');
  const selected = params.get('room');

  useEffect(() => {
    if (!user) return;
    api<Room[]>('/chat/rooms').then(setRooms).catch(() => setRooms([]));
  }, [user, selected]);

  const other = (r: Room) => (r.buyer_id === user?.id ? r.seller_name : r.buyer_name) ?? t('chat.user');
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (rooms ?? [])
      .filter((r) => tab === 'all' || (tab === 'orders' ? !!r.order_id : !r.order_id))
      .filter((r) => !term || other(r).toLowerCase().includes(term) || (r.offer_title ?? '').toLowerCase().includes(term) || (!!r.order_id && matchesOrder(term, { id: r.order_id, ref: r.order_ref })));
  }, [rooms, q, tab, user]);
  const room = rooms?.find((r) => r.id === selected) ?? null;

  if (!user)
    return (
      <div className="card" style={{ maxWidth: 520 }}>
        <p className="muted" style={{ margin: 0 }}>{t('messages.signIn')} <Link to="/login?next=/messages">{t('nav.signIn')}</Link></p>
      </div>
    );

  return (
    <div className={`inbox ${room ? 'has-room' : ''}`}>
      <aside className="inbox-list" aria-label={t('nav.messages')}>
        <h1 className="inbox-title">{t('nav.messages')}</h1>
        <label className="inbox-search">
          <Search className="size-4" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('messages.search')} aria-label={t('messages.search')} />
        </label>
        <div className="inbox-tabs" role="group" aria-label={t('messages.filter')}>
          {(['all', 'orders', 'questions'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{t(`messages.tab.${k}`)}</button>
          ))}
        </div>
        <div className="inbox-rows">
          {rooms === null ? (
            <p className="muted small" style={{ padding: 16 }}>{t('home.loading')}</p>
          ) : list.length === 0 ? (
            <p className="muted small" style={{ padding: 16 }}>{rooms.length ? t('messages.noMatch', { q }) : t('messages.empty')}</p>
          ) : (
            list.map((r) => (
              <button
                key={r.id}
                type="button"
                className="inbox-row"
                aria-current={r.id === selected ? 'true' : undefined}
                onClick={() => setParams({ room: r.id })}
              >
                <span className="avatar-sm" aria-hidden>{initials(other(r))}</span>
                <b className="truncate">{other(r)}</b>
                <span className="inbox-time">{when(r.last_at)}</span>
                <span className="inbox-preview" dir="auto">
                  {r.last_sender_id === user.id ? `${t('messages.you')}: ` : ''}
                  {r.last_message ?? r.offer_title ?? ''}
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="inbox-thread">
        {room ? (
          <>
            <div className="inbox-thread-head">
              <button type="button" className="icon-link inbox-back" onClick={() => setParams({})} aria-label={t('messages.back')}>
                <ArrowLeft className="size-[18px] rtl:rotate-180" />
              </button>
              <span className="avatar-sm" aria-hidden>{initials(other(room))}</span>
              <div className="min-w-0 flex-1">
                <b className="block truncate">{other(room)}</b>
                <span className="small muted block truncate">{room.buyer_id === user.id ? t('messages.seller') : t('messages.buyer')}</span>
              </div>
              {!room.order_id && room.offer_id && <Link className="btn ghost" to={`/offers/${room.offer_id}`}>{t('messages.openListing')}</Link>}
            </div>
            {room.order_id && (
              <div className="inbox-strip">
                <span className="mono muted" dir="ltr">{orderRef({ id: room.order_id, ref: room.order_ref })}</span>
                <b className="min-w-0 flex-1 truncate">{room.offer_title}</b>
                {room.order_status && <span className={`chip ${STATUS_CHIP[room.order_status] ?? ''}`}>{statusLabel(room.order_status)}</span>}
                <Link className="btn ghost sm" to={`/orders/${room.order_id}`}>{t('messages.openOrder')}</Link>
              </div>
            )}
            <Chat roomId={room.id} meId={user.id} names={{ [room.buyer_id]: room.buyer_name ?? '', [room.seller_id]: room.seller_name ?? '' }} />
          </>
        ) : (
          <div className="inbox-empty">
            <p className="muted">{rooms?.length ? t('messages.pick') : t('messages.empty')}</p>
          </div>
        )}
      </section>
      {room && (
        <aside className="inbox-side" aria-label={t('messages.about', { name: other(room) })}>
          <div className="inbox-side-who">
            <span className="avatar-sm avatar-lg" aria-hidden>{initials(other(room))}</span>
            <b>{other(room)}</b>
            {room.buyer_id === user.id && <Link className="small" to={`/sellers/${room.seller_id}`}>{t('messages.viewShop')}</Link>}
          </div>
          {room.order_id && (
            <>
              <p className="eyebrow" style={{ margin: 0 }}>{t('messages.thisOrder')}</p>
              <Link className="inbox-order" to={`/orders/${room.order_id}`}>
                <span className="row spread" style={{ flexWrap: 'nowrap' }}>
                  <span className="small muted mono" dir="ltr">{orderRef({ id: room.order_id, ref: room.order_ref })}</span>
                  {room.order_status && <span className={`chip ${STATUS_CHIP[room.order_status] ?? ''}`}>{statusLabel(room.order_status)}</span>}
                </span>
                <b>{room.offer_title}</b>
              </Link>
            </>
          )}
          <Link className="small inbox-report" to={`/support/new?category=${room.order_id ? `order&order=${room.order_id}` : 'report'}`}>
            <Flag className="size-4" aria-hidden /> {t('messages.report')}
          </Link>
        </aside>
      )}
    </div>
  );
}
