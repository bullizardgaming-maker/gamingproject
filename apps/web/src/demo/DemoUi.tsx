import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, money, session } from '../api';

/** Shown on every page of a demo build so nobody mistakes it for the live marketplace. */
export function DemoBanner() {
  const reset = async () => {
    const { resetDemo } = await import('./mock');
    resetDemo();
    session.set(null);
    window.location.assign('/');
  };
  return (
    <div className="demo-banner" role="note">
      <div className="shell row spread">
        <span>
          <b>Preview with sample data.</b> No real payments or accounts. Sign in with a demo account; verification codes are <span className="mono">123456</span>.
        </span>
        <button className="btn ghost" onClick={reset}>Reset demo</button>
      </div>
    </div>
  );
}

const ACCOUNTS = [
  { email: 'buyer@demo.test', label: 'Buyer', who: 'Pixel Pat · has orders in progress' },
  { email: 'seller@demo.test', label: 'Seller', who: 'NorthWind Keys · verified shop' },
  { email: 'admin@demo.test', label: 'Admin', who: 'Arbiter Ada · operations console' },
];

/** One-click sign-in for the demo accounts on the login page. */
export function DemoSignIn({ next }: { next: string }) {
  const nav = useNavigate();
  const [error, setError] = useState('');
  const go = async (email: string) => {
    setError('');
    try {
      const res = await api<{ token: string }>('/auth/login', { body: { email, password: 'demo-password-123' } });
      session.set(res.token);
      nav(email.startsWith('seller') ? '/sell' : email.startsWith('admin') ? '/admin' : next);
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="stack">
      <div className="eyebrow" style={{ marginBottom: 0 }}>Try it as</div>
      <div className="grid three">
        {ACCOUNTS.map((a) => (
          <button key={a.email} className="card demo-account" onClick={() => go(a.email)}>
            <b>{a.label}</b>
            <span className="small muted">{a.who}</span>
          </button>
        ))}
      </div>
      {error && <div className="alert">{error}</div>}
    </div>
  );
}

/**
 * Stand-in for the payment partner's hosted checkout page. In production the buyer is sent to the
 * partner's page and card details never touch our servers; here a button simulates a successful payment.
 */
export function DemoCheckout() {
  const { id } = useParams();
  const nav = useNavigate();
  const [order, setOrder] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/orders/${id}`).then(setOrder).catch(() => setOrder(false));
  }, [id]);

  if (order === false) return <div className="card"><h2>Checkout not found</h2><Link to="/market">Back to the market</Link></div>;
  if (!order) return <p className="muted">Opening secure checkout…</p>;

  const pay = async () => {
    setBusy(true);
    const { payDemoOrder } = await import('./mock');
    payDemoOrder(order.id);
    nav(`/orders/${order.id}`);
  };

  return (
    <div className="card stack checkout-card">
      <div className="eyebrow">Secure checkout · demo</div>
      <h2 style={{ margin: 0 }}>{order.offer_title}</h2>
      <div className="row spread">
        <span className="muted">Total</span>
        <span className="mono" style={{ fontSize: 28, fontWeight: 600 }}>{money(order.amount_cents, order.currency)}</span>
      </div>
      <div className="notice">
        In the live marketplace this page belongs to our payment partner and card details never reach us. In this preview, no card is
        needed: paying moves the money into escrow just like a real payment.
      </div>
      <div className="row">
        <button className="btn" disabled={busy} onClick={pay}>{busy ? 'Paying…' : `Pay ${money(order.amount_cents, order.currency)}`}</button>
        <Link className="btn ghost" to={`/offers/${order.offer_id}`}>Cancel</Link>
      </div>
    </div>
  );
}
