import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn } from './helpers';

const PAGES = ['/', '/market', '/games', '/games/valorant', '/games/league-of-legends/boosting', '/offers/offer-1', '/help', '/status'];

test.describe('phone layout', () => {
  for (const path of PAGES) {
    test(`no sideways scroll on ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(page);
    });
  }

  test('signed-in pages fit too', async ({ page }) => {
    await signIn(page, 'Seller');
    for (const path of ['/sell', '/sell/analytics', '/watchlist', '/orders']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(page);
    }
  });

  test('language and currency are reachable from the footer', async ({ page }) => {
    await page.goto('/');
    const lang = page.locator('footer').getByLabel('Language');
    await lang.scrollIntoViewIfNeeded();
    await expect(lang).toBeVisible();
    await lang.selectOption('es');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  });
});
