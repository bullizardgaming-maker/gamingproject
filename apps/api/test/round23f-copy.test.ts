import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { withTx } from '../src/db.js';
import { accountId, post } from '../src/domain/ledger.js';
import { PACKS, arCount, arDuration } from '../src/domain/locales/index.js';
import { render, renderCodeEmail } from '../src/domain/notifications.js';
import { decideWithdrawal } from '../src/domain/cryptoPayouts.js';
import { NowPaymentsProvider } from '../src/providers/payments/nowpayments.js';
import { buyAndPay, client, makeOffer, makeUser, setup, type Harness } from './helpers.js';

/** Round 23f part B: copy deck §9 (claude/bullizard-copy-deck.md) — error codes, withdrawal reasons, email layout, chat. */
let h: Harness;
let wsUrl: string;
beforeAll(async () => {
  h = await setup();
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  wsUrl = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/v1/ws`;
});
afterAll(async () => {
  await h.close();
});
const PASSWORD = 'correct horse battery';
const ORDER_ID = '00000000-0000-4000-8000-000000000001';

describe('§9.2 / §9.4 distinct error codes', () => {
  it('sign-in, session, re-auth and change-password failures each have their own code', async () => {
    const u = await makeUser(h);
    const wrong = await client(h.app).post('/v1/auth/login', { email: u.email, password: 'not the password' });
    expect([wrong.status, wrong.body.error.code]).toEqual([401, 'invalid_credentials']);
    // Unknown account: the same answer, so it never reveals which accounts exist.
    const unknown = await client(h.app).post('/v1/auth/login', { email: `nobody_${Date.now()}@example.com`, password: 'not the password' });
    expect([unknown.status, unknown.body.error.code, unknown.body.error.message]).toEqual([401, 'invalid_credentials', wrong.body.error.message]);
    expect((await client(h.app).post('/v1/auth/refresh', {})).body.error.code).toBe('session_expired');
    expect((await client(h.app).post('/v1/auth/refresh', { refreshToken: 'not-a-token' })).body.error.code).toBe('session_expired');
    expect((await client(h.app, 'not-a-jwt').get('/v1/me')).body.error.code).toBe('session_expired');
    expect((await client(h.app).post('/v1/auth/mfa', { mfaToken: 'not-a-jwt', code: '123456' })).body.error.code).toBe('reauth_required');
    const change = await u.api.post('/v1/me/password', { currentPassword: 'not the password', newPassword: 'another good password 23f' });
    expect([change.status, change.body.error.code]).toEqual([403, 'wrong_current_password']); // not 401: the client would refresh and retry
  });

  it('balance_owed no longer talks about chargebacks', async () => {
    const seller = await makeUser(h, { tier: 2 });
    await withTx(h.ctx.db, async (tx) => {
      await post(tx, [{ account: await accountId(tx, 'treasury', 'USD'), amountCents: 5_00 }, { account: await accountId(tx, 'seller_available', 'USD', seller.id), amountCents: -5_00 }], 'test_negative');
    });
    const del = await seller.api.post('/v1/me/delete', { password: PASSWORD });
    expect(del.body.error.code).toBe('balance_owed');
    expect(del.body.error.message).not.toMatch(/chargeback/i);
  });
});

describe('§9.6 withdrawal_failed carries a reason code', () => {
  it('rejections and unsupported coins send a code, worded per language; old free text falls back to a safe line', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const cfo = await makeUser(h, { tier: 2, role: 'finance' });
    const insert = async (coin: string) =>
      (await h.ctx.db.query(
        `INSERT INTO withdrawals (user_id, amount_cents, currency, status, fee_cents, net_cents, destination_address, destination_currency) VALUES ($1, 1000, 'USD', 'pending_approval', 0, 1000, 'TAddr23f', $2) RETURNING id`,
        [seller.id, coin],
      )).rows[0].id as string;
    const reasons = async () => (await h.ctx.db.query(`SELECT data->>'reason' AS r FROM notifications WHERE user_id = $1 AND template = 'withdrawal_failed' ORDER BY created_at`, [seller.id])).rows.map((r) => r.r);
    // A payouts provider that is never reached: rejections and refused coins never call it.
    const np = new NowPaymentsProvider({ apiKey: 'k', ipnSecret: 'i', apiUrl: 'https://np.test', email: 'e', password: 'p', twoFactorSecret: 'JBSWY3DPEHPK3PXP', fetch: (async () => { throw new Error('not called'); }) as any });
    const ctx = { ...h.ctx, payments: np } as typeof h.ctx;
    const staff = { id: cfo.id, role: 'finance' };
    expect((await decideWithdrawal(ctx, await insert('usdttrc20'), staff, false, 'odd pattern')).status).toBe('rejected');
    await decideWithdrawal(ctx, await insert('btc'), staff, true).catch(() => {});
    expect(await reasons()).toEqual(['not_approved', 'unsupported_coin']);

    const data = { amount_cents: 10_00, currency: 'USD', reason: 'unsupported_coin' };
    const en = render(h.ctx, 'withdrawal_failed', data, 'en');
    expect(en.subject).toBe('Withdrawal of $10.00 not sent');
    expect(en.text).toContain("We couldn't send your withdrawal of $10.00. Payouts go out in USDT only. Add a USDT (TRC-20 or BEP-20) address and try again. The money is back in your balance.");
    const ar = render(h.ctx, 'withdrawal_failed', { ...data, reason: 'not_approved' }, 'ar');
    expect(ar.subject).toBe('لم يُرسَل سحب $10.00');
    expect(ar.text).toContain('تعذّر إرسال سحبك بقيمة $10.00. لم تتم الموافقة عليه. تواصل مع الدعم إن احتجت التفاصيل. عاد المبلغ إلى رصيدك.');
    // No English provider text inside an Arabic email: unknown reasons get the provider_failed line.
    const legacy = render(h.ctx, 'withdrawal_failed', { ...data, reason: 'insufficient funds in hot wallet' }, 'ar');
    expect(legacy.text).toContain('رفضته شبكة الدفع.');
    expect(legacy.text).not.toContain('insufficient');
    for (const pack of Object.values(PACKS)) expect(Object.keys(pack.withdrawalReasons).sort()).toEqual(['not_approved', 'provider_failed', 'unsupported_coin']);
  });
});

describe('§9.7 email layout', () => {
  it('arCount and durations agree in Arabic', () => {
    expect([1, 2, 3, 10, 11, 15].map((n) => arCount(n, 'دقيقة واحدة', 'دقيقتان', 'دقائق', 'دقيقة'))).toEqual(['دقيقة واحدة', 'دقيقتان', '3 دقائق', '10 دقائق', '11 دقيقة', '15 دقيقة']);
    expect([15, 10, 60, 120, 1440].map(arDuration)).toEqual(['15 دقيقة', '10 دقائق', 'ساعة واحدة', 'ساعتان', '24 ساعة']);
  });

  it('greeting, one green button, isolated variables, plain sign-off and footer, in every language', () => {
    const data = { title: 'Elden Ring key', amount_cents: 32_49, currency: 'USD', order_id: ORDER_ID, order_ref: 'BZ-7Q2', character: 'Ryo_77', tos_version: '2026-10-24' };
    const ar = render(h.ctx, 'order_paid', data, 'ar', { name: 'Layla' });
    expect(ar.text.startsWith('أهلًا Layla،\n\n')).toBe(true);
    expect(ar.text).toContain(`تابع طلبك: ${h.ctx.cfg.PUBLIC_WEB_URL}/orders/${ORDER_ID}`); // plain text keeps "Label: URL"
    expect(ar.text).toContain('\n\nفريق Bullizard\n\n');
    expect(ar.text).toContain(`إعدادات البريد: ${h.ctx.cfg.PUBLIC_WEB_URL}/account`);
    expect(ar.text).not.toContain('—');
    // HTML: the last link is the one button (rune green, dark text, radius 8, no shadow); variables isolated.
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.html).toContain('line-height:1.7');
    expect(ar.html).toMatch(/<a href="[^"]*\/terms" style="display:inline-block;background:#4bae24;color:#0d131c;[^"]*border-radius:8px;box-shadow:none">/);
    expect(ar.html.match(/background:#4bae24/g)).toHaveLength(1);
    expect(ar.html).toContain('<bdi>Elden Ring key</bdi>');
    expect(ar.html).toContain('<bdi>Ryo_77</bdi>');
    expect(ar.html).toContain('<span dir="ltr">$32.49</span>');
    expect(ar.html).toMatch(/>الشروط \(الإصدار 2026-10-24\) المقبولة لهذا الطلب<\/a>/); // the last link is the button, with its label
    expect(ar.html).not.toContain('#2f6fed');
    expect(ar.html).not.toMatch(/[-]/); // no marker leaks
    expect(ar.html).toContain(`href="${h.ctx.cfg.PUBLIC_WEB_URL}/orders/${ORDER_ID}"`); // markers never reach a URL
    expect(ar.html).toContain('system-ui, &quot;Segoe UI&quot;, Tahoma, Arial, sans-serif');
    for (const line of ['تصلك هذه الرسالة لأن لديك حسابًا في Bullizard.', 'لن نطلب منك كلمة المرور أو الرموز عبر البريد أبدًا.', 'إعدادات البريد', 'Bullizard · للبالغين 18+ فقط · غير تابع لأي ناشر ألعاب']) expect(ar.html).toContain(line);
    const en = render(h.ctx, 'order_paid', data, 'en', { name: null });
    expect(en.text.startsWith('Hey,\n\n')).toBe(true);
    expect(en.html).toContain('>Terms v2026-10-24 accepted for this order</a>'); // the button carries the label
    for (const locale of ['es', 'fr', 'de', 'pt'] as const) {
      const r = render(h.ctx, 'order_completed', data, locale, { name: 'Sam' });
      expect(r.text.startsWith(PACKS[locale].layout.greeting.replace('{name}', 'Sam'))).toBe(true);
      expect(r.html).toContain(PACKS[locale].layout.legal);
      expect(r.text).not.toContain('—');
    }
  });

  it('security emails have no "Email settings" link; missing values drop their piece', () => {
    const locked = render(h.ctx, 'account_locked', { failures: 5, minutes: 15 }, 'ar');
    expect(locked.subject).toBe('أوقفنا تسجيل الدخول مؤقتًا بعد محاولات فاشلة');
    expect(locked.text).toContain('وعدد المحاولات: 5، لذا أوقفنا تسجيل الدخول لمدة 15 دقيقة.');
    expect(locked.text).not.toContain('إعدادات البريد');
    expect(locked.html).not.toContain('إعدادات البريد');
    expect(locked.html).toContain('>إعادة تعيين كلمة المرور</a>');
    expect(render(h.ctx, 'account_locked', { failures: 5, minutes: 10 }, 'ar').text).toContain('لمدة 10 دقائق');
    expect(render(h.ctx, 'account_locked', { failures: 5, minutes: 60 }, 'en').text).toContain('paused for 1 hour.');
    const noQty = render(h.ctx, 'seller_new_order', { title: 'Gold', order_id: ORDER_ID }, 'en');
    expect(noQty.text).not.toContain('undefined');
    expect(noQty.text).toContain('Gold is paid and waiting.');
    expect(render(h.ctx, 'seller_new_order', { title: 'Gold', order_id: ORDER_ID }, 'ar').text).not.toContain('×');
    const noTos = render(h.ctx, 'order_paid', { title: 'K', amount_cents: 100, currency: 'USD', order_id: ORDER_ID }, 'ar');
    expect(noTos.text).not.toContain('الإصدار )');
    expect(noTos.text).not.toContain('الإصدار');
    expect(render(h.ctx, 'order_paid', { title: 'K', amount_cents: 100, currency: 'USD', order_id: ORDER_ID }, 'en').text).not.toMatch(/Terms v\s/);
  });

  it('the verification-code email has the code in its subject and in a large LTR block', async () => {
    const mail = renderCodeEmail(h.ctx, '482913', 10, 'ar', 'Layla');
    expect(mail.subject).toBe('رمز Bullizard الخاص بك: 482913');
    expect(mail.text).toContain('رمزك هو 482913، وهو صالح لمدة 10 دقائق. إن لم تطلبه فتجاهل هذه الرسالة.');
    expect(mail.html).toMatch(/<div dir="ltr" style="font:700 30px[^"]*">482913<\/div>/);
    expect(mail.html).not.toContain('إعدادات البريد'); // a security email
    expect(renderCodeEmail(h.ctx, '482913', 10, 'en').subject).toBe('Your Bullizard code: 482913');
    // Through the API: the email that is actually sent.
    const sent: any[] = [];
    const orig = h.messenger.send.bind(h.messenger);
    h.messenger.send = async (m: any) => (sent.push(m), orig(m));
    try {
      const u = await makeUser(h, { tier: 0 });
      await u.api.post('/v1/verify/email/send');
      expect(sent.at(-1).subject).toMatch(/^Your Bullizard code: \d{6}$/);
    } finally {
      h.messenger.send = orig;
    }
  });
});

describe('§9.5 chat "Not sent" follows the server action', () => {
  it('the WebSocket error carries details.action, and the web shows the matching line', async () => {
    const seller = await makeUser(h, { tier: 2 });
    const buyer = await makeUser(h);
    const offer = await makeOffer(seller, { categorySlug: 'currency', deliveryMode: 'manual', stock: 3 });
    const order = await buyAndPay(h, buyer, offer.id);
    const room = (await buyer.api.get(`/v1/orders/${order.id}`)).body.room_id as string;
    const frame = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: buyer.token })));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'ready') ws.send(JSON.stringify({ type: 'message', roomId: room, body: 'my telegram is @trader23f', clientMsgId: 'c1' }));
        if (m.type === 'error') {
          ws.close();
          resolve(m);
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('no error frame')), 5_000);
    });
    expect(frame.code).toBe('offplatform_blocked');
    expect(['queue', 'ban']).toContain(frame.details?.action);
    const rest = await seller.api.post(`/v1/chat/rooms/${room}/messages`, { body: 'text me on whatsapp +44 7700 900123' }); // the buyer may be banned by now
    expect(rest.status).toBe(422);
    expect(['queue', 'ban']).toContain(rest.body.error.details.action);
    const web = await import('../../web/src/lib/chatBlocked.ts');
    expect(web.blockedNoticeKeys(web.blockedAction({ code: 'offplatform_blocked', details: { action: 'queue' } }))).toEqual(['chat.blocked.queue']);
    expect(web.blockedNoticeKeys(web.blockedAction({ code: 'offplatform_blocked', details: { action: 'ban' } }))).toEqual(['chat.blocked.ban']);
    expect(web.blockedNoticeKeys(web.blockedAction({ code: 'offplatform_blocked' }))).toEqual(['chat.notSent', 'chat.bannable']);
  });
});

describe('§9.2 / §9.8 web error display and keys', () => {
  it('err.<code> wins over the 429 and 5xx fallbacks; every §9 key exists in all six languages', async () => {
    const { errorMessage } = await import('../../web/src/api.ts');
    expect(errorMessage(429, 'account_locked', 'x')).toBe('Too many wrong tries, so sign-in is paused for a while. Reset your password to get in now.');
    expect(errorMessage(503, 'scanner_unavailable', 'x')).toBe('Uploads are paused for a moment while our file scan restarts. Try again in a minute.');
    expect(errorMessage(429, 'too_many_requests', 'x')).toBe(errorMessage(429, 'rate_limited_unknown', 'x'));
    const keys = [
      'auth.newsOptIn', 'auth.newsOptIn.hint', 'account.newsletter.title', 'account.newsletter.toggle', 'account.newsletter.hint', 'account.newsletter.saved',
      'auth.botCheck', 'err.captcha_required', 'err.captcha_failed', 'auth.botCheckExpired', 'err.invalid_credentials', 'err.session_expired', 'err.reauth_required', 'err.wrong_current_password', 'err.account_locked', 'auth.resetSent',
      'upload.videoTooLarge', 'err.file_too_large', 'err.direct_upload_unavailable', 'err.malware_detected', 'err.scanner_unavailable', 'err.upload_missing', 'upload.uploading', 'upload.scanning',
      'err.balance_remaining', 'err.open_orders', 'err.balance_owed', 'account.data.before',
      'chat.notSent', 'chat.blocked.queue', 'chat.blocked.ban', 'chat.ev.account_suspended_offplatform', 'chat.ev.account_banned_offplatform', 'chat.ev.security_review', 'mod.inReview', 'mod.inReviewHint',
      'err.unsupported_coin', 'err.unsupported_currency', 'money.payoutAddress.coinHint', 'money.payoutAddress.cleared',
    ];
    const en = (await import('../../web/src/i18n/en.ts')).default as Record<string, string>;
    for (const k of keys) expect(en[k], k).toBeTruthy();
    for (const loc of ['ar', 'es', 'fr', 'de', 'pt']) {
      const site = (await import(`../../web/src/i18n/${loc}.ts`)).default as Record<string, string>;
      const seller = (await import(`../../web/src/i18n/${loc}.seller.ts`)).default as Record<string, string>;
      for (const k of keys) expect(site[k] ?? seller[k], `${loc}:${k}`).toBeTruthy();
    }
    const ar = (await import('../../web/src/i18n/ar.ts')).default as Record<string, string>;
    expect(ar['chat.blocked.ban']).toBe('لم تُرسَل. تم حظر حسابك بسبب مشاركة وسائل تواصل خارجية. تظن أننا أخطأنا؟ راسل support@bullizard.com.');
    expect(en['upload.videoTooLarge']).toContain('{maxMb}');
  });
});
