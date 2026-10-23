-- Round 19 (Oct 24): legal documents, sign-up acceptance, Arabic rules test with the 13 launch
-- questions (pass mark 90%), split dispute decisions, listing bans, appeal tickets, the Support
-- Lead flag, referral activity window (30 days) and the launch moderation ladder.

-- Legal documents: every version of every public document, with its hash; the web shows version
-- and date on each page and /terms/history. TOS_VERSION comes from the current `terms` row.
CREATE TABLE legal_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc          text NOT NULL CHECK (doc IN ('terms', 'privacy', 'seller-agreement', 'refunds', 'restricted-countries')),
  locale       text NOT NULL DEFAULT 'en',
  version      text NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  title        text NOT NULL,
  content_md   text NOT NULL,
  sha256       text NOT NULL,
  -- A material change: users are told 14 days ahead and must accept again at their next sign-in.
  material     boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc, locale, version)
);
CREATE INDEX legal_documents_current_idx ON legal_documents (doc, locale, effective_at DESC);

INSERT INTO legal_documents (doc, version, title, content_md, sha256) VALUES
  ('terms', '2026-10-24', 'Terms of Service',
   E'# Terms of Service\n\nInterim summary until the approved text is loaded (Ops → Legal).\n\n- You must be 18 or older to use Bullizard.\n- You are responsible for the character name or ID you give at checkout.\n- All communication and payment stays on Bullizard. Sharing outside contacts can get your account banned right away.\n- The seller is paid when you confirm delivery; staff may release an unconfirmed order 24 hours after delivery with proof.\n- Underpayments are kept in your balance and are never refunded.\n- Refunds decided in a dispute go to your Bullizard balance.\n- Bullizard is not responsible for game bans or publisher actions.\n- Payments are in crypto through NOWPayments.\n- Referral and creator earnings are a share of Bullizard''s commission and can be changed or stopped by Bullizard.',
   encode(sha256(convert_to('terms:2026-10-24', 'UTF8')), 'hex')),
  ('privacy', '2026-10-24', 'Privacy Policy',
   E'# Privacy Policy\n\nInterim summary until the approved text is loaded.\n\n- Identity checks run through our KYC partner; we keep the result, not your documents.\n- Order chats are encrypted and hash-chained; they are kept for disputes and deleted on the retention schedule.\n- We use one essential cookie for sign-in and no analytics cookies.\n- You can export or delete your data from your account page.',
   encode(sha256(convert_to('privacy:2026-10-24', 'UTF8')), 'hex')),
  ('seller-agreement', '2026-10-24', 'Seller Agreement',
   E'# Seller Agreement\n\nInterim summary until the approved text is loaded.\n\n- Pass the rules test before your first offer; verify your ID within 30 days (you may withdraw meanwhile).\n- Upload proof of every delivery before marking it delivered.\n- Bot-farmed currency is banned.\n- Commission is added on top of your price by rank (Hatchling 13.99% → Dragon 9.99% on 30-day sales); 5% for your first 60 days.\n- Withdrawal fee 6%, minimum $1.50.\n- Penalties: warning → listing ban → account ban → frozen balance.',
   encode(sha256(convert_to('seller-agreement:2026-10-24', 'UTF8')), 'hex')),
  ('refunds', '2026-10-24', 'Refund & Dispute Policy',
   E'# Refund & Dispute Policy\n\nInterim summary until the approved text is loaded.\n\n- No order is cancelled or refunded automatically.\n- Open a dispute before you confirm; 48 hours for evidence, a decision within 72 hours, one appeal.\n- Refunds go to your Bullizard balance; withdrawing them costs the normal 6% (minimum $1.50).\n- Buyer Protection: the seller is paid only after the delivery is confirmed or checked by staff.',
   encode(sha256(convert_to('refunds:2026-10-24', 'UTF8')), 'hex')),
  ('restricted-countries', '2026-10-24', 'Restricted countries',
   E'# Restricted countries\n\nInterim list until the approved text is loaded. Bullizard is not available where crypto payments or our services are not permitted; the approved list will be published here.',
   encode(sha256(convert_to('restricted-countries:2026-10-24', 'UTF8')), 'hex'));

