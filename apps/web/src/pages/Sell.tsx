import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api, money } from '../api';
import { FeeLadder } from '../components/FeeLadder';
import { useSession } from '../session';
import { SellerMoney } from './SellerMoney';
import { SellerAnalytics } from './SellerAnalytics';
import { usePageMeta } from '@/lib/seo';
import { t } from '../i18n';
import { attrLabel, attributesFor } from '@/lib/attributes';
import { categoryLabel, useGames } from '@/lib/catalog';

interface Dashboard {
  tier: { name: string; accountRateBps: number; otherRateBps: number };
  monthlySalesCents: number;
  next: { tier: { name: string; minMonthlySalesCents: number }; remainingCents: number } | null;
  payoutCurrency?: string;
  balances: { availableCents: number; pendingEscrowCents: number; withdrawableCents?: number; onHoldCents?: number; currency?: string };
  withdrawalsFrozen: boolean;
  stats: { completed: number; in_progress: number; disputed: number; charged_back: number };
}

interface SellerOffer {
  id: string;
  title: string;
  game: string;
  category_slug: string;
  price_cents: number;
  delivery_mode: 'auto' | 'manual';
  available: number;
  status: string;
  owner_proof_status: string;
  version: number;
}

export function Sell() {
  usePageMeta({ title: 'Sell on Bullizard', description: 'Open a shop: fees fall as your sales grow, instant delivery for codes, Chargeback Shield and payouts in USD, EUR or GBP.' });
  const { user, refresh } = useSession();
  const { pathname } = useLocation();
  const moneyTab = pathname.startsWith('/sell/money');
  const analyticsTab = pathname.startsWith('/sell/analytics');
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [offers, setOffers] = useState<SellerOffer[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [d, o] = await Promise.all([api<Dashboard>('/seller/dashboard'), api<SellerOffer[]>('/seller/offers')]);
    setDash(d);
    setOffers(o);
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
  if (user.kyc_tier < 2) {
    return (
      <div className="stack" style={{ maxWidth: 720 }}>
        <h1 style={{ fontSize: 40 }}>{t('sell.kyc.title')}</h1>
        <p className="lede">{t('sell.kyc.lede')}</p>
        <Link className="btn" to="/account">{t('sell.kyc.verify')}</Link>
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

  const setUpPayouts = async () => {
    try {
      const { url } = await api<{ url: string }>('/seller/payout-account', { body: {} });
      window.location.assign(url);
    } catch (e: any) {
      setMsg({ kind: 'alert', text: e.message });
    }
  };

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
      <div className="grid three">
        <div className="card stack">
          <div className="eyebrow">{t('sell.level')}</div>
          <h2 style={{ margin: 0 }}>{dash.tier.name}</h2>
          <p className="small muted">
            {t('sell.fees', { fee: (dash.tier.otherRateBps / 100).toFixed(2), accounts: (dash.tier.accountRateBps / 100).toFixed(2) })}
          </p>
          <div className="progress" aria-label={t('sell.progress')}><div style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>
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
                {offers.map((o) => <OfferRow key={o.id} offer={o} onChange={load} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NewOffer onCreated={load} />
    </div>
  );
}

function OfferRow({ offer, onChange }: { offer: SellerOffer; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<'txt' | 'json'>('txt');
  const [content, setContent] = useState('');
  const [result, setResult] = useState('');
  const [proofOpen, setProofOpen] = useState(false);
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
          <b>{offer.title}</b>
          <div className="small muted">{offer.game} · {categoryLabel(offer.category_slug)}</div>
          {offer.category_slug === 'accounts' && offer.owner_proof_status !== 'verified' && (
            <div className="small" style={{ color: 'var(--disputed)' }}>{t('sell.ownerProof', { status: offer.owner_proof_status })}</div>
          )}
        </td>
        <td className="mono">{money(offer.price_cents)}</td>
        <td className="mono">{offer.available}</td>
        <td>{offer.delivery_mode === 'auto' ? t('delivery.instant') : t('sell.manual')}</td>
        <td>
          {offer.delivery_mode === 'auto' && <button className="btn ghost" onClick={() => setOpen(!open)}>{t('sell.addStock')}</button>}
          {needsProof && <button className="btn ghost" onClick={() => setProofOpen(!proofOpen)}>{t('sell.addProof')}</button>}
        </td>
      </tr>
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

function NewOffer({ onCreated }: { onCreated: () => void }) {
  const [error, setError] = useState('');
  const [category, setCategory] = useState('keys');
  const [game, setGame] = useState('');
  const fields = attributesFor(game, category);
  const { games } = useGames();
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
          ...(f.deliveryMode === 'manual' && f.categorySlug !== 'accounts' ? { stock: Number(f.stock || 1) } : {}),
        },
      });
      form.reset();
      setGame('');
      onCreated();
    } catch (err: any) {
      setError(err.message);
    }
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h3>{t('sell.new')}</h3>
      <div className="grid two">
        <label className="field">
          {t('market.category')}
          <select name="categorySlug" value={category} onChange={(e) => setCategory(e.target.value)}>
            {['keys', 'accounts', 'currency', 'items', 'boosting', 'gift-cards', 'top-ups', 'video-games'].map((c) => (
              <option key={c} value={c}>{categoryLabel(c)}{['gift-cards', 'top-ups', 'video-games'].includes(c) ? ' (4.99%)' : ''}</option>
            ))}
          </select>
        </label>
        <label className="field">{t('sell.f.game')}<input name="game" required maxLength={80} value={game} onChange={(e) => setGame(e.target.value)} list="sell-games" /></label>
        <datalist id="sell-games">{games?.map((g) => <option key={g.game} value={g.game} />)}</datalist>
        <label className="field">{t('sell.f.title')}<input name="title" required minLength={3} maxLength={140} /></label>
        <label className="field">{t('sell.f.price')}<input name="price" type="number" step="0.01" min="0.01" required /></label>
        <label className="field">
          {t('table.delivery')}
          <select name="deliveryMode" defaultValue="auto">
            <option value="auto">{t('sell.f.auto')}</option>
            <option value="manual">{t('sell.f.manual')}</option>
          </select>
        </label>
        {category !== 'accounts' && <label className="field">{t('sell.f.stock')}<input name="stock" type="number" min="1" defaultValue="1" /></label>}
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
      <label className="field">{t('sell.f.description')}<textarea name="description" maxLength={5000} /></label>
      {category === 'accounts' && (
        <p className="small muted">{t('sell.f.accountHint')}</p>
      )}
      {error && <div className="alert">{error}</div>}
      <button className="btn" type="submit">{t('sell.f.create')}</button>
    </form>
  );
}
