import { expect, test } from '@playwright/test';
import { buy, disputeViaSupport, signIn } from './helpers';

// Round 29e (M-A): dispute / warranty / progress texts with a contact attempt are saved, then listed for staff.
test('a dispute statement with a contact attempt is saved and shows in Ops → Moderation → Texts', async ({ page }) => {
  await signIn(page, 'Buyer');
  await buy(page, '/offers/offer-14');
  const orderUrl = await disputeViaSupport(page, 'Seller has gone quiet after I paid for the skin', 'No trade offer since I paid. Please step in.');

  await signIn(page, 'Buyer');
  await page.goto(orderUrl);
  await page.getByPlaceholder(/Your side for the arbiter/).fill('Still nothing. Add me on discord so we can sort it there: zedtrades#4521');
  await page.getByRole('button', { name: 'Add statement' }).click();
  await expect(page.getByText('Buyer statement', { exact: true })).toHaveCount(2); // accepted, not refused
  await expect(page.locator('.alert')).toHaveCount(0);

  await signIn(page, 'Admin');
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Moderation' }).click();
  await expect(page.getByRole('button', { name: 'Texts (3)' })).toBeVisible(); // two seeded + this one
  await page.getByRole('button', { name: /^Texts/ }).click();
  const flag = page.getByTestId('text-flag').filter({ hasText: 'zedtrades#4521' });
  await expect(flag).toContainText('Dispute statement');
  await expect(flag.getByRole('link', { name: /^Order / })).toBeVisible();
  await flag.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('button', { name: 'Texts (2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirmed' }).click();
  await expect(page.getByTestId('text-flag').filter({ hasText: 'zedtrades#4521' })).toBeVisible();
});

test('staff dismiss a flagged progress note', async ({ page }) => {
  await signIn(page, 'Admin');
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Moderation' }).click();
  await page.getByRole('button', { name: 'Texts (2)' }).click();
  const note = page.getByTestId('text-flag').filter({ hasText: 'discord.gg/boostzone' });
  await expect(note).toContainText('Progress note');
  await note.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByRole('button', { name: 'Texts (1)' })).toBeVisible();
  await expect(page.getByTestId('text-flag').filter({ hasText: 'discord.gg/boostzone' })).toHaveCount(0);
});
