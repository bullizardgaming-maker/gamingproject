import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Round 23f part B: copy deck §9 strings on the screens they belong to. */
test.describe('copy deck §9', () => {
  test('sign-up consent hint, wrong password, reset sent, account deletion note', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[name=email]').fill('buyer@demo.test');
    await page.locator('input[name=password]').fill('not-the-password');
    await page.locator('form button[type=submit]').click();
    await expect(page.getByRole('alert')).toHaveText('Wrong email or password.'); // err.invalid_credentials
    await page.getByRole('button', { name: 'Sign up, it’s free!' }).click();
    await expect(page.getByText('Optional. Turn it off any time in Account.')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Email me about new games and offers/ })).not.toBeChecked();
    await page.goto('/forgot-password');
    await page.locator('input[name=email]').fill('someone@example.com');
    await page.getByRole('button', { name: 'Email me a reset link' }).click();
    await expect(page.locator('.ok[role=status]')).toHaveText('If that email has an account, the reset link is on its way. Check spam too.');
    await signIn(page, 'Buyer');
    await page.goto('/account');
    await expect(page.getByText('Before you delete: finish open orders and withdraw your balance.')).toBeVisible();
    await expect(page.locator('.card', { has: page.getByRole('heading', { name: 'News and offers' }) }).getByRole('checkbox', { name: 'Email me about new games and offers' })).toBeVisible();
  });

  test('the payout coin hint is shown with the coin picker', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell/money');
    await expect(page.getByText('USDT only, on TRC-20 or BEP-20.')).toBeVisible();
  });
});
