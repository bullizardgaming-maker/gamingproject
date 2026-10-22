import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, FileText, Lock, ReceiptText } from 'lucide-react';
import { api, download, money } from '../api';
import { useSession } from '../session';
import { cn } from '@/lib/utils';
import { t, type MessageKey } from '../i18n';

interface Hold {
  level: string;
  holdDays: number;
  currency: string;
  availableCents: number;
  heldCents: number;
  withdrawableCents: number;
  /** unlocksAt null: held until a warranty claim is settled. */
  upcoming: Array<{ unlocksAt: string | null; cents: number }>;
}
interface TaxProfile {
  country: string | null;
  isBusiness: boolean;
  taxId: string | null;
  taxIdVerified: boolean;
  billingAddress: string | null;
  commissionTax: { country: string; treatment: 'standard' | 'reverse_charge' | 'outside_scope'; rateBps: number; note?: string };
}

const CURRENCIES = ['USD', 'EUR', 'EGP'];
const holdLabel = (level: string) => (['new', 'established', 'trusted', 'watch', 'custom'].includes(level) ? t(`money.hold.${level}` as MessageKey) : level);
const COUNTRIES: Array<[string, string]> = [
  ['AT', 'Austria'], ['BE', 'Belgium'], ['BG', 'Bulgaria'], ['HR', 'Croatia'], ['CY', 'Cyprus'], ['CZ', 'Czechia'], ['DK', 'Denmark'],
  ['EE', 'Estonia'], ['FI', 'Finland'], ['FR', 'France'], ['DE', 'Germany'], ['GR', 'Greece'], ['HU', 'Hungary'], ['IE', 'Ireland'],
  ['IT', 'Italy'], ['LV', 'Latvia'], ['LT', 'Lithuania'], ['LU', 'Luxembourg'], ['MT', 'Malta'], ['NL', 'Netherlands'], ['PL', 'Poland'],
  ['PT', 'Portugal'], ['RO', 'Romania'], ['SK', 'Slovakia'], ['SI', 'Slovenia'], ['ES', 'Spain'], ['SE', 'Sweden'],
  ['GB', 'United Kingdom'], ['NO', 'Norway'], ['CH', 'Switzerland'], ['US', 'United States'], ['CA', 'Canada'], ['AU', 'Australia'],
  ['NZ', 'New Zealand'], ['BR', 'Brazil'], ['MX', 'Mexico'], ['TR', 'Türkiye'], ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'],
  ['EG', 'Egypt'], ['IN', 'India'], ['JP', 'Japan'], ['KR', 'South Korea'], ['SG', 'Singapore'], ['PH', 'Philippines'], ['ZA', 'South Africa'],
];
const TREATMENT_TEXT = {
  standard: (rate: number, c: string) => t('money.tax.standard', { rate: (rate / 100).toFixed(2), country: c }),
  reverse_charge: () => t('money.tax.reverse'),
  outside_scope: () => t('money.tax.outside'),
};

const first = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const fmtDate = (d: string) => new Date(d).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

