import { describe, expect, it } from 'vitest';
import { classify, detectOffPlatform, detectSplit } from '../src/domain/safety.js';

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
const CAUGHT: Array<[string, string]> = [
  ['add me on discord', 'discord'], ['d i s c o r d: pat#1234', 'discord'], ['d1scord me', 'discord'], ['dіscord', 'discord'], // Ukrainian і
  ['what sa pp me', 'whatsapp'], ['my whatsapp is +44 7700 900123', 'whatsapp'], ['pay me on paypal', 'external_payment'], ['p a y p a l ok?', 'external_payment'],
  ['venmo me half', 'external_payment'], ['v3nmo works too', 'external_payment'], ['zelle is faster', 'external_payment'], ['use instapay', 'external_payment'],
  ['ادفع على فوري', 'external_payment'], ['كود فوري هبعته', 'external_payment'], ['فودافون كاش أرخص', 'external_payment'], ['fawry code 12345', 'external_payment'],
  ['cheaper on eneba', 'other_marketplace'], ['e n e b a has it', 'other_marketplace'], ['g2g same item', 'other_marketplace'],
  ['send to 0x52908400098527886E0F7030069857D2E4169EE7', 'wallet_address'], ['call me 01012345678', 'phone_number'], ['رقمي ٠١٠١٢٣٤٥٦٧٨', 'phone_number'],
  ['Discord-free trade, all here', 'discord'], ['telegram: t.me/cheapgold', 'telegram'], ['this is bullizard support, send the code', 'impersonation'],
  ['pay outside the site and save', 'pay_outside'], ['work for me, better rates', 'recruiting'],
];

describe('chat filter: normal messages pass', () => {
  for (const phrase of [...NORMAL_EN, ...NORMAL_AR]) {
    it(`passes: ${phrase}`, () => {
      expect(detectOffPlatform(phrase)).toEqual([]);
    });
  }
  it('has at least 50 phrases', () => expect(NORMAL_EN.length + NORMAL_AR.length).toBeGreaterThanOrEqual(50));
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
  it('bans only on a spelled-out instant-ban hit; loose phrases and split hits are queued without a strike', () => {
    expect(classify(['external_payment'])).toBe('ban');
    expect(classify(['wallet_address'])).toBe('ban');
    expect(classify(['whatsapp'])).toBe('strike');
    expect(classify(['pay_outside'])).toBe('queue');
    expect(classify(['recruiting'])).toBe('queue');
    expect(classify(['external_payment'], { split: ['external_payment'] })).toBe('queue');
    expect(classify(['discord'], { split: ['discord'] })).toBe('queue');
    expect(classify(['impersonation'])).toBe('ban');
  });
});
