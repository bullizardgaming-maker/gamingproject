import { useSyncExternalStore } from 'react';
import en, { type MessageKey, type Messages, type PluralBase } from './en';

/**
 * Interface languages. English is bundled; the others load on demand. Buyer-facing pages are
 * translated; seller tools and staff Operations stay in English (labelled as such). Arabic sets
 * the page to right-to-left, and every layout uses logical CSS properties so it mirrors.
 */
export const LOCALES = {
  en: { name: 'English', short: 'EN', dir: 'ltr', intl: 'en-US' },
  ar: { name: 'العربية', short: 'ع', dir: 'rtl', intl: 'ar-u-nu-latn' },
  es: { name: 'Español', short: 'ES', dir: 'ltr', intl: 'es-ES' },
  fr: { name: 'Français', short: 'FR', dir: 'ltr', intl: 'fr-FR' },
  de: { name: 'Deutsch', short: 'DE', dir: 'ltr', intl: 'de-DE' },
  pt: { name: 'Português', short: 'PT', dir: 'ltr', intl: 'pt-BR' },
} as const;
export type Locale = keyof typeof LOCALES;
export type { MessageKey };
type Dict = Messages;

/** Help-centre articles in one language, keyed by article slug (see lib/help.ts). */
export interface HelpPack {
  topics: Record<string, { title: string; blurb: string }>;
  articles: Record<string, { title: string; summary: string; body: string[] }>;
  ticketCategories: Record<string, string>;
}
type Loaded = [{ default: Dict }, { default: Dict }, { default: HelpPack }];
// Each language is three chunks: the site, the seller hub and the help centre.
const loaders: Record<Exclude<Locale, 'en'>, () => Promise<Loaded>> = {
  ar: () => Promise.all([import('./ar'), import('./ar.seller'), import('./ar.help')]),
  es: () => Promise.all([import('./es'), import('./es.seller'), import('./es.help')]),
  fr: () => Promise.all([import('./fr'), import('./fr.seller'), import('./fr.help')]),
  de: () => Promise.all([import('./de'), import('./de.seller'), import('./de.help')]),
  pt: () => Promise.all([import('./pt'), import('./pt.seller'), import('./pt.help')]),
};
let help: HelpPack | null = null;
/** The help centre in the active language, or null for English. */
export const helpPack = () => help;

const KEY = 'bz.lang';
let locale: Locale = 'en';
let dict: Dict = en;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

function stored(): Locale | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && v in LOCALES ? (v as Locale) : null;
  } catch {
    return null;
  }
}
function detect(): Locale {
  for (const l of typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []) {
    const base = l.toLowerCase().split('-')[0]!;
    if (base in LOCALES) return base as Locale;
  }
  return 'en';
}

function apply() {
  const html = document.documentElement;
  html.lang = locale === 'pt' ? 'pt-BR' : locale;
  html.dir = LOCALES[locale].dir;
}

async function load(l: Locale) {
  if (l === 'en') {
    dict = en;
    help = null;
  } else {
    const [site, seller, helpModule] = await loaders[l]();
    dict = { ...en, ...site.default, ...seller.default };
    help = helpModule.default;
  }
  locale = l;
  apply();
  listeners.forEach((fn) => fn());
}

/** Picks the saved or browser language and loads it before the first render (no flash). */
export async function initI18n() {
  const l = stored() ?? detect();
  try {
    await load(l);
  } catch {
    await load('en');
  }
}

export async function setLocale(l: Locale) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* storage blocked: lasts for this visit */
  }
  await load(l);
}

export const currentLocale = () => locale;
/** The language the person picked in this browser, or null if it was only detected. */
export const chosenLocale = () => stored();
export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && v in LOCALES;
export const intlLocale = () => LOCALES[locale].intl;
/** Prices: Arabic interfaces in gaming marketplaces show Latin "$29.00", which also reads cleanly inside RTL text. */
export const moneyLocale = () => (locale === 'ar' ? 'en-US' : LOCALES[locale].intl);

/**
 * Translate a key. `{name}` placeholders are filled from vars; a `count` var picks the plural form
 * (`key_one`, `key_few`, … per the language's rules), falling back to `key_other`, then `key`.
 */
export function t(key: MessageKey | PluralBase, vars?: Record<string, string | number>): string {
  let msg: string | undefined;
  if (vars && typeof vars.count === 'number') {
    const rule = new Intl.PluralRules(intlLocale()).select(vars.count);
    msg = (dict as Record<string, string>)[`${key}_${rule}`] ?? (dict as Record<string, string>)[`${key}_other`];
  }
  msg ??= (dict as Record<string, string>)[key] ?? (en as Record<string, string>)[key] ?? key;
  return vars ? msg.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? (typeof vars[k] === 'number' ? (vars[k] as number).toLocaleString(intlLocale()) : String(vars[k])) : `{${k}}`)) : msg;
}

/** Re-renders the caller when the language changes; returns the active locale. */
export const useLocale = () => useSyncExternalStore(subscribe, () => locale);
/** Run a callback after every language change (and keep it registered). */
export const onLocaleChange = (fn: () => void) => subscribe(fn);
