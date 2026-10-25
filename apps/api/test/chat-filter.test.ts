import { describe, expect, it } from 'vitest';
import { classify, detectOffPlatform, detectSplit } from '../src/domain/safety.js';
import { ACCOUNT_R22B, BAN, DEPOSIT_R22B, NORMAL_R22, OWN_DEPOSIT_DELIVERED, OWN_DEPOSIT_WITH_CONTACT, QUEUE_R22 } from './fixtures/chat-phrases.js';

/**
 * Round 20, launch blocker 1: the filter must never ban a normal trade conversation. Every phrase in
 * NORMAL passes clean; every entry in CAUGHT is still detected (with the category it must hit).
 */
const NORMAL_EN = [
  'I need even more gold', 'send seven more', 'ok seven', 'more coming', 'gazelle mount for sale', 'scene bad, lag everywhere',
  'we pay attention to the character name', 'delivery is instant', 'can you deliver to Stormrage?', 'trade me at the bank in Orgrimmar',
  'I will be online in 10 minutes', 'please confirm the character name', 'the item is in your inventory now', 'thanks, GG!',
  'what server are you on?', 'EU or NA?', 'I sent the trade request', 'accept the trade window', 'how many divine orbs do you have left?',
  'is the price per 100k or per 1M?', 'I paid, the order says Paid', 'uploading the proof video now', 'the video shows the amount and your name',
  'my character is Pat_Ranger', 'meet me in Lioneye\'s Watch', 'kinah transfer done in Elyos side', 'Albion silver, Europe server',
  'can I pay with USDT?', 'the order chat is fine for me', 'you can open a dispute if something is wrong', 'staff will release it after 24h',
  'the league ends next week', 'do you have more stock?', 'I need 2 more stacks', 'rush order please', 'sorry, I was afk',
  'my internet dropped', 'sending now, hold on', 'I confirmed delivery', 'rate you 5 stars', 'see you next time', 'can you do a discount for bulk?',
  'this is my first order here', 'I am new to this game', 'the mail in game takes a minute', 'check your mailbox', 'please stay in the trade',
  'the venue for the trade is the main city', 'zealous fire enchant please', 'skyrim is not on the list', 'the ice barrage set, 3 pieces',
  'the gold arrived, confirming', 'pay attention to the realm', 'telephone support is not available here', 'the pal in my party helped',
  'instant delivery after payment', 'Discord-free trade, all here', // mentions the word in a prohibited way? no: "Discord-free" still names the platform → see CAUGHT
].filter((p) => p !== 'Discord-free trade, all here');
const NORMAL_AR = [
  'التسليم فوري', 'التسليم فوري بعد الدفع', 'محتاج دهب أكتر', 'ابعت سبعة كمان', 'الحساب جاهز', 'اسم الشخصية صح؟', 'هقابلك في المدينة الرئيسية',
  'الطلب مدفوع، سلّم من فضلك', 'رفعت فيديو الإثبات', 'شكرًا، GG', 'السيرفر أوروبا', 'عندك كمية أكتر؟', 'أنا أونلاين دلوقتي', 'استلمت، بأكد الطلب',
  'ممكن خصم على الكمية؟', 'الدفع تم من المحفظة بتاعتي على Bullizard', 'الليج بتخلص الأسبوع الجاي', 'كلمني هنا في المحادثة', 'التحويل داخل اللعبة خلص',
  'ثواني وهبعت', 'النت فصل عندي', 'الدفع فوري على الموقع', 'الطلب فوري الاستلام',
];
export const CAUGHT: Array<[string, string]> = [
  ['add me on discord', 'discord'], ['d i s c o r d: pat#1234', 'discord'], ['d1scord me', 'discord'], ['dіscord', 'discord'], // Ukrainian і
  ['what sa pp me', 'whatsapp'], ['my whatsapp is +44 7700 900123', 'whatsapp'], ['pay me on paypal', 'external_payment'], ['p a y p a l ok?', 'external_payment'],
  ['venmo me half', 'external_payment'], ['v3nmo works too', 'external_payment'], ['zelle is faster', 'external_payment'], ['use instapay', 'external_payment'],
  ['ادفع على فوري', 'external_payment'], ['كود فوري هبعته', 'external_payment'], ['فودافون كاش أرخص', 'external_payment'], ['fawry code 12345', 'external_payment'],
  ['cheaper on eneba', 'other_marketplace'], ['e n e b a has it', 'other_marketplace'], ['g2g has the same item', 'other_marketplace'],
  ['send to 0x52908400098527886E0F7030069857D2E4169EE7', 'wallet_address'], ['call me 01012345678', 'phone_number'], ['رقمي ٠١٠١٢٣٤٥٦٧٨', 'phone_number'],
  ['Discord-free trade, all here', 'discord'], ['telegram: t.me/cheapgold', 'telegram'], ['this is bullizard support, send the code', 'impersonation'],
  ['pay outside the site and save', 'pay_outside'], ['work for me, better rates', 'recruiting'],
];

