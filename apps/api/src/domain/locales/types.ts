import type { TemplateName } from '../notifications.js';

export const LOCALES = ['en', 'ar', 'es', 'fr', 'de', 'pt'] as const;
export type Locale = (typeof LOCALES)[number];
export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

type Data = Record<string, any>;
/** Formatting in the reader's language: prices (Arabic keeps Latin "$29.00") and UTC times. */
export interface Helpers {
  money(cents: number, currency?: string): string;
  when(iso: string): string;
  /** Round 23f: "15 minutes" in the reader's language (Arabic: number and noun agree). */
  duration(minutes: number): string;
  /** Round 23f: the reader's wording for a withdrawal reason code. */
  reason(code: unknown): string;
}
export interface LocalizedTemplate {
  subject(d: Data, h: Helpers): string;
  body(d: Data, link: (path: string) => string, h: Helpers): string;
}
/** Round 23f (copy deck §9.7): the strings of the one email layout, in every language. */
export interface EmailLayout {
  /** "{name}" is replaced by the reader's display name. */
  greeting: string;
  greetingNoName: string;
  signoff: string;
  why: string;
  safety: string;
  /** "Email settings" (left out of security emails). */
  manage: string;
  legal: string;
  /** Label of the button when the body's last link has none. */
  button: string;
}
/** Round 23f (§9.6): why a withdrawal was not sent, as a code; each language words it. */
export const WITHDRAWAL_REASONS = ['unsupported_coin', 'not_approved', 'provider_failed'] as const;
export type WithdrawalReason = (typeof WITHDRAWAL_REASONS)[number];
export const withdrawalReason = (v: unknown): WithdrawalReason => ((WITHDRAWAL_REASONS as readonly unknown[]).includes(v) ? (v as WithdrawalReason) : 'provider_failed');

/** One language's customer-facing messages. Staff alerts stay in English. */
export interface LocalePack {
  layout: EmailLayout;
  /** Verification-code email (§9.7): subject and body. */
  verifySubject(code: string): string;
  verifyCode(code: string, minutes: number): string;
  /** "15 minutes", "1 hour" — Arabic agrees number and noun (arCount). */
  duration(minutes: number): string;
  withdrawalReasons: Record<WithdrawalReason, string>;
  templates: Partial<Record<TemplateName, LocalizedTemplate>>;
}

/**
 * Round 23f (§9.7 item 5): an Arabic count with the noun in agreement. 1 → `one` («دقيقة واحدة»), 2 → `two`
 * («دقيقتان»), 3–10 → "{n} {few}" («5 دقائق»), 11+ (and 0) → "{n} {many}" («15 دقيقة»).
 */
export function arCount(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}
/** Minutes in Arabic; 60 and more become hours with the same agreement rule (60 → «ساعة واحدة», 1440 → «24 ساعة»). */
export function arDuration(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.round(minutes / 60);
    return arCount(h, 'ساعة واحدة', 'ساعتان', 'ساعات', 'ساعة');
  }
  return arCount(minutes, 'دقيقة واحدة', 'دقيقتان', 'دقائق', 'دقيقة');
}
/** The same split for languages with a plain singular/plural. */
export function simpleDuration(minutes: number, units: { minute: string; minutes: string; hour: string; hours: string }): string {
  if (minutes >= 60) {
    const h = Math.round(minutes / 60);
    return `${h} ${h === 1 ? units.hour : units.hours}`;
  }
  return `${minutes} ${minutes === 1 ? units.minute : units.minutes}`;
}

const INTL: Record<Locale, string> = { en: 'en-US', ar: 'ar-u-nu-latn', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR' };
export function helpers(locale: Locale): Pick<Helpers, 'money' | 'when'> {
  return {
    money: (cents, currency = 'USD') => new Intl.NumberFormat(locale === 'ar' ? 'en-US' : INTL[locale], { style: 'currency', currency }).format(cents / 100),
    when: (iso) => `${new Date(iso).toLocaleString(INTL[locale], { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC`,
  };
}
