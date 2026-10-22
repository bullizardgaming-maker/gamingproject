import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, realtime, type ChatMessage } from '../api';
import { detectOffPlatform } from '@/lib/safety';
import { t, type MessageKey } from '../i18n';

/** Order chat. Messages are rendered strictly by server `seq`, never by client clocks. */
export function Chat({ roomId, meId, names, accountOrder = false }: { roomId: string; meId: string; names: Record<string, string>; /** Account handovers may carry the account's email. */ accountOrder?: boolean }) {
  const [messages, setMessages] = useState<Map<number, ChatMessage>>(new Map());
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(new Map());
    const merge = (list: ChatMessage[]) =>
      setMessages((prev) => {
        const next = new Map(prev);
        for (const m of list) if (m.room_id === roomId) next.set(m.seq, m);
        return next;
      });
    // REST backfill covers the gap before the socket is ready.
    api<ChatMessage[]>(`/chat/rooms/${roomId}/messages`).then(merge).catch((e) => setError(e.message));
    return realtime.subscribe(roomId, (f) => {
      if (f.type === 'history' && f.roomId === roomId) merge(f.messages);
      if (f.type === 'message' && f.roomId === roomId) merge([f.message]);
      if (f.type === 'error') setError(f.message);
    });
  }, [roomId]);

  const ordered = [...messages.values()].sort((a, b) => a.seq - b.seq);
  const roomHasOrder = ordered.some((m) => m.kind === 'system_order');
  // Same rules as the server: warn before sending rather than after the strike.
  const risky = detectOffPlatform(draft, { allowEmail: accountOrder }).length > 0;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [ordered.length]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setError('');
    try {
      realtime.send(roomId, body);
    } catch {
      // Socket down: fall back to REST so the message is still recorded.
      try {
        const m = await api<ChatMessage>(`/chat/rooms/${roomId}/messages`, { body: { body } });
        setMessages((prev) => new Map(prev).set(m.seq, m));
      } catch (err: any) {
        setError(err.message);
        return;
      }
    }
    setDraft('');
  };

  return (
    <div className="card chat">
      <div className="row spread" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{t('chat.title')}</h3>
        <span className="chip">{t('chat.recorded')}</span>
      </div>
      {roomHasOrder && <SafetyPanel />}
      <div className="chat-log" ref={logRef} role="log" aria-label={t('a11y.chatLog')}>
        {ordered.map((m) => {
          const mine = m.sender_id === meId;
          const cls = m.kind === 'text' ? (mine ? 'msg mine' : 'msg') : `msg ${m.kind}`;
          if (m.kind === 'system_order') return <OrderCard key={m.seq} message={m} />;
          return (
            <div key={m.seq} className={cls}>
              {m.body ?? <i className="muted">{t('chat.erased')}</i>}
              <span className="meta">
                #{m.seq} · {m.sender_id ? names[m.sender_id] ?? t('chat.user') : t('chat.system')} ·{' '}
                {new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {m.flags.length > 0 && ` · ${t('chat.flagged')}`}
              </span>
            </div>
          );
        })}
      </div>
      {error && <div className="alert" style={{ marginBottom: 8 }}>{error}</div>}
      {risky && (
        <div className="alert flex items-start gap-2" role="status" style={{ marginBottom: 8 }}>
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>{t('chat.offPlatform')}</span>
        </div>
      )}
      <form onSubmit={send}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('chat.placeholder')} aria-label={t('chat.message')} maxLength={4000} />
        <button className="btn" type="submit">{risky ? t('chat.sendAnyway') : t('chat.send')}</button>
      </form>
    </div>
  );
}


/**
 * The official order message: posted only by the server (kind `system_order`), rendered in a frame
 * user messages never get. Ink header with the mark and a tick, the order ref linked to the order,
 * item, character and a status chip; never a money amount.
 */
function OrderCard({ message }: { message: ChatMessage }) {
  let card: { order_id: string; ref: string; title: string; quantity: number; character_name: string | null; status: string } | null = null;
  try {
    card = JSON.parse(message.body ?? '');
  } catch {
    card = null;
  }
  if (!card) return null;
  const chip = ORDER_CHIP[card.status] ?? { label: card.status, cls: '' };
  return (
    <div className="order-card" data-testid="order-card" data-status={card.status}>
      <div className="order-card-head">
        <span className="brand-mark" aria-hidden />
        <span>Bullizard</span>
        <BadgeCheck className="size-4" aria-label={t('chat.official')} />
        <span className="meta">{new Date(message.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div className="order-card-body">
        <Link to={`/orders/${card.order_id}`} className="mono">{card.ref}</Link>
        <span>{card.title}{card.quantity > 1 ? ` ×${card.quantity}` : ''}</span>
        {card.character_name && <span className="small muted">→ <b className="mono">{card.character_name}</b></span>}
        <span className={`chip ${chip.cls}`}>{t(chip.label as MessageKey)}</span>
      </div>
    </div>
  );
}
const ORDER_CHIP: Record<string, { label: string; cls: string }> = {
  awaiting_payment: { label: 'ocard.awaiting', cls: '' },
  paid: { label: 'ocard.held', cls: 'held' },
  delivered: { label: 'ocard.delivered', cls: 'held' },
  completed: { label: 'ocard.released', cls: 'released' },
  disputed: { label: 'ocard.disputed', cls: 'disputed' },
  refunded: { label: 'ocard.refunded', cls: 'disputed' },
  cancelled: { label: 'ocard.cancelled', cls: '' },
  charged_back: { label: 'ocard.disputed', cls: 'disputed' },
};

/** "Stay safe": staff-managed text above every order chat, open by default, collapsible. */
function SafetyPanel() {
  const [text, setText] = useState<{ body: string; link_label: string; link_href: string } | null>(null);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('bz.safety.collapsed') !== '1';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    api<{ body: string; link_label: string; link_href: string }>('/texts/chat_safety').then(setText).catch(() => {});
  }, []);
  if (!text) return null;
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem('bz.safety.collapsed', o ? '1' : '0');
      } catch {
        /* storage blocked */
      }
      return !o;
    });
  };
  return (
    <div className="safety-panel" data-testid="safety-panel">
      <button type="button" className="safety-toggle" aria-expanded={open} onClick={toggle}>
        <ShieldCheck className="size-4" /> {t('chat.staySafe')} <span className="meta">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="safety-body">
          {text.body.split('\n').map((line, i) => <p key={i}>{line}</p>)}
          {text.link_href && <Link to={text.link_href}>{text.link_label || t('chat.rules')}</Link>}
        </div>
      )}
    </div>
  );
}