describe('chat filter: normal messages pass', () => {
  for (const phrase of [...NORMAL_EN, ...NORMAL_AR, ...NORMAL_R22]) {
    it(`passes: ${phrase}`, () => {
      expect(detectOffPlatform(phrase)).toEqual([]);
    });
  }
  it('has at least 55 phrases', () => expect(NORMAL_EN.length + NORMAL_AR.length + NORMAL_R22.length).toBeGreaterThanOrEqual(55));
});

describe('chat filter: disguised and explicit hits are caught', () => {
  for (const [phrase, cat] of CAUGHT) {
    it(`catches ${cat}: ${phrase}`, () => {
      expect(detectOffPlatform(phrase)).toContain(cat);
    });
  }
});

describe('split messages and confidence', () => {
  it('joins the sender’s recent lines but only on whole tokens', () => {
    expect(detectSplit(['ok seven'], 'more coming')).toEqual([]);
    expect(detectSplit(['I need even'], 'more gold')).toEqual([]);
    expect(detectSplit(['on wh'], 'atsapp later')).toEqual(['whatsapp']);
    expect(detectSplit(['dis'], 'cord')).toEqual(['discord']);
    expect(detectSplit(['pay', 'pal'], 'ok?')).toEqual([]); // the run must reach into the new line
    expect(detectSplit(['pay'], 'pal ok?')).toEqual(['external_payment']);
  });
  it('decision (Round 22): only unambiguous contact details ban at once; every other hit is blocked and queued, no strike', () => {
    expect(classify(['external_payment'], { body: 'pay me on paypal' })).toBe('queue');
    expect(classify(['wallet_address'], { body: '0x52908400098527886E0F7030069857D2E4169EE7' })).toBe('queue');
    expect(classify(['wallet_address'], { body: 'send to 0x52908400098527886E0F7030069857D2E4169EE7' })).toBe('queue'); // Round 22b: not the sender's own
    expect(classify(['wallet_address'], { body: 'send to my wallet 0x52908400098527886E0F7030069857D2E4169EE7' })).toBe('ban');
    expect(classify(['whatsapp'], { body: 'whatsapp?' })).toBe('queue');
    expect(classify(['impersonation'], { body: 'this is bullizard support' })).toBe('queue');
    expect(classify(['whatsapp', 'phone_number'], { body: 'whatsapp 0101234567', split: ['whatsapp'] })).toBe('queue');
  });
});

