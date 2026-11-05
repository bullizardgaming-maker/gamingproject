import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Round 30: the Ops redesign (shadcn/ui), stage by stage. Logic is unchanged; these cover the new layout. */

test('Ops sidebar groups the sections; the arrow keys move through them', async ({ page }) => {
  await signIn(page, 'Admin');
  await page.goto('/admin');
  const side = page.getByRole('complementary', { name: 'Operations sections' });
  for (const g of ['Overview', 'Orders & support', 'Risk & compliance', 'Money', 'Sellers & growth', 'Platform']) await expect(side.getByText(g, { exact: true })).toBeVisible();
  await side.getByRole('tab', { name: 'Fraud review' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Fraud review' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(side.getByRole('tab', { name: 'Fraud model' })).toBeFocused();
  await expect(page.getByRole('heading', { level: 1, name: 'Fraud model' })).toBeVisible();
});

test('Fraud review: score, reasons in words, clear one account, confirm another after a second step', async ({ page }) => {
  await signIn(page, 'Admin');
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Fraud review' }).click();
  await expect(page.getByText('Open flags')).toBeVisible();

  const quick = page.getByRole('row', { name: /quickbuy_2/ });
  await expect(quick).toContainText('0.64');
  await expect(quick.getByRole('link', { name: 'BZ-7F3A2C' })).toBeVisible();
  await quick.getByRole('button', { name: 'Review' }).click();
  let panel = page.getByRole('dialog', { name: /Fraud review · quickbuy_2/ });
  await expect(panel.getByText(/under 24 h old/)).toBeVisible();
  await panel.getByRole('button', { name: 'Clear and unfreeze' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'quickbuy_2 cleared' })).toBeVisible();
  await expect(page.getByRole('row', { name: /quickbuy_2/ })).toHaveCount(0);

  await page.getByRole('row', { name: /fresh_seller_77/ }).getByRole('button', { name: 'Review' }).click();
  panel = page.getByRole('dialog', { name: /Fraud review · fresh_seller_77/ });
  await expect(panel.getByText(/linked accounts buying from this seller/)).toBeVisible();
  await panel.getByRole('button', { name: 'Confirm fraud' }).click();
  await expect(panel.getByText('Suspend fresh_seller_77?')).toBeVisible();
  await panel.getByRole('button', { name: 'Suspend account' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'confirmed as fraud' })).toBeVisible();
  await expect(page.getByText('Nothing waiting here.')).toBeVisible();
});
