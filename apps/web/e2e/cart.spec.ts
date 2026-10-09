import { expect, test } from '@playwright/test';
import { signIn, watchErrors } from './helpers';

test.describe('cart', () => {
  test('pays listings from two sellers in one checkout, one escrow order each', async ({ page }) => {
    const done = watchErrors(page);
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-1');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText('Added to your cart.')).toBeVisible();
    await page.goto('/offers/offer-2');
    await page.getByLabel('Quantity').fill('2');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByRole('link', { name: 'Cart, 3 items' })).toBeVisible();

    await page.getByRole('link', { name: 'Cart, 3 items' }).click();
    await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
    await expect(page.getByText('Elden Ring — Steam key (Global)')).toBeVisible();
    await expect(page.getByText('Baldur’s Gate 3 — Steam key (EU)')).toBeVisible();
    await expect(page.getByText(/split into 2 escrow orders/)).toBeVisible();
    // $32.49 + 2 × $41.99
    await expect(page.getByText('$116.47').first()).toBeVisible();
    await page.getByLabel(/I accept the Terms of Service/).check();
    await page.getByRole('button', { name: 'Pay $116.47 into escrow' }).click();
    await page.waitForURL(/demo-checkout\/cart-/);
    await page.getByRole('button', { name: /^Pay / }).click();
    await page.waitForURL(/\/orders/);
    await expect(page.getByText('Elden Ring — Steam key (Global)').first()).toBeVisible();
    await expect(page.getByText('Baldur’s Gate 3 — Steam key (EU)').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cart, 0 items' })).toBeVisible();
    done();
  });

  test('shows an empty cart and works signed out', async ({ page }) => {
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible();
    await page.goto('/offers/offer-1');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await page.goto('/cart');
    await expect(page.getByRole('link', { name: 'Sign in to buy' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible();
  });
});
