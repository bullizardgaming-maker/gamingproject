import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CircleNotch, Hourglass, Wallet } from '@phosphor-icons/react';
import QRCode from 'qrcode';
import { ApiError, api, money } from '../api';
import { t, type MessageKey } from '../i18n';
import { useDisplayCurrency, usePrice } from '@/lib/prefs';

/**
 * Crypto checkout. `base` is `/orders/<id>` or `/checkouts/<id>`; the API under it offers the
 * coins whose minimum fits what is owed, creates a payment (address + exact amount), and reports
 * status. The page polls while a payment is waiting; an underpayment shows the shortfall and
 * offers a top-up. Nothing is typed in: the buyer sends from their own wallet.
 */
export interface CryptoPayment {
  id: string;
  payment_id: string;
  pay_currency: string;
  pay_currency_name: string;
  pay_address: string;
  pay_extra_id: string | null;
  pay_amount: string;
  price_usd: string;
  actually_paid: string;
  actually_paid_usd: string | null;
  /** Network fee the buyer covers on top of the order amount. */
  fee_usd?: string;
  /** Round 25: what the invoice is priced in (USD or EUR) and that amount, plus the EUR-per-USD rate used. */
  price_currency?: string;
  price_amount?: string;
  fx_rate?: string;
  /** Round 26 (A2): what this payment means for the buyer, and the order's status. */
  state?: 'waiting' | 'confirming' | 'received_applying' | 'paid' | 'underpaid' | 'held_for_review' | 'credited_to_balance' | 'failed' | 'expired';
  order_status?: string | null;
  status: string;
  expires_at: string | null;
  created_at: string;
}
interface Coins { owedCents: number; currency: string; coins: Array<{ coin: string; name: string; minUsd: number; available?: boolean; network?: string; fee_cents?: number; total_cents?: number }> }
/** GET /payment-methods (Round 25, B5): only Crypto for the beta; more methods appear when they are enabled. */
interface PaymentMethod { id: string; currencies: string[]; enabled: boolean; pay_currency?: string }
/** POST …/fx-quote: the price in a currency, held until `lockedUntil`. */
interface FxQuote { currency: string; rate: string | number; amountCents: number; usdCents: number; lockedUntil: string; fresh?: boolean }

const STATUSES = ['waiting', 'confirming', 'confirmed', 'sending', 'partially_paid', 'finished', 'failed', 'refunded', 'expired'] as const;
const statusText = (s: string) => ((STATUSES as readonly string[]).includes(s) ? t(`crypto.status.${s as (typeof STATUSES)[number]}`) : s);
const OPEN = new Set(['waiting', 'confirming', 'confirmed', 'sending']);
const trim = (n: string) => n.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Checkout payment (Round 25): first the payment method (from GET /payment-methods; only Crypto now), then what
 * the crypto invoice is priced in (USD or EUR; EGP viewers pay a USD invoice), then the coin. `base` is
 * `/orders/<id>` or `/checkouts/<id>` (a cart is quoted as one; a single order inside it is never re-quoted).
 * An EUR price is held 15 minutes; if it lapsed, the API answers 409 fx_quote_expired with the new price, which
 * the buyer confirms before paying. A provider outage shows its message and a Retry, never an endless "Loading".
 */
