/**
 * Text safety checks shared by chat, reviews and listings. No dependencies, so the web app
 * bundles this module too and warns before a message is sent, with the same rules the API applies.
 *
 * Off-platform contact: all negotiation must stay in the recorded chat. It is the evidence base
 * for arbitration and chargeback representment, and deals moved elsewhere aren't in escrow.
 */
export const OFFPLATFORM_PATTERNS: Array<[string, RegExp]> = [
  // "dc" alone is also "disconnect": only "on dc", "via dc", "dc: name"; "my disc is …" / "disc: …" for the short form.
  ['discord', /\bdiscord(?:app)?(?:\.gg|\.com)?\b|\bdisc\s*(?:ord)?\s*:\s*\S|\bmy\s+disc\s+(?:is|=)\s+\S|\b(?:on|via)\s+dc\b|\bdc\s*:\s*\S|ديسكورد|دسكورد/i],
  // "tele" alone is "tele port", "telephone": only "tele: name".
  ['telegram', /\btelegram\b|\bt\.me\/|\btg\s*:\s*@?\w+|\btele\s*:\s*@?\w+|\b(?:on|via|my)\s+tele\b(?![\s-]*port)|تيليجرام|تلغرام|تلجرام/i],
  ['whatsapp', /\bwhats\s?app\b|\bwats\s?app\b|\bwhatsap\b|\bwa\.me\/|\bwsp\b|واتساب|واتس/i],
  ['facebook', /\bface\s?book\b|\bfb(?:\.com|\.me)?\b|\bmessenger\b|\bm\.me\/|فيسبوك|فيس بوك|ماسنجر|مسنجر/i],
  // "insta" alone is "instant" (insta delivery): only Instagram spelled out, "insta: name", "my/on/via insta".
  ['instagram', /\binstagram\b|\binsta\s*:\s*@?\w+|\b(?:my|on|via)\s+insta\b(?!\s*(?:delivery|deliver|buy|kill|win|refund))|\big\s*:\s*@?\w+|انستجرام|انستقرام|انستا/i],
  ['other_messenger', /\b(?:skype|viber|wechat|signal\s+app|kik|snapchat)\b|\bsnap\s*:\s*\S/i],
  // "فوري" is also the ordinary word for "instant" (التسليم فوري, الكود هيوصلك فوري), so Fawry only counts as a whole word
  // right next to a payment word (كود فوري, على فوري, ادفع على فوري) or followed by one (فوري كاش).
  ['external_payment', /\b(?:paypal(?:\.me)?|cash\s?app|venmo|zelle|western\s+union|revolut|wise\.com|skrill|vodafone\s+cash|vf\s*cash|instapay|insta\s*pay|fawry|orange\s+cash|etisalat\s+cash|we\s+pay\s+(?:app|wallet)|meeza|bank\s+transfer|iban|friends\s*(?:and|&)\s*family|f\s?&\s?f)\b|فودافون كاش|فودافون كاش|انستاباي|انستا باي|(?<![^\s،.!?:])(?:كود|رقم|محفظة|على|عبر|بواسطة)\s+فوري(?![^\s،.!?])|(?<![^\s،.!?:])(?:ادفع|ادفعلي|حول|حوّل|حولي)(?:\s+\S+)?\s+(?:على|عبر)\s+فوري(?![^\s،.!?])|(?<![^\s،.!?:])فوري\s+(?:\S+\s+)?(?:دفع|كاش|باي|بالكود)(?![^\s،.!?])|اورنج كاش|أورنج كاش|اتصالات كاش|تحويل بنكي|محفظة\s*(?:رقم|الكترونية|إلكترونية)/i],
  // Crypto wallet addresses: paying outside escrow (EVM, BTC legacy/segwit, TRON, LTC, SOL-length base58).
  ['wallet_address', /\b0x[a-fA-F0-9]{40}\b|\bbc1[a-z0-9]{25,62}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\bT[a-km-zA-HJ-NP-Z1-9]{33}\b|\b[LM][a-km-zA-HJ-NP-Z1-9]{26,33}\b|\bltc1[a-z0-9]{25,62}\b/],
  // Other marketplaces: moving the deal elsewhere. "g2g" is also "got to go" and Eldorado is a map: those two only
  // count as a site (g2g.com, eldorado.gg) or next to a shopping word ("on g2g", "g2g has it cheaper").
  ['other_marketplace', /\b(?:funpay|eldorado\.gg|playerauctions|playerup|z2u|igvault|mmoga|kinguin|eneba|odealo|u7buy|lootbar|overgear|skycoach)\b|\bg2g\.com\b|\b(?:on|at|from|via|use|try|check)\s+(?:g2g|eldorado)\b|\b(?:g2g|eldorado)\s+(?:has|sells?|is\s+cheaper|cheaper|price|prices|site|listing)\b|فن باي|جي تو جي/i],
  ['pay_outside', /\b(?:pay|send|transfer)(?:\s+\w+){0,3}\s+(?:outside|off)\s+(?:the\s+)?(?:site|platform|bullizard)\b|\boutside\s+(?:the\s+)?(?:site|platform|escrow)\b|\bskip\s+(?:the\s+)?escrow\b/i],
  // International numbers, and Egyptian mobiles written locally (010/011/012/015 + 7–8 digits, with or without spaces).
  // Round 22b: also every digit spaced out ("0 1 0 1 2 3 4 5 6 7 8").
  ['phone_number', /(?:\+|\b00)\d[\d\s().-]{7,}\d\b|\b0[\s.-]?1[\s.-]?[0125](?:[\s.-]?\d){7,8}\b|(?<![٠-٩])٠١[٠١٢٥](?:[\s.-]?[٠-٩]){7,8}(?![٠-٩])/],
  // Emails are only allowed inside account orders (the encrypted handover box), see detectOffPlatform().
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  // Links anywhere but to Bullizard itself. A bare domain needs a name of 3+ characters starting with a letter, so
  // "ok.gg" and "10.co" are chat, not links; anything with a path (bit.ly/abc) is a link.
  ['link', /\b(?:https?:\/\/|www\.)(?!(?:[\w-]+\.)*bullizard\.(?:com|gg)\b)\S+|\b(?!bullizard\b)[a-z][\w-]{2,}\.(?:com|net|org|io|gg|me|app|link|xyz|co|uk|de|eg|ru|ly|to|cc|su|biz|info|shop|store)(?:\/\S*)?(?=\s|$|[.,!?)])|\b(?!bullizard\b)[a-z]{2,}[\w-]*\.[a-z]{2,6}\/[\w\-./?=&%#]+/i],
  // @handles (an email's @ never follows whitespace or the start of the text).
  ['handle', /(?:^|[\s(])@[a-z0-9_.]{3,}/i],
  // Asking to be contacted somewhere else. Player IDs and usernames are not contacts: "my id: 512345" (a top-up),
  // "my username is X", "add me as friend in game", "hmu" on its own all pass.
  ['add_me', /\badd\s+me\s+(?:on|at|via)\s+(?!(?:steam|the\s+game|in\s*game|epic|battle\.?net|xbox|psn|playstation|riot|here)\b)\w+|\b(?:hit\s+me\s+up|hmu|dm\s+me|msg\s+me|message\s+me|text\s+me|contact\s+me|reach\s+me|find\s+me)\s+(?:on|at|via)\s+(?!(?:here|chat|this\s+chat|the\s+chat|bullizard|the\s+site|steam|the\s+game|in\s*game)\b)\w+|\bmy\s+(?:discord|telegram|whatsapp|insta|snap|handle|number|phone|cell|mobile)\s*(?:is|:)|ضيفني (?:على|ع) (?!اللعبة|الجيم)|كلمني على (?!هنا|الشات|المحادثة|الموقع)|تواصل معي على (?!هنا|الشات|المحادثة|الموقع)/i],
  // Recruiting sellers elsewhere, impersonating staff, dodging a ban (Support playbook). Impersonation needs a claim about
  // Bullizard or the site ("I'm the mod of our guild", "I am the official seller" are not).
  ['recruiting', /\b(?:work|sell|farm|trade)\s+(?:for|with)\s+me\b|\bjoin\s+my\s+(?:team|guild|server|group|shop)\b|\bi(?:'ll| will)\s+pay\s+you\s+(?:more|better)\b|\bbetter\s+(?:price|rate)\s+(?:outside|elsewhere|on)\b|اشتغل معايا|اشتغل معي|انضم (?:لفريقي|لسيرفري|لجروبي)/i],
  ['impersonation', /\b(?:i\s*am|i'm|im|this\s+is|we\s+are)\s+(?:a\s+|an\s+|the\s+|from\s+)?(?:bullizard|site|platform|marketplace)\s+(?:admin|administrator|moderator|mod|staff|support|arbiter|team|official)\b|\b(?:i\s*am|i'm|this\s+is)\s+(?:a\s+|an\s+|the\s+)?(?:admin|administrator|moderator|mod|staff|support|arbiter)\s+(?:of|from|at|for)\s+(?:bullizard|the\s+site|this\s+site|the\s+platform)\b|\bbullizard\s+(?:staff|support|admin|team|moderator)\s+here\b|\bofficial\s+bullizard\s+(?:staff|support|admin|team)\b|(?:أنا|انا)\s+(?:من\s+)?(?:فريق|دعم|أدمن|ادمن|مشرف|إدارة|ادارة)\s+(?:Bullizard|بوليزارد|الموقع|المنصة)/i],
  ['ban_dodging', /\b(?:my\s+)?(?:new|second|other|alt)\s+account\b.*\b(?:banned|suspended)\b|\b(?:banned|suspended)\b.*\b(?:new|second|other|alt)\s+account\b|حسابي (?:الجديد|التاني|الثاني).*(?:محظور|موقوف)|(?:محظور|موقوف).*حسابي (?:الجديد|التاني|الثاني)/i],
];

/**
 * Platform names spelled to dodge the filter: digit swaps (d1scord), look-alike letters (dіscord),
 * letters spaced or dotted out (d i s c o r d, dis.cord, what sa pp). Matched on WHOLE tokens only —
 * a token, or a run of adjacent tokens, must spell the name exactly once squashed — so ordinary
 * words that happen to contain one ("even more" ⊃ venmo, "gazelle" ⊃ zelle, "scene bad" ⊃ eneba)
 * never match.
 */
const DISGUISED_NAMES: Record<string, string> = {
  discord: 'discord', discordapp: 'discord',
  telegram: 'telegram',
  whatsapp: 'whatsapp',
  facebook: 'facebook', messenger: 'facebook',
  instagram: 'instagram',
  snapchat: 'other_messenger', viber: 'other_messenger', skype: 'other_messenger', wechat: 'other_messenger',
  paypal: 'external_payment', cashapp: 'external_payment', venmo: 'external_payment', zelle: 'external_payment', skrill: 'external_payment',
  vodafonecash: 'external_payment', instapay: 'external_payment', fawry: 'external_payment', orangecash: 'external_payment', etisalatcash: 'external_payment',
  watsapp: 'whatsapp',
  funpay: 'other_marketplace', playerauctions: 'other_marketplace', igvault: 'other_marketplace', kinguin: 'other_marketplace', eneba: 'other_marketplace',
};
const LONGEST_NAME = Math.max(...Object.keys(DISGUISED_NAMES).map((n) => n.length));
/** Cyrillic/Greek letters that look like Latin ones (dіscord with a Ukrainian і). */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ԁ: 'd', ѕ: 's', ԛ: 'q', ԝ: 'w', һ: 'h', ո: 'n', ⅼ: 'l', ɡ: 'g',
  α: 'a', ο: 'o', ρ: 'p', τ: 't', ν: 'v', ε: 'e', ι: 'i', κ: 'k', '０': '0', '１': '1', '３': '3', '４': '4', '５': '5', '７': '7',
};
const LEET_LETTERS: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'l' };
/** Lower-case, undo look-alikes and digit swaps, drop everything that is not a letter: "d.1.s c0rd" → "discord". */
export function squash(text: string) {
  return text
    .toLowerCase()
    .replace(/[\u0400-\u04ff\u0370-\u03ff\uff10-\uff19ԁѕԛԝһոⅼɡ]/g, (c) => HOMOGLYPHS[c] ?? c)
    .replace(/[013457@$!|]/g, (c) => LEET_LETTERS[c] ?? c)
    .replace(/[^\p{L}]+/gu, '');
}
/** Whitespace-separated tokens, squashed; empty ones (pure punctuation) dropped. */
const squashedTokens = (text: string) => text.split(/\s+/).map(squash).filter(Boolean);
/**
 * Categories whose name a token, or a run of adjacent tokens, spells exactly. `from` limits the runs to
 * those that use at least one token at index >= from (for split messages: the run must reach into the new line).
 */
function disguisedHits(tokens: string[], from = 0): string[] {
  const hits = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    let run = '';
    for (let j = i; j < tokens.length && run.length < LONGEST_NAME; j++) {
      run += tokens[j];
      if (j < from) continue;
      const cat = DISGUISED_NAMES[run];
      if (cat) hits.add(cat);
    }
  }
  return [...hits];
}

/** Platform names spelled across several short messages ("dis" then "cord"): the sender's recent lines joined with this one. */
export function detectSplit(previous: string[], body: string): string[] {
  const before = previous.flatMap(squashedTokens);
  const now = squashedTokens(body);
  if (!before.length || !now.length) return [];
  const own = new Set(disguisedHits(now));
  return disguisedHits([...before, ...now], before.length).filter((c) => !own.has(c));
}

/**
 * Names of the off-platform patterns a text matches (empty when clean). Email addresses are the
 * one thing an account order may carry (the credentials handover), so callers pass `allowEmail`
 * for those rooms.
 */
export function detectOffPlatform(body: string, opts: { allowEmail?: boolean; allowIds?: boolean } = {}): string[] {
  body = withoutLoginMethods(body);
  if (opts.allowIds) body = withoutPlayerIds(body);
  const emailRe = OFFPLATFORM_PATTERNS.find(([n]) => n === 'email')![1];
  // An email's domain is not a link on its own.
  const noEmails = body.replace(new RegExp(emailRe.source, 'g'), ' ');
  const hits = new Set(
    OFFPLATFORM_PATTERNS.filter(([name, re]) => !(opts.allowEmail && name === 'email') && re.test(name === 'link' ? noEmails : body)).map(([name]) => name),
  );
  for (const name of disguisedHits(squashedTokens(body))) hits.add(name);
  return [...hits];
}

const MESSENGERS = new Set(['discord', 'telegram', 'whatsapp', 'facebook', 'instagram', 'other_messenger']);
/** Links that open a chat or a payment page with someone: t.me/xyz, wa.me/…, paypal.me/x, discord.gg/…. */
const CONTACT_LINK = /\b(?:t\.me|telegram\.me|wa\.me|chat\.whatsapp\.com|m\.me|paypal\.me|cash\.app|discord\.gg|discord(?:app)?\.com\/invite|venmo\.com(?:\/u)?)\/[\w.@$-]+/i;
/** A messenger handle: @name, a Discord tag (name#1234), or "discord: name". */
const HANDLE = /(?:^|[\s(:])@[a-z0-9_.]{3,}|\b[\w.]{2,32}#\d{4}\b|\b(?:discord|telegram|tg|snap|snapchat|insta|instagram|whatsapp|skype|viber|wechat|kik)\s*:\s*@?[\w.#-]{3,}/i;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const WALLET = OFFPLATFORM_PATTERNS.find(([n]) => n === 'wallet_address')![1];
/**
 * A wallet address offered as the sender's own receiving address for a payment (Round 22b): an order to pay or send to it
 * ("send to 0x…", "pay me at T…", "send to my wallet 0x…", "ابعت على محفظتي …"). Past tense ("I sent USDT to …", "paid to
 * the address the site gave me: …") is a buyer asking about a payment and never matches. `<W>` stands for the address.
 */
const WALLET_OFFER = [
  /\b(?:send|pay|transfer|deposit)\b(?:\s+[\w$<>-]+){0,3}?\s+(?:to|at|on|into)\s+(?:(?:my|this|the\s+following)\s+(?:\w+\s+)?(?:wallet|address|addy)\s*(?:address\s*)?[:=-]?\s*)?<W>/i,
  /(?:ابعت|ابعتلي|ابعتها|حول|حوّل|حولي|حوللي|ادفع|ادفعلي)(?:\s+\S+){0,3}?\s+(?:على|ع|لـ?|في)\s+(?:(?:محفظتي|عنواني|المحفظة\s+دي|العنوان\s+ده)\s*[:=-]?\s*)?<W>/,
];

/**
 * The automatic-ban test for a wallet address (Round 22b). Addresses that are a NOWPayments deposit address of one of the
 * room's / user's orders (`ownAddresses`) never count; a remaining address bans only when offered for payment (WALLET_OFFER).
 */
function walletOffered(body: string, ownAddresses: string[] = []) {
  const ours = new Set(ownAddresses.map((a) => a.toLowerCase()));
  let foreign = false;
  const marked = body.replace(new RegExp(WALLET.source, 'g'), (a) => {
    if (ours.has(a.toLowerCase())) return ' <OURS> ';
    foreign = true;
    return ' <W> ';
  });
  return foreign && WALLET_OFFER.some((re) => re.test(marked.replace(/\s+/g, ' ')));
}

/**
 * The automatic filter decision (Round 22): every hit is blocked (not delivered) and goes to the staff queue; a staff member
 * confirms before any strike or ban. The only automatic ban is an unambiguous one:
 *  - a link that opens a chat or payment page (t.me/xyz, wa.me/…, paypal.me/x, discord.gg/…);
 *  - a full phone number together with a messenger or payment name ("whatsapp 0101234567", "my wats app is 0101234567");
 *  - a messenger handle with a messenger name ("telegram: @cheapgold", "discord pat#1234");
 *  - a payment name with an email or phone ("paypal me@x.com");
 *  - a crypto wallet address offered as the sender's receiving address ("send to 0x…", "pay me at T…"), never one of our own
 *    deposit addresses (`ownAddresses`) and never "I sent/paid to …" (Round 22b).
 * Split-message hits never count towards a ban.
 */
export function classify(violations: string[], opts: { split?: string[]; body?: string; ownAddresses?: string[] } = {}): 'ban' | 'queue' {
  const split = new Set(opts.split ?? []);
  const direct = new Set(violations.filter((v) => !split.has(v)));
  const body = opts.body ?? '';
  if (!direct.size) return 'queue';
  if (CONTACT_LINK.test(body)) return 'ban';
  const messenger = [...direct].some((v) => MESSENGERS.has(v));
  const payment = direct.has('external_payment');
  if ((messenger || payment) && direct.has('phone_number')) return 'ban';
  if (messenger && HANDLE.test(body)) return 'ban';
  if (payment && EMAIL.test(body)) return 'ban';
  if (direct.has('wallet_address') && walletOffered(body, opts.ownAddresses)) return 'ban';
  return 'queue';
}

/**
 * Rooms where the buyer gives a player ID / UID or a username for delivery (top-ups, in-game delivery): a labelled ID
 * ("id: 0123456789", "UID 0012345678", "الايدي 0101234567") is the delivery detail, not a phone number.
 */
const LABELLED_ID = /\b(?:player\s*id|game\s*id|user\s*id|uid|id|pubg\s*id|character\s*id)\s*(?:is|:|#|=)?\s*\d[\d\s-]{3,}\d|(?:الايدي|الآيدي|ايدي|آيدي|اي دي|الأيدي|الـ\s*UID|ال\s*UID|الـ\s*ID)\s*(?:is|:|=)?\s*[\d٠-٩][\d٠-٩\s-]{3,}/gi;
export const withoutPlayerIds = (body: string) => body.replace(LABELLED_ID, ' ');

/**
 * How an account signs in ("account linked to facebook", "connected to google", "الحساب مربوط بالفيسبوك") is a detail of the
 * account being sold, not an offer to talk on Facebook (Round 22b): dropped before the checks, in every room.
 */
const LOGIN_METHOD = /\b(?:linked|connected|bound|tied|attached|registered|signed\s+up)\s+(?:to|with|via|through)\s+(?:a\s+|an\s+|the\s+|my\s+)?(?:facebook|fb|google|gmail|apple(?:\s+id)?|twitter|x|vk|game\s*center|google\s+play|play\s+games)(?:\s+(?:account|login))?\b|(?:مربوط|مرتبط|متربط|متسجل)\s+(?:بـ?\s*|ب|على\s+|ع\s+)?(?:ال)?(?:فيسبوك|فيس\s+بوك|فيس|جوجل|جيميل|ابل|تويتر)/gi;
export const withoutLoginMethods = (body: string) => body.replace(LOGIN_METHOD, ' ');

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
