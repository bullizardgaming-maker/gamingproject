import { useSyncExternalStore } from 'react';
import { api, money } from '../api';

/**
 * Viewer preferences kept in this browser: colour theme and the currency prices are shown in.
 * Prices are settled in USD; other currencies are shown as approximate conversions at the
 * platform's published rates (checkout always shows the exact amount charged).
 */
export type Theme = 'light' | 'dark' | 'system';
export const DISPLAY_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
};

let theme: Theme = (read('bz.theme') as Theme) || 'system';
let currency: DisplayCurrency = DISPLAY_CURRENCIES.includes(read('bz.currency') as DisplayCurrency) ? (read('bz.currency') as DisplayCurrency) : 'USD';
let rates: Record<string, number> = { USD: 1 };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined;
export const resolvedTheme = () => (theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme);

export function applyTheme() {
  const dark = resolvedTheme() === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  // Browser chrome (and the installed app's title bar) follows the chosen theme, not just the OS.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#0d131c' : '#eef1f5'));
}
media?.addEventListener?.('change', () => theme === 'system' && (applyTheme(), emit()));

export function setTheme(t: Theme) {
  theme = t;
  write('bz.theme', t);
  applyTheme();
  emit();
}

export function setCurrency(c: DisplayCurrency) {
  currency = c;
  write('bz.currency', c);
  if (c !== 'USD') loadRates();
  emit();
}

let loading: Promise<void> | null = null;
function loadRates() {
  loading ??= api<{ rates: Array<{ currency: string; rate: number | string }> }>('/fx/rates')
    .then((r) => {
      rates = { USD: 1, ...Object.fromEntries(r.rates.map((x) => [x.currency, Number(x.rate)])) };
      emit();
    })
    .catch(() => {
      loading = null;
    });
  return loading;
}
if (currency !== 'USD') loadRates();

export const useTheme = () => useSyncExternalStore(subscribe, () => theme);
export const useDisplayCurrency = () => useSyncExternalStore(subscribe, () => currency);

/**
 * Price formatter in the viewer's currency. `fmt(cents)` takes a USD (settlement) amount: exact in
 * USD, "≈" when converted. `fmtOffer(o)` shows a listing in its own currency when the viewer
 * picked that currency, otherwise converts its settlement price.
 */
export function usePrice() {
  const cur = useSyncExternalStore(subscribe, () => currency);
  useSyncExternalStore(subscribe, () => rates);
  const fmt = (cents: number, from = 'USD') => {
    if (cur === from || from !== 'USD' || !rates[cur]) return money(cents, from);
    return `≈ ${money(Math.round(cents * rates[cur]!), cur)}`;
  };
  const fmtOffer = (o: { price_cents: number; currency: string; price_settlement_cents?: number | string | null }) =>
    o.currency === cur ? money(o.price_cents, cur) : fmt(o.currency === 'USD' ? o.price_cents : Number(o.price_settlement_cents ?? o.price_cents), o.currency === 'USD' || o.price_settlement_cents != null ? 'USD' : o.currency);
  return Object.assign(fmt, { offer: fmtOffer });
}
