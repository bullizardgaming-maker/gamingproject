import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('seller trust levels', () => {
  test('badges show on listings and shops, and the market sorts by trust', async ({ page }) => {
    await page.goto('/sellers/u-sell5-0000-4000-8000-000000000007');
    await expect(page.getByText('Top seller').first()).toBeVisible();
    await page.goto('/market?sort=trust');
    await expect(page.getByText('Top seller').first()).toBeVisible();
  });

  test('a seller sees their level and what the next one needs', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    await expect(page.getByText('Your trust level')).toBeVisible();
    await expect(page.getByText('To reach Top seller:')).toBeVisible();
    await expect(page.getByText(/1,?000\+ completed sales/)).toBeVisible();
  });
});
