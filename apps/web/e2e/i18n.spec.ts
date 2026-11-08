import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn, setLanguage } from './helpers';

test.describe('languages', () => {
  test('Arabic switches the page to right-to-left and persists', async ({ page }) => {
    await page.goto('/');
    await setLanguage(page, 'ar');
    await expect(page.getByRole('heading', { level: 1, name: /السوق الرقمي/ })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expectNoHorizontalScroll(page);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: /السوق الرقمي/ })).toBeVisible();
    await page.goto('/games/league-of-legends/boosting');
    await expect(page.getByLabel('الخادم')).toBeVisible();
    await expect(page.getByText('عرضان').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('seller hub is translated', async ({ page }) => {
    await signIn(page, 'Seller');
    await setLanguage(page, 'ar');
    await page.goto('/sell');
    await expect(page.getByRole('heading', { name: 'لوحة البائع', exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('buyer orders page is translated and right-to-left', async ({ page }) => {
    await signIn(page, 'Buyer');
    await setLanguage(page, 'ar');
    await page.goto('/orders');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'الطلبات', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'مشترياتي' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'الحالة' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('German and back to English', async ({ page }) => {
    await page.goto('/market');
    await setLanguage(page, 'de');
    await expect(page.getByRole('heading', { name: 'Währung', exact: true })).toBeVisible(); // the market opens on game coins (Round 25)
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await setLanguage(page, 'en');
    await expect(page.getByRole('heading', { name: 'Currency', exact: true })).toBeVisible();
  });

  test('picks the browser language on first visit', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'fr-FR' });
    const page = await ctx.newPage();
    await page.goto('/market');
    await expect(page.getByRole('heading', { name: 'Monnaie', exact: true })).toBeVisible();
    await ctx.close();
  });
});
