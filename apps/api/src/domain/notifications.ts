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
  /** Switched off at launch (copy deck §5.13): the event is recorded nowhere and nothing is sent. */
  disabled?: boolean;
  subject: (d: Data) => string;
  body: (d: Data, link: (path: string) => string) => string;
}

const money = (cents: number, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
const when = (iso: string) => new Date(iso).toUTCString().replace(' GMT', ' UTC');

export const TEMPLATES = {
  order_paid: {
    category: 'orders',
    subject: (d) => `Payment in. ${d.order_ref ?? d.title} is with the seller`,
    body: (d, link) =>
      `We have your ${money(d.amount_cents, d.currency)} for ${d.title}, and we're holding it. The seller trades with ${d.character ?? 'your character'} in-game and uploads the video. Nothing reaches them until that video is checked.\n\n` +
      `Track your order: ${link(`/orders/${d.order_id}`)}\n\nTerms v${d.tos_version ?? ''} accepted for this order: ${link('/terms')}`,
  },
  welcome: {
    category: 'account',
    subject: () => 'Your Bullizard account is ready',
    body: (_d, link) =>
      `Welcome in. Bullizard is for the gold, items and top-ups you'd rather not farm, in Aion, Aion 2, Albion Online and both Path of Exile games.\n\n` +
      `When you buy, your money waits with us. The seller trades with your character, films the trade and uploads it. A person checks that video, you or our staff, before anything reaches the seller.\n\n` +
      `One rule we don't bend: every word of a deal stays in the order chat. Sharing outside contacts can get an account banned right away.\n\nFind your game: ${link('/games')}`,
  },
  order_completed: {
    category: 'orders',
    subject: () => 'Order closed. Enjoy the loot',
    body: (d, link) => `${d.title} is complete and the seller has been paid. Thirty seconds on a rating helps the next buyer pick the right seller.\n\nRate the seller: ${link(`/orders/${d.order_id}`)}`,
  },
  kyc_due_reminder: {
    category: 'selling',
    subject: (d) => (Number(d.days_left) <= 0 ? 'Selling paused until you verify your ID' : `${d.days_left} days left to verify your ID`),
    body: (d, link) =>
      (Number(d.days_left) <= 0
        ? `Your 30 days are up, so selling and withdrawals are paused. Verify your ID and both switch back on. Your offers and balance are safe in the meantime.`
        : `Your ID check is due by ${when(d.date)}. It takes about five minutes: a photo ID and a short selfie video. Miss the date and selling and withdrawals pause until it's done.`) +
      `\n\nVerify now: ${link('/account')}`,
  },
  referral_earned: {
    category: 'orders',
    subject: (d) => `Your invites earned ${money(d.amount_cents, d.currency)}`,
    body: (d, link) =>
      `Friends you invited completed ${d.count} orders. Your ${d.rate_pct}% of our commission, ${money(d.amount_cents, d.currency)}, is in your balance. It keeps coming on every order they complete, for as long as they stay active.\n\nShare your link: ${link('/account#invite')}`,
  },
  legal_change: {
    category: 'account',
    subject: (d) => `${d.title} is changing on ${when(d.effective_at).slice(0, 16)}`,
    body: (d, link) => `We updated our ${d.title} (version ${d.version}). The new version takes effect on ${when(d.effective_at)}; you'll be asked to accept it at your next sign-in after that. Read it now: ${link(`/${d.doc}`)}`,
  },
  crypto_underpaid: {
    category: 'orders',
    subject: (d) => `Your payment is ${money(d.owed_cents, d.currency)} short`,
    body: (d, link) =>
      `We received ${money(d.paid_cents, d.currency)} for your order, which is ${money(d.owed_cents, d.currency)} less than its price (network fees or an exchange rate change on the way). ` +
      `Open the order and send the remaining amount to finish paying; what you sent is kept for it.\n\n${link(`/orders/${d.order_id}?pay=crypto`)}`,
  },
  crypto_refund_address: {
    category: 'orders',
    subject: (d) => `Refund of ${money(d.amount_cents, d.currency)}: where should we send it?`,
    body: (d, link) =>
      `A refund of ${money(d.amount_cents, d.currency)} is due on your order. Crypto refunds are sent to an address you give us: open the order, pick the coin and paste your address, and the treasury sends it within three working days.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  crypto_refund_sent: {
    category: 'orders',
    subject: (d) => `Refund of ${money(d.amount_cents, d.currency)} sent`,
    body: (d, link) => `Your refund of ${money(d.amount_cents, d.currency)} is on its way. Transaction: ${d.tx_hash}\n\n${link(`/orders/${d.order_id}`)}`,
  },
  order_delivered: {
    category: 'orders',
    subject: () => 'Delivered. Check your inventory',
    body: (d, link) => `The seller says ${d.title} is done and uploaded the video. Log in, check your character, then confirm on the order page. If anything is off, open a dispute instead of confirming.\n\nCheck and confirm: ${link(`/orders/${d.order_id}`)}`,
  },
  order_refunded: {
    category: 'orders',
    subject: (d) => `Refund for ${d.title}`,
    body: (d, link) => `${money(d.amount_cents, d.currency)} is back in your Bullizard balance. Spend it at checkout or withdraw it.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  delivery_late: {
    category: 'orders',
    subject: (d) => `Your order is late: ${d.title}`,
    body: (d, link) => `The seller's delivery time has passed. Give them a nudge in the order chat, or open a dispute.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  delivery_overdue: {
    category: 'selling',
    subject: (d) => `Overdue: deliver ${d.title} now`,
    body: (d, link) => `Your delivery time for ${d.title} has passed. Deliver now. The buyer can open a dispute, and late deliveries lower your on-time rate.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  protection_ending: {
    category: 'reminders',
    disabled: true, // no auto-release at launch
    subject: (d) => `24 hours left to check ${d.title}`,
    body: (d, link) => `The seller is paid automatically at ${when(d.protection_ends_at)}. If anything is wrong with your order, open a dispute before then.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  seller_new_order: {
    category: 'selling',
    subject: (d) => `New order: deliver to ${d.character ?? 'the buyer'}`,
    body: (d, link) =>
      `${d.title} ×${d.quantity} is paid and waiting. Trade with ${d.character ?? 'the buyer'} in-game, record the trade with the name and amount on screen, then upload it to the order. You're paid when the order is confirmed.\n\nOpen the order: ${link(`/orders/${d.order_id}`)}`,
  },
  seller_paid: {
    category: 'selling',
    subject: (d) => `${money(d.seller_net_cents, d.currency)} landed in your balance`,
    body: (d, link) => `${d.order_ref ?? d.title} is complete. ${money(d.seller_net_cents, d.currency)} is yours and ready to withdraw.\n\nOpen wallet: ${link('/sell/money')}`,
  },
  payout_address_code: {
    category: 'security',
    subject: () => 'Your code to confirm the new payout address',
    body: (d) => `Your code is ${d.code}. It expires in ${d.minutes} minutes and only works with the confirmation link from our other email.\n\nNot you? Change your password now.`,
  },
  payout_address_confirm: {
    category: 'security',
    subject: () => 'Confirm your new payout address',
    body: (d) =>
      `Someone (hopefully you) asked to send your withdrawals to this ${d.coin} address:\n\n${d.address}\n\n` +
      `Confirm it within ${d.minutes} minutes (you will be asked for ${d.via === 'app' ? 'your two-factor code' : d.via === 'sms' ? 'the code we sent by SMS' : 'the code in our other email'}):\n${d.url}\n\n` +
      `If you didn't ask for this, ignore this email and change your password.`,
  },
  payout_address_changed: {
    category: 'security',
    subject: () => 'Your payout address was changed',
    body: (d, link) => `Withdrawals now go to this ${d.coin} address: ${d.address}. Not you? Secure your account now: ${link('/account')}`,
  },
  withdrawal_requested: {
    category: 'selling',
    subject: (d) => `Withdrawal of ${money(d.amount_cents, d.currency)} received`,
    body: (d, link) =>
      `We'll send ${money(d.net_cents, d.currency)} to your ${d.coin} address after the ${money(d.fee_cents, d.currency)} fee, once it's approved. That usually takes up to 3 working days. Didn't ask for this? Change your password now.\n\nView wallet: ${link('/sell/money')}`,
  },
  withdrawal_paid: {
    category: 'selling',
    subject: (d) => `Sent. ${money(d.net_cents ?? d.amount_cents, d.currency)} is on the chain`,
    body: (d, link) => `${money(d.net_cents ?? d.amount_cents, d.currency)} is on its way to ${d.address ?? 'your payout address'}. Transaction: ${d.tx ?? d.provider_ref ?? 'pending'}. Depending on the network, it can take a few minutes to show in your wallet.\n\nView wallet: ${link('/sell/money')}`,
  },
  dispute_opened: {
    category: 'disputes',
    subject: (d) => `${d.order_ref ?? d.title} is on hold`,
    body: (d, link) => `A dispute was opened on ${d.title}: "${d.reason}". The money stays frozen while a Bullizard arbiter reviews the order. They read the order chat and the proof, so put everything you want them to see there now.\n\nOpen the order: ${link(`/orders/${d.order_id}`)}`,
  },
  dispute_statement: {
    category: 'disputes',
    subject: (d) => `New statement in your dispute`,
    body: (d, link) => `The ${d.role} added a statement to the dispute. Read it and reply in the order chat or with your own statement before the arbiter decides.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  warranty_claim: {
    disabled: true, // not at launch (copy deck §5.13)
    category: 'disputes',
    subject: (d) => `Warranty claim on ${d.title}`,
    body: (d, link) =>
      `The buyer says ${({ recovered: 'the account was taken back by its original owner', banned: 'the account was banned', locked: 'the account is locked' } as Record<string, string>)[d.reason as string] ?? 'the account stopped working'}. ` +
      `You have ${d.hours} hours to fix it, refund, or contest it; after that an arbiter decides. This order's payout stays on hold until the claim is settled.\n\n${link(`/orders/${d.order_id}`)}`,
  },
  warranty_update: {
    disabled: true, // not at launch (copy deck §5.13)
    category: 'disputes',
    subject: (d) => `Warranty claim update: ${d.title}`,
    body: (d, link) =>
      `${({
        seller_fixed: d.role === 'buyer' ? 'The seller says the account works again. Confirm it, or send the claim to an arbiter if it doesn’t.' : 'You reported a fix. The buyer has 72 hours to confirm it.',
        escalated: 'The claim has gone to an arbiter, who will read the order chat and decide.',
        resolved: 'The claim is resolved: the account works again.',
        refunded: d.role === 'buyer' ? 'You’ve been refunded under the warranty.' : 'The buyer was refunded under the warranty, from this order’s held payout.',
        rejected: 'An arbiter rejected the claim.',
        withdrawn: 'The buyer withdrew the claim.',
      } as Record<string, string>)[d.status as string] ?? 'The claim was updated.'}\n\n${link(`/orders/${d.order_id}`)}`,
  },
  order_progress: {
    disabled: true, // not at launch (copy deck §5.13)
    category: 'orders',
    subject: (d) => `${d.percent}% done: ${d.title}`,
    body: (d, link) => `The seller posted progress on "${d.title}": ${d.percent}%${d.note ? `. "${d.note}"` : '.'}\n\n${link(`/orders/${d.order_id}`)}`,
  },
  dispute_resolved: {
    category: 'disputes',
    subject: (d) => `Decision on ${d.order_ref ?? d.title}`,
    body: (d, link) => {
      // `for_you` and `result` are set per recipient (orders.ts resolveDispute).
      const lead = d.for_you ? 'The arbiter ruled in your favour.' : 'The arbiter ruled in the other side\'s favour.';
      return `${lead} ${d.result ?? ''} The arbiter's note: "${d.note}"\n\nOpen the order: ${link(`/orders/${d.order_id}`)}`;
    },
  },
  chargeback_received: {
    category: 'disputes',
    disabled: true, // no card payments at launch
    subject: (d) => `Chargeback on order ${String(d.order_id).slice(0, 8)}`,
    body: (d) =>
      `The buyer's bank reversed ${money(d.amount_cents)} (${d.network} ${d.reason_code}). We've filed the evidence automatically.\n\n` +
      (d.seller_protected ? 'Chargeback Shield covers this order: your balance is not affected.' : 'This listing had no verified Original Owner Proof, so the amount was taken from your balance. If the bank rules in our favour, it is returned.'),
  },
  kyc_result: {
    category: 'account',
    subject: (d) => (d.approved ? 'Your identity is verified' : 'We could not verify your identity'),
    body: (d, link) => (d.approved ? `You're verified. Selling and withdrawals are on.\n\n${link('/sell')}` : `Please try again with a clear photo of a valid ID.\n\n${link('/account')}`),
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
  retention_digest: {
    category: 'operations',
    subject: (d) => `${d.alerts.length ? 'Alert: ' : ''}Weekly retention: ${d.active_buyers} active buyers (${d.active_buyers_delta_pct == null ? 'n/a' : `${d.active_buyers_delta_pct >= 0 ? '+' : ''}${d.active_buyers_delta_pct}%`} vs last week)`,
    body: (d, link) =>
      `Retention for the week ending ${d.week_ending}:\n\n` +
      (d.alerts.length ? `ALERTS\n${(d.alerts as string[]).map((a) => `- ${a}`).join('\n')}\n\n` : '') +
      `THIS WEEK (vs the week before)\n` +
      `- Paid orders: ${d.orders} (${d.prev_orders})\n` +
      `- Active buyers: ${d.active_buyers} (${d.prev_active_buyers}), of which returning: ${d.returning_buyers} (${d.prev_returning_buyers})\n` +
      `- New buyers: ${d.new_buyers} (${d.prev_new_buyers})\n` +
      `- Active sellers: ${d.active_sellers} (${d.prev_active_sellers}), new sellers: ${d.new_sellers} (${d.prev_new_sellers})\n\n` +
      `LAST FULL MONTH (${d.month})\n` +
      `- Seller churn: ${d.seller_churn_pct == null ? 'n/a' : `${d.seller_churn_pct}%`} (${d.churned_sellers ?? 0} of ${d.sellers_last_month ?? 0} sellers active the month before did not sell)\n` +
      `- Returning buyers: ${d.returning_pct == null ? 'n/a' : `${d.returning_pct}%`} of ${d.month_active_buyers} active buyers\n` +
      `- 90-day repeat rate (completed cohorts): ${d.repeat_90d_pct == null ? 'n/a' : `${d.repeat_90d_pct}%`}\n\n` +
      `Cohorts and the full series: ${link('/admin/retention')}`,
  },
  ops_alert: {
    category: 'operations',
    subject: (d) => `Ops alert: ${d.title}`,
    body: (d, link) => `${d.detail}\n\nWhat to do: ${d.action}\n\nOps console: ${link('/admin')}`,
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
  saved_search_digest: {
    category: 'alerts',
    subject: (d) => `${d.count} new listing${d.count === 1 ? '' : 's'} for "${d.name}"`,
    body: (d, link) =>
      `New since we last looked, cheapest first:\n\n${(d.top as any[]).map((o) => `- ${o.title}: ${money(o.price_cents, o.currency)}`).join('\n')}\n\nSee all ${d.count}: ${link(d.path)}\n\nChange or stop this digest on your watchlist: ${link('/watchlist')}`,
  },
  watch_game_low: {
    category: 'alerts',
    subject: (d) => `${d.game}${d.attributes && Object.keys(d.attributes).length ? ` (${Object.values(d.attributes).join(', ')})` : ''}: from ${money(d.price_cents, d.currency)}`,
    body: (d, link) =>
      `A ${d.game} listing you're watching for is ${d.target_cents ? `at or below your ${money(d.target_cents, d.currency)} target` : 'at a new low'}: "${d.title}" for ${money(d.price_cents, d.currency)}.\n\n${link(`/offers/${d.offer_id}`)}`,
  },
  request_posted: {
    disabled: true, // not at launch (copy deck §5.13)
    category: 'selling',
    subject: (d) => `New request in ${d.game}: ${d.title}`,
    body: (d, link) =>
      `A buyer is looking for "${d.title}"${d.budget_cents ? ` with a budget of ${money(d.budget_cents, d.currency)}` : ''}. You list in ${d.game}, so you may have what they need. Send a price and delivery time.\n\n${link(`/requests/${d.request_id}`)}`,
  },
  request_proposal: {
    disabled: true, // not at launch (copy deck §5.13)
    category: 'orders',
    subject: (d) => `${d.revised ? 'Updated proposal' : 'New proposal'} for "${d.title}"`,
    body: (d, link) =>
      `${d.seller_name} offers ${money(d.price_cents, d.currency)} with delivery within ${d.delivery_hours} hours. Accept it to check out; your payment is held in escrow as for any order.\n\n${link(`/requests/${d.request_id}`)}`,
  },
  request_accepted: {
    disabled: true, // not at launch (copy deck §5.13)
    category: 'selling',
    subject: (d) => `Proposal accepted: ${d.title}`,
    body: (d, link) =>
      `The buyer accepted your ${money(d.price_cents, d.currency)} proposal. We've made a private listing for them; you'll get the usual new-order notice as soon as they pay.\n\n${link(`/requests/${d.request_id}`)}`,
  },
  crypto_kept_in_balance: {
    category: 'orders',
    subject: (d) => `${money(d.amount_cents, d.currency)} kept in your balance`,
    body: (d, link) =>
      `The payment window for your order closed before the full amount arrived, so the ${money(d.amount_cents, d.currency)} you sent is now in your Bullizard balance. Use it on your next order at checkout, or withdraw it to your wallet (6% fee, minimum 1.50).\n\n${link('/account#credit')}`,
  },
  listing_expired_league: {
    category: 'selling',
    subject: (d) => `${d.league} has ended: "${d.title}" is no longer listed`,
    body: (d, link) =>
      `The ${d.league} league is over, so your listing "${d.title}" has been taken off the market. Move it to an open league from your seller hub to list it again.\n\n${link('/sell')}`,
  },
  listing_review: {
    category: 'selling',
    subject: () => 'Your listing is being reviewed',
    body: (d, link) =>
      `${d.title ? `"${d.title}"` : 'Your listing'} mentions something our rules ask us to check (prohibited goods or contact details), so it's hidden until a moderator looks at it, usually within a few hours. You'll hear back either way.\n\n${link('/sell')}`,
  },
  listing_approved: {
    category: 'selling',
    subject: (d) => `Listing approved: ${d.title}`,
    body: (d, link) => `A moderator approved "${d.title}" and it's live again.\n\n${link(`/offers/${d.offer_id}`)}`,
  },
  listing_rejected: {
    category: 'selling',
    subject: (d) => `Listing removed: ${d.title}`,
    body: (d, link) => `A moderator removed "${d.title}": ${d.note}\n\nYou can post a new listing that follows the rules. Reply to support if you think this is a mistake.\n\n${link('/support/new?category=selling')}`,
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
  // A template switched off at launch (copy deck §5.13) sends no email; the inbox item still appears.
  const disabled = !!(TEMPLATES[template] as Template).disabled;
  const { rowCount } = await q.query(
    `INSERT INTO notifications (user_id, template, data, dedupe_key, status, sent_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'skipped' THEN now() END) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [userId, template, JSON.stringify(data), dedupeKey ?? null, disabled ? 'skipped' : 'pending'],
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

/**
 * Round 23a: an email to a team mailbox (ALERTS_EMAIL, FINANCE_EMAIL) rather than a user: same outbox, retries and
 * dedupe key, English, no inbox item. Does nothing when the address is not configured.
 */
export async function enqueueMailboxEmail(q: Queryable, to: string | undefined, template: TemplateName, data: Data, dedupeKey: string) {
  if (!to) return;
  await q.query(
    `INSERT INTO notifications (user_id, to_email, template, data, dedupe_key, status) VALUES (NULL, $1, $2, $3, $4, 'pending') ON CONFLICT (dedupe_key) DO NOTHING`,
    [to, template, JSON.stringify(data), `${dedupeKey}:${to}`],
  );
}

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

/**
 * The HTML part of every customer email (follow-up 12): one layout for all languages, right-to-left with lang="ar" for
 * Arabic. The plain-text part is always sent next to it.
 */
export function emailHtml(text: string, locale: Locale = 'en', title = 'Bullizard') {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const body = escapeHtml(text)
    .split('\n')
    .map((l) => l.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2f6fed">$1</a>'))
    .join('<br>');
  return (
    `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head><body style="margin:0;padding:24px;background:#f5f7fa">` +
    `<div dir="${dir}" style="font:15px/1.55 system-ui,sans-serif;color:#16202e;max-width:560px;margin:0 auto;background:#ffffff;padding:24px;border-radius:8px;text-align:${dir === 'rtl' ? 'right' : 'left'}">` +
    `${body}</div></body></html>`
  );
}

export function render(ctx: Ctx, name: TemplateName, data: Data, locale: Locale = 'en') {
  const t = templateFor(name, locale);
  const link = (path: string) => `${ctx.cfg.PUBLIC_WEB_URL}${path}`;
  const pack = locale === 'en' ? null : PACKS[locale];
  const text = `${t.body(data, link)}\n\n${pack?.signoff ?? '— Bullizard'}\n${pack?.manage ?? 'Manage emails'}: ${link('/account')}`;
  const html = emailHtml(text, locale, t.subject(data));
  return { subject: t.subject(data), text, html, category: t.category };
}

const MAX_ATTEMPTS = 6;

export async function dispatchEmails(ctx: Ctx, limit = 50): Promise<number> {
  const claimed = await withTx(ctx.db, (tx) =>
    many(
      tx,
      `UPDATE notifications n SET attempts = n.attempts + 1, next_attempt_at = now() + interval '2 minutes'
        WHERE n.id IN (
          SELECT id FROM notifications WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING n.id, n.template, n.data, n.attempts,
          COALESCE(n.to_email, (SELECT u.email FROM users u WHERE u.id = n.user_id)) AS email,
          (SELECT u.email_preferences FROM users u WHERE u.id = n.user_id) AS email_preferences,
          (SELECT u.locale FROM users u WHERE u.id = n.user_id) AS locale`,
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
      // The notification id is the idempotency key: a retry after a timeout is the same message, sent once.
      await ctx.messenger.send({ channel: 'email', to: n.email, subject: msg.subject, body: msg.text, html: msg.html, idempotencyKey: `notification-${n.id}` });
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
