import { expect, test } from '@playwright/test';
import { buy, signIn, startOffer, publishOffer } from './helpers';

test.describe('bundles', () => {
  test('a buyer sees what is inside and gets every part delivered', async ({ page }) => {
    await page.goto('/offers/offer-bundle-1');
    await expect(page.getByText('In this bundle')).toBeVisible();
    await expect(page.getByText('Separately $80.41: you save $8.40')).toBeVisible();
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-bundle-1');
    await expect(page.getByTestId('order-card')).toContainText('Delivered');
  });

  test('a seller builds a bundle from their instant listings', async ({ page }) => {
    await signIn(page, 'Seller');
    await startOffer(page, 'keys', 'Valorant');
    await page.locator('input[name=title]').fill('VP + skin code starter pack');
    await page.locator('input[name=price]').fill('70');
    await page.getByLabel('Make this a bundle of my instant listings').check();
    // Scoped to the new-listing form: the shop-page editor lists the same titles for pinning.
    const form = page.locator('form', { has: page.locator('input[name=title]') });
    await form.getByRole('checkbox', { name: /5,350 VP — NA region code/ }).check();
    await form.getByRole('checkbox', { name: /Galaxy Scout skin code/ }).check();
    await publishOffer(page);
    await expect(page.getByRole('row', { name: /VP \+ skin code starter pack/ }).getByText('Bundle')).toBeVisible();
  });
});
