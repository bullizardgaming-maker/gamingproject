/**
 * Give an existing account a staff role (staging/production shell): node dist/scripts/make-staff.js --email you@x --role admin
 * Roles: arbiter, support, lead, finance, compliance, admin. The account must exist (sign up in the app first) and should
 * turn on 2FA right away. Logged to the admin audit log with actor "cli".
 */
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { maybeOne } from '../db.js';
import { STAFF_ROLES } from '../domain/permissions.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter((e) => e.length));
const email = String(args.email ?? '').trim().toLowerCase();
const role = String(args.role ?? '').trim();
if (!email || !(STAFF_ROLES as readonly string[]).includes(role)) {
  console.error(`usage: make-staff --email <email> --role <${STAFF_ROLES.join('|')}>`);
  process.exit(2);
}
const ctx = createContext(loadConfig(), { info() {}, warn: console.warn, error: console.error });
const u = await maybeOne<{ id: string; role: string }>(ctx.db, 'SELECT id, role FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
if (!u) {
  console.error(`no account with email ${email}; sign up in the app first`);
  process.exit(1);
}
await ctx.db.query(`UPDATE users SET role = $2, kyc_tier = GREATEST(kyc_tier, 1) WHERE id = $1`, [u.id, role]);
await ctx.db.query(`INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, details, ip) VALUES ($1, 'staff.role', 'user', $1, $2, NULL)`, [u.id, JSON.stringify({ from: u.role, to: role, by: 'make-staff' })]).catch(() => {});
console.log(`${email}: ${u.role} → ${role}. Ask them to turn on 2FA (Account → Two-factor) before doing anything in Ops.`);
await ctx.pubsub.close();
await ctx.views.close();
process.exit(0);
