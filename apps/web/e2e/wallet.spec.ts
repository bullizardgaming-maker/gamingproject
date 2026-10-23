import { expect, test } from '@playwright/test';
import { buy, signIn } from './helpers';

test.describe('wallet', () => {
  test('a buyer sees their balance and every order in one list', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/wallet');
    await expect(page.getByRole('heading', { name: /Balance/ })).toBeVisible();
    const table = page.getByRole('table', { name: 'History' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await expect(table.getByText(/order#/).first()).toBeVisible();
  });

  test('a buyer can confirm before the seller marks it delivered', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-52'); // Albion silver, delivered by hand in game
    await page.getByRole('button', { name: 'Got it · release payment' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('The seller is paid now and the order closes');
    await dialog.getByRole('button', { name: 'Yes, I received it' }).click();
    await expect(page.getByTestId('order-card').or(page.locator('.od-status')).first()).toContainText(/Completed|Released/);
  });
});
