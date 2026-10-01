/**
 * Sample data for the demo preview (no backend). Mirrors the API's shapes closely enough that
 * every page works: three demo accounts, a market of listings, and a few orders in different
 * states so escrow, chat, disputes and the operations console all have something to show.
 */
export const DEMO_PASSWORD = 'demo-password-123';
export const DEMO_CODE = '123456';

const day = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

export interface DemoUser {
  id: string;
  email: string;
  password: string;
  display_name: string;
  role: 'user' | 'arbiter' | 'support' | 'finance' | 'compliance' | 'admin';
  staff_roles?: string[];
  kyc_tier: number;
  status: string;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  withdrawals_frozen: boolean;
  totp_enabled: boolean;
  payouts_enabled: boolean;
  legal_name: string | null;
  created_at: string;
}

const u = (id: string, email: string, name: string, role: DemoUser['role'], tier: number, extra: Partial<DemoUser> = {}): DemoUser => ({
  id,
  email,
  password: DEMO_PASSWORD,
  display_name: name,
  role,
  kyc_tier: tier,
  status: 'active',
  email_verified_at: tier >= 1 ? ago(90 * day) : null,
  phone_verified_at: tier >= 1 ? ago(90 * day) : null,
  withdrawals_frozen: false,
  totp_enabled: false,
  payouts_enabled: tier >= 2,
  legal_name: tier >= 2 ? name : null,
  created_at: ago(120 * day),
  ...extra,
});

export const CATEGORIES = [
  { slug: 'accounts', name: 'Game Accounts', kind: 'account' },
  { slug: 'currency', name: 'In-Game Currency', kind: 'currency' },
  { slug: 'items', name: 'In-Game Items', kind: 'item' },
  { slug: 'keys', name: 'Software & CD Keys', kind: 'key' },
  { slug: 'boosting', name: 'Boosting Services', kind: 'boosting' },
  { slug: 'gift-cards', name: 'Gift Cards', kind: 'gift_card' },
  { slug: 'top-ups', name: 'Mobile Top-ups', kind: 'topup' },
  { slug: 'video-games', name: 'Video Games', kind: 'video_game' },
];

type Seed = [cat: string, game: string, title: string, price: number, mode: 'auto' | 'manual', stock: number, seller: string, proof?: string, description?: string];

const LISTINGS: Seed[] = [
  ['keys', 'Elden Ring', 'Elden Ring — Steam key (Global)', 32_49, 'auto', 40, 'seller', 'none', 'Global Steam key, activates instantly. Delivered to your order page the second payment clears.'],
  ['keys', 'Baldur’s Gate 3', 'Baldur’s Gate 3 — Steam key (EU)', 41_99, 'auto', 18, 'seller2'],
  ['keys', 'Cyberpunk 2077', 'Cyberpunk 2077 + Phantom Liberty — GOG key', 38_90, 'auto', 9, 'seller'],
  ['gift-cards', 'Steam', 'Steam Wallet $50 gift card (US)', 47_90, 'auto', 25, 'seller', 'none', 'US region Steam Wallet code. Instant delivery.'],
  ['gift-cards', 'PlayStation', 'PlayStation Store $25 (US)', 23_99, 'auto', 31, 'seller2'],
  ['top-ups', 'Genshin Impact', '6480 Genesis Crystals — direct top-up', 89_99, 'manual', 12, 'seller3', 'none', 'Send your UID in the order chat. Topped up within 30 minutes.'],
  ['currency', 'World of Warcraft', '100k Gold — Stormrage (Alliance)', 18_00, 'manual', 30, 'seller', 'none', 'Delivered face-to-face in Stormwind or by mailbox within 2 hours.'],
  ['currency', 'Old School RuneScape', '100M OSRS GP', 54_00, 'manual', 8, 'seller3'],
  ['accounts', 'World of Warcraft', 'Lvl 80 Warrior, full mythic gear, 2009 account', 300_00, 'manual', 1, 'seller', 'verified', 'Original owner since 2009. Registration email and early receipts verified. Full changeover support.'],
  ['accounts', 'Valorant', 'Immortal 2 account, 34 skins', 145_00, 'manual', 1, 'seller2', 'none'],
  ['accounts', 'Fortnite', 'OG account, Renegade Raider + 210 skins', 420_00, 'manual', 1, 'seller3', 'verified'],
  ['boosting', 'League of Legends', 'Gold IV → Platinum IV, duo queue', 89_00, 'manual', 5, 'seller', 'none', 'Duo queue with a Grandmaster player. You keep playing on your own account.'],
  ['boosting', 'Counter-Strike 2', 'Premier 10k → 15k rating', 64_00, 'manual', 4, 'seller3'],
  ['items', 'Counter-Strike 2', 'AK-47 | Redline (Field-Tested)', 21_75, 'manual', 3, 'seller'],
  ['items', 'Diablo IV', 'Shako (Harlequin Crest), Season 6', 12_50, 'manual', 6, 'seller2'],
  ['video-games', 'Nintendo', 'Zelda: Tears of the Kingdom — eShop code (US)', 52_00, 'auto', 7, 'seller2'],
];

