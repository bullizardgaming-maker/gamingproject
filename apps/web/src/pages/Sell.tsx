import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, money } from '../api';
import { FeeLadder, pct } from '../components/FeeLadder';
import { RulesTest } from '../components/RulesTest';
import { useSession } from '../session';
import { SellerMoney } from './SellerMoney';
import { SellerAnalytics } from './SellerAnalytics';
import { usePageMeta } from '@/lib/seo';
import { intlLocale, t, type MessageKey } from '../i18n';
import { attrLabel, attributesFor, useLeagues } from '@/lib/attributes';
import { categoryLabel, isCategoryOpen, useCategoryOrder, useGames } from '@/lib/catalog';
import { replyLabel } from '@/lib/presence';
import { TrustBadge } from '../components/CatalogUi';
import { StorefrontEditor } from '../components/StorefrontEditor';
import { BulkListings } from '../components/BulkListings';
import { LinkedAccounts, platformName, type LinkedAccount } from '../components/LinkedAccounts';
import { platformForGame } from '../../../api/src/domain/platforms';

interface Dashboard {
  tier: { name: string; accountRateBps: number; otherRateBps: number };
  rank: { name: string; rateBps: number; minMonthlySalesCents: number };
  /** The rate on new orders: the rank rate, or the launch promo while it runs. */
  rateBps: number;
  promo: { rateBps: number; endsAt: string } | null;
  monthlySalesCents: number;
  next: { tier: { name: string; minMonthlySalesCents: number }; remainingCents: number } | null;
  payoutCurrency?: string;
  onboarding?: { tier1: boolean; rulesPassedAt: string | null; identityVerified: boolean; idDueAt: string | null; idDueDays: number; sellingRestrictedAt: string | null; canSell: boolean };
  founding?: Founding;
  balances: { availableCents: number; pendingEscrowCents: number; withdrawableCents?: number; onHoldCents?: number; currency?: string };
  withdrawalsFrozen: boolean;
  shop?: { showOnline?: boolean; responseMinutes?: number | null };
  stats: { completed: number; in_progress: number; disputed: number; charged_back: number };
}

interface Founding {
  founding: boolean;
  foundingUntil: string;
  windowOpen: boolean;
  featuredSlots: number;
  featuredUsed: number;
  featuredDays: number;
}

interface SellerOffer {
  id: string;
  title: string;
  game: string;
  category_slug: string;
  /** What buyers pay (the seller's price with commission grossed up). */
  price_cents: number;
  /** What the seller entered and receives. */
  seller_price_cents: number;
  delivery_mode: 'auto' | 'manual';
  available: number;
  status: string;
  owner_proof_status: string;
  version: number;
  attributes?: Record<string, string>;
  expired_reason?: string | null;
  featured?: boolean;
  featured_until?: string | null;
  sale_price_cents?: number | null;
  sale_starts_at?: string | null;
  sale_ends_at?: string | null;
  reserved_for?: string | null;
  is_bundle?: boolean;
  linked_account_id?: string | null;
}

const TIER_ROWS = [0, 1, 2];

interface TrustInfo {
  level: 'new' | 'rising' | 'trusted' | 'top';
  metrics: { completed: number; ageDays: number; onTimePct: number | null; disputePct: number | null; chargebackPct: number | null };
  next: { level: string; requirements: { completed: number; ageDays: number; onTimePct: number; disputePct: number; chargebackPct: number }; met: Record<string, boolean> } | null;
}

