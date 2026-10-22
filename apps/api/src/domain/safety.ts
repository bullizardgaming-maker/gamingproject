/**
 * Text safety checks shared by chat, reviews and listings. No dependencies, so the web app
 * bundles this module too and warns before a message is sent, with the same rules the API applies.
 *
 * Off-platform contact: all negotiation must stay in the recorded chat. It is the evidence base
 * for arbitration and chargeback representment, and deals moved elsewhere aren't in escrow.
 */
export const OFFPLATFORM_PATTERNS: Array<[string, RegExp]> = [
  ['discord', /\bdiscord(?:app)?(?:\.gg|\.com)?\b|\bdisc\s*(?:ord)?\s*:\s*\S|ديسكورد|دسكورد/i],
  ['telegram', /\btelegram\b|\bt\.me\/|\btg\s*:\s*@?\w+|\btele\b|تيليجرام|تلغرام|تلجرام/i],
  ['whatsapp', /\bwhats\s?app\b|\bwa\.me\/|\bwsp\b|واتساب|واتس/i],
  ['facebook', /\bface\s?book\b|\bfb(?:\.com|\.me)?\b|\bmessenger\b|\bm\.me\/|فيسبوك|فيس بوك|ماسنجر|مسنجر/i],
  ['instagram', /\binsta(?:gram)?\b|\big\s*:\s*@?\w+|انستجرام|انستقرام|انستا/i],
  ['other_messenger', /\b(?:skype|viber|wechat|signal\s+app|kik|snapchat|snap\s*:\s*\S|line\s*id)\b/i],
  ['external_payment', /\b(?:paypal(?:\.me)?|cash\s?app|venmo|zelle|western\s+union|revolut|wise\.com|skrill|vodafone\s+cash|instapay|friends\s*(?:and|&)\s*family|f\s?&\s?f)\b|فودافون كاش|انستاباي/i],
  ['pay_outside', /\b(?:pay|send|transfer)(?:\s+\w+){0,3}\s+(?:outside|off)\s+(?:the\s+)?(?:site|platform|bullizard)\b|\boutside\s+(?:the\s+)?(?:site|platform|escrow)\b|\bskip\s+(?:the\s+)?escrow\b/i],
  ['phone_number', /(?:\+|\b00)\d[\d\s().-]{7,}\d\b/],
  // Emails are only allowed inside account orders (the encrypted handover box), see detectOffPlatform().
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  // Links anywhere but to Bullizard itself.
  ['link', /\b(?:https?:\/\/|www\.)(?!(?:[\w-]+\.)*bullizard\.(?:com|gg)\b)\S+|\b(?!bullizard\b)[\w-]+\.(?:com|net|org|io|gg|me|app|link|xyz|co|uk|de|eg|ru)(?:\/\S*)?(?=\s|$|[.,!?)])/i],
  // @handles (an email's @ never follows whitespace or the start of the text).
  ['handle', /(?:^|[\s(])@[a-z0-9_.]{3,}/i],
  ['add_me', /\badd\s+me\b|\bhmu\b|\bdm\s+me\b|\bmy\s+(?:discord|telegram|whatsapp|insta|snap|tag|username|user\s*name|id|handle|number)\s*(?:is|:)|\b(?:contact|reach|message|text)\s+me\s+(?:on|at|via)\b|ضيفني|كلمني على|تواصل معي على/i],
];

/** Platform names matched again on the text with spaces, dots and digit swaps removed (d1scord, d i s c o r d). */
const DISGUISED: Array<[string, RegExp]> = [
  ['discord', /discord/],
  ['telegram', /telegram/],
  ['whatsapp', /whatsapp/],
  ['facebook', /facebook|messenger/],
  ['instagram', /instagram/],
  ['other_messenger', /snapchat|viber|skype|wechat/],
  ['external_payment', /paypal|cashapp|venmo|zelle|skrill|vodafonecash|instapay/],
];
const LEET_LETTERS: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'l' };
/** Lower-case, undo digit swaps, drop everything that is not a letter: "d.1.s c0rd" → "discord". */
export function squash(text: string) {
  return text
    .toLowerCase()
    .replace(/[013457@$!|]/g, (c) => LEET_LETTERS[c] ?? c)
    .replace(/[^\p{L}]+/gu, '');
}

/**
 * Names of the off-platform patterns a text matches (empty when clean). Email addresses are the
 * one thing an account order may carry (the credentials handover), so callers pass `allowEmail`
 * for those rooms.
 */
export function detectOffPlatform(body: string, opts: { allowEmail?: boolean } = {}): string[] {
  const emailRe = OFFPLATFORM_PATTERNS.find(([n]) => n === 'email')![1];
  // An email's domain is not a link on its own.
  const noEmails = body.replace(new RegExp(emailRe.source, 'g'), ' ');
  const hits = new Set(
    OFFPLATFORM_PATTERNS.filter(([name, re]) => !(opts.allowEmail && name === 'email') && re.test(name === 'link' ? noEmails : body)).map(([name]) => name),
  );
  const compact = squash(body);
  for (const [name, re] of DISGUISED) if (re.test(compact)) hits.add(name);
  return [...hits];
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
