import { expect, test } from '@playwright/test';
import { watchErrors } from './helpers';

test.describe('price history and recommendations', () => {
  test('a listing shows its price history with a hover readout and a table view', async ({ page }) => {
    const done = watchErrors(page);
    await page.goto('/offers/offer-2');
    const card = page.locator('section', { has: page.getByRole('heading', { name: 'Price history' }) });
    await expect(card).toBeVisible();
    const chart = card.getByRole('img', { name: /Price of this .* listing over 90 days/ });
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(card.locator('.pointer-events-none.absolute')).toContainText('$');
    await card.getByText('Show as a table').click();
    await expect(card.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Buyers also bought' })).toBeVisible();
    done();
  });

  test('a game market shows lowest and median prices over time', async ({ page }) => {
    await page.goto('/games/elden-ring/keys');
    await page.getByText(/^Price trend: Elden Ring/).click();
    await expect(page.getByRole('img', { name: /Daily prices for Elden Ring/ })).toBeVisible();
    await expect(page.getByText('Typical (median) price').first()).toBeVisible();
  });
});
