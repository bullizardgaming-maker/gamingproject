import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, withTx } from '../db.js';
import { badRequest } from '../lib/errors.js';

/**
 * Transactional email. Business code calls enqueueEmail() inside its own
 * transaction (outbox pattern), so an email exists if and only if the event it
 * describes committed. The worker renders and sends, honouring preferences.
 */
export type EmailCategory = 'orders' | 'selling' | 'disputes' | 'reminders' | 'account' | 'security';

export const EMAIL_CATEGORIES: Record<EmailCategory, { label: string; mandatory?: boolean }> = {
  orders: { label: 'Purchases: payment received, delivery, refunds' },
  selling: { label: 'Sales: new orders to deliver, payouts' },
  disputes: { label: 'Disputes and chargebacks', mandatory: true },
  reminders: { label: 'Reminders before your protection window ends' },
  account: { label: 'Verification and payout account updates', mandatory: true },
  security: { label: 'Security alerts', mandatory: true },
};

type Data = Record<string, any>;
interface Template {
  category: EmailCategory;
  subject: (d: Data) => string;
  body: (d: Data, link: (path: string) => string) => string;
}

const money = (cents: number, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
const when = (iso: string) => new Date(iso).toUTCString().replace(' GMT', ' UTC');

export const TEMPLATES = {
  order_paid: {
    category: 'orders',
    subject: (d) => `Payment received for ${d.title}`,
    body: (d, link) => `We've received ${money(d.amount_cents, d.currency)} for "${d.title}". It's held in escrow and the seller isn't paid until you have the goods.\n\nTrack the order: ${link(`/orders/${d.order_id}`)}`,
  },
  order_delivered: {
    category: 'orders',
    subject: (d) => `Delivered: ${d.title}`,
    body: (d, link) =>
      `Your order "${d.title}" has been delivered. Open your order page to see it.\n\n` +
      (d.protection === 'insurance_14d'
        ? `This account is covered by 14-day asset insurance until ${when(d.protection_ends_at)}. Complete the security checklist now: change the password, recovery email and 2FA.`
        : `You have until ${when(d.protection_ends_at)} to check it. If something is wrong, open a dispute before then.`) +
      `\n\n${link(`/orders/${d.order_id}`)}`,
  },
  order_refunded: {
    category: 'orders',
    subject: (d) => `Refund issued for ${d.title}`,
    body: (d, link) => `${money(d.amount_cents, d.currency)} has been refunded to your original payment method. Card refunds usually appear within 5–10 business days.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  protection_ending: {
    category: 'reminders',
    subject: (d) => `24 hours left to check ${d.title}`,
    body: (d, link) => `The seller is paid automatically at ${when(d.protection_ends_at)}. If anything is wrong with your order, open a dispute before then.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  seller_new_order: {
    category: 'selling',
    subject: (d) => (d.delivery_mode === 'manual' ? `New order to deliver: ${d.title}` : `Sold: ${d.title}`),
    body: (d, link) =>
      (d.delivery_mode === 'manual'
        ? `A buyer paid ${money(d.amount_cents, d.currency)} for "${d.title}" x${d.quantity}. Deliver it from the order page; the payment stays in escrow until then.`
        : `"${d.title}" x${d.quantity} sold for ${money(d.amount_cents, d.currency)} and was delivered automatically from your stock.`) +
      `\n\n${link(`/orders/${d.order_id}`)}`,
  },
  seller_paid: {
    category: 'selling',
    subject: (d) => `${money(d.seller_net_cents, d.currency)} added to your balance`,
    body: (d, link) => `Order "${d.title}" is complete. ${money(d.seller_net_cents, d.currency)} is now in your balance and ready to withdraw.\n\n${link('/sell')}`,
  },
  withdrawal_paid: {
    category: 'selling',
    subject: (d) => `Withdrawal of ${money(d.amount_cents, d.currency)} sent`,
    body: (d) => `We've sent ${money(d.amount_cents, d.currency)} to your payout account (reference ${d.provider_ref}).`,
  },
  dispute_opened: {
    category: 'disputes',
    subject: (d) => `Dispute opened on ${d.title}`,
    body: (d, link) => `A dispute was opened: "${d.reason}". The payment is frozen until an arbiter reviews the order chat. Add any evidence to the chat now.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  dispute_resolved: {
    category: 'disputes',
    subject: (d) => `Dispute resolved: ${d.title}`,
    body: (d, link) => `The arbiter decided in favour of the ${d.outcome}. Note: "${d.note}"\n\n${link(`/orders/${d.order_id}`)}`,
  },
  chargeback_received: {
    category: 'disputes',
    subject: (d) => `Chargeback on order ${String(d.order_id).slice(0, 8)}`,
    body: (d) =>
      `The buyer's bank reversed ${money(d.amount_cents)} (${d.network} ${d.reason_code}). We've filed the evidence automatically.\n\n` +
      (d.seller_protected ? 'Chargeback Shield covers this order: your balance is not affected.' : 'This listing had no verified Original Owner Proof, so the amount was taken from your balance. If the bank rules in our favour, it is returned.'),
  },
  kyc_result: {
    category: 'account',
    subject: (d) => (d.approved ? 'Your identity is verified' : 'We could not verify your identity'),
    body: (d, link) => (d.approved ? `You can now list items, use the seller API and withdraw.\n\n${link('/sell')}` : `Please try again with a clear photo of a valid ID.\n\n${link('/account')}`),
  },
  new_signin: {
    category: 'security',
    subject: () => 'New sign-in to your Bullizard account',
    body: (d, link) => `Your account was signed in from a new device (${d.userAgent ?? 'unknown browser'}, IP ${d.ip ?? 'unknown'}) at ${when(d.at)}.\n\nNot you? Change your password and sign out other devices: ${link('/account')}`,
  },
  password_changed: {
    category: 'security',
    subject: () => 'Your password was changed',
    body: (_d, link) => `Your password was changed and your other devices were signed out. Not you? Reset your password immediately: ${link('/account')}`,
  },
  mfa_changed: {
    category: 'security',
    subject: (d) => (d.enabled ? 'Two-factor login turned on' : 'Two-factor login turned off'),
    body: (d, link) => `Two-factor login was turned ${d.enabled ? 'on' : 'off'} for your account. Other devices were signed out. Not you? ${link('/account')}`,
  },
  session_reuse_detected: {
    category: 'security',
    subject: () => 'We signed out a device that may be compromised',
    body: (d, link) => `A sign-in token for one of your devices (${d.userAgent ?? 'unknown browser'}) was used twice, which usually means it was copied. We signed that device out. Change your password if you didn't expect this: ${link('/account')}`,
  },
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;

export async function enqueueEmail(q: Queryable, userId: string, template: TemplateName, data: Data, dedupeKey?: string) {
  await q.query(
    `INSERT INTO notifications (user_id, template, data, dedupe_key) VALUES ($1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
    [userId, template, JSON.stringify(data), dedupeKey ?? null],
  );
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
export async function getPreferences(q: Queryable, userId: string) {
  const row = await maybeOne<{ email_preferences: Record<string, boolean> }>(q, 'SELECT email_preferences FROM users WHERE id = $1', [userId]);
  const prefs = row?.email_preferences ?? {};
  return (Object.keys(EMAIL_CATEGORIES) as EmailCategory[]).map((c) => ({
    category: c,
    label: EMAIL_CATEGORIES[c].label,
    mandatory: !!EMAIL_CATEGORIES[c].mandatory,
    enabled: EMAIL_CATEGORIES[c].mandatory ? true : prefs[c] !== false,
  }));
}

export async function setPreferences(q: Queryable, userId: string, changes: Record<string, boolean>) {
  for (const [c, on] of Object.entries(changes)) {
    const def = EMAIL_CATEGORIES[c as EmailCategory];
    if (!def) throw badRequest('unknown_category', `Unknown email category ${c}`);
    if (def.mandatory && !on) throw badRequest('mandatory_category', `${def.label} can't be turned off`);
  }
  await q.query(`UPDATE users SET email_preferences = email_preferences || $2::jsonb WHERE id = $1`, [userId, JSON.stringify(changes)]);
  return getPreferences(q, userId);
}

// ---------------------------------------------------------------------------
// Rendering & dispatch
// ---------------------------------------------------------------------------
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function render(ctx: Ctx, name: TemplateName, data: Data) {
  const t = TEMPLATES[name] as Template;
  const link = (path: string) => `${ctx.cfg.PUBLIC_WEB_URL}${path}`;
  const text = `${t.body(data, link)}\n\n— Bullizard\nManage emails: ${link('/account')}`;
  const html =
    `<div style="font:15px/1.55 system-ui,sans-serif;color:#16202e;max-width:560px">` +
    escapeHtml(text)
      .split('\n')
      .map((l) => l.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>'))
      .join('<br>') +
    `</div>`;
  return { subject: t.subject(data), text, html, category: t.category };
}

const MAX_ATTEMPTS = 6;

export async function dispatchEmails(ctx: Ctx, limit = 50): Promise<number> {
  const claimed = await withTx(ctx.db, (tx) =>
    many(
      tx,
      `UPDATE notifications n SET attempts = n.attempts + 1, next_attempt_at = now() + interval '2 minutes'
         FROM users u
        WHERE u.id = n.user_id AND n.id IN (
          SELECT id FROM notifications WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING n.id, n.template, n.data, n.attempts, u.email, u.email_preferences`,
      [limit],
    ),
  );
  for (const n of claimed) {
    const tpl = TEMPLATES[n.template as TemplateName] as Template | undefined;
    if (!tpl) {
      await ctx.db.query(`UPDATE notifications SET status = 'failed', last_error = 'unknown template' WHERE id = $1`, [n.id]);
      continue;
    }
    if (!EMAIL_CATEGORIES[tpl.category].mandatory && n.email_preferences?.[tpl.category] === false) {
      await ctx.db.query(`UPDATE notifications SET status = 'skipped' WHERE id = $1`, [n.id]);
      continue;
    }
    try {
      const msg = render(ctx, n.template as TemplateName, n.data);
      await ctx.messenger.send({ channel: 'email', to: n.email, subject: msg.subject, body: msg.text, html: msg.html });
      await ctx.db.query(`UPDATE notifications SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`, [n.id]);
    } catch (err) {
      const dead = n.attempts >= MAX_ATTEMPTS;
      await ctx.db.query(
        `UPDATE notifications SET status = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
        [n.id, dead ? 'failed' : 'pending', (err as Error).message.slice(0, 500), 60 * 2 ** n.attempts],
      );
    }
  }
  return claimed.length;
}

/** Worker: remind buyers 24h before escrow auto-releases. Idempotent via dedupe key. */
export async function queueProtectionReminders(ctx: Ctx): Promise<number> {
  const due = await many(
    ctx.db,
    `SELECT o.id, o.buyer_id, o.protection_ends_at, f.title
       FROM orders o JOIN offers f ON f.id = o.offer_id
      WHERE o.status = 'delivered' AND o.protection_ends_at BETWEEN now() AND now() + interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.dedupe_key = 'protection_ending:' || o.id)
      LIMIT 200`,
  );
  for (const o of due) {
    await enqueueEmail(ctx.db, o.buyer_id, 'protection_ending', { order_id: o.id, title: o.title, protection_ends_at: o.protection_ends_at }, `protection_ending:${o.id}`);
  }
  return due.length;
}
