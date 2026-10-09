/**
 * Demo data for local development: `npm run seed -w apps/api`.
 * Creates an admin, a verified seller with listings and stock, and a Tier 1 buyer.
 * All accounts use the password "demo-password-123".
 */
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { migrate, maybeOne } from './db.js';
import { addInventory } from './domain/inventory.js';
import { hashPassword } from './lib/crypto.js';

const cfg = loadConfig();
const ctx = createContext(cfg, { info() {}, warn: console.warn, error: console.error });
await migrate(ctx.db);

const password = await hashPassword('demo-password-123');
async function user(email: string, name: string, tier: number, role = 'user') {
  const existing = await maybeOne<{ id: string }>(ctx.db, 'SELECT id FROM users WHERE email = $1', [email]);
  if (existing) return existing.id;
  const { rows } = await ctx.db.query(
    `INSERT INTO users (email, password_hash, display_name, role, kyc_tier, email_verified_at, phone_verified_at, legal_name)
     VALUES ($1, $2, $3, $4, $5, now(), now(), $3) RETURNING id`,
    [email, password, name, role, tier],
  );
  return rows[0].id as string;
}

await user('admin@demo.test', 'Arbiter Ada', 2, 'admin');
const seller = await user('seller@demo.test', 'NorthWind Keys', 2);
await user('buyer@demo.test', 'Pixel Pat', 1);

const offers: Array<{ cat: string; game: string; title: string; price: number; mode: string; codes?: number; stock?: number; proof?: string; attrs: Record<string, string> }> = [
  { cat: 'keys', game: 'Elden Ring', title: 'Elden Ring — Steam key (Global)', price: 32_49, mode: 'auto', codes: 40, attrs: { platform: 'Steam', region: 'Global' } },
  { cat: 'gift-cards', game: 'Steam', title: 'Steam Wallet $50 gift card (US)', price: 47_90, mode: 'auto', codes: 25, attrs: { region: 'United States' } },
  { cat: 'currency', game: 'World of Warcraft', title: '100k Gold — Stormrage (Alliance)', price: 18_00, mode: 'manual', stock: 30, attrs: { region: 'US', server: 'Stormrage', faction: 'Alliance' } },
  { cat: 'accounts', game: 'World of Warcraft', title: 'Lvl 80 Warrior, full mythic gear, 2009 account', price: 300_00, mode: 'manual', stock: 1, proof: 'verified', attrs: { region: 'EU', faction: 'Horde' } },
  { cat: 'accounts', game: 'Valorant', title: 'Immortal 2 account, 34 skins', price: 145_00, mode: 'manual', stock: 1, attrs: { region: 'Europe', rank: 'Immortal' } },
  { cat: 'boosting', game: 'League of Legends', title: 'Gold IV → Platinum IV, duo queue', price: 89_00, mode: 'manual', stock: 5, attrs: { server: 'EUW', rank_from: 'Gold', rank_to: 'Platinum' } },
  { cat: 'items', game: 'Counter-Strike 2', title: 'AK-47 | Redline (Field-Tested)', price: 21_75, mode: 'manual', stock: 3, attrs: { exterior: 'Field-Tested', stattrak: 'No' } },
];

for (const o of offers) {
  const exists = await maybeOne(ctx.db, 'SELECT 1 FROM offers WHERE seller_id = $1 AND title = $2', [seller, o.title]);
  if (exists) continue;
  const { rows } = await ctx.db.query(
    `INSERT INTO offers (seller_id, category_slug, game, title, description, price_cents, delivery_mode, stock, owner_proof_status, attributes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [seller, o.cat, o.game, o.title, 'Demo listing.', o.price, o.mode, o.mode === 'manual' ? o.stock : 0, o.proof ?? 'none', JSON.stringify(o.attrs)],
  );
  if (o.codes) {
    const codes = Array.from({ length: o.codes }, (_, i) => `${o.game.slice(0, 4).toUpperCase()}-${i.toString().padStart(4, '0')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`);
    await addInventory(ctx, ctx.db, seller, rows[0].id, codes);
  }
}

console.log('Seeded. Log in as buyer@demo.test / seller@demo.test / admin@demo.test with password "demo-password-123".');
await ctx.pubsub.close();
await ctx.db.end();
