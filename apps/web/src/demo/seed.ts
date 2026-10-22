/**
 * Sample data for the demo preview (no backend). Mirrors the API's shapes closely enough that
 * every page works: three demo accounts, a market of listings, and a few orders in different
 * states so escrow, chat, disputes and the operations console all have something to show.
 */
import { DEFAULT_TERMS } from '../../../api/src/domain/safety';
import { LAUNCH_GAMES } from '../lib/launch';

/**
 * The demo shows the launch: only the launch games and phase-1 categories. The full sample
 * catalogue (every game and category, used by the browser tests) is switched on with
 * localStorage 'bz-demo-full' = '1'.
 */
export const DEMO_FULL = (() => {
  try {
    return localStorage.getItem('bz-demo-full') === '1';
  } catch {
    return false;
  }
})();
const isLaunch = (game: string) => (LAUNCH_GAMES as readonly string[]).includes(game);

export const DEMO_PASSWORD = 'demo-password-123';
export const DEMO_CODE = '123456';

const day = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

export interface DemoUser {
  id: string;
  email: string;
  password: string;
  locale?: string;
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
  /** Crypto payout address (withdrawals are sent here). */
  payout_address?: string | null;
  payout_address_currency?: string | null;
  payout_address_set_at?: string | null;
  legal_name: string | null;
  /** First listing or proposal: the 60-day launch promo (5% commission) counts from here. */
  seller_since?: string | null;
  /** Character names / UIDs remembered per game after the first order. */
  handover_names?: Record<string, string>;
  /** Founding Seller: opened the shop during the launch window. */
  founding?: boolean;
  /** Seller onboarding: the rules test passed; selling restricted once the ID deadline passes. */
  rules_passed_at?: string | null;
  rules_attempts?: number;
  selling_restricted_at?: string | null;
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
  payout_address: tier >= 2 ? `TDemo${id.replace(/-/g, '').slice(0, 28)}` : null,
  payout_address_currency: tier >= 2 ? 'usdttrc20' : null,
  payout_address_set_at: tier >= 2 ? ago(60 * day) : null,
  legal_name: tier >= 2 ? name : null,
  seller_since: tier >= 2 ? ago(100 * day) : null,
  rules_passed_at: tier >= 2 ? ago(100 * day) : null,
  founding: tier >= 2,
  rules_attempts: tier >= 2 ? 1 : 0,
  selling_restricted_at: null,
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

type Seed = [cat: string, game: string, title: string, price: number, mode: 'auto' | 'manual', stock: number, seller: string, proof?: string, description?: string, hours?: number];

// Extra launch-game listings so the launch demo has something to compare (not in the full test catalogue).
const LAUNCH_EXTRAS: Seed[] = [
  ['currency', 'Albion Online', '30M silver — Europe', 33_50, 'manual', 40, 'seller2', 'none', 'Face-to-face trade at the Caerleon market. Send a trade request when you are online.', 0.5],
  ['currency', 'Albion Online', '10M silver — Asia', 12_20, 'manual', 30, 'seller4', 'none', '', 1],
  ['items', 'Albion Online', 'T8.3 Avalonian mount — Americas', 58_00, 'manual', 2, 'seller5', 'none', '', 3],
  ['currency', 'Aion', '500M kinah — Siel (NA)', 46_00, 'manual', 12, 'seller5', 'none', '', 1],
  ['currency', 'Aion 2', '100M kinah — Nezakan (NA)', 26_00, 'manual', 20, 'seller5', 'none', '', 1],
  ['items', 'Aion 2', 'Legendary weapon set — Israphel (EU)', 64_00, 'manual', 3, 'seller2', 'none', '', 6],
  ['currency', 'Path of Exile 2', '50 Exalted Orbs — Dawn of the Hunt', 9_00, 'manual', 60, 'seller2', 'none', '', 0.5],
  ['items', 'Path of Exile', 'Mageblood — Mercenaries', 320_00, 'manual', 1, 'seller5', 'none', '', 4],
];

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
  // A wider catalogue so every game page has a real offer table to compare.
  ['top-ups', 'Genshin Impact', 'Blessing of the Welkin Moon — UID top-up', 4_49, 'manual', 60, 'seller5', 'none', '', 0.25],
  ['accounts', 'Genshin Impact', 'AR 58 · 9 five-stars incl. Furina C2, Neuvillette', 189_00, 'manual', 1, 'seller4', 'verified'],
  ['accounts', 'Genshin Impact', 'Starter AR 10 · Raiden + Nahida reroll (Asia)', 24_00, 'manual', 1, 'seller2', 'none', '', 1],
  ['boosting', 'Genshin Impact', 'Spiral Abyss 36★ clear, any team', 19_00, 'manual', 9, 'seller3', 'none', '', 12],
  ['top-ups', 'Valorant', '2,050 VP — EU region code', 19_49, 'auto', 22, 'seller5'],
  ['top-ups', 'Valorant', '5,350 VP — NA region code', 48_99, 'auto', 14, 'seller'],
  ['boosting', 'Valorant', 'Ascendant 1 → Ascendant 3, solo or duo', 139_00, 'manual', 3, 'seller3', 'none', '', 48],
  ['accounts', 'Valorant', 'Radiant-ready smurf, level 20, unranked (EU)', 11_90, 'manual', 12, 'seller4', 'none', '', 0.5],
  ['currency', 'League of Legends', '1,380 RP gift code (EUW)', 10_49, 'auto', 35, 'seller5'],
  ['accounts', 'League of Legends', 'Level 30 unranked, 40k BE, hand-levelled (NA)', 9_90, 'manual', 25, 'seller4', 'none', '', 0.5],
  ['boosting', 'League of Legends', 'Placement games (5) with a Master duo', 29_00, 'manual', 8, 'seller3', 'none', '', 24],
  ['currency', 'Fortnite', '13,500 V-Bucks — gifted to your account', 79_00, 'manual', 10, 'seller2', 'none', '', 2],
  ['items', 'Fortnite', 'Galaxy Scout skin code', 34_00, 'auto', 4, 'seller'],
  ['accounts', 'Fortnite', 'Chapter 1 Season 2 account, Black Knight', 249_00, 'manual', 1, 'seller4', 'verified'],
  ['items', 'Counter-Strike 2', 'Karambit | Doppler Phase 2 (Factory New)', 1_190_00, 'manual', 1, 'seller4', 'none', '', 2],
  ['items', 'Counter-Strike 2', 'AWP | Asiimov (Field-Tested)', 98_00, 'manual', 2, 'seller2', 'none', '', 1],
  ['accounts', 'Counter-Strike 2', 'Prime account, 2,000 hours, Faceit level 8', 64_00, 'manual', 1, 'seller3', 'none'],
  ['currency', 'World of Warcraft', '250k Gold — Silvermoon (Horde, EU)', 41_00, 'manual', 12, 'seller5', 'none', '', 1],
  ['boosting', 'World of Warcraft', 'Mythic+ 10 key, timed, loot funnel', 22_00, 'manual', 20, 'seller3', 'none', '', 6],
  ['currency', 'Old School RuneScape', '250M OSRS GP — trade in Grand Exchange', 129_00, 'manual', 4, 'seller5', 'none', '', 0.5],
  ['accounts', 'Old School RuneScape', 'Maxed main, 2277 total, infernal cape', 860_00, 'manual', 1, 'seller4', 'verified'],
  ['currency', 'Diablo IV', '1 billion gold, Season 6 softcore', 6_50, 'manual', 40, 'seller5', 'none', '', 1],
  ['boosting', 'Diablo IV', 'Level 1 → 60 + Torment 4 unlock', 34_00, 'manual', 6, 'seller3', 'none', '', 24],
  ['currency', 'EA Sports FC 25', '1M FUT coins, comfort trade (PS5)', 39_00, 'manual', 15, 'seller2', 'none', '', 2],
  ['currency', 'EA Sports FC 25', '500k FUT coins, player auction (PC)', 21_00, 'manual', 22, 'seller5', 'none', '', 1],
  ['currency', 'Roblox', '10,000 Robux via group payout', 79_99, 'manual', 9, 'seller5', 'none', '', 1],
  ['items', 'Roblox', 'Blox Fruits — Leopard fruit (permanent)', 18_50, 'manual', 7, 'seller2', 'none', '', 1],
  ['accounts', 'Minecraft', 'Java + Bedrock, full access, OG name', 39_00, 'manual', 2, 'seller4', 'verified'],
  ['keys', 'Minecraft', 'Minecraft Java & Bedrock — PC key (Global)', 22_90, 'auto', 30, 'seller'],
  ['currency', 'Path of Exile 2', '100 Divine Orbs — Standard league', 17_00, 'manual', 18, 'seller5', 'none', '', 0.5],
  ['items', 'Path of Exile 2', 'Mirror-tier bow, crafted to order', 210_00, 'manual', 1, 'seller4', 'none', '', 24],
  // Launch games: Aion, Aion 2, Albion Online, Path of Exile 1 & 2 (currency and items, delivered in-game).
  ['currency', 'Path of Exile', '200 Divine Orbs — Mercenaries softcore', 24_00, 'manual', 30, 'seller5', 'none', 'Traded in your hideout within 15 minutes of the order. Whisper-free: we join your party.', 0.5],
  ['currency', 'Path of Exile', '50 Divine Orbs — Standard', 6_50, 'manual', 40, 'seller2', 'none', '', 1],
  ['items', 'Path of Exile', 'Headhunter — Mercenaries', 180_00, 'manual', 2, 'seller4', 'none', 'Legacy-free Headhunter, delivered by trade.', 2],
  ['currency', 'Path of Exile', '10 Divine Orbs — Settlers (ended)', 1_40, 'manual', 5, 'seller5', 'none', 'Left over from the Settlers league.', 1],
  ['currency', 'Albion Online', '10M silver — Europe', 11_50, 'manual', 60, 'seller5', 'none', 'Handed over at the Martlock bank or by direct trade.', 0.5],
  ['currency', 'Albion Online', '10M silver — Americas', 11_90, 'manual', 25, 'seller2', 'none', '', 1],
  ['items', 'Albion Online', 'T8 Bloodletter 8.3 — Europe', 42_00, 'manual', 3, 'seller4', 'none', '', 2],
  ['currency', 'Aion', '100M kinah — Siel (NA)', 9_90, 'manual', 50, 'seller', 'none', 'Mailed in-game or traded in Sanctum.', 1],
  ['currency', 'Aion 2', '50M kinah — Israphel (EU)', 14_00, 'manual', 30, 'seller2', 'none', '', 1],
  ['items', 'Aion 2', 'Stigma bundle — Israphel (EU)', 29_00, 'manual', 6, 'seller4', 'none', '', 4],
  ['top-ups', 'Honkai: Star Rail', '6480 Oneiric Shards — UID top-up', 89_00, 'manual', 10, 'seller5', 'none', '', 0.5],
  ['accounts', 'Honkai: Star Rail', 'TL 65 · Acheron E1 + signature cone', 119_00, 'manual', 1, 'seller4', 'verified'],
  ['accounts', 'Apex Legends', 'Heirloom account, 3 heirlooms, Predator badge', 175_00, 'manual', 1, 'seller4', 'none'],
  ['boosting', 'Apex Legends', 'Ranked: Platinum → Diamond', 59_00, 'manual', 4, 'seller3', 'none', '', 36],
  ['items', 'Dota 2', 'Arcana bundle: Terrorblade + Phantom Assassin', 52_00, 'manual', 5, 'seller2', 'none', '', 1],
  ['boosting', 'Dota 2', '+1,000 MMR, party with an Immortal player', 89_00, 'manual', 3, 'seller3', 'none', '', 72],
  ['top-ups', 'Mobile Legends', '2,195 Diamonds — direct top-up', 34_00, 'manual', 50, 'seller5', 'none', '', 0.25],
  ['top-ups', 'PUBG Mobile', '1,800 UC — direct top-up', 24_50, 'manual', 50, 'seller5', 'none', '', 0.25],
  ['accounts', 'Clash of Clans', 'TH16 max, 60+ hero levels, legend league', 145_00, 'manual', 1, 'seller4', 'none'],
  ['gift-cards', 'Steam', 'Steam Wallet €20 (EU)', 19_40, 'auto', 40, 'seller5'],
  ['gift-cards', 'Xbox', 'Xbox Game Pass Ultimate — 3 months', 32_90, 'auto', 18, 'seller2'],
  ['gift-cards', 'Apple', 'Apple Gift Card $25 (US)', 24_40, 'auto', 20, 'seller'],
  ['video-games', 'Nintendo', 'Mario Kart 8 Deluxe — eShop code (EU)', 41_00, 'auto', 6, 'seller5'],
  ['keys', 'Hogwarts Legacy', 'Hogwarts Legacy — Steam key (Global)', 21_90, 'auto', 16, 'seller5'],
  ['keys', 'Red Dead Redemption 2', 'Red Dead Redemption 2 — Rockstar key', 15_50, 'auto', 20, 'seller2'],
  ['accounts', 'Valorant', 'Diamond 1 smurf, 12 skins, Riot sign-in verified', 55_00, 'manual', 1, 'seller3', 'none', 'Fresh email, no bans. Verified by Riot sign-in; you confirm the handover by signing in yourself.'],
];
/** Game-specific fields per listing title (see apps/api/src/domain/attributeSets.ts). */
/** Running sales: [sale price, days left]. */
const SALES: Record<string, [number, number]> = {
  'Cyberpunk 2077 + Phantom Liberty — GOG key': [29_90, 3],
  'AWP | Asiimov (Field-Tested)': [86_00, 1],
};

