import { expect, test } from '@playwright/test';
import { signIn, startOffer } from './helpers';

test.describe('seller side', () => {
  test('a seller lists currency with a 6-decimal unit price and volume discounts, and picks the badges buyers see', async ({ page }) => {
    await signIn(page, 'Seller');
    // Round 25: Create offer is its own page; the currency form has only server, stock, unit price, discounts,
    // delivery methods and delivery time. No "established buyers only".
    await startOffer(page, 'currency', 'Albion Online');
    await expect(page.getByText(/established buyers/i)).toHaveCount(0);
    await expect(page.locator('input[name=title]')).toHaveCount(0);
    await page.locator('select[name="attr.server"]').selectOption('Europe');
    await page.locator('input[name=stock]').fill('50000000');
    await page.locator('input[name=unitPrice]').fill('0.000123');
    await page.locator('input[name=unitPrice]').blur();
    await expect(page.locator('input[name=unitPrice]')).toHaveValue('0.000123');
    await page.getByRole('button', { name: 'Add discount' }).click();
    await page.getByLabel('Discount 1: from quantity').fill('20000000');
    await page.getByLabel('Discount 1: percent off').fill('5');
    await page.getByLabel('Market order').uncheck();
    await page.locator('select[name=deliveryTime]').selectOption('15m');
    await page.getByRole('button', { name: 'Publish offer' }).click();
    await expect(page.getByText('Your offer is live.')).toBeVisible();
    await page.goto('/games/albion-online/currency');
    await page.getByRole('button', { name: /Europe/ }).click(); // the server is picked first (Round 24)
    const row = page.locator('.cl-row').filter({ hasText: 'NorthWind' }).filter({ hasText: '15 min' });
    await expect(row).toBeVisible();
    await row.locator('a').first().click();
    // The buyer sees this seller's delivery methods and time, the unit price and the volume discount.
    await expect(page.locator('.of-rows')).toContainText('15 min');
    await expect(page.locator('.of-methods')).toContainText('Face to face');
    await expect(page.locator('.of-methods')).not.toContainText('Market order');
    await expect(page.getByRole('button', { name: /20,000,000\+ · 5% off/ })).toBeVisible();
    await page.goto('/sellers/u-sell1-0000-4000-8000-000000000002');
    await page.getByRole('button', { name: 'Edit shop' }).click();

    const picker = page.locator('.badge-pick');
    const on = picker.locator('.badge-opt[aria-pressed="true"]');
    await expect(on.first()).toBeVisible();
    const before = await on.count();
    await on.first().click();
    await expect(on).toHaveCount(before - 1);
  });
});
