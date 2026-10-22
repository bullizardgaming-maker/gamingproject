import { expect, test } from '@playwright/test';
import { watchErrors } from './helpers';

test.describe('browsing', () => {
  test('home, market paging and search', async ({ page }) => {
    const done = watchErrors(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Your money waits/ })).toBeVisible();
    await page.goto('/market');
    await expect(page.getByRole('link', { name: 'Red Dead Redemption 2 — Rockstar key' })).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText(/Page 2 of/)).toBeVisible();
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

  test('status page, help centre and deep-link reload', async ({ page }) => {
    await page.goto('/status');
    await expect(page.getByRole('heading', { name: 'All systems operational' })).toBeVisible();
    await page.goto('/help');
    await page.getByLabel('Search help articles').fill('refund');
    await page.getByText('When will I see my refund?').click();
    await expect(page.getByRole('heading', { name: 'When will I see my refund?' })).toBeVisible();
    await page.goto('/developers');
    await expect(page.getByText(/API/).first()).toBeVisible();
  });

  test('dark mode and display currency persist', async ({ page }) => {
    await page.goto('/games/genshin-impact');
    await page.getByLabel('Show prices in').first().selectOption('EUR');
    await expect(page.getByText(/≈ €/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Use dark theme' }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('quantity prices lower the unit price as you buy more', async ({ page }) => {
    await page.goto('/games/world-of-warcraft/currency');
    await expect(page.getByText('$15.00 at 10+')).toBeVisible();
    await page.goto('/offers/offer-7');
    await page.getByRole('button', { name: '10+ · $15.00 each' }).click();
    await expect(page.getByLabel('Quantity')).toHaveValue('10');
    await expect(page.getByText('$150.00').first()).toBeVisible();
    await expect(page.getByText('You save $30.00 ($15.00 each)')).toBeVisible();
    await page.getByLabel('Quantity').fill('3');
    await expect(page.getByText('$54.00').first()).toBeVisible();
  });

  test('listings and shops show who is online and how fast they reply', async ({ page }) => {
    await page.goto('/games/genshin-impact/top-ups');
    await expect(page.getByRole('img', { name: 'Online now' }).first()).toBeVisible();
    await page.goto('/sellers/u-sell5-0000-4000-8000-000000000007');
    await expect(page.getByText('Online now')).toBeVisible();
    await expect(page.getByText('Usually replies within 15 minutes')).toBeVisible();
    await page.goto('/sellers/u-sell2-0000-4000-8000-000000000004');
    await expect(page.getByText('Usually replies within an hour')).toBeVisible();
    await expect(page.getByText(/Last seen 3 hours ago/)).toBeVisible();
  });
});
