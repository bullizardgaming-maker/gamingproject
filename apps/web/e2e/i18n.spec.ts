import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn } from './helpers';

test.describe('languages', () => {
  test('Arabic switches the page to right-to-left and persists', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Language').first().selectOption('ar');
    await expect(page.getByRole('heading', { name: /تداول سلع الألعاب/ })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expectNoHorizontalScroll(page);
    await page.reload();
    await expect(page.getByRole('link', { name: 'السوق' }).first()).toBeVisible();
    await page.goto('/games/league-of-legends/boosting');
    await expect(page.getByLabel('الخادم')).toBeVisible();
    await expect(page.getByText('عرضان').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('seller hub and help centre are translated', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.getByLabel('Language').first().selectOption('ar');
    await page.goto('/sell');
    await expect(page.getByRole('heading', { name: 'متجرك', exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto('/help');
    await expect(page.getByText('النزاعات والحماية').first()).toBeVisible();
    await page.goto('/help/how-escrow-works');
    await expect(page.getByRole('heading', { name: 'كيف يحمي الضمان طلبك' })).toBeVisible();
  });

  test('German and back to English', async ({ page }) => {
    await page.goto('/market');
    await page.getByLabel('Language').first().selectOption('de');
    await expect(page.getByRole('heading', { name: 'Alle Angebote' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.getByLabel('Sprache').first().selectOption('en');
    await expect(page.getByRole('heading', { name: 'All offers' })).toBeVisible();
  });

  test('picks the browser language on first visit', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'fr-FR' });
    const page = await ctx.newPage();
    await page.goto('/market');
    await expect(page.getByRole('heading', { name: 'Toutes les offres' })).toBeVisible();
    await ctx.close();
  });
});
