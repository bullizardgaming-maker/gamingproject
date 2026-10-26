import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, makeUser, setup, type Harness } from './helpers.js';
import { TEMPLATES, dispatchEmails, notify, render, type TemplateName } from '../src/domain/notifications.js';
import { PACKS } from '../src/domain/locales/index.js';
import { TEMPLATE_DATA } from './fixtures/template-data.js';

let h: Harness;
const sent: Array<{ to: string; subject?: string; body: string; html?: string }> = [];
beforeAll(async () => {
  h = await setup();
  const orig = h.messenger.send.bind(h.messenger);
  h.messenger.send = async (m: any) => {
    sent.push(m);
    return orig(m);
  };
});
afterAll(async () => h.close());

describe('messages in the user’s language', () => {
  it('stores the language at sign-up and when the user switches', async () => {
    const res = await client(h.app).post('/v1/auth/register', { email: `ar_${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'Layla', acceptTerms: true, locale: 'ar' });
    expect(res.status).toBe(201);
    expect(res.body.user.locale).toBe('ar');
    const u = await makeUser(h);
    expect((await u.api.get('/v1/me')).body.user.locale).toBe('en');
    expect((await u.api.put('/v1/me/locale', { locale: 'de' })).body).toEqual({ locale: 'de' });
    expect((await u.api.get('/v1/me')).body.user.locale).toBe('de');
    expect((await u.api.put('/v1/me/locale', { locale: 'xx' })).status).toBe(400);
  });

  it('sends emails and inbox items in that language, and staff alerts stay English', async () => {
    const u = await makeUser(h);
    await u.api.put('/v1/me/locale', { locale: 'ar' });
    await notify(h.ctx.db, u.id, 'order_paid', { title: 'Elden Ring key', amount_cents: 32_49, currency: 'USD', order_id: '00000000-0000-4000-8000-000000000001' });
    const inbox = (await u.api.get('/v1/me/notifications')).body.items;
    expect(inbox[0].title).toBe('وصل الدفع. Elden Ring key عند البائع');
    expect(inbox[0].body).toContain('$32.49'); // Latin prices inside Arabic text

    await dispatchEmails(h.ctx);
    const mail = sent.find((m) => m.to === u.email && !/جاهز/.test(m.subject ?? ''))!; // the welcome email comes first
    expect(mail.subject).toBe('وصل الدفع. Elden Ring key عند البائع');
    expect(mail.body).toContain('— فريق Bullizard');
    expect(mail.html).toContain('dir="rtl"');

    const fr = render(h.ctx, 'clawback', { title: 'Clé', amount_cents: 10_00, currency: 'EUR', order_id: 'x', reason: 'r', credit_note: 'CN-1' }, 'fr');
    expect(fr.subject).toBe('Remboursement après versement : Clé');
    expect(fr.text).toMatch(/10,00\s€/); // French puts a narrow no-break space before the symbol
    expect(render(h.ctx, 'reconciliation_alert', { status: 'failed', issues: 1, started_at: 'today', summary: ['x'] }, 'fr').subject).toMatch(/^Reconciliation/);
  });

  it('sends verification codes in that language', async () => {
    const u = await makeUser(h, { tier: 0 });
    await u.api.put('/v1/me/locale', { locale: 'es' });
    await u.api.post('/v1/verify/email/send');
    expect(sent.at(-1)!.body).toMatch(/^Tu código de verificación es \d{6}/);
  });

  it('every translated template renders with realistic data in every language', () => {
    for (const [locale, pack] of Object.entries(PACKS)) {
      for (const name of Object.keys(pack.templates) as TemplateName[]) {
        expect(TEMPLATES[name], `${locale}:${name} is not a real template`).toBeTruthy();
        const r = render(h.ctx, name, TEMPLATE_DATA, locale as any);
        expect(r.subject.length, `${locale}:${name}`).toBeGreaterThan(3);
        expect(r.text).not.toContain('undefined');
      }
    }
  });
});
