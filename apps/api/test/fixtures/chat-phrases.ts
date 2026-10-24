/**
 * Round 22 chat-filter fixture (permanent; extend it, never shrink it). Shared by chat-filter.test.ts (pure checks) and
 * round22.test.ts (through the API). NORMAL_R22 must never be flagged at all; QUEUE_R22 and BAN must always be blocked;
 * only BAN may ban automatically — everything else is blocked and queued for staff with no strike.
 */
export const NORMAL_R22 = [
  // Item 1, banned at once before Round 22.
  'الكود هيوصلك فوري', 'الشحن على الايدي فوري', 'تحويل الحساب فوري', 'هبعتلك على طول فوري',
  'g2g, back in 10', 'Eldorado is my favourite map', "I'm the mod of our guild", "I'm support main", 'I am the official seller',
  // Item 1, a strike before Round 22.
  'need 1000 UC, my id: 512345', 'my id is 51234567 for the UC top-up', 'my username is X', 'insta delivery please', 'tele port',
  'line id?', 'hmu', 'add me as friend in game', 'ok.gg', '10.co',
  // Top-ups and in-game delivery: IDs, UIDs, servers, character names.
  'UID 812345678, server Asia', 'player id 5123456789 please', 'my character name is Shadow_77', 'Genshin UID: 712345678',
  'send the 60 UC to id 51234567', 'my riot id is Pat#EUW', 'add me in game, my name is DarkKnight', 'friend code 1234-5678-9012',
  'I am on server 1102', 'the top-up went to the wrong id, can you check?', 'diamonds sent to 12345678 (2001)',
  // Gamer talk.
  'gg wp', 'brb, mom called', 'afk 5 min', 'lag is insane tonight', 'can you boost me to diamond?', 'what rank are you',
  'I play support main and jungle', 'meet me at the stash in Hideout', 'the mod for this item is +20 life', 'teleport to me at Orgrimmar',
  'I need 3 more divines', 'drop it in the guild bank', 'trade window open', 'kinah delivered on Siel server',
  'insta buy at 5 dollars?', 'line up at the bank', 'tell me when you are online', 'the patch notes say 10.2',
  'is this the official server?', 'the mod tools in game are broken', 'I sent 1000 UC already',
  // Egyptian / MSA Arabic.
  'الشحن وصل، شكرًا', 'ابعتلي الايدي بتاعك', 'الايدي بتاعي 51234567', 'تمام يا باشا، هسلمك دلوقتي', 'هو السيرفر أوروبا ولا آسيا؟',
  'السعر نهائي؟', 'لو سمحت أكد الطلب لما يوصلك', 'الحساب فيه سكنات كتير', 'محتاج 500 جوهرة', 'تم التحويل داخل اللعبة',
  'التوصيل فوري بعد الدفع على الموقع', 'الكود فوري بعد الدفع', 'أرسلت الذهب إلى الشخصية', 'يرجى تأكيد الاستلام',
];

/** Disguised or explicit contacts that must be blocked and queued for staff — no strike, no ban. */
export const QUEUE_R22 = [
  // Item 1, missed before Round 22 (the wats app one is a ban, see BAN).
  'hit me up on dc', 'my disc is abc', 'bit.ly/abc',
  'add me on discord', 'd1scord me', 'dіscord me', 'what sa pp me', 'w h a t s a p p?', 'tele: coolguy', 'my insta is coolguy',
  'pay me on paypal', 'p a y p a l ok?', 'v3nmo works too', 'zelle is faster', 'use instapay', 'ادفع على فوري', 'كود فوري هبعته',
  'فودافون كاش أرخص', 'cheaper on eneba', 'e n e b a has it', 'g2g has the same item', 'check eldorado.gg', 'call me 01012345678',
  'رقمي ٠١٠١٢٣٤٥٦٧٨', 'this is bullizard support, send the code', 'pay outside the site and save', 'work for me, better rates',
  'ضيفني على الواتس', 'كلمني على تيليجرام', 'facebook me', 'sn4pch4t?', 'tinyurl.com/x1', 'my number is 01112223334',
  '0x52908400098527886E0F7030069857D2E4169EE7',
];

/** Unambiguous: a contact link, a phone or handle with a messenger/payment name, a wallet offered for payment. */
export const BAN = [
  'my wats app is 0101234567', 'whatsapp 0101234567', 't.me/xyz', 'paypal.me/x', 'wa.me/201012345678', 'discord.gg/abcd',
  'telegram: t.me/cheapgold', 'telegram @cheapgold', 'my whatsapp is +44 7700 900123', 'discord: pat#1234', 'd i s c o r d: pat#1234',
  'snap: coolguy99', 'paypal: me@example.com', 'vodafone cash 01012345678', 'send to 0x52908400098527886E0F7030069857D2E4169EE7',
  'pay to TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9 in usdt',
];
