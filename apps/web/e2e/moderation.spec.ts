import { expect, test } from '@playwright/test';
import { buy, signIn, startOffer } from './helpers';

test.describe('safety and moderation', () => {
  test('chat warns before sending contact details', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-2');
    const box = page.getByLabel('Message', { exact: true });
    await box.fill('thanks, all good');
    await expect(page.getByRole('status').filter({ hasText: /outside Bullizard/ })).toHaveCount(0);
    await box.fill('add me on telegram, I pay with paypal');
    await expect(page.getByRole('status').filter({ hasText: /Sharing outside contacts can get your account banned right away/ })).toBeVisible();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Not sent.')).toBeVisible();
    await expect(page.getByRole('log').getByText('add me on telegram')).toHaveCount(0);
  });

  test('a listing with a review term waits for a moderator', async ({ page }) => {
    await signIn(page, 'Seller');
    await startOffer(page, 'items', 'Counter-Strike 2');
    await page.locator('input[name=title]').fill('Wallhack-proof crosshair pack');
    await page.locator('input[name=price]').fill('3');
    await page.getByRole('button', { name: 'Publish offer' }).click();
    await expect(page.getByText('In review').first()).toBeVisible();
    await startOffer(page, 'items', 'Counter-Strike 2');
    await page.locator('input[name=title]').fill('Carding guide');
    await page.locator('input[name=price]').fill('3');
    await page.getByRole('button', { name: 'Publish offer' }).click();
    await expect(page.getByText('This offer breaks the rules on what can be sold.')).toBeVisible(); // err.listing_blocked (copy deck §2.13)
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
