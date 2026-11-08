import { useEffect, useState, type ComponentType } from 'react';
import { Coins, CreditCard, CurrencyBtc, CurrencyDollar, CurrencyEth, DeviceMobile, Lightning, Wallet } from '@phosphor-icons/react';
import { api } from '../api';
import { useDisplayCurrency } from '@/lib/prefs';
import { t } from '../i18n';

type Item = { key: string; label: string; Icon: ComponentType<{ className?: string; weight?: 'regular' | 'bold' | 'fill' | 'duotone' }>; soon?: boolean };

// Coins the crypto checkout offers (NOWPayments); names only, no coin logos.
const COINS: Item[] = [
  { key: 'usdt', label: 'USDT', Icon: CurrencyDollar },
  { key: 'usdc', label: 'USDC', Icon: CurrencyDollar },
  { key: 'btc', label: 'Bitcoin', Icon: CurrencyBtc },
  { key: 'eth', label: 'Ethereum', Icon: CurrencyEth },
  { key: 'ltc', label: 'Litecoin', Icon: Coins },
  { key: 'sol', label: 'Solana', Icon: Coins },
  { key: 'trx', label: 'TRON', Icon: Coins },
  { key: 'ton', label: 'Toncoin', Icon: Coins },
  { key: 'doge', label: 'Dogecoin', Icon: Coins },
];

/**
 * The moving strip of ways to pay (CEO, 8 Nov). Crypto only when checkout offers it to this connection (GET
 * /payment-methods hides it in Egypt, Round 29); the wallet balance always; the local methods marked "Soon".
 */
export function PaymentStrip() {
  const cur = useDisplayCurrency();
  const [crypto, setCrypto] = useState<boolean | null>(null);
  useEffect(() => {
    api<Array<{ id: string; enabled?: boolean }>>(`/payment-methods?currency=${cur}`)
      .then((m) => setCrypto(m.some((x) => x.id === 'crypto' && x.enabled !== false)))
      .catch(() => setCrypto(false));
  }, [cur]);
  const items: Item[] = [
    ...(crypto ? COINS : []),
    { key: 'wallet', label: t('pay.strip.wallet'), Icon: Wallet },
    { key: 'card', label: t('pay.strip.card'), Icon: CreditCard, soon: true },
    { key: 'mobile', label: t('pay.strip.mobile'), Icon: DeviceMobile, soon: true },
    { key: 'instapay', label: 'InstaPay', Icon: Lightning, soon: true },
  ];
  const row = (hidden: boolean) => (
    <ul className="pay-row" aria-hidden={hidden || undefined}>
      {items.map(({ key, label, Icon, soon }) => (
        <li key={key} className="pay-chip">
          <Icon className="size-5" weight="duotone" />
          <span>{label}</span>
          {soon && <span className="pay-soon">{t('pay.strip.soon')}</span>}
        </li>
      ))}
    </ul>
  );
  return (
    <section className="pay-strip bleed" aria-labelledby="pay-strip-title" data-testid="payment-strip">
      <div className="shell pay-strip-head">
        <h2 id="pay-strip-title">{t('pay.strip.title')}</h2>
      </div>
      {crypto === null ? (
        <div className="pay-track" aria-hidden><div className="pay-row pay-row-skel" /></div>
      ) : (
        <div className="pay-track">
          <div className="pay-move">
            {row(false)}
            {row(true)}
          </div>
        </div>
      )}
    </section>
  );
}
