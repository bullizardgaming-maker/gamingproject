import { helpPack, onLocaleChange } from '../i18n';
import { PHASE2_UI } from './launch';

/**
 * Help-centre articles. Plain data so it ships with the app and works offline; each article is a
 * list of paragraphs (a paragraph starting with "- " lines renders as a list).
 */
export interface HelpArticle {
  slug: string;
  topic: HelpTopic;
  title: string;
  summary: string;
  body: string[];
  /** Pre-selects the support form's category when the reader still needs help. */
  ticket?: 'order' | 'payment' | 'account' | 'selling' | 'report' | 'other';
}
export type HelpTopic = 'buying' | 'protection' | 'payments' | 'selling' | 'account';

const BASE_TOPICS: Record<HelpTopic, { title: string; blurb: string }> = {
  buying: { title: 'Buying', blurb: 'Finding offers, ordering and receiving what you bought.' },
  protection: { title: 'Disputes & protection', blurb: "Buyer Protection, escrow, insurance and refunds." },
  payments: { title: 'Payments', blurb: "Crypto, network fees, your wallet and refunds." },
  selling: { title: 'Selling', blurb: 'Listings, delivery, fees and getting paid.' },
  account: { title: 'Account & security', blurb: 'Verification, two-factor login and your data.' },
};

