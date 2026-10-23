# Bullizard Copy Deck v1 (EN + AR) — copied from the project doc `claude/bullizard-copy-deck.md` (Copywriter, 2026-10-23)

Copy the strings by **key** into `apps/web/src/i18n/en.ts` + `ar.ts` (or `ar.seller.ts` where the key already lives there). `[NEW]` = key doesn't exist yet. `[CHANGE]` = key exists, text changes. Keys not listed keep their current text; keys under §0.4 get hidden or deleted.

## 0.2 Arabic rules
- Site, checkout, money, rules, errors, emails: simple Modern Standard Arabic.
- Gamer words stay as players say them: فارم، آيتمز، دروب، تريد، سيرفر، ليج، أورب. Game names, coin names and networks stay in English.
- Brand name in running text: **Bullizard** (Latin).
- Numbers, prices, order IDs, character names: Western digits, wrapped `dir="ltr"`.
- Counts: where a string has a count it is written as **label: {n}** (e.g. «العروض: {n}») so one form works. Use the `_one/_other` keys only in English.

## 0.4 Hide or delete at launch (front end)
These keys describe things Bullizard doesn't do at launch. Hide the UI that uses them (or delete the strings):
- Payments by card / on-chain escrow: `offer.card`, `offer.crypto`, `offer.wallet`, `offer.escrow14`, `offer.escrow72`, `offer.tos` (CEO: no checkbox), `order.rail.*`, `order.crypto.*`, `escrow.cardOrUsdc`, `escrow.refundedToCard`, `footer.cardLine`, `home.shield*`, `order.status.charged_back`, `orders.status.charged_back`, `ostatus.charged_back`, `sell.ordersLine2` (chargebacks part), `trust.req.chargebacks`, `buyerRep.chargebacks`.
- 72h window / 14-day insurance / accounts / keys / boosting: `protect.inspection`, `protect.noProof`, `protect.verified`, `badge.insurance`, `badge.inspection`, `badge.highRisk`, `badge.ownerVerified`, `trust.instant*`, `trust.insurance*`, `home.window*`, `home.instant*`, `home.verified*`, `home.highRiskNote`, `game.protect14`, `game.protect72`, `order.window14`, `order.window72`, `order.changeover*`, `order.handover.*`, `order.releaseEarly`, `order.warranty.*`, `order.claim*`, `warranty.*`, `linked.*`, `boost.*`, `bundle.*`, `sell.proof.*`, `sell.addProof`, `sell.upload*`, `sell.f.auto`, `sell.f.accountHint`, `cat.accounts*`, `cat.boosting*`, `cat.keys*`, `cat.gift-cards*`, `cat.video-games*`, `footer.insurance`, `footer.api`, `home.api*`.
- Old home (replaced by the new hero): `home.eyebrow`, `home.title`, `home.titleEm`, `home.lede`, `home.ledeLoading`, `home.heroTitle1/2`, `home.heroLede`, `home.how*`, `home.step*`, `home.sellers*`, `home.rule*`, `home.byCategory*`, `home.popular*`, `home.index*`.
- Tax/VAT/invoices (no entity yet): `money.tax*`, `money.invoices*`, `money.credits`, `money.col.tax`, `money.exp.invoices*`, `money.exp.credits*`, `money.vies`, `money.vatNumber`, `money.business`.
- Requests, cart, discount codes, sales, saved searches, price history: hide if their screens aren't in the launch nav.
- Chat: `chat.sendAnyway` (outside contact is never sent).

## 1. Taglines + home hero
| Key | EN | AR |
|---|---|---|
| `home.hero.title` [CHANGE] | The market for every game and gamer. | السوق لكل لعبة ولكل لاعب. |
| `home.hero.lede` [CHANGE] | Skip the grind. Buy gold, items and top-ups from real players. Every order is checked by a person before the seller is paid. | تخطَّ الفارم. اشترِ الذهب والآيتمز والشحن من لاعبين حقيقيين، وكل طلب يراجعه إنسان قبل أن يستلم البائع أمواله. |
| `home.hero.soon` [NEW] | Coming soon: coaches and gamepals | قريبًا: مدرّبون ورفاق لعب |
| `footer.tagline` [CHANGE] | Skip the grind. Every order human-checked. | تخطَّ الفارم. وكل طلب يراجعه إنسان. |

## 2.2 Home
| Key | EN | AR |
|---|---|---|
| `home.meta` [CHANGE] | Buy and sell game gold, items and top-ups for Aion, Albion Online and Path of Exile. Pay in crypto. Every order is checked by a person before the seller is paid. | اشترِ وبِع ذهب الألعاب والآيتمز والشحن لـ Aion وAlbion Online وPath of Exile. ادفع بالكريبتو، وكل طلب يراجعه إنسان قبل أن يستلم البائع أمواله. |
| `home.topSearches` | Top searches | الأكثر بحثًا |
| `trust.proof` | Proof on every delivery | إثبات مع كل تسليم |
| `trust.proof.text` | Video or photo of the trade | فيديو أو صورة للتريد |
| `trust.escrow` [CHANGE] | Held until it's checked | محجوز حتى المراجعة |
| `trust.escrow.text` [CHANGE] | You confirm, or our staff check the proof | تؤكد أنت، أو يراجع فريقنا الإثبات |
| `trust.crypto` | Pay with crypto | ادفع بالكريبتو |
| `trust.crypto.text` | USDT, USDC, LTC and more | USDT وUSDC وLTC وغيرها |
| `trust.reviews` | Reviews from real orders | تقييمات من طلبات حقيقية |
| `trust.reviews.text` [CHANGE] | Only buyers who got an order can rate | لا يقيّم إلا من استلم طلبًا |
| `home.games` | Games | الألعاب |
| `home.topGames` [CHANGE] | Launch games | ألعاب الإطلاق |
| `home.voteNext` | Want another game? Vote for the next one. | تريد لعبة أخرى؟ صوّت للعبة القادمة. |
| `home.missingGame` | Missing a game? Vote for it | لعبتك غير موجودة؟ صوّت لها |
| `home.recentlyBought` | Recently bought | اشتريتها مؤخرًا |
| `home.buyAgain` | Buy again | اشترِ مجددًا |
| `home.allOrders` | All orders | كل الطلبات |
| `home.continue` | Continue browsing | تابع التصفح |
| `grow.title` | Grow with Bullizard | اربح مع Bullizard |
| `grow.sub` [CHANGE] | Two ways to earn. | طريقتان للربح. |
| `grow.inviteTitle` [CHANGE] | Invite friends. Earn 20% of our fee. | ادعُ أصدقاءك واربح 20% من عمولتنا. |
| `grow.inviteText` [CHANGE] | On every order they complete, for as long as they stay active. | على كل طلب يكملونه، طالما بقوا نشطين. |
| `grow.inviteCta` | Get your invite link | احصل على رابط الدعوة |
| `grow.sellBadge` | Founding Seller | بائع مؤسس |
| `grow.sellTitle` [CHANGE] | Turn your grind into income | حوّل الفارم إلى دخل |
| `grow.sellText` [CHANGE] | 5% fee for your first 60 days. Founding Sellers keep the badge for good. | عمولة 5% لأول 60 يومًا، وشارة البائع المؤسس تبقى معك للأبد. |
| `grow.sellCta` | Start selling | ابدأ البيع |

## 2.3 Footer
| Key | EN | AR |
|---|---|---|
| `footer.about` [CHANGE] | Bullizard is a marketplace for game gold, items and top-ups. Your payment is held until the delivery is checked. | Bullizard سوق لذهب الألعاب والآيتمز والشحن. دفعتك محجوزة حتى تتم مراجعة التسليم. |
| `footer.legal` [NEW] | 18+ only. Not affiliated with any game publisher. Game names belong to their owners. | للبالغين 18+ فقط. Bullizard غير تابع لأي ناشر ألعاب، وأسماء الألعاب ملك أصحابها. |
| `footer.escrowLine` [CHANGE] | Payments are held until the buyer confirms or staff release them after checking the proof. | المبالغ محجوزة حتى يؤكد المشتري أو يحرّرها فريقنا بعد مراجعة الإثبات. |
| `footer.buy` / `footer.sell` / `footer.help` | Buy / Sell / Help | الشراء / البيع / المساعدة |
| `footer.helpCentre` | Help centre | مركز المساعدة |
| `footer.contact` | Contact support | تواصل مع الدعم |
| `footer.escrow` | How payment is held | كيف تُحجز المبالغ |
| `footer.dispute` | Opening a dispute | فتح نزاع |
| `footer.fees` | Seller fees and ranks | عمولة البائع والرتب |
| `footer.openShop` | Open a shop | افتح متجرًا |
| `footer.games` | All games | كل الألعاب |
| `footer.terms` [NEW] | Terms | الشروط |
| `footer.privacy` [NEW] | Privacy | الخصوصية |
| `footer.nightMode` | Night mode | الوضع الليلي |

