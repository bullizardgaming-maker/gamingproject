import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('save a game search, get a digest and manage it on the watchlist', async ({ page }) => {
  await signIn(page, 'Buyer');
  await page.goto('/market?game=World+of+Warcraft&category=currency'); // the game page no longer has it (Round 24)
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible(); // signed in before saving
  await page.getByRole('button', { name: 'Save this search' }).click();
  await expect(page.getByText('Saved. We’ll send you new listings daily.')).toBeVisible();
  await page.goto('/watchlist');
  await expect(page.getByRole('link', { name: 'Currency' })).toHaveAttribute('href', /game=World\+of\+Warcraft/);
  await page.getByLabel('How often').selectOption('hourly');
  await expect(page.getByLabel('How often')).toHaveValue('hourly');
  await page.getByRole('button', { name: 'Delete Currency' }).click();
  await expect(page.getByText(/No saved searches yet/)).toBeVisible();
});
