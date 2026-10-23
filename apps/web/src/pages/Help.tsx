import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CaretRight as ChevronRight, Lifebuoy as LifeBuoy, MagnifyingGlass as Search } from '@phosphor-icons/react';
import { api, money } from '../api';
import { useSession } from '../session';
import { HELP_ARTICLES, HELP_TOPICS, TICKET_CATEGORY_LABEL, articleBySlug, searchHelp, type HelpArticle, type HelpTopic } from '@/lib/help';
import { usePageMeta } from '@/lib/seo';
import { cn } from '@/lib/utils';
import { currentLocale, t } from '../i18n';

function ArticleLink({ a }: { a: HelpArticle }) {
  return (
    <Link to={`/help/${a.slug}`} className="group flex items-center gap-3 border-b border-border px-4 py-3 no-underline last:border-b-0 hover:bg-secondary/50">
      <div className="min-w-0 flex-1">
        <div className="font-medium group-hover:underline">{a.title}</div>
        <div className="truncate text-sm text-muted-foreground">{a.summary}</div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
    </Link>
  );
}

function ContactCard({ category, orderId }: { category?: string; orderId?: string }) {
  const q = new URLSearchParams();
  if (category) q.set('category', category);
  if (orderId) q.set('order', orderId);
  return (
    <div className="card row" style={{ gap: 14 }}>
      <LifeBuoy className="size-7 shrink-0 text-released" />
      <div style={{ flex: '1 1 240px' }}>
        <b>{t('help.still')}</b>
        <div className="small muted">{t('help.still.text')}</div>
      </div>
      <Link className="btn" to={`/support/new${q.size ? `?${q}` : ''}`}>{t('help.contact')}</Link>
    </div>
  );
}

/** /help: search plus articles grouped by topic. */
export function HelpCentre() {
  usePageMeta({ title: t('help.eyebrow'), description: 'Answers about escrow, disputes, payments, selling and account security on Bullizard, and how to contact support.' });
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const results = useMemo(() => searchHelp(q), [q]);
  return (
    <div className="stack" style={{ maxWidth: 920, margin: '0 auto', width: '100%' }}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="eyebrow">{t('help.eyebrow')}</div>
        <h1 style={{ fontSize: 40, margin: 0 }}>{t('help.title')}</h1>
        <label className="relative block">
          <Search className="pointer-events-none absolute start-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            aria-label={t('help.searchLabel')}
            placeholder={t('help.search')}
            value={q}
            onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
            style={{ height: 52, paddingInlineStart: 46, fontSize: 16 }}
          />
        </label>
      </div>
      {q.trim() ? (
        results.length ? (
          <div className="overflow-hidden rounded-xl border border-border bg-card">{results.map((a) => <ArticleLink key={a.slug} a={a} />)}</div>
        ) : (
          <div className="card muted">{t('help.noMatch', { q })}</div>
        )
      ) : (
        <div className="grid gap-4 md:grid-cols-2 help-topics">
          {(Object.keys(HELP_TOPICS) as HelpTopic[]).map((t) => (
            <section key={t} className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <h2 style={{ fontSize: 18, margin: 0 }}>{HELP_TOPICS[t].title}</h2>
                <div className="small muted">{HELP_TOPICS[t].blurb}</div>
              </div>
              {HELP_ARTICLES.filter((a) => a.topic === t).map((a) => <ArticleLink key={a.slug} a={a} />)}
            </section>
          ))}
        </div>
      )}
      <ContactCard />
      <p className="small muted">
        {t('help.outage', { status: '\u0000', requests: '\u0001' }).split(/[\u0000\u0001]/)[0]}
        <Link to="/status">{t('help.statusLink')}</Link>
        {t('help.outage', { status: '\u0000', requests: '\u0001' }).split(/[\u0000\u0001]/)[1]}
        <Link to="/support">{t('help.requestsLink')}</Link>
        {t('help.outage', { status: '\u0000', requests: '\u0001' }).split(/[\u0000\u0001]/)[2]}
      </p>
    </div>
  );
}

