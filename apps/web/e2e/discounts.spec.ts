import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('seller discounts', () => {
  test('a running sale shows the old price crossed out', async ({ page }) => {
    await page.goto('/offers/offer-3');
    await expect(page.getByText('$29.90').first()).toBeVisible();
    await expect(page.locator('.line-through', { hasText: '$38.90' })).toBeVisible();
    await expect(page.getByText(/Sale ends/)).toBeVisible();
  });

  test('a buyer applies a seller code at checkout', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-1');
    await page.getByLabel('Seller discount code').fill('northwind10');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('NORTHWIND10 applied: $3.24 off')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pay $29.25 into escrow' })).toBeVisible();
    await page.getByLabel('Seller discount code').fill('NOPE');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('That code isn’t valid for this seller')).toBeVisible();
  });

  test('a seller starts a sale and creates a code', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    const row = page.getByRole('row', { name: /Elden Ring — Steam key/ });
    await row.getByRole('button', { name: 'Sale' }).click();
    await page.getByLabel('Sale price (USD)').fill('25');
    await page.getByRole('button', { name: 'Start sale' }).click();
    await expect(page.getByText(/Sale \$25\.00 until/)).toBeVisible();
    await page.getByLabel('Code', { exact: true }).fill('WEEKEND15');
    await page.getByLabel('% off').fill('15');
    await page.getByRole('button', { name: 'Create code' }).click();
    await expect(page.getByRole('cell', { name: 'WEEKEND15' })).toBeVisible();
    await page.goto('/offers/offer-1');
    await expect(page.getByText('$25.00').first()).toBeVisible();
  });
});
