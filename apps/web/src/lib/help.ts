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

export const HELP_TOPICS: Record<HelpTopic, { title: string; blurb: string }> = {
  buying: { title: 'Buying', blurb: 'Finding offers, ordering and receiving what you bought.' },
  protection: { title: 'Disputes & protection', blurb: 'Escrow, the inspection window, insurance and refunds.' },
  payments: { title: 'Payments', blurb: 'Cards, crypto, currencies and store credit.' },
  selling: { title: 'Selling', blurb: 'Listings, delivery, fees and getting paid.' },
  account: { title: 'Account & security', blurb: 'Verification, two-factor login and your data.' },
};

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: 'how-escrow-works',
    topic: 'protection',
    title: 'How escrow protects your order',
    summary: 'Your payment waits with us until you have what you paid for.',
    body: [
      'When you pay, the money goes into escrow, not to the seller. The seller only sees that the order is paid and can deliver.',
      'After delivery you have a protection window to check everything: 72 hours for keys, currency, items, top-ups and boosting, and 14 days of insurance for game accounts.',
      'The seller is paid when you confirm the order or when the window ends without a dispute, whichever comes first. If something is wrong, open a dispute from the order page before the window ends and the money stays frozen until it is settled.',
    ],
    ticket: 'order',
  },
  {
    slug: 'order-not-delivered',
    topic: 'buying',
    title: 'My order hasn’t been delivered',
    summary: 'What to do when a seller is late, and when you get your money back automatically.',
    body: [
      'Instant-delivery offers deliver the moment payment clears; check the order page. For manual offers, the seller promises a delivery time shown on the listing.',
      'Message the seller in the order chat first; most delays are sorted there. If the promised time passes, we remind the seller, and if they still don’t deliver the order is cancelled and refunded to you automatically.',
      'You can also open a dispute from the order page at any point while the payment is in escrow.',
    ],
    ticket: 'order',
  },
  {
    slug: 'open-a-dispute',
    topic: 'protection',
    title: 'Opening a dispute',
    summary: 'When something isn’t as described, an arbiter decides using the order chat and evidence.',
    body: [
      'Open a dispute from the order page while the order is in its protection window. Explain what is wrong and add screenshots to the order chat.',
      'The payment stays frozen while a Bullizard arbiter reviews the chat, delivery records and evidence from both sides.',
      '- If the arbiter decides for you, the full amount is refunded to your original payment method.\n- If they decide for the seller, the payment is released to them.',
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
    slug: 'game-fields-and-filters',
    topic: 'buying',
    title: 'Filtering by server, region, platform and rank',
    summary: 'Use the pickers on each game page to see only offers that work for you.',
    body: [
      'Many games split their market: League of Legends by server, Valorant by region, World of Warcraft by realm and faction, CS2 skins by exterior. Open a game, pick a category, and use the pickers above the offer table.',
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
    title: 'Ways to pay',
    summary: 'Cards through a hosted checkout, or USDC/USDT through an on-chain escrow contract.',
    body: [
      'Card payments go through our payment partner’s secure page; we never see your card number. You pay the price shown at checkout, in the listing’s currency.',
      'Crypto payments use an on-chain escrow contract with the same protection window. Send only the exact amount to the contract address shown for your order.',
      'Prices shown in another currency are approximate conversions; checkout always shows the exact amount you’ll be charged.',
    ],
    ticket: 'payment',
  },
  {
    slug: 'refund-timing',
    topic: 'payments',
    title: 'When will I see my refund?',
    summary: 'Refunds go back to the original payment method; banks take a few days.',
    body: [
      'Refunds return to the card or wallet you paid with. We send card refunds immediately; your bank usually shows them within 5–10 business days.',
      'Store credit (from promotions or referrals) is returned as store credit straight away.',
    ],
    ticket: 'payment',
  },
  {
    slug: 'selling-fees',
    topic: 'selling',
    title: 'Seller fees and levels',
    summary: 'Fees fall as your 30-day sales grow; gift cards, top-ups and video games have a lower rate.',
    body: [
      'Each sale pays a commission that depends on your seller level, which is set by your sales over the last 30 days. Accounts have their own rate; gift cards, top-ups and video games pay 4.99%.',
      'You see the exact fee and your net earnings on each order, and your level and progress on the seller hub.',
    ],
    ticket: 'selling',
  },
  {
    slug: 'getting-paid',
    topic: 'selling',
    title: 'Getting paid',
    summary: 'Withdraw to your bank in USD, EUR or GBP once the protection window ends.',
    body: [
      'Money from a sale becomes available when the buyer confirms or the protection window ends. Withdraw it from the seller hub to the bank account you added on our payment partner’s page.',
      'New sellers may have a short payout hold while we build trust; the hub shows when held money is released.',
      'If a refund or chargeback takes your balance below zero, new sales pay it down first and withdrawals pause until it is settled.',
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
    summary: 'Level 1 to buy, level 2 (photo ID) to sell.',
    body: [
      'Level 1 means a verified email and phone number; it’s enough to buy. Level 2 adds a photo ID and a liveness check through our verification partner, and is required to sell.',
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

export const articleBySlug = (slug: string) => HELP_ARTICLES.find((a) => a.slug === slug);

/** Simple ranked search over titles, summaries and bodies. */
export function searchHelp(q: string) {
  const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
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

export const TICKET_CATEGORY_LABEL: Record<string, string> = {
  order: 'A problem with an order',
  payment: 'Payments and refunds',
  account: 'My account or verification',
  selling: 'Selling and payouts',
  report: 'Report a user',
  other: 'Something else',
};
