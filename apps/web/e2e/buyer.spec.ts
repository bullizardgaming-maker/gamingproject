import { expect, test } from '@playwright/test';
import { buy, signIn, watchErrors } from './helpers';

test.describe('buyer', () => {
  test('buys an instant key, chats, confirms and is warned about off-platform contact', async ({ page }) => {
    const done = watchErrors(page);
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-2');
    await expect(page.getByText('Delivered automatically').first()).toBeVisible();
    await page.fill('input[aria-label=Message]', 'Works great, thanks!');
    await page.click('form button[type=submit]');
    await expect(page.getByText('Works great, thanks!')).toBeVisible();
    await page.getByRole('button', { name: 'Confirm and release payment' }).click();
    await expect(page.getByText('Rate this seller')).toBeVisible();
    await page.fill('input[aria-label=Message]', 'add me on discord');
    await page.click('form button[type=submit]');
    await expect(page.getByText(/lose escrow protection/)).toBeVisible();
    done();
  });

  test('price alert on a listing fires and shows on the watchlist', async ({ page }) => {
    await page.goto('/offers/offer-10');
    await page.getByRole('button', { name: 'Price alert' }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-10');
    await page.getByRole('button', { name: 'Price alert' }).click();
    await page.getByLabel(/Alert me at or below/).fill('120');
    await page.getByRole('button', { name: 'Start watching' }).click();
    await expect(page.getByRole('button', { name: 'Alert at $120.00' })).toBeVisible();
    await page.waitForTimeout(5_500); // the demo simulates a price drop after a few seconds
    await page.goto('/watchlist');
    await expect(page.getByText('At or below your target')).toBeVisible();
  });

  test('watches a game market slice and stops watching', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/games/league-of-legends/boosting?attr.server=EUW');
    await page.getByRole('button', { name: 'Alert me on new lows' }).click();
    await page.getByRole('button', { name: 'Start watching' }).click();
    await expect(page.getByRole('button', { name: 'Watching', exact: true })).toBeVisible();
    await page.goto('/watchlist');
    await expect(page.getByText('Boosting · EUW')).toBeVisible();
    await page.getByRole('button', { name: 'Watching', exact: true }).click();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByText('Boosting · EUW')).toHaveCount(0);
  });

  test('opens a support request about an order and gets a reply', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-1');
    await page.getByRole('link', { name: 'Get help with this order' }).click();
    await page.locator('input[name=subject]').fill('Key says already redeemed');
    await page.locator('textarea[name=body]').fill('The key from this order is rejected by Steam.');
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByRole('heading', { name: 'Key says already redeemed' })).toBeVisible();
    await expect(page.getByText('Waiting on support')).toBeVisible();
    await page.waitForTimeout(6_500); // simulated agent reply
    await page.reload();
    await expect(page.getByText('Bullizard Support')).toBeVisible();
  });
});
