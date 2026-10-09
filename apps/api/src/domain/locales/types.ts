import type { TemplateName } from '../notifications.js';

export const LOCALES = ['en', 'ar', 'es', 'fr', 'de', 'pt'] as const;
export type Locale = (typeof LOCALES)[number];
export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

type Data = Record<string, any>;
/** Formatting in the reader's language: prices (Arabic keeps Latin "$29.00") and UTC times. */
export interface Helpers {
  money(cents: number, currency?: string): string;
  when(iso: string): string;
}
export interface LocalizedTemplate {
  subject(d: Data, h: Helpers): string;
  body(d: Data, link: (path: string) => string, h: Helpers): string;
}
/** One language's customer-facing messages. Staff alerts stay in English. */
export interface LocalePack {
  signoff: string;
  manage: string;
  verifyCode(code: string, minutes: number): string;
  templates: Partial<Record<TemplateName, LocalizedTemplate>>;
}

const INTL: Record<Locale, string> = { en: 'en-US', ar: 'ar-u-nu-latn', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR' };
export function helpers(locale: Locale): Helpers {
  return {
    money: (cents, currency = 'USD') => new Intl.NumberFormat(locale === 'ar' ? 'en-US' : INTL[locale], { style: 'currency', currency }).format(cents / 100),
    when: (iso) => `${new Date(iso).toLocaleString(INTL[locale], { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC`,
  };
}
