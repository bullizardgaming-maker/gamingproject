import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Clock, Inbox, MessageSquarePlus, ShieldCheck, Star } from 'lucide-react';
import { api, money } from '../api';
import { useSession } from '../session';
import { GameArt } from '../components/CatalogUi';
import { attrLabel, attributePairs, attributesFor } from '@/lib/attributes';
import { CATEGORY_ORDER, categoryLabel, useGames } from '@/lib/catalog';
import { usePageMeta } from '@/lib/seo';
import { t, type MessageKey } from '../i18n';

export interface BuyerRequest {
  id: string;
  buyer_id: string;
  buyer_name: string;
  game: string;
  category_slug: string;
  title: string;
  description: string;
  budget_cents: number | null;
  currency: string;
  attributes: Record<string, string>;
  status: 'open' | 'accepted' | 'closed' | 'expired';
  expires_at: string;
  created_at: string;
  proposals: number;
  open?: boolean;
  mine?: boolean;
  proposal_list?: Proposal[];
}
export interface Proposal {
  id: string;
  request_id: string;
  seller_id: string;
  seller_name: string;
  seller_rating: number | string | null;
  seller_completed_orders: number;
  price_cents: number;
  delivery_hours: number;
  message: string;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  offer_id: string | null;
  updated_at: string;
  // On a seller's own list
  request_title?: string;
  game?: string;
  currency?: string;
  request_status?: string;
}

const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
const statusLabel = (s: string) => t(`req.status.${s}` as MessageKey);
const chipClass = (s: string) => (s === 'open' || s === 'pending' ? 'held' : s === 'accepted' ? 'released' : '');

function Tabs() {
  const { user } = useSession();
  return (
    <nav className="game-tabs" aria-label={t('req.title')}>
      <NavLink to="/requests" end>{t('req.tab.board')}</NavLink>
      {user && <NavLink to="/requests/mine">{t('req.tab.mine')}</NavLink>}
      {user && user.kyc_tier >= 2 && <NavLink to="/requests/proposals">{t('req.tab.proposals')}</NavLink>}
    </nav>
  );
}

function Header() {
  return (
    <div className="row" style={{ alignItems: 'end', justifyContent: 'space-between', gap: 16 }}>
      <div style={{ flex: '1 1 320px' }}>
        <div className="eyebrow">{t('req.eyebrow')}</div>
        <h1 style={{ fontSize: 40, margin: 0 }}>{t('req.title')}</h1>
        <p className="muted" style={{ margin: '6px 0 0' }}>{t('req.lede')}</p>
      </div>
      <Link className="btn" to="/requests/new"><MessageSquarePlus className="size-4" /> {t('req.post')}</Link>
    </div>
  );
}

function RequestRow({ r }: { r: BuyerRequest }) {
  const pairs = attributePairs(r.game, r.category_slug, r.attributes).map(([, v]) => v);
  return (
    <li className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3.5 last:border-b-0 sm:grid-cols-[auto_1fr_auto]">
      <GameArt game={r.game} size="sm" className="h-10 w-14 rounded-lg" />
      <div className="min-w-0">
        <Link to={`/requests/${r.id}`} className="block truncate font-medium no-underline hover:underline">{r.title}</Link>
        <div className="truncate text-xs text-muted-foreground">
          {[r.game, categoryLabel(r.category_slug), ...pairs].join(' · ')} · {t('req.by', { name: r.buyer_name })}
        </div>
      </div>
      <div className="col-start-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm sm:col-start-auto sm:justify-end">
        <span className="font-mono font-semibold">{r.budget_cents ? t('req.budgetIs', { price: money(r.budget_cents, r.currency) }) : <span className="muted font-sans font-normal">{t('req.noBudget')}</span>}</span>
        <span className="muted">{t('req.proposalCount', { count: r.proposals })}</span>
        {r.status === 'open' ? (
          <span className="muted inline-flex items-center gap-1"><Clock className="size-3.5" />{t('req.daysLeft', { count: daysLeft(r.expires_at) })}</span>
        ) : (
          <span className={`chip ${chipClass(r.status)}`}>{statusLabel(r.status)}</span>
        )}
      </div>
    </li>
  );
}

