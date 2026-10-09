import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { buy, signIn } from './helpers';

/**
 * Automated accessibility checks (axe-core, WCAG 2.1 A and AA) on the main pages. Fails on
 * serious and critical issues: missing names on controls, contrast, broken ARIA, keyboard traps.
 * Automated checks find roughly a third of real issues; they don't replace a manual review.
 */
// For contrast failures: the colours and ratio found.
const detail = (n: { any: Array<{ data?: any }> }) => {
  const d = n.any[0]?.data;
  return d?.contrastRatio ? `${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1 (needs ${d.expectedContrastRatio})` : '';
};

async function scan(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('main').locator('h1, h2').first()).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = serious.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.slice(0, 5).map((n) => `  ${n.target.join(' ')}  ${detail(n)}`).join('\n')}`).join('\n');
  expect(serious, `${path}\n${report}`).toEqual([]);
}

const PUBLIC = ['/', '/market', '/games', '/games/elden-ring', '/offers/offer-2', '/offers/offer-bundle-1', '/requests', '/help', '/status', '/login', '/cart'];

test.describe('accessibility', () => {
  for (const path of PUBLIC) {
    test(`public page ${path}`, async ({ page }) => scan(page, path));
  }

  test('buyer pages', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-2');
    const order = new URL(page.url()).pathname;
    for (const path of [order, '/orders', '/watchlist', '/account', '/requests/req-1']) await scan(page, path);
  });

  test('seller pages', async ({ page }) => {
    await signIn(page, 'Seller');
    for (const path of ['/sell', '/sell/money', '/sell/analytics']) await scan(page, path);
  });

  test('dark theme keeps contrast', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const path of ['/', '/games/elden-ring', '/offers/offer-2', '/cart']) await scan(page, path);
  });
});