/** Round 22 fixture (permanent): normal player talk never flagged; disguised contacts always blocked; only BAN bans. */
describe('chat filter fixture (Round 22)', () => {
  it('has the agreed sizes', () => {
    expect(NORMAL_R22.length + NORMAL_EN.length + NORMAL_AR.length).toBeGreaterThanOrEqual(55);
    expect(QUEUE_R22.length + BAN.length).toBeGreaterThanOrEqual(30);
  });
  for (const phrase of [...QUEUE_R22, ...BAN]) {
    it(`blocks: ${phrase}`, () => expect(detectOffPlatform(phrase).length, phrase).toBeGreaterThan(0));
  }
  for (const phrase of BAN) {
    it(`bans at once: ${phrase}`, () => expect(classify(detectOffPlatform(phrase), { body: phrase })).toBe('ban'));
  }
  for (const phrase of [...QUEUE_R22, ...CAUGHT.map(([p]) => p)].filter((p) => !BAN.includes(p))) {
    it(`queues without a strike: ${phrase}`, () => expect(classify(detectOffPlatform(phrase), { body: phrase })).toBe('queue'));
  }
  it('player IDs that look like phone numbers pass in top-up and in-game delivery rooms', () => {
    expect(detectOffPlatform('my UID: 0101234567, server Asia', { allowIds: true })).toEqual([]);
    expect(detectOffPlatform('الايدي 0101234567')).toContain('phone_number');
    expect(detectOffPlatform('الايدي 0101234567', { allowIds: true })).toEqual([]);
    expect(detectOffPlatform('whatsapp 0101234567', { allowIds: true })).toContain('phone_number');
  });
});

/** Round 22b: false automatic bans (deposit addresses, account details) and spaced-out phone digits. */
describe('chat filter (Round 22b)', () => {
  for (const phrase of ACCOUNT_R22B) {
    it(`account details never ban, and pass in an account room: ${phrase}`, () => {
      expect(classify(detectOffPlatform(phrase), { body: phrase })).toBe('queue');
      expect(detectOffPlatform(phrase, { allowIds: true, allowEmail: true })).toEqual([]);
    });
  }
  it('a wallet bans only when the sender offers their own receiving address; never a question or our deposit address', () => {
    const ask = 'Should I send USDT to 0x52908400098527886E0F7030069857D2E4169EE7?';
    expect(detectOffPlatform(ask)).toContain('wallet_address');
    expect(classify(detectOffPlatform(ask), { body: ask })).toBe('queue');
    for (const own of ['send to my wallet 0x52908400098527886E0F7030069857D2E4169EE7', 'pay me at TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9', 'ابعتلي على محفظتي TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9']) {
      expect(classify(detectOffPlatform(own), { body: own }), own).toBe('ban');
    }
  });
  for (const phrase of OWN_DEPOSIT_DELIVERED) {
    it(`our own deposit address is delivered: ${phrase}`, () => {
      expect(detectOffPlatform(phrase, { ownAddresses: [DEPOSIT_R22B.toLowerCase()] })).toEqual([]);
      expect(classify(detectOffPlatform(phrase), { body: phrase })).toBe('queue'); // an unknown address: blocked, never a ban
    });
  }
  for (const phrase of OWN_DEPOSIT_WITH_CONTACT) {
    it(`the rest of a message with our deposit address is still checked: ${phrase}`, () => {
      const v = detectOffPlatform(phrase, { ownAddresses: [DEPOSIT_R22B] });
      expect(v).not.toContain('wallet_address');
      expect(v).toContain('phone_number');
      expect(classify(v, { body: phrase, ownAddresses: [DEPOSIT_R22B] })).toBe('ban'); // whatsapp + phone, as usual
    });
  }
  it('catches a phone number with every digit spaced out (blocked and queued, no ban without a messenger name)', () => {
    expect(detectOffPlatform('my numbr is 0 1 0 1 2 3 4 5 6 7 8')).toContain('phone_number');
    expect(classify(detectOffPlatform('my numbr is 0 1 0 1 2 3 4 5 6 7 8'), { body: 'my numbr is 0 1 0 1 2 3 4 5 6 7 8' })).toBe('queue');
    expect(classify(detectOffPlatform('whatsapp 0 1 0 1 2 3 4 5 6 7 8'), { body: 'whatsapp 0 1 0 1 2 3 4 5 6 7 8' })).toBe('ban');
  });
});