export function CryptoCheckout({ base, amountCents, currency, onPaid }: { base: string; amountCents: number; currency: string; onPaid: () => void }) {
  const viewer = useDisplayCurrency();
  const nav = useNavigate();
  const [coins, setCoins] = useState<Coins | null>(null);
  const [payments, setPayments] = useState<CryptoPayment[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [method, setMethod] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<'USD' | 'EUR' | null>(null);
  const [quote, setQuote] = useState<FxQuote | null>(null);
  /** A lapsed EUR price came back with a new amount: the buyer confirms it before the coin is charged. */
  const [requote, setRequote] = useState<{ coin: string; quote: FxQuote } | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [m, p, c] = await Promise.all([
        api<PaymentMethod[]>(`/payment-methods?currency=${viewer}`),
        api<CryptoPayment[]>(`${base}/crypto/payments`),
        api<Coins>(`${base}/crypto/coins`),
      ]);
      setMethods(m.filter((x) => x.enabled));
      setPayments(p);
      setCoins(c);
      return p;
    } catch (e: any) {
      // 503 payment_provider_unavailable (Round 25): the provider is down or slow; say so and offer Retry.
      setLoadError(e?.code === 'payment_provider_unavailable' || e?.status === 503 ? t('crypto.unavailable') : e.message || t('crypto.unavailable'));
      return null;
    }
  }, [base, viewer]);

  useEffect(() => {
    void load();
  }, [load]);

  const list = payments ?? [];
  const stateOf = (p: CryptoPayment) => p.state ?? (p.status === 'partially_paid' ? 'underpaid' : p.status === 'finished' ? 'received_applying' : OPEN.has(p.status) ? 'waiting' : p.status === 'refunded' ? 'failed' : (p.status as CryptoPayment['state']));
  const open = list.find((p) => OPEN.has(p.status) && !['received_applying', 'paid', 'held_for_review', 'credited_to_balance'].includes(stateOf(p)!));
  const underpaid = list.find((p) => stateOf(p) === 'underpaid');
  // Round 26 (A4): the money has arrived: never fall back to the coin list or a blank card while the order catches up.
  const latest = list[0] ? [...list].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : undefined;
  const received = list.find((p) => stateOf(p) === 'received_applying' || stateOf(p) === 'paid');
  const held = list.find((p) => stateOf(p) === 'held_for_review');
  const credited = list.find((p) => stateOf(p) === 'credited_to_balance');
  const lapsed = !open && latest && (stateOf(latest) === 'failed' || stateOf(latest) === 'expired') ? stateOf(latest) : null;
  const paidCents = list.filter((p) => ['partially_paid', 'finished', 'confirmed', 'sending'].includes(p.status)).reduce((s, p) => s + Math.round(Number(p.actually_paid_usd ?? 0) * 100), 0);

  // Received (or held for a person): keep asking about the payment and reloading the order until it is funded.
  const settling = received ?? held;
  useEffect(() => {
    if (!settling || open) return;
    const every = held && !received ? 15_000 : 3_000;
    const timer = setInterval(async () => {
      try {
        const next = await api<CryptoPayment[]>(`${base}/crypto/payments/${settling.payment_id}/refresh`, { method: 'POST', body: {} });
        setPayments(next);
      } catch {
        /* keep asking */
      }
      onPaid(); // the order page reloads the order; once it is paid this checkout gives way to the paid order
    }, every);
    return () => clearInterval(timer);
  }, [base, settling?.payment_id, !!open, !!held, !!received, onPaid]);

  // Poll the open payment every 5 s; the API asks the provider and applies what it finds.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(async () => {
      try {
        const next = await api<CryptoPayment[]>(`${base}/crypto/payments/${open.payment_id}/refresh`, { method: 'POST', body: {} });
        setPayments(next);
        const mine = next.find((p) => p.payment_id === open.payment_id);
        if (mine && (mine.status === 'finished' || (mine.status === 'partially_paid' && paidCents >= amountCents))) onPaid();
        else if (mine && mine.status === 'partially_paid') {
          const c = await api<Coins>(`${base}/crypto/coins`).catch(() => null);
          if (c) setCoins(c);
          onPaid();
        }
      } catch {
        /* keep polling */
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [base, open?.payment_id, amountCents, paidCents, onPaid]);

  const crypto = methods?.find((m) => m.id === 'crypto');
  // EGP (or any viewer the method doesn't price in) gets the method's pay currency: USD.
  const invoiceChoices = (crypto?.currencies.filter((c) => c === 'USD' || c === 'EUR') ?? ['USD']) as Array<'USD' | 'EUR'>;
  const offered = invoiceChoices.includes(viewer as 'USD' | 'EUR') ? invoiceChoices : (['USD'] as const).filter((c) => invoiceChoices.includes(c));

  const chooseInvoice = async (c: 'USD' | 'EUR') => {
    setError('');
    setInvoice(c);
    setQuote(null);
    if (c === 'USD') return;
    setBusy(true);
    try {
      setQuote(await api<FxQuote>(`${base}/fx-quote`, { body: { currency: c } }));
    } catch (e: any) {
      // Round 25b: an order inside a cart is quoted and paid through its checkout only (409 use_checkout).
      if (e?.code === 'use_checkout' && e.details?.checkoutId) return nav(`/checkouts/${e.details.checkoutId}/pay`, { replace: true });
      setError(e?.code === 'use_checkout' ? t('crypto.useCheckout') : e.message);
      setInvoice(null);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (coin: string) => {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/crypto/pay`, { body: { coin, priceCurrency: invoice ?? 'USD' } });
      setRequote(null);
      await load();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'fx_quote_expired' && e.details) {
        const q = e.details as FxQuote;
        setQuote(q);
        setRequote({ coin, quote: q });
      } else if (e?.code === 'use_checkout' && e.details?.checkoutId) nav(`/checkouts/${e.details.checkoutId}/pay`, { replace: true });
      else setError(e?.code === 'payment_provider_unavailable' ? t('crypto.unavailable') : e?.code === 'use_checkout' ? t('crypto.useCheckout') : e.message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the address is selectable */
    }
  };

  if (loadError && !payments) {
    return (
      <div className="card stack" data-testid="pay-error">
        <div className="alert" role="alert">{loadError}</div>
        <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => void load()}>{t('crypto.retry')}</button>
      </div>
    );
  }
  if (!payments || !methods) return <div className="card"><p className="muted">{t('crypto.loading')}</p></div>;
  const owed = coins?.owedCents ?? amountCents - paidCents;
  const ticker = (code: string) => code.toUpperCase().replace(/(.+)(TRC20|ERC20|BSC|SOL)$/, '$1');
  const invoiceAmount = (p: CryptoPayment) => (p.price_currency && p.price_currency !== 'USD' && p.price_amount ? money(Math.round(Number(p.price_amount) * 100), p.price_currency) : money(Math.round(Number(p.price_usd) * 100), 'USD'));

  return (
    <div className="crypto-checkout pg-pay">
      <h2 className="sr-only">{t('crypto.title')}</h2>
      {received && !open ? (
        <div className="card pay-state" role="status" aria-live="polite" data-testid="pay-confirming">
          <span className="pay-state-icon is-ok" aria-hidden><CircleNotch className="size-6 auth-spin" /></span>
          <h3>{t('pay26.confirming')}</h3>
          <p className="small muted">{t('pay26.confirmingText')}</p>
        </div>
      ) : held && !open ? (
        <div className="card pay-state" role="status" aria-live="polite" data-testid="pay-held">
          <span className="pay-state-icon is-held" aria-hidden><Hourglass className="size-6" /></span>
          <h3>{t('pay26.held')}</h3>
          <p className="small muted">{t('pay26.heldText')}</p>
          <Link className="btn ghost sm" to="/support/new">{t('pay26.contactSupport')}</Link>
        </div>
      ) : credited && !open ? (
        <div className="card pay-state" role="status" aria-live="polite" data-testid="pay-credited">
          <span className="pay-state-icon is-ok" aria-hidden><Wallet className="size-6" /></span>
          <h3>{t('pay26.credited', { amount: money(Math.round(Number(credited.actually_paid_usd ?? credited.price_usd) * 100), 'USD') })}</h3>
          <p className="small muted">{t('pay26.creditedText')}</p>
          <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
            <Link className="btn sm" to="/wallet">{t('pay26.seeBalance')}</Link>
            <Link className="btn ghost sm" to="/support/new">{t('pay26.contactSupport')}</Link>
          </div>
        </div>
      ) : (
      <>
      {lapsed && (
        <div className="alert" role="status" data-testid="pay-lapsed">{lapsed === 'expired' ? t('pay26.expired') : t('pay26.failed')}</div>
      )}
      {underpaid && !open && (
        <div className="alert" role="status">
          {t('crypto.underpaid', { received: money(paidCents, currency), short: money(owed, currency) })}
        </div>
      )}
      {open ? (
        <div className="card pg-qr-card">
          <QrBox text={open.pay_address} />
          <div className="pg-qr-info">
            <div className="row spread">
              <span className="small muted">{t('crypto.sendExactly')}</span>
              <span className="chip held">{statusText(open.status)}{open.expires_at ? ` · ${t('crypto.rateLocked', { time: hm(open.expires_at) })}` : ''}</span>
            </div>
            <b className="pg-pay-amount num" data-testid="pay-amount">{trim(open.pay_amount)} {ticker(open.pay_currency)}</b>
            <span className="small muted">{t('crypto.onNetwork', { network: open.pay_currency_name })}</span>
            {open.price_currency && open.price_currency !== 'USD' ? (
              <span className="small muted num" data-testid="pay-breakdown">{t('crypto.invoiceIn', { amount: invoiceAmount(open) })}</span>
            ) : Number(open.fee_usd) > 0 && (
              <span className="small muted num" data-testid="pay-breakdown">
                {t('crypto.breakdown', { price: money(Math.round(Number(open.price_usd) * 100), 'USD'), fee: money(Math.round(Number(open.fee_usd) * 100), 'USD'), total: money(Math.round((Number(open.price_usd) + Number(open.fee_usd)) * 100), 'USD') })}
              </span>
            )}
            <div className="pg-addr">
              <code className="num" data-testid="pay-address">{open.pay_address}</code>
              <button className="btn ghost sm" type="button" onClick={() => copy(open.pay_address)}>{copied ? t('crypto.copied') : t('crypto.copyAddress')}</button>
            </div>
            {open.pay_extra_id && <div className="pg-addr"><span className="small muted">{t('crypto.memo')}</span><code className="num">{open.pay_extra_id}</code></div>}
            <button className="btn ghost sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => copy(trim(open.pay_amount))}>{t('crypto.copyAmount')}</button>
            <p className="small muted" style={{ margin: 0 }}>{t('crypto.sendExact')}</p>
          </div>
        </div>
      ) : !method ? (
        <MethodStep methods={methods} owed={owed} onPick={(id) => { setMethod(id); if (offered.length === 1) void chooseInvoice(offered[0]!); }} />
      ) : !invoice || (invoice === 'EUR' && !quote) ? (
        <InvoiceStep choices={offered} owed={owed} busy={busy} onPick={chooseInvoice} onBack={() => setMethod(null)} />
      ) : (
        <CoinStep
          coins={coins}
          due={invoice === 'EUR' && quote ? money(quote.amountCents, 'EUR') : money(owed, 'USD')}
          heldUntil={invoice === 'EUR' && quote ? quote.lockedUntil : null}
          usd={invoice === 'USD'}
          busy={busy}
          onPick={pick}
          onBack={() => (offered.length > 1 ? (setInvoice(null), setQuote(null)) : setMethod(null))}
          coinsError={!coins ? loadError : ''}
          onRetry={() => void load()}
        />
      )}
      </>
      )}
      {requote && (
        <div className="notice stack" role="alertdialog" aria-labelledby="requote-title" data-testid="fx-requote" style={{ gap: 8 }}>
          <b id="requote-title">{t('crypto.newPrice', { amount: money(requote.quote.amountCents, requote.quote.currency) })}</b>
          <span className="small">{t('crypto.newPriceText', { time: hm(requote.quote.lockedUntil) })}</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void pick(requote.coin)}>{t('crypto.payNewPrice')}</button>
            <button type="button" className="btn ghost" onClick={() => setRequote(null)}>{t('crypto.notNow')}</button>
          </div>
        </div>
      )}
      {list.filter((p) => !OPEN.has(p.status)).length > 0 && (
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>{t('crypto.history')}</summary>
          <ul className="small" style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
            {list.map((p) => (
              <li key={p.id}>{t('crypto.historyLine', { coin: p.pay_currency_name, amount: trim(p.pay_amount), price: invoiceAmount(p), status: statusText(p.status) })}{p.actually_paid_usd ? ` · ${t('crypto.received', { amount: money(Math.round(Number(p.actually_paid_usd) * 100), 'USD') })}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
    </div>
  );
}

const METHOD_TEXT: Record<string, { name: MessageKey; text: MessageKey; sym: string }> = {
  crypto: { name: 'pay.crypto', text: 'pay.cryptoText', sym: '₿' },
};

/** Step 1: how to pay. Built for more methods later (e.g. a local wallet in EGP); only enabled ones are listed. */
function MethodStep({ methods, owed, onPick }: { methods: PaymentMethod[]; owed: number; onPick: (id: string) => void }) {
  const price = usePrice();
  return (
    <div className="card pg-coins">
      <div className="row spread">
        <h3 style={{ margin: 0 }}>{t('pay.chooseMethod')}</h3>
        <span className="small muted num">{t('crypto.toPayShort', { amount: price(owed) })}</span>
      </div>
      {methods.length === 0 ? (
        <p className="small" role="status">{t('pay.noMethod')}</p>
      ) : (
        <div className="pg-coin-list">
          {methods.map((m) => {
            const meta = METHOD_TEXT[m.id];
            return (
              <button key={m.id} type="button" className="pg-coin" onClick={() => onPick(m.id)} data-testid={`method-${m.id}`}>
                <span className="pg-sym" aria-hidden>{meta?.sym ?? m.id.slice(0, 2).toUpperCase()}</span>
                <span className="min-w-0 flex-1"><b className="block">{meta ? t(meta.name) : m.id}</b>{meta && <span className="small muted">{t(meta.text)}</span>}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Step 2 (crypto): what the invoice is priced in. EGP viewers skip this: their invoice is in USD. */
function InvoiceStep({ choices, owed, busy, onPick, onBack }: { choices: ReadonlyArray<'USD' | 'EUR'>; owed: number; busy: boolean; onPick: (c: 'USD' | 'EUR') => void; onBack: () => void }) {
  return (
    <div className="card pg-coins">
      <div className="row spread">
        <h3 style={{ margin: 0 }}>{t('pay.invoiceCurrency')}</h3>
        <button type="button" className="btn ghost sm" onClick={onBack}>{t('pay.back')}</button>
      </div>
      <div className="pg-coin-list">
        {choices.map((c) => (
          <button key={c} type="button" className="pg-coin" disabled={busy} onClick={() => onPick(c)} data-testid={`invoice-${c}`}>
            <span className="pg-sym" aria-hidden>{c === 'EUR' ? '€' : '$'}</span>
            <span className="min-w-0 flex-1"><b className="block">{c}</b><span className="small muted">{c === 'USD' ? money(owed, 'USD') : t('pay.eurText')}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Step 3: the coin. Amounts are in the invoice currency; network fees are estimates in USD. */
function CoinStep({ coins, due, heldUntil, usd, busy, onPick, onBack, coinsError, onRetry }: { coins: Coins | null; due: string; heldUntil: string | null; usd: boolean; busy: boolean; onPick: (coin: string) => void; onBack: () => void; coinsError: string; onRetry: () => void }) {
  const ticker = (code: string) => code.toUpperCase().replace(/(.+)(TRC20|ERC20|BSC|SOL)$/, '$1');
  return (
    <div className="card pg-coins">
      <div className="row spread">
        <h3 style={{ margin: 0 }}>{t('crypto.chooseCoin')}</h3>
        <span className="small muted num" data-testid="pay-due">{t('crypto.toPayShort', { amount: due })}{heldUntil ? ` · ${t('pay.heldUntil', { time: hm(heldUntil) })}` : ''}</span>
      </div>
      <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>{t('pay.back')}</button>
      {coinsError ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="alert" role="alert">{coinsError}</div>
          <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={onRetry}>{t('crypto.retry')}</button>
        </div>
      ) : (
        <>
          {coins && !coins.coins.some((c) => c.available !== false) && <p className="small">{t('crypto.noCoin')}</p>}
          <div className="pg-coin-list">
            {coins?.coins.map((c) => {
              const off = c.available === false;
              return (
                <button key={c.coin} type="button" className={`pg-coin${off ? ' off' : ''}`} disabled={busy || off} aria-disabled={off || undefined} onClick={() => onPick(c.coin)} title={off ? t('crypto.tooSmall', { amount: money(Math.round(c.minUsd * 100), 'USD') }) : undefined}>
                  <span className="pg-sym" aria-hidden>{ticker(c.coin).slice(0, 4)}</span>
                  <span className="min-w-0 flex-1">
                    <b className="block">{c.name}{c.network && !c.name.includes('(') && c.network !== c.name && !c.name.startsWith(c.network) && <span className="pg-net">{c.network}</span>}</b>
                    <span className="small muted">{off ? t('crypto.tooSmall', { amount: money(Math.round(c.minUsd * 100), 'USD') }) : c.fee_cents != null ? t('crypto.feeLine', { fee: money(c.fee_cents, 'USD') }) : t('crypto.minimum', { amount: money(Math.round(c.minUsd * 100), 'USD') })}</span>
                  </span>
                  {usd && !off && c.total_cents != null && <b className="pg-coin-total num">{money(c.total_cents, 'USD')}</b>}
                </button>
              );
            })}
          </div>
          <p className="small muted" style={{ margin: 0 }}>{t('crypto.feeNote')}</p>
        </>
      )}
    </div>
  );
}

/** QR code for the deposit address (drawn locally, nothing leaves the page). */
function QrBox({ text }: { text: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { margin: 1, width: 296, color: { dark: '#0d131c', light: '#ffffff' } }).then((u) => live && setSrc(u)).catch(() => {});
    return () => { live = false; };
  }, [text]);
  return <div className="pg-qr">{src && <img src={src} width={148} height={148} alt={t('crypto.qrAlt')} />}</div>;
}

/** Checkout steps: Confirm → Pay → Order. */
export function CheckoutSteps({ step }: { step: 1 | 2 | 3 }) {
  const labels = [t('checkout.step.confirm'), t('checkout.step.pay'), t('checkout.step.order')];
  return (
    <ol className="pg-stepper" aria-label={t('checkout.steps')}>
      {labels.map((l, i) => (
        <li key={l} className={i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''} aria-current={i + 1 === step ? 'step' : undefined}>
          <i aria-hidden>{i + 1 < step ? '✓' : i + 1}</i>{l}
        </li>
      ))}
    </ol>
  );
}

/** After a refund is decided on a crypto order, the buyer tells us where to send it. */
export function RefundAddressForm({ orderId, refund, coins, onDone }: { orderId: string; refund: { amount_cents: number; currency: string; status: string; refund_address: string | null; refund_currency: string | null; tx_hash: string | null }; coins: Array<{ coin: string; name: string }>; onDone: () => void }) {
  const [address, setAddress] = useState('');
  const [coin, setCoin] = useState(coins[0]?.coin ?? 'usdttrc20');
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api(`/orders/${orderId}/refund-address`, { method: 'PUT', body: { address, currency: coin } });
      onDone();
    } catch (err: any) {
      setError(err.message);
    }
  };
  return (
    <div className="card stack">
      <h3>{t('crypto.refund.title', { amount: money(refund.amount_cents, refund.currency) })}</h3>
      {refund.status === 'sent' ? (
        <p className="small">
          {t('crypto.refund.sent', { address: '\u0000', tx: '\u0001' }).split(/[\u0000\u0001]/)[0]}
          <code className="mono">{refund.refund_address}</code>
          {t('crypto.refund.sent', { address: '\u0000', tx: '\u0001' }).split(/[\u0000\u0001]/)[1]}
          <code className="mono" style={{ wordBreak: 'break-all' }}>{refund.tx_hash}</code>
          {t('crypto.refund.sent', { address: '\u0000', tx: '\u0001' }).split(/[\u0000\u0001]/)[2]}
        </p>
      ) : refund.status === 'pending' ? (
        <p className="small muted" style={{ margin: 0 }}>
          {t('crypto.refund.pending', { address: '\u0000', coin: refund.refund_currency?.toUpperCase() ?? '' }).split('\u0000')[0]}
          <code className="mono">{refund.refund_address}</code>
          {t('crypto.refund.pending', { address: '\u0000', coin: refund.refund_currency?.toUpperCase() ?? '' }).split('\u0000')[1]}
        </p>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="small muted" style={{ margin: 0 }}>{t('crypto.refund.text')}</p>
          <label className="field">{t('crypto.coin')}
            <select value={coin} onChange={(e) => setCoin(e.target.value)}>{coins.map((c) => <option key={c.coin} value={c.coin}>{c.name}</option>)}</select>
          </label>
          <label className="field">{t('crypto.address')}
            <input value={address} onChange={(e) => setAddress(e.target.value)} required minLength={10} maxLength={128} placeholder={t('crypto.refund.placeholder')} />
          </label>
          {error && <div className="alert" role="alert">{error}</div>}
          <button className="btn" type="submit">{t('crypto.refund.send')}</button>
        </form>
      )}
    </div>
  );
}

export const REFUND_COINS = [
  { coin: 'usdttrc20', name: 'Tether (TRC-20)' }, { coin: 'usdterc20', name: 'Tether (ERC-20)' }, { coin: 'usdtbsc', name: 'Tether (BEP-20)' },
  { coin: 'usdcerc20', name: 'USD Coin (ERC-20)' }, { coin: 'btc', name: 'Bitcoin' }, { coin: 'eth', name: 'Ethereum' }, { coin: 'ltc', name: 'Litecoin' }, { coin: 'trx', name: 'TRON' },
];
