import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('seller discounts', () => {
  test('a running sale shows the old price crossed out', async ({ page }) => {
    await page.goto('/offers/offer-3');
    await expect(page.getByText('$29.90').first()).toBeVisible();
    await expect(page.locator('.line-through', { hasText: '$38.90' })).toBeVisible();
    await expect(page.getByText(/Sale ends/)).toBeVisible();
  });

  // Discount codes were removed by the owner (Oct 2026).
  test.skip('a buyer applies a seller code at checkout', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-1');
    await page.getByLabel('Seller discount code').fill('northwind10');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('NORTHWIND10 applied: $2.89 off')).toBeVisible(); // 10% of the seller's $28.92
    await expect(page.getByRole('button', { name: 'Buy now · $29.61' })).toBeVisible();
    await page.getByLabel('Seller discount code').fill('NOPE');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('That code isn’t valid for this seller')).toBeVisible();
  });
  // Round 25 (CEO): the Sale tool is removed from the seller's pages.
  test('the seller hub has no Sale button', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    await expect(page.getByRole('row', { name: /Elden Ring — Steam key/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sale', exact: true })).toHaveCount(0);
  });
});