const BASE_ARTICLES: HelpArticle[] = [
  {
    slug: 'buyer-protection',
    topic: 'protection',
    title: "Bullizard Buyer Protection",
    summary: "Your money is held until the delivery is proven and checked.",
    body: [
      "When you pay, Bullizard holds the money. The seller delivers in-game and uploads a video or photo of the trade.",
      "The seller is paid when you confirm. If you don't confirm, our staff check the proof and release it: never before 24 hours after delivery.",
      "Not delivered, or wrong amount or item: open a dispute before you confirm. The money stays frozen until an arbiter decides; if they decide for you, it's refunded to your balance.",
      "Keep the whole trade in the order chat. Deals made outside Bullizard aren't protected, and sharing outside contacts can get your account banned right away.",
    ],
    ticket: 'order',
  },
  {
    slug: 'how-escrow-works',
    topic: 'protection',
    title: "How escrow protects your order",
    summary: "Your payment waits with us until you confirm you have what you paid for.",
    body: [
      "When you pay, the money goes into escrow, not to the seller. The seller only sees that the order is paid and can deliver.",
      "There's no auto-release. The money stays held until you confirm, or until staff check the proof (never before 24 hours after delivery). Confirm only when you have everything.",
      "If something is wrong, open a dispute from the order page instead of confirming. The money stays frozen until it is settled.",
    ],
    ticket: 'order',
  },
  {
    slug: 'order-not-delivered',
    topic: 'buying',
    title: 'My order hasn’t been delivered',
    summary: 'What to do when a seller is late, and how you get your money back.',
    body: [
      "The seller's delivery time is on the offer. Message them in the order chat first. Most delays are sorted there.",
      "Still nothing? Open a dispute from the order page. Staff check the chat and proof; if the order wasn't delivered, you're refunded to your balance. Orders are never cancelled automatically.",
    ],
    ticket: 'order',
  },
  {
    slug: 'open-a-dispute',
    topic: 'protection',
    title: "Opening a dispute",
    summary: "When something isn’t as described, an arbiter decides using the order chat and evidence.",
    body: [
      "Open a dispute from the order page before you confirm the order. Explain what is wrong and add screenshots to the order chat.",
      "The payment stays frozen while a Bullizard arbiter reviews the chat, delivery records and evidence from both sides.",
      "- If the arbiter decides for you, the full amount is refunded to your Bullizard balance.\n- If they decide for the seller, the payment is released to them.",
    ],
    ticket: 'order',
  },
  {
    slug: 'account-insurance',
    topic: 'protection',
    title: 'Game account insurance and owner proof',
    summary: 'Why account listings have 14 days of insurance and what “owner verified” means.',
    body: [
      'Accounts can be recovered by a previous owner, so account orders are insured for 14 days after delivery: if the account is pulled back in that time, you are refunded.',
      'Listings marked owner-verified come from the original owner, who showed us the registration email and early purchase receipts. Listings without it are labelled high risk; escrow and insurance still apply.',
      'After the handover, change the email, password and two-factor settings straight away.',
    ],
    ticket: 'order',
  },
  {
    slug: 'delivery-in-game',
    topic: 'buying',
    title: 'How in-game delivery works',
    summary: 'Currency and items are traded to the character name you confirm at checkout; the seller attaches proof and you release the payment.',
    body: [
      'For games that deliver in-game (currency, items, top-ups), you give the exact character name or UID the seller should trade with. It is confirmed in one tap at checkout and remembered for your next order; check it carefully, because the seller delivers to that name and you are responsible for it being right.',
      'The seller trades with that character and attaches a photo or video of the trade before marking the order delivered. You can watch the proof on the order page.',
      'The payment stays in escrow until you confirm you received the goods. If something is wrong, open a dispute from the order page instead of confirming; staff compare the proof with the trade and decide.',
    ],
    ticket: 'order',
  },
  {
    slug: 'game-fields-and-filters',
    topic: 'buying',
    title: 'Filtering by server, region, platform and rank',
    summary: 'Use the pickers on each game page to see only offers that work for you.',
    body: [
      'Each game splits its market: Albion Online by server, Path of Exile by league and mode (Softcore/Hardcore), Aion by server and region. Pick a category, then use the filters above the offers.',
      'Each option shows how many live offers it has with your other filters applied. Sellers must fill these fields in, so a filter is reliable.',
    ],
  },
  {
    slug: 'price-alerts',
    topic: 'buying',
    title: 'Watchlists and price alerts',
    summary: 'Follow a listing or a whole market and hear about new lows.',
    body: [
      'Use “Price alert” on a listing, or “Alert me on new lows” on a game page (it keeps your server or region filters). You can set a target price, or leave it empty to hear about any drop.',
      'We check every few minutes and notify you once per new low, plus when a sold-out listing is back in stock. Manage everything from your Watchlist.',
    ],
  },
  {
    slug: 'payment-methods',
    topic: 'payments',
    title: "Ways to pay",
    summary: "Pay in crypto: pick a popular coin; its network fee is added to the total.",
    body: [
      "Checkout takes crypto. Pick a coin from the list; each one shows its network (for example TRC-20) and the total to send.",
      "The coin’s network fee is added on top: an $11.50 order with a $1.00 fee means you send $12.50. Only the order amount goes to the seller.",
      "Send the exact amount to the address shown, on the same network. The order is paid once the network confirms it. Coins whose minimum is above your order are greyed out.",
      "Money in your Bullizard balance is used first.",
    ],
    ticket: 'payment',
  },
  {
    slug: 'refund-timing',
    topic: 'payments',
    title: "When will I see my refund?",
    summary: "Refunds land in your Bullizard balance straight away.",
    body: [
      "When an order is refunded, the money goes to your Bullizard balance at once. You can see it on your Wallet page.",
      "Use it on your next order, or withdraw it in crypto. 6% withdrawal fee, minimum $1.50. It's sent after approval.",
    ],
    ticket: 'payment',
  },
  {
    slug: 'wallet',
    topic: 'payments',
    title: "Your wallet",
    summary: "Your balance and every money movement in one list.",
    body: [
      "Open Wallet from the account menu. The top shows your balance; below is every order, refund, sale and withdrawal.",
      "- Yellow, Held: the money is in escrow until the order is confirmed.\n- Green, Completed: done.\n- Red, Cancelled: the order or withdrawal was cancelled.\n- Grey, Pending: waiting for payment or approval.",
      "Sellers see their sales in the same list. Payouts and tax documents are on the seller hub under Money.",
    ],
    ticket: 'payment',
  },
  {
    slug: 'invite-friends',
    topic: 'account',
    title: "Invite friends, earn 20%",
    summary: "Share your invite link and earn 20% of Bullizard's commission on every order your friends complete, for as long as they stay active.",
    body: [
      "Share your invite link. When a friend signs up with it and completes their first order, you start earning 20% of Bullizard's commission on every order they complete, for as long as they stay active (a completed order in the last 30 days). Earnings land in your balance: spend them or withdraw.",
      "One code per account, entered at sign-up only. Your friend types your code (or opens your link) when they create their account; a code can't be added or changed later, and an account carries either a friend's invite code or a creator's code, never both. Nothing is earned on orders you sell to your own invitees.",
    ],
    ticket: 'account',
  },
  {
    slug: 'selling-fees',
    topic: 'selling',
    title: 'Seller commission and ranks',
    summary: 'You set your price and receive it in full; the commission is added on top for the buyer and falls as your rank grows.',
    body: [
        'You enter the price you want. The commission for your rank is added on top for the buyer, so the amount you typed is exactly what lands in your balance when the order completes. Ranks are set by your completed sales over the last 30 days; new sellers pay a reduced launch rate for their first 60 days.',
        'The sell form shows what buyers will pay in each currency before you publish. Your rank and progress are on the seller hub.',
        'Ranks by 30-day sales: Hatchling $0 · 13.99% → Scale $500 · 12.99% → Fang $2,000 · 11.99% → Basilisk $5,000 · 10.99% → Dragon $15,000 · 9.99%. New sellers pay 5% for their first 60 days. Example: you set $10 → the buyer pays $11.63 (or $10.53 in the promo), and you earn $10.',
      ],
    ticket: 'selling',
  },
  {
    slug: 'getting-paid',
    topic: 'selling',
    title: 'Getting paid',
    summary: 'Withdraw in crypto once the order is confirmed or released; a 6% fee applies.',
    body: [
        'Money from a sale becomes available when the buyer confirms, or when staff release the order after checking your proof (never before 24 hours). Withdraw in crypto to the address you confirmed by email. Fee: 6%, minimum $1.50. Withdrawals are approved and sent within about 3 working days.',
      ],
    ticket: 'selling',
  },
  {
    slug: 'sell-by-amount',
    topic: 'selling',
    title: "Selling currency by amount",
    summary: "Set a unit, a price per unit, a minimum and your stock; buyers pick how much.",
    body: [
      "In the sell form choose Currency and fill in the unit, for example M for millions of silver. The price is then per unit.",
      "Set your stock and the minimum order, both in units. Buyers choose any amount from your minimum up to your stock, and the total updates as they go.",
      "On the game page your offer shows in the sellers table with your server, stock, minimum, delivery time and price per unit.",
    ],
    ticket: 'selling',
  },
  {
    slug: 'seller-badges',
    topic: 'selling',
    title: "Your badges and shop page",
    summary: "Pick the 2 badges buyers see next to your name.",
    body: [
      "You earn badges as you sell: your rank, Founding Seller, ID verified and Top seller. On the seller hub, under your shop page, pick up to 2 to show next to your name on offers.",
      "Your shop page also shows the languages you speak, your intro and your stats: positive reviews, rating, orders sold and on-time delivery.",
    ],
    ticket: 'selling',
  },
  {
    slug: 'seller-analytics',
    topic: 'selling',
    title: 'Reading your shop analytics',
    summary: 'Views, conversion and repeat buyers, and how they are counted.',
    body: [
      'The Analytics tab shows sales, listing views, conversion (orders divided by views), average order and repeat buyers, compared with the period before.',
      'A view is counted once per visitor, listing and hour, and never when you look at your own listing.',
    ],
  },
  {
    slug: 'verify-identity',
    topic: 'account',
    title: 'Verifying your identity',
    summary: 'Level 1 to buy and start selling; level 2 (photo ID) within 30 days of your first offer.',
    body: [
      'Level 1 is a verified email and phone. That\'s enough to buy and to start selling. Level 2 is a photo ID and a short selfie video, due within 30 days of your first offer; after that, selling and withdrawals pause until it\'s done.',
      'Verification usually takes a few minutes. If it fails, check the photo is sharp and every corner of the document is visible, then try again.',
    ],
    ticket: 'account',
  },
  {
    slug: 'two-factor',
    topic: 'account',
    title: 'Two-factor login and staying secure',
    summary: 'Turn on an authenticator app and never share codes from your order chat.',
    body: [
      'Turn on two-factor login in Account → Security with any authenticator app, and keep your recovery codes somewhere safe.',
      'Bullizard staff will never ask for your password or a login code. Keep trades in the order chat: deals moved to other apps aren’t protected by escrow.',
    ],
    ticket: 'account',
  },
  {
    slug: 'report-a-user',
    topic: 'account',
    title: 'Reporting a scam attempt or abuse',
    summary: 'Tell us about off-platform payment requests, phishing links or harassment.',
    body: [
      'If someone asks you to pay outside Bullizard, sends a suspicious link, or is abusive, don’t reply further. Send us a request in the “Report a user” category with their name and the order or chat it happened in.',
      'Our trust and safety team reviews every report. We can’t always tell you the outcome, but we act on them.',
    ],
    ticket: 'report',
  },
];

