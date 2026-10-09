import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('a seller links Steam and Riot accounts and lists one with a verified badge', async ({ page }) => {
  await signIn(page, 'Seller');
  await page.goto('/sell');
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Linked game accounts' }) });
  await expect(card.getByText('keystone_shop')).toBeVisible();

  // The platform sign-in completes straight away in the demo and comes back to the hub.
  await card.getByRole('button', { name: 'Link Riot' }).click();
  await expect(card.getByRole('status')).toContainText('Riot account linked.');
  await expect(page).toHaveURL(/\/sell$/);
  await expect(card.getByText(/#1001/)).toBeVisible();

  // Account listings offer the game's own platform only.
  await page.locator('select[name=categorySlug]').selectOption('accounts');
  await page.locator('input[name=game]').fill('Counter-Strike 2');
  const pick = page.getByLabel('Linked Steam account');
  await expect(pick.locator('option')).toHaveText(['None', 'keystone_shop']);
  await pick.selectOption({ label: 'keystone_shop' });
  await page.locator('input[name=title]').fill('Prime account, 3k hours, Faceit 10');
  await page.locator('input[name=price]').fill('90');
  await page.locator('select[name=deliveryMode]').selectOption('manual');
  await page.getByRole('button', { name: 'Create listing' }).click();
  await expect(page.getByText('Steam verified').first()).toBeVisible();
  // The account is now in use, so a second listing can't pick it.
  await page.locator('input[name=game]').fill('Dota 2');
  await expect(page.getByLabel('Linked Steam account').locator('option')).toHaveText(['None']);

  await page.goto('/games/counter-strike-2/accounts');
  await page.getByRole('link', { name: /Prime account, 3k hours/ }).first().click();
  await expect(page.getByText('Steam account verified · since 2014').first()).toBeVisible();
  await expect(page.getByText('keystone_shop')).toHaveCount(0); // the account name stays private
});

test('staff see the linked account next to an owner proof', async ({ page }) => {
  await signIn(page, 'Admin');
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Owner proofs' }).click();
  const row = page.getByRole('row', { name: /Immortal 2 account/ });
  await expect(row.getByText('Riot sign-in')).toBeVisible();
  await expect(row.getByText('RiftTrader#EUW')).toBeVisible();
});