/** Quantity prices on bulk listings (gold, top-ups). */
const TIERS: Record<string, Array<{ minQty: number; priceCents: number }>> = {
  '100k Gold — Stormrage (Alliance)': [{ minQty: 5, priceCents: 16_50 }, { minQty: 10, priceCents: 15_00 }],
  '100M OSRS GP': [{ minQty: 3, priceCents: 51_00 }],
  '1 billion gold, Season 6 softcore': [{ minQty: 5, priceCents: 5_90 }, { minQty: 20, priceCents: 5_20 }],
  'Blessing of the Welkin Moon — UID top-up': [{ minQty: 3, priceCents: 4_19 }, { minQty: 6, priceCents: 3_99 }],
};

const ATTRS: Record<string, Record<string, string>> = {
  '30M silver — Europe': { server: 'Europe' },
  '10M silver — Asia': { server: 'Asia' },
  'T8.3 Avalonian mount — Americas': { server: 'Americas' },
  '500M kinah — Siel (NA)': { server: 'Siel', region: 'North America' },
  '100M kinah — Nezakan (NA)': { server: 'Nezakan', region: 'North America' },
  'Legendary weapon set — Israphel (EU)': { server: 'Israphel', region: 'Europe' },
  '50 Exalted Orbs — Dawn of the Hunt': { league: 'Dawn of the Hunt', mode: 'Softcore' },
  'Mageblood — Mercenaries': { league: 'Mercenaries', mode: 'Softcore' },
  'Elden Ring — Steam key (Global)': { platform: 'Steam', region: 'Global' },
  'Baldur’s Gate 3 — Steam key (EU)': { platform: 'Steam', region: 'Europe' },
  'Cyberpunk 2077 + Phantom Liberty — GOG key': { platform: 'GOG', region: 'Global' },
  'Steam Wallet $50 gift card (US)': { region: 'United States' },
  'PlayStation Store $25 (US)': { region: 'United States' },
  '6480 Genesis Crystals — direct top-up': { server: 'Europe' },
  '100k Gold — Stormrage (Alliance)': { region: 'US', server: 'Stormrage', faction: 'Alliance' },
  '100M OSRS GP': { method: 'Trade' },
  'Lvl 80 Warrior, full mythic gear, 2009 account': { region: 'EU', faction: 'Horde' },
  'Immortal 2 account, 34 skins': { region: 'Europe', rank: 'Immortal' },
  'Diamond 1 smurf, 12 skins, Riot sign-in verified': { region: 'Europe', rank: 'Diamond' },
  'OG account, Renegade Raider + 210 skins': { platform: 'PC' },
  'Gold IV → Platinum IV, duo queue': { server: 'EUW', rank_from: 'Gold', rank_to: 'Platinum' },
  'Premier 10k → 15k rating': { region: 'Europe' },
  'AK-47 | Redline (Field-Tested)': { exterior: 'Field-Tested', stattrak: 'No' },
  'Shako (Harlequin Crest), Season 6': { mode: 'Softcore', platform: 'PC' },
  'Zelda: Tears of the Kingdom — eShop code (US)': { platform: 'Nintendo eShop', region: 'North America' },
  'Blessing of the Welkin Moon — UID top-up': { server: 'Asia' },
  'AR 58 · 9 five-stars incl. Furina C2, Neuvillette': { server: 'Europe' },
  'Starter AR 10 · Raiden + Nahida reroll (Asia)': { server: 'Asia' },
  'Spiral Abyss 36★ clear, any team': { server: 'America' },
  '2,050 VP — EU region code': { region: 'Europe' },
  '5,350 VP — NA region code': { region: 'North America' },
  'Ascendant 1 → Ascendant 3, solo or duo': { region: 'Europe', rank_from: 'Ascendant', rank_to: 'Ascendant' },
  'Radiant-ready smurf, level 20, unranked (EU)': { region: 'Europe', rank: 'Unranked' },
  '1,380 RP gift code (EUW)': { server: 'EUW' },
  'Level 30 unranked, 40k BE, hand-levelled (NA)': { server: 'NA', rank: 'Unranked' },
  'Placement games (5) with a Master duo': { server: 'EUW' },
  '13,500 V-Bucks — gifted to your account': { platform: 'PlayStation' },
  'Chapter 1 Season 2 account, Black Knight': { platform: 'Xbox' },
  'Karambit | Doppler Phase 2 (Factory New)': { exterior: 'Factory New', stattrak: 'No' },
  'AWP | Asiimov (Field-Tested)': { exterior: 'Field-Tested', stattrak: 'Yes' },
  'Prime account, 2,000 hours, Faceit level 8': { prime: 'Yes', region: 'Europe' },
  '250k Gold — Silvermoon (Horde, EU)': { region: 'EU', server: 'Silvermoon', faction: 'Horde' },
  'Mythic+ 10 key, timed, loot funnel': { region: 'EU' },
  '250M OSRS GP — trade in Grand Exchange': { method: 'Grand Exchange' },
  'Maxed main, 2277 total, infernal cape': { type: 'Main' },
  '1 billion gold, Season 6 softcore': { mode: 'Softcore', platform: 'PC' },
  'Level 1 → 60 + Torment 4 unlock': { mode: 'Softcore', platform: 'PlayStation' },
  '1M FUT coins, comfort trade (PS5)': { platform: 'PlayStation', method: 'Comfort trade' },
  '500k FUT coins, player auction (PC)': { platform: 'PC', method: 'Player auction' },
  'Java + Bedrock, full access, OG name': { platform: 'PC', region: 'Global' },
  'Minecraft Java & Bedrock — PC key (Global)': { region: 'Global' },
  '100 Divine Orbs — Standard league': { league: 'Standard', mode: 'Softcore' },
  'Mirror-tier bow, crafted to order': { league: 'Dawn of the Hunt', mode: 'Softcore' },
  '200 Divine Orbs — Mercenaries softcore': { league: 'Mercenaries', mode: 'Softcore' },
  '50 Divine Orbs — Standard': { league: 'Standard', mode: 'Softcore' },
  'Headhunter — Mercenaries': { league: 'Mercenaries', mode: 'Softcore' },
  '10 Divine Orbs — Settlers (ended)': { league: 'Settlers', mode: 'Softcore' },
  '10M silver — Europe': { server: 'Europe' },
  '10M silver — Americas': { server: 'Americas' },
  'T8 Bloodletter 8.3 — Europe': { server: 'Europe' },
  '100M kinah — Siel (NA)': { server: 'Siel', region: 'North America' },
  '50M kinah — Israphel (EU)': { server: 'Israphel', region: 'Europe' },
  'Stigma bundle — Israphel (EU)': { server: 'Israphel', region: 'Europe' },
  '6480 Oneiric Shards — UID top-up': { server: 'America' },
  'TL 65 · Acheron E1 + signature cone': { server: 'Asia' },
  'Heirloom account, 3 heirlooms, Predator badge': { platform: 'PC', rank: 'Predator' },
  'Ranked: Platinum → Diamond': { platform: 'PC', rank_from: 'Platinum', rank_to: 'Diamond' },
  '+1,000 MMR, party with an Immortal player': { region: 'Europe' },
  '2,195 Diamonds — direct top-up': { region: 'Asia' },
  '1,800 UC — direct top-up': { region: 'Middle East' },
  'TH16 max, 60+ hero levels, legend league': { platform: 'Mobile' },
  'Steam Wallet €20 (EU)': { region: 'Europe' },
  'Xbox Game Pass Ultimate — 3 months': { region: 'Global' },
  'Apple Gift Card $25 (US)': { region: 'United States' },
  'Mario Kart 8 Deluxe — eShop code (EU)': { platform: 'Nintendo eShop', region: 'Europe' },
  'Hogwarts Legacy — Steam key (Global)': { platform: 'Steam', region: 'Global' },
  'Red Dead Redemption 2 — Rockstar key': { platform: 'Rockstar', region: 'Global' },
};
const DEFAULT_HOURS: Record<string, number> = { accounts: 2, currency: 1, items: 1, boosting: 24, 'top-ups': 0.5 };

