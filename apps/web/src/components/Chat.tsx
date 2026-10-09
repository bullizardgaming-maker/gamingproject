import { useEffect, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api, realtime, type ChatMessage } from '../api';
import { detectOffPlatform } from '@/lib/safety';
import { t } from '../i18n';

/** Order chat. Messages are rendered strictly by server `seq`, never by client clocks. */
export function Chat({ roomId, meId, names }: { roomId: string; meId: string; names: Record<string, string> }) {
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
  // Same rules as the server: warn before sending rather than after the strike.
  const risky = detectOffPlatform(draft).length > 0;

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
      <div className="chat-log" ref={logRef} aria-live="polite">
        {ordered.map((m) => {
          const mine = m.sender_id === meId;
          const cls = m.kind === 'text' ? (mine ? 'msg mine' : 'msg') : `msg ${m.kind}`;
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
