/**
 * Text safety checks shared by chat, reviews and listings. No dependencies, so the web app
 * bundles this module too and warns before a message is sent, with the same rules the API applies.
 *
 * Off-platform contact: all negotiation must stay in the recorded chat. It is the evidence base
 * for arbitration and chargeback representment, and deals moved elsewhere aren't in escrow.
 */
export const OFFPLATFORM_PATTERNS: Array<[string, RegExp]> = [
  ['discord', /\bdiscord(?:app)?(?:\.gg|\.com)?\b|ديسكورد/i],
  ['telegram', /\btelegram\b|\bt\.me\/|\btg\s*:\s*@?\w+|تيليجرام|تلغرام/i],
  ['whatsapp', /\bwhats\s?app\b|\bwa\.me\/|واتساب|واتس/i],
  ['other_messenger', /\b(?:skype|viber|wechat|signal\s+app|kik|snapchat|instagram\s+dm)\b/i],
  ['external_payment', /\b(?:paypal(?:\.me)?|cash\s?app|venmo|zelle|western\s+union|revolut|wise\.com|skrill|friends\s*(?:and|&)\s*family|f\s?&\s?f)\b/i],
  ['pay_outside', /\b(?:pay|send|transfer)(?:\s+\w+){0,3}\s+(?:outside|off)\s+(?:the\s+)?(?:site|platform|bullizard)\b|\boutside\s+(?:the\s+)?(?:site|platform|escrow)\b|\bskip\s+(?:the\s+)?escrow\b/i],
  ['phone_number', /(?:\+|\b00)\d[\d\s().-]{7,}\d\b/],
];

/** Names of the off-platform patterns a text matches (empty when clean). */
export function detectOffPlatform(body: string): string[] {
  return OFFPLATFORM_PATTERNS.filter(([, re]) => re.test(body)).map(([name]) => name);
}

/**
 * Listing terms staff maintain. `block` rejects the listing outright (clearly illegal goods);
 * `review` holds it for a moderator. Matching is case-insensitive on word boundaries and sees
 * through simple obfuscation (h4ck, c.h.e.a.t).
 */
export interface ModerationTerm {
  term: string;
  action: 'block' | 'review';
}

export const DEFAULT_TERMS: ModerationTerm[] = [
  ...['stolen card', 'carding', 'cvv', 'fullz', 'ddos', 'doxx', 'doxing', 'swatting', 'credit card generator'].map((term) => ({ term, action: 'block' as const })),
  ...['aimbot', 'wallhack', 'cheat', 'hack', 'exploit', 'dupe', 'duped', 'injector', 'unban', 'recovered account', 'stolen', 'chargeback', 'cracked', 'modded account', 'botted'].map(
    (term) => ({ term, action: 'review' as const }),
  ),
];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
/** Lowercase and undo common digit swaps (h4ck → hack). */
export function normalise(text: string) {
  return text.toLowerCase().replace(/[013457@$]/g, (c) => LEET[c] ?? c);
}
const words = (s: string) => ` ${s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** Terms a listing's text contains, block terms first. */
export function matchTerms(text: string, terms: ModerationTerm[]): ModerationTerm[] {
  const n = normalise(text);
  // Two readings: separators as spaces ("wallhack-proof" → "wallhack proof") and separators
  // inside a word dropped ("c.h.e.a.t" → "cheat").
  const variants = [words(n), words(n.replace(/(?<=[\p{L}\p{N}])[._\-*](?=[\p{L}\p{N}])/gu, ''))];
  const hits = terms.filter((t) => {
    const needle = words(normalise(t.term));
    return variants.some((v) => v.includes(needle));
  });
  return hits.sort((a, b) => (a.action === b.action ? 0 : a.action === 'block' ? -1 : 1));
}
