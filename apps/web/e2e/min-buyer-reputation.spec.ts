import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('high-value listings can be limited to established buyers', async ({ page }) => {
  // The seeded Fortnite account carries the badge; the demo buyer (11 completed orders) may buy it.
  await signIn(page, 'Buyer');
  await page.goto('/offers/offer-11'); // Fortnite OG account, $420
  await expect(page.getByText('Established buyers only').first()).toBeVisible();

  // A seller can opt in only on listings of $100 or more.
  await signIn(page, 'Seller');
  await page.goto('/sell');
  await page.locator('select[name=categorySlug]').selectOption('currency');
  await page.locator('input[name=game]').fill('Albion Online');
  await page.locator('input[name=title]').fill('Small gold pack, 10k');
  await page.locator('input[name=price]').fill('20');
  await page.locator('select[name=deliveryMode]').selectOption('manual');
  await page.locator('select[name="attr.server"]').selectOption('Europe');
  await page.getByLabel('Established buyers only').check();
  await page.getByRole('button', { name: 'Publish offer' }).click();
  await expect(page.getByRole('alert')).toContainText('100 or more');

  await page.locator('input[name=title]').fill('Huge gold pack, 1M');
  await page.locator('input[name=price]').fill('250');
  await page.getByRole('button', { name: 'Publish offer' }).click();
  await expect(page.getByText('Huge gold pack, 1M').first()).toBeVisible();
  await page.goto('/games/albion-online/currency');
  await page.getByRole('button', { name: /Europe/ }).click(); // server first (Round 24)
  await page.getByRole('link', { name: /Huge gold pack, 1M/ }).first().click();
  await expect(page.getByText('Established buyers only').first()).toBeVisible();
});