-- Sign-up acceptance (18+ and Terms + Privacy).
ALTER TABLE users
  ADD COLUMN tos_version     text,
  ADD COLUMN tos_accepted_at timestamptz,
  -- Listing ban: the seller keeps the account but can't create or relist offers.
  ADD COLUMN listing_banned_at timestamptz,
  ADD COLUMN listing_ban_reason text;

-- Rules test in Arabic too; 13 launch questions; pass mark 90% (one mistake allowed).
ALTER TABLE rules_questions
  ADD COLUMN question_ar    text,
  ADD COLUMN options_ar     jsonb,
  ADD COLUMN explanation_ar text;
UPDATE rules_questions SET active = false;
UPDATE rules_settings SET pass_mark_pct = 90, updated_at = now();
INSERT INTO rules_questions (position, question, options, correct, explanation, question_ar, options_ar, explanation_ar) VALUES
  (1, 'Where does all talk with a buyer happen?',
      '["Discord", "WhatsApp after the first order", "The order chat on Bullizard", "Any app the buyer prefers"]', 2,
      'The order chat is the record an arbiter reads. Sharing outside contacts can get your account banned right away.',
      'أين يتم كل التواصل مع المشتري؟',
      '["ديسكورد", "واتساب بعد أول طلب", "محادثة الطلب على Bullizard", "أي تطبيق يفضّله المشتري"]',
      'محادثة الطلب هي السجل الذي يقرؤه الحَكَم، ومشاركة وسائل تواصل خارجية قد تؤدي إلى حظر حسابك فورًا.'),
  (2, 'A buyer asks for your Discord "to speed things up". You…',
      '["Send it as an image so the filter misses it", "Reply in the order chat that everything stays on Bullizard", "Send it, they already paid", "Ignore the order"]', 1,
      'Getting around the filter counts the same as sharing it.',
      'يطلب مشترٍ حسابك على ديسكورد «لتسريع الأمور». ماذا تفعل؟',
      '["ترسله كصورة حتى لا يكتشفه الفلتر", "ترد في محادثة الطلب بأن كل شيء يبقى على Bullizard", "ترسله لأنه دفع بالفعل", "تتجاهل الطلب"]',
      'التحايل على الفلتر يُحتسب كمشاركة مباشرة.'),
  (3, 'What must you upload before marking an order delivered?',
      '["Nothing", "A video or photo of the trade showing the character name and amount", "A screenshot of your stock before the trade", "A Discord chat log"]', 1,
      'No proof, no payout. It''s your evidence in a dispute.',
      'ماذا يجب أن ترفع قبل تسجيل الطلب كمسلَّم؟',
      '["لا شيء", "فيديو أو صورة للتريد يظهر فيها اسم الشخصية والكمية", "لقطة لمخزونك قبل التريد", "سجل محادثة من ديسكورد"]',
      'لا إثبات يعني لا أموال، وهو دليلك في أي نزاع.'),
  (4, 'In the chat, the buyer asks you to deliver to a different character than the one on the order. You…',
      '["Deliver to the new name", "Deliver half to each", "Deliver only to the name on the order; if it must change, the buyer contacts support", "Cancel the order yourself"]', 2,
      'The name confirmed at checkout is the one you''re protected for.',
      'يطلب المشتري في المحادثة التسليم إلى شخصية غير المسجّلة في الطلب. ماذا تفعل؟',
      '["تسلّم للاسم الجديد", "تسلّم نصف الكمية لكل اسم", "تسلّم فقط للاسم المسجّل في الطلب، وإن لزم التغيير يتواصل المشتري مع الدعم", "تلغي الطلب بنفسك"]',
      'الاسم المؤكَّد عند الدفع هو الاسم الذي تحميك عليه المنصة.'),
  (5, 'When do you get paid?',
      '["As soon as the buyer pays", "When you mark it delivered", "When the buyer confirms, or when staff release it after checking your proof", "Automatically after 72 hours"]', 2,
      'There''s no auto-release. Staff release never happens before 24 hours.',
      'متى تستلم أموالك؟',
      '["فور دفع المشتري", "عند تسجيل التسليم", "عند تأكيد المشتري، أو عندما يحرّر الفريق المبلغ بعد مراجعة إثباتك", "تلقائيًا بعد 72 ساعة"]',
      'لا يوجد تحرير تلقائي، ولا يحرّر الفريق المبلغ قبل 24 ساعة.'),
  (6, 'Two days after delivery, the buyer still hasn''t confirmed. You…',
      '["Message them on Telegram", "Open a dispute", "Press \"Ask support to release\" on the order", "Post the order on Discord"]', 2,
      'Staff check your proof and release it.',
      'مرّ يومان على التسليم ولم يؤكد المشتري. ماذا تفعل؟',
      '["تراسله على تيليجرام", "تفتح نزاعًا", "تضغط «اطلب من الدعم تحرير المبلغ» في صفحة الطلب", "تنشر الطلب في ديسكورد"]',
      'يراجع الفريق إثباتك ويحرّر المبلغ.'),
  (7, 'Your price is $10 and your fee is 13.99%. How much do you earn?',
      '["$10", "$8.60", "$11.63", "$9.40"]', 0,
      'The fee is added on top for the buyer ($11.63). You earn your own price.',
      'سعرك 10$ والعمولة 13.99%. كم تربح؟',
      '["10$", "8.60$", "11.63$", "9.40$"]',
      'تُضاف العمولة فوق السعر على المشتري (11.63$)، وتربح سعرك كاملًا.'),
  (8, 'A buyer says "I paid, send it" but the order shows "Waiting for payment". You…',
      '["Deliver, buyers are honest", "Wait. Deliver only when the order shows Paid", "Deliver half", "Ask for a screenshot of the transfer and deliver"]', 1,
      'Screenshots can be faked. Only the order status counts.',
      'يقول مشترٍ «دفعت، أرسل» لكن الطلب يظهر «بانتظار الدفع». ماذا تفعل؟',
      '["تسلّم، فالمشترون صادقون", "تنتظر، ولا تسلّم إلا عندما تظهر الحالة «مدفوع»", "تسلّم النصف", "تطلب لقطة للتحويل ثم تسلّم"]',
      'لقطات الشاشة يمكن تزويرها، والعبرة بحالة الطلب فقط.'),
  (9, 'When must you verify your ID?',
      '["Never", "Before your first offer", "Within 30 days of your first offer, or selling and withdrawals pause", "Only for withdrawals over $1,000"]', 2,
      'You have 30 days from your first offer; after that selling and withdrawals pause until it''s done.',
      'متى يجب أن توثّق هويتك؟',
      '["أبدًا", "قبل أول عرض", "خلال 30 يومًا من أول عرض، وإلا يتوقف البيع والسحب", "فقط للسحوبات فوق 1,000$"]',
      'لديك 30 يومًا من أول عرض، وبعدها يتوقف البيع والسحب حتى تكمله.'),
  (10, 'Can you sell a game that isn''t on Bullizard''s list?',
      '["Yes, under \"Other\"", "Yes, in the offer note", "No. Only listed games. Vote for the one you want", "Yes, if the buyer asks"]', 2,
      'Only listed games can be sold; vote for the one you want.',
      'هل يمكنك بيع لعبة غير موجودة في قائمة Bullizard؟',
      '["نعم تحت «أخرى»", "نعم في ملاحظة العرض", "لا، فقط الألعاب المدرجة، وصوّت للعبة التي تريدها", "نعم إن طلب المشتري"]',
      'تُباع الألعاب المدرجة فقط، وصوّت للعبة التي تريدها.'),
  (11, 'A buyer opens a dispute. Your best move?',
      '["Argue with them in DMs", "Add your proof and a clear statement in the order; the arbiter decides", "Refund them outside Bullizard", "Leave the chat"]', 1,
      'The arbiter reads the order chat, your proof and your statement.',
      'فتح مشترٍ نزاعًا. ما أفضل تصرّف؟',
      '["تجادله في الخاص", "تضيف إثباتك وأقوالك بوضوح في الطلب، والحَكَم يقرر", "تعيد له المبلغ خارج Bullizard", "تغادر المحادثة"]',
      'يقرأ الحَكَم محادثة الطلب وإثباتك وأقوالك.'),
  (12, 'A buyer offers 10% extra if you deliver now and they pay you later by PayPal. You…',
      '["Accept, 10% is 10%", "Accept, but ask for half first", "Refuse and report the chat", "Ask for crypto instead of PayPal"]', 2,
      'Off-platform payment is the #1 scam. It also breaks the rules.',
      'يعرض مشترٍ 10% إضافية إذا سلّمت الآن ودفع لاحقًا عبر PayPal. ماذا تفعل؟',
      '["تقبل، 10% مكسب", "تقبل وتطلب النصف أولًا", "ترفض وتبلّغ عن المحادثة", "تطلب كريبتو بدل PayPal"]',
      'الدفع خارج المنصة أشهر طرق الاحتيال، ويخالف القوانين.'),
  (13, 'What can happen if you break the rules?',
      '["Nothing for the first month", "Only a warning, ever", "Warning → listing ban → account ban → frozen balance. Sharing outside contacts can mean a ban right away", "A small fine"]', 2,
      'The penalty ladder applies to every seller; outside contact can be a ban right away.',
      'ماذا يحدث إذا خالفت القوانين؟',
      '["لا شيء في الشهر الأول", "تحذير فقط دائمًا", "تحذير ← منع العروض ← حظر الحساب ← تجميد الرصيد، ومشاركة وسائل تواصل خارجية قد تعني حظرًا فوريًا", "غرامة بسيطة"]',
      'سلّم العقوبات ينطبق على كل بائع، ومشاركة وسائل تواصل خارجية قد تعني حظرًا فوريًا.');

