import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Image as ImageIcon, ShieldCheck } from '@phosphor-icons/react';
import { api, money, realtime, type ChatMessage } from '../api';
import { detectOffPlatform } from '@/lib/safety';
import { blockedAction, blockedNoticeKeys, isBlockedError, type BlockedAction } from '@/lib/chatBlocked';
import { BrandMark } from './Brand';
import { currentLocale, t, type MessageKey } from '../i18n';

const time = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function BlockedNotice({ action }: { action: BlockedAction }) {
  const [first, second] = blockedNoticeKeys(action);
  return (
    <div className="msg mine blocked" role={action === 'ban' ? 'alert' : 'status'}>
      {second ? <><b>{t(first!)}</b> {t(second)}</> : t(first!)}
    </div>
  );
}

/** A server-originated event (paid, delivered, dispute opened…): one compact signed line. Users can only send `text`, so this can't be faked. */
/** The server's English text, or the same event in the reader's language when it carries a code. */
export function systemText(m: Pick<ChatMessage, 'body' | 'code' | 'params'>): string {
  if (!m.code) return m.body ?? '';
  const p = (m.params ?? {}) as Record<string, any>;
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p)) vars[k] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof p.amount_cents === 'number') vars.amount = money(p.amount_cents, String(p.currency ?? 'USD'));
  if (p.role === 'buyer' || p.role === 'seller') vars.role = t(p.role === 'buyer' ? 'chat.roleBuyer' : 'chat.roleSeller');
  if (typeof p.rate_pct === 'number') vars.rate = String(p.rate_pct);
  if (!vars.character) vars.character = t('chat.theBuyer');
  // Official order messages (copy deck §2.8) by code; older event keys as a fallback; the server's English last.
  const sysKey = `sys.${m.code}` as any;
  const sys = t(sysKey, vars);
  if (sys !== sysKey) return sys;
  const key = `chat.ev.${m.code}` as any;
  const text = t(key, vars);
  return text === key ? (m.body ?? '') : text;
}

function OfficialNote({ m }: { m: ChatMessage }) {
  return (
    <div className="chat-note" role="article" aria-label={t('chat.fromBullizard')}>
      <BrandMark className="chat-note-mark" />
      <div className="min-w-0 flex-1">
        <span className="chat-note-who">Bullizard <Check className="inline size-3" weight="bold" aria-label={t('chat.verified')} /></span>
        <span className="chat-note-text" dir="auto">{systemText(m)}</span>
      </div>
      <span className="chat-note-time">{time(m.created_at)}</span>
    </div>
  );
}

/**
 * Order chat. Messages are rendered strictly by server `seq`, never by client clocks.
 * Outside contact details are never sent: the attempt stays in place in the thread as "Not sent."
 */
