import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('a seller sees the buyer’s reputation, rates them, and the buyer sees their own', async ({ page }) => {
  await signIn(page, 'Buyer'); // gives the demo buyer an order history, including a completed order from the demo seller
  await signIn(page, 'Seller');
  await page.goto('/orders?as=seller');
  await page.getByRole('link', { name: /Elden Ring/ }).first().click();
  await page.waitForURL(/\/orders\/[^/]+$/);

  const card = page.locator('section', { has: page.getByRole('heading', { name: 'About the buyer' }) });
  await expect(card.getByText('Good buyer', { exact: true })).toBeVisible();
  await expect(card.getByText('90% positive from 10 seller ratings')).toBeVisible();
  await expect(card.getByText('Disputes lost: 0 of 0')).toBeVisible();

  await card.getByRole('radio', { name: /Good buyer/ }).click();
  await expect(card.getByLabel('Rude')).toHaveCount(0); // only tags that fit the verdict
  await card.getByLabel('Patient').check();
  await card.getByRole('button', { name: 'Rate buyer' }).click();
  await expect(card.getByText('You rated this buyer positive: Patient.')).toBeVisible();
  await expect(card.getByText('91% positive from 11 seller ratings')).toBeVisible();

  await signIn(page, 'Buyer');
  await page.goto('/account');
  const mine = page.locator('section', { has: page.getByRole('heading', { name: 'Your buyer reputation' }) });
  await expect(mine.getByText('91% positive from 11 seller ratings')).toBeVisible();
  await expect(mine.getByText('Confirmed quickly ×6')).toBeVisible();
});
