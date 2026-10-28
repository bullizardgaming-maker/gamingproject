import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { payCrypto, signIn, signOut, watchErrors, buyNow } from './helpers';

/** Round 23a: newsletter consent, Cloudflare Turnstile on the auth forms only, the proof video size message. */

async function openSignUp(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
}
async function fillSignUp(page: Page, name: string) {
  await page.locator('input[name=displayName]').fill(name);
  await page.locator('input[name=email]').fill(`${name.toLowerCase().replace(/\W/g, '')}-${Date.now()}@example.com`);
  await page.locator('input[name=password]').fill('correct horse battery');
  await page.getByRole('checkbox', { name: /18 or older/ }).check();
}

test.describe('newsletter consent', () => {
  test('is unticked at sign-up, stored when ticked, and can be changed in Account', async ({ page }) => {
    await openSignUp(page);
    const news = page.getByRole('checkbox', { name: 'Email me about new games and offers' });
    await expect(news).not.toBeChecked();
    await fillSignUp(page, 'News Fan');
    await news.check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/account/);
    const setting = page.locator('.card', { has: page.getByRole('heading', { name: 'News and offers' }) }).getByRole('checkbox', { name: 'Email me about new games and offers' });
    await expect(setting).toBeChecked();
    await setting.uncheck();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.reload();
    await expect(page.locator('.card', { has: page.getByRole('heading', { name: 'News and offers' }) }).getByRole('checkbox')).not.toBeChecked();
  });

  test('left unticked, the account is not subscribed; the Arabic label is the agreed text', async ({ page }) => {
    await openSignUp(page);
    await fillSignUp(page, 'Quiet Fan');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/account/);
    await expect(page.locator('.card', { has: page.getByRole('heading', { name: 'News and offers' }) }).getByRole('checkbox')).not.toBeChecked();
    await signOut(page);
    await page.goto('/login');
    await page.getByLabel('Language', { exact: true }).first().selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl'); // the Arabic strings are in before the click
    await page.getByRole('button', { name: 'New here? Create an account' }).click(); // the auth chrome is English-only
    await expect(page.getByText(/راسلني عن الألعاب الجديدة والعروض\./)).toBeVisible();
  });
});

test.describe('Cloudflare Turnstile', () => {
  // The demo build has no site key and a CSP without Cloudflare; the test switches the widget on with Cloudflare's
  // test site key and serves a stand-in for api.js (no network), so the CSP is bypassed for these pages.
  test.use({ bypassCSP: true });
  const STUB = (autoSolve: boolean) => `
    window.turnstile = {
      render(el, opts) {
        el.setAttribute('data-sitekey', opts.sitekey);
        el.setAttribute('data-action', opts.action);
        ${autoSolve ? "setTimeout(() => opts.callback('XXXX.DUMMY.TOKEN.XXXX'), 30);" : ''}
        return 'w' + Math.random();
      },
      reset() {},
      remove() {},
    };`;
  async function withTurnstile(page: Page, autoSolve = true) {
    await page.addInitScript(() => localStorage.setItem('bz.demo.turnstile', '1x00000000000000000000AA'));
    await page.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({ contentType: 'text/javascript', body: STUB(autoSolve) }));
  }
  const turnstileScripts = (page: Page) => page.locator('script[src*="challenges.cloudflare.com"]');

  test('sign-up sends the token; the script is only on the auth pages and gone after leaving them', async ({ page }) => {
    const errors = watchErrors(page);
    await withTurnstile(page);
    await page.goto('/market');
    await expect(page.getByRole('heading', { name: 'Currency', exact: true })).toBeVisible(); // the market opens on game coins (Round 25)
    await expect(turnstileScripts(page)).toHaveCount(0); // not on ordinary pages

    await openSignUp(page);
    await expect(turnstileScripts(page)).toHaveCount(1);
    await expect(page.locator('.turnstile')).toHaveAttribute('data-sitekey', '1x00000000000000000000AA');
    await expect(page.locator('.turnstile')).toHaveAttribute('data-action', 'signup');
    await fillSignUp(page, 'Bot Checked');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/account/);
    await expect(page.getByRole('heading', { name: 'News and offers' })).toBeVisible();
    await expect(turnstileScripts(page)).toHaveCount(0); // full load after leaving the auth pages
    await expect.poll(() => page.evaluate(() => typeof (window as any).turnstile)).toBe('undefined');

    // A page that starts a payment never has it.
    await page.goto('/offers/offer-55');
    await expect(page.getByRole('button', { name: /Buy now/ })).toBeVisible();
    await expect(turnstileScripts(page)).toHaveCount(0);
    errors();
  });

  test('without a solved check, sign-in and password reset are refused with a translated message', async ({ page }) => {
    await withTurnstile(page, false);
    await page.goto('/login');
    await expect(page.locator('.turnstile')).toHaveAttribute('data-action', 'signin');
    await page.locator('input[name=email]').fill('buyer@demo.test');
    await page.locator('input[name=password]').fill('demo-password-123');
    await page.locator('form button[type=submit]').click();
    await expect(page.getByRole('alert')).toHaveText('Finish the quick check above first.');
    await page.goto('/forgot-password');
    await expect(page.locator('.turnstile')).toHaveAttribute('data-action', 'reset');
    await page.locator('input[name=email]').fill('buyer@demo.test');
    await page.getByRole('button', { name: 'Email me a reset link' }).click();
    await expect(page.getByRole('alert')).toHaveText('Finish the quick check above first.');
  });
});

test.describe('proof video size', () => {
  test('a video over 95 MB gets the translated limit before anything is uploaded', async ({ page }, info) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-55');
    await buyNow(page, 'Big_Video');
    await page.waitForURL(/\/orders\/.*pay=crypto/);
    await payCrypto(page);
    const orderUrl = page.url().split('?')[0]!;
    await signOut(page);
    await signIn(page, 'Seller');
    await page.goto(orderUrl);
    const big = info.outputPath('trade.mp4'); // sparse 96 MB file (Playwright takes buffers only up to 50 MB)
    mkdirSync(path.dirname(big), { recursive: true });
    writeFileSync(big, '');
    truncateSync(big, 96 * 1024 * 1024);
    await page.getByLabel(/Proof of delivery/).setInputFiles(big);
    await page.getByRole('button', { name: 'Mark as delivered' }).click();
    await expect(page.getByRole('alert')).toContainText('Videos can be up to 95 MB');
  });
});
