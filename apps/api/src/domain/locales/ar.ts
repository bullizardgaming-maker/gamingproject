import type { LocalePack } from './types.js';

const ar: LocalePack = {
  signoff: '— فريق Bullizard',
  manage: 'إدارة رسائل البريد',
  verifyCode: (code, minutes) => `رمز التحقق الخاص بك هو ${code}. ينتهي خلال ${minutes} دقيقة.`,
  templates: {
    order_paid: {
      subject: (d) => `استلمنا دفعتك مقابل ${d.title}`,
      body: (d, link, h) => `استلمنا ${h.money(d.amount_cents, d.currency)} مقابل «${d.title}». المبلغ محفوظ في الضمان ولن يحصل عليه البائع حتى تستلم طلبك.\n\nتتبّع الطلب: ${link(`/orders/${d.order_id}`)}`,
    },
    order_delivered: {
      subject: (d) => `تم التسليم: ${d.title}`,
      body: (d, link, h) =>
        `تم تسليم طلبك «${d.title}». افتح صفحة الطلب لرؤيته.\n\n` +
        (d.protection === 'insurance_14d'
          ? `هذا الحساب مشمول بتأمين الأصول لمدة 14 يومًا حتى ${h.when(d.protection_ends_at)}. أكمل قائمة الأمان الآن: غيّر كلمة المرور وبريد الاسترداد والمصادقة الثنائية.`
          : d.protection_ends_at
            ? `أمامك حتى ${h.when(d.protection_ends_at)} للتحقق منه. إن كان فيه خلل فافتح نزاعًا قبل ذلك.`
            : `تحقق منه ثم أكّد الطلب؛ لا يُدفع للبائع إلا عند تأكيدك. وإن كان فيه خلل فافتح نزاعًا بدلًا من ذلك.`) +
        `\n\n${link(`/orders/${d.order_id}`)}`,
    },
    order_refunded: {
      subject: (d) => `تم استرداد مبلغ ${d.title}`,
      body: (d, link, h) => `أُعيد ${h.money(d.amount_cents, d.currency)} إلى وسيلة الدفع الأصلية. يظهر استرداد البطاقات عادة خلال 5 إلى 10 أيام عمل.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    delivery_late: {
      subject: (d) => `طلبك متأخر: ${d.title}`,
      body: (d, link, h) =>
        `وعد البائع بالتسليم قبل ${h.when(d.delivery_due_at)} ولم يسلّم بعد. يمكنك الانتظار أو الإلغاء الآن واسترداد المبلغ كاملًا. ` +
        `إن لم يُسلَّم خلال ${d.auto_refund_hours} ساعة نعيد لك المال تلقائيًا.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    delivery_overdue: {
      subject: (d) => `متأخر: سلّم ${d.title} الآن`,
      body: (d, link, h) =>
        `وعدت بالتسليم قبل ${h.when(d.delivery_due_at)}. يمكن للمشتري الآن الإلغاء واسترداد المبلغ كاملًا، وسيُسترد تلقائيًا خلال ${d.auto_refund_hours} ساعة. ` +
        `التأخير يخفض نسبة التسليم في الوقت المحدد التي يراها المشترون في ملفك.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    referral_reward: {
      subject: (d, h) => `حصلت على رصيد ${h.money(d.amount_cents, d.currency)} في Bullizard`,
      body: (d, link, h) => `أكمل صديق دعوته أول طلب له. أصبح لديك رصيد ${h.money(d.amount_cents, d.currency)} يُخصم عند الدفع.\n\n${link('/account')}`,
    },
    protection_ending: {
      subject: (d) => `تبقّت 24 ساعة لفحص ${d.title}`,
      body: (d, link, h) => `سيحصل البائع على المال تلقائيًا في ${h.when(d.protection_ends_at)}. إن كان في طلبك خلل فافتح نزاعًا قبل ذلك.\n\n${link(`/orders/${d.order_id}`)}`,
    },
    seller_new_order: {
      subject: (d) => (d.delivery_mode === 'manual' ? `طلب جديد للتسليم: ${d.title}` : `تم البيع: ${d.title}`),
      body: (d, link, h) =>
        (d.delivery_mode === 'manual'
          ? `دفع مشترٍ ${h.money(d.amount_cents, d.currency)} مقابل «${d.title}» ×${d.quantity}. سلّمه من صفحة الطلب؛ يبقى المبلغ في الضمان حتى ذلك الحين.`
          : `بيع «${d.title}» ×${d.quantity} بمبلغ ${h.money(d.amount_cents, d.currency)} وسُلِّم تلقائيًا من مخزونك.`) +
        `\n\n${link(`/orders/${d.order_id}`)}`,
    },
    seller_paid: {
      subject: (d, h) => `أُضيف ${h.money(d.seller_net_cents, d.currency)} إلى رصيدك`,
      body: (d, link, h) => `اكتمل الطلب «${d.title}». أصبح ${h.money(d.seller_net_cents, d.currency)} في رصيدك وجاهزًا للسحب.\n\n${link('/sell')}`,
    },
    withdrawal_paid: {
      subject: (d, h) => `أُرسل سحب بقيمة ${h.money(d.amount_cents, d.currency)}`,
      body: (d, _link, h) => `أرسلنا ${h.money(d.amount_cents, d.currency)} إلى حساب السحب الخاص بك (المرجع ${d.provider_ref}).`,
    },
    dispute_opened: {
      subject: (d) => `فُتح نزاع على ${d.title}`,
      body: (d, link) => `فُتح نزاع: «${d.reason}». المبلغ مجمّد حتى يراجع المحكّم محادثة الطلب. أضف أي أدلة إلى المحادثة الآن.\n\n${link(`/orders/${d.order_id}`)}`,
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
    dispute_resolved: {
      subject: (d) => `حُسم النزاع: ${d.title}`,
      body: (d, link) => `قرر المحكّم لصالح ${d.outcome === 'buyer' ? 'المشتري' : 'البائع'}. ملاحظة: «${d.note}»\n\n${link(`/orders/${d.order_id}`)}`,
    },
    chargeback_received: {
      subject: (d) => `اعتراض بنكي على الطلب ${String(d.order_id).slice(0, 8)}`,
      body: (d, _link, h) =>
        `استرجع بنك المشتري ${h.money(d.amount_cents)} (${d.network} ${d.reason_code}). قدّمنا الأدلة تلقائيًا.\n\n` +
        (d.seller_protected ? 'درع الاسترداد البنكي يغطي هذا الطلب: رصيدك لا يتأثر.' : 'لم يكن لهذا العرض إثبات موثّق للمالك الأصلي، فخُصم المبلغ من رصيدك. إن حكم البنك لصالحنا يُعاد إليك.'),
    },
    kyc_result: {
      subject: (d) => (d.approved ? 'تم توثيق هويتك' : 'تعذّر توثيق هويتك'),
      body: (d, link) => (d.approved ? `يمكنك الآن نشر العروض واستخدام الواجهة البرمجية للبائعين والسحب.\n\n${link('/sell')}` : `يرجى المحاولة مجددًا بصورة واضحة لهوية سارية.\n\n${link('/account')}`),
    },
    new_signin: {
      subject: () => 'تسجيل دخول جديد إلى حسابك في Bullizard',
      body: (d, link, h) => `سُجّل الدخول إلى حسابك من جهاز جديد (${d.userAgent ?? 'متصفح غير معروف'}، IP ${d.ip ?? 'غير معروف'}) في ${h.when(d.at)}.\n\nلست أنت؟ غيّر كلمة المرور وسجّل الخروج من الأجهزة الأخرى: ${link('/account')}`,
    },
    password_reset: {
      subject: () => 'إعادة تعيين كلمة مرور Bullizard',
      body: (d) =>
        `طلب أحدهم إعادة تعيين كلمة مرور هذا الحساب${d.ip ? ` (من IP ${d.ip})` : ''}. استخدم هذا الرابط خلال ${d.minutes} دقيقة:\n\n${d.url}\n\n` +
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
      subject: (d, h) => `فشل سحب ${h.money(d.amount_cents, d.currency)}`,
      body: (d, link, h) => `تعذّر إرسال سحب ${h.money(d.amount_cents, d.currency)} (${d.reason}). عاد المبلغ إلى رصيدك. راجع حساب السحب: ${link('/sell')}`,
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
    saved_search_digest: {
      subject: (d) => `${d.count} عرض جديد لـ«${d.name}»`,
      body: (d, link, h) =>
        `الجديد منذ آخر بحث، الأرخص أولًا:\n\n${(d.top as any[]).map((o) => `- ${o.title}: ${h.money(o.price_cents, o.currency)}`).join('\n')}\n\nاعرض الكل (${d.count}): ${link(d.path)}\n\nغيّر هذا الملخص أو أوقفه من قائمة المتابعة: ${link('/watchlist')}`,
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
      subject: () => 'تم إيقاف تسجيل الدخول مؤقتًا بعد محاولات فاشلة',
      body: (d, link) => `حدثت ${d.failures} محاولات دخول فاشلة إلى حسابك، لذا أُوقف تسجيل الدخول لمدة ${d.minutes} دقيقة. إن لم تكن أنت فحسابك آمن، لكن ننصح بتفعيل المصادقة الثنائية. يمكنك أيضًا إعادة تعيين كلمة المرور الآن: ${link('/forgot-password')}`,
    },
  },
};
export default ar;
