import { expect, test } from '@playwright/test';

/** Round 24 §6: no phone anywhere. Sign up, verify the email, and the account is level 1: buy and start selling. */
test('a new account reaches level 1 with a verified email only: no phone step anywhere', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign up, it’s free!' }).click();
  await page.locator('input[name=displayName]').fill('No Phone Trader');
  await page.locator('input[name=email]').fill(`nophone-${Date.now()}@example.com`);
  await page.locator('input[name=password]').fill('correct horse battery');
  await page.getByRole('checkbox', { name: /18 or older/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account/);

  await expect(page.getByText('Level 1 · verified email · buy and sell')).toBeVisible();
  // No phone step (the demo's push-notification note mentions phones as devices, which is fine).
  await expect(page.getByText(/phone number|verify (your )?phone|phone (code|verification)/i)).toHaveCount(0);
  await expect(page.getByPlaceholder('+14155550123')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByPlaceholder('Demo code: 123456').fill('123456');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByText('Email verified.')).toBeVisible();
  await expect(page.getByText(/Level 1 of 2/)).toBeVisible();

  // Selling: straight to the rules test (no "verify email and phone" gate).
  await page.goto('/sell');
  await expect(page.getByText(/verify email and phone|verify your email/i)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Sell on the marketplace' })).toBeVisible();
  await expect(page.getByText(/One step before your first offer/)).toBeVisible();
  // No phone step (the demo's push-notification note mentions phones as devices, which is fine).
  await expect(page.getByText(/phone number|verify (your )?phone|phone (code|verification)/i)).toHaveCount(0);
});
