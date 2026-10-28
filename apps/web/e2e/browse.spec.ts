import { expect, test } from '@playwright/test';
import { watchErrors } from './helpers';

test.describe('browsing', () => {
  test('home, market paging and search', async ({ page }) => {
    const done = watchErrors(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /The market for every game/ })).toBeVisible();
    // Round 25: the market opens on game coins as game + server cards, G2G-style, with a filter panel.
    await page.goto('/market');
    await expect(page.getByRole('heading', { name: 'Currency', exact: true })).toBeVisible();
    await expect(page.getByTestId('result-count')).toContainText(/\d+ results/);
    await expect(page.locator('.mk-card').first()).toBeVisible();
    const panel = page.getByRole('complementary', { name: 'Filters' });
    await panel.getByRole('button', { name: /^World of Warcraft/ }).click();
    await expect(page).toHaveURL(/game=World/);
    await expect(page.locator('.mk-card').first()).toContainText('World of Warcraft');
    await page.getByLabel('Sort').selectOption('price_asc');
    await expect(page).toHaveURL(/sort=price_asc/);
    // Other product types come as the listing table, paged.
    await page.goto('/market?category=keys');
    await expect(page.getByRole('link', { name: 'Red Dead Redemption 2 — Rockstar key' })).toBeVisible();
    await page.goto('/market?q=e');
    await page.locator('.mk-pager').getByRole('button', { name: '2', exact: true }).click();
    await expect(page.locator('.mk-pager [aria-current=page]')).toHaveText('2');
    await page.fill('input[name=q]', 'valorant');
    await page.press('input[name=q]', 'Enter');
    await expect(page.getByText('Immortal 2 account').first()).toBeVisible();
    done();
  });

  test('header search suggests a game and the game page has category tabs', async ({ page }) => {
    await page.goto('/');
    await page.locator('header input[name=search]').fill('genshin');
    await page.locator('header').getByRole('option', { name: /Genshin Impact/ }).click();
    await expect(page).toHaveURL(/genshin-impact/);
    await page.getByRole('link', { name: /^Accounts 2$/ }).click();
    await expect(page).toHaveURL(/genshin-impact\/accounts/);
    // Router updates run in a transition, so click and wait rather than check() (which reads state at once).
    await page.getByLabel('Owner-verified').click();
    await expect(page.getByLabel('Owner-verified')).toBeChecked();
    await expect(page.getByText(/^1 offer/)).toBeVisible();
  });

  test('game-specific filters narrow the offers and show counts', async ({ page }) => {
    await page.goto('/games/league-of-legends/boosting');
    await page.getByLabel('Server').selectOption('EUW');
    await expect(page).toHaveURL(/attr\.server=EUW/);
    await expect(page.getByText(/^2 offers ·/)).toBeVisible();
    await page.goto('/games/counter-strike-2/items');
    await page.getByLabel('Exterior').selectOption('Field-Tested');
    await page.getByLabel('StatTrak™').selectOption('Yes');
    await expect(page.getByText(/^1 offer$/)).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/attr\./);
  });

  test('A–Z directory, seller profile and offer details', async ({ page }) => {
    await page.goto('/games');
    await page.getByLabel('Filter games').fill('rune');
    await expect(page.getByRole('link', { name: 'Old School RuneScape' }).first()).toBeVisible();
    await page.goto('/offers/offer-10');
    await expect(page.getByText('Rank', { exact: true })).toBeVisible();
    await expect(page.getByText('Immortal', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: /RiftTrader/ }).click();
    await expect(page).toHaveURL(/sellers\//);
    await page.getByRole('tab', { name: /Reviews/ }).click();
  });

  test('status page; the help centre is drafted and sends people to support', async ({ page }) => {
    await page.goto('/status');
    await expect(page.getByRole('heading', { name: 'All systems operational' })).toBeVisible();
    await page.goto('/help');
    await expect(page).toHaveURL(/\/support\/new/); // Round 24b: no help centre until it is built
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Help centre' })).toHaveCount(0);
  });

  test('dark mode and display currency persist', async ({ page }) => {
    await page.goto('/games/genshin-impact');
    await page.getByLabel('Show prices in', { exact: true }).first().selectOption('EGP');
    await expect(page.getByText(/EGP\s?[\d,.]+/).first()).toBeVisible(); // exact, no "≈" (Round 25)
    await expect(page.getByText(/≈/)).toHaveCount(0);
    await page.getByLabel('Show prices in', { exact: true }).first().selectOption('EUR');
    await expect(page.getByText(/€[\d,.]+/).first()).toBeVisible();
    // The theme follows the device until the viewer picks one; the choice sticks across a reload.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('button', { name: 'Language, currency and theme' }).click();
    await page.getByRole('button', { name: 'Use light theme' }).click();
    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });

  test('prices default to the local currency on a first visit', async ({ browser }) => {
    const cairo = await browser.newContext({ timezoneId: 'Africa/Cairo', locale: 'en-US' });
    const page = await cairo.newPage();
    await page.goto('/games/genshin-impact');
    await expect(page.getByLabel('Show prices in').first()).toHaveValue('EGP');
    await expect(page.getByTestId('prefs-currency')).toHaveText('EGP'); // visible in the top bar
    await expect(page.getByText(/EGP\s?[\d,.]+/).first()).toBeVisible();
    await cairo.close();
    const berlin = await browser.newContext({ timezoneId: 'Europe/Berlin', locale: 'de-DE' });
    const p2 = await berlin.newPage();
    await p2.goto('/games/genshin-impact');
    await expect(p2.getByLabel('Preise anzeigen in').first()).toHaveValue('EUR');
    await berlin.close();
  });

  test('volume discounts lower the unit price as you buy more', async ({ page }) => {
    // Round 25: currency listings take a % off from a quantity; the total is quantity × unit price, rounded up.
    await page.goto('/offers/offer-7');
    await page.getByLabel('Quantity').fill('3');
    const three = await page.getByTestId('offer-total').textContent();
    await page.getByRole('button', { name: /^10\+ · \d+% off$/ }).click();
    await expect(page.getByLabel('Quantity')).toHaveValue('10');
    await expect(page.locator('.of-unitprice')).toContainText('% off');
    const ten = Number((await page.getByTestId('offer-total').textContent())!.replace(/[^\d.]/g, ''));
    expect(ten).toBeLessThan((Number(three!.replace(/[^\d.]/g, '')) / 3) * 10);
  });

  test('listings and shops show who is online and how fast they reply', async ({ page }) => {
    await page.goto('/games/genshin-impact/top-ups');
    await expect(page.getByRole('img', { name: 'Online now' }).first()).toBeVisible();
    await page.goto('/sellers/u-sell5-0000-4000-8000-000000000007');
    // Online is the green dot on the picture; "last seen" is written only when the seller is away (Round 24).
    await expect(page.getByRole('img', { name: 'Online now' }).first()).toBeVisible();
    await expect(page.getByText('Online now', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Usually replies within 15 minutes')).toBeVisible();
    await page.goto('/sellers/u-sell2-0000-4000-8000-000000000004');
    await expect(page.getByText('Usually replies within an hour')).toBeVisible();
    await expect(page.getByText(/Last seen 3 hours ago/)).toBeVisible();
  });
});
