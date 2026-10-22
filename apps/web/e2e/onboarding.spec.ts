import { expect, test } from '@playwright/test';
import { signIn, signOut } from './helpers';

test.describe('seller onboarding', () => {
  test('a new seller passes the rules test before the first listing and sees the ID deadline', async ({ page }) => {
    await signIn(page, 'Buyer'); // Pixel Pat: Tier 1, never sold
    await page.goto('/sell');
    const form = page.getByTestId('rules-test');
    await expect(form.getByRole('heading', { name: 'Seller rules test' })).toBeVisible();
    const check = form.getByRole('button', { name: 'Check my answers' });
    await expect(check).toBeDisabled();
    // Everything wrong: fail, with the explanation on each missed question.
    const groups = form.getByRole('group');
    const n = await groups.count();
    expect(n).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < n; i++) await groups.nth(i).getByRole('radio').last().check();
    await groups.first().getByRole('radio').first().check();
    await check.click();
    await expect(form.getByRole('status')).toContainText('you need 100%');
    await expect(form.getByText('Trading or sharing outside contacts anywhere on Bullizard can get your account banned right away.')).toBeVisible();

    // The right answers (the demo's question set).
    const right = [1, 2, 1, 0, 1, 2];
    for (let i = 0; i < right.length; i++) await groups.nth(i).getByRole('radio').nth(right[i]!).check();
    await check.click();
    await expect(page.getByText('Your rank')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hatchling' })).toBeVisible();
    await expect(page.getByTestId('seller-rate')).toContainText('Commission 13.99%'); // the promo starts with the first listing

    // First listing: allowed on Tier 1; the ID deadline then shows on the hub.
    await page.locator('select[name=categorySlug]').selectOption('currency');
    await page.locator('input[name=game]').fill('Albion Online');
    await page.locator('input[name=title]').fill('5M silver — Europe');
    await page.locator('input[name=price]').fill('6');
    await page.locator('select[name=deliveryMode]').selectOption('manual');
    await page.locator('select[name="attr.server"]').selectOption('Europe');
    await page.getByRole('button', { name: 'Publish offer' }).click();
    await expect(page.getByText('5M silver — Europe').first()).toBeVisible();
    await expect(page.getByTestId('id-deadline')).toContainText('Verify your identity by');
    await expect(page.getByTestId('seller-rate')).toContainText('Launch promo: 5%');
  });

  test('support edits the rules test', async ({ page }) => {
    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Rules test' }).click();
    await expect(page.getByTestId('rules-question')).toHaveCount(6);
    await page.getByLabel('Pass mark').fill('80');
    await page.getByRole('button', { name: 'Add question' }).click();
    await expect(page.getByTestId('rules-question')).toHaveCount(7);
    await page.getByLabel('Question 7', { exact: true }).fill('Can you ask a buyer for their account password?');
    await page.getByLabel('Question 7 option 1').fill('Yes');
    await page.getByLabel('Question 7 option 2').fill('No, never');
    await page.getByLabel('Question 7 correct answer 2').check();
    await page.getByRole('button', { name: 'Save test' }).click();
    await expect(page.getByText('Saved. New sellers get the updated test at once.')).toBeVisible();
    await signOut(page);
    await signIn(page, 'Buyer');
    await page.goto('/sell');
    await expect(page.getByTestId('rules-test')).toContainText('80% is a pass');
    await expect(page.getByTestId('rules-test')).toContainText('Can you ask a buyer for their account password?');
  });
});
