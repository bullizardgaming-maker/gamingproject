import { expect, test } from '@playwright/test';
import { signIn, signOut } from './helpers';

test.describe('seller', () => {
  test('creates a listing with game-specific fields that buyers can filter by', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    await page.locator('select[name=categorySlug]').selectOption('boosting');
    await page.locator('input[name=game]').fill('League of Legends');
    await page.locator('input[name=title]').fill('Silver → Gold in 3 days');
    await page.locator('input[name=price]').fill('25');
    // Live preview: NorthWind is on the Basilisk rank (10.99%), grossed up on top of the $25.
    const preview = page.getByTestId('price-preview');
    await expect(preview).toContainText('Buyers pay $28.09');
    await expect(preview).toContainText('≈ €');
    await expect(preview).toContainText('≈ EGP');
    await expect(preview).toContainText('You earn $25.00');
    await expect(preview.getByRole('link', { name: 'Fee details' })).toHaveCount(0); // help centre drafted (Round 24b)
    await page.locator('select[name=deliveryMode]').selectOption('manual');
    await page.locator('select[name="attr.server"]').selectOption('KR');
    await page.locator('select[name="attr.rank_from"]').selectOption('Silver');
    await page.locator('select[name="attr.rank_to"]').selectOption('Gold');
    await page.getByRole('button', { name: 'Publish offer' }).click();
    await expect(page.getByText('Silver → Gold in 3 days').first()).toBeVisible();
    await expect(page.getByRole('row', { name: /Silver → Gold in 3 days/ })).toContainText('buyers pay $28.09');
    await page.goto('/games/league-of-legends/boosting?attr.server=KR');
    await expect(page.getByText('Silver → Gold in 3 days')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Silver → Gold in 3 days' })).toContainText('$28.09');
  });

  test('the hub shows the seller’s rank and the launch promo for new sellers', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    await expect(page.getByText('Your rank')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Basilisk' })).toBeVisible();
    await expect(page.getByTestId('seller-rate')).toContainText('Commission 10.99%');
    await expect(page.getByRole('table', { name: 'Commission by seller rank' })).toHaveCount(0); // own rank and progress only (Round 24b)
    await signOut(page);
    // RiftTrader opened their shop three weeks ago: still inside the 60-day launch promo.
    await page.goto('/login');
    await page.locator('input[name=email]').fill('rift@demo.test');
    await page.locator('input[name=password]').fill('demo-password-123');
    await page.locator('form button[type=submit]').click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto('/sell');
    await expect(page.getByRole('heading', { name: 'Scale' })).toBeVisible();
    await expect(page.getByTestId('seller-rate')).toContainText('Launch promo: 5% until');
  });

  test('analytics tab shows KPIs and switches period', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell/analytics');
    await expect(page.getByText('Sales per day', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Listing views', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '12 months' }).click();
    await expect(page.getByText('Sales per week', { exact: true }).first()).toBeVisible();
  });

  test('money page: invoice PDF and withdrawal', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell/money');
    await expect(page.getByText('Tax, invoices and exports')).toHaveCount(0); // removed (Round 24b)
    // Nothing is filled in: the fee shows once the seller types an amount.
    await expect(page.getByTestId('withdrawal-fee')).toHaveCount(0);
    await page.getByLabel(/Amount in/).fill('10');
    await expect(page.getByTestId('withdrawal-fee')).toBeVisible();
    await page.getByLabel(/I checked the address and network/).check();
    await page.getByRole('button', { name: /^Withdraw \$/ }).click();
    await expect(page.getByText(/sent once the treasury approves/).first()).toBeVisible();
  });

  test('can hide online status from buyers', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sellers/u-sell1-0000-4000-8000-000000000002');
    await expect(page.getByRole('img', { name: 'Online now' }).first()).toBeVisible(); // the green dot
    await page.getByRole('button', { name: 'Edit shop' }).click(); // shop settings live on the shop page (Round 24b)
    await expect(page.getByText('Buyers see: “Usually replies within 15 minutes”')).toBeVisible();
    await page.getByLabel('Show buyers when I’m online').uncheck();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Usually replies within 15 minutes')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Online now' })).toHaveCount(0);
  });
});