function List({ items, empty }: { items: BuyerRequest[] | null; empty: React.ReactNode }) {
  if (items === null) return <p className="muted">{t('common.loading')}</p>;
  if (items.length === 0) return <>{empty}</>;
  return <ul className="m-0 list-none overflow-hidden rounded-xl border border-border bg-card p-0">{items.map((r) => <RequestRow key={r.id} r={r} />)}</ul>;
}

/** /requests: open requests anyone can browse, filtered by game and category. */
export function RequestsBoard() {
  usePageMeta({ title: t('req.title'), description: t('req.lede') });
  const { games } = useGames();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<BuyerRequest[] | null>(null);
  const game = params.get('game') ?? '';
  const category = params.get('category') ?? '';
  useEffect(() => {
    let stale = false;
    setItems(null);
    const q = new URLSearchParams();
    if (game) q.set('game', game);
    if (category) q.set('category', category);
    api<BuyerRequest[]>(`/requests${q.size ? `?${q}` : ''}`).then((r) => !stale && setItems(r)).catch(() => !stale && setItems([]));
    return () => {
      stale = true;
    };
  }, [game, category]);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };
  return (
    <div className="stack" style={{ maxWidth: 1040 }}>
      <Header />
      <Tabs />
      <div className="toolbar" style={{ marginTop: 0 }}>
        <select aria-label={t('req.f.game')} value={game} onChange={(e) => set('game', e.target.value)} style={{ width: 220, height: 38, padding: '6px 10px' }}>
          <option value="">{t('req.anyGame')}</option>
          {games?.map((g) => <option key={g.game} value={g.game}>{g.game}</option>)}
        </select>
        <select aria-label={t('market.category')} value={category} onChange={(e) => set('category', e.target.value)} style={{ width: 190, height: 38, padding: '6px 10px' }}>
          <option value="">{t('req.anyCategory')}</option>
          {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
        </select>
      </div>
      <List
        items={items}
        empty={
          <div className="card stack" style={{ alignItems: 'start' }}>
            <Inbox className="size-6 text-muted-foreground" />
            <b>{t('req.empty')}</b>
            <p className="muted" style={{ margin: 0 }}>{t('req.empty.text')}</p>
            <Link className="btn" to={`/requests/new${game ? `?game=${encodeURIComponent(game)}${category ? `&category=${category}` : ''}` : ''}`}>{t('req.post')}</Link>
          </div>
        }
      />
      <p className="small muted" style={{ margin: 0 }}><ShieldCheck className="inline size-4 text-released" /> {t('req.escrowNote')}</p>
    </div>
  );
}

/** /requests/mine: the buyer's own requests, any status. */
export function MyRequests() {
  usePageMeta({ title: t('req.tab.mine'), noindex: true });
  const { user } = useSession();
  const [items, setItems] = useState<BuyerRequest[] | null>(null);
  useEffect(() => {
    if (user) api<BuyerRequest[]>('/requests/mine').then(setItems).catch(() => setItems([]));
  }, [user]);
  if (!user) return <p className="muted"><Link to="/login?next=/requests/mine">{t('req.signIn')}</Link></p>;
  return (
    <div className="stack" style={{ maxWidth: 1040 }}>
      <Header />
      <Tabs />
      <List items={items} empty={<p className="muted">{t('req.mine.empty')}</p>} />
    </div>
  );
}