const BASE_TICKET_LABELS: Record<string, string> = {
  order: 'A problem with an order',
  payment: 'Payments and refunds',
  account: 'My account or verification',
  selling: 'Selling and payouts',
  report: 'Report a user',
  other: 'Something else',
};

// The exports below are live bindings: they are rebuilt in the active language whenever it changes
// (falling back to English for anything a translation leaves out).
/** Articles about phase-2 features (account insurance): kept for the full demo, hidden at launch. */
const HIDDEN_AT_LAUNCH = new Set(['account-insurance']);
const visible = (a: HelpArticle) => PHASE2_UI || !HIDDEN_AT_LAUNCH.has(a.slug);
export let HELP_TOPICS = BASE_TOPICS;
export let HELP_ARTICLES = BASE_ARTICLES.filter(visible);
export let TICKET_CATEGORY_LABEL = BASE_TICKET_LABELS;
function localize() {
  const pack = helpPack();
  HELP_TOPICS = pack ? (Object.fromEntries(Object.entries(BASE_TOPICS).map(([k, v]) => [k, pack.topics[k] ?? v])) as typeof BASE_TOPICS) : BASE_TOPICS;
  HELP_ARTICLES = (pack ? BASE_ARTICLES.map((a) => ({ ...a, ...pack.articles[a.slug] })) : BASE_ARTICLES).filter(visible);
  TICKET_CATEGORY_LABEL = pack ? { ...BASE_TICKET_LABELS, ...pack.ticketCategories } : BASE_TICKET_LABELS;
}
localize();
onLocaleChange(localize);

export const articleBySlug = (slug: string) => HELP_ARTICLES.find((a) => a.slug === slug);

/** Simple ranked search over titles, summaries and bodies. */
export function searchHelp(q: string) {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (!words.length) return [];
  return HELP_ARTICLES.map((a) => {
    const title = a.title.toLowerCase();
    const rest = `${a.summary} ${a.body.join(' ')}`.toLowerCase();
    const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 0) + (rest.includes(w) ? 1 : 0), 0);
    return { a, score };
  })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}

