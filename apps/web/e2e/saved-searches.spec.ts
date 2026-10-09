import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('save a game search, get a digest and manage it on the watchlist', async ({ page }) => {
  await signIn(page, 'Buyer');
  await page.goto('/games/world-of-warcraft/currency');
  await page.getByRole('button', { name: 'Save this search' }).click();
  await expect(page.getByText('Saved. We’ll send you new listings daily.')).toBeVisible();
  await page.goto('/watchlist');
  await expect(page.getByRole('link', { name: /World of Warcraft · / })).toBeVisible();
  await page.getByLabel('How often').selectOption('hourly');
  await expect(page.getByLabel('How often')).toHaveValue('hourly');
  await page.getByRole('button', { name: /^Delete World of Warcraft/ }).click();
  await expect(page.getByText(/No saved searches yet/)).toBeVisible();
});
