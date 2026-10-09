import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api, money } from '../api';
import { FeeLadder } from '../components/FeeLadder';
import { useSession } from '../session';
import { SellerMoney } from './SellerMoney';
import { usePageMeta } from '@/lib/seo';
import { attributesFor } from '@/lib/attributes';
import { useGames } from '@/lib/catalog';

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
  const moneyTab = useLocation().pathname.startsWith('/sell/money');
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

  if (!user) return <p className="muted"><Link to="/login?next=/sell">Sign in</Link> to start selling.</p>;
  if (user.kyc_tier < 2) {
    return (
      <div className="stack" style={{ maxWidth: 720 }}>
        <h1 style={{ fontSize: 40 }}>Sell on the marketplace</h1>
        <p className="lede">Sellers verify their identity once. It keeps scammers out and lets us pay you out without holds.</p>
        <Link className="btn" to="/account">Verify your identity</Link>
        <div className="card"><FeeLadder /></div>
      </div>
    );
  }
  const tabs = (
    <nav className="filters" aria-label="Seller sections">
      <NavLink end to="/sell">Shop</NavLink>
      <NavLink to="/sell/money">Money &amp; tax</NavLink>
    </nav>
  );
  if (moneyTab) {
    return (
      <div className="stack">
        <h1 style={{ fontSize: 40 }}>Your shop</h1>
        {tabs}
        <SellerMoney />
      </div>
    );
  }
  if (!dash) return <p className="muted">Loading your shop…</p>;
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
      setMsg({ kind: 'ok', text: `Withdrawal of ${money(withdrawable, cur)} sent.` });
      load();
    } catch (e: any) {
      setMsg({ kind: 'alert', text: e.message });
    }
  };

  return (
    <div className="stack">
      <h1 style={{ fontSize: 40 }}>Your shop</h1>
      {tabs}
      <div className="grid three">
        <div className="card stack">
          <div className="eyebrow">Level</div>
          <h2 style={{ margin: 0 }}>{dash.tier.name}</h2>
          <p className="small muted">
            Fee {(dash.tier.otherRateBps / 100).toFixed(2)}% · accounts {(dash.tier.accountRateBps / 100).toFixed(2)}%
          </p>
          <div className="progress" aria-label="Progress to next level"><div style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>
          <p className="small muted">
            {dash.next ? `${money(dash.next.remainingCents)} more in 30-day sales reaches ${dash.next.tier.name}.` : 'Top level reached.'}
          </p>
        </div>
        <div className="card stack">
          <div className="eyebrow">Balance</div>
          <h2 className="mono" style={{ margin: 0 }}>{money(withdrawable, cur)}</h2>
          <p className="small muted">
            Ready to withdraw.{dash.balances.onHoldCents ? ` ${money(dash.balances.onHoldCents, cur)} on payout hold.` : ''} {money(dash.balances.pendingEscrowCents)} still in escrow on open orders.{' '}
            <Link to="/sell/money">Details</Link>
          </p>
          {user.payouts_enabled ? (
            <button className="btn" disabled={dash.withdrawalsFrozen || withdrawable <= 0} onClick={withdraw}>Withdraw all</button>
          ) : (
            <>
              <button className="btn" onClick={setUpPayouts}>Set up payouts</button>
              <p className="small muted">Add the bank account we pay you into. Our payment partner collects the details on their secure page.</p>
            </>
          )}
          {dash.withdrawalsFrozen && <p className="small muted">Withdrawals are paused while a security review runs.</p>}
        </div>
        <div className="card stack">
          <div className="eyebrow">Orders</div>
          <p className="mono">{dash.stats.completed} completed · {dash.stats.in_progress} open</p>
          <p className="mono">{dash.stats.disputed} disputed · {dash.stats.charged_back} charged back</p>
          <Link to="/orders?as=seller">Manage orders</Link>
        </div>
      </div>
      {msg && <div className={msg.kind}>{msg.text}</div>}

      <div className="card">
        <h3>Listings</h3>
        {offers.length === 0 ? (
          <p className="muted">No listings yet. Create your first one below.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Listing</th><th>Price</th><th>Stock</th><th>Delivery</th><th /></tr></thead>
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
      setResult(`Added ${r.added}, skipped ${r.duplicates} duplicates. ${r.available} ready for instant delivery.`);
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
          <div className="small muted">{offer.game} · {offer.category_slug}</div>
          {offer.category_slug === 'accounts' && offer.owner_proof_status !== 'verified' && (
            <div className="small" style={{ color: 'var(--disputed)' }}>Owner proof: {offer.owner_proof_status}</div>
          )}
        </td>
        <td className="mono">{money(offer.price_cents)}</td>
        <td className="mono">{offer.available}</td>
        <td>{offer.delivery_mode === 'auto' ? 'Instant' : 'Manual'}</td>
        <td>
          {offer.delivery_mode === 'auto' && <button className="btn ghost" onClick={() => setOpen(!open)}>Add stock</button>}
          {needsProof && <button className="btn ghost" onClick={() => setProofOpen(!proofOpen)}>Add owner proof</button>}
        </td>
      </tr>
      {proofOpen && (
        <tr>
          <td colSpan={5}>
            <form className="stack" onSubmit={submitProof}>
              <p className="small muted">Buyers see verified accounts as lower risk. The billing name must match the name on your verified ID.</p>
              <div className="grid three">
                <label className="field">Original registration email<input name="registrationEmail" type="email" required /></label>
                <label className="field">Registration date<input name="registrationDate" type="date" required /></label>
                <label className="field">Billing name on early purchases<input name="billingName" /></label>
              </div>
              <label className="field">Evidence (links to screenshots of the registration email, early receipts, CD key)<textarea name="evidence" /></label>
              <button className="btn">Submit for review</button>
            </form>
          </td>
        </tr>
      )}
      {open && (
        <tr>
          <td colSpan={5}>
            <div className="stack">
              <p className="small muted">One code per line (.txt) or a JSON array of strings or objects. Everything is encrypted as it's stored; duplicates are skipped.</p>
              <input type="file" accept=".txt,.json" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
              <textarea className="mono" value={content} onChange={(e) => setContent(e.target.value)} placeholder={format === 'txt' ? 'XXXX-XXXX-XXXX\nYYYY-YYYY-YYYY' : '["XXXX-XXXX", {"login": "…", "password": "…"}]'} />
              <div className="row">
                <select value={format} onChange={(e) => setFormat(e.target.value as 'txt' | 'json')} style={{ width: 120 }}>
                  <option value="txt">.txt</option>
                  <option value="json">JSON</option>
                </select>
                <button className="btn" disabled={!content.trim()} onClick={upload}>Upload stock</button>
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
      <h3>New listing</h3>
      <div className="grid two">
        <label className="field">
          Category
          <select name="categorySlug" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="keys">Software & CD keys</option>
            <option value="accounts">Game accounts</option>
            <option value="currency">In-game currency</option>
            <option value="items">In-game items</option>
            <option value="boosting">Boosting</option>
            <option value="gift-cards">Gift cards (4.99%)</option>
            <option value="top-ups">Top-ups (4.99%)</option>
            <option value="video-games">Video games (4.99%)</option>
          </select>
        </label>
        <label className="field">Game<input name="game" required maxLength={80} value={game} onChange={(e) => setGame(e.target.value)} list="sell-games" /></label>
        <datalist id="sell-games">{games?.map((g) => <option key={g.game} value={g.game} />)}</datalist>
        <label className="field">Title<input name="title" required minLength={3} maxLength={140} /></label>
        <label className="field">Price (USD)<input name="price" type="number" step="0.01" min="0.01" required /></label>
        <label className="field">
          Delivery
          <select name="deliveryMode" defaultValue="auto">
            <option value="auto">Instant, from uploaded stock</option>
            <option value="manual">I deliver each order myself</option>
          </select>
        </label>
        {category !== 'accounts' && <label className="field">Stock (manual delivery)<input name="stock" type="number" min="1" defaultValue="1" /></label>}
      </div>
      {fields.length > 0 && (
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
          <legend className="small muted" style={{ marginBottom: 8 }}>
            {game.trim() ? `${game.trim()} details` : 'Listing details'} · buyers filter by these on the game page
          </legend>
          <div className="grid three">
            {fields.map((d) => (
              <label key={`${category}-${game.trim().toLowerCase()}-${d.key}`} className="field">
                {d.label}{d.required ? '' : ' (optional)'}
                {d.type === 'select' ? (
                  <select name={`attr.${d.key}`} required={d.required} defaultValue="">
                    <option value="">{d.required ? 'Choose…' : '—'}</option>
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
      <label className="field">Description<textarea name="description" maxLength={5000} /></label>
      {category === 'accounts' && (
        <p className="small muted">After creating an account listing, submit Original Owner Proof so buyers see it as verified instead of high risk.</p>
      )}
      {error && <div className="alert">{error}</div>}
      <button className="btn" type="submit">Create listing</button>
    </form>
  );
}
