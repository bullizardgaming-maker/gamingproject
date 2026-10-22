import { expect, test } from '@playwright/test';
import { buy, signIn } from './helpers';

test.describe('safety and moderation', () => {
  test('chat warns before sending contact details', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-2');
    const box = page.getByLabel('Message', { exact: true });
    await box.fill('thanks, all good');
    await expect(page.getByRole('status').filter({ hasText: /outside Bullizard/ })).toHaveCount(0);
    await box.fill('add me on telegram, I pay with paypal');
    await expect(page.getByText(/looks like contact details or a payment method outside Bullizard/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send anyway' })).toBeVisible();
  });

  test('a listing with a review term waits for a moderator', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    await page.locator('select[name=categorySlug]').selectOption('items');
    await page.locator('input[name=game]').fill('Counter-Strike 2');
    await page.locator('input[name=title]').fill('Wallhack-proof crosshair pack');
    await page.locator('input[name=price]').fill('3');
    await page.getByRole('button', { name: 'Create listing' }).click();
    await expect(page.getByText('In review').first()).toBeVisible();
    await page.locator('input[name=game]').fill('Counter-Strike 2');
    await page.locator('input[name=title]').fill('Carding guide');
    await page.locator('input[name=price]').fill('3');
    await page.getByRole('button', { name: 'Create listing' }).click();
    await expect(page.getByText(/prohibited goods/)).toBeVisible();
  });

  test('staff approve listings, dismiss flags and edit terms', async ({ page }) => {
    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Moderation' }).click();
    await expect(page.getByText('CS2 rage config with aimbot settings, undetected')).toBeVisible();
    await expect(page.getByText('contact: discord')).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).first().click();
    await expect(page.getByText('No listings waiting.')).toBeVisible();

    await page.getByRole('button', { name: /Flagged chats/ }).click();
    await expect(page.getByText(/My whatsapp is \+44 7700 900456/)).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(page.getByText('Nothing here.')).toBeVisible();
    await page.getByRole('button', { name: 'Dismissed' }).click();
    await expect(page.getByText(/My whatsapp is/)).toBeVisible();

    await page.getByRole('button', { name: 'Terms', exact: true }).click();
    await page.getByLabel('Term').fill('account sharing');
    await page.getByRole('button', { name: 'Add term' }).click();
    await expect(page.getByText('account sharing')).toBeVisible();
    await page.getByRole('button', { name: 'Remove account sharing' }).click();
    await expect(page.getByText('account sharing')).toHaveCount(0);
  });
});