-- Split dispute decisions: part of the escrow back to the buyer's balance, the rest to the seller.
ALTER TABLE disputes DROP CONSTRAINT disputes_status_check;
ALTER TABLE disputes ADD CONSTRAINT disputes_status_check CHECK (status IN ('open', 'resolved_buyer', 'resolved_seller', 'resolved_split'));
ALTER TABLE disputes ADD COLUMN refund_cents bigint;

-- Appeals get their own ticket category.
ALTER TABLE support_tickets DROP CONSTRAINT support_tickets_category_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_category_check CHECK (category IN ('order', 'payment', 'account', 'selling', 'report', 'appeal', 'other'));

-- Referral: "active" = a completed order in the last 30 days. Moderation ladder: warn → suspend → ban.
UPDATE referral_settings SET active_days = 30, updated_at = now();
UPDATE moderation_settings SET offplatform_actions = '{warn,suspend,ban}', updated_at = now();

-- Site text for the chat safety panel (copy deck §2.8), English and Arabic.
UPDATE site_texts SET body = 'Keep the whole trade in this chat. Deals made anywhere else aren''t held or protected. Sharing outside contacts can get your account banned right away. The seller is paid when the buyer confirms, or after staff check the proof. Something wrong? Open a dispute from the order page.', updated_at = now()
 WHERE key = 'chat_safety' AND locale = 'en';
INSERT INTO site_texts (key, locale, body, link_label, link_href)
 VALUES ('chat_safety', 'ar', 'أبقِ التريد كله في هذه المحادثة، فالصفقات خارجها غير محجوزة وغير محمية. مشاركة وسائل تواصل خارجية قد تؤدي إلى حظر حسابك فورًا. يستلم البائع أمواله عند تأكيد المشتري أو بعد مراجعة فريقنا للإثبات. في مشكلة؟ افتح نزاعًا من صفحة الطلب.', 'القواعد والسياسات', '/help/report-a-user')
 ON CONFLICT (key, locale) DO UPDATE SET body = EXCLUDED.body, updated_at = now();
