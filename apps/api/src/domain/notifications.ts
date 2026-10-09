import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { many, maybeOne, withTx } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { PACKS, helpers, isLocale, type Locale } from './locales/index.js';

/**
 * Notifications. Business code calls notify() (alias enqueueEmail) inside its own transaction
 * (outbox pattern), so a notification exists if and only if the event it describes committed.
 * Each one lands in the user's in-app inbox, and the worker delivers it by email and Web Push
 * according to the user's per-category preferences for each channel, and live to open tabs.
 */
export type EmailCategory = 'orders' | 'selling' | 'disputes' | 'reminders' | 'alerts' | 'support' | 'account' | 'security' | 'operations';

export const EMAIL_CATEGORIES: Record<EmailCategory, { label: string; mandatory?: boolean; staffOnly?: boolean }> = {
  orders: { label: 'Purchases: payment received, delivery, refunds' },
  selling: { label: 'Sales: new orders to deliver, payouts' },
  disputes: { label: 'Disputes and chargebacks', mandatory: true },
  reminders: { label: 'Reminders before your protection window ends' },
  alerts: { label: 'Price alerts and watchlist updates' },
  support: { label: 'Replies to your help requests', mandatory: true },
  account: { label: 'Verification and payout account updates', mandatory: true },
  security: { label: 'Security alerts', mandatory: true },
  operations: { label: 'Staff alerts (reconciliation, operations)', mandatory: true, staffOnly: true },
};