## 2.4 Game page
| Key | EN | AR |
|---|---|---|
| `game.pickCategory` | What are you looking for? | عن ماذا تبحث؟ |
| `cat.currency` | Currency | العملات |
| `cat.currency.hint` [CHANGE] | Gold, silver, Kina and orbs, traded in-game | ذهب وفضة وكينا وأورب، تُسلَّم داخل اللعبة |
| `cat.items` | Items | الآيتمز |
| `cat.items.hint` [CHANGE] | Gear, uniques and rare drops | عتاد ويونيك ودروب نادرة |
| `cat.top-ups` | Top-ups | الشحن |
| `cat.top-ups.hint` [CHANGE] | Game credit sent to your account | رصيد يُشحن إلى حسابك في اللعبة |
| `attrLabel.Server` | Server | السيرفر |
| `attrLabel.Region` | Region | المنطقة |
| `attrLabel.League` | League | الليج |
| `attrLabel.Mode` | Mode | الوضع |
| `attr.any` | Any {label} | {label}: الكل |
| `game.howMany` | How many? | كم تريد؟ |
| `game.howMany.hint` | Prices update for this amount. | تتحدّث الأسعار حسب هذه الكمية. |
| `ct.sellers` | Sellers | البائعون |
| `ct.server` | Server | السيرفر |
| `ct.min` | Min. qty | أقل كمية |
| `ct.deliveryTime` | Delivery | مدة التسليم |
| `ct.onlineOnly` | Online sellers only | البائعون المتصلون فقط |
| `ct.sort.recommended` | Recommended | المقترح |
| `ct.sort.cheapest` | Cheapest first | الأرخص أولًا |
| `ct.sort.minQty` | Lowest minimum | أقل حد أدنى |
| `ct.count` | {n} offers | العروض: {n} |
| `ct.sell` | Sell {game} {what} | بِع {what} في {game} |
| `table.perUnit` | Each | للوحدة |
| `table.totalFor` | Total for {n} | الإجمالي لـ {n} |
| `table.onlyStock` | Only {n} left | المتبقي: {n} فقط |
| `table.buy` | Buy | اشترِ |
| `rating.new` | New seller | بائع جديد |
| `presence.online` | Online now | متصل الآن |
| `presence.lastSeen` | Last seen {when} | آخر ظهور {when} |
| `founding.badge` | Founding Seller | بائع مؤسس |
| `badge.idVerified` | ID verified | هوية موثّقة |
| `game.alertLows` | Alert me on new lows | نبّهني عند سعر أقل |
| `game.more` | Show more offers | عروض أكثر |
| `league.ended` | {league} has ended | انتهى ليج {league} |