export function seed() {
  const users = [
    u('u-buyer-0000-4000-8000-000000000001', 'buyer@demo.test', 'Pixel Pat', 'user', 1),
    u('u-sell1-0000-4000-8000-000000000002', 'seller@demo.test', 'NorthWind Keys', 'user', 2),
    u('u-admin-0000-4000-8000-000000000003', 'admin@demo.test', 'Arbiter Ada', 'admin', 2),
    u('u-sell2-0000-4000-8000-000000000004', 'rift@demo.test', 'RiftTrader', 'user', 2, { seller_since: ago(20 * day) }),
    u('u-sell3-0000-4000-8000-000000000005', 'arcane@demo.test', 'ArcaneBoost', 'user', 2),
  ];
  users.push(
    u('u-sell4-0000-4000-8000-000000000006', 'vault@demo.test', 'VaultHopper', 'user', 2, { created_at: ago(700 * day), seller_since: ago(690 * day) }),
    u('u-sell5-0000-4000-8000-000000000007', 'koi@demo.test', 'KoiCurrency', 'user', 2, { created_at: ago(410 * day), seller_since: ago(400 * day) }),
  );
  const sellerId: Record<string, string> = { seller: users[1]!.id, seller2: users[3]!.id, seller3: users[4]!.id, seller4: users[5]!.id, seller5: users[6]!.id };
  // Commission is grossed up on top of the seller's price (ranks below + the launch promo). The
  // listing prices above are what buyers see, so the seller's own price is derived from them here.
  const sellerRate: Record<string, number> = { seller: 1099, seller2: 500, seller3: 1199, seller4: 1399, seller5: 1399 };
  const net = (seller: string, cents: number) => Math.round((cents * (10_000 - sellerRate[seller]!)) / 10_000);

  const WARRANTY: Record<string, number> = { 'Lvl 80 Warrior, full mythic gear, 2009 account': 30, 'OG account, Renegade Raider + 210 skins': 14 };
  const list = DEMO_FULL ? LISTINGS : [...LISTINGS, ...LAUNCH_EXTRAS];
  const offers = list.map(([cat, game, title, price, mode, stock, seller, proof, description, hours], i) => {
    const kind = CATEGORIES.find((c) => c.slug === cat)!.kind;
    return {
      id: `offer-${i + 1}`,
      seller_id: sellerId[seller]!,
      category_slug: cat,
      category_kind: kind,
      game,
      title,
      description: description ?? '',
      price_cents: net(seller, price),
      currency: 'USD',
      delivery_mode: mode,
      delivery_hours: mode === 'auto' ? 0 : hours ?? DEFAULT_HOURS[cat] ?? 2,
      stock,
      inventory: mode === 'auto' ? Array.from({ length: stock }, (_, k) => `${game.slice(0, 4).toUpperCase().replace(/[^A-Z]/g, 'X')}-${String(k + 1).padStart(4, '0')}-${(i * 7919 + k * 104729).toString(36).toUpperCase().slice(-5).padStart(5, 'Q')}`) : [],
      // The Settlers listing belongs to a seller who went quiet: it expired when that league ended.
      status: title.includes('(ended)') ? 'expired' : 'active',
      expired_reason: (title.includes('(ended)') ? 'league_ended:Settlers' : null) as string | null,
      featured_until: (title.startsWith('Elden Ring') ? ago(-5 * day) : null) as string | null,
      owner_proof_status: kind === 'account' ? proof ?? 'none' : 'none',
      attributes: ATTRS[title] ?? {},
      price_tiers: (TIERS[title] ?? []).map((t) => ({ ...t, priceCents: net(seller, t.priceCents) })),
      // Account listings: a warranty that runs on after escrow releases.
      warranty_days: WARRANTY[title] ?? 0,
      linked_account_id: (title.startsWith('Immortal 2') ? 'la-1' : title.startsWith('Diamond 1 smurf') ? 'la-3' : null) as string | null,
      // High-value listings can be limited to established buyers (opt-in).
      min_buyer_reputation: (title.startsWith('OG account') ? 'good' : null) as 'good' | null,
      review_reasons: [] as string[],
      bundle: null as Array<{ offer_id: string; quantity: number }> | null,
      sale_price_cents: (SALES[title] ? net(seller, SALES[title]![0]) : null) as number | null,
      sale_starts_at: (SALES[title] ? ago(day) : null) as string | null,
      sale_ends_at: (SALES[title] ? ago(-SALES[title]![1] * day) : null) as string | null,
      // Set on listings made from an accepted buyer request.
      reserved_for: null as string | null,
      request_id: null as string | null,
      version: 1,
      created_at: ago((list.length - i) * 3_600_000 * 7),
    };
  });
  // A bundle: two of NorthWind's instant listings at one price, delivered from their stock.
  offers.push({
    ...offers.find((o) => o.title.startsWith('Elden Ring'))!, id: 'offer-bundle-1', title: 'Elden Ring + $50 Steam Wallet bundle',
    description: 'The game key plus a $50 US Steam Wallet card, delivered together the moment you pay.', price_cents: net('seller', 72_00), stock: 0, inventory: [],
    attributes: {}, price_tiers: [], sale_price_cents: null, sale_starts_at: null, sale_ends_at: null, featured_until: null, created_at: ago(5 * 3_600_000),
    bundle: [{ offer_id: offers.find((o) => o.title.startsWith('Elden Ring'))!.id, quantity: 1 }, { offer_id: offers.find((o) => o.title.startsWith('Steam Wallet'))!.id, quantity: 1 }],
  });
  // Moderation samples: a listing held for review and a pre-sale chat flagged for off-platform contact.
  const template = offers.find((o) => o.title.startsWith('Premier 10k'))!;
  offers.push({
    ...template, id: 'offer-review-1', seller_id: users[5]!.id, category_slug: 'items', category_kind: 'item', title: 'CS2 rage config with aimbot settings, undetected',
    description: 'Works on Premier. Add me on discord for the loader and updates.', price_cents: net('seller4', 14_99), stock: 50, attributes: {}, status: 'review', review_reasons: ['term:aimbot', 'contact:discord'], created_at: ago(3 * 3_600_000),
  });
  const flagRoom = { id: 'room-flag-1', order_id: null, offer_id: 'offer-10', buyer_id: 'u-req-zed', seller_id: users[3]!.id, last_seq: 3 };
  const flagMsgs = [
    ['u-req-zed', 'Hi, is the Immortal 2 account still available?'],
    [users[3]!.id, 'Yes, it has 34 skins and the original email.'],
    ['u-req-zed', 'Can I pay you with PayPal friends and family? Cheaper for both of us. My whatsapp is +44 7700 900456'],
  ].map(([sender, body], k) => ({ id: `fm-${k}`, room_id: flagRoom.id, seq: k + 1, sender_id: sender, kind: 'text', body, flags: k === 2 ? ['offplatform:whatsapp'] : [], hash: `seed-${k}`, created_at: ago((40 - k * 5) * 60_000) }));

  // Linked Steam/Riot accounts: RiftTrader's Valorant account shows a verified badge; the demo seller has a
  // Steam account linked but not yet on a listing.
  const linkedAccounts = [
    { id: 'la-1', user_id: users[3]!.id, provider: 'riot', display_name: 'RiftTrader#EUW', profile_url: null, account_created_at: null, linked_at: ago(3 * day), unlinked_at: null },
    { id: 'la-3', user_id: users[4]!.id, provider: 'riot', display_name: 'ArcaneSmurf#EUW', profile_url: null, account_created_at: null, linked_at: ago(2 * day), unlinked_at: null },
    { id: 'la-2', user_id: users[1]!.id, provider: 'steam', display_name: 'keystone_shop', profile_url: 'https://steamcommunity.com/profiles/76561198000000001', account_created_at: '2014-06-01T00:00:00Z', linked_at: ago(10 * day), unlinked_at: null },
  ];

  const st = {
    users,
    offers,
    linkedAccounts: linkedAccounts as any[],
    orders: [] as any[],
    warrantyClaims: [] as any[],
    // Ratings sellers gave buyers; the demo buyer has some history from before the demo.
    buyerRatings: [
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ id: `br-${k}`, order_id: null as string | null, seller_id: users[3 + (k % 4)]!.id, buyer_id: users[0]!.id, positive: true, tags: k % 3 === 0 ? ['clear_communication', 'quick_confirmation'] : k % 3 === 1 ? ['quick_confirmation'] : [], created_at: ago((20 + k * 9) * day) })),
      { id: 'br-9', order_id: null as string | null, seller_id: users[4]!.id, buyer_id: users[0]!.id, positive: false, tags: ['unresponsive'], created_at: ago(140 * day) },
    ],
    buyerCompletedBefore: { [users[0]!.id]: 11 } as Record<string, number>,
    // Boosting milestones and chat screenshots (data: URLs in the demo).
    progress: [] as Array<{ id: string; order_id: string; percent: number; note: string; attachment_id: string | null; created_at: string }>,
    attachments: [] as Array<{ id: string; room_id: string; uploader_id: string; data_url: string; mime: string; original_name?: string; created_at: string }>,
    rooms: [flagRoom] as any[],
    messages: flagMsgs as any[],
    modTerms: DEFAULT_TERMS.map((t, k) => ({ id: `term-${k}`, ...t, created_at: ago(30 * day) })),
    chatFlags: [
      { id: 'cf-1', room_id: flagRoom.id, seq: 3, user_id: 'u-req-zed', user_name: 'zed.plays', user_email: 'zed@example.test', reasons: ['whatsapp', 'external_payment', 'phone_number'], status: 'open', note: null, created_at: ago(30 * 60_000) },
    ] as any[],
    reviews: [
      { id: 'r1', order_id: 'seed-1', seller_id: users[1]!.id, rating: 5, comment: 'Key worked instantly.', seller_reply: null, created_at: ago(20 * day) },
      { id: 'r2', order_id: 'seed-2', seller_id: users[1]!.id, rating: 5, comment: 'Gold arrived in 20 minutes.', seller_reply: 'Thanks!', created_at: ago(12 * day) },
      { id: 'r3', order_id: 'seed-3', seller_id: users[1]!.id, rating: 4, comment: 'Smooth account handover.', seller_reply: null, created_at: ago(6 * day) },
      { id: 'r4', order_id: 'seed-4', seller_id: users[3]!.id, rating: 5, comment: 'Fast and friendly.', seller_reply: null, created_at: ago(9 * day) },
      { id: 'r5', order_id: 'seed-5', seller_id: users[4]!.id, rating: 4, comment: 'Boost done a day early.', seller_reply: null, created_at: ago(3 * day) },
      ...[
        [5, 'Account matched the screenshots exactly. Changeover took ten minutes.', 'Enjoy it!', 'Genshin Impact'],
        [5, 'Registration email came with it, insurance window gave me peace of mind.', null, 'Old School RuneScape'],
        [4, 'Good account, took a few hours to respond overnight.', 'Sorry for the wait, we are on CET.', 'Fortnite'],
        [5, 'Third purchase, always smooth.', null, 'Minecraft'],
      ].map(([rating, comment, reply, game], k) => ({ id: `r-v${k}`, order_id: `seed-v${k}`, seller_id: users[5]!.id, rating, comment, seller_reply: reply, created_at: ago((k * 4 + 1) * day), game })),
      ...[
        [5, 'Top-up landed in under five minutes.', 'Genshin Impact'],
        [5, 'Gold delivered at the mailbox while I was still in the chat.', 'World of Warcraft'],
        [5, 'Fast, cheap, no drama.', 'Mobile Legends'],
        [4, 'Delivery fine, wish they had more stock on EU.', 'Valorant'],
        [5, 'Coins arrived in two batches as agreed.', 'EA Sports FC 25'],
      ].map(([rating, comment, game], k) => ({ id: `r-k${k}`, order_id: `seed-k${k}`, seller_id: users[6]!.id, rating, comment, seller_reply: null, created_at: ago((k * 2 + 1) * day), game })),
    ] as any[],
    completedBefore: { [users[1]!.id]: 212, [users[3]!.id]: 64, [users[4]!.id]: 131, [users[5]!.id]: 1_486, [users[6]!.id]: 3_902 } as Record<string, number>,
    // Review history from before the demo starts: shown as totals on listings and seller pages.
    reviewsBefore: {
      [users[1]!.id]: { count: 187, sum: 187 * 4.9 },
      [users[3]!.id]: { count: 51, sum: 51 * 4.7 },
      [users[4]!.id]: { count: 109, sum: 109 * 4.8 },
      [users[5]!.id]: { count: 1_204, sum: 1_204 * 4.95 },
      [users[6]!.id]: { count: 3_310, sum: 3_310 * 4.9 },
    } as Record<string, { count: number; sum: number }>,
    balances: { [users[1]!.id]: 1_284_50, [users[3]!.id]: 312_00, [users[4]!.id]: 861_40, [users[5]!.id]: 4_210_00, [users[6]!.id]: 9_655_20 } as Record<string, number>,
    monthlySales: { [users[1]!.id]: 6_420_00, [users[3]!.id]: 840_00, [users[4]!.id]: 2_310_00 } as Record<string, number>,
    withdrawals: [] as any[],
    cryptoPayments: [] as any[],
    cryptoRefunds: [] as any[],
    // Challenge leagues (Path of Exile): one open, one that has ended.
    leagues: [
      { id: 'league-1', game: 'path of exile', name: 'Settlers', starts_at: ago(100 * day), ends_at: ago(2 * day), created_at: ago(100 * day), updated_at: ago(2 * day) },
      { id: 'league-2', game: 'path of exile', name: 'Mercenaries', starts_at: ago(2 * day), ends_at: null, created_at: ago(2 * day), updated_at: ago(2 * day) },
      { id: 'league-3', game: 'path of exile 2', name: 'Dawn of the Hunt', starts_at: ago(30 * day), ends_at: null, created_at: ago(30 * day), updated_at: ago(30 * day) },
    ] as Array<{ id: string; game: string; name: string; starts_at: string | null; ends_at: string | null; created_at: string; updated_at: string }>,
    handoverNames: {} as Record<string, Record<string, string>>,
    rulesSettings: { passMarkPct: 100, idDueDays: 30 },
    launchPhase: 3,
    offplatformActions: ['warn', 'warn', 'ban'] as string[],
    credit: {} as Record<string, number>,
    texts: {
      chat_safety: { key: 'chat_safety', body: 'Keep the whole trade in this chat. Never pay or deliver anywhere else: deals made outside Bullizard are not in escrow and not protected.\nSharing outside contacts can get your account banned right away.\nThe payment is released only when the buyer confirms delivery. If something is wrong, open a dispute from the order page.', link_label: 'Rules and policies', link_href: '/help/report-a-user', updated_at: ago(10 * day) },
    } as Record<string, { key: string; body: string; link_label: string; link_href: string; updated_at: string }>,
    launch: { foundingUntil: ago(-45 * day), featuredSlots: 2, featuredDays: 7 },
    gameVotes: [
      { id: 'gv-1', name: 'Lost Ark', votes: 184, status: 'planned', staff_note: 'Opening with the next wave of sellers.', suggested_by: null as string | null, voters: [] as string[], created_at: ago(30 * day) },
      { id: 'gv-2', name: 'Throne and Liberty', votes: 97, status: 'open', staff_note: '', suggested_by: null as string | null, voters: [] as string[], created_at: ago(20 * day) },
      { id: 'gv-3', name: 'Black Desert Online', votes: 61, status: 'open', staff_note: '', suggested_by: null as string | null, voters: [] as string[], created_at: ago(12 * day) },
      { id: 'gv-4', name: 'Escape from Tarkov', votes: 40, status: 'declined', staff_note: 'Real-money trading is against that game’s rules; we do not list it.', suggested_by: null as string | null, voters: [] as string[], created_at: ago(8 * day) },
    ],
    affiliates: [{ id: 'aff-1', user_id: users[4]!.id, code: 'ARCANE-TV', rate_bps: 2000, status: 'active', note: 'Twitch, 40k followers', created_at: ago(20 * day) }] as Array<{ id: string; user_id: string; code: string; rate_bps: number; status: string; note: string; created_at: string }>,
    affiliateOf: {} as Record<string, string>,
    affiliateEarnings: [] as Array<{ id: string; affiliate_id: string; order_id: string; commission_cents: number; earned_cents: number; currency: string; created_at: string }>,
    rulesQuestions: [
      ['A buyer asks you to finish the trade on Discord so you both skip the fee. What do you do?', ['Agree, it saves money', 'Decline and keep the whole trade in the Bullizard order chat', 'Share your Discord but trade here', 'Ask them to pay half outside'], 1, 'Trading or sharing outside contacts anywhere on Bullizard can get your account banned right away. Everything stays in the order chat.'],
      ['When does the payment reach your balance?', ['The moment the buyer pays', 'When you mark the order delivered', 'When the buyer confirms delivery, or staff release it after review', 'After 72 hours automatically'], 2, 'The payment is held in escrow until the buyer confirms. There is no automatic release; staff can release an unconfirmed order after review, never before 24 hours.'],
      ['What must you attach before marking an in-game delivery as delivered?', ['Nothing', 'A photo or video of the trade (proof of delivery)', 'The buyer’s email', 'A screenshot of your inventory'], 1, 'Proof of delivery is required for currency, items, top-ups and boosting. It is what staff look at in a dispute.'],
      ['Which price do you enter on the sell form?', ['The price you want to receive; the commission is added on top for the buyer', 'The buyer price; the commission is taken out', 'Any price plus the withdrawal fee', 'The price in the buyer’s currency'], 0, 'You set your price and receive it in full. The buyer sees it with your rank’s commission added on top.'],
      ['A buyer’s character name on the order is wrong and the trade fails. What do you do?', ['Deliver to any character with a similar name', 'Message the buyer in the order chat and wait; do not deliver elsewhere', 'Cancel and ask them to pay you directly', 'Mark it delivered anyway'], 1, 'The buyer confirmed the name and is responsible for it. Sort it out in the order chat, or open a dispute; never deliver to another name.'],
      ['What happens on a third off-platform warning?', ['Nothing', 'A listing is removed', 'Your account is banned automatically and reviewed by staff', 'You pay a fee'], 2, 'First and second offences are warnings; the third bans the account automatically pending staff review.'],
    ].map(([question, options, correct, explanation], i) => ({ id: `rq-${i + 1}`, position: i + 1, question: question as string, options: options as string[], correct: correct as number, explanation: explanation as string, active: true })),
    apiKeys: [] as any[],
    watches: [] as any[],
    tickets: [] as any[],
    savedSearches: [] as any[],
    sellerCodes: [
      { id: 'code-1', seller_id: users[1]!.id, code: 'NORTHWIND10', percent_off: 10, min_order_cents: 20_00, max_uses: 500, per_buyer_limit: 1, starts_at: ago(10 * day), ends_at: ago(-20 * day), active: true, created_at: ago(10 * day), uses_before: 37 },
    ] as any[],
    checkouts: [] as Array<{ id: string; buyer_id: string; order_ids: string[]; created_at: string }>,
    // "Online now" and typical reply time per seller (minutes).
    presence: {
      [users[1]!.id]: { online: false, last_seen_at: ago(40 * 60_000), response_minutes: 12 },
      [users[3]!.id]: { online: false, last_seen_at: ago(3 * 3_600_000), response_minutes: 45 },
      [users[4]!.id]: { online: false, last_seen_at: ago(26 * 3_600_000), response_minutes: 180 },
      [users[5]!.id]: { online: true, last_seen_at: ago(60_000), response_minutes: 8 },
      [users[6]!.id]: { online: true, last_seen_at: ago(120_000), response_minutes: 5 },
    } as Record<string, { online: boolean; last_seen_at: string; response_minutes: number | null }>,
    showOnline: {} as Record<string, boolean>,
    // Shop pages: intro, accent, banner (a data: URL in the demo) and pinned listings.
    storefronts: {
      [users[1]!.id]: { intro: 'Keys, gift cards and wallet codes since 2019. Most orders deliver in under a minute, and every code comes with a replacement promise.', accent: 'teal', banner: null as string | null, pinned: ['offer-2', 'offer-bundle-1'] },
    } as Record<string, { intro: string; accent: string; banner: string | null; pinned: string[] }>,
    trust: { [users[1]!.id]: 'trusted', [users[3]!.id]: 'rising', [users[4]!.id]: 'trusted', [users[5]!.id]: 'top', [users[6]!.id]: 'top' } as Record<string, string>,
    // Buyer requests board: one by the demo buyer with proposals waiting, others for sellers to answer.
    requests: [
      {
        id: 'req-1', buyer_id: users[0]!.id, buyer_name: users[0]!.display_name, game: 'Valorant', category_slug: 'accounts', title: 'EU account with Reaver Vandal, Diamond or higher',
        description: 'Full access with original email please. Happy to wait a day.', budget_cents: 120_00, currency: 'USD', attributes: { region: 'Europe' },
        status: 'open', accepted_proposal_id: null, expires_at: ago(-12 * day), created_at: ago(2 * day), updated_at: ago(day),
      },
      {
        id: 'req-2', buyer_id: 'u-req-mira', buyer_name: 'Mira_K', game: 'League of Legends', category_slug: 'boosting', title: 'Silver II → Gold IV on EUW before the split ends',
        description: 'Solo queue, I play Lux and Ahri mostly.', budget_cents: 45_00, currency: 'USD', attributes: { server: 'EUW', rank_from: 'Silver', rank_to: 'Gold' },
        status: 'open', accepted_proposal_id: null, expires_at: ago(-13 * day), created_at: ago(20 * 3_600_000), updated_at: ago(20 * 3_600_000),
      },
      {
        id: 'req-3', buyer_id: 'u-req-zed', buyer_name: 'zed.plays', game: 'Elden Ring', category_slug: 'keys', title: 'Shadow of the Erdtree DLC key, Steam (Global)',
        description: '', budget_cents: 30_00, currency: 'USD', attributes: { platform: 'Steam', region: 'Global' },
        status: 'open', accepted_proposal_id: null, expires_at: ago(-10 * day), created_at: ago(4 * day), updated_at: ago(4 * day),
      },
      {
        id: 'req-4', buyer_id: 'u-req-holl', buyer_name: 'Hollowfang', game: 'Old School RuneScape', category_slug: 'currency', title: '500M OSRS GP, delivered in two trades',
        description: 'Grand Exchange or in-person trade at Varrock.', budget_cents: null, currency: 'USD', attributes: {},
        status: 'open', accepted_proposal_id: null, expires_at: ago(-9 * day), created_at: ago(5 * day), updated_at: ago(5 * day),
      },
    ] as any[],
    proposals: [
      { id: 'prop-1', request_id: 'req-1', seller_id: users[3]!.id, price_cents: 110_00, delivery_hours: 6, message: 'Diamond 3, Reaver Vandal + Prime collection. Original email included.', status: 'pending', offer_id: null, created_at: ago(day), updated_at: ago(day) },
      { id: 'prop-2', request_id: 'req-1', seller_id: users[5]!.id, price_cents: 98_00, delivery_hours: 12, message: 'Ascendant 1 with Reaver Vandal and Karambit. Owner-verified seller.', status: 'pending', offer_id: null, created_at: ago(20 * 3_600_000), updated_at: ago(20 * 3_600_000) },
      { id: 'prop-3', request_id: 'req-3', seller_id: users[6]!.id, price_cents: 28_50, delivery_hours: 1, message: '', status: 'pending', offer_id: null, created_at: ago(3 * day), updated_at: ago(3 * day) },
    ] as any[],
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
    incidents: [
      {
        id: 'inc-2', kind: 'incident', title: 'Slow instant delivery for some Steam keys', impact: 'minor', status: 'resolved', components: ['delivery'],
        scheduled_start: null, scheduled_end: null, created_at: ago(2 * day + 3 * 3_600_000), resolved_at: ago(2 * day + 3_600_000),
        updates: [
          { status: 'resolved', body: 'All delayed keys were delivered. Buyers’ protection windows started at delivery, not at payment.', at: ago(2 * day + 3_600_000) },
          { status: 'identified', body: 'A queue backlog after a large inventory upload; we added workers.', at: ago(2 * day + 2 * 3_600_000) },
          { status: 'investigating', body: 'Some instant-delivery orders are taking up to 10 minutes. Money stays in escrow.', at: ago(2 * day + 3 * 3_600_000) },
        ],
      },
      {
        id: 'inc-1', kind: 'maintenance', title: 'Database upgrade', impact: 'none', status: 'completed', components: ['payouts', 'checkout'],
        scheduled_start: ago(5 * day), scheduled_end: ago(5 * day - 3_600_000), created_at: ago(8 * day), resolved_at: ago(5 * day - 3_000_000),
        updates: [
          { status: 'completed', body: 'Upgrade finished in 18 minutes.', at: ago(5 * day - 3_000_000) },
          { status: 'scheduled', body: 'Payouts and checkout may pause for up to 30 minutes.', at: ago(8 * day) },
        ],
      },
    ] as any[],
    subscribers: [] as string[],
    debts: [
      { id: 'debt-1', seller_id: users[3]!.id, currency: 'USD', opened_at: ago(16 * day), peak_cents: 112_40, owed_cents: 64_90, reminders_sent: 3, paused_at: ago(2 * day), closed_at: null, closed_reason: null },
      { id: 'debt-0', seller_id: users[4]!.id, currency: 'USD', opened_at: ago(30 * day), peak_cents: 41_00, owed_cents: 0, reminders_sent: 2, paused_at: null, closed_at: ago(24 * day), closed_reason: 'repaid' },
    ] as any[],
    fxTopups: [
      { id: 'fx-1', from_currency: 'USD', to_currency: 'EUR', to_cents: 2_400_00, est_from_cents: 2_621_00, from_cents: 2_618_44, status: 'completed', requested_by: null, requested_by_name: null, decided_by_name: 'Arbiter Ada', error: null, created_at: ago(9 * day) },
      { id: 'fx-2', from_currency: 'USD', to_currency: 'EGP', to_cents: 41_710_00, est_from_cents: 860_00, from_cents: null, status: 'proposed', requested_by: null, requested_by_name: null, decided_by_name: null, error: null, created_at: ago(3 * 3_600_000) },
    ] as any[],
    platform: { escrow: 0, treasury: 18_432_10, reserve: 2_048_00, tax_payable: 3_118_40, withdrawn: 5_000_00, gateway_clearing: -24_960_00 },
    seq: 1,
  };
  return DEMO_FULL ? st : launchOnly(st);
}