type Data = Record<string, any>;
interface Template {
  category: EmailCategory;
  /** false for messages carrying secrets (reset links) that must only go to the mailbox. */
  inbox?: boolean;
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
  delivery_late: {
    category: 'orders',
    subject: (d) => `Your order is late: ${d.title}`,
    body: (d, link) =>
      `The seller promised delivery by ${when(d.delivery_due_at)} and hasn't delivered yet. You can wait, or cancel now for a full refund. ` +
      `If it still isn't delivered within ${d.auto_refund_hours} hours, we refund you automatically.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  delivery_overdue: {
    category: 'selling',
    subject: (d) => `Overdue: deliver ${d.title} now`,
    body: (d, link) =>
      `You promised delivery by ${when(d.delivery_due_at)}. The buyer can now cancel for a full refund, and the order is refunded automatically in ${d.auto_refund_hours} hours. ` +
      `Late deliveries lower your on-time rate, which buyers see on your profile.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  referral_reward: {
    category: 'orders',
    subject: (d) => `You earned ${money(d.amount_cents, d.currency)} in Bullizard credit`,
    body: (d, link) => `A friend you invited completed their first order. ${money(d.amount_cents, d.currency)} of credit is in your account and applies at checkout.\n\n${link('/account')}`,
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
  password_reset: {
    category: 'security',
    inbox: false,
    subject: () => 'Reset your Bullizard password',
    body: (d) =>
      `Someone asked to reset the password for this account${d.ip ? ` (from IP ${d.ip})` : ''}. Use this link within ${d.minutes} minutes:\n\n${d.url}\n\n` +
      `If you didn't ask for this, ignore this email; your password stays the same.`,
  },
  new_review: {
    category: 'selling',
    subject: (d) => `New ${d.rating}-star review`,
    body: (d, link) => `A buyer rated order "${d.title}" ${d.rating}/5${d.comment ? `: "${d.comment}"` : '.'}\n\nYou can post one public reply: ${link('/sell')}`,
  },
  reconciliation_alert: {
    category: 'operations',
    subject: (d) => `Reconciliation ${d.status}: ${d.issues} issue(s)`,
    body: (d, link) => `The ${d.started_at} money reconciliation found ${d.issues} issue(s):\n\n${(d.summary as string[]).join('\n')}\n\n${link('/admin')}`,
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
  clawback: {
    category: 'selling',
    subject: (d) => `Refund after release: ${d.title}`,
    body: (d, link) =>
      `After reviewing order "${d.title}", we refunded the buyer (${d.reason}). Your share, ${money(d.amount_cents, d.currency)}, has been taken from your balance; if your balance goes below zero, it's recovered from your next sales. Commission was returned too (credit note ${d.credit_note}).\n\n${link(`/orders/${d.order_id}`)}`,
  },
  withdrawal_failed: {
    category: 'selling',
    subject: (d) => `Payout of ${money(d.amount_cents, d.currency)} failed`,
    body: (d, link) => `Your payout of ${money(d.amount_cents, d.currency)} could not be sent (${d.reason}). The money is back in your balance. Check your payout account: ${link('/sell')}`,
  },
  invoice_issued: {
    category: 'selling',
    subject: (d) => `Your commission invoice ${d.number}`,
    body: (d, link) => `Invoice ${d.number} for ${d.period} is ready: commission ${money(d.gross_cents, d.currency)}, of which tax ${money(d.tax_cents, d.currency)}. It was already deducted from your sales.\n\n${link('/sell/invoices')}`,
  },
  aml_case_opened: {
    category: 'operations',
    subject: (d) => `Compliance case: ${d.rule} (${d.severity})`,
    body: (d, link) => `A ${d.severity}-severity compliance case was opened (${d.rule}). Review it: ${link(`/admin/aml/${d.case_id}`)}`,
  },
  staff_roles_changed: {
    category: 'security',
    subject: () => 'Your staff access changed',
    body: (d, link) => `Your Bullizard staff roles are now: ${d.roles.length ? d.roles.join(', ') : 'none'} (changed by ${d.by}). If this is unexpected, contact security immediately. ${link('/account')}`,
  },
  debt_reminder: {
    category: 'account',
    subject: (d) => (d.first ? `Your balance is ${money(-d.amount_cents, d.currency)}` : `Reminder: you owe ${money(d.amount_cents, d.currency)}`),
    body: (d, link) =>
      `Your Bullizard balance is below zero by ${money(d.amount_cents, d.currency)} after a refund or chargeback. New sales pay it down automatically, or you can pay it now by card. ` +
      `Withdrawals are paused until it's settled, and if it's still unpaid on ${when(d.pause_at)} your shop will be paused.\n\n${link('/sell/money')}`,
  },
  debt_shop_paused: {
    category: 'account',
    subject: () => 'Your shop is paused until your balance is settled',
    body: (d, link) =>
      `Your balance is still below zero by ${money(d.amount_cents, d.currency)}, so your listings are hidden and can't be bought. ` +
      `Orders already paid still need to be delivered. Pay the balance to reopen your shop straight away.\n\n${link('/sell/money')}`,
  },
  debt_cleared: {
    category: 'selling',
    subject: () => 'Your balance is settled',
    body: (d, link) => `Your ${d.currency} balance is back above zero${d.reason === 'written_off' ? ' (we wrote off the remainder)' : ''}. ${d.resumed ? 'Your shop is open again. ' : ''}Withdrawals are available as usual.\n\n${link('/sell/money')}`,
  },
  fx_topup_proposed: {
    category: 'operations',
    subject: (d) => `Approve buying ${money(d.to_cents, d.currency)}`,
    body: (d, link) => `Sellers are owed more ${d.currency} than the platform holds. Proposed: buy ${money(d.to_cents, d.currency)} for about ${money(d.est_from_cents, d.from_currency)}. Approve or reject it: ${link('/admin')}`,
  },
  debt_escalated: {
    category: 'operations',
    subject: (d) => `Seller debt unpaid: ${money(d.amount_cents, d.currency)}`,
    body: (d, link) => `A seller has owed ${money(d.amount_cents, d.currency)} past the reminder period; their shop is now paused. Review it, or write it off with a ledger adjustment: ${link('/admin')}`,
  },
  watch_price_drop: {
    category: 'alerts',
    subject: (d) => `Price drop: ${d.title} is now ${money(d.price_cents, d.currency)}`,
    body: (d, link) =>
      `${d.title} is now ${money(d.price_cents, d.currency)}${d.target_cents ? `, at or below your target of ${money(d.target_cents, d.currency)}` : ', lower than when you started watching it'}.\n\n${link(`/offers/${d.offer_id}`)}`,
  },
  watch_back_in_stock: {
    category: 'alerts',
    subject: (d) => `Back in stock: ${d.title}`,
    body: (d, link) => `${d.title} is available again at ${money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
  },
  watch_game_low: {
    category: 'alerts',
    subject: (d) => `${d.game}${d.attributes && Object.keys(d.attributes).length ? ` (${Object.values(d.attributes).join(', ')})` : ''}: from ${money(d.price_cents, d.currency)}`,
    body: (d, link) =>
      `A ${d.game} listing you're watching for is ${d.target_cents ? `at or below your ${money(d.target_cents, d.currency)} target` : 'at a new low'}: "${d.title}" for ${money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
  },
  support_received: {
    category: 'support',
    subject: (d) => `We got your request #${d.number}`,
    body: (d, link) => `Thanks for getting in touch about "${d.subject}". Our support team usually answers within a few hours; you'll get an email when they reply.\n\n${link(`/support/${d.ticket_id}`)}`,
  },
  support_reply: {
    category: 'support',
    subject: (d) => (d.resolved ? `Request #${d.number} resolved` : `New reply on request #${d.number}`),
    body: (d, link) =>
      `Bullizard Support replied to "${d.subject}"${d.resolved ? ' and marked it resolved. Reply if you still need help and it reopens' : ''}:\n\n${d.preview}\n\n${link(`/support/${d.ticket_id}`)}`,
  },
  support_auto_resolved: {
    category: 'support',
    subject: (d) => `Request #${d.number} closed`,
    body: (d, link) => `We haven't heard back about "${d.subject}" for ${d.days} days, so we've marked it resolved. Reply any time to reopen it.\n\n${link(`/support/${d.ticket_id}`)}`,
  },
  account_locked: {
    category: 'security',
    subject: () => 'Sign-in paused after failed attempts',
    body: (d, link) => `There were ${d.failures} failed sign-in attempts on your account, so sign-in is paused for ${d.minutes} minutes. If this wasn't you, your account is safe, but consider turning on two-factor login. You can also reset your password now: ${link('/forgot-password')}`,
  },
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;

/**
 * A template in the reader's language. Customer-facing messages are translated (./locales);
 * staff alerts and anything not yet translated fall back to English.
 */
export function templateFor(name: TemplateName, locale: Locale = 'en'): Template {
  const base = TEMPLATES[name] as Template;
  const t = locale === 'en' ? undefined : PACKS[locale].templates[name];
  if (!t) return base;
  const h = helpers(locale);
  return { ...base, subject: (d) => t.subject(d, h), body: (d, link) => t.body(d, link, h) };
}

async function localeOf(q: Queryable, userId: string): Promise<Locale> {
  const row = await maybeOne<{ locale: string }>(q, 'SELECT locale FROM users WHERE id = $1', [userId]);
  return isLocale(row?.locale) ? row.locale : 'en';
}

export async function enqueueEmail(q: Queryable, userId: string, template: TemplateName, data: Data, dedupeKey?: string) {
  const { rowCount } = await q.query(
    `INSERT INTO notifications (user_id, template, data, dedupe_key) VALUES ($1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [userId, template, JSON.stringify(data), dedupeKey ?? null],
  );
  if (!rowCount) return; // duplicate (dedupe key): already notified
  const t = templateFor(template, await localeOf(q, userId));
  if (t.inbox === false) return;
  const item = inboxText(t, data);
  await q.query(
    `INSERT INTO inbox_items (user_id, template, category, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, template, t.category, item.title, item.body, item.link],
  );
}

/** Every notification goes to the inbox and, per preferences, to email and push. */
export const notify = enqueueEmail;

/** Inbox wording: the email subject as title, its first paragraph as body, its first app link as the target. */
function inboxText(t: Template, data: Data) {
  const MARK = '\u0000';
  const raw = t.body(data, (path) => `${MARK}${path}${MARK}`);
  const link = raw.split(MARK)[1] ?? null;
  const first = raw.split('\n\n')[0]!.split(MARK).filter((_, i) => i % 2 === 0).join('').replace(/[:\s]+$/, '').trim();
  return { title: t.subject(data).slice(0, 200), body: first.length > 300 ? `${first.slice(0, 297)}...` : first, link };
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
export async function getPreferences(q: Queryable, userId: string) {
  const row = await maybeOne<{ email_preferences: Record<string, boolean> }>(q, 'SELECT email_preferences FROM users WHERE id = $1', [userId]);
  const prefs = row?.email_preferences ?? {};
  return (Object.keys(EMAIL_CATEGORIES) as EmailCategory[]).filter((c) => !EMAIL_CATEGORIES[c].staffOnly).map((c) => ({
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

export function render(ctx: Ctx, name: TemplateName, data: Data, locale: Locale = 'en') {
  const t = templateFor(name, locale);
  const link = (path: string) => `${ctx.cfg.PUBLIC_WEB_URL}${path}`;
  const pack = locale === 'en' ? null : PACKS[locale];
  const text = `${t.body(data, link)}\n\n${pack?.signoff ?? '— Bullizard'}\n${pack?.manage ?? 'Manage emails'}: ${link('/account')}`;
  const html =
    `<div dir="${locale === 'ar' ? 'rtl' : 'ltr'}" style="font:15px/1.55 system-ui,sans-serif;color:#16202e;max-width:560px">` +
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
        RETURNING n.id, n.template, n.data, n.attempts, u.email, u.email_preferences, u.locale`,
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
      const msg = render(ctx, n.template as TemplateName, n.data, isLocale(n.locale) ? n.locale : 'en');
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
