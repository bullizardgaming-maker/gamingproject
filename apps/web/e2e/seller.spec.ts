import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('seller', () => {
  test('creates a listing with game-specific fields that buyers can filter by', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    await page.locator('select[name=categorySlug]').selectOption('boosting');
    await page.locator('input[name=game]').fill('League of Legends');
    await page.locator('input[name=title]').fill('Silver → Gold in 3 days');
    await page.locator('input[name=price]').fill('25');
    await page.locator('select[name=deliveryMode]').selectOption('manual');
    await page.locator('select[name="attr.server"]').selectOption('KR');
    await page.locator('select[name="attr.rank_from"]').selectOption('Silver');
    await page.locator('select[name="attr.rank_to"]').selectOption('Gold');
    await page.getByRole('button', { name: 'Create listing' }).click();
    await expect(page.getByText('Silver → Gold in 3 days').first()).toBeVisible();
    await page.goto('/games/league-of-legends/boosting?attr.server=KR');
    await expect(page.getByText('Silver → Gold in 3 days')).toBeVisible();
  });

  test('analytics tab shows KPIs and switches period', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell/analytics');
    await expect(page.getByText('Sales per day', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Listing views', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '12 months' }).click();
    await expect(page.getByText('Sales per week', { exact: true }).first()).toBeVisible();
  });

  test('money page: invoice PDF and withdrawal', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell/money');
    await expect(page.getByRole('heading', { name: 'Commission invoices' })).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF' }).first().click()]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    await page.getByRole('button', { name: /^Withdraw \$/ }).click();
    await expect(page.getByText(/on its way to your bank/).first()).toBeVisible();
  });
});
