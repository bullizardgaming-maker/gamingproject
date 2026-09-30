import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, money } from '../api';
import { useSession } from '../session';
import { OfferBadges, type Offer } from './Market';

export function OfferPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useSession();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [qty, setQty] = useState(1);
  const [rail, setRail] = useState<'fiat' | 'crypto'>('fiat');
  const [wallet, setWallet] = useState('');
  const [tos, setTos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Offer>(`/offers/${id}`).then(setOffer).catch((e) => setError(e.message));
  }, [id]);

  if (!offer) return <p className="muted">{error || 'Loading…'}</p>;
  const isAccount = offer.category_kind === 'account';
  const total = offer.price_cents * qty;
  const own = user?.id === offer.seller_id;

  const buy = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ order: { id: string }; checkoutUrl: string | null }>('/orders', {
        body: { offerId: offer.id, quantity: qty, rail, acceptTos: true, ...(rail === 'crypto' ? { walletAddress: wallet } : {}) },
        headers: { 'Idempotency-Key': `${offer.id}:${qty}:${rail}:${Math.floor(Date.now() / 60_000)}` },
      });
      if (res.checkoutUrl) window.location.assign(res.checkoutUrl);
      else nav(`/orders/${res.order.id}`);
    } catch (e: any) {
      setError(e.code === 'kyc_required' ? 'Verify your email and phone number before buying.' : e.message);
      setBusy(false);
    }
  };

  const ask = async () => {
    const room = await api<{ id: string }>('/chat/rooms', { body: { offerId: offer.id } });
    nav(`/chat/${room.id}`);
  };

  return (
    <div className="order-layout">
      <div className="stack">
        <div className="eyebrow">{offer.game}</div>
        <h1 style={{ fontSize: 40 }}>{offer.title}</h1>
        <OfferBadges offer={offer} />
        <p style={{ whiteSpace: 'pre-wrap' }}>{offer.description || <span className="muted">The seller has not added a description.</span>}</p>
        <p className="small muted">
          Sold by <b>{offer.seller_name}</b> · {offer.seller_completed_orders} completed orders · identity verified
        </p>
        {offer.high_risk_secondary && (
          <div className="alert">
            This account has no verified Original Owner Proof. It may have changed hands before, which raises the risk that a previous
            owner recovers it. Escrow and the 14-day insurance still apply.
          </div>
        )}
      </div>

      <div className="card stack">
        <div className="row spread">
          <span className="mono" style={{ fontSize: 28, fontWeight: 600 }}>{money(total, offer.currency)}</span>
          <span className="small muted">{offer.stock} available</span>
        </div>
        {!isAccount && (
          <label className="field">
            Quantity
            <input type="number" min={1} max={offer.stock} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} />
          </label>
        )}
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted" style={{ marginBottom: 8 }}>Pay with</legend>
          <label className="row"><input type="radio" style={{ width: 'auto' }} checked={rail === 'fiat'} onChange={() => setRail('fiat')} /> Card (hosted secure checkout)</label>
          <label className="row"><input type="radio" style={{ width: 'auto' }} checked={rail === 'crypto'} onChange={() => setRail('crypto')} /> USDC / USDT (on-chain escrow contract)</label>
          {rail === 'crypto' && (
            <label className="field">
              Your wallet address
              <input className="mono" placeholder="0x…" value={wallet} onChange={(e) => setWallet(e.target.value.trim())} />
            </label>
          )}
        </fieldset>
        <div className="notice">
          Your payment is held in escrow. The seller is paid after {isAccount ? 'the 14-day insurance period' : 'the 72-hour inspection window'} or when
          you confirm, whichever comes first.
        </div>
        <label className="row small">
          <input type="checkbox" style={{ width: 'auto' }} checked={tos} onChange={(e) => setTos(e.target.checked)} />
          I accept the Terms of Service, including that all communication for this order stays in the order chat.
        </label>
        {error && <div className="alert">{error} {error.includes('Verify') && <Link to="/account">Verify now</Link>}</div>}
        {!user ? (
          <Link className="btn" to={`/login?next=/offers/${offer.id}`}>Sign in to buy</Link>
        ) : own ? (
          <p className="muted small">This is your listing.</p>
        ) : (
          <div className="row">
            <button className="btn" disabled={!tos || busy || offer.stock < qty || (rail === 'crypto' && !/^0x[0-9a-fA-F]{40}$/.test(wallet))} onClick={buy}>
              {busy ? 'Opening checkout…' : `Pay ${money(total, offer.currency)} into escrow`}
            </button>
            <button className="btn ghost" onClick={ask}>Ask the seller</button>
          </div>
        )}
      </div>
    </div>
  );
}
