import { expect, test } from '@playwright/test';
import { buy, signIn } from './helpers';

test('dispute: buyer states the case, the arbiter decides from the case file', async ({ page }) => {
  await signIn(page, 'Buyer');
  await buy(page, '/offers/offer-14'); // AK-47 Redline, manual delivery
  await page.getByText('Open a dispute').click();
  await page.getByLabel("What's the problem?").selectOption('not_delivered');
  await page.getByPlaceholder(/What happened\?/).fill('Paid an hour ago and the seller has not traded the skin yet.');
  await page.getByRole('button', { name: 'Open dispute' }).click();
  await expect(page.getByText('Buyer statement')).toBeVisible();
  await page.getByPlaceholder(/Add your statement/).fill('My Steam trade link is in the chat; nothing has arrived.');
  await page.getByRole('button', { name: 'Add statement' }).click();
  await expect(page.getByText('Buyer statement', { exact: true })).toHaveCount(2); // saved, not just typed

  await signIn(page, 'Admin');
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Disputes' }).click();
  await page.locator('.card', { hasText: 'Paid an hour ago and the seller has not traded' }).getByRole('button', { name: 'Open case file' }).click();
  await expect(page.getByText('Buyer statements')).toBeVisible();
  await expect(page.getByText('My Steam trade link is in the chat').first()).toBeVisible();
  await expect(page.getByText(/Seller replied after the dispute/)).toBeVisible();
  await page.getByRole('button', { name: 'Statements', exact: true }).click();
  await page.getByPlaceholder('Decision note (shared in the order record)').fill('No delivery evidence in the chat.');
  await page.getByRole('button', { name: 'Refund buyer' }).click();
  await expect(page.getByText('Paid an hour ago and the seller has not traded')).toHaveCount(0);
});
