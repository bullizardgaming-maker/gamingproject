import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, payCrypto, signIn, watchErrors } from './helpers';

test.describe('buyer requests', () => {
  test('the board is public and filters by game', async ({ page }) => {
    const done = watchErrors(page);
    await page.goto('/requests');
    await expect(page.getByRole('heading', { name: 'Buyer requests' })).toBeVisible();
    await expect(page.getByText('Silver II → Gold IV on EUW before the split ends')).toBeVisible();
    await page.locator('main').getByLabel('Game', { exact: true }).selectOption('Elden Ring');
    await expect(page.getByText('Shadow of the Erdtree DLC key, Steam (Global)')).toBeVisible();
    await expect(page.getByText('Silver II → Gold IV on EUW before the split ends')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    done();
  });

  test('buyer accepts a proposal and checks out the private listing', async ({ page }) => {
    const done = watchErrors(page);
    await signIn(page, 'Buyer');
    await page.goto('/requests/mine');
    await page.getByRole('link', { name: /EU account with Reaver Vandal/ }).click();
    await expect(page.getByText('VaultHopper')).toBeVisible();
    page.once('dialog', (d) => d.accept());
    // Cheapest first: VaultHopper at $98.
    await page.getByRole('button', { name: 'Accept' }).first().click();
    await expect(page).toHaveURL(/\/offers\/offer-r-/);
    await expect(page.getByText(/This listing was made for you/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /EU account with Reaver Vandal/ })).toBeVisible();
    // Private: not in the game's public offers.
    const url = page.url();
    await page.goto('/games/valorant/accounts');
    await expect(page.getByText(/EU account with Reaver Vandal/)).toHaveCount(0);
    await page.goto(url);
    await page.getByLabel(/I accept the Terms of Service/).check();
    await page.getByRole('button', { name: /Buy now/ }).click();
    await page.waitForURL(/\/orders\/.*pay=crypto/);
    await payCrypto(page);
    done();
  });

  test('buyer posts a request and a seller proposal arrives', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/games/diablo-iv');
    await page.getByRole('link', { name: 'Post a request' }).click();
    await expect(page.locator('main').getByLabel('Game', { exact: true })).toHaveValue('Diablo IV');
    await page.getByLabel('What do you want?').fill('Season 7 Tyrael’s Might, any roll');
    await page.getByLabel('Budget in USD (optional)').fill('20');
    await page.getByRole('button', { name: 'Post request' }).click();
    await expect(page.getByRole('heading', { name: 'Season 7 Tyrael’s Might, any roll' })).toBeVisible();
    await expect(page.getByText(/No proposals yet/)).toBeVisible();
    await page.waitForTimeout(5500);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
    await expect(page.getByText('$18.95')).toBeVisible(); // the seller's $18.00 plus their launch-promo commission
  });

  test('a seller sends and revises a proposal', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/requests');
    await page.getByRole('link', { name: 'Silver II → Gold IV on EUW before the split ends' }).click();
    await page.getByLabel('Your price (USD)').fill('42');
    await page.getByLabel('Delivery within (hours)').fill('48');
    await page.getByRole('button', { name: 'Send a proposal' }).click();
    await expect(page.getByText(/Your proposal is with the buyer/)).toBeVisible();
    await page.getByLabel('Your price (USD)').fill('40');
    await page.getByRole('button', { name: 'Update proposal' }).first().click();
    await expect(page.getByText('$40.00').first()).toBeVisible();
    await expect(page.getByText('buyers pay $44.94')).toBeVisible(); // NorthWind is on the Basilisk rate
    await page.goto('/requests/proposals');
    await expect(page.getByText('$40.00')).toBeVisible();
    await expect(page.getByText('Waiting for buyer')).toBeVisible();
  });

  test('a seller offers a listing they already have in one click', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/requests');
    await page.getByRole('link', { name: 'Shadow of the Erdtree DLC key, Steam (Global)' }).click();
    await expect(page.getByText('Your matching listings')).toBeVisible();
    await page.getByRole('button', { name: 'Offer this listing' }).first().click();
    await expect(page.getByText('Existing listing')).toBeVisible();
    await expect(page.getByText(/Your proposal is with the buyer/)).toBeVisible();
  });
});