/** Launch view: only launch-game listings, requests and history; phase 1 categories. */
function launchOnly<T extends { offers: any[]; requests: any[]; proposals?: any[]; rooms: any[]; ownerProofs: any[]; storefronts: Record<string, { pinned: string[] }>; launchPhase: number }>(st: T): T {
  const offers = st.offers.filter((o) => isLaunch(o.game));
  const ids = new Set(offers.map((o) => o.id));
  const requests = st.requests.filter((r) => isLaunch(r.game));
  const reqIds = new Set(requests.map((r) => r.id));
  return {
    ...st,
    offers,
    launchPhase: 1,
    requests,
    ...(st.proposals ? { proposals: st.proposals.filter((p) => reqIds.has(p.request_id)) } : {}),
    rooms: st.rooms.map((r) => (r.offer_id && !ids.has(r.offer_id) ? { ...r, offer_id: offers.find((o) => o.seller_id === r.seller_id)?.id ?? offers[0]?.id } : r)),
    ownerProofs: st.ownerProofs.filter((p) => ids.has(p.offer_id)),
    storefronts: Object.fromEntries(Object.entries(st.storefronts).map(([k, v]) => [k, { ...v, pinned: v.pinned.filter((id) => ids.has(id)) }])),
  };
}

export type DemoState = ReturnType<typeof seed>;
