import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('seller side', () => {
  test('a seller lists currency by amount and picks the badges buyers see', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    const form = page.locator('#create-offer');
    await form.locator('select[name=categorySlug]').selectOption('currency');
    await form.locator('input[name=game]').fill('Albion Online');
    await form.locator('input[name=title]').fill('Silver by the million');
    await form.locator('input[name=unitLabel]').fill('M');
    await form.locator('input[name=price]').fill('0.25');
    await form.locator('select[name=deliveryMode]').selectOption('manual');
    await form.locator('input[name=stock]').fill('500');
    await form.locator('input[name=minQty]').fill('20');
    await form.locator('select[name="attr.server"]').selectOption('Europe');
    await page.getByRole('button', { name: 'Publish offer' }).click();
    await expect(page.getByText('Silver by the million').first()).toBeVisible();
    await page.goto('/games/albion-online/currency');
    await page.getByRole('button', { name: /Europe/ }).click(); // the server is picked first (Round 24)
    await expect(page.locator('.cl-row').filter({ hasText: 'Min. 20' }).first()).toBeVisible(); // plain numbers, the unit is in the price
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
