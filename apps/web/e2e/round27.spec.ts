import { expect, test } from '@playwright/test';
import { buy, signIn } from './helpers';

const SELLER_ID = 'u-sell1-0000-4000-8000-000000000002';

test.describe('Round 27: staging test fixes', () => {
  test('a paid order is never stuck on "confirming": the crypto box gives way to the paid order', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-7'); // ends on the order page once the checkout is gone
    await expect(page.locator('.crypto-checkout')).toHaveCount(0);
    await expect(page.getByTestId('pay-confirming')).toHaveCount(0);
    await expect(page.locator('.od-line li').first()).toHaveClass(/done/);
  });

  test('timeline: the current step is yellow; red with a reason only under security review, actions disabled not gone', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-12');
    const orderUrl = page.url();
    const orderId = orderUrl.split('/orders/')[1]!.split(/[?#]/)[0]!;
    // Normal: the current step is "now" (yellow), nothing red, no review note.
    await expect(page.locator('.od-line li.now')).toHaveCount(1);
    await expect(page.locator('.od-line li.stop')).toHaveCount(0);
    await expect(page.getByTestId('under-review')).toHaveCount(0);

    // Staff freeze the order for a security review.
    await page.addInitScript((id) => {
      const raw = localStorage.getItem('bz.demo.v29');
      if (!raw) return;
      const s = JSON.parse(raw);
      const o = s.orders.find((x: { id: string }) => x.id === id);
      if (o) o.escrow_frozen = true;
      localStorage.setItem('bz.demo.v29', JSON.stringify(s));
    }, orderId);
    await page.reload();
    await expect(page.getByTestId('under-review')).toHaveText('Under security review — staff will clear it shortly');
    await expect(page.locator('.od-line li.stop')).toHaveCount(1);
    const confirm = page.getByRole('button', { name: 'Confirm and release payment' });
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAccessibleDescription('Under security review — staff will clear it shortly');

    await signIn(page, 'Seller');
    await page.goto(orderUrl);
    await expect(page.getByTestId('under-review')).toBeVisible();
    const deliver = page.getByRole('button', { name: /Mark as delivered|Mark delivered/ });
    await expect(deliver).toBeDisabled();
    await expect(deliver).toHaveAccessibleDescription('Under security review — staff will clear it shortly');
  });

  test('signed-in users never see /login or /signup', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/login?next=/orders');
    await expect(page).toHaveURL(/\/orders$/);
    await page.goto('/signup');
    await expect(page).not.toHaveURL(/\/signup/);
    await expect(page.getByRole('heading', { name: /Sign in to Bullizard|Create your account/ })).toHaveCount(0);
    // Reached from inside the app: back where they came from.
    await page.goto('/wallet');
    await page.evaluate(() => (history.pushState({ usr: null, key: 'e2e', idx: (history.state?.idx ?? 0) + 1 }, '', '/login'), dispatchEvent(new PopStateEvent('popstate'))));
    await expect(page).toHaveURL(/\/wallet$/);
  });

  test('a new payout address is confirmed on its own page with the emailed code', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell/money');
    const card = page.locator('#payout-address');
    await card.getByLabel('Address').fill('TXYZabcdefghijk1234567890');
    await card.getByRole('button', { name: 'Use this address' }).click();
    await expect(page).toHaveURL(/\/sell\/payout-address\/confirm/);
    await expect(page.getByRole('heading', { name: 'Confirm your payout address' })).toBeVisible();
    await expect(page.getByText('We sent a code to your email to confirm your payout address — this protects your money.')).toBeVisible();
    await expect(page.getByTestId('pa27-address')).toContainText('TXYZabcdefghijk1234567890');
    await page.getByLabel('Code from the email').fill('000000');
    await page.getByRole('button', { name: 'Confirm address' }).click();
    await expect(page.getByRole('alert')).toContainText('That code isn’t right');
    await page.getByLabel('Code from the email').fill('123456');
    await page.getByRole('button', { name: 'Confirm address' }).click();
    await expect(page).toHaveURL(/\/sell\/money$/);
    await expect(page.getByText('Payout address confirmed.')).toBeVisible();
    await expect(card).toContainText('TXYZabcdefghijk1234567890');
  });

  test('the seller profile shows stars, positive %, the review count and recent reviews', async ({ page }) => {
    await page.goto(`/sellers/${SELLER_ID}`);
    const rating = page.getByTestId('sp-rating');
    await expect(rating.getByRole('img', { name: /out of 5/ })).toBeVisible();
    await expect(rating).toContainText(/\d+ reviews/);
    await expect(page.getByText('Positive')).toBeVisible();
    const recent = page.getByTestId('sp-recent');
    await expect(recent.getByRole('heading', { name: 'Recent reviews' })).toBeVisible();
    expect(await recent.locator('.sp-review').count()).toBeGreaterThan(0);
    await recent.getByRole('button', { name: /All \d+ reviews/ }).click();
    await expect(page.getByRole('tab', { name: /Reviews/ })).toHaveAttribute('aria-selected', 'true');
  });
});
