import { arDuration, type LocalePack } from './types.js';

const ar: LocalePack = {
  layout: { greeting: "أهلًا {name}،", greetingNoName: "أهلًا،", signoff: "فريق Bullizard", why: "تصلك هذه الرسالة لأن لديك حسابًا في Bullizard.", safety: "لن نطلب منك كلمة المرور أو الرموز عبر البريد أبدًا.", manage: "إعدادات البريد", legal: "Bullizard · للبالغين 18+ فقط · غير تابع لأي ناشر ألعاب", button: "افتح Bullizard" },
  verifySubject: (code) => `رمز Bullizard الخاص بك: ${code}`,
  verifyCode: (code, minutes) => `رمزك هو ${code}، وهو صالح لمدة ${arDuration(minutes)}. إن لم تطلبه فتجاهل هذه الرسالة.`,
  duration: (minutes) => arDuration(minutes),
  withdrawalReasons: { unsupported_coin: "السحب بعملة USDT فقط. أضف عنوان USDT (TRC-20 أو BEP-20) وحاول مجددًا.", not_approved: "لم تتم الموافقة عليه. تواصل مع الدعم إن احتجت التفاصيل.", provider_failed: "رفضته شبكة الدفع. راجع عنوانك وحاول مجددًا." },
  templates: {
    order_paid: {
      subject: (d) => `وصل الدفع. ${d.order_ref ?? d.title} عند البائع`,
      body: (d, link, h) => `استلمنا ${h.money(d.amount_cents, d.currency)} مقابل ${d.title} وهو محجوز لدينا. يسلّم البائع إلى ${d.character ?? 'شخصيتك'} داخل اللعبة ويرفع الفيديو، ولا يصله شيء قبل مراجعة هذا الفيديو.\n\nتابع طلبك: ${link(`/orders/${d.order_id}`)}\n\n${d.tos_version ? `الشروط (الإصدار ${d.tos_version}) المقبولة لهذا الطلب` : 'الشروط المقبولة لهذا الطلب'}: ${link('/terms')}`,
    },
    welcome: {
      subject: () => 'حسابك في Bullizard جاهز',
      body: (_d, link) => `أهلًا بك. Bullizard مكانك للذهب والآيتمز والشحن التي لا تريد أن تفرمها، في Aion وAion 2 وAlbion Online ولعبتي Path of Exile.\n\nعندما تشتري تبقى أموالك عندنا. يسلّم البائع لشخصيتك ويصوّر التريد ويرفعه، ويراجع إنسانٌ هذا الفيديو، أنت أو فريقنا، قبل أن يصل أي شيء للبائع.\n\nقاعدة واحدة لا نتساهل فيها: كل كلمة في الصفقة تبقى في محادثة الطلب، ومشاركة وسائل تواصل خارجية قد تؤدي إلى حظر الحساب فورًا.\n\nاختر لعبتك: ${link('/games')}`,
    },
    seller_new_order: {
      subject: (d) => `طلب جديد: سلّم إلى ${d.character ?? 'المشتري'}`,
      body: (d, link) => `تم دفع ${d.title}${d.quantity ? ` ×${d.quantity}` : ''} وهو بانتظارك. سلّم إلى ${d.character ?? 'المشتري'} داخل اللعبة، وصوّر التريد بحيث يظهر الاسم والكمية، ثم ارفعه على الطلب. تستلم أموالك عند تأكيد الطلب.\n\nافتح الطلب: ${link(`/orders/${d.order_id}`)}`,
    },
    order_delivered: {
      subject: () => 'تم التسليم. افحص حقيبتك',
      body: (d, link) => `يقول البائع إن ${d.title} تم ورفع الفيديو. ادخل اللعبة وافحص شخصيتك، ثم أكّد من صفحة الطلب. إن كان هناك أي خلل فافتح نزاعًا بدل التأكيد.\n\nتحقق وأكّد: ${link(`/orders/${d.order_id}`)}`,
    },
    order_completed: {
      subject: () => 'اكتمل الطلب. استمتع بالغنيمة',
      body: (d, link) => `اكتمل ${d.title} واستلم البائع أمواله. ثلاثون ثانية لتقييمه تساعد المشتري التالي على اختيار البائع المناسب.\n\nقيّم البائع: ${link(`/orders/${d.order_id}`)}`,
    },
    seller_paid: {
      subject: (d, h) => `وصل ${h.money(d.seller_net_cents, d.currency)} إلى رصيدك`,
      body: (d, link, h) => `اكتمل ${d.order_ref ?? d.title}، و${h.money(d.seller_net_cents, d.currency)} أصبح لك وجاهزًا للسحب.\n\nافتح المحفظة: ${link('/sell/money')}`,
    },
    dispute_opened: {
      subject: (d) => `الطلب ${d.order_ref ?? d.title} مجمّد`,
      body: (d, link) => `تم فتح نزاع على ${d.title}: «${d.reason}». يبقى المبلغ مجمّدًا بينما يراجع حَكَم من Bullizard الطلب. الحَكَم يقرأ محادثة الطلب والإثبات، فضع فيها الآن كل ما تريده أن يراه.\n\nافتح الطلب: ${link(`/orders/${d.order_id}`)}`,
    },
    dispute_resolved: {
      subject: (d) => `قرار الحَكَم في ${d.order_ref ?? d.title}`,
      body: (d, link) => `${d.for_you ? 'قرر الحَكَم لصالحك.' : 'قرر الحَكَم لصالح الطرف الآخر.'} ${d.result ?? ''} ملاحظة الحَكَم: «${d.note}»\n\nافتح الطلب: ${link(`/orders/${d.order_id}`)}`,
    },
    withdrawal_requested: {
      subject: (d, h) => `استلمنا طلب سحب ${h.money(d.amount_cents, d.currency)}`,
      body: (d, link, h) => `سنرسل ${h.money(d.net_cents, d.currency)} إلى عنوانك على ${d.coin} بعد خصم رسوم ${h.money(d.fee_cents, d.currency)} وبعد الموافقة، وعادةً يستغرق ذلك حتى 3 أيام عمل. لم تطلب هذا؟ غيّر كلمة المرور الآن.\n\nعرض المحفظة: ${link('/sell/money')}`,
    },
    withdrawal_paid: {
      subject: (d, h) => `أُرسل ${h.money(d.net_cents ?? d.amount_cents, d.currency)} على الشبكة`,
      body: (d, link, h) => `${h.money(d.net_cents ?? d.amount_cents, d.currency)} في طريقه إلى ${d.address ?? 'عنوان السحب'}. المعاملة: ${d.tx ?? d.provider_ref ?? 'قيد الإرسال'}. حسب الشبكة، قد يستغرق ظهوره في محفظتك بضع دقائق.\n\nعرض المحفظة: ${link('/sell/money')}`,
    },
    order_refunded: {
      subject: (d) => `استرداد ${d.title}`,
      body: (d, link, h) => `عاد ${h.money(d.amount_cents, d.currency)} إلى رصيدك في Bullizard. استخدمه عند الدفع أو اسحبه.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    delivery_late: {
      subject: (d) => `طلبك متأخر: ${d.title}`,
      body: (d, link) => `انتهت مدة التسليم لدى البائع. ذكّره في محادثة الطلب أو افتح نزاعًا.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    delivery_overdue: {
      subject: (d) => `متأخر: سلّم ${d.title} الآن`,
      body: (d, link) => `انتهت مدة تسليم ${d.title}. سلّم الآن، فالمشتري يمكنه فتح نزاع، والتأخير يخفض نسبة تسليمك في الموعد.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    kyc_due_reminder: {
      subject: (d) => (Number(d.days_left) <= 0 ? 'البيع متوقف حتى توثّق هويتك' : `الأيام المتبقية لتوثيق هويتك: ${d.days_left}`),
      body: (d, link, h) =>
        (Number(d.days_left) <= 0
          ? 'انتهت مهلة الـ 30 يومًا، فتوقف البيع والسحب. وثّق هويتك ويعود الاثنان للعمل، وعروضك ورصيدك محفوظة في هذه الأثناء.'
          : `موعد توثيق هويتك قبل ${h.when(d.date)}، ويستغرق نحو خمس دقائق: هوية بصورة وفيديو سيلفي قصير. إن فاتك الموعد يتوقف البيع والسحب حتى تكمله.`) +
        `\n\nوثّق الآن: ${link('/account')}`,
    },
    referral_earned: {
      subject: (d, h) => `دعواتك ربحت ${h.money(d.amount_cents, d.currency)}`,
      body: (d, link, h) => `أكمل أصدقاؤك الذين دعوتهم طلبات عددها ${d.count}. حصتك ${d.rate_pct}% من عمولتنا، أي ${h.money(d.amount_cents, d.currency)}، في رصيدك الآن، وتستمر على كل طلب يكملونه طالما بقوا نشطين.\n\nشارك رابطك: ${link('/account#invite')}`,
    },
    legal_change: {
      subject: (d, h) => `تغيير في ${d.title} اعتبارًا من ${h.when(d.effective_at)}`,
      body: (d, link, h) => `حدّثنا ${d.title} (الإصدار ${d.version}). يسري الإصدار الجديد في ${h.when(d.effective_at)}، وسنطلب منك قبوله عند تسجيل الدخول التالي بعد ذلك. اقرأه الآن: ${link(`/${d.doc}`)}`,
    },
    kyc_result: {
      subject: (d) => (d.approved ? 'تم توثيق هويتك' : 'لم نتمكن من توثيق هويتك'),
      body: (d, link) => (d.approved ? `تم توثيقك. البيع والسحب متاحان.\n\n${link('/sell')}` : `حاول مجددًا بصورة واضحة لهوية سارية.\n\n${link('/account')}`),
    },
    protection_ending: {
      subject: (d) => `تبقّت 24 ساعة لفحص ${d.title}`,
      body: (d, link, h) => `سيحصل البائع على المال تلقائيًا في ${h.when(d.protection_ends_at)}. إن كان في طلبك خلل فافتح نزاعًا قبل ذلك.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    dispute_statement: {
      subject: () => 'بيان جديد في نزاعك',
      body: (d, link) => `أضاف ${d.role === 'buyer' ? 'المشتري' : 'البائع'} بيانًا إلى النزاع. اقرأه ورُدّ في محادثة الطلب أو ببيانك قبل أن يقرر المحكّم.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    warranty_claim: {
      subject: (d) => `مطالبة ضمان على ${d.title}`,
      body: (d, link) => {
        const r = ({ recovered: "أن صاحب الحساب الأصلي استعاده", banned: "أن الحساب حُظر", locked: "أن الحساب مقفل" } as Record<string, string>)[d.reason as string] ?? "أن الحساب توقف عن العمل";
        return `يقول المشتري ${r}. أمامك ${d.hours} ساعة لإصلاح المشكلة أو رد المبلغ أو الاعتراض؛ بعدها يقرر محكّم. يبقى مبلغ هذا الطلب معلقًا حتى تُحسم المطالبة.\n\n${link(`/orders/${d.order_id}`)}`;
      },
    },
    warranty_update: {
      subject: (d) => `تحديث مطالبة الضمان: ${d.title}`,
      body: (d, link) => {
        const b = d.role === 'buyer';
        const m: Record<string, string> = { seller_fixed: b ? "يقول البائع إن الحساب يعمل مجددًا. أكّد ذلك، أو أرسل المطالبة إلى محكّم إن لم يعمل." : "أبلغت عن إصلاح. أمام المشتري 72 ساعة للتأكيد.", escalated: "انتقلت المطالبة إلى محكّم سيقرأ محادثة الطلب ويقرر.", resolved: "حُسمت المطالبة: الحساب يعمل مجددًا.", refunded: b ? "استرددت مبلغك بموجب الضمان." : "رُدّ للمشتري مبلغه بموجب الضمان من المبلغ المعلق لهذا الطلب.", rejected: "رفض محكّم المطالبة.", withdrawn: "سحب المشتري المطالبة." };
        return `${m[d.status as string] ?? "حُدّثت المطالبة."}\n\n${link(`/orders/${d.order_id}`)}`;
      },
    },
    order_progress: {
      subject: (d) => `اكتمل ${d.percent}%: ${d.title}`,
      body: (d, link) => `نشر البائع تقدّمًا في «${d.title}»: ${d.percent}%${d.note ? `. «${d.note}»` : '.'}\n\n${link(`/orders/${d.order_id}`)}`,
    },
    chargeback_received: {
      subject: (d) => `اعتراض بنكي على الطلب ${String(d.order_id).slice(0, 8)}`,
      body: (d, _link, h) =>
        `استرجع بنك المشتري ${h.money(d.amount_cents)} (${d.network} ${d.reason_code}). قدّمنا الأدلة تلقائيًا.\n\n` +
        (d.seller_protected ? 'درع الاسترداد البنكي يغطي هذا الطلب: رصيدك لا يتأثر.' : 'لم يكن لهذا العرض إثبات موثّق للمالك الأصلي، فخُصم المبلغ من رصيدك. إن حكم البنك لصالحنا يُعاد إليك.'),
    },
    new_signin: {
      subject: () => 'تسجيل دخول جديد إلى حسابك في Bullizard',
      body: (d, link, h) => `سُجّل الدخول إلى حسابك من جهاز جديد (${d.userAgent ?? 'متصفح غير معروف'}، IP ${d.ip ?? 'غير معروف'}) في ${h.when(d.at)}.\n\nلست أنت؟ غيّر كلمة المرور وسجّل الخروج من الأجهزة الأخرى: ${link('/account')}`,
    },
    password_reset: {
      subject: () => 'إعادة تعيين كلمة مرور Bullizard',
      body: (d, _link, h) =>
        `طلب أحدهم إعادة تعيين كلمة مرور هذا الحساب${d.ip ? ` (من IP ${d.ip})` : ''}. استخدم هذا الرابط خلال ${h.duration(Number(d.minutes))}:\n\n${d.url}\n\n` +
        `إن لم تطلب ذلك فتجاهل هذه الرسالة؛ كلمة مرورك لن تتغير.`,
    },
    new_review: {
      subject: (d) => `تقييم جديد بـ ${d.rating} نجوم`,
      body: (d, link) => `قيّم مشترٍ الطلب «${d.title}» بـ ${d.rating}/5${d.comment ? `: «${d.comment}»` : '.'}\n\nيمكنك نشر رد علني واحد: ${link('/sell')}`,
    },
    password_changed: {
      subject: () => 'تم تغيير كلمة مرورك',
      body: (_d, link) => `تم تغيير كلمة مرورك وتسجيل الخروج من أجهزتك الأخرى. لست أنت؟ أعد تعيين كلمة المرور فورًا: ${link('/account')}`,
    },
    mfa_changed: {
      subject: (d) => (d.enabled ? 'تم تفعيل المصادقة الثنائية' : 'تم إيقاف المصادقة الثنائية'),
      body: (d, link) => `${d.enabled ? 'فُعّلت' : 'أُوقفت'} المصادقة الثنائية لحسابك وسُجّل الخروج من الأجهزة الأخرى. لست أنت؟ ${link('/account')}`,
    },
    session_reuse_detected: {
      subject: () => 'سجّلنا الخروج من جهاز قد يكون مخترقًا',
      body: (d, link) => `استُخدم رمز دخول أحد أجهزتك (${d.userAgent ?? 'متصفح غير معروف'}) مرتين، وهذا يعني غالبًا أنه نُسخ. سجّلنا خروج ذلك الجهاز. غيّر كلمة المرور إن لم تتوقع ذلك: ${link('/account')}`,
    },
    clawback: {
      subject: (d) => `استرداد بعد الصرف: ${d.title}`,
      body: (d, link, h) =>
        `بعد مراجعة الطلب «${d.title}» أعدنا المبلغ للمشتري (${d.reason}). خُصمت حصتك، ${h.money(d.amount_cents, d.currency)}، من رصيدك؛ وإن صار رصيدك أقل من صفر تُسترد من مبيعاتك القادمة. أُعيدت العمولة أيضًا (إشعار دائن ${d.credit_note}).\n\n${link(`/orders/${d.order_id}`)}`,
    },
    withdrawal_failed: {
      subject: (d, h) => `لم يُرسَل سحب ${h.money(d.amount_cents, d.currency)}`,
      body: (d, link, h) => `تعذّر إرسال سحبك بقيمة ${h.money(d.amount_cents, d.currency)}. ${h.reason(d.reason)} عاد المبلغ إلى رصيدك.\n\nافتح المحفظة: ${link('/sell/money')}`,
    },
    invoice_issued: {
      subject: (d) => `فاتورة العمولة ${d.number}`,
      body: (d, link, h) => `الفاتورة ${d.number} للفترة ${d.period} جاهزة: العمولة ${h.money(d.gross_cents, d.currency)}، منها ضريبة ${h.money(d.tax_cents, d.currency)}. وقد خُصمت مسبقًا من مبيعاتك.\n\n${link('/sell/invoices')}`,
    },
    debt_reminder: {
      subject: (d, h) => (d.first ? `رصيدك ${h.money(-d.amount_cents, d.currency)}` : `تذكير: عليك ${h.money(d.amount_cents, d.currency)}`),
      body: (d, link, h) =>
        `رصيدك في Bullizard أقل من صفر بمقدار ${h.money(d.amount_cents, d.currency)} بعد استرداد أو اعتراض بنكي. تسدّده المبيعات الجديدة تلقائيًا، أو يمكنك دفعه الآن بالبطاقة. ` +
        `السحب متوقف حتى السداد، وإن بقي غير مسدّد في ${h.when(d.pause_at)} سيُوقف متجرك مؤقتًا.\n\n${link('/sell/money')}`,
    },
    debt_shop_paused: {
      subject: () => 'متجرك متوقف مؤقتًا حتى سداد رصيدك',
      body: (d, link, h) =>
        `ما زال رصيدك أقل من صفر بمقدار ${h.money(d.amount_cents, d.currency)}، لذا أُخفيت عروضك ولا يمكن شراؤها. الطلبات المدفوعة مسبقًا ما زالت تحتاج إلى التسليم. ` +
        `ادفع الرصيد لإعادة فتح متجرك فورًا.\n\n${link('/sell/money')}`,
    },
    debt_cleared: {
      subject: () => 'تمت تسوية رصيدك',
      body: (d, link) => `عاد رصيدك بعملة ${d.currency} فوق الصفر${d.reason === 'written_off' ? ' (شطبنا المتبقي)' : ''}. ${d.resumed ? 'أُعيد فتح متجرك. ' : ''}السحب متاح كالمعتاد.\n\n${link('/sell/money')}`,
    },
    watch_price_drop: {
      subject: (d, h) => `انخفاض السعر: ${d.title} أصبح ${h.money(d.price_cents, d.currency)}`,
      body: (d, link, h) =>
        `أصبح سعر ${d.title} ${h.money(d.price_cents, d.currency)}${d.target_cents ? `، عند هدفك ${h.money(d.target_cents, d.currency)} أو أقل` : '، أقل مما كان عند بدء المتابعة'}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    watch_back_in_stock: {
      subject: (d) => `عاد إلى المخزون: ${d.title}`,
      body: (d, link, h) => `${d.title} متوفر مجددًا بسعر ${h.money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    watch_game_low: {
      subject: (d, h) => `${d.game}${d.attributes && Object.keys(d.attributes).length ? ` (${Object.values(d.attributes).join('، ')})` : ''}: ابتداءً من ${h.money(d.price_cents, d.currency)}`,
      body: (d, link, h) =>
        `عرض في ${d.game} تتابعه ${d.target_cents ? `عند هدفك ${h.money(d.target_cents, d.currency)} أو أقل` : 'بأدنى سعر جديد'}: «${d.title}» بسعر ${h.money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    request_posted: {
      subject: (d) => `طلب جديد في ${d.game}: «${d.title}»`,
      body: (d, link, h) => `يبحث مشترٍ عن «${d.title}»${d.budget_cents ? ` بميزانية ${h.money(d.budget_cents, d.currency)}` : ''}. أنت تبيع في ${d.game}، فقد يكون لديك ما يحتاجه. أرسل سعرًا ومدة تسليم.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    request_proposal: {
      subject: (d) => `${d.revised ? 'عرض محدَّث' : 'عرض جديد'} لـ«${d.title}»`,
      body: (d, link, h) => `يعرض ${d.seller_name} مبلغ ${h.money(d.price_cents, d.currency)} مع التسليم خلال ${d.delivery_hours} ساعة. اقبله لإتمام الدفع؛ يُحفظ مبلغك في الضمان كأي طلب.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    request_accepted: {
      subject: (d) => `قُبل عرضك: ${d.title}`,
      body: (d, link, h) => `قبل المشتري عرضك بقيمة ${h.money(d.price_cents, d.currency)}. أنشأنا له عرضًا خاصًا، وسيصلك إشعار الطلب الجديد المعتاد فور دفعه.\n\n${link(`/requests/${d.request_id}`)}`,
    },
    listing_review: {
      subject: () => 'عرضك قيد المراجعة',
      body: (d, link) => `يذكر ${d.title ? `«${d.title}»` : 'عرضك'} شيئًا تطلب قواعدنا التحقق منه (سلع محظورة أو بيانات تواصل)، لذا أُخفي حتى يراجعه مشرف، عادةً خلال ساعات قليلة. سنبلغك بالنتيجة في الحالتين.\n\n${link('/sell')}`,
    },
    listing_approved: {
      subject: (d) => `تمت الموافقة على العرض: ${d.title}`,
      body: (d, link) => `وافق مشرف على «${d.title}» وأصبح متاحًا من جديد.\n\n${link(`/offers/${d.offer_id}`)}`,
    },
    listing_rejected: {
      subject: (d) => `أُزيل العرض: ${d.title}`,
      body: (d, link) => `أزال مشرف «${d.title}»: ${d.note}\n\nيمكنك نشر عرض جديد يلتزم بالقواعد. راسل الدعم إن كنت ترى أن هذا خطأ.\n\n${link('/support/new?category=selling')}`,
    },
    support_received: {
      subject: (d) => `استلمنا طلبك رقم ${d.number}`,
      body: (d, link) => `شكرًا لتواصلك بخصوص «${d.subject}». يرد فريق الدعم عادة خلال ساعات قليلة، وستصلك رسالة عند الرد.\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    support_reply: {
      subject: (d) => (d.resolved ? `تم حل الطلب رقم ${d.number}` : `رد جديد على الطلب رقم ${d.number}`),
      body: (d, link) =>
        `ردّ دعم Bullizard على «${d.subject}»${d.resolved ? ' وعلّمه كمحلول. رُدّ إن كنت ما زلت تحتاج مساعدة وسيُعاد فتحه' : ''}:\n\n${d.preview}\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    support_auto_resolved: {
      subject: (d) => `أُغلق الطلب رقم ${d.number}`,
      body: (d, link) => `لم يصلنا رد بخصوص «${d.subject}» منذ ${d.days} أيام، لذا علّمناه كمحلول. رُدّ في أي وقت لإعادة فتحه.\n\n${link(`/support/${d.ticket_id}`)}`,
    },
    account_locked: {
      subject: () => 'أوقفنا تسجيل الدخول مؤقتًا بعد محاولات فاشلة',
      body: (d, link, h) =>
        `حاول أحدهم الدخول إلى حسابك وأخطأ في كلمة المرور، وعدد المحاولات: ${d.failures}، لذا أوقفنا تسجيل الدخول لمدة ${h.duration(Number(d.minutes))}. إن كنت أنت فانتظر أو أعد تعيين كلمة المرور. وإن لم تكن أنت فحسابك ما زال آمنًا، وفعّل المصادقة الثنائية ليبقى كذلك.\n\nإعادة تعيين كلمة المرور: ${link('/forgot-password')}`,
    },
  },
};
export default ar;