## 2.5 Offer page + buy box
| Key | EN | AR |
|---|---|---|
| `offer.sellerProfile` | Seller | البائع |
| `offer.viewShop` | View shop | زيارة المتجر |
| `offer.completed` | {n} orders completed | الطلبات المكتملة: {n} |
| `offer.message` | Message | راسل البائع |
| `offer.details` | Offer | العرض |
| `offer.sellerNote` | Seller's note | ملاحظة البائع |
| `offer.noDescription` [CHANGE] | No note from the seller. | لا توجد ملاحظة من البائع. |
| `offer.instructions` | Delivery instructions | تعليمات التسليم |
| `offer.reviews` | Reviews | التقييمات |
| `offer.allReviews` | All reviews | كل التقييمات |
| `offer.otherSellers` | Other sellers ({n}) | بائعون آخرون ({n}) |
| `offer.buyBox` | Buy this offer | اشترِ هذا العرض |
| `offer.price` | Price | السعر |
| `offer.minQty` | Min. {n} | الحد الأدنى: {n} |
| `offer.inStock` | In stock: {n} | المتوفر: {n} |
| `offer.less` / `offer.more` | Less / More | أقل / أكثر |
| `handover.character` | Deliver to character | التسليم إلى الشخصية |
| `handover.uid` | Deliver to UID | التسليم إلى الـ UID |
| `handover.hint.character` [CHANGE] | Your exact character name in the game. | اسم شخصيتك بالضبط كما في اللعبة. |
| `handover.hint.uid` | Your UID, from the game settings. | الـ UID الخاص بك من إعدادات اللعبة. |
| `handover.responsible` [CHANGE] | The seller trades with exactly this name. You're responsible for getting it right. | يسلّم البائع إلى هذا الاسم بالضبط، وأنت مسؤول عن صحته. |
| `handover.confirm` / `handover.change` / `handover.confirmed` | Confirm / Change / Confirmed | تأكيد / تغيير / تم التأكيد |
| `offer.total` | Total | الإجمالي |
| `offer.pay` | Buy now · {amount} | اشترِ الآن · {amount} |
| `offer.heldUntil` [CHANGE] | Held until the delivery is checked. | المبلغ محجوز حتى تتم مراجعة التسليم. |
| `offer.terms` [NEW, CEO's exact words] | By buying you agree to the {terms} | بالشراء أنت توافق على {terms} |
| `offer.termsLink` [NEW] | Terms | الشروط |
| `offer.howEscrow` | How it works | كيف يعمل |
| `offer.guarantee` [CHANGE] | Buyer Protection | حماية المشتري |
| `offer.guaranteeText` [CHANGE] | Your money stays held until the delivery is proven. | أموالك محجوزة حتى يثبت التسليم. |
| `offer.support` [CHANGE] | Real people | فريق حقيقي |
| `offer.supportText` [CHANGE] | Disputes are decided by our team | النزاعات يحسمها فريقنا |
| `protect.title` | Buyer Protection | حماية المشتري |
| `protect.text` [CHANGE] | The seller is paid when you confirm. If you don't, our staff check the proof first. Something wrong? Open a dispute. | يستلم البائع أمواله عند تأكيدك، أو بعد مراجعة فريقنا للإثبات إن لم تؤكد. في مشكلة؟ افتح نزاعًا. |
| `offer.signInToBuy` | Sign in to buy | سجّل الدخول للشراء |
| `offer.verifyFirst` [CHANGE] | Verify your email and phone to buy. | وثّق بريدك ورقم هاتفك لتتمكن من الشراء. |
| `offer.verifyNow` | Verify now | وثّق الآن |
| `offer.yours` | This is your offer. | هذا عرضك. |
| `offer.opening` | Opening checkout… | جارٍ فتح صفحة الدفع… |

Removed (say it once): the buy box shows one trust line only (`offer.heldUntil`). `offer.guarantee` + `offer.support` sit below the box as two small icons, not repeated in the box.

## 2.6 Checkout
| Key | EN | AR |
|---|---|---|
| `checkout.step.confirm` / `.pay` / `.order` | Confirm / Pay / Order | تأكيد / دفع / الطلب |
| `checkout.yourOrder` | Your order | طلبك |
| `checkout.price` | Price | السعر |
| `checkout.fromBalance` | From your balance | من رصيدك |
| `checkout.toPay` | To pay | المطلوب دفعه |
| `checkout.received` | Already received | تم استلامه |
| `checkout.rules` | **Delete**: the Terms line is in the buy box (say it once). | |
| `crypto.title` | Pay with crypto | ادفع بالكريبتو |
| `crypto.chooseCoin` | Choose a coin | اختر العملة |
| `crypto.feeNote` [CHANGE] | Totals include the network fee. | الإجمالي يشمل رسوم الشبكة. |
| `crypto.breakdown` | {price} + {fee} network fee = {total} | {price} + {fee} رسوم الشبكة = {total} |
| `crypto.minimum` | min {amount} | الحد الأدنى {amount} |
| `crypto.tooSmall` [CHANGE] | Order is below this coin's minimum ({amount}) | الطلب أقل من الحد الأدنى لهذه العملة ({amount}) |
| `crypto.onlyFitting` | **Delete**: the greyed coin already says why. | |
| `crypto.rateLocked` | Rate locked until {time} | السعر مثبّت حتى {time} |
| `crypto.sendExactly` | Send exactly | أرسل بالضبط |
| `crypto.onNetwork` | {network} only | على شبكة {network} فقط |
| `crypto.address` | Address | العنوان |
| `crypto.memo` | Memo / tag (required) | المذكرة / التاغ (إلزامي) |
| `crypto.copyAddress` / `crypto.copyAmount` / `crypto.copied` | Copy address / Copy amount / Copied | انسخ العنوان / انسخ المبلغ / تم النسخ |
| `crypto.sendExact` [CHANGE] | Send this exact amount on this network. This page updates by itself. | أرسل هذا المبلغ بالضبط على هذه الشبكة. تتحدّث الصفحة تلقائيًا. |
| `crypto.status.waiting` | Waiting for your transfer | بانتظار تحويلك |
| `crypto.status.confirming` | Seen on the network, confirming… | ظهر على الشبكة، جارٍ التأكيد… |
| `crypto.status.confirmed` / `.sending` | Confirmed, finishing up… | تم التأكيد، لحظات… |
| `crypto.status.partially_paid` | Partly paid | مدفوع جزئيًا |
| `crypto.status.finished` | Paid | مدفوع |
| `crypto.status.expired` | Time ran out | انتهت المهلة |
| `crypto.status.failed` | Payment failed | فشل الدفع |
| `crypto.underpaid` [CHANGE] | We got {received}, which is {short} short (network fee or rate change). Send the rest before the timer ends. If you don't, what you sent goes to your Bullizard balance. Short payments can't be cancelled or refunded. | وصلنا {received}، أي أقل بـ {short} (رسوم شبكة أو تغيّر في السعر). أرسل الباقي قبل انتهاء المؤقت، وإلا يُضاف ما أرسلته إلى رصيدك في Bullizard. المبالغ الناقصة لا تُلغى ولا تُسترد. |
| `crypto.noCoin` [CHANGE] | No coin can take this amount right now. Try again in a minute. | لا توجد عملة تقبل هذا المبلغ الآن. حاول بعد دقيقة. |
| `crypto.loading` | Loading coins… | جارٍ تحميل العملات… |

## 2.7 Order page (buyer + seller)
| Key | EN | AR |
|---|---|---|
| `order.ref` [CHANGE] | {id} (id already includes `order#`) | {id} |
| `order.status.awaiting_payment` | Waiting for payment | بانتظار الدفع |
| `order.status.paid` [CHANGE] | Paid · waiting for delivery | مدفوع · بانتظار التسليم |
| `order.status.delivered` [CHANGE] | Delivered · waiting for confirmation | تم التسليم · بانتظار التأكيد |
| `order.status.completed` | Completed | مكتمل |
| `order.status.disputed` [CHANGE] | In dispute | قيد النزاع |
| `order.status.refunded` [CHANGE] | Refunded to balance | مُسترد إلى الرصيد |
| `order.status.cancelled` | Cancelled | ملغى |
| `order.step.paid` [CHANGE] | Paid · held | مدفوع · محجوز |
| `order.step.deliveredProof` | Delivered with proof | سُلّم مع إثبات |
| `order.step.youConfirm` | You confirm | تؤكد أنت |
| `order.step.buyerConfirms` | Buyer confirms | يؤكد المشتري |
| `order.step.sellerPaid` | Seller paid | استلم البائع |
| `order.step.youPaid` | You're paid | استلمت أموالك |
| `order.character` | Character | الشخصية |
| `order.forBuyer` / `order.fromSeller` | for {name} / from {name} | لـ {name} / من {name} |
| `proof.title` | Delivery proof | إثبات التسليم |
| `proof.loading` / `proof.unavailable` | Loading proof… / Proof unavailable | جارٍ تحميل الإثبات… / الإثبات غير متاح |
| `order.gotIt` [CHANGE] | Got it · release payment | استلمت · حرّر المبلغ |
| `order.gotIt.title` | Confirm you received it? | هل تؤكد الاستلام؟ |
| `order.gotIt.text` [CHANGE] | The seller is paid now and the order closes. You can't open a dispute after this. | سيستلم البائع أمواله الآن ويُغلق الطلب، ولا يمكنك فتح نزاع بعدها. |
| `order.gotIt.yes` / `.no` | Yes, I received it / Not yet | نعم، استلمت / ليس بعد |
| `order.somethingWrong` | Something's wrong | هناك مشكلة |
| `order.openDispute` | Open a dispute | افتح نزاعًا |
| `order.dispute.text` [CHANGE] | The payment freezes. A Bullizard arbiter checks the chat and proof, then decides. | يتجمّد المبلغ، ويراجع حَكَم من Bullizard المحادثة والإثبات ثم يقرر. |
| `order.dispute.problem` | What's the problem? | ما المشكلة؟ |
| `order.dispute.placeholder` [CHANGE] | Be specific: what you expected, what you got, and when. | كن محددًا: ماذا توقعت، وماذا استلمت، ومتى. |
| `order.dispute.cat.not_delivered` | Not delivered | لم يُسلَّم |
| `order.dispute.cat.not_as_described` [CHANGE] | Wrong amount or item | كمية أو آيتم خاطئ |
| `order.dispute.cat.other` | Something else | سبب آخر |
| `order.dispute.open` | Open dispute | افتح النزاع |
| `order.statement.placeholder` [CHANGE] | Your side for the arbiter. Put screenshots in the chat. | أقوالك للحَكَم. ضع لقطات الشاشة في المحادثة. |
| `order.deliver` | Deliver this order | سلّم هذا الطلب |
| `order.deliverTo` [CHANGE] | Deliver to {name}, the {label} the buyer confirmed. | سلّم إلى {name}، وهو الـ {label} الذي أكّده المشتري. |
| `order.proofLabel` [CHANGE] | Proof of delivery (video or photo of the trade) | إثبات التسليم (فيديو أو صورة للتريد) |
| `order.proofHint` [CHANGE] | Required. Show the character name and the amount. It's your evidence in a dispute. | إلزامي. أظهر اسم الشخصية والكمية، فهو دليلك في أي نزاع. |
| `order.markDelivered` | Mark as delivered | تم التسليم |
| `order.delivering` | Sending… | جارٍ الإرسال… |
| `order.waitingBuyer` | Waiting for the buyer | بانتظار المشتري |
| `order.waitingBuyer.text` [CHANGE] | You're paid when the buyer confirms. If they don't, staff can release it from 24 hours after delivery. | تستلم أموالك عند تأكيد المشتري، وإن لم يؤكد يمكن لفريقنا تحرير المبلغ بعد 24 ساعة من التسليم. |
| `order.askRelease` | Ask support to release | اطلب من الدعم تحرير المبلغ |
| `order.followUpSent` [CHANGE] | Sent. Staff will check your proof. | تم الإرسال. سيراجع الفريق إثباتك. |
| `order.frozenNote` [CHANGE] | This order is in a routine security check. The money stays held until it's done. | هذا الطلب قيد فحص أمني روتيني، والمبلغ محجوز حتى ينتهي. |
| `order.getHelp` | Get help with this order | مساعدة بخصوص هذا الطلب |
| `order.rate` | Rate this seller | قيّم البائع |
| `order.reviewHint` | What went well or badly? (optional) | ما الذي أعجبك أو لم يعجبك؟ (اختياري) |
| `order.postReview` | Post review | انشر التقييم |
| `order.allOrders` | All orders | كل الطلبات |

## 2.8 Chat + official notices (owned by the other engineer — listed for reference only)
| Key | EN | AR |
|---|---|---|
| `chat.fromBullizard` | Message from Bullizard | رسالة من Bullizard |
| `chat.official` | Official Bullizard message | رسالة رسمية من Bullizard |
| `chat.verified` | Official | رسمي |
| `chat.placeholder` | Write a message | اكتب رسالة |
| `chat.send` | Send | إرسال |
| `chat.recorded` [CHANGE] | saved for disputes | محفوظة للنزاعات |
| `chat.notSent` | Not sent. | لم تُرسَل. |
| `chat.bannable` | Sharing outside contacts can get your account banned right away. | مشاركة وسائل تواصل خارجية قد تؤدي إلى حظر حسابك فورًا. |
| `chat.offPlatform` [CHANGE] | Not sent. Sharing outside contacts can get your account banned right away. | لم تُرسَل. مشاركة وسائل تواصل خارجية قد تؤدي إلى حظر حسابك فورًا. |
| `chat.safeTitle` | Stay safe | ابقَ بأمان |
| `chat.safe1` | Trade and talk only on Bullizard. Sharing outside contacts can get your account banned right away. | تداول وتواصل على Bullizard فقط. مشاركة وسائل تواصل خارجية قد تؤدي إلى حظر حسابك فورًا. |
| `chat.safe2` | Never open links or files a trader sends. Report them. | لا تفتح روابط أو ملفات يرسلها أي تاجر، وأبلغ عنها. |
| `chat.safe3` | Deliver and confirm only on the order page. | سلّم وأكّد من صفحة الطلب فقط. |
| `chat.safe4` [CHANGE] | "I paid" means nothing until the order says Paid. | عبارة «دفعت» لا تعني شيئًا حتى تظهر حالة الطلب «مدفوع». |
| `chat.readIt` | Read it | اقرأها |
| `messages.report` | Report this chat | أبلغ عن هذه المحادثة |
| `messages.openOrder` | Open order | افتح الطلب |
| `messages.thisOrder` | This chat's order | طلب هذه المحادثة |
| `messages.tab.all` / `.orders` / `.questions` | All / Orders / Questions | الكل / الطلبات / الأسئلة |
| `messages.search` | Search name, offer or order# | ابحث بالاسم أو العرض أو order# |

Official order messages `sys.*` (render by code; no money amounts ever):
| Code | EN | AR |
|---|---|---|
| `sys.order_created` | Order placed. Waiting for payment. | تم إنشاء الطلب. بانتظار الدفع. |
| `sys.paid` | Payment received and held. Seller: deliver to {character} and upload proof. | تم استلام الدفع وحجزه. أيها البائع: سلّم إلى {character} وارفع الإثبات. |
| `sys.delivered` | Delivered with proof. Buyer: check it, then confirm. | تم التسليم مع إثبات. أيها المشتري: تحقق ثم أكّد. |
| `sys.confirmed_early` | Buyer confirmed before delivery was marked. Order complete. | أكّد المشتري قبل تسجيل التسليم. الطلب مكتمل. |
| `sys.completed` | Buyer confirmed. Order complete. GG. | أكّد المشتري. الطلب مكتمل. GG. |
| `sys.staff_released` | Staff checked the proof and completed the order. | راجع الفريق الإثبات وأكمل الطلب. |
| `sys.follow_up` | Seller asked staff to review this order. | طلب البائع من الفريق مراجعة الطلب. |
| `sys.dispute_opened` | Dispute opened. The order is frozen until an arbiter decides. | تم فتح نزاع. الطلب مجمّد حتى يقرر الحَكَم. |
| `sys.dispute_buyer` | Dispute closed in the buyer's favour. | أُغلق النزاع لصالح المشتري. |
| `sys.dispute_seller` | Dispute closed in the seller's favour. | أُغلق النزاع لصالح البائع. |
| `sys.refunded` | Order refunded to the buyer's balance. | تم استرداد مبلغ الطلب إلى رصيد المشتري. |
| `sys.underpaid` | Payment arrived short. Buyer: send the rest or it goes to your balance. | وصل الدفع ناقصًا. أيها المشتري: أرسل الباقي أو يُضاف ما أرسلته إلى رصيدك. |
| `sys.delivery_late` (warning) | Delivery time has passed. Seller: deliver now. Buyer: you can open a dispute. | انتهت مدة التسليم. أيها البائع: سلّم الآن. أيها المشتري: يمكنك فتح نزاع. |

## 2.9 Sell form
| Key | EN | AR |
|---|---|---|
| `sell.new` [CHANGE] | Create an offer | أنشئ عرضًا |
| `sell.f.game` | Game | اللعبة |
| `picker.placeholder` | Type a game name | اكتب اسم اللعبة |
| `picker.choose` | Pick a game from the list. | اختر لعبة من القائمة. |
| `picker.none` [CHANGE] | We don't list that game yet. Vote for it. | هذه اللعبة غير متاحة بعد. صوّت لها. |
| `sell.f.launchGames` | Launch games | ألعاب الإطلاق |
| `sell.f.details` [CHANGE] | Offer details | تفاصيل العرض |
| `sell.f.detailsHint` [CHANGE] | buyers filter by these | يفلتر المشترون بها |
| `sell.f.unit` [CHANGE] | Unit | الوحدة |
| `sell.f.unitHint` [CHANGE] | E.g. M for millions. Buyers pick any amount from your minimum up to your stock. | مثل M للمليون. يختار المشتري أي كمية من الحد الأدنى حتى مخزونك. |
| `sell.f.pricePerUnit` | Your price per {unit} (USD) | سعرك لكل {unit} (دولار) |
| `sell.f.stockUnits` | Stock ({unit}) | المخزون ({unit}) |
| `sell.f.minQty` | Minimum order ({unit}) | أقل طلب ({unit}) |
| `sell.f.price` | Your price (USD) | سعرك (دولار) |
| `sell.f.stock` [CHANGE] | Stock | المخزون |
| `sell.f.manual` | I deliver each order myself | أسلّم كل طلب بنفسي |
| `sell.f.description` [CHANGE] | Note for buyers | ملاحظة للمشترين |
| `sell.f.optional` | optional | اختياري |
| `sell.f.choose` | Choose… | اختر… |
| `sell.f.howPaid` [CHANGE] | Deliver in-game, upload proof, get paid when the order is confirmed. | سلّم داخل اللعبة، وارفع الإثبات، واستلم أموالك عند تأكيد الطلب. |
| `preview.title` | Preview | معاينة |
| `preview.earnLabel` | You earn | تربح |
| `preview.buyerPaysLabel` | Buyer pays | يدفع المشتري |
| `preview.feeDetails` | Fee details | تفاصيل العمولة |
| `preview.hint` | **Delete**: the two numbers say it. | |
| `sell.f.create` | Publish offer | انشر العرض |
| `league.endedHint` [CHANGE] | The league ended, so this offer was taken down. Move it to an open league to list it again. | انتهى الليج فأُزيل هذا العرض. انقله إلى ليج مفتوح لتعرضه من جديد. |
| `league.pick` / `league.relist` | Pick a league / List again | اختر ليج / اعرض من جديد |

## 2.10 Wallet (buyers + sellers)
| Key | EN | AR |
|---|---|---|
| `wallet.title` | Wallet | المحفظة |
| `wallet.available` | Available | المتاح |
| `money.inEscrow` [CHANGE] | Held | محجوز |
| `wallet.withdrawn` | Withdrawn | المسحوب |
| `wallet.unlocking` | {amount} unlocking soon | {amount} يُتاح قريبًا |
| `wallet.notice` [CHANGE] | Refunds and short payments land here. Spend them at checkout or withdraw in crypto. | المبالغ المستردة والمدفوعات الناقصة تُضاف هنا. استخدمها عند الدفع أو اسحبها بالكريبتو. |
| `wallet.history` | History | السجل |
| `wallet.col.date` / `.what` / `.status` / `.amount` | Date / What / Status / Amount | التاريخ / البيان / الحالة / المبلغ |
| `wallet.kind.all` / `.order` / `.refund` / `.sale` / `.withdrawal` | All / Orders / Refunds / Sales / Withdrawals | الكل / الطلبات / المستردات / المبيعات / السحوبات |
| `wallet.state.held` / `.released` / `.disputed` / `.sent` / `.pending` / `.failed` | Held / Released / Disputed / Sent / Pending / Failed | محجوز / مُحرَّر / قيد النزاع / أُرسل / قيد الانتظار / فشل |
| `wallet.withdraw` | Withdraw | سحب |
| `money.payoutAddress.coin` | Coin | العملة |
| `wallet.address` [CHANGE] | Your {network} address | عنوانك على شبكة {network} |
| `wallet.amountUsd` | Amount in USD (up to {max}) | المبلغ بالدولار (حتى {max}) |
| `wallet.fee` | Fee ({pct}%, minimum {min}) | الرسوم ({pct}%، بحد أدنى {min}) |
| `wallet.youReceive` | You receive | تستلم |
| `wallet.checked` [CHANGE] | I checked the address and network. Crypto sent to a wrong address is gone for good. | راجعت العنوان والشبكة. الكريبتو المُرسل إلى عنوان خاطئ لا يمكن استرجاعه. |
| `money.requested` [CHANGE] | {amount} requested. {net} is usually sent within 3 working days of approval. | طلبت سحب {amount}. يُرسل {net} عادةً خلال 3 أيام عمل من الموافقة. |
| `money.wstatus.pending_approval` / `.processing` / `.paid` / `.failed` / `.rejected` | Waiting for approval / Sending / Sent / Failed / Rejected | بانتظار الموافقة / جارٍ الإرسال / أُرسل / فشل / مرفوض |
| `money.payoutAddress` | Payout address | عنوان السحب |
| `money.payoutAddress.text` [CHANGE] | Withdrawals go to this address. Changing it needs a confirmation from your email. | تُرسل السحوبات إلى هذا العنوان، وتغييره يتطلب تأكيدًا من بريدك. |
| `money.payoutAddress.sent` | Check your email to confirm the new address. | افحص بريدك لتأكيد العنوان الجديد. |
| `money.payoutAddress.confirmed` | Payout address confirmed. | تم تأكيد عنوان السحب. |
| `credit.title` | Your balance | رصيدك |
| `credit.text` [CHANGE] | Short payments, refunds and referral earnings. Spend at checkout or withdraw. | المدفوعات الناقصة والمستردات وأرباح الدعوات. استخدمها عند الدفع أو اسحبها. |
| `money.frozen` | Withdrawals are paused while a routine review runs. | السحب متوقف مؤقتًا أثناء مراجعة روتينية. |

## 2.11 Seller shop (public page + seller hub)
| Key | EN | AR |
|---|---|---|
| `sp.positive` | Positive | إيجابي |
| `sp.rating` | Rating | التقييم |
| `sp.sold` | Orders sold | طلبات مُباعة |
| `sp.onTime` | On-time delivery | التسليم في الموعد |
| `sp.since` | Selling since | يبيع منذ |
| `sp.speaks` | Speaks {list} | يتحدث {list} |
| `sp.offers` / `sp.reviews` | Offers / Reviews | العروض / التقييمات |
| `sp.featured` | Featured | مميّز |
| `sp.reviewNote` [CHANGE] | Only buyers who received an order can review. | لا يقيّم إلا من استلم طلبًا. |
| `sp.showing` | Showing the latest {n} of {total} written reviews. | آخر {n} من أصل {total} تقييم مكتوب. |
| `sell.title` | Your shop | متجرك |
| `sell.tab.shop` / `.analytics` / `.money` [CHANGE] | Shop / Analytics / Money | المتجر / الإحصاءات / الأموال |
| `ranks.yourRank` | Your rank | رتبتك |
| `ranks.rate` | Commission {rate}, added on top of your price. | العمولة {rate} وتُضاف فوق سعرك. |
| `ranks.promoRate` [CHANGE] | Launch promo: {rate} until {until}. | عرض الإطلاق: {rate} حتى {until}. |
| `ranks.caption` | Commission by rank · 30-day sales | العمولة حسب الرتبة · مبيعات 30 يومًا |
| `sell.nextLevel` [CHANGE] | {amount} more in 30-day sales reaches {level}. | {amount} إضافية في مبيعات 30 يومًا توصلك إلى {level}. |
| `sell.topLevel` [CHANGE] | Top rank. Nowhere higher to fly. | أعلى رتبة. لا يوجد أعلى من هنا. |
| `founding.spots` | {used} of {slots} free featured spots in use until {until}. | المستخدم: {used} من {slots} أماكن مميّزة مجانية حتى {until}. |
| `founding.spotsOver` | Thanks for being here from day one. The free featured spots have closed. | شكرًا لوجودك معنا من البداية. انتهت الأماكن المميّزة المجانية. |
| `founding.feature` / `founding.unfeature` | Feature / Unfeature | ميّز / ألغِ التمييز |
| `shop.title` | Your shop page | صفحة متجرك |
| `shop.lede` [CHANGE] | Buyers see this first. No contact details or outside payment methods. | أول ما يراه المشترون. ممنوع وضع وسائل تواصل أو طرق دفع خارجية. |
| `shop.intro` | Intro | النبذة |
| `shop.languages` | Languages you speak | اللغات التي تتحدثها |
| `badges.title` | Badges next to your name | الشارات بجانب اسمك |
| `badges.hint` [CHANGE] | Pick up to 2. | اختر حتى شارتين. |
| `presence.showOnline` | Show buyers when I'm online | أظهر للمشترين أنني متصل |
| `shop.save` / `shop.saved` | Save shop page / Saved. | احفظ صفحة المتجر / تم الحفظ. |

## 2.12 Onboarding (sell flow)
| Key | EN | AR |
|---|---|---|
| `sell.signIn` | Sign in to start selling. | سجّل الدخول لتبدأ البيع. |
| `sell.tier1.lede` [CHANGE] | Three steps: verify email and phone, pass a short rules test, list. Photo ID is due within 30 days of your first offer. | ثلاث خطوات: وثّق بريدك وهاتفك، وانجح في اختبار قصير للقوانين، ثم اعرض. توثيق الهوية بصورة مطلوب خلال 30 يومًا من أول عرض. |
| `sell.tier1.verify` | Verify email and phone | وثّق البريد والهاتف |
| `rules.gate` [CHANGE] | One step before your first offer: a short test on how trading works here. Retake it as often as you like. | خطوة واحدة قبل أول عرض: اختبار قصير عن طريقة التداول هنا، ويمكنك إعادته متى شئت. |
| `rules.title` | Seller rules test | اختبار قوانين البائع |
| `rules.lede` [CHANGE] | Answer every question. Pass mark: {pct}%. | أجب عن كل الأسئلة. درجة النجاح: {pct}%. |
| `rules.readRules` | Read the rules first | اقرأ القوانين أولًا |
| `rules.submit` | Check my answers | تحقق من إجاباتي |
| `rules.checking` | Checking… | جارٍ التحقق… |
| `rules.passed` [CHANGE] | {pct}%. Passed. Your shop is ready. | {pct}%. نجحت. متجرك جاهز. |
| `rules.failed` [CHANGE] | {pct}%. You need {need}%. Read the explanations below and try again. | {pct}%. تحتاج {need}%. اقرأ الشرح بالأسفل وحاول مجددًا. |
| `onb.done.title` [NEW] | You're in. GG. | أنت جاهز. GG. |
| `onb.done.text` [NEW] | List your first offer now. Verify your ID by {date} to keep selling. | اعرض أول عرض لك الآن، ووثّق هويتك قبل {date} لتواصل البيع. |
| `onb.done.cta` [NEW] | Create your first offer | أنشئ أول عرض |
| `onb.due` | Verify your ID by {date}. | وثّق هويتك قبل {date}. |
| `onb.restricted` [CHANGE] | Selling is paused: ID verification is overdue. | البيع متوقف: انتهت مهلة توثيق الهوية. |
| `onb.why` [CHANGE] | You have 30 days from your first offer to verify a photo ID. After that, selling and withdrawals pause until it's done. | لديك 30 يومًا من أول عرض لتوثيق هويتك بصورة، وبعدها يتوقف البيع والسحب حتى تكمله. |
| `account.title` | Verification | التوثيق |
| `account.lede` [CHANGE] | Level {tier} of 2. Level 1 (email + phone) to buy and sell. Level 2 (photo ID) within 30 days of your first offer, and to withdraw. | المستوى {tier} من 2. المستوى 1 (البريد والهاتف) للشراء والبيع، والمستوى 2 (الهوية بصورة) خلال 30 يومًا من أول عرض وللسحب. |
| `account.level1` | Level 1 · buy and sell | المستوى 1 · شراء وبيع |
| `account.level2` | Level 2 · ID | المستوى 2 · الهوية |
| `account.id.text` [CHANGE] | A government photo ID and a short selfie video, checked by our ID partner. | هوية حكومية بصورة وفيديو سيلفي قصير، يراجعها شريك التوثيق لدينا. |
| `account.id.start` | Start ID check | ابدأ توثيق الهوية |
| `account.id.verified` | ID verified. | تم توثيق الهوية. |

## 2.13 Errors (all [NEW]) — show `err.<code>` when it exists
| Key | EN | AR |
|---|---|---|
| `err.generic` | Something broke on our side. Try again in a moment. | حدث خطأ من جهتنا. حاول بعد لحظات. |
| `err.network` | You're offline. Check your connection. | أنت غير متصل. تحقق من الإنترنت. |
| `err.too_many` | Too many tries. Wait a minute. | محاولات كثيرة. انتظر دقيقة. |
| `err.not_found` | Not found. It may have been removed. | غير موجود، ربما تمت إزالته. |
| `err.suspended` | This account is suspended. Contact support. | هذا الحساب موقوف. تواصل مع الدعم. |
| `err.kyc_required` | Verify your email and phone first. | وثّق بريدك وهاتفك أولًا. |
| `err.kyc_overdue` | Your 30 days are up. Verify your ID to keep selling. | وثّق هويتك لتواصل البيع، فقد انتهت مهلة الـ 30 يومًا. |
| `err.rules_test_required` | Pass the rules test before your first offer. | انجح في اختبار القوانين قبل أول عرض. |
| `err.offplatform_contact` / `err.contact_details` / `err.offplatform_blocked` | Not sent. Sharing outside contacts can get your account banned right away. | لم تُرسَل. مشاركة وسائل تواصل خارجية قد تؤدي إلى حظر حسابك فورًا. |
| `err.intro_not_allowed` | Your intro mentions something the rules don't allow. | النبذة تحتوي على ما تمنعه القوانين. |
| `err.listing_blocked` | This offer breaks the rules on what can be sold. | هذا العرض يخالف قوانين ما يُسمح ببيعه. |
| `err.proof_required` / `err.invalid_proof` | Upload a video or photo of the trade first. | ارفع فيديو أو صورة للتريد أولًا. |
| `err.unsupported_file` | Use PNG, JPEG, WebP, MP4 or WebM. | استخدم PNG أو JPEG أو WebP أو MP4 أو WebM. |
| `err.out_of_stock` | Someone just bought it. Try a smaller amount or another seller. | اشتراه شخص للتو. جرّب كمية أقل أو بائعًا آخر. |
| `err.listing_unavailable` / `err.seller_unavailable` | This offer isn't available anymore. | هذا العرض لم يعد متاحًا. |
| `err.own_offer` | That's your own offer. | هذا عرضك أنت. |
| `err.amount_too_small` | This amount is below the minimum. | هذا المبلغ أقل من الحد الأدنى. |
| `err.already_paid` | Already paid. Waiting for the network to confirm. | تم الدفع، بانتظار تأكيد الشبكة. |
| `err.invalid_unit` | Check your unit, minimum and stock: the minimum can't be above your stock. | راجع الوحدة والحد الأدنى والمخزون: الحد الأدنى لا يتجاوز المخزون. |
| `err.invalid_address` | That isn't a valid address for this network. | هذا ليس عنوانًا صحيحًا لهذه الشبكة. |
| `err.no_payout_address` | Add and confirm a payout address first. | أضف عنوان السحب وأكّده أولًا. |
| `err.link_expired` / `err.invalid_token` | This link expired. Request a new one. | انتهت صلاحية الرابط. اطلب رابطًا جديدًا. |
| `err.invalid_code` / `err.code_expired` | Wrong or expired code. Try the newest one. | الرمز خاطئ أو منتهي. جرّب أحدث رمز. |
| `err.invalid_email` | Enter a valid email. | أدخل بريدًا صحيحًا. |
| `err.email_taken` | An account with this email already exists. Sign in instead. | يوجد حساب بهذا البريد. سجّل الدخول بدلًا من ذلك. |
| `err.phone_in_use` | This number is verified on another account. | هذا الرقم موثّق على حساب آخر. |
| `err.phone_not_supported` | Use a real mobile number. Virtual numbers don't work. | استخدم رقم جوال حقيقيًا، الأرقام الافتراضية لا تعمل. |
| `err.invalid_affiliate_code` | That invite or creator code isn't valid. | رمز الدعوة أو صانع المحتوى غير صحيح. |
| `err.dispute_closed` / `err.already_resolved` | This dispute is already decided. | هذا النزاع محسوم بالفعل. |
| `err.already_reviewed` | You already reviewed this order. | قيّمت هذا الطلب من قبل. |

## 2.14 Empty states
| Key | EN | AR |
|---|---|---|
| `table.empty` [CHANGE] | No offers here yet. Sellers are joining. Check back soon. | لا توجد عروض بعد. البائعون في الطريق، عُد قريبًا. |
| `game.noMatch` | Nothing matches these filters. | لا شيء يطابق هذه الفلاتر. |
| `game.clear` | Clear filters | امسح الفلاتر |
| `games.none` | No game with that name. Vote for it. | لا توجد لعبة بهذا الاسم. صوّت لها. |
| `orders.empty` [CHANGE] | No orders yet. Your first one is a search away. | لا توجد طلبات بعد. أول طلب على بُعد بحث. |
| `orders.browse` | Browse games | تصفّح الألعاب |
| `messages.empty` | No chats yet. A chat opens when you buy or ask a seller something. | لا توجد محادثات بعد. تبدأ المحادثة عند الشراء أو سؤال بائع. |
| `messages.pick` | Pick a chat to read it. | اختر محادثة لقراءتها. |
| `notif.empty` | Nothing yet. Orders, payouts and security alerts show up here. | لا شيء بعد. تظهر هنا تحديثات الطلبات والسحوبات وتنبيهات الأمان. |
| `notif.emptyPurchases` / `.emptySales` / `.emptyUpdates` | No new purchase updates / No new sales updates / Nothing new | لا تحديثات جديدة للمشتريات / لا تحديثات جديدة للمبيعات / لا جديد |
| `wallet.empty` / `wallet.noHistory` | Nothing here yet. | لا شيء هنا بعد. |
| `sell.noListings` [CHANGE] | No offers yet. Create your first one below. | لا توجد عروض بعد. أنشئ أول عرض بالأسفل. |
| `sp.noOffers` | No live offers right now. | لا توجد عروض حاليًا. |
| `sp.noReviews` / `offer.noReviews` | No written reviews yet. | لا توجد تقييمات مكتوبة بعد. |
| `sp.paused` | This shop is taking a short break. | المتجر في استراحة قصيرة. |
| `votes.empty` | No suggestions yet. Be the first. | لا توجد اقتراحات بعد. كن الأول. |
| `watch.page.empty.text` [CHANGE] | Tap "Price alert" on any offer, or follow a whole market from a game page. | اضغط «تنبيه السعر» على أي عرض، أو تابع سوقًا كاملًا من صفحة اللعبة. |
| `sup.none` | No requests yet. Most answers are in the help centre. | لا توجد طلبات بعد. معظم الإجابات في مركز المساعدة. |
| `common.notFound` | Page not found. | الصفحة غير موجودة. |
| `common.loading` / `home.loading` | Loading… | جارٍ التحميل… |

## 2.15 Help-centre fixes (lib/help.ts EN + ar.help.ts AR)

**`buyer-protection`**: Bullizard Buyer Protection / حماية المشتري من Bullizard
- EN summary: Your money is held until the delivery is proven and checked.
- EN body (4 paragraphs): When you pay, Bullizard holds the money. The seller delivers in-game and uploads a video or photo of the trade. / The seller is paid when you confirm. If you don't confirm, our staff check the proof and release it: never before 24 hours after delivery. / Not delivered, or wrong amount or item: open a dispute before you confirm. The money stays frozen until an arbiter decides; if they decide for you, it's refunded to your balance. / Keep the whole trade in the order chat. Deals made outside Bullizard aren't protected, and sharing outside contacts can get your account banned right away.
- AR summary: أموالك محجوزة حتى يثبت التسليم وتتم مراجعته.
- AR body: عند الدفع تحجز Bullizard المبلغ. يسلّم البائع داخل اللعبة ويرفع فيديو أو صورة للتريد. / يستلم البائع أمواله عند تأكيدك. وإن لم تؤكد يراجع فريقنا الإثبات ويحرّر المبلغ، ولا يحدث ذلك قبل 24 ساعة من التسليم. / إن لم يُسلَّم الطلب أو كانت الكمية أو الآيتم خاطئًا فافتح نزاعًا قبل التأكيد. يبقى المبلغ مجمّدًا حتى يقرر الحَكَم، وإن قرر لصالحك يُسترد إلى رصيدك. / أبقِ التريد كله في محادثة الطلب، فالصفقات خارج Bullizard غير محمية، ومشاركة وسائل تواصل خارجية قد تؤدي إلى حظر حسابك فورًا.

**`how-escrow-works`**: replace "There is no timer: the money stays in escrow until you confirm" with:
- EN: There's no auto-release. The money stays held until you confirm, or until staff check the proof (never before 24 hours after delivery).
- AR: لا يوجد تحرير تلقائي. يبقى المبلغ محجوزًا حتى تؤكد، أو حتى يراجع فريقنا الإثبات (ولا يحدث ذلك قبل 24 ساعة من التسليم).

**`order-not-delivered`**: replace body (no auto-cancel, no auto-refund):
- EN: The seller's delivery time is on the offer. Message them in the order chat first. Most delays are sorted there. Still nothing? Open a dispute from the order page. Staff check the chat and proof; if the order wasn't delivered, you're refunded to your balance. Orders are never cancelled automatically.
- AR: مدة التسليم مكتوبة في العرض. راسل البائع في محادثة الطلب أولًا، فمعظم التأخير يُحل هناك. ما زال لا شيء؟ افتح نزاعًا من صفحة الطلب. يراجع الفريق المحادثة والإثبات، وإن لم يُسلَّم الطلب يُسترد المبلغ إلى رصيدك. لا تُلغى الطلبات تلقائيًا أبدًا.

**`account-insurance`**: hide at launch (accounts are Phase 2).

**`game-fields-and-filters`**: replace the LoL/Valorant/WoW/CS2 examples:
- EN: Each game splits its market: Albion Online by server, Path of Exile by league and mode (Softcore/Hardcore), Aion by server and region. Pick a category, then use the filters above the offers.
- AR: كل لعبة تقسّم سوقها: Albion Online حسب السيرفر، وPath of Exile حسب الليج والوضع (Softcore/Hardcore)، وAion حسب السيرفر والمنطقة. اختر الفئة ثم استخدم الفلاتر فوق العروض.

**`refund-timing`**: replace "(USDT TRC-20)" with "in crypto" / «بالكريبتو», and add the fee once: "6% withdrawal fee, minimum $1.50." / «رسوم السحب 6% بحد أدنى 1.50 دولار.»

**`selling-fees`**: delete "and what you keep after the withdrawal fee". Add the table once:
- EN: Ranks by 30-day sales: Hatchling $0 · 13.99% → Scale $500 · 12.99% → Fang $2,000 · 11.99% → Basilisk $5,000 · 10.99% → Dragon $15,000 · 9.99%. New sellers pay 5% for their first 60 days. Example: you set $10 → the buyer pays $11.63 (or $10.53 in the promo), and you earn $10.
- AR: الرتب حسب مبيعات 30 يومًا: فَقيس 0$ · 13.99% ← حَرشَفة 500$ · 12.99% ← ناب 2,000$ · 11.99% ← باسيليسك 5,000$ · 10.99% ← تِنّين 15,000$ · 9.99%. البائع الجديد يدفع 5% أول 60 يومًا. مثال: سعرك 10$ ← يدفع المشتري 11.63$ (أو 10.53$ خلال العرض) وتربح 10$.

**`getting-paid`**: replace body:
- EN: Money from a sale becomes available when the buyer confirms, or when staff release the order after checking your proof (never before 24 hours). Withdraw in crypto to the address you confirmed by email. Fee: 6%, minimum $1.50. Withdrawals are approved and sent within about 3 working days.
- AR: تصبح أموال البيع متاحة عند تأكيد المشتري، أو عندما يحرّر الفريق الطلب بعد مراجعة إثباتك (ولا يحدث ذلك قبل 24 ساعة). اسحب بالكريبتو إلى العنوان الذي أكدته عبر البريد. الرسوم 6% بحد أدنى 1.50 دولار، وتُعتمد السحوبات وتُرسل خلال 3 أيام عمل تقريبًا.

**`verify-identity`**: replace:
- EN: Level 1 is a verified email and phone. That's enough to buy and to start selling. Level 2 is a photo ID and a short selfie video, due within 30 days of your first offer; after that, selling and withdrawals pause until it's done.
- AR: المستوى 1 بريد وهاتف موثّقان، ويكفي للشراء وبدء البيع. المستوى 2 هوية بصورة وفيديو سيلفي قصير، مطلوب خلال 30 يومًا من أول عرض، وبعدها يتوقف البيع والسحب حتى تكمله.

**`invite-friends`** (topic `account`): Invite friends, earn 20% / ادعُ أصدقاءك واربح 20%
- EN: Share your invite link. When a friend signs up with it and completes their first order, you start earning 20% of Bullizard's commission on every order they complete, for as long as they stay active. Earnings land in your balance: spend them or withdraw.
- AR: شارك رابط الدعوة. عندما يسجّل صديقك عبره ويكمل أول طلب، تبدأ في ربح 20% من عمولة Bullizard على كل طلب يكمله، طالما بقي نشطًا. تُضاف الأرباح إلى رصيدك لتستخدمها أو تسحبها.

## 3. Ranks + Founding Seller
Rank names are stored in English in the database. Front end shows them through `rank.name.<English>` keys. Only Dragon uses the accent colour.
| Key | EN name | AR name | 30-day sales · fee | EN perk (`rank.perk.<name>`) | AR perk |
|---|---|---|---|---|---|
| `rank.name.Hatchling` | Hatchling | فَقيس | $0 · 13.99% | Fresh out of the egg. Every Dragon starts here. | خرجت للتو من البيضة. كل تنين يبدأ من هنا. |
| `rank.name.Scale` | Scale | حَرشَفة | $500 · 12.99% | First armour on: a lower fee and a cheaper shelf price. | أول درع لك: عمولة أقل وسعر أرخص للمشتري. |
| `rank.name.Fang` | Fang | ناب | $2,000 · 11.99% | Now you bite: your offers undercut new sellers at the same price. | الآن تعضّ: عروضك أرخص من البائعين الجدد بنفس سعرك. |
| `rank.name.Basilisk` | Basilisk | باسيليسك | $5,000 · 10.99% | One look and buyers stop scrolling. | نظرة واحدة وتتوقف أيدي المشترين عن التمرير. |
| `rank.name.Dragon` | Dragon | تِنّين | $15,000 · 9.99% | Lowest fee on Bullizard, plus a featured spot on the home page. | أقل عمولة على Bullizard، ومكان مميّز في الصفحة الرئيسية. |
| `founding.badge` | Founding Seller | بائع مؤسس | — | Opened shop at launch. Keeps the badge for good. | فتح متجره مع الإطلاق، والشارة معه للأبد. |
| `founding.hint` [CHANGE] | — | — | — | Opened their shop at the Bullizard launch | فتح متجره مع إطلاق Bullizard |

## 6. SEO pages (one per launch game) — `seo.*` keys
Rules: what you can buy, how buying works, server/league choice, honest FAQ. No farming tips, no guides. Game names in text only. Each page ends with the live offer table.

Shared "How buying works" / «كيف يتم الشراء» (`seo.how.title`, `seo.how.1`..`seo.how.4`):
| EN | AR |
|---|---|
| 1. Pick your server and amount. | 1. اختر السيرفر والكمية. |
| 2. Confirm your character name and pay in crypto. Your money is held. | 2. أكّد اسم شخصيتك وادفع بالكريبتو، وأموالك محجوزة. |
| 3. The seller trades with you in-game and uploads video proof. | 3. يسلّمك البائع داخل اللعبة ويرفع فيديو إثبات. |
| 4. You confirm, or our staff check the proof. Then the seller is paid. | 4. تؤكد أنت، أو يراجع فريقنا الإثبات، ثم يستلم البائع أمواله. |

Shared FAQ (`seo.faq.title`, `seo.faq.1.q/.a` … `seo.faq.4.q/.a`):
| EN | AR |
|---|---|
| **Is it safe?** Your payment is held until the delivery is proven on video and checked by a person. If something's wrong, an arbiter decides. | **هل الشراء آمن؟** دفعتك محجوزة حتى يثبت التسليم بالفيديو ويراجعه إنسان، وإن حدثت مشكلة يقرر الحَكَم. |
| **How do I pay?** Crypto: USDT, USDC, LTC and more. The total includes the network fee. | **كيف أدفع؟** بالكريبتو: USDT وUSDC وLTC وغيرها، والإجمالي يشمل رسوم الشبكة. |
| **What if I typed the wrong character name?** The seller delivers to the name you confirmed, so check it before paying. | **ماذا لو كتبت اسم الشخصية خطأ؟** يسلّم البائع للاسم الذي أكدته، فتأكد منه قبل الدفع. |
| **Can my game account get banned?** Buying in-game goods for real money may break the game's rules. That risk is yours. Bullizard isn't affiliated with the publisher. | **هل يمكن أن يُحظر حسابي في اللعبة؟** شراء ممتلكات داخل اللعبة بأموال حقيقية قد يخالف قوانين اللعبة، وهذه مخاطرة تتحملها أنت، وBullizard غير تابع للناشر. |

Per game (`seo.<slug>.title`, `.description`, `.h1`, `.intro`, `.buy`, `.servers`):

### aion
| Field | EN | AR |
|---|---|---|
| Title tag | Buy Aion Kinah & Items · Bullizard | شراء كينا وآيتمز Aion · Bullizard |
| Meta description | Buy Aion Kinah and items from real players. Pay in crypto; your money is held until the delivery is proven and checked. | اشترِ كينا وآيتمز Aion من لاعبين حقيقيين. ادفع بالكريبتو، وأموالك محجوزة حتى يثبت التسليم وتتم مراجعته. |
| H1 | Buy Aion Kinah and items | شراء كينا وآيتمز Aion |
| Intro | Skip the grind and get back to the fun part. Buy Kinah and items from real Aion players, delivered in-game to your character. Every order is checked by a person before the seller is paid. | تخطَّ الفارم وارجع للمتعة. اشترِ الكينا والآيتمز من لاعبي Aion الحقيقيين، تُسلَّم داخل اللعبة إلى شخصيتك، وكل طلب يراجعه إنسان قبل أن يستلم البائع أمواله. |
| What you can buy | Kinah by the million. Pick any amount from the seller's minimum up to their stock. Items: gear and materials, traded to your character. | الكينا بالمليون: اختر أي كمية من الحد الأدنى للبائع حتى مخزونه. الآيتمز: عتاد ومواد تُسلَّم إلى شخصيتك. |
| Servers | Pick your server and region from the filter. Prices and stock are per server. | اختر السيرفر والمنطقة من الفلتر، فالأسعار والمخزون تختلف حسب السيرفر. |

### aion-2
| Field | EN | AR |
|---|---|---|
| Title tag | Buy Aion 2 Kina & Items · Bullizard | شراء كينا وآيتمز Aion 2 · Bullizard |
| Meta description | Buy Aion 2 Kina and items from real players. Crypto checkout, video proof on every delivery, paid out only after it's checked. | اشترِ كينا وآيتمز Aion 2 من لاعبين حقيقيين. دفع بالكريبتو، وإثبات فيديو مع كل تسليم، ولا يستلم البائع إلا بعد المراجعة. |
| H1 | Buy Aion 2 Kina and items | شراء كينا وآيتمز Aion 2 |
| Intro | New world, same grind. Unless you skip it. Buy Kina and items for Aion 2 from players already ahead, delivered in-game with video proof. | عالم جديد ونفس الفارم، إلا إذا تخطيته. اشترِ الكينا والآيتمز في Aion 2 من لاعبين سبقوك، تُسلَّم داخل اللعبة مع إثبات بالفيديو. |
| What you can buy | Kina by amount, from the seller's minimum up to their stock. Items: gear and materials, traded to your character. | الكينا بالكمية، من الحد الأدنى للبائع حتى مخزونه. الآيتمز: عتاد ومواد تُسلَّم إلى شخصيتك. |
| Servers | Pick your server and region from the filter. Only trade on the server your character plays on. | اختر السيرفر والمنطقة من الفلتر، واشترِ فقط على السيرفر الذي تلعب عليه شخصيتك. |

### albion-online
| Field | EN | AR |
|---|---|---|
| Title tag | Buy Albion Online Silver & Items · Bullizard | شراء فضة وآيتمز Albion Online · Bullizard |
| Meta description | Buy Albion Online Silver and items on Americas, Europe and Asia servers. Pay in crypto; your money is held until the delivery is proven. | اشترِ فضة وآيتمز Albion Online على سيرفرات Americas وEurope وAsia. ادفع بالكريبتو، وأموالك محجوزة حتى يثبت التسليم. |
| H1 | Buy Albion Online Silver and items | شراء فضة وآيتمز Albion Online |
| Intro | Gear breaks. Silver runs out. Skip the grind and buy Silver and items from real Albion players, traded to your character with video proof. | العتاد ينكسر والفضة تنفد. تخطَّ الفارم واشترِ الفضة والآيتمز من لاعبي Albion الحقيقيين، تُسلَّم إلى شخصيتك مع إثبات بالفيديو. |
| What you can buy | Silver by the million. Any amount from the seller's minimum to their stock. Items: gear, mounts and materials. | الفضة بالمليون: أي كمية من الحد الأدنى للبائع حتى مخزونه. الآيتمز: عتاد وخيول ومواد. |
| Servers | Americas, Europe or Asia. Pick yours from the filter. Silver can't move between servers, so match your character's server. | Americas أو Europe أو Asia، اختر سيرفرك من الفلتر. الفضة لا تنتقل بين السيرفرات، فاختر سيرفر شخصيتك. |

### path-of-exile
| Field | EN | AR |
|---|---|---|
| Title tag | Buy PoE Currency: Divine & Chaos Orbs · Bullizard | شراء عملات PoE: Divine وChaos Orbs · Bullizard |
| Meta description | Buy Path of Exile Divine Orbs, Chaos Orbs and items for the current league. Crypto checkout, video proof, money held until it's checked. | اشترِ Divine Orbs وChaos Orbs وآيتمز Path of Exile للّيج الحالي. دفع بالكريبتو، وإثبات بالفيديو، والمبلغ محجوز حتى المراجعة. |
| H1 | Buy Path of Exile currency and items | شراء عملات وآيتمز Path of Exile |
| Intro | League just started and your build needs Divines yesterday? Skip the grind. Buy orbs and items from real players, traded in-game with video proof. | بدأ الليج وبيلدك يحتاج Divines الآن؟ تخطَّ الفارم. اشترِ الأورب والآيتمز من لاعبين حقيقيين، تُسلَّم داخل اللعبة مع إثبات بالفيديو. |
| What you can buy | Currency: Divine Orbs, Chaos Orbs and more, by amount. Items: uniques and gear for your build. | العملات: Divine Orbs وChaos Orbs وغيرها بالكمية. الآيتمز: يونيك وعتاد لبيلدك. |
| League & mode | Pick the league and mode (Softcore or Hardcore) from the filter. Offers in an ended league come down automatically. | اختر الليج والوضع (Softcore أو Hardcore) من الفلتر. عروض الليج المنتهي تُزال تلقائيًا. |

### path-of-exile-2
| Field | EN | AR |
|---|---|---|
| Title tag | Buy PoE 2 Currency: Exalted & Divine Orbs · Bullizard | شراء عملات PoE 2: Exalted وDivine Orbs · Bullizard |
| Meta description | Buy Path of Exile 2 Exalted Orbs, Divine Orbs and items. Crypto checkout, video proof on every delivery, checked before the seller is paid. | اشترِ Exalted Orbs وDivine Orbs وآيتمز Path of Exile 2. دفع بالكريبتو، وإثبات فيديو مع كل تسليم، ومراجعة قبل أن يستلم البائع. |
| H1 | Buy Path of Exile 2 currency and items | شراء عملات وآيتمز Path of Exile 2 |
| Intro | Wraeclast got harder. Your stash doesn't have to. Buy Exalted and Divine Orbs and items from real PoE 2 players, traded in-game with video proof. | Wraeclast أصبحت أصعب، لكن مخزنك لا يجب أن يكون كذلك. اشترِ Exalted وDivine Orbs والآيتمز من لاعبي PoE 2 الحقيقيين، تُسلَّم داخل اللعبة مع إثبات بالفيديو. |
| What you can buy | Currency: Exalted Orbs, Divine Orbs and more, by amount. Items: uniques and gear. | العملات: Exalted Orbs وDivine Orbs وغيرها بالكمية. الآيتمز: يونيك وعتاد. |
| League & mode | Pick the league and mode (Softcore or Hardcore) from the filter. Offers in an ended league come down automatically. | اختر الليج والوضع (Softcore أو Hardcore) من الفلتر. عروض الليج المنتهي تُزال تلقائيًا. |
