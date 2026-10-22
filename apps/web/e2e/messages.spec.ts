import { expect, test } from '@playwright/test';
import { signIn, watchErrors } from './helpers';

test.describe('messages inbox', () => {
  test('lists chats, opens one with its order, finds it by order#, and blocks outside contact', async ({ page }) => {
    const done = watchErrors(page);
    await signIn(page, 'Buyer');
    await page.goto('/messages');
    const rows = page.locator('.inbox-row');
    await expect(rows.first()).toBeVisible();
    await rows.first().click();

    // Order strip and side panel name the order the same way.
    const ref = await page.locator('.inbox-strip .mono').innerText();
    expect(ref).toMatch(/^order#[0-9A-Z]{7}$/);
    await expect(page.locator('.inbox-side')).toContainText(ref);
    await expect(page.getByRole('link', { name: 'Open order' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Message from Bullizard' }).first()).toBeVisible();

    // Official messages never show money amounts.
    await expect(page.getByRole('article', { name: 'Message from Bullizard' }).filter({ hasText: /\$\d/ })).toHaveCount(0);

    // Search by order code, with or without the "order#" prefix.
    await page.getByLabel('Search name, listing or order').fill(ref.slice(0, 10));
    await expect(rows).toHaveCount(1);
    await page.getByLabel('Search name, listing or order').fill('');

    // Outside contact is never sent; a normal message after it lands below the notice.
    const box = page.locator('input[aria-label=Message]');
    await box.fill('add me on discord');
    await box.press('Enter');
    await expect(page.getByText('Not sent.')).toBeVisible();
    await box.fill('All good, thanks');
    await box.press('Enter');
    await expect(page.getByRole('log').getByText('All good, thanks')).toBeVisible();
    await expect(page.getByRole('log').getByText('add me on discord')).toHaveCount(0);
    done();
  });
});