export function seed() {
  const users = [
    u('u-buyer-0000-4000-8000-000000000001', 'buyer@demo.test', 'Pixel Pat', 'user', 1),
    u('u-sell1-0000-4000-8000-000000000002', 'seller@demo.test', 'NorthWind Keys', 'user', 2),
    u('u-admin-0000-4000-8000-000000000003', 'admin@demo.test', 'Arbiter Ada', 'admin', 2),
    u('u-sell2-0000-4000-8000-000000000004', 'rift@demo.test', 'RiftTrader', 'user', 2),
    u('u-sell3-0000-4000-8000-000000000005', 'arcane@demo.test', 'ArcaneBoost', 'user', 2),
  ];
  const sellerId: Record<string, string> = { seller: users[1]!.id, seller2: users[3]!.id, seller3: users[4]!.id };

  const offers = LISTINGS.map(([cat, game, title, price, mode, stock, seller, proof, description], i) => {
    const kind = CATEGORIES.find((c) => c.slug === cat)!.kind;
    return {
      id: `offer-${i + 1}`,
      seller_id: sellerId[seller]!,
      category_slug: cat,
      category_kind: kind,
      game,
      title,
      description: description ?? '',
      price_cents: price,
      currency: 'USD',
      delivery_mode: mode,
      stock,
      inventory: mode === 'auto' ? Array.from({ length: stock }, (_, k) => `${game.slice(0, 4).toUpperCase().replace(/[^A-Z]/g, 'X')}-${String(k + 1).padStart(4, '0')}-${(i * 7919 + k * 104729).toString(36).toUpperCase().slice(-5).padStart(5, 'Q')}`) : [],
      status: 'active',
      owner_proof_status: kind === 'account' ? proof ?? 'none' : 'none',
      version: 1,
      created_at: ago((LISTINGS.length - i) * 3_600_000 * 7),
    };
  });

  return {
    users,
    offers,
    orders: [] as any[],
    rooms: [] as any[],
    messages: [] as any[],
    reviews: [
      { id: 'r1', order_id: 'seed-1', seller_id: users[1]!.id, rating: 5, comment: 'Key worked instantly.', seller_reply: null, created_at: ago(20 * day) },
      { id: 'r2', order_id: 'seed-2', seller_id: users[1]!.id, rating: 5, comment: 'Gold arrived in 20 minutes.', seller_reply: 'Thanks!', created_at: ago(12 * day) },
      { id: 'r3', order_id: 'seed-3', seller_id: users[1]!.id, rating: 4, comment: 'Smooth account handover.', seller_reply: null, created_at: ago(6 * day) },
      { id: 'r4', order_id: 'seed-4', seller_id: users[3]!.id, rating: 5, comment: 'Fast and friendly.', seller_reply: null, created_at: ago(9 * day) },
      { id: 'r5', order_id: 'seed-5', seller_id: users[4]!.id, rating: 4, comment: 'Boost done a day early.', seller_reply: null, created_at: ago(3 * day) },
    ] as any[],
    completedBefore: { [users[1]!.id]: 212, [users[3]!.id]: 64, [users[4]!.id]: 131 } as Record<string, number>,
    balances: { [users[1]!.id]: 1_284_50, [users[3]!.id]: 312_00, [users[4]!.id]: 861_40 } as Record<string, number>,
    monthlySales: { [users[1]!.id]: 6_420_00, [users[3]!.id]: 840_00, [users[4]!.id]: 2_310_00 } as Record<string, number>,
    withdrawals: [] as any[],
    apiKeys: [] as any[],
    webhooks: [] as any[],
    emailPrefs: {} as Record<string, Record<string, boolean>>,
    ownerProofs: [
      {
        id: 'p1', offer_id: offers.find((o) => o.title.startsWith('Immortal 2'))!.id, title: 'Immortal 2 account, 34 skins', seller_id: users[3]!.id,
        registration_email: 'rift.original@example.com', registration_date: '2020-06-02', billing_name: 'RiftTrader', seller_legal_name: 'RiftTrader',
        status: 'pending', created_at: ago(2 * day),
      },
    ] as any[],
    riskFlags: [
      {
        id: 'k1', user_id: 'u-x', display_name: 'fresh_seller_77', email: 'fresh77@example.test', withdrawals_frozen: true, score: 0.86, order_id: null, status: 'open',
        reasons: [{ code: 'buyer_syndicate_cluster' }, { code: 'new_seller' }, { code: 'shared_device' }], created_at: ago(5 * 3_600_000),
      },
    ] as any[],
    chargebacks: [
      { id: 'c1', order_id: 'b7f3a2c1-0000-4000-8000-000000000099', network: 'visa', reason_code: '10.4', category: 'fraud', amount_cents: 60_00, respond_by: ahead(26 * day), status: 'submitted', packet_sha256: 'ab12' },
    ] as any[],
    reconRuns: [
      { id: 'rc1', status: 'ok', started_at: ago(day), report: { issues: [], warnings: [], totals: { escrow: 0 } } },
    ] as any[],
    audit: [
      { id: 'a1', created_at: ago(2 * day), actor_name: 'Arbiter Ada', actor_role: 'admin', ip: '203.0.113.7', action: 'dispute.resolved', target_type: 'dispute', target_id: 'd0000000-1', details: { outcome: 'buyer' } },
      { id: 'a2', created_at: ago(day), actor_name: 'Arbiter Ada', actor_role: 'admin', ip: '203.0.113.7', action: 'reconciliation.run', target_type: 'reconciliation_run', target_id: 'rc100000', details: { status: 'ok' } },
    ] as any[],
    inbox: [
      { id: 'n1', user_id: users[1]!.id, template: 'payout.paid', category: 'selling', title: 'Payout sent', body: '$420.00 is on its way to your bank.', link: '/sell/money', read_at: ago(2 * day), created_at: ago(2 * day) },
      { id: 'n2', user_id: users[1]!.id, template: 'invoice.issued', category: 'selling', title: 'Your commission invoice is ready', body: `Invoice BZ-${new Date().getFullYear()}-000412 for last month.`, link: '/sell/money', read_at: null, created_at: ago(20 * 3_600_000) },
      { id: 'n3', user_id: users[0]!.id, template: 'security.new_login', category: 'security', title: 'New sign-in', body: 'Your account was signed in from a new browser.', link: '/account', read_at: null, created_at: ago(3_600_000) },
      { id: 'n4', user_id: users[2]!.id, template: 'ops.aml_case', category: 'operations', title: 'New compliance case', body: 'Sanctions screening flagged a possible match for review.', link: '/admin', read_at: null, created_at: ago(5 * 3_600_000) },
    ] as any[],
    payoutCurrency: {} as Record<string, string>,
    taxProfiles: {
      [users[1]!.id]: { country: 'DE', isBusiness: true, taxId: 'DE123456789', taxIdVerified: true, billingAddress: 'NorthWind Keys GmbH\nTorstraße 1\n10119 Berlin' },
    } as Record<string, any>,
    invoices: [1, 2, 3].map((m) => {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - m);
      return { id: `inv-${m}`, seller_id: users[1]!.id, number: `BZ-${d.getUTCFullYear()}-${String(412 - m * 37).padStart(6, '0')}`, period_start: d.toISOString(), currency: 'USD', gross_cents: [612_40, 588_15, 497_80][m - 1], tax_cents: 0 };
    }) as any[],
    creditNotes: [
      { id: 'cn1', seller_id: users[1]!.id, number: 'BZC-000031', issued_at: ago(11 * day), currency: 'USD', gross_cents: 4_21, reason: 'Refund after release: key already redeemed' },
    ] as any[],
    pushPrefs: {} as Record<string, Record<string, boolean>>,
    amlCases: [
      {
        id: 'aml-1', user_id: users[3]!.id, rule: 'sanctions_screening', source: 'sanctions', severity: 'high', status: 'open', holds_payouts: true, sar_reference: null, created_at: ago(5 * 3_600_000),
        details: { why: 'Legal name screened against consolidated sanctions lists at payout onboarding.', matches: [{ name: 'RIFT TRADING LLC', program: 'Sectoral sanctions', list: 'OFAC SDN', ref: '38211', score: 0.82 }], threshold: 0.8 },
        notes: [] as any[],
      },
      {
        id: 'aml-2', user_id: users[4]!.id, rule: 'rapid_cash_out', source: 'monitoring', severity: 'medium', status: 'open', holds_payouts: false, sar_reference: null, created_at: ago(day),
        details: { why: 'More than 90% of released sales withdrawn within 24 hours, six days running.', window_days: 7, withdrawn_share: 0.94 },
        notes: [{ note: 'Seller is a known boosting shop; checking order mix.', at: ago(20 * 3_600_000) }],
      },
      {
        id: 'aml-3', user_id: users[0]!.id, rule: 'structuring', source: 'monitoring', severity: 'medium', status: 'cleared', holds_payouts: false, sar_reference: null, created_at: ago(9 * day),
        details: { why: 'Several purchases just under the verification threshold.', orders: 4 },
        notes: [{ decision: 'clear', note: 'Normal gift-card buying pattern; amounts vary.', at: ago(8 * day) }],
      },
    ] as any[],
    treasury: [
      { id: 'tw1', amount_cents: 5_000_00, currency: 'USD', note: 'September operating costs', source: 'treasury', status: 'paid', requested_by: 'u-fin-1', requested_by_name: 'Finley (finance)', decided_by_name: 'Arbiter Ada', created_at: ago(14 * day) },
      { id: 'tw2', amount_cents: 2_400_00, currency: 'USD', note: 'Quarterly VAT payment (OSS)', source: 'tax_payable', status: 'pending_approval', requested_by: 'u-fin-1', requested_by_name: 'Finley (finance)', decided_by_name: null, created_at: ago(3 * 3_600_000) },
    ] as any[],
    staff: [
      { id: 'u-fin-1', email: 'finley@bullizard.test', display_name: 'Finley', role: 'user', staff_roles: ['finance'], totp_enabled: true },
      { id: 'u-cmp-1', email: 'casey@bullizard.test', display_name: 'Casey', role: 'user', staff_roles: ['compliance', 'support'], totp_enabled: false },
    ] as any[],
    platform: { escrow: 0, treasury: 18_432_10, reserve: 2_048_00, tax_payable: 3_118_40, withdrawn: 5_000_00, gateway_clearing: -24_960_00 },
    seq: 1,
  };
}

export type DemoState = ReturnType<typeof seed>;