/** The seller's trust level and a checklist for the next one. */
function TrustCard() {
  const [info, setInfo] = useState<TrustInfo | null>(null);
  useEffect(() => void api<TrustInfo>('/seller/trust').then(setInfo).catch(() => {}), []);
  if (!info) return null;
  const m = info.metrics;
  const rows = info.next
    ? ([
        ['completed', t('trust.req.completed', { n: info.next.requirements.completed }), `${m.completed}`],
        ['ageDays', t('trust.req.age', { n: info.next.requirements.ageDays }), `${m.ageDays}`],
        ['onTimePct', t('trust.req.onTime', { n: info.next.requirements.onTimePct }), m.onTimePct == null ? '—' : `${m.onTimePct}%`],
        ['disputePct', t('trust.req.disputes', { n: info.next.requirements.disputePct }), m.disputePct == null ? '—' : `${m.disputePct}%`],
        ['chargebackPct', t('trust.req.chargebacks', { n: info.next.requirements.chargebackPct }), m.chargebackPct == null ? '—' : `${m.chargebackPct}%`],
      ] as const)
    : [];
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row spread">
        <div>
          <div className="eyebrow">{t('trust.yourLevel')}</div>
          <h3 style={{ margin: 0 }}>{info.level === 'new' ? t('trust.new') : t(`trust.${info.level}` as MessageKey)}</h3>
        </div>
        <TrustBadge level={info.level} />
      </div>
      {info.next ? (
        <>
          <div className="small muted">{t('trust.nextIs', { level: t(`trust.${info.next.level}` as MessageKey) })}</div>
          <ul className="m-0 list-none p-0 small">
            {rows.map(([k, label, value]) => (
              <li key={k} className="flex items-center justify-between gap-3 border-b border-border py-1.5 last:border-b-0">
                <span>{info.next!.met[k] ? '✓' : '○'} {label}</span>
                <span className="font-mono muted">{value}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="small muted">{t('trust.atTop')}</div>
      )}
      <div className="small muted">{t('trust.footnote')}</div>
    </div>
  );
}

/** "Online now" opt-out and the seller's own reply time, as buyers see it. */
function PresenceSettings({ shop }: { shop?: Dashboard['shop'] }) {
  const [show, setShow] = useState(shop?.showOnline ?? true);
  const [saved, setSaved] = useState(false);
  const reply = replyLabel(shop?.responseMinutes);
  return (
    <div className="card row" style={{ gap: 16, padding: '12px 16px' }}>
      <label className="row small" style={{ flex: '1 1 280px', gap: 8 }} title={t('presence.showOnlineHint')}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={show}
          onChange={async (e) => {
            const next = e.target.checked;
            setShow(next);
            setSaved(false);
            await api('/seller/presence', { method: 'PUT', body: { showOnline: next } }).then(() => setSaved(true), () => setShow(!next));
          }}
        />
        {t('presence.showOnline')}
        {saved && <span className="text-released" role="status">{t('presence.saved')}</span>}
      </label>
      <span className="small muted">{reply ? t('presence.yourReply', { time: reply }) : t('presence.noReplyYet')}</span>
    </div>
  );
}

export function Sell() {
  usePageMeta({ title: 'Sell on Bullizard', description: 'Open a shop: you set your price and receive it in full, commission falls as your rank grows, instant delivery for codes, Chargeback Shield and crypto payouts.' });
  const { user, refresh } = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const moneyTab = pathname.startsWith('/sell/money');
  const analyticsTab = pathname.startsWith('/sell/analytics');
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [offers, setOffers] = useState<SellerOffer[]>([]);
  const [linked, setLinked] = useState<LinkedAccount[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [d, o, l] = await Promise.all([api<Dashboard>('/seller/dashboard'), api<SellerOffer[]>('/seller/offers'), api<LinkedAccount[]>('/seller/linked-accounts').catch(() => [])]);
    setDash(d);
    setOffers(o);
    setLinked(l);
  }, []);

  useEffect(() => {
    if (user) load().catch(() => {});
  }, [user, load]);

  // Returning from the payment partner's onboarding page: sync payout status.
  useEffect(() => {
    if (user && !user.payouts_enabled && new URLSearchParams(window.location.search).get('payouts')) {
      api<{ payoutsEnabled: boolean }>('/seller/payout-account').then((s) => { if (s.payoutsEnabled) refresh(); }).catch(() => {});
    }
  }, [user, refresh]);

  if (!user) return <p className="muted"><Link to="/login?next=/sell">{t('sell.signIn')}</Link></p>;
  // Onboarding: Tier 1 (email + phone), then the rules test, then the hub; identity within 30 days.
  if (user.kyc_tier < 1) {
    return (
      <div className="stack" style={{ maxWidth: 720 }}>
        <h1 style={{ fontSize: 40 }}>{t('sell.kyc.title')}</h1>
        <p className="lede">{t('sell.tier1.lede')}</p>
        <Link className="btn" to="/account">{t('sell.tier1.verify')}</Link>
        <div className="card"><FeeLadder /></div>
      </div>
    );
  }
  if (!user.rules_passed_at) {
    return (
      <div className="stack" style={{ maxWidth: 820 }}>
        <h1 style={{ fontSize: 40 }}>{t('sell.kyc.title')}</h1>
        <p className="lede">{t('rules.gate')}</p>
        <RulesTest onPassed={() => refresh()} />
        <div className="card"><FeeLadder /></div>
      </div>
    );
  }
  const tabs = (
    <nav className="filters" aria-label={t('sell.sections')}>
      <NavLink end to="/sell">{t('sell.tab.shop')}</NavLink>
      <NavLink to="/sell/analytics">{t('sell.tab.analytics')}</NavLink>
      <NavLink to="/sell/money">{t('sell.tab.money')}</NavLink>
    </nav>
  );
  if (moneyTab || analyticsTab) {
    return (
      <div className="stack">
        <h1 style={{ fontSize: 40 }}>{t('sell.title')}</h1>
        {tabs}
        {moneyTab ? <SellerMoney /> : <SellerAnalytics />}
      </div>
    );
  }
  if (!dash) return <p className="muted">{t('sell.loading')}</p>;
  const cur = dash.payoutCurrency ?? 'USD';
  const withdrawable = dash.balances.withdrawableCents ?? dash.balances.availableCents;

  const progress = dash.next ? dash.monthlySalesCents / dash.next.tier.minMonthlySalesCents : 1;

  // Payouts go to a crypto address the seller sets on the Money tab.
  const setUpPayouts = () => navigate('/sell/money#payout-address');

  const withdraw = async () => {
    try {
      await api('/seller/withdrawals', { body: { amountCents: withdrawable, currency: cur } });
      setMsg({ kind: 'ok', text: t('sell.withdrawSent', { amount: money(withdrawable, cur) }) });
      load();
    } catch (e: any) {
      setMsg({ kind: 'alert', text: e.message });
    }
  };

  return (
    <div className="stack">
      <h1 style={{ fontSize: 40 }}>{t('sell.title')}</h1>
      {tabs}
      {dash.onboarding && !dash.onboarding.identityVerified && (
        <div className={dash.onboarding.sellingRestrictedAt ? 'alert' : 'notice'} role={dash.onboarding.sellingRestrictedAt ? 'alert' : 'status'} data-testid="id-deadline">
          <b>{dash.onboarding.sellingRestrictedAt ? t('onb.restricted') : t('onb.due', { date: dash.onboarding.idDueAt ? new Date(dash.onboarding.idDueAt).toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' }) : '' })}</b>{' '}
          {t('onb.why')} <Link to="/account">{t('sell.kyc.verify')}</Link>
        </div>
      )}
      {dash.founding?.founding && (
        <div className="notice" role="status" data-testid="founding-card">
          <b>{t('founding.badge')}</b> · {dash.founding.windowOpen ? t('founding.spots', { used: dash.founding.featuredUsed, slots: dash.founding.featuredSlots, days: dash.founding.featuredDays, until: new Date(dash.founding.foundingUntil).toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' }) }) : t('founding.spotsOver')}
        </div>
      )}
      <PresenceSettings shop={dash.shop} />
      <TrustCard />
      {user && <StorefrontEditor sellerId={user.id} />}
      <div className="grid three">
        <div className="card stack">
          <div className="eyebrow">{t('ranks.yourRank')}</div>
          <h2 style={{ margin: 0 }}>{dash.rank?.name ?? dash.tier.name}</h2>
          <p className="small muted" data-testid="seller-rate">
            {dash.promo
              ? t('ranks.promoRate', { rate: pct(dash.rateBps), until: new Date(dash.promo.endsAt).toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' }), rankRate: pct(dash.rank?.rateBps ?? dash.tier.otherRateBps) })
              : t('ranks.rate', { rate: pct(dash.rateBps) })}
          </p>
          <div className="progress" role="progressbar" aria-label={t('sell.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, progress * 100))}><div style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>
          <p className="small muted">
            {dash.next ? t('sell.nextLevel', { amount: money(dash.next.remainingCents), level: dash.next.tier.name }) : t('sell.topLevel')}
          </p>
        </div>
        <div className="card stack">
          <div className="eyebrow">{t('sell.balance')}</div>
          <h2 className="mono" style={{ margin: 0 }}>{money(withdrawable, cur)}</h2>
          <p className="small muted">
            {t('sell.ready')}{dash.balances.onHoldCents ? ` ${t('sell.onHold', { amount: money(dash.balances.onHoldCents, cur) })}` : ''} {t('sell.inEscrow', { amount: money(dash.balances.pendingEscrowCents) })}{' '}
            <Link to="/sell/money">{t('sell.details')}</Link>
          </p>
          {user.payouts_enabled ? (
            <button className="btn" disabled={dash.withdrawalsFrozen || withdrawable <= 0} onClick={withdraw}>{t('sell.withdrawAll')}</button>
          ) : (
            <>
              <button className="btn" onClick={setUpPayouts}>{t('sell.setUpPayouts')}</button>
              <p className="small muted">{t('sell.setUpPayouts.text')}</p>
            </>
          )}
          {dash.withdrawalsFrozen && <p className="small muted">{t('sell.frozen')}</p>}
        </div>
        <div className="card stack">
          <div className="eyebrow">{t('nav.orders')}</div>
          <p className="mono">{t('sell.ordersLine1', { completed: dash.stats.completed, open: dash.stats.in_progress })}</p>
          <p className="mono">{t('sell.ordersLine2', { disputed: dash.stats.disputed, chargedBack: dash.stats.charged_back })}</p>
          <Link to="/orders?as=seller">{t('sell.manageOrders')}</Link>
        </div>
      </div>
      {msg && <div className={msg.kind}>{msg.text}</div>}

      <div className="card">
        <h3>{t('sell.listings')}</h3>
        {offers.length === 0 ? (
          <p className="muted">{t('sell.noListings')}</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('sell.col.listing')}</th><th>{t('table.price')}</th><th>{t('table.stock')}</th><th>{t('table.delivery')}</th><th /></tr></thead>
              <tbody>
                {offers.map((o) => <OfferRow key={o.id} offer={o} linked={linked} onChange={load} founding={dash.founding} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <LinkedAccounts accounts={linked} onChange={load} />
      <DiscountCodes />
      <NewOffer onCreated={load} offers={offers} linked={linked} />
      <BulkListings onApplied={load} />
      <div className="card"><FeeLadder current={dash.rank?.name ?? dash.tier.name} /></div>
    </div>
  );
}

/** A timed sale on one listing: a lower price until a date (seller-funded). */
function SaleForm({ offer, onDone }: { offer: SellerOffer; onDone: () => void }) {
  const [error, setError] = useState('');
  const running = offer.sale_price_cents != null;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api(`/offers/${offer.id}/sale`, { method: 'PUT', body: { salePriceCents: Math.round(Number(f.price) * 100), endsAt: new Date(`${f.ends}T23:59:00`).toISOString() } });
      onDone();
    } catch (err: any) {
      setError(err.message);
    }
  };
  const defaultEnd = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  return (
    <form className="row" onSubmit={submit} style={{ alignItems: 'end' }}>
      <label className="field">{t('sale.price')}<input name="price" type="number" step="0.01" min="0.01" max={(offer.price_cents - 1) / 100} required defaultValue={offer.sale_price_cents ? offer.sale_price_cents / 100 : undefined} /></label>
      <label className="field">{t('sale.ends')}<input name="ends" type="date" required defaultValue={offer.sale_ends_at?.slice(0, 10) ?? defaultEnd} /></label>
      <button className="btn">{running ? t('sale.update') : t('sale.start')}</button>
      {running && <button type="button" className="btn ghost" onClick={async () => (await api(`/offers/${offer.id}/sale`, { method: 'DELETE' }), onDone())}>{t('sale.endNow')}</button>}
      <span className="small muted" style={{ flex: '1 1 220px' }}>{t('sale.hint')}</span>
      {error && <div className="alert" style={{ width: '100%' }}>{error}</div>}
    </form>
  );
}

interface SellerCode { id: string; code: string; percent_off: number; min_order_cents: number; max_uses: number | null; ends_at: string | null; active: boolean; uses: number }

/** Discount codes for the seller's shop (seller-funded, % off). */
function DiscountCodes() {
  const [codes, setCodes] = useState<SellerCode[] | null>(null);
  const [error, setError] = useState('');
  const load = () => void api<SellerCode[]>('/seller/codes').then(setCodes).catch(() => setCodes([]));
  useEffect(load, []);
  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api('/seller/codes', {
        body: {
          code: f.code, percentOff: Number(f.percent),
          minOrderCents: f.min ? Math.round(Number(f.min) * 100) : undefined, maxUses: f.max ? Number(f.max) : undefined,
          endsAt: f.ends ? new Date(`${f.ends}T23:59:00`).toISOString() : undefined,
        },
      });
      form.reset();
      setError('');
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };
  return (
    <div className="card stack">
      <div>
        <h3 style={{ margin: 0 }}>{t('code.title')}</h3>
        <p className="small muted" style={{ margin: '4px 0 0' }}>{t('code.lede')}</p>
      </div>
      {codes && codes.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{t('code.code')}</th><th>{t('code.off')}</th><th>{t('code.uses')}</th><th>{t('code.endsCol')}</th><th /></tr></thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.code}</td>
                  <td>{c.percent_off}%{Number(c.min_order_cents) ? ` · ${t('code.minShort', { price: money(Number(c.min_order_cents)) })}` : ''}</td>
                  <td className="mono">{c.uses}{c.max_uses ? ` / ${c.max_uses}` : ''}</td>
                  <td className="small">{c.ends_at ? new Date(c.ends_at).toLocaleDateString(intlLocale()) : '—'}</td>
                  <td>
                    <button className="btn ghost" onClick={async () => (await api(`/seller/codes/${c.id}`, { method: 'PATCH', body: { active: !c.active } }), load())}>
                      {c.active ? t('code.pause') : t('code.resume')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="row" onSubmit={create} style={{ alignItems: 'end' }}>
        <label className="field">{t('code.code')}<input name="code" required minLength={3} maxLength={30} pattern="[A-Za-z0-9_\-]+" placeholder="SPRING10" /></label>
        <label className="field" style={{ width: 110 }}>{t('code.off')}<input name="percent" type="number" min={1} max={90} required defaultValue={10} /></label>
        <label className="field" style={{ width: 140 }}>{t('code.min')}<input name="min" type="number" step="0.01" min="0" /></label>
        <label className="field" style={{ width: 120 }}>{t('code.max')}<input name="max" type="number" min={1} /></label>
        <label className="field">{t('code.ends')}<input name="ends" type="date" /></label>
        <button className="btn">{t('code.create')}</button>
      </form>
      {error && <div className="alert" role="alert">{error}</div>}
    </div>
  );
}

function OfferRow({ offer, linked, onChange, founding }: { offer: SellerOffer; linked: LinkedAccount[]; onChange: () => void; founding?: Founding }) {
  const [featureError, setFeatureError] = useState('');
  const shown = linked.find((a) => a.id === offer.linked_account_id);
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<'txt' | 'json'>('txt');
  const [content, setContent] = useState('');
  const [result, setResult] = useState('');
  const [proofOpen, setProofOpen] = useState(false);
  const [saleOpen, setSaleOpen] = useState(false);
  const needsProof = offer.category_slug === 'accounts' && ['none', 'rejected'].includes(offer.owner_proof_status);

  const submitProof = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api(`/offers/${offer.id}/owner-proof`, {
        body: { registrationEmail: f.registrationEmail, registrationDate: f.registrationDate, billingName: f.billingName || undefined, evidence: { notes: f.evidence } },
      });
      setProofOpen(false);
      onChange();
    } catch (err: any) {
      setResult(err.message);
    }
  };

  const upload = async () => {
    try {
      const r = await api<{ added: number; duplicates: number; available: number }>(`/offers/${offer.id}/inventory`, { body: { format, content } });
      setResult(t('sell.uploaded', { added: r.added, duplicates: r.duplicates, available: r.available }));
      setContent('');
      onChange();
    } catch (e: any) {
      setResult(e.message);
    }
  };

  const readFile = async (file: File) => {
    setFormat(file.name.endsWith('.json') ? 'json' : 'txt');
    setContent(await file.text());
  };

  return (
    <>
      <tr>
        <td>
          <b>{offer.title}</b>{offer.is_bundle && <span className="chip" style={{ marginInlineStart: 6 }}>{t('bundle.chip')}</span>}
          <div className="small muted">{offer.game} · {categoryLabel(offer.category_slug)}</div>
          {offer.status === 'review' && (
            <div className="small" title={t('mod.inReviewHint')}><span className="chip held">{t('mod.inReview')}</span> <span className="muted">{t('mod.inReviewHint')}</span></div>
          )}
          {offer.status === 'expired' && <RelistExpired offer={offer} onDone={onChange} />}
          {shown && <div className="small"><span className="chip released">{t('linked.listingChip', { platform: platformName(shown.provider) })}</span> <span className="muted">{shown.display_name}</span></div>}
          {offer.category_slug === 'accounts' && offer.owner_proof_status !== 'verified' && (
            <div className="small" style={{ color: 'var(--disputed)' }}>{t('sell.ownerProof', { status: offer.owner_proof_status })}</div>
          )}
        </td>
        <td className="mono">
          {money(offer.seller_price_cents ?? offer.price_cents)}
          <div className="small muted">{t('ranks.buyersPay', { price: money(offer.price_cents) })}</div>
          {offer.sale_price_cents != null && offer.sale_ends_at && new Date(offer.sale_ends_at) > new Date() && (
            <div className="small text-released">{t('sale.until', { price: money(offer.sale_price_cents), when: new Date(offer.sale_ends_at).toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' }) })}</div>
          )}
        </td>
        <td className="mono">{offer.available}</td>
        <td>{offer.delivery_mode === 'auto' ? t('delivery.instant') : t('sell.manual')}</td>
        <td>
          {offer.delivery_mode === 'auto' && !offer.is_bundle && <button className="btn ghost" onClick={() => setOpen(!open)}>{t('sell.addStock')}</button>}
          {needsProof && <button className="btn ghost" onClick={() => setProofOpen(!proofOpen)}>{t('sell.addProof')}</button>}
          {!offer.reserved_for && <button className="btn ghost" onClick={() => setSaleOpen(!saleOpen)}>{t('sale.button')}</button>}
          {founding?.founding && founding.windowOpen && offer.status === 'active' && (
            offer.featured ? (
              <button className="btn ghost" onClick={() => api(`/offers/${offer.id}/feature`, { method: 'DELETE' }).then(onChange).catch((e) => setFeatureError(e.message))}>{t('founding.unfeature')}</button>
            ) : (
              <button className="btn ghost" disabled={founding.featuredUsed >= founding.featuredSlots} title={founding.featuredUsed >= founding.featuredSlots ? t('founding.noSlots') : ''} onClick={() => api(`/offers/${offer.id}/feature`, { body: {} }).then(onChange).catch((e) => setFeatureError(e.message))}>{t('founding.feature')}</button>
            )
          )}
          {offer.featured && <div className="small text-released">{t('founding.featuredUntil', { when: offer.featured_until ? new Date(offer.featured_until).toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' }) : '' })}</div>}
          {featureError && <div className="small" style={{ color: 'var(--disputed)' }}>{featureError}</div>}
        </td>
      </tr>
      {saleOpen && (
        <tr>
          <td colSpan={5}>
            <SaleForm offer={offer} onDone={() => (setSaleOpen(false), onChange())} />
          </td>
        </tr>
      )}
      {proofOpen && (
        <tr>
          <td colSpan={5}>
            <form className="stack" onSubmit={submitProof}>
              <p className="small muted">{t('sell.proof.text')}</p>
              <div className="grid three">
                <label className="field">{t('sell.proof.email')}<input name="registrationEmail" type="email" required /></label>
                <label className="field">{t('sell.proof.date')}<input name="registrationDate" type="date" required /></label>
                <label className="field">{t('sell.proof.billing')}<input name="billingName" /></label>
              </div>
              <label className="field">{t('sell.proof.evidence')}<textarea name="evidence" /></label>
              <button className="btn">{t('sell.proof.submit')}</button>
            </form>
          </td>
        </tr>
      )}
      {open && (
        <tr>
          <td colSpan={5}>
            <div className="stack">
              <p className="small muted">{t('sell.upload.text')}</p>
              <input type="file" accept=".txt,.json" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
              <textarea className="mono" value={content} onChange={(e) => setContent(e.target.value)} placeholder={format === 'txt' ? 'XXXX-XXXX-XXXX\nYYYY-YYYY-YYYY' : '["XXXX-XXXX", {"login": "…", "password": "…"}]'} />
              <div className="row">
                <select value={format} onChange={(e) => setFormat(e.target.value as 'txt' | 'json')} style={{ width: 120 }}>
                  <option value="txt">.txt</option>
                  <option value="json">JSON</option>
                </select>
                <button className="btn" disabled={!content.trim()} onClick={upload}>{t('sell.upload')}</button>
              </div>
              {result && <div className="notice">{result}</div>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function NewOffer({ onCreated, offers, linked }: { onCreated: () => void; offers: SellerOffer[]; linked: LinkedAccount[] }) {
  const [error, setError] = useState('');
  const [bundleOn, setBundleOn] = useState(false);
  const [parts, setParts] = useState<Record<string, number>>({});
  const bundleable = offers.filter((o) => o.delivery_mode === 'auto' && o.status === 'active' && !o.is_bundle && !o.reserved_for);
  useCategoryOrder(); // closed launch-phase categories drop out of the picker once known
  const [category, setCategory] = useState('currency');
  const [game, setGame] = useState('');
  const [price, setPrice] = useState('');
  useLeagues(game); // league options refresh from the table once it loads
  const fields = attributesFor(game, category);
  const { games } = useGames();
  // Account listings can show a linked account from the game's own platform, if it isn't on another listing.
  const platform = category === 'accounts' ? platformForGame(game) : null;
  const inUse = new Set(offers.filter((o) => ['active', 'paused', 'review'].includes(o.status)).map((o) => o.linked_account_id));
  const linkable = platform ? linked.filter((a) => a.provider === platform && !inUse.has(a.id)) : [];
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError('');
    try {
      await api('/offers', {
        body: {
          categorySlug: f.categorySlug,
          game: f.game,
          title: f.title,
          description: f.description,
          priceCents: Math.round(Number(f.price) * 100),
          deliveryMode: f.deliveryMode,
          attributes: Object.fromEntries(fields.map((d) => [d.key, f[`attr.${d.key}`] ?? '']).filter(([, v]) => v)),
          priceTiers: category === 'accounts' ? undefined : TIER_ROWS.filter((i) => f[`tierQty${i}`] && f[`tierPrice${i}`]).map((i) => ({ minQty: Number(f[`tierQty${i}`]), priceCents: Math.round(Number(f[`tierPrice${i}`]) * 100) })),
          ...(f.deliveryMode === 'manual' && f.categorySlug !== 'accounts' ? { stock: Number(f.stock || 1) } : {}),
          ...(f.categorySlug === 'accounts' && Number(f.warrantyDays) ? { warrantyDays: Number(f.warrantyDays) } : {}),
          ...(f.linkedAccountId ? { linkedAccountId: f.linkedAccountId } : {}),
          ...(f.minBuyerReputation === 'on' ? { minBuyerReputation: 'good' } : {}),
          ...(bundleOn ? { bundle: Object.entries(parts).map(([offerId, quantity]) => ({ offerId, quantity })) } : {}),
        },
      });
      form.reset();
      setGame('');
      setPrice('');
      setBundleOn(false);
      setParts({});
      onCreated();
    } catch (err: any) {
      setError(err.message);
    }
  };
  return (
    <form className="pg-sell" id="create-offer" onSubmit={submit} aria-labelledby="create-offer-title">
      <h2 id="create-offer-title" className="pg-h1">{t('sell.new')}</h2>
      <div className="pg-split">
      <div className="pg-sell-main">
      <div className="card pg-sell-games">
        <p className="pg-label">{t('sell.f.game')}</p>
        <div className="pg-gpick" role="group" aria-label={t('sell.f.launchGames')}>
          {LAUNCH_GAMES.map((g) => (
            <button key={g} type="button" aria-pressed={game.trim().toLowerCase() === g.toLowerCase()} onClick={() => setGame(g)}>
              <i aria-hidden>{LAUNCH_INI[g]}</i>{g}
            </button>
          ))}
        </div>
      </div>
      <div className="card stack">
      <div className="grid two">
        <label className="field">
          {t('market.category')}
          <select name="categorySlug" value={category} onChange={(e) => setCategory(e.target.value)}>
            {['currency', 'items', 'top-ups', 'accounts', 'boosting', 'keys', 'gift-cards', 'video-games'].filter(isCategoryOpen).map((c) => (
              <option key={c} value={c}>{categoryLabel(c)}</option>
            ))}
          </select>
        </label>
        <label className="field">{t('sell.f.game')}<input name="game" required maxLength={80} value={game} onChange={(e) => setGame(e.target.value)} list="sell-games" /></label>
        <datalist id="sell-games">{games?.map((g) => <option key={g.game} value={g.game} />)}</datalist>
        <label className="field">{t('sell.f.title')}<input name="title" required minLength={3} maxLength={140} /></label>
        <label className="field">
          {t('sell.f.price')}
          <input name="price" className="num" type="number" step="0.01" min="0.01" required value={price} onChange={(e) => setPrice(e.target.value)} aria-describedby="price-preview" />
        </label>
        <label className="field">
          {t('table.delivery')}
          <select name="deliveryMode" defaultValue="auto">
            <option value="auto">{t('sell.f.auto')}</option>
            <option value="manual">{t('sell.f.manual')}</option>
          </select>
        </label>
        {category !== 'accounts' && <label className="field">{t('sell.f.stock')}<input name="stock" type="number" min="1" defaultValue="1" /></label>}
        {category === 'accounts' && (
          <label className="field">
            {t('warranty.sellLabel')}
            <select name="warrantyDays" defaultValue="0" aria-describedby="warranty-hint">
              {[0, 7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d ? t('warranty.days', { count: d }) : t('warranty.none')}</option>)}
            </select>
            <span id="warranty-hint" className="small muted">{t('warranty.sellHint')}</span>
          </label>
        )}
        <div className="field">
          <label className="check-row" style={{ color: 'var(--ink)' }}>
            <input name="minBuyerReputation" type="checkbox" style={{ width: 'auto' }} aria-describedby="minrep-hint" /> {t('minRep.sellLabel')}
          </label>
          <span id="minrep-hint" className="small muted">{t('minRep.sellHint')}</span>
        </div>
        {platform && (
          <label className="field">
            {t('linked.sellLabel', { platform: platformName(platform) })}
            <select name="linkedAccountId" defaultValue="" aria-describedby="linked-hint" key={`${platform}-${linkable.length}`}>
              <option value="">{t('linked.sellNone')}</option>
              {linkable.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
            </select>
            <span id="linked-hint" className="small muted">{linkable.length ? t('linked.sellHint') : t('linked.sellLinkFirst', { platform: platformName(platform) })}</span>
          </label>
        )}
      </div>
      {fields.length > 0 && (
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
          <legend className="small muted" style={{ marginBottom: 8 }}>
            {game.trim() ? t('sell.f.detailsFor', { game: game.trim() }) : t('sell.f.details')} · {t('sell.f.detailsHint')}
          </legend>
          <div className="grid three">
            {fields.map((d) => (
              <label key={`${category}-${game.trim().toLowerCase()}-${d.key}`} className="field">
                {attrLabel(d.label)}{d.required ? '' : ` (${t('sell.f.optional')})`}
                {d.type === 'select' ? (
                  <select name={`attr.${d.key}`} required={d.required} defaultValue="">
                    <option value="">{d.required ? t('sell.f.choose') : '—'}</option>
                    {d.options!.map((o) => <option key={o}>{o}</option>)}
                  </select>
                ) : (
                  <input name={`attr.${d.key}`} required={d.required} maxLength={60} />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {category !== 'accounts' && (
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
          <legend className="small muted" style={{ marginBottom: 8 }}>{t('tier.sellTitle')} · {t('tier.sellHint')}</legend>
          <div className="grid three">
            {TIER_ROWS.map((i) => (
              <div key={i} className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <label className="field" style={{ flex: 1 }}>{t('tier.fromQty')}<input name={`tierQty${i}`} type="number" min={2} placeholder={String([10, 50, 100][i])} /></label>
                <label className="field" style={{ flex: 1 }}>{t('tier.each')}<input name={`tierPrice${i}`} type="number" step="0.01" min="0.01" /></label>
              </div>
            ))}
          </div>
        </fieldset>
      )}
      {category !== 'accounts' && bundleable.length >= 2 && (
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={bundleOn} onChange={(e) => setBundleOn(e.target.checked)} />
            {t('bundle.make')}
          </label>
          {bundleOn && (
            <>
              <p className="small muted" style={{ margin: 0 }}>{t('bundle.makeHint')}</p>
              <div className="grid two">
                {bundleable.map((o) => (
                  <label key={o.id} className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={o.id in parts}
                      onChange={(e) => setParts((p) => {
                        const next = { ...p };
                        if (e.target.checked) next[o.id] = 1;
                        else delete next[o.id];
                        return next;
                      })}
                    />
                    <span className="min-w-0 flex-1 truncate">{o.title}</span>
                    {o.id in parts && (
                      <input type="number" min={1} max={20} value={parts[o.id]} aria-label={t('bundle.qtyOf', { title: o.title })} onChange={(e) => setParts((p) => ({ ...p, [o.id]: Math.max(1, Number(e.target.value)) }))} style={{ width: 64, height: 30, padding: '2px 6px' }} />
                    )}
                  </label>
                ))}
              </div>
            </>
          )}
        </fieldset>
      )}
      <label className="field">{t('sell.f.description')}<textarea name="description" maxLength={5000} /></label>
      {category === 'accounts' && (
        <p className="small muted">{t('sell.f.accountHint')}</p>
      )}
      </div>
      </div>
      <aside className="card pg-sticky pg-sell-preview">
        <SellPreview price={price} />
        {error && <div className="alert" role="alert">{error}</div>}
        <button className="btn lg block" type="submit">{t('sell.f.create')}</button>
        <p className="small muted" style={{ margin: 0 }}>{t('sell.f.howPaid')}</p>
      </aside>
      </div>
    </form>
  );
}


const LAUNCH_GAMES = ['Albion Online', 'Aion', 'Aion 2', 'Path of Exile', 'Path of Exile 2'];
const LAUNCH_INI: Record<string, string> = { 'Albion Online': 'AO', Aion: 'AI', 'Aion 2': 'A2', 'Path of Exile': 'P1', 'Path of Exile 2': 'P2' };
const PREVIEW_CURRENCIES = ['USD', 'EUR', 'EGP'] as const;

/**
 * The sell form's sticky preview: "You earn" is the seller's own price; "Buyer pays" is that price
 * with the commission added on top (API maths). One currency at a time, the others in a line below.
 */
function SellPreview({ price }: { price: string }) {
  const [p, setP] = useState<Preview | null>(null);
  const [cur, setCur] = useState<(typeof PREVIEW_CURRENCIES)[number]>('USD');
  const cents = Math.round(Number(price) * 100);
  useEffect(() => {
    if (!(cents > 0)) return setP(null);
    let live = true;
    const id = setTimeout(() => {
      api<Preview>(`/seller/price-preview?priceCents=${cents}&currency=USD`).then((r) => live && setP(r)).catch(() => live && setP(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [cents]);
  const rate = (c: string) => (p && p.buyerCents ? (p.buyerIn[c] ?? p.buyerCents) / p.buyerCents : 1);
  const show = (usdCents: number, c: string) => (c === 'USD' ? money(usdCents) : `≈ ${money(Math.round(usdCents * rate(c)), c)}`);
  return (
    <div className="pg-sell-pv" id="price-preview" data-testid="price-preview" aria-live="polite">
      <div className="row spread">
        <p className="pg-label">{t('preview.title')}</p>
        <div className="pg-seg" role="group" aria-label={t('preview.currency')}>
          {PREVIEW_CURRENCIES.map((c) => <button key={c} type="button" aria-pressed={cur === c} onClick={() => setCur(c)}>{c}</button>)}
        </div>
      </div>
      {!(cents > 0) || !p ? (
        <p className="small muted" style={{ margin: 0 }}>{cents > 0 ? '…' : t('preview.hint')}</p>
      ) : (
        <>
          <div className="pg-earn">
            <span className="small muted">{t('preview.earnLabel')}</span>{' '}
            <span className="pg-big">{show(p.sellerCents, cur)}</span>
          </div>
          <div className="pg-rows">
            <div className="pg-total"><span>{t('preview.buyerPaysLabel')}</span><span className="pg-price">{show(p.buyerCents, cur)}</span></div>
          </div>
          <span className="small muted">
            {t('preview.buyersPay', { price: money(p.buyerCents) })}
            {PREVIEW_CURRENCIES.filter((c) => c !== 'USD').map((c) => ` · ${show(p.buyerCents, c)}`).join('')}
            {' · '}<Link to="/help/selling-fees">{t('preview.feeDetails')}</Link>
          </span>
        </>
      )}
    </div>
  );
}

interface Preview {
  sellerCents: number;
  rateBps: number;
  promo: { rateBps: number; endsAt: string } | null;
  rank: string;
  buyerCents: number;
  buyerIn: Record<string, number>;
  commissionCents: number;
  withdrawalFeeBps: number;
  withdrawalFeeCents: number;
  afterWithdrawalCents: number;
}

/**
 * Live preview under the price field: what buyers will see in each currency, and what the seller
 * keeps after the withdrawal fee. The API does the maths (GET /seller/price-preview) so the number
 * shown is the number charged.
 */
export function PricePreview({ price, currency = 'USD' }: { price: string; currency?: string }) {
  const [p, setP] = useState<Preview | null>(null);
  const cents = Math.round(Number(price) * 100);
  useEffect(() => {
    if (!(cents > 0)) {
      setP(null);
      return;
    }
    let live = true;
    const id = setTimeout(() => {
      api<Preview>(`/seller/price-preview?priceCents=${cents}&currency=${currency}`).then((r) => live && setP(r)).catch(() => live && setP(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [cents, currency]);
  if (!(cents > 0)) return <span id="price-preview" className="small muted">{t('preview.hint')}</span>;
  if (!p) return <span id="price-preview" className="small muted">…</span>;
  const others = Object.entries(p.buyerIn).filter(([c]) => c !== 'USD');
  return (
    <span id="price-preview" className="small stack" style={{ gap: 2 }} data-testid="price-preview">
      <span>
        <b>{t('preview.buyersPay', { price: money(p.buyerCents) })}</b>
        {others.length > 0 && <span className="muted"> · {others.map(([c, v]) => `≈ ${money(v, c)}`).join(' · ')}</span>}
      </span>
      <span className="muted">{t('preview.commission', { amount: money(p.commissionCents), rate: pct(p.rateBps) })}{p.promo ? ` · ${t('preview.promo', { until: new Date(p.promo.endsAt).toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' }) })}` : ''}</span>
      <span className="muted">{t('preview.youEarn', { price: money(p.sellerCents) })} · <Link to="/help/selling-fees">{t('preview.feeDetails')}</Link></span>
    </span>
  );
}


/** A listing taken off the market when its league ended: pick an open league to list it again. */
function RelistExpired({ offer, onDone }: { offer: SellerOffer; onDone: () => void }) {
  const leagues = useLeagues(offer.game);
  const ended = offer.expired_reason?.startsWith('league_ended:') ? offer.expired_reason.slice('league_ended:'.length) : null;
  const [league, setLeague] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="small stack" style={{ gap: 4 }} data-testid="relist">
      <span><span className="chip disputed">{t('league.ended', { league: ended ?? '' })}</span> <span className="muted">{t('league.endedHint')}</span></span>
      <div className="row" style={{ gap: 6 }}>
        <select aria-label={t('league.pick')} value={league} onChange={(e) => setLeague(e.target.value)} style={{ width: 'auto' }}>
          <option value="">{t('league.pick')}</option>
          {leagues.map((l) => <option key={l}>{l}</option>)}
        </select>
        <button
          className="btn small"
          disabled={!league}
          onClick={async () => {
            setError('');
            try {
              await api(`/offers/${offer.id}/relist`, { body: { league } });
              onDone();
            } catch (e: any) {
              setError(e.message);
            }
          }}
        >
          {t('league.relist')}
        </button>
      </div>
      {error && <span style={{ color: 'var(--disputed)' }}>{error}</span>}
    </div>
  );
}
