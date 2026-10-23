// The 13 rules-test questions (Support playbook §9, migration 067), English + Arabic.
export const RULES_QUESTIONS = [
  {
    "position": 1,
    "question": "Where does all talk with a buyer happen?",
    "options": [
      "Discord",
      "WhatsApp after the first order",
      "The order chat on Bullizard",
      "Any app the buyer prefers"
    ],
    "correct": 2,
    "explanation": "The order chat is the record an arbiter reads. Sharing outside contacts can get your account banned right away.",
    "question_ar": "أين يتم كل التواصل مع المشتري؟",
    "options_ar": [
      "ديسكورد",
      "واتساب بعد أول طلب",
      "محادثة الطلب على Bullizard",
      "أي تطبيق يفضّله المشتري"
    ],
    "explanation_ar": "محادثة الطلب هي السجل الذي يقرؤه الحَكَم، ومشاركة وسائل تواصل خارجية قد تؤدي إلى حظر حسابك فورًا."
  },
  {
    "position": 2,
    "question": "A buyer asks for your Discord \"to speed things up\". You…",
    "options": [
      "Send it as an image so the filter misses it",
      "Reply in the order chat that everything stays on Bullizard",
      "Send it, they already paid",
      "Ignore the order"
    ],
    "correct": 1,
    "explanation": "Getting around the filter counts the same as sharing it.",
    "question_ar": "يطلب مشترٍ حسابك على ديسكورد «لتسريع الأمور». ماذا تفعل؟",
    "options_ar": [
      "ترسله كصورة حتى لا يكتشفه الفلتر",
      "ترد في محادثة الطلب بأن كل شيء يبقى على Bullizard",
      "ترسله لأنه دفع بالفعل",
      "تتجاهل الطلب"
    ],
    "explanation_ar": "التحايل على الفلتر يُحتسب كمشاركة مباشرة."
  },
  {
    "position": 3,
    "question": "What must you upload before marking an order delivered?",
    "options": [
      "Nothing",
      "A video or photo of the trade showing the character name and amount",
      "A screenshot of your stock before the trade",
      "A Discord chat log"
    ],
    "correct": 1,
    "explanation": "No proof, no payout. It's your evidence in a dispute.",
    "question_ar": "ماذا يجب أن ترفع قبل تسجيل الطلب كمسلَّم؟",
    "options_ar": [
      "لا شيء",
      "فيديو أو صورة للتريد يظهر فيها اسم الشخصية والكمية",
      "لقطة لمخزونك قبل التريد",
      "سجل محادثة من ديسكورد"
    ],
    "explanation_ar": "لا إثبات يعني لا أموال، وهو دليلك في أي نزاع."
  },
  {
    "position": 4,
    "question": "In the chat, the buyer asks you to deliver to a different character than the one on the order. You…",
    "options": [
      "Deliver to the new name",
      "Deliver half to each",
      "Deliver only to the name on the order; if it must change, the buyer contacts support",
      "Cancel the order yourself"
    ],
    "correct": 2,
    "explanation": "The name confirmed at checkout is the one you're protected for.",
    "question_ar": "يطلب المشتري في المحادثة التسليم إلى شخصية غير المسجّلة في الطلب. ماذا تفعل؟",
    "options_ar": [
      "تسلّم للاسم الجديد",
      "تسلّم نصف الكمية لكل اسم",
      "تسلّم فقط للاسم المسجّل في الطلب، وإن لزم التغيير يتواصل المشتري مع الدعم",
      "تلغي الطلب بنفسك"
    ],
    "explanation_ar": "الاسم المؤكَّد عند الدفع هو الاسم الذي تحميك عليه المنصة."
  },
  {
    "position": 5,
    "question": "When do you get paid?",
    "options": [
      "As soon as the buyer pays",
      "When you mark it delivered",
      "When the buyer confirms, or when staff release it after checking your proof",
      "Automatically after 72 hours"
    ],
    "correct": 2,
    "explanation": "There's no auto-release. Staff release never happens before 24 hours.",
    "question_ar": "متى تستلم أموالك؟",
    "options_ar": [
      "فور دفع المشتري",
      "عند تسجيل التسليم",
      "عند تأكيد المشتري، أو عندما يحرّر الفريق المبلغ بعد مراجعة إثباتك",
      "تلقائيًا بعد 72 ساعة"
    ],
    "explanation_ar": "لا يوجد تحرير تلقائي، ولا يحرّر الفريق المبلغ قبل 24 ساعة."
  },
  {
    "position": 6,
    "question": "Two days after delivery, the buyer still hasn't confirmed. You…",
    "options": [
      "Message them on Telegram",
      "Open a dispute",
      "Press \"Ask support to release\" on the order",
      "Post the order on Discord"
    ],
    "correct": 2,
    "explanation": "Staff check your proof and release it.",
    "question_ar": "مرّ يومان على التسليم ولم يؤكد المشتري. ماذا تفعل؟",
    "options_ar": [
      "تراسله على تيليجرام",
      "تفتح نزاعًا",
      "تضغط «اطلب من الدعم تحرير المبلغ» في صفحة الطلب",
      "تنشر الطلب في ديسكورد"
    ],
    "explanation_ar": "يراجع الفريق إثباتك ويحرّر المبلغ."
  },
  {
    "position": 7,
    "question": "Your price is $10 and your fee is 13.99%. How much do you earn?",
    "options": [
      "$10",
      "$8.60",
      "$11.63",
      "$9.40"
    ],
    "correct": 0,
    "explanation": "The fee is added on top for the buyer ($11.63). You earn your own price.",
    "question_ar": "سعرك 10$ والعمولة 13.99%. كم تربح؟",
    "options_ar": [
      "10$",
      "8.60$",
      "11.63$",
      "9.40$"
    ],
    "explanation_ar": "تُضاف العمولة فوق السعر على المشتري (11.63$)، وتربح سعرك كاملًا."
  },
  {
    "position": 8,
    "question": "A buyer says \"I paid, send it\" but the order shows \"Waiting for payment\". You…",
    "options": [
      "Deliver, buyers are honest",
      "Wait. Deliver only when the order shows Paid",
      "Deliver half",
      "Ask for a screenshot of the transfer and deliver"
    ],
    "correct": 1,
    "explanation": "Screenshots can be faked. Only the order status counts.",
    "question_ar": "يقول مشترٍ «دفعت، أرسل» لكن الطلب يظهر «بانتظار الدفع». ماذا تفعل؟",
    "options_ar": [
      "تسلّم، فالمشترون صادقون",
      "تنتظر، ولا تسلّم إلا عندما تظهر الحالة «مدفوع»",
      "تسلّم النصف",
      "تطلب لقطة للتحويل ثم تسلّم"
    ],
    "explanation_ar": "لقطات الشاشة يمكن تزويرها، والعبرة بحالة الطلب فقط."
  },
  {
    "position": 9,
    "question": "When must you verify your ID?",
    "options": [
      "Never",
      "Before your first offer",
      "Within 30 days of your first offer, or selling and withdrawals pause",
      "Only for withdrawals over $1,000"
    ],
    "correct": 2,
    "explanation": "You have 30 days from your first offer; after that selling and withdrawals pause until it's done.",
    "question_ar": "متى يجب أن توثّق هويتك؟",
    "options_ar": [
      "أبدًا",
      "قبل أول عرض",
      "خلال 30 يومًا من أول عرض، وإلا يتوقف البيع والسحب",
      "فقط للسحوبات فوق 1,000$"
    ],
    "explanation_ar": "لديك 30 يومًا من أول عرض، وبعدها يتوقف البيع والسحب حتى تكمله."
  },
  {
    "position": 10,
    "question": "Can you sell a game that isn't on Bullizard's list?",
    "options": [
      "Yes, under \"Other\"",
      "Yes, in the offer note",
      "No. Only listed games. Vote for the one you want",
      "Yes, if the buyer asks"
    ],
    "correct": 2,
    "explanation": "Only listed games can be sold; vote for the one you want.",
    "question_ar": "هل يمكنك بيع لعبة غير موجودة في قائمة Bullizard؟",
    "options_ar": [
      "نعم تحت «أخرى»",
      "نعم في ملاحظة العرض",
      "لا، فقط الألعاب المدرجة، وصوّت للعبة التي تريدها",
      "نعم إن طلب المشتري"
    ],
    "explanation_ar": "تُباع الألعاب المدرجة فقط، وصوّت للعبة التي تريدها."
  },
  {
    "position": 11,
    "question": "A buyer opens a dispute. Your best move?",
    "options": [
      "Argue with them in DMs",
      "Add your proof and a clear statement in the order; the arbiter decides",
      "Refund them outside Bullizard",
      "Leave the chat"
    ],
    "correct": 1,
    "explanation": "The arbiter reads the order chat, your proof and your statement.",
    "question_ar": "فتح مشترٍ نزاعًا. ما أفضل تصرّف؟",
    "options_ar": [
      "تجادله في الخاص",
      "تضيف إثباتك وأقوالك بوضوح في الطلب، والحَكَم يقرر",
      "تعيد له المبلغ خارج Bullizard",
      "تغادر المحادثة"
    ],
    "explanation_ar": "يقرأ الحَكَم محادثة الطلب وإثباتك وأقوالك."
  },
  {
    "position": 12,
    "question": "A buyer offers 10% extra if you deliver now and they pay you later by PayPal. You…",
    "options": [
      "Accept, 10% is 10%",
      "Accept, but ask for half first",
      "Refuse and report the chat",
      "Ask for crypto instead of PayPal"
    ],
    "correct": 2,
    "explanation": "Off-platform payment is the #1 scam. It also breaks the rules.",
    "question_ar": "يعرض مشترٍ 10% إضافية إذا سلّمت الآن ودفع لاحقًا عبر PayPal. ماذا تفعل؟",
    "options_ar": [
      "تقبل، 10% مكسب",
      "تقبل وتطلب النصف أولًا",
      "ترفض وتبلّغ عن المحادثة",
      "تطلب كريبتو بدل PayPal"
    ],
    "explanation_ar": "الدفع خارج المنصة أشهر طرق الاحتيال، ويخالف القوانين."
  },
  {
    "position": 13,
    "question": "What can happen if you break the rules?",
    "options": [
      "Nothing for the first month",
      "Only a warning, ever",
      "Warning → listing ban → account ban → frozen balance. Sharing outside contacts can mean a ban right away",
      "A small fine"
    ],
    "correct": 2,
    "explanation": "The penalty ladder applies to every seller; outside contact can be a ban right away.",
    "question_ar": "ماذا يحدث إذا خالفت القوانين؟",
    "options_ar": [
      "لا شيء في الشهر الأول",
      "تحذير فقط دائمًا",
      "تحذير ← منع العروض ← حظر الحساب ← تجميد الرصيد، ومشاركة وسائل تواصل خارجية قد تعني حظرًا فوريًا",
      "غرامة بسيطة"
    ],
    "explanation_ar": "سلّم العقوبات ينطبق على كل بائع، ومشاركة وسائل تواصل خارجية قد تعني حظرًا فوريًا."
  }
];