/** /help/:slug */
export function HelpArticlePage() {
  const { slug = '' } = useParams();
  const a = articleBySlug(slug);
  usePageMeta({ title: a?.title ?? 'Help', description: a?.summary });
  if (!a) return <div className="card stack"><h2>{t('help.notFound')}</h2><Link to="/help">{t('help.back')}</Link></div>;
  const related = HELP_ARTICLES.filter((x) => x.topic === a.topic && x.slug !== a.slug);
  return (
    <div className="stack" style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/help">{t('help.eyebrow')}</Link><span>/</span><span>{HELP_TOPICS[a.topic].title}</span></nav>
      <article className="help-article">
        <h1>{a.title}</h1>
        <p className="lede">{a.summary}</p>
        {a.body.map((p, i) =>
          p.startsWith('- ') ? (
            <ul key={i}>{p.split('\n').map((li, k) => <li key={k}>{li.replace(/^- /, '')}</li>)}</ul>
          ) : (
            <p key={i}>{p}</p>
          ),
        )}
      </article>
      <ContactCard category={a.ticket} />
      {related.length > 0 && (
        <section>
          <h2 style={{ fontSize: 18 }}>{t('help.more', { topic: HELP_TOPICS[a.topic].title })}</h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card">{related.map((x) => <ArticleLink key={x.slug} a={x} />)}</div>
        </section>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------------------------
// Support requests
// --------------------------------------------------------------------------------------------
export interface Ticket {
  id: string;
  number: number;
  category: string;
  subject: string;
  status: 'open' | 'pending' | 'resolved';
  priority: 'normal' | 'high';
  order_id: string | null;
  created_at: string;
  updated_at: string;
  last_from_staff?: boolean;
  user_name?: string;
  user_email?: string;
  assigned_to?: string | null;
  assignee_name?: string | null;
  messages?: Array<{ id: string; staff: boolean; internal?: boolean; body: string; created_at: string; author_name: string }>;
  order?: { id: string; status: string; amount_cents: number; currency: string; offer_title: string; game: string; buyer_name: string; seller_name: string } | null;
}

export const TICKET_STATUS: Record<Ticket['status'], { label: string; chip: string }> = {
  open: { get label() { return t('sup.status.open'); }, chip: 'held' },
  pending: { get label() { return t('sup.status.pending'); }, chip: 'disputed' },
  resolved: { get label() { return t('sup.status.resolved'); }, chip: 'released' },
};
export const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** /support: the customer's requests. */
export function SupportList() {
  usePageMeta({ title: t('sup.mine'), noindex: true });
  const { user } = useSession();
  const [list, setList] = useState<Ticket[] | null>(null);
  useEffect(() => {
    if (user) api<Ticket[]>('/support/tickets').then(setList).catch(() => setList([]));
  }, [user]);
  if (!user) return <p className="muted"><Link to="/login?next=/support">{t('sup.signInList')}</Link></p>;
  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <div className="row spread">
        <div>
          <div className="eyebrow">{t('sup.eyebrow')}</div>
          <h1 style={{ fontSize: 40, margin: 0 }}>{t('sup.mine')}</h1>
        </div>
        <Link className="btn" to="/support/new">{t('sup.new')}</Link>
      </div>
      {list === null ? (
        <p className="muted">Loading…</p>
      ) : list.length === 0 ? (
        <div className="card muted"><Link to="/help">{t('sup.none')}</Link></div>
      ) : (
        <ul className="m-0 list-none overflow-hidden rounded-xl border border-border bg-card p-0">
          {list.map((t) => (
            <li key={t.id} className="border-b border-border last:border-b-0">
              <Link to={`/support/${t.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 no-underline hover:bg-secondary/50">
                <span className="font-mono text-xs text-muted-foreground">#{t.number}</span>
                <span className="min-w-0 flex-1 font-medium">{t.subject}</span>
                <span className={cn('chip', TICKET_STATUS[t.status].chip)}>{TICKET_STATUS[t.status].label}</span>
                <span className="text-xs text-muted-foreground">{when(t.updated_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** /support/new?category=…&order=… */
export function SupportNew() {
  usePageMeta({ title: t('sup.contact'), noindex: true });
  const { user } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [orders, setOrders] = useState<Array<{ id: string; offer_title: string; created_at: string; amount_cents: number; currency: string }>>([]);
  const [category, setCategory] = useState(params.get('category') ?? (params.get('order') ? 'order' : ''));
  const [orderId, setOrderId] = useState(params.get('order') ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user) return;
    Promise.all([api<any[]>('/orders').catch(() => []), api<any[]>('/orders?as=seller').catch(() => [])]).then(([a, b]) => {
      const seen = new Set<string>();
      setOrders([...a, ...b].filter((o) => !seen.has(o.id) && seen.add(o.id)).sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 50));
    });
  }, [user]);
  const suggestions = useMemo(() => HELP_ARTICLES.filter((a) => a.ticket === category).slice(0, 3), [category]);

  if (!user) return <p className="muted"><Link to={`/login?next=${encodeURIComponent('/support/new?' + params)}`}>{t('sup.signInNew')}</Link></p>;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError('');
    try {
      const t = await api<Ticket>('/support/tickets', { body: { category, subject: f.subject, body: f.body, orderId: orderId || undefined } });
      nav(`/support/${t.id}`);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="stack" style={{ maxWidth: 720 }} onSubmit={submit}>
      <div>
        <div className="eyebrow">{t('sup.eyebrow')}</div>
        <h1 style={{ fontSize: 40, margin: 0 }}>{t('sup.contact')}</h1>
      </div>
      <label className="field">
        {t('sup.topic')}
        <select required value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="" disabled>{t('sup.chooseTopic')}</option>
          {Object.entries(TICKET_CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {suggestions.length > 0 && (
        <div className="notice small">
          {t('sup.mayAnswer')} {suggestions.map((a, i) => <span key={a.slug}>{i ? ' · ' : ''}<Link to={`/help/${a.slug}`}>{a.title}</Link></span>)}
        </div>
      )}
      <label className="field">
        {t('sup.order')}
        <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
          <option value="">{t('sup.noOrder')}</option>
          {orders.map((o) => <option key={o.id} value={o.id}>{o.offer_title} · {money(o.amount_cents, o.currency)} · {new Date(o.created_at).toLocaleDateString()}</option>)}
          {orderId && !orders.some((o) => o.id === orderId) && <option value={orderId}>{t('sup.orderShort', { id: orderId.slice(0, 8) })}</option>}
        </select>
      </label>
      <label className="field">{t('sup.subject')}<input name="subject" required minLength={3} maxLength={140} placeholder={t('sup.subjectHint')} /></label>
      <label className="field">
        {t('sup.details')}
        <textarea name="body" required minLength={2} maxLength={5000} rows={6} placeholder={t('sup.detailsHint')} />
      </label>
      <p className="small muted" style={{ margin: 0 }}>{t('sup.privacy')}</p>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="row">
        <button className="btn" disabled={busy}>{t('sup.send')}</button>
        <Link to="/help" className="btn ghost">{t('sup.backHelp')}</Link>
      </div>
    </form>
  );
}

/** /support/:id: the thread with support. */
export function SupportTicket() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const [tk, setT] = useState<Ticket | null>(null);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  usePageMeta({ title: tk ? t('sup.request', { number: tk.number }) : t('sup.eyebrow'), noindex: true });
  useEffect(() => {
    if (user) api<Ticket>(`/support/tickets/${id}`).then(setT).catch((e) => setError(e.message));
  }, [user, id]);
  if (!user) return <p className="muted"><Link to={`/login?next=/support/${id}`}>{t('sup.signInTicket')}</Link></p>;
  if (!tk) return <p className="muted">{error || t('common.loading')}</p>;
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setT(await api<Ticket>(`/support/tickets/${id}/messages`, { body: { body: reply } }));
      setReply('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const resolve = async () => setT(await api<Ticket>(`/support/tickets/${id}/resolve`, { body: {} }));
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/support">My requests</Link><span>/</span><span>#{tk.number}</span></nav>
      <div className="row spread" style={{ alignItems: 'start' }}>
        <div>
          <h1 style={{ fontSize: 32, margin: 0 }}>{tk.subject}</h1>
          <div className="small muted">{t('sup.opened', { category: TICKET_CATEGORY_LABEL[tk.category] ?? tk.category, date: when(tk.created_at) })}</div>
        </div>
        <span className={cn('chip', TICKET_STATUS[tk.status].chip)}>{TICKET_STATUS[tk.status].label}</span>
      </div>
      {tk.order && (
        <Link to={`/orders/${tk.order.id}`} className="card row no-underline hover:border-foreground" style={{ padding: 14 }}>
          <span className="eyebrow" style={{ margin: 0 }}>{t('sup.orderLabel')}</span>
          <span style={{ flex: 1 }}>{tk.order.offer_title}</span>
          <span className="mono small">{money(tk.order.amount_cents, tk.order.currency)} · {tk.order.status}</span>
        </Link>
      )}
      <ol className="m-0 grid list-none gap-3 p-0">
        {tk.messages!.map((m) => (
          <li key={m.id} className={cn('rounded-xl border p-4', m.staff ? 'border-released/30 bg-released/5' : 'border-border bg-card')}>
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <b>{m.staff ? m.author_name : t('sup.you')}</b>
              <span className="text-xs text-muted-foreground">{when(m.created_at)}</span>
            </div>
            <p className="m-0" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p>
          </li>
        ))}
      </ol>
      <form className="card stack" onSubmit={send}>
        <label className="field">
          {tk.status === 'resolved' ? t('sup.replyReopen') : t('sup.reply')}
          <textarea required minLength={2} maxLength={5000} rows={4} value={reply} onChange={(e) => setReply(e.target.value)} />
        </label>
        {error && <div className="alert" role="alert">{error}</div>}
        <div className="row">
          <button className="btn" disabled={busy || reply.trim().length < 2}>{t('sup.sendReply')}</button>
          {tk.status !== 'resolved' && <button type="button" className="btn ghost" onClick={resolve}>{t('sup.solved')}</button>}
        </div>
      </form>
    </div>
  );
}
