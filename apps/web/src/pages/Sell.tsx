import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { FeeLadder } from '../components/FeeLadder';
import { useSession } from '../session';

interface Dashboard {
  tier: { name: string; accountRateBps: number; otherRateBps: number };
  monthlySalesCents: number;
  next: { tier: { name: string; minMonthlySalesCents: number }; remainingCents: number } | null;
  balances: { availableCents: number; pendingEscrowCents: number };
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
  const { user } = useSession();
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
  if (!dash) return <p className="muted">Loading your shop…</p>;

  const progress = dash.next ? dash.monthlySalesCents / dash.next.tier.minMonthlySalesCents : 1;

  const withdraw = async () => {
    try {
      await api('/seller/withdrawals', { body: { amountCents: dash.balances.availableCents } });
      setMsg({ kind: 'ok', text: `Withdrawal of ${money(dash.balances.availableCents)} sent.` });
      load();
    } catch (e: any) {
      setMsg({ kind: 'alert', text: e.message });
    }
  };

  return (
    <div className="stack">
      <h1 style={{ fontSize: 40 }}>Your shop</h1>
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
          <h2 className="mono" style={{ margin: 0 }}>{money(dash.balances.availableCents)}</h2>
          <p className="small muted">{money(dash.balances.pendingEscrowCents)} still in escrow on open orders.</p>
          <button className="btn" disabled={dash.withdrawalsFrozen || dash.balances.availableCents <= 0} onClick={withdraw}>Withdraw all</button>
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
          ...(f.deliveryMode === 'manual' && f.categorySlug !== 'accounts' ? { stock: Number(f.stock || 1) } : {}),
        },
      });
      form.reset();
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
        <label className="field">Game<input name="game" required maxLength={80} /></label>
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
      <label className="field">Description<textarea name="description" maxLength={5000} /></label>
      {category === 'accounts' && (
        <p className="small muted">After creating an account listing, submit Original Owner Proof so buyers see it as verified instead of high risk.</p>
      )}
      {error && <div className="alert">{error}</div>}
      <button className="btn" type="submit">Create listing</button>
    </form>
  );
}
