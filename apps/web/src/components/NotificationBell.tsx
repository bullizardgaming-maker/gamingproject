import { t } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { api, realtime } from '../api';
import { cn } from '@/lib/utils';

interface Item {
  id: string;
  template: string;
  category: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

const CATEGORY_DOT: Record<string, string> = {
  orders: 'bg-held',
  selling: 'bg-released',
  disputes: 'bg-disputed',
  security: 'bg-disputed',
  account: 'bg-muted-foreground',
  reminders: 'bg-held',
  operations: 'bg-foreground',
};

function ago(iso: string) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** The bell in the top bar: unread count, the latest notifications, and live updates. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await api<{ items: Item[]; unread: number }>('/me/notifications?limit=20');
    setItems(r.items);
    setUnread(r.unread);
  }, []);

  useEffect(() => {
    load().catch(() => {});
    // New items arrive over the socket as they happen; poll gently as a fallback.
    const off = realtime.listen((f) => {
      if (f.type === 'notification' && f.event === 'inbox.new') {
        setItems((prev) => (prev ? [f.data, ...prev.filter((i) => i.id !== f.data.id)].slice(0, 20) : prev));
        setUnread((n) => n + 1);
      }
    });
    const poll = setInterval(() => load().catch(() => {}), 60_000);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const markRead = async (item: Item) => {
    if (item.read_at) return;
    setItems((prev) => prev?.map((i) => (i.id === item.id ? { ...i, read_at: new Date().toISOString() } : i)) ?? prev);
    const r = await api<{ unread: number }>(`/me/notifications/${item.id}/read`, { body: {} }).catch(() => null);
    if (r) setUnread(r.unread);
  };
  const markAll = async () => {
    await api('/me/notifications/read-all', { body: {} });
    setItems((prev) => prev?.map((i) => ({ ...i, read_at: i.read_at ?? new Date().toISOString() })) ?? prev);
    setUnread(0);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={unread ? t('notif.unread', { n: unread }) : t('notif.title')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative grid size-10 cursor-pointer place-items-center rounded-lg border border-border bg-transparent text-foreground transition-colors hover:border-foreground"
      >
        <Bell className="size-[18px]" strokeWidth={1.8} />
        <AnimatePresence>
          {unread > 0 && (
            <motion.span
              key="badge"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0 }}
              className="absolute -end-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-disputed px-1 font-mono text-[11px] font-semibold text-[color:var(--frost)]"
            >
              {unread > 99 ? '99+' : unread}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label={t('notif.title')}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="absolute end-0 top-12 z-50 w-[min(380px,calc(100vw-32px))] origin-top-right overflow-hidden rounded-xl border border-border bg-card shadow-[0_18px_50px_-12px_rgba(22,32,46,0.28)]"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="font-semibold">{t('notif.title')}</span>
              {unread > 0 && (
                <button type="button" onClick={markAll} className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent text-sm text-muted-foreground hover:text-foreground">
                  <CheckCheck className="size-4" /> {t('notif.markAll')}
                </button>
              )}
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {items === null ? (
                <p className="m-0 px-4 py-6 text-sm text-muted-foreground">{t('common.loading')}</p>
              ) : items.length === 0 ? (
                <p className="m-0 px-4 py-8 text-center text-sm text-muted-foreground">{t('notif.empty')}</p>
              ) : (
                items.map((i) => {
                  const body = (
                    <>
                      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', i.read_at ? 'bg-transparent' : CATEGORY_DOT[i.category] ?? 'bg-foreground')} />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-sm leading-snug', !i.read_at && 'font-semibold')}>{i.title}</span>
                        <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-muted-foreground">{i.body}</span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{ago(i.created_at)}</span>
                    </>
                  );
                  const cls = 'flex w-full gap-3 border-0 border-b border-border/60 bg-transparent px-4 py-3 text-start no-underline last:border-b-0 hover:bg-secondary/60';
                  return i.link ? (
                    <Link key={i.id} to={i.link} className={cls} onClick={() => (markRead(i), setOpen(false))}>{body}</Link>
                  ) : (
                    <button key={i.id} type="button" className={cn(cls, 'cursor-pointer')} onClick={() => markRead(i)}>{body}</button>
                  );
                })
              )}
            </div>
            <Link to="/account#notifications" onClick={() => setOpen(false)} className="block border-t border-border px-4 py-2.5 text-center text-sm text-muted-foreground no-underline hover:text-foreground">
              Notification settings
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