/** /requests/proposals: what a seller has offered on other people's requests. */
export function MyProposals() {
  usePageMeta({ title: t('req.tab.proposals'), noindex: true });
  const { user } = useSession();
  const [items, setItems] = useState<Proposal[] | null>(null);
  useEffect(() => {
    if (user) api<Proposal[]>('/requests/proposals/mine').then(setItems).catch(() => setItems([]));
  }, [user]);
  if (!user) return <p className="muted"><Link to="/login?next=/requests/proposals">{t('req.signIn')}</Link></p>;
  return (
    <div className="stack" style={{ maxWidth: 1040 }}>
      <Header />
      <Tabs />
      {items === null ? (
        <p className="muted">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="muted">{t('req.proposals.empty')}</p>
      ) : (
        <ul className="m-0 list-none overflow-hidden rounded-xl border border-border bg-card p-0">
          {items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-3.5 last:border-b-0">
              <div className="min-w-0" style={{ flex: '1 1 260px' }}>
                <Link to={`/requests/${p.request_id}`} className="block truncate font-medium no-underline hover:underline">{p.request_title}</Link>
                <div className="truncate text-xs text-muted-foreground">{p.game}</div>
              </div>
              <span className="font-mono font-semibold">{money(p.price_cents, p.currency)}</span>
              <span className={`chip ${chipClass(p.status)}`}>{t(`req.pstatus.${p.status}` as MessageKey)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** /requests/new: describe what you want; game fields are optional ("any server"). */
export function RequestNew() {
  usePageMeta({ title: t('req.new.title'), noindex: true });
  const { user } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { games } = useGames();
  const [game, setGame] = useState(params.get('game') ?? '');
  const [category, setCategory] = useState(params.get('category') ?? 'accounts');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fields = game.trim() ? attributesFor(game.trim(), category) : [];

  if (!user) return <p className="muted"><Link to={`/login?next=${encodeURIComponent('/requests/new?' + params)}`}>{t('req.signIn')}</Link></p>;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError('');
    try {
      const r = await api<BuyerRequest>('/requests', {
        body: {
          game: game.trim(),
          categorySlug: category,
          title: f.title,
          description: f.description || undefined,
          budgetCents: f.budget ? Math.round(Number(f.budget) * 100) : undefined,
          attributes: Object.fromEntries(fields.map((d) => [d.key, f[`attr.${d.key}`] ?? '']).filter(([, v]) => v)),
        },
      });
      nav(`/requests/${r.id}`);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="stack" style={{ maxWidth: 760 }} onSubmit={submit}>
      <div>
        <div className="eyebrow">{t('req.eyebrow')}</div>
        <h1 style={{ fontSize: 40, margin: 0 }}>{t('req.new.title')}</h1>
        <p className="muted" style={{ margin: '6px 0 0' }}>{t('req.new.lede')}</p>
      </div>
      <div className="grid two">
        <label className="field">
          {t('market.category')}
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
          </select>
        </label>
        <label className="field">{t('req.f.game')}<input required maxLength={80} value={game} onChange={(e) => setGame(e.target.value)} list="req-games" /></label>
        <datalist id="req-games">{games?.map((g) => <option key={g.game} value={g.game} />)}</datalist>
      </div>
      <label className="field">{t('req.f.title')}<input name="title" required minLength={5} maxLength={140} placeholder={t('req.f.titleHint')} /></label>
      {fields.length > 0 && (
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
          <legend className="small muted" style={{ marginBottom: 8 }}>{t('req.f.details', { game: game.trim() })}</legend>
          <div className="grid three">
            {fields.map((d) => (
              <label key={`${category}-${game.trim().toLowerCase()}-${d.key}`} className="field">
                {attrLabel(d.label)}
                {d.type === 'select' ? (
                  <select name={`attr.${d.key}`} defaultValue="">
                    <option value="">{t('req.f.any')}</option>
                    {d.options!.map((o) => <option key={o}>{o}</option>)}
                  </select>
                ) : (
                  <input name={`attr.${d.key}`} maxLength={60} placeholder={t('req.f.any')} />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="field">{t('req.f.budget')}<input name="budget" type="number" step="0.01" min="0.5" placeholder={t('req.f.budgetHint')} /></label>
      <label className="field">{t('req.f.description')}<textarea name="description" maxLength={2000} rows={4} placeholder={t('req.f.descriptionHint')} /></label>
      <p className="small muted" style={{ margin: 0 }}>{t('req.new.note')}</p>
      {error && <div className="alert">{error}</div>}
      <div className="row">
        <button className="btn" disabled={busy}>{t('req.new.submit')}</button>
        <Link to="/requests" className="btn ghost">{t('common.cancel')}</Link>
      </div>
    </form>
  );
}

function ProposalForm({ r, mine, onSaved }: { r: BuyerRequest; mine?: Proposal; onSaved: (r: BuyerRequest) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError('');
    try {
      onSaved(await api<BuyerRequest>(`/requests/${r.id}/proposals`, { body: { priceCents: Math.round(Number(f.price) * 100), deliveryHours: Number(f.hours), message: f.message || undefined } }));
    } catch (err: any) {
      setError(err.message);
    }
    setBusy(false);
  };
  const live = mine && mine.status === 'pending';
  return (
    <form className="card stack" onSubmit={submit}>
      <h3 style={{ margin: 0 }}>{live ? t('req.p.update') : t('req.p.send')}</h3>
      <div className="grid two">
        <label className="field">{t('req.p.price', { currency: r.currency })}<input name="price" type="number" step="0.01" min="0.5" required defaultValue={live ? mine.price_cents / 100 : r.budget_cents ? r.budget_cents / 100 : undefined} /></label>
        <label className="field">{t('req.p.hours')}<input name="hours" type="number" min={1} max={168} required defaultValue={live ? mine.delivery_hours : 24} /></label>
      </div>
      <label className="field">{t('req.p.message')}<textarea name="message" maxLength={1000} rows={3} defaultValue={live ? mine.message : ''} placeholder={t('req.p.messageHint')} /></label>
      <p className="small muted" style={{ margin: 0 }}>{t('req.p.note')}</p>
      {error && <div className="alert">{error}</div>}
      <div className="row">
        <button className="btn" disabled={busy}>{live ? t('req.p.update') : t('req.p.send')}</button>
        {live && (
          <button type="button" className="btn ghost" disabled={busy} onClick={async () => onSaved(await api<BuyerRequest>(`/requests/${r.id}/proposals/mine`, { method: 'DELETE' }))}>
            {t('req.p.withdraw')}
          </button>
        )}
      </div>
    </form>
  );
}

function ProposalCard({ p, r, onAccept }: { p: Proposal; r: BuyerRequest; onAccept?: () => void }) {
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-border px-4 py-3.5 last:border-b-0">
      <div className="min-w-0" style={{ flex: '1 1 260px' }}>
        <Link to={`/sellers/${p.seller_id}`} className="font-medium">{p.seller_name}</Link>
        <div className="text-xs text-muted-foreground">
          {p.seller_rating != null && <><Star className="inline size-3" /> {Number(p.seller_rating).toFixed(1)} · </>}
          {t('req.p.sales', { count: p.seller_completed_orders })} · {t('req.p.within', { count: p.delivery_hours })}
        </div>
        {p.message && <p className="small" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{p.message}</p>}
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-lg font-semibold">{money(p.price_cents, r.currency)}</span>
        {onAccept ? <button className="btn" onClick={onAccept}>{t('req.p.accept')}</button> : <span className={`chip ${chipClass(p.status)}`}>{t(`req.pstatus.${p.status}` as MessageKey)}</span>}
      </div>
    </li>
  );
}

/** /requests/:id — the buyer compares and accepts proposals; sellers send or revise theirs. */
export function RequestPage() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const nav = useNavigate();
  const [r, setR] = useState<BuyerRequest | null>(null);
  const [error, setError] = useState('');
  usePageMeta({ title: r?.title ?? t('req.title'), description: r ? `${r.game} · ${categoryLabel(r.category_slug)}` : undefined });
  useEffect(() => {
    api<BuyerRequest>(`/requests/${id}`).then(setR).catch((e) => setError(e.message));
  }, [id, user?.id]);

  if (error && !r) return <div className="card"><p>{error}</p><Link to="/requests">{t('req.back')}</Link></div>;
  if (!r) return <p className="muted">{t('common.loading')}</p>;
  const pairs = attributePairs(r.game, r.category_slug, r.attributes);
  const list = r.proposal_list ?? [];
  const accepted = list.find((p) => p.status === 'accepted');
  const mineAsSeller = !r.mine ? list[0] : undefined;
  const accept = async (p: Proposal) => {
    if (!confirm(t('req.p.confirm', { seller: p.seller_name, price: money(p.price_cents, r.currency) }))) return;
    try {
      const res = await api<{ offerId: string; request: BuyerRequest }>(`/requests/${r.id}/proposals/${p.id}/accept`, { method: 'POST' });
      nav(`/offers/${res.offerId}`);
    } catch (err: any) {
      setError(err.message);
    }
  };
  const close = async () => {
    if (!confirm(t('req.closeConfirm'))) return;
    try {
      setR(await api<BuyerRequest>(`/requests/${r.id}/close`, { method: 'POST' }));
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <Link to="/requests" className="small">← {t('req.back')}</Link>
      <div className="card stack">
        <div className="row" style={{ gap: 14, alignItems: 'start' }}>
          <GameArt game={r.game} size="sm" className="h-14 w-20 shrink-0 rounded-lg" />
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <div className="small muted">{r.game} · {categoryLabel(r.category_slug)} · {t('req.by', { name: r.buyer_name })}</div>
            <h1 style={{ fontSize: 30, margin: '2px 0 0' }}>{r.title}</h1>
          </div>
          <span className={`chip ${chipClass(r.status)}`}>{r.status === 'open' ? t('req.daysLeft', { count: daysLeft(r.expires_at) }) : statusLabel(r.status)}</span>
        </div>
        {pairs.length > 0 && <div className="row" style={{ gap: 6 }}>{pairs.map(([k, v]) => <span key={k} className="chip">{k}: {v}</span>)}</div>}
        {r.description && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.description}</p>}
        <div className="row small" style={{ gap: 18 }}>
          <span><b>{t('req.budget')}</b> {r.budget_cents ? money(r.budget_cents, r.currency) : t('req.noBudget')}</span>
          <span><b>{t('req.proposalsLabel')}</b> {r.proposals}</span>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}

      {r.mine ? (
        <>
          {accepted?.offer_id && (
            <div className="notice row" style={{ justifyContent: 'space-between', gap: 12 }}>
              <span>{t('req.acceptedNote', { seller: accepted.seller_name })}</span>
              <Link className="btn" to={`/offers/${accepted.offer_id}`}>{t('req.checkout')}</Link>
            </div>
          )}
          <h2 style={{ margin: '8px 0 0' }}>{t('req.proposalsLabel')}</h2>
          {list.length === 0 ? (
            <p className="muted">{r.open ? t('req.waiting') : t('req.none')}</p>
          ) : (
            <ul className="m-0 list-none overflow-hidden rounded-xl border border-border bg-card p-0">
              {list.map((p) => <ProposalCard key={p.id} p={p} r={r} onAccept={r.open && p.status === 'pending' ? () => accept(p) : undefined} />)}
            </ul>
          )}
          {r.open && <div className="row"><button className="btn ghost" onClick={close}>{t('req.close')}</button></div>}
        </>
      ) : !user ? (
        <p className="muted"><Link to={`/login?next=/requests/${r.id}`}>{t('req.signInPropose')}</Link></p>
      ) : user.kyc_tier < 2 ? (
        <p className="muted">{t('req.sellersOnly')} <Link to="/sell">{t('req.becomeSeller')}</Link></p>
      ) : (
        <>
          {mineAsSeller && mineAsSeller.status !== 'withdrawn' && (
            <ul className="m-0 list-none overflow-hidden rounded-xl border border-border bg-card p-0"><ProposalCard p={mineAsSeller} r={r} /></ul>
          )}
          {r.open && <ProposalForm r={r} mine={mineAsSeller} onSaved={setR} />}
          {mineAsSeller?.status === 'pending' && <p className="small muted" style={{ margin: 0 }}>{t('req.p.sent')}</p>}
        </>
      )}
    </div>
  );
}
