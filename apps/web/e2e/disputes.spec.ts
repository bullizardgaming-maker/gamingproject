import { expect, test } from '@playwright/test';
import { buy, disputeViaSupport, signIn } from './helpers';

// Round 24: the order page has no dispute form; the buyer writes to support and staff open the dispute from the ticket.
test('dispute: buyer writes to support, staff open the dispute from the ticket, the arbiter decides from the case file', async ({ page }) => {
  await signIn(page, 'Buyer');
  await buy(page, '/offers/offer-14'); // AK-47 Redline, manual delivery
  await expect(page.getByText('Open a dispute', { exact: true })).toHaveCount(0);
  const orderUrl = await disputeViaSupport(page, 'Paid an hour ago and the seller has not traded the skin yet', 'Nothing in the chat since I paid. Please step in.');

  await signIn(page, 'Buyer');
  await page.goto(orderUrl);
  await expect(page.getByText('Buyer statement')).toBeVisible(); // what the buyer wrote to support
  await expect(page.getByText('Nothing in the chat since I paid. Please step in.')).toBeVisible();
  await page.getByPlaceholder(/Your side for the arbiter/).fill('My Steam trade link is in the chat; nothing has arrived.');
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
