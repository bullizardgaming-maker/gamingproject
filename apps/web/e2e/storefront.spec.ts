import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

// A 1×1 PNG: enough to exercise the upload path.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqLefDwAEJAHnZcOWyQAAAABJRU5ErkJggg==', 'base64');

test('a seller customises their shop page and buyers see it', async ({ page }) => {
  await signIn(page, 'Seller');
  await page.goto('/sell');
  const editor = page.locator('section', { has: page.getByRole('heading', { name: 'Your shop page' }) });
  await expect(editor).toBeVisible();

  // Contact details are refused, like in listings.
  await editor.getByLabel('Intro').fill('DM me on telegram for cheaper keys');
  await editor.getByRole('button', { name: 'Save shop page' }).click();
  await expect(editor.getByRole('alert')).toContainText('Sharing outside contacts can get your account banned right away.');

  await editor.getByLabel('Intro').fill('Instant Steam keys and gift cards. Replacement promise on every code.');
  await editor.locator('input[type=file]').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: PNG });
  await expect(editor.getByRole('status')).toContainText('Banner updated');
  await editor.getByRole('button', { name: 'Save shop page' }).click();
  await expect(editor.getByRole('status')).toContainText('Shop page saved');

  await editor.getByRole('link', { name: 'View your shop' }).click();
  await expect(page.getByText('Instant Steam keys and gift cards. Replacement promise on every code.')).toBeVisible();
  await expect(page.getByRole('img', { name: /shop banner/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Featured' })).toBeVisible();
});
