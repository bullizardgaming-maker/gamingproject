import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CryptoCheckout } from '../components/CryptoCheckout';
import { ShieldCheck, ShoppingCart, Trash2 } from 'lucide-react';
import { api, money } from '../api';
import { useSession } from '../session';
import { GameArt } from '../components/CatalogUi';
import { clearCart, removeFromCart, setQuantity, useCart } from '@/lib/cart';
import { unitPriceFor } from '@/lib/tiers';
import { usePageMeta } from '@/lib/seo';
import type { Offer } from './Market';
import { t } from '../i18n';

/** /cart: listings from any number of sellers, one card payment, one escrow order per listing. */
export function CartPage() {
  usePageMeta({ title: t('cart.title'), noindex: true });
  const { user } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const items = useCart();
  const [offers, setOffers] = useState<Record<string, Offer | null>>({});
  const [tos, setTos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const ids = items.map((i) => i.offerId).join(',');
  useEffect(() => {
    // Fresh prices and stock every time the cart is shown; a listing that's gone shows as unavailable.
    for (const id of ids.split(',').filter(Boolean)) {
      api<Offer>(`/offers/${id}`).then((o) => setOffers((m) => ({ ...m, [id]: o }))).catch(() => setOffers((m) => ({ ...m, [id]: null })));
    }
  }, [ids]);

  const lines = items.map((i) => {
    const o = offers[i.offerId];
    const ok = !!o && (o.status ?? 'active') === 'active' && i.quantity <= o.stock && !o.shop_paused && o.seller_id !== user?.id;
    return { ...i, offer: o, ok, unit: o ? unitPriceFor(o, i.quantity) : 0 };
  });
  const groups = useMemo(() => {
    const m = new Map<string, typeof lines>();
    for (const l of lines) {
      const k = l.offer?.seller_id ?? `x-${l.offerId}`;
      m.set(k, [...(m.get(k) ?? []), l]);
    }
    return [...m.values()];
  }, [lines]);
  const payable = lines.filter((l) => l.ok);
  const currencies = new Set(payable.map((l) => l.offer!.currency));
  const total = payable.reduce((s, l) => s + l.unit * l.quantity, 0);
  const loading = items.some((i) => !(i.offerId in offers));

  const checkout = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ checkoutUrl: string | null }>('/orders/cart', {
        body: { items: payable.map((l) => ({ offerId: l.offerId, quantity: l.quantity })), acceptTos: true, currency: [...currencies][0] },
        headers: { 'Idempotency-Key': `cart:${payable.map((l) => `${l.offerId}x${l.quantity}`).join(',')}:${Math.floor(Date.now() / 60_000)}` },
      });
      for (const l of payable) removeFromCart(l.offerId);
      if (res.checkoutUrl) window.location.assign(res.checkoutUrl);
      else nav('/orders');
    } catch (e: any) {
      setError(e.code === 'kyc_required' ? t('offer.verifyFirst') : e.message);
      setBusy(false);
    }
  };

  if (!items.length)
    return (
      <div className="card stack" style={{ alignItems: 'start', maxWidth: 720 }}>
        <ShoppingCart className="size-6 text-muted-foreground" />
        <h1 style={{ fontSize: 32, margin: 0 }}>{t('cart.empty')}</h1>
        <p className="muted" style={{ margin: 0 }}>{params.get('checkout') === 'cancelled' ? t('cart.cancelled') : t('cart.empty.text')}</p>
        <Link className="btn" to="/games">{t('watch.page.browse')}</Link>
      </div>
    );

  return (
    <div className="order-layout" style={{ marginTop: 0 }}>
      <div className="stack">
        <div>
          <div className="eyebrow">{t('cart.eyebrow')}</div>
          <h1 style={{ fontSize: 40, margin: 0 }}>{t('cart.title')}</h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>{t('cart.lede')}</p>
        </div>
        {groups.map((g) => (
          <section key={g[0]!.offer?.seller_id ?? g[0]!.offerId} className="overflow-hidden rounded-xl border border-border bg-card">
            {g[0]!.offer && (
              <div className="border-b border-border px-4 py-2 text-sm">
                {t('cart.from')} <Link to={`/sellers/${g[0]!.offer.seller_id}`} className="font-medium">{g[0]!.offer.seller_name}</Link>
                <span className="muted"> · {t('cart.ownEscrow')}</span>
              </div>
            )}
            <ul className="m-0 list-none p-0">
              {g.map((l) => (
                <li key={l.offerId} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0">
                  {l.offer ? <GameArt game={l.offer.game} size="sm" className="h-10 w-14 rounded-lg" /> : <span className="h-10 w-14" />}
                  <div className="min-w-0">
                    {l.offer ? <Link to={`/offers/${l.offerId}`} className="block truncate font-medium no-underline hover:underline">{l.offer.title}</Link> : <span className="muted">{offers[l.offerId] === null ? t('cart.gone') : t('common.loading')}</span>}
                    {l.offer && (
                      <div className="text-xs text-muted-foreground">
                        {money(l.unit, l.offer.currency)} {t('cart.each')}
                        {!l.ok && <span className="text-disputed"> · {l.offer.seller_id === user?.id ? t('offer.yours') : t('cart.unavailable')}</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {l.offer && l.offer.category_kind !== 'account' && (
                      <input
                        type="number"
                        min={1}
                        max={l.offer.stock}
                        value={l.quantity}
                        aria-label={t('offer.quantity')}
                        onChange={(e) => setQuantity(l.offerId, Number(e.target.value))}
                        style={{ width: 72, height: 34, padding: '4px 8px' }}
                      />
                    )}
                    {l.offer && <span className="font-mono font-semibold" style={{ minWidth: 80, textAlign: 'end' }}>{money(l.unit * l.quantity, l.offer.currency)}</span>}
                    <button className="btn ghost" aria-label={t('cart.remove')} onClick={() => removeFromCart(l.offerId)}><Trash2 className="size-4" /></button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <button className="cursor-pointer self-start border-0 bg-transparent p-0 text-sm underline" onClick={clearCart}>{t('cart.clear')}</button>
      </div>

      <div className="card stack">
        <div className="row spread">
          <span className="muted">{t('cart.total', { count: payable.length })}</span>
          <span className="mono" style={{ fontSize: 28, fontWeight: 600 }}>{currencies.size === 1 ? money(total, [...currencies][0]) : '—'}</span>
        </div>
        <div className="notice small"><ShieldCheck className="inline size-4 text-released" /> {t('cart.escrowNote', { count: groups.length })}</div>
        <label className="row small">
          <input type="checkbox" style={{ width: 'auto' }} checked={tos} onChange={(e) => setTos(e.target.checked)} />
          {t('offer.tos')}
        </label>
        {currencies.size > 1 && <div className="alert small">{t('cart.oneCurrency')}</div>}
        {error && <div className="alert" role="alert">{error}</div>}
        {!user ? (
          <Link className="btn" to="/login?next=/cart">{t('offer.signInToBuy')}</Link>
        ) : (
          <button className="btn" disabled={!tos || busy || loading || !payable.length || currencies.size > 1} onClick={checkout}>
            {busy ? t('offer.opening') : t('offer.pay', { amount: currencies.size === 1 ? money(total, [...currencies][0]) : '' })}
          </button>
        )}
      </div>
    </div>
  );
}

/** Crypto payment for a cart checkout: one payment covers every order in it. */
export function CartPayPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [view, setView] = useState<{ checkout: { id: string; status: string; presentment_amount_cents: number; presentment_currency: string }; orders: Array<{ id: string; offer_title: string; quantity: number; seller_name: string; amount_cents: number; currency: string }> } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const v = await api<any>(`/checkouts/${id}`);
      setView(v);
      if (v.checkout.status === 'paid') nav('/orders?checkout=success', { replace: true });
    } catch (e: any) {
      setError(e.message);
    }
  }, [id, nav]);
  useEffect(() => {
    load();
  }, [load]);
  if (error) return <div className="card"><h2>Checkout not found</h2><p className="muted">{error}</p><Link to="/cart">Back to the cart</Link></div>;
  if (!view) return <p className="muted">Loading…</p>;
  const total = view.orders.reduce((s, o) => s + o.amount_cents, 0);
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div>
        <div className="eyebrow">Checkout</div>
        <h1 style={{ fontSize: 32 }}>{view.orders.length} listing{view.orders.length === 1 ? '' : 's'} · {money(total, view.orders[0]?.currency ?? 'USD')}</h1>
      </div>
      <ul className="card small" style={{ margin: 0, paddingInlineStart: 34 }}>
        {view.orders.map((o) => <li key={o.id}>{o.offer_title} × {o.quantity} · {o.seller_name} · {money(o.amount_cents, o.currency)}</li>)}
      </ul>
      <CryptoCheckout base={`/checkouts/${view.checkout.id}`} amountCents={total} currency={view.orders[0]?.currency ?? 'USD'} onPaid={load} />
    </div>
  );
}
