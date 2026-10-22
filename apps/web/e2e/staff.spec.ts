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

  test('retention dashboard: cohorts, repeat rate and seller churn', async ({ page }) => {
    await page.getByRole('tab', { name: 'Retention' }).click();
    await expect(page.getByText('Repeat within 90 days')).toBeVisible();
    const cohorts = page.getByRole('table', { name: /Buyer cohorts/ });
    await expect(cohorts.getByRole('row')).toHaveCount(13); // header + 12 months
    await expect(cohorts.getByRole('row').nth(1).getByRole('cell').nth(1)).toHaveText('100%'); // M0
    await page.getByRole('button', { name: 'Sellers', exact: true }).click();
    await expect(page.getByRole('table', { name: /Seller cohorts/ })).toBeVisible();
    await page.getByRole('button', { name: '6 months' }).click();
    await expect(page.getByRole('table', { name: /Seller cohorts/ }).getByRole('row')).toHaveCount(7);
    await expect(page.getByText('Sellers per month')).toBeVisible();
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
      ['Seller ranks', 'Launch promo for new sellers'],
      ['Support', 'Needs reply'],
    ] as const) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByText(text).first(), tab).toBeVisible();
    }
  });
});
