import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqLefDwAEJAHnZcOWyQAAAABJRU5ErkJggg==', 'base64');

test('boosting progress: the seller posts a milestone with a screenshot and the buyer follows it', async ({ page }) => {
  // The demo buyer's history includes a boosting order from the demo seller, 35% done.
  await signIn(page, 'Buyer');
  await page.goto('/orders');
  await page.getByRole('link', { name: /Gold IV → Platinum IV/ }).first().click();
  await page.waitForURL(/\/orders\/[^/]+$/);
  const order = new URL(page.url()).pathname;
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Progress' }) });
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
  await expect(card.getByText('Gold II now, 9 wins from 14 games')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Post update' })).toHaveCount(0); // buyers only read

  await signIn(page, 'Seller');
  await page.goto(order);
  // Progress can't go backwards.
  await card.getByLabel('Done (%)').fill('20');
  await card.getByRole('button', { name: 'Post update' }).click();
  expect(await card.getByLabel('Done (%)').evaluate((e: HTMLInputElement) => e.validity.rangeUnderflow)).toBe(true);
  await card.getByLabel('Done (%)').fill('70');
  await card.getByLabel('Note for the buyer').fill('Platinum IV reached');
  await card.locator('input[type=file]').setInputFiles({ name: 'rank.png', mimeType: 'image/png', buffer: PNG });
  await card.getByRole('button', { name: 'Post update' }).click();
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '70');
  await expect(page.getByText('Progress: 70% · Platinum IV reached (screenshot attached)')).toBeVisible();

  await signIn(page, 'Buyer');
  await page.goto(order);
  await expect(card.getByText('Platinum IV reached')).toBeVisible();
  await expect(card.getByRole('img', { name: 'Progress screenshot' })).toBeVisible();
  await page.getByRole('button', { name: /notifications/i }).first().click();
  await expect(page.getByText('70% done: Gold IV → Platinum IV, duo queue').first()).toBeVisible();
});
