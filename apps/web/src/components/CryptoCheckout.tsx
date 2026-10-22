import { useCallback, useEffect, useState } from 'react';
import { api, money } from '../api';
import { t } from '../i18n';

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
  status: string;
  expires_at: string | null;
  created_at: string;
}
interface Coins { owedCents: number; currency: string; coins: Array<{ coin: string; name: string; minUsd: number }> }

const STATUSES = ['waiting', 'confirming', 'confirmed', 'sending', 'partially_paid', 'finished', 'failed', 'refunded', 'expired'] as const;
const statusText = (s: string) => ((STATUSES as readonly string[]).includes(s) ? t(`crypto.status.${s as (typeof STATUSES)[number]}`) : s);
const OPEN = new Set(['waiting', 'confirming', 'confirmed', 'sending']);
const trim = (n: string) => n.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

export function CryptoCheckout({ base, amountCents, currency, onPaid }: { base: string; amountCents: number; currency: string; onPaid: () => void }) {
  const [coins, setCoins] = useState<Coins | null>(null);
  const [payments, setPayments] = useState<CryptoPayment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([api<Coins>(`${base}/crypto/coins`).catch(() => null), api<CryptoPayment[]>(`${base}/crypto/payments`)]);
    setCoins(c);
    setPayments(p);
    return p;
  }, [base]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  const open = payments.find((p) => OPEN.has(p.status));
  const underpaid = payments.find((p) => p.status === 'partially_paid');
  const paidCents = payments.filter((p) => ['partially_paid', 'finished', 'confirmed', 'sending'].includes(p.status)).reduce((s, p) => s + Math.round(Number(p.actually_paid_usd ?? 0) * 100), 0);

  // Poll the open payment every 5 s; the API asks the provider and applies what it finds.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(async () => {
      try {
        const next = await api<CryptoPayment[]>(`${base}/crypto/payments/${open.payment_id}/refresh`, { method: 'POST', body: {} });
        setPayments(next);
        const mine = next.find((p) => p.payment_id === open.payment_id);
        if (mine && (mine.status === 'finished' || (mine.status === 'partially_paid' && paidCents >= amountCents))) onPaid();
        else if (mine && mine.status === 'partially_paid') {
          const c = await api<Coins>(`${base}/crypto/coins`).catch(() => null);
          setCoins(c);
          onPaid();
        }
      } catch {
        /* keep polling */
      }
    }, 5_000);
    return () => clearInterval(t);
  }, [base, open?.payment_id, amountCents, paidCents, onPaid]);

  const pick = async (coin: string) => {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/crypto/pay`, { body: { coin } });
      await load();
    } catch (e: any) {
      setError(e.message);
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

  if (!coins && payments.length === 0) return <div className="card"><p className="muted">{error || t('crypto.loading')}</p></div>;
  const owed = coins?.owedCents ?? amountCents - paidCents;

  return (
    <div className="card stack crypto-checkout">
      <h3>{t('crypto.title')}</h3>
      {underpaid && !open && (
        <div className="alert" role="status">
          {t('crypto.underpaid', { received: money(paidCents, currency), short: money(owed, currency) })}
        </div>
      )}
      {open ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="small muted" style={{ margin: 0 }}>{t('crypto.sendExact')}</p>
          <div className="row spread"><span className="muted">{t('crypto.coin')}</span><b>{open.pay_currency_name}</b></div>
          <div className="row spread"><span className="muted">{t('crypto.amount')}</span><b className="mono" data-testid="pay-amount">{trim(open.pay_amount)} {open.pay_currency.toUpperCase().replace(/(TRC20|ERC20|BSC|SOL)$/, '')}</b></div>
          <div className="row spread" style={{ alignItems: 'start', gap: 8 }}>
            <span className="muted">{t('crypto.address')}</span>
            <code className="mono" style={{ wordBreak: 'break-all', textAlign: 'end' }} data-testid="pay-address">{open.pay_address}</code>
          </div>
          {open.pay_extra_id && <div className="row spread"><span className="muted">{t('crypto.memo')}</span><code className="mono">{open.pay_extra_id}</code></div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" type="button" onClick={() => copy(open.pay_address)}>{copied ? t('crypto.copied') : t('crypto.copyAddress')}</button>
            <button className="btn ghost" type="button" onClick={() => copy(trim(open.pay_amount))}>{t('crypto.copyAmount')}</button>
          </div>
          <p className="small" style={{ margin: 0 }}>
            <span className="chip held">{statusText(open.status)}</span>
            {open.expires_at && <span className="muted"> · {t('crypto.rateLocked', { time: new Date(open.expires_at).toLocaleTimeString() })}</span>}
          </p>
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <p className="small muted" style={{ margin: 0 }}>
            {t('crypto.toPay', { amount: money(owed, currency) })}
          </p>
          {coins && coins.coins.length === 0 && <p className="small">{t('crypto.noCoin')}</p>}
          <div className="coin-grid">
            {coins?.coins.map((c) => (
              <button key={c.coin} type="button" className="btn ghost coin-option" disabled={busy} onClick={() => pick(c.coin)}>
                <b>{c.name}</b>
                <span className="small muted">{c.coin.toUpperCase()}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {payments.filter((p) => !OPEN.has(p.status)).length > 0 && (
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>{t('crypto.history')}</summary>
          <ul className="small" style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
            {payments.map((p) => (
              <li key={p.id}>{t('crypto.historyLine', { coin: p.pay_currency_name, amount: trim(p.pay_amount), price: money(Math.round(Number(p.price_usd) * 100), 'USD'), status: statusText(p.status) })}{p.actually_paid_usd ? ` · ${t('crypto.received', { amount: money(Math.round(Number(p.actually_paid_usd) * 100), 'USD') })}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
    </div>
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