export function SellerMoney() {
  const { user } = useSession();
  const [dash, setDash] = useState<any>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [tax, setTax] = useState<TaxProfile | null>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [credits, setCredits] = useState<any[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);
  const [sales, setSales] = useState<any[]>([]);
  const [withdrawals, setWithdrawals] = useState<any[]>([]);

  const load = useCallback(async () => {
    api<any[]>('/orders?as=seller').then(setSales).catch(() => {});
    api<any[]>('/seller/withdrawals').then(setWithdrawals).catch(() => {});
    const [d, h, t, inv, cn] = await Promise.all([
      api('/seller/dashboard'),
      api<Hold>('/seller/payout-hold'),
      api<TaxProfile>('/seller/tax-profile'),
      api<any[]>('/seller/invoices'),
      api<any[]>('/seller/credit-notes'),
    ]);
    setDash(d);
    setHold(h);
    setTax(t);
    setInvoices(inv);
    setCredits(cn);
  }, []);
  useEffect(() => {
    load().catch((e) => setMsg({ kind: 'alert', text: e.message }));
  }, [load]);

  if (!dash || !hold || !tax) return <p className="muted">{msg?.text ?? t('money.loading')}</p>;
  const currency: string = dash.payoutCurrency ?? 'USD';
  const others = (dash.allBalances ?? []).filter((b: any) => b.currency !== currency);
  const withdrawn = withdrawals.filter((w) => w.status === 'paid' && w.currency === currency).reduce((s, w) => s + Number(w.amount_cents), 0);
  const history: HistoryRow[] = [
    ...sales
      .filter((o) => ['paid', 'delivered', 'completed', 'disputed'].includes(o.status))
      .map((o) => ({ id: o.id, at: o.created_at, what: `${o.ref ?? ''}${o.ref ? ' · ' : ''}${o.offer_title}`, href: `/orders/${o.id}`, state: (o.status === 'completed' ? 'released' : o.status === 'disputed' ? 'disputed' : 'held') as HistoryRow['state'], cents: Number(o.seller_net_cents ?? o.amount_cents), currency: o.currency, sign: 1 })),
    ...withdrawals.map((w) => ({ id: w.id, at: w.created_at, what: `${t('wallet.withdrawal')}${w.destination_currency ? ` · ${String(w.destination_currency).toUpperCase()}` : ''}`, state: (w.status === 'paid' ? 'sent' : ['failed', 'rejected'].includes(w.status) ? 'failed' : 'pending') as HistoryRow['state'], label: t(WSTATUS[w.status] ?? 'money.wstatus.pending'), cents: Number(w.amount_cents), currency: w.currency, sign: -1 })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'ok', text: ok });
      await load();
    } catch (e: any) {
      setMsg({ kind: 'alert', text: e.message });
    }
  };

  return (
    <div className="stack">
      {msg && <div className={msg.kind}>{msg.text}</div>}
      {(dash.debts ?? []).map((d: any) => (
        <DebtCard key={d.id} debt={d} onError={(text) => setMsg({ kind: 'alert', text })} />
      ))}

      <div className="pg-wallet-cards">
        <div className="card pg-bal">
          <span className="small muted">{t('wallet.available')}</span>
          <span className="pg-big">{money(hold.withdrawableCents, currency)}</span>
          {hold.heldCents > 0 && <span className="chip held" style={{ alignSelf: 'flex-start' }}><Lock className="size-3" aria-hidden /> {t('wallet.unlocking', { amount: money(hold.heldCents, currency) })}</span>}
        </div>
        <div className="card pg-bal">
          <span className="small muted">{t('money.inEscrow')}</span>
          <span className="pg-big muted">{money(dash.balances.pendingEscrowCents, 'USD')}</span>
        </div>
        <div className="card pg-bal">
          <span className="small muted">{t('wallet.withdrawn')}</span>
          <span className="pg-big muted">{money(withdrawn, currency)}</span>
        </div>
      </div>

      <div className="pg-split">
        <section className="pg-history" aria-labelledby="wallet-history">
          <h2 id="wallet-history" className="pg-label">{t('wallet.history')}</h2>
          <WalletHistory rows={history} currency={currency} />
          <p className="small muted" style={{ margin: 0 }}>
            {hold.holdDays > 0 ? t('money.holdText', { level: holdLabel(hold.level), count: hold.holdDays }) : t('money.noHold')}
          </p>
          {hold.upcoming.length > 0 && (
            <div className="small">
              {hold.upcoming.slice(0, 4).map((u) => (
                <div key={u.unlocksAt ?? 'claim'} className="row spread" style={{ borderTop: '1px solid var(--rule)', padding: '6px 0' }}>
                  <span className="muted">{u.unlocksAt ? t('money.unlocks', { date: fmtDate(u.unlocksAt) }) : t('money.unlocksClaim')}</span>
                  <span className="num">{money(u.cents, currency)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="card pg-withdraw" aria-labelledby="wallet-withdraw">
          <div className="row spread">
            <h2 id="wallet-withdraw" className="h3" style={{ margin: 0, fontSize: 19 }}>{t('money.withdraw')}</h2>
            <label className="row small" style={{ gap: 8 }}>
              {t('money.paidOutIn')}
              <select
                aria-label={t('money.payoutCurrency')}
                value={currency}
                style={{ width: 90, height: 36, padding: '0 8px' }}
                onChange={(e) => run(() => api('/seller/payout-currency', { method: 'PUT', body: { currency: e.target.value } }), t('money.currencyChanged', { currency: e.target.value }))}
              >
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          </div>
          <Withdraw
            currency={currency}
            max={hold.withdrawableCents}
            disabled={!user?.payouts_enabled || dash.withdrawalsFrozen}
            onWithdraw={(cents) => run(() => api('/seller/withdrawals', { body: { amountCents: cents, currency } }), t('money.onItsWay', { amount: money(cents, currency) }))}
          />
          {!user?.payouts_enabled && <p className="small muted" style={{ margin: 0 }}>{t('money.setUpFirst')}</p>}
          {dash.withdrawalsFrozen && <p className="small muted" style={{ margin: 0 }}>{t('money.frozen')}</p>}
          {others.map((b: any) => (
            <div key={b.currency} className="notice row spread">
              <span>{t('money.alsoHold', { amount: money(b.cents, b.currency) })}</span>
              {b.cents > 0 && (
                <button className="btn ghost" disabled={!user?.payouts_enabled} onClick={() => run(() => api('/seller/withdrawals', { body: { amountCents: b.cents, currency: b.currency } }), t('money.onItsWayShort', { amount: money(b.cents, b.currency) }))}>
                  {t('money.withdraw')}
                </button>
              )}
            </div>
          ))}
        </aside>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Payout address */}
        <PayoutAddressCard onChanged={load} onMessage={setMsg} />

        {/* Tax profile */}
        <TaxForm tax={tax} onSaved={(next) => (setTax(next), setMsg({ kind: 'ok', text: t('money.taxSaved') }))} onError={(text) => setMsg({ kind: 'alert', text })} />
      </div>

      {/* Invoices & credit notes */}
      <div className="card stack">
        <div className="row spread">
          <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2"><ReceiptText className="size-5" strokeWidth={1.8} /> {t('money.invoices')}</h3>
          <span className="small muted">{t('money.invoices.when')}</span>
        </div>
        {invoices.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>{t('money.invoices.none')}</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('money.col.number')}</th><th>{t('money.col.period')}</th><th>{t('money.col.commission')}</th><th>{t('money.col.tax')}</th><th /></tr></thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.number}</td>
                    <td className="small">{fmtDate(i.period_start)}</td>
                    <td className="mono">{money(Number(i.gross_cents), i.currency)}</td>
                    <td className="mono muted">{money(Number(i.tax_cents), i.currency)}</td>
                    <td><button className="btn ghost" onClick={() => download(`/seller/invoices/${i.id}/pdf`, `${i.number}.pdf`)}><FileText className="size-4" /> PDF</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {credits.length > 0 && (
          <>
            <h4 style={{ margin: '8px 0 0' }}>{t('money.credits')}</h4>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>{t('money.col.number')}</th><th>{t('money.col.issued')}</th><th>{t('money.col.returned')}</th><th>{t('money.col.reason')}</th></tr></thead>
                <tbody>
                  {credits.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.number}</td>
                      <td className="small">{fmtDate(c.issued_at)}</td>
                      <td className="mono">{money(Number(c.gross_cents), c.currency)}</td>
                      <td className="small muted">{c.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <Exports />
    </div>
  );
}

/** A negative balance after a refund or chargeback: what's owed, when the shop pauses, and pay now. */
function DebtCard({ debt, onError }: { debt: { id: string; currency: string; owedCents: number; pausesAt: string | null; shopPausedAt: string | null }; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const pay = async () => {
    setBusy(true);
    try {
      const r = await api<{ checkoutUrl: string }>(`/seller/debts/${debt.id}/pay`, { body: {} });
      window.location.assign(r.checkoutUrl);
    } catch (e: any) {
      onError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="card stack" style={{ borderColor: 'var(--disputed)' }}>
      <div className="row spread">
        <div>
          <div className="eyebrow" style={{ marginBottom: 4, color: 'var(--disputed)' }}>{t('money.debt.title')}</div>
          <div className="font-mono text-2xl font-semibold">−{money(debt.owedCents, debt.currency)}</div>
        </div>
        <button className="btn" disabled={busy} onClick={pay}>{busy ? t('offer.opening') : t('money.debt.pay', { amount: money(debt.owedCents, debt.currency) })}</button>
      </div>
      <p className="small" style={{ margin: 0 }}>
        {t('money.debt.text')}{' '}
        {debt.shopPausedAt ? t('money.debt.paused') : debt.pausesAt ? t('money.debt.pausesAt', { date: fmtDate(debt.pausesAt) }) : ''}
      </p>
    </div>
  );
}

function Stat({ label, value, tone, icon }: { label: string; value: string; tone?: 'released' | 'held'; icon?: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-border p-3', tone === 'released' && 'border-released/40 bg-released/5', tone === 'held' && 'border-held/40 bg-held/5')}>
      <div className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function Withdraw({ currency, max, disabled, onWithdraw }: { currency: string; max: number; disabled: boolean; onWithdraw: (cents: number) => void }) {
  const [amount, setAmount] = useState('');
  const [checked, setChecked] = useState(false);
  const [dest, setDest] = useState<{ address: string | null; currencyName: string | null } | null>(null);
  const [quote, setQuote] = useState<{ feeCents: number; netCents: number; feeBps: number; feeMinCents: number } | null>(null);
  const cents = amount ? Math.round(Number(amount) * 100) : max;
  useEffect(() => {
    api<{ address: string | null; currencyName: string | null }>('/seller/payout-address').then(setDest).catch(() => {});
  }, []);
  useEffect(() => {
    if (cents <= 0) return setQuote(null);
    let live = true;
    api<any>(`/seller/withdrawals/quote?amountCents=${cents}`).then((q) => live && setQuote(q)).catch(() => live && setQuote(null));
    return () => {
      live = false;
    };
  }, [cents]);
  return (
    <div className="pg-withdraw-body">
      <div className="field">
        <span className="pg-wlabel">{t('wallet.sendTo')}</span>
        {dest?.address ? (
          <div className="pg-addr"><span className="small"><b>{dest.currencyName}</b></span><code className="num">{dest.address}</code><a className="small" href="#payout-address">{t('handover.change')}</a></div>
        ) : (
          <a className="small" href="#payout-address">{t('money.payoutAddress.none')}</a>
        )}
      </div>
      <label className="field">
        <span className="pg-wlabel">{t('money.amountIn', { currency })}</span>
        <input
          className="num"
          type="number"
          min={0}
          step="0.01"
          placeholder={t('money.all', { amount: (max / 100).toFixed(2) })}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      {quote && cents > 0 && (
        <div className="pg-rows" data-testid="withdrawal-fee">
          <div><span className="muted">{t('wallet.fee', { pct: (quote.feeBps / 100).toFixed(0), min: money(quote.feeMinCents, currency) })}</span><span className="num">{money(quote.feeCents, currency)}</span></div>
          <div className="pg-total"><span>{t('wallet.youReceive')}</span><span className="pg-price">{money(quote.netCents, currency)}</span></div>
        </div>
      )}
      <label className="check-row small">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        {t('wallet.checked')}
      </label>
      <button className="btn lg block" disabled={disabled || !checked || cents <= 0 || cents > max} onClick={() => (onWithdraw(cents), setAmount(''), setChecked(false))}>
        {t('money.withdrawAmount', { amount: money(cents, currency) })}
      </button>
    </div>
  );
}

interface HistoryRow { id: string; at: string; what: string; href?: string; state: 'held' | 'released' | 'disputed' | 'sent' | 'pending' | 'failed'; label?: string; cents: number; currency: string; sign: number }

function WalletHistory({ rows, currency }: { rows: HistoryRow[]; currency: string }) {
  if (!rows.length) return <div className="card small muted">{t('wallet.noHistory')}</div>;
  const chip = (r: HistoryRow) => {
    const tone = r.state === 'held' || r.state === 'pending' ? 'held' : r.state === 'disputed' || r.state === 'failed' ? 'disputed' : 'released';
    const label = r.label ?? t(`wallet.state.${r.state}` as MessageKey);
    return <span className={cn('chip', tone)}><span className="chip-dot" aria-hidden />{label}</span>;
  };
  return (
    <div className="card pg-htable">
      <table className="data">
        <thead><tr><th>{t('wallet.col.date')}</th><th>{t('wallet.col.what')}</th><th>{t('wallet.col.status')}</th><th className="text-end">{t('wallet.col.amount')}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="muted small num">{fmtDate(r.at)}</td>
              <td className="small">{r.href ? <a href={r.href}>{r.what}</a> : r.what}</td>
              <td>{chip(r)}</td>
              <td className={cn('num text-end', r.sign < 0 && 'muted')}><b>{r.sign < 0 ? '−' : '+'}{money(r.cents, r.currency ?? currency)}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const WSTATUS: Record<string, MessageKey> = {
  pending_approval: 'money.wstatus.pending_approval', processing: 'money.wstatus.processing', paid: 'money.wstatus.paid',
  failed: 'money.wstatus.failed', rejected: 'money.wstatus.rejected', pending: 'money.wstatus.pending',
};

interface PayoutAddress { address: string | null; currency: string | null; currencyName: string | null; setAt: string | null; pending: { address: string; currency: string; since: string } | null; coins: Array<{ coin: string; name: string }> }

/** The crypto address withdrawals go to: set with an email link, plus the 2FA code when the account has one. */
function PayoutAddressCard({ onChanged, onMessage }: { onChanged: () => void; onMessage: (m: { kind: 'ok' | 'alert'; text: string }) => void }) {
  const [pa, setPa] = useState<PayoutAddress | null>(null);
  const [coin, setCoin] = useState('usdttrc20');
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [params, setParams] = useSearchParams();
  const token = params.get('confirm-payout-address');
  const load = useCallback(() => api<PayoutAddress>('/seller/payout-address').then(setPa).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);

  const request = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setPa(await api<PayoutAddress>('/seller/payout-address', { body: { address, currency: coin } }));
      setAddress('');
      onMessage({ kind: 'ok', text: t('money.payoutAddress.sent') });
    } catch (err: any) {
      onMessage({ kind: 'alert', text: err.message });
    }
  };
  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setPa(await api<PayoutAddress>('/seller/payout-address/confirm', { body: { token, ...(code ? { code } : {}) } }));
      setParams({}, { replace: true });
      onMessage({ kind: 'ok', text: t('money.payoutAddress.confirmed') });
      onChanged();
    } catch (err: any) {
      onMessage({ kind: 'alert', text: err.message });
    }
  };

  if (!pa) return null;
  return (
    <div className="card stack" id="payout-address">
      <div className="eyebrow" style={{ marginBottom: 0 }}>{t('money.payoutAddress')}</div>
      <p className="small muted" style={{ margin: 0 }}>{t('money.payoutAddress.text')}</p>
      {pa.address ? (
        <p className="small" style={{ margin: 0 }}><b>{pa.currencyName}</b> · <code className="mono" style={{ wordBreak: 'break-all' }}>{pa.address}</code></p>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>{t('money.payoutAddress.none')}</p>
      )}
      {token ? (
        <form className="row" onSubmit={confirm} style={{ alignItems: 'end', flexWrap: 'wrap' }}>
          <label className="field" style={{ margin: 0 }}>
            {t('money.payoutAddress.code')}
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={12} style={{ maxWidth: 140 }} />
          </label>
          <button className="btn" type="submit">{t('money.payoutAddress.confirm')}</button>
        </form>
      ) : pa.pending ? (
        <p className="small" role="status" style={{ margin: 0 }}>{t('money.payoutAddress.pending', { address: pa.pending.address })}</p>
      ) : null}
      <form className="row" onSubmit={request} style={{ alignItems: 'end', flexWrap: 'wrap' }}>
        <label className="field" style={{ margin: 0 }}>
          {t('money.payoutAddress.coin')}
          <select value={coin} onChange={(e) => setCoin(e.target.value)}>{pa.coins.map((c) => <option key={c.coin} value={c.coin}>{c.name}</option>)}</select>
        </label>
        <label className="field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
          {t('money.payoutAddress.address')}
          <input value={address} onChange={(e) => setAddress(e.target.value)} required minLength={10} maxLength={128} />
        </label>
        <button className="btn ghost" type="submit">{t('money.payoutAddress.save')}</button>
      </form>
    </div>
  );
}

function TaxForm({ tax, onSaved, onError }: { tax: TaxProfile; onSaved: (t: TaxProfile) => void; onError: (m: string) => void }) {
  const [business, setBusiness] = useState(tax.isBusiness);
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setSaving(true);
    try {
      onSaved(await api<TaxProfile>('/seller/tax-profile', { method: 'PUT', body: { country: f.country, isBusiness: business, taxId: business ? f.taxId || null : null, billingAddress: f.billingAddress || null } }));
    } catch (err: any) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const ct = tax.commissionTax;
  return (
    <form className="card stack" onSubmit={submit}>
      <div className="eyebrow" style={{ marginBottom: 0 }}>{t('money.taxDetails')}</div>
      <p className="small muted" style={{ margin: 0 }}>{t('money.taxDetails.text')}</p>
      <label className="field">
        {t('money.country')}
        <select name="country" defaultValue={tax.country ?? ''} required>
          <option value="" disabled>{t('sell.f.choose')}</option>
          {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </label>
      <label className="row small">
        <input type="checkbox" style={{ width: 'auto' }} checked={business} onChange={(e) => setBusiness(e.target.checked)} />
        {t('money.business')}
      </label>
      {business && (
        <label className="field">
          {t('money.vatNumber')}
          <input name="taxId" className="mono" defaultValue={tax.taxId ?? ''} placeholder="e.g. DE123456789" />
          {tax.taxId && <span className={cn('small', tax.taxIdVerified ? 'text-released' : 'text-muted-foreground')}>{tax.taxIdVerified ? t('money.vies') : t('money.notVerified')}</span>}
        </label>
      )}
      <label className="field">{t('money.billing')}<textarea name="billingAddress" defaultValue={tax.billingAddress ?? ''} style={{ minHeight: 60 }} /></label>
      <div className="notice small">{TREATMENT_TEXT[ct.treatment](ct.rateBps, ct.country)}</div>
      <button className="btn" disabled={saving} style={{ alignSelf: 'flex-start' }}>{saving ? t('money.saving') : t('money.saveTax')}</button>
    </form>
  );
}

const exportsList = (): Array<[string, string, string]> => [
  ['sales', t('money.exp.sales'), t('money.exp.sales.hint')],
  ['statement', t('money.exp.statement'), t('money.exp.statement.hint')],
  ['payouts', t('money.exp.payouts'), t('money.exp.payouts.hint')],
  ['invoices', t('money.exp.invoices'), t('money.exp.invoices.hint')],
  ['credit_notes', t('money.exp.credits'), t('money.exp.credits.hint')],
];

function Exports() {
  const [from, setFrom] = useState(first());
  const [to, setTo] = useState(tomorrow());
  const [error, setError] = useState('');
  return (
    <div className="card stack">
      <div className="row spread">
        <h3 style={{ margin: 0 }} className="inline-flex items-center gap-2"><Download className="size-5" strokeWidth={1.8} /> {t('money.exports')}</h3>
        <div className="row small">
          <label className="row" style={{ gap: 6 }}>{t('money.from')} <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} /></label>
          <label className="row" style={{ gap: 6 }}>{t('money.to')} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} /></label>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {exportsList().map(([kind, label, hint]) => (
          <button
            key={kind}
            type="button"
            className="card demo-account cursor-pointer text-start"
            onClick={async () => {
              setError('');
              try {
                await download(`/seller/exports/${kind}?from=${from}&to=${to}`, `bullizard-${kind}-${from}-to-${to}.csv`);
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <b className="inline-flex items-center gap-1.5"><Download className="size-4" /> {label}</b>
            <span className="small muted">{hint}</span>
          </button>
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>{t('money.csv')}</p>
      {error && <div className="alert" role="alert">{error}</div>}
    </div>
  );
}