export function Chat({ roomId, meId, names, accountOrder = false }: { roomId: string; meId: string; names: Record<string, string>; /** Account handovers may carry the account's email. */ accountOrder?: boolean }) {
  const [messages, setMessages] = useState<Map<number, ChatMessage>>(new Map());
  // Blocked attempts stay where they happened: each remembers the last message it followed.
  const [blocked, setBlocked] = useState<Array<{ key: number; after: number; action: BlockedAction }>>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const lastSeq = useRef(-1);

  const markBlocked = (action: BlockedAction = null) => setBlocked((b) => [...b, { key: Date.now() + b.length, after: lastSeq.current, action }]);

  useEffect(() => {
    setMessages(new Map());
    setBlocked([]);
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
      if (f.type === 'error') (isBlockedError(f) ? markBlocked(blockedAction(f)) : setError(f.message));
    });
  }, [roomId]);

  const all = [...messages.values()].sort((a, b) => a.seq - b.seq);
  lastSeq.current = all.at(-1)?.seq ?? -1;
  // One order card per order: the server posts a new one on every status change; only the latest is shown, at the top.
  const orderCard = all.filter((m) => m.kind === 'system_order').at(-1);
  // The server echoes each status change as a text next to the new card; the single card already says it.
  const cardSeqs = new Set(all.filter((m) => m.kind === 'system_order').map((m) => m.seq));
  const ordered = all.filter((m) => m.kind !== 'system_order' && !((m.kind === 'system' || m.kind === 'delivery') && (cardSeqs.has(m.seq - 1) || cardSeqs.has(m.seq + 1))));
  const roomHasOrder = !!orderCard;
  // A blocked attempt sits after the last shown message at or before the one it followed (hidden echoes don't count).
  const anchorOf = (after: number) => ordered.filter((m) => m.seq <= after).at(-1)?.seq ?? -1;
  // Same rules as the server: catch it before it leaves the browser.
  const risky = detectOffPlatform(draft, { allowEmail: accountOrder }).length > 0;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [ordered.length, blocked.length]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setError('');
    if (detectOffPlatform(body, { allowEmail: accountOrder }).length > 0) {
      markBlocked();
      setDraft('');
      return;
    }
    try {
      realtime.send(roomId, body);
    } catch {
      // Socket down: fall back to REST so the message is still recorded.
      try {
        const m = await api<ChatMessage>(`/chat/rooms/${roomId}/messages`, { body: { body } });
        setMessages((prev) => new Map(prev).set(m.seq, m));
      } catch (err: any) {
        if (isBlockedError(err)) markBlocked(blockedAction(err));
        else {
          setError(err.message);
          return;
        }
      }
    }
    setDraft('');
  };

  const line = (m: ChatMessage) => {
    if (m.kind === 'system') return <OfficialNote m={m} />;
    if (m.kind === 'delivery' || m.kind === 'warning')
      return (
        <div className={`chat-event ${m.kind === 'delivery' ? 'held' : 'disputed'}`}>
          <i aria-hidden /> <span dir="auto">{systemText(m)}</span> <span className="muted">· {time(m.created_at)}</span>
        </div>
      );
    const mine = m.sender_id === meId;
    return (
      <div className={mine ? 'msg mine' : 'msg'} dir="auto">
        {m.kind === 'attachment' && <ImageIcon className="me-1 inline size-4 align-text-bottom" aria-hidden />}
        {m.body ?? <i className="muted">{t('chat.erased')}</i>}
        <span className="meta">
          {mine ? '' : `${m.sender_id ? names[m.sender_id] ?? t('chat.user') : t('chat.system')} · `}
          {time(m.created_at)} · #{m.seq}
          {m.flags.length > 0 && ` · ${t('chat.flagged')}`}
        </span>
      </div>
    );
  };

  return (
    <div className="card chat chat2" style={{ ['--chat-h' as string]: '640px' }}>
      <div className="chat2-head">
        <h3 style={{ margin: 0 }}>{t('chat.title')}</h3>
      </div>
      <div className="chat-log" ref={logRef} role="log" aria-label={t('a11y.chatLog')}>
        {orderCard && <OrderCard message={orderCard} />}
        {roomHasOrder && <SafetyPanel />}
        {blocked.filter((b) => anchorOf(b.after) < 0).map((b) => <BlockedNotice key={b.key} action={b.action} />)}
        {ordered.map((m) => (
          <Fragment key={m.seq}>
            {line(m)}
            {blocked.filter((b) => anchorOf(b.after) === m.seq).map((b) => <BlockedNotice key={b.key} action={b.action} />)}
          </Fragment>
        ))}
      </div>
      {error && <div className="alert" style={{ marginBottom: 8 }}>{error}</div>}
      {risky && (
        <div className="alert small" role="status" style={{ marginBottom: 8 }}>
          {t('chat.offPlatform')}
        </div>
      )}
      <form onSubmit={send}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('chat.placeholder')} aria-label={t('chat.message')} maxLength={4000} />
        <button className="btn" type="submit">{t('chat.send')}</button>
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
    <div className="chat-official" role="article" aria-label={t('chat.fromBullizard')} data-testid="order-card" data-status={card.status}>
      <div className="chat-official-head">
        <BrandMark style={{ width: 20, height: 18 }} />
        <b>Bullizard</b>
        <Check className="size-4" weight="bold" aria-label={t('chat.official')} />
        <span className="chat-official-time">{time(message.created_at)}</span>
      </div>
      <div className="chat-official-body order-card-rows">
        <span><Link to={`/orders/${card.order_id}`} className="mono" dir="ltr">{card.ref}</Link></span>
        <span dir="auto">{card.title}{card.quantity > 1 ? ` ×${card.quantity}` : ''}</span>
        {card.character_name && <span className="small muted">→ <b className="mono" dir="ltr">{card.character_name}</b></span>}
        <span><span className={`chip ${chip.cls}`}>{t(chip.label as MessageKey)}</span></span>
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

/** "Stay safe": the staff-managed safety text as a signed Bullizard message at the top of every order chat; at most 15% of the chat, collapsible. */
function SafetyPanel() {
  const [text, setText] = useState<{ body: string; link_label: string; link_href: string; lang?: string } | null>(null);
  const lang = currentLocale();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('bz.safety.collapsed') !== '1';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    api<{ body: string; link_label: string; link_href: string; lang?: string }>(`/texts/chat_safety?lang=${lang}`).then(setText).catch(() => {});
  }, [lang]);
  if (!text) return null;
  // Staff write the text per language; until a translation exists the built-in one is shown.
  const body = lang === 'en' || text.lang === lang ? text.body : t('chat.safetyBody');
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
    <div className="chat-official chat-safety-msg" role="article" aria-label={t('chat.fromBullizard')} data-testid="safety-panel">
      <div className="chat-official-head">
        <BrandMark style={{ width: 20, height: 18 }} />
        <b>Bullizard</b>
        <Check className="size-4" weight="bold" aria-label={t('chat.official')} />
        <button type="button" className="chat-safety-toggle" aria-expanded={open} onClick={toggle}>
          <ShieldCheck className="size-4" aria-hidden /> {t('chat.staySafe')}{!open && <span className="chat-safety-read">{t('chat.readIt')}</span>} <span aria-hidden>{open ? '▾' : '▸'}</span>
        </button>
      </div>
      {open && (
        <div className="chat-official-body chat-safety-body">
          {body.split('\n').map((line, i) => <p key={i} dir="auto">{line}</p>)}
          {text.link_href && <Link to={text.link_href}>{text.lang === lang && text.link_label ? text.link_label : t('chat.rules')}</Link>}
        </div>
      )}
    </div>
  );
}
