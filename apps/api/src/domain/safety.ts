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
  ['external_payment', /\b(?:paypal(?:\.me)?|cash\s?app|venmo|zelle|western\s+union|revolut|wise\.com|skrill|vodafone\s+cash|vf\s*cash|instapay|insta\s*pay|fawry|orange\s+cash|etisalat\s+cash|we\s+pay|meeza|bank\s+transfer|iban|friends\s*(?:and|&)\s*family|f\s?&\s?f)\b|فودافون كاش|فودافون كاش|انستاباي|انستا باي|فوري|اورنج كاش|أورنج كاش|اتصالات كاش|تحويل بنكي|محفظة\s*(?:رقم|الكترونية|إلكترونية)/i],
  // Crypto wallet addresses: paying outside escrow (EVM, BTC legacy/segwit, TRON, LTC, SOL-length base58).
  ['wallet_address', /\b0x[a-fA-F0-9]{40}\b|\bbc1[a-z0-9]{25,62}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\bT[a-km-zA-HJ-NP-Z1-9]{33}\b|\b[LM][a-km-zA-HJ-NP-Z1-9]{26,33}\b|\bltc1[a-z0-9]{25,62}\b/],
  // Other marketplaces: moving the deal elsewhere.
  ['other_marketplace', /\b(?:g2g|funpay|eldorado(?:\.gg)?|playerauctions|player\s*up|z2u|igvault|mmoga|kinguin|eneba|odealo|u7buy|lootbar|overgear|skycoach)\b|فن باي|جي تو جي/i],
  ['pay_outside', /\b(?:pay|send|transfer)(?:\s+\w+){0,3}\s+(?:outside|off)\s+(?:the\s+)?(?:site|platform|bullizard)\b|\boutside\s+(?:the\s+)?(?:site|platform|escrow)\b|\bskip\s+(?:the\s+)?escrow\b/i],
  // International numbers, and Egyptian mobiles written locally (010/011/012/015 + 8 digits, with or without spaces).
  ['phone_number', /(?:\+|\b00)\d[\d\s().-]{7,}\d\b|\b01[0125](?:[\s.-]?\d){8}\b|(?<![٠-٩])٠١[٠١٢٥](?:[\s.-]?[٠-٩]){8}(?![٠-٩])/],
  // Emails are only allowed inside account orders (the encrypted handover box), see detectOffPlatform().
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  // Links anywhere but to Bullizard itself.
  ['link', /\b(?:https?:\/\/|www\.)(?!(?:[\w-]+\.)*bullizard\.(?:com|gg)\b)\S+|\b(?!bullizard\b)[\w-]+\.(?:com|net|org|io|gg|me|app|link|xyz|co|uk|de|eg|ru)(?:\/\S*)?(?=\s|$|[.,!?)])/i],
  // @handles (an email's @ never follows whitespace or the start of the text).
  ['handle', /(?:^|[\s(])@[a-z0-9_.]{3,}/i],
  ['add_me', /\badd\s+me\b|\bhmu\b|\bdm\s+me\b|\bmy\s+(?:discord|telegram|whatsapp|insta|snap|tag|username|user\s*name|id|handle|number)\s*(?:is|:)|\b(?:contact|reach|message|text)\s+me\s+(?:on|at|via)\b|ضيفني|كلمني على|تواصل معي على/i],
  // Instant-ban categories (Support playbook): recruiting sellers elsewhere, impersonating staff, dodging a ban.
  ['recruiting', /\b(?:work|sell|farm|trade)\s+(?:for|with)\s+me\b|\bjoin\s+my\s+(?:team|guild|server|group|shop)\b|\bi(?:'ll| will)\s+pay\s+you\s+(?:more|better)\b|\bbetter\s+(?:price|rate)\s+(?:outside|elsewhere|on)\b|اشتغل معايا|اشتغل معي|انضم (?:لفريقي|لسيرفري|لجروبي)/i],
  ['impersonation', /\b(?:i\s*am|i'm|this\s+is)\s+(?:a\s+|an\s+|the\s+)?(?:bullizard\s+)?(?:admin|moderator|mod|staff|support|arbiter|official)\b|\bbullizard\s+(?:staff|support|admin|team)\s+here\b|أنا (?:من )?(?:فريق|دعم|أدمن|مشرف) Bullizard|انا (?:من )?(?:فريق|دعم|ادمن|مشرف)/i],
  ['ban_dodging', /\b(?:my\s+)?(?:new|second|other|alt)\s+account\b.*\b(?:banned|suspended)\b|\b(?:banned|suspended)\b.*\b(?:new|second|other|alt)\s+account\b|حسابي (?:الجديد|التاني|الثاني).*(?:محظور|موقوف)|(?:محظور|موقوف).*حسابي (?:الجديد|التاني|الثاني)/i],
];

/** Categories that mean an instant ban, whatever the warn/suspend/ban ladder says (Support playbook, Oct 24). */
export const INSTANT_BAN_CATEGORIES = new Set(['external_payment', 'wallet_address', 'pay_outside', 'other_marketplace', 'recruiting', 'impersonation', 'ban_dodging']);
export const isInstantBan = (violations: string[]) => violations.some((v) => INSTANT_BAN_CATEGORIES.has(v));

/** Platform names matched again on the text with spaces, dots and digit swaps removed (d1scord, d i s c o r d). */
const DISGUISED: Array<[string, RegExp]> = [
  ['discord', /discord/],
  ['telegram', /telegram/],
  ['whatsapp', /whatsapp/],
  ['facebook', /facebook|messenger/],
  ['instagram', /instagram/],
  ['other_messenger', /snapchat|viber|skype|wechat/],
  ['external_payment', /paypal|cashapp|venmo|zelle|skrill|vodafonecash|instapay|fawry|orangecash|etisalatcash/],
  ['other_marketplace', /funpay|eldorado|playerauctions|igvault|kinguin|eneba/],
];
/** Cyrillic/Greek letters that look like Latin ones (dіscord with a Ukrainian і). */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ԁ: 'd', ѕ: 's', ԛ: 'q', ԝ: 'w', һ: 'h', ո: 'n', ⅼ: 'l', ɡ: 'g',
  α: 'a', ο: 'o', ρ: 'p', τ: 't', ν: 'v', ε: 'e', ι: 'i', κ: 'k', '０': '0', '１': '1', '３': '3', '４': '4', '５': '5', '７': '7',
};
const LEET_LETTERS: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'l' };
/** Lower-case, undo digit swaps, drop everything that is not a letter: "d.1.s c0rd" → "discord". */
export function squash(text: string) {
  return text
    .toLowerCase()
    .replace(/[\u0400-\u04ff\u0370-\u03ff\uff10-\uff19ԁѕԛԝһոⅼɡ]/g, (c) => HOMOGLYPHS[c] ?? c)
    .replace(/[013457@$!|]/g, (c) => LEET_LETTERS[c] ?? c)
    .replace(/[^\p{L}]+/gu, '');
}

/** Platform names spelled across several short messages ("dis" then "cord"): check the sender's recent lines joined with this one. */
export function detectSplit(previous: string[], body: string): string[] {
  const joined = squash([...previous, body].join(''));
  if (!joined) return [];
  const own = squash(body);
  return DISGUISED.filter(([, re]) => re.test(joined) && !re.test(own)).map(([name]) => `${name}`);
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
