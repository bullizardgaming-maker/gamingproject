import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CryptoCheckout } from '../components/CryptoCheckout';
import { CharacterField, handoverFieldFor } from '../components/CharacterField';
import { ShieldCheck, ShoppingCart, Trash as Trash2 } from '@phosphor-icons/react';
import { api, money } from '../api';
import { useSession } from '../session';
import { clearCart, removeFromCart, setQuantity, useCart } from '@/lib/cart';
import { unitPriceFor } from '@/lib/tiers';
import { usePageMeta } from '@/lib/seo';
import { useTermsVersion } from '@/lib/terms';
import { TermsChanged } from '../components/TermsChanged';
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
  const [names, setNames] = useState<Record<string, { value: string; ok: boolean }>>({});
  const [busy, setBusy] = useState(false);
  const terms = useTermsVersion(); // Round 23e/23f: the version loaded with the page goes with the order
  const termsVersion = terms.version;
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
  // Games that deliver in-game need the buyer's character name on each of their lines.
  const needsName = (l: { offer: Offer | null }) => !!l.offer && !!handoverFieldFor(l.offer.game, l.offer.category_slug);
  const namesOk = payable.every((l) => !needsName(l) || names[l.offerId]?.ok);
  const currencies = new Set(payable.map((l) => l.offer!.currency));
  const total = payable.reduce((s, l) => s + l.unit * l.quantity, 0);
  const loading = items.some((i) => !(i.offerId in offers));

  const checkout = async () => {
    setBusy(true);
    setError('');
    try {
      if (!termsVersion) throw Object.assign(new Error(t('legal.reloadTerms')), { code: 'terms_stale' });
      const res = await api<{ checkoutUrl: string | null }>('/orders/cart', {
        body: { items: payable.map((l) => ({ offerId: l.offerId, quantity: l.quantity, ...(needsName(l) ? { characterName: names[l.offerId]!.value.trim() } : {}) })), acceptTos: true, currency: [...currencies][0], useCredit: true, tosVersion: termsVersion },
        headers: { 'Idempotency-Key': `cart:${payable.map((l) => `${l.offerId}x${l.quantity}`).join(',')}:${Math.floor(Date.now() / 60_000)}` },
      });
      for (const l of payable) removeFromCart(l.offerId);
      if (res.checkoutUrl) window.location.assign(res.checkoutUrl);
      else nav('/orders?checkout=success');
    } catch (e: any) {
      if (e.code === 'terms_stale') {
        // Round 23f: fetch the version now in force and ask the buyer to read and accept it.
        await terms.onStale();
        setBusy(false);
        return;
      }
      setError(e.code === 'kyc_required' ? t('offer.verifyFirst') : e.code === 'terms_reacceptance_required' ? t('legal.acceptToContinue') : e.message);
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
                  <div className="min-w-0">
                    {l.offer ? <Link to={`/offers/${l.offerId}`} className="block truncate font-medium no-underline hover:underline">{l.offer.title}</Link> : <span className="muted">{offers[l.offerId] === null ? t('cart.gone') : t('common.loading')}</span>}
                    {l.offer && (
                      <div className="text-xs text-muted-foreground">
                        {money(l.unit, l.offer.currency)} {t('cart.each')}
                        {!l.ok && <span className="text-disputed"> · {l.offer.seller_id === user?.id ? t('offer.yours') : t('cart.unavailable')}</span>}
                      </div>
                    )}
                    {l.offer && l.ok && needsName(l) && (
                      <CharacterField compact game={l.offer.game} category={l.offer.category_slug} value={names[l.offerId]?.value ?? ''} onChange={(value, ok) => setNames((m) => ({ ...m, [l.offerId]: { value, ok } }))} />
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
        <p className="small muted" style={{ margin: 0 }} data-testid="buy-agree">
          {t('offer.agree', { terms: '\u0000' }).split('\u0000')[0]}<Link to="/terms">{t('offer.agreeTerms')}</Link>{t('offer.agree', { terms: '\u0000' }).split('\u0000')[1]}
        </p>
        {currencies.size > 1 && <div className="alert small">{t('cart.oneCurrency')}</div>}
        {terms.stale && <TermsChanged busy={busy} onAccept={() => { terms.accepted(); void checkout(); }} />}
          {error && <div className="alert" role="alert">{error}</div>}
        {!user ? (
          <Link className="btn" to="/login?next=/cart">{t('offer.signInToBuy')}</Link>
        ) : (
          <button className="btn" disabled={busy || loading || !payable.length || currencies.size > 1 || !namesOk} onClick={checkout}>
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
  const [view, setView] = useState<{ checkout: { id: string; status: string; presentment_amount_cents: number; presentment_currency: string }; orders: Array<{ id: string; offer_title: string; quantity: number; seller_name: string; amount_cents: number; credit_cents?: number; charged_cents?: number; currency: string }> } | null>(null);
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
  const fromBalance = view.orders.reduce((s, o) => s + (o.credit_cents ?? 0), 0);
  const toPay = total - fromBalance;
  const cur = view.orders[0]?.currency ?? 'USD';
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div>
        <div className="eyebrow">Checkout</div>
        <h1 style={{ fontSize: 32 }}>{view.orders.length} listing{view.orders.length === 1 ? '' : 's'} · {money(toPay, cur)}</h1>
      </div>
      <div className="card small pg-rows">
        {view.orders.map((o) => <div key={o.id}><span>{o.offer_title} × {o.quantity} · {o.seller_name}</span><span className="num">{money(o.amount_cents, o.currency)}</span></div>)}
        <div><span className="muted">{t('checkout.price')}</span><span className="num">{money(total, cur)}</span></div>
        {fromBalance > 0 && <div><span className="muted">{t('checkout.fromBalance')}</span><span className="num" data-testid="from-balance">−{money(fromBalance, cur)}</span></div>}
        <div className="pg-total"><span>{t('checkout.toPay')}</span><span className="pg-price">{money(toPay, cur)}</span></div>
      </div>
      <CryptoCheckout base={`/checkouts/${view.checkout.id}`} amountCents={toPay} currency={cur} onPaid={load} />
    </div>
  );
}
