import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('staff operations', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'Admin');
    await page.goto('/admin');
  });

  test('business dashboard', async ({ page }) => {
    await page.getByRole('tab', { name: 'Business' }).click();
    await expect(page.getByText('GMV and take per day')).toBeVisible();
    await page.getByRole('button', { name: '90 days' }).click();
    await expect(page.getByText('GMV and take per day')).toBeVisible();
  });

  test('posts an incident that shows on the public status page', async ({ page }) => {
    await page.getByRole('tab', { name: 'Status page' }).click();
    await page.getByLabel('Title').fill('Payouts delayed for some sellers');
    await page.getByText('Seller payouts', { exact: true }).click();
    await page.getByLabel('Impact').selectOption('major');
    await page.getByLabel('First update').fill('Our payout provider is slow; money is safe.');
    await page.getByRole('button', { name: 'Post incident' }).click();
    await expect(page.getByText('Payouts delayed for some sellers').first()).toBeVisible();
    await page.goto('/status');
    await expect(page.getByRole('heading', { name: 'Some systems are having problems' })).toBeVisible();
  });

  test('every staff tab loads', async ({ page }) => {
    for (const [tab, text] of [
      ['Owner proofs', 'Immortal 2 account'],
      ['Compliance', 'RiftTrader'],
      ['Treasury', 'Quarterly VAT payment'],
      ['Seller debts', 'RiftTrader'],
      ['Fraud model', 'Model 3f9a1c0e7b21'],
      ['Staff', 'Finley'],
      ['Support', 'Needs reply'],
    ] as const) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByText(text).first(), tab).toBeVisible();
    }
  });
});
