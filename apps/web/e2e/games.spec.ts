import { expect, test } from '@playwright/test';
import { payCrypto, signIn, signOut, buyNow, startOffer } from './helpers';

/** A tiny PNG (1×1) used as the seller's delivery proof. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function signInAs(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill('demo-password-123');
  await page.locator('form button[type=submit]').click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe('launch games: in-game delivery', () => {
  test('buyer gives a character name once, the seller delivers with proof, the buyer sees it', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-55'); // 100M kinah — Aion delivers in-game
    // Buy now opens the delivery pop-up: pick a method, give the character name, keep it for next time.
    await buyNow(page, 'Kaisinel_Pat');
    await page.waitForURL(/\/orders\/.*pay=crypto/);
    await payCrypto(page);
    await expect(page.getByTestId('order-character')).toContainText('Kaisinel_Pat');
    const orderUrl = page.url().split('?')[0]!;

    // Next time the saved name is filled in.
    await page.goto('/offers/offer-55');
    await page.getByRole('button', { name: /Buy now/ }).click();
    await expect(page.getByRole('dialog', { name: 'Delivery method' }).getByLabel('Character name')).toHaveValue('Kaisinel_Pat');
    await page.keyboard.press('Escape');

    // The seller must attach proof before the delivery counts.
    await signOut(page);
    await signIn(page, 'Seller');
    await page.goto(orderUrl);
    await expect(page.getByText('Deliver to Kaisinel_Pat')).toBeVisible();
    const deliver = page.getByRole('button', { name: 'Mark as delivered' });
    await expect(deliver).toBeDisabled();
    await page.getByLabel(/Proof of delivery/).setInputFiles({ name: 'trade.png', mimeType: 'image/png', buffer: PNG });
    await expect(deliver).toBeEnabled();
    await deliver.click();
    await expect(page.getByTestId('delivery-proof')).toBeVisible();
    await expect(page.getByTestId('delivery-proof')).toContainText('trade.png');

    await signOut(page);
    await signIn(page, 'Buyer');
    await page.goto(orderUrl);
    await expect(page.getByTestId('delivery-proof').getByRole('img')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm and release payment' })).toBeVisible();
  });

  test('the sell form shows league and mode for Path of Exile, with the open challenge league', async ({ page }) => {
    await signIn(page, 'Seller');
    await startOffer(page, 'currency', 'Path of Exile');
    const league = page.locator('input[name="attr.league"]'); // Round 26b: searchable list ("Type to filter")
    await expect(league).toHaveAttribute('placeholder', 'Type to filter');
    await league.focus();
    await expect(page.getByRole('listbox').getByRole('option')).toContainText(['Standard', 'Hardcore', 'Mercenaries']);
    await expect(page.getByRole('listbox').getByRole('option', { name: /Settlers/ })).toHaveCount(0); // ended
    await page.keyboard.press('Escape'); // close the league list
    await page.locator('input[name="attr.mode"]').click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['Softcore', 'Hardcore']);
    await startOffer(page, 'currency', 'Albion Online');
    await page.locator('input[name="attr.server"]').focus();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['Americas', 'Europe', 'Asia']);
  });

  test('a listing expired by a league ending can be moved to an open league', async ({ page }) => {
    await signInAs(page, 'koi@demo.test'); // KoiCurrency went quiet while Settlers ended
    await page.goto('/sell');
    const row = page.getByRole('row', { name: /10 Divine Orbs — Settlers/ });
    await expect(row.getByText('Settlers ended')).toBeVisible();
    await row.getByLabel('Pick a league').selectOption('Mercenaries');
    await row.getByRole('button', { name: 'List again' }).click();
    await expect(page.getByRole('row', { name: /10 Divine Orbs — Settlers/ }).getByText('Settlers ended')).toHaveCount(0);
    await page.goto('/offers/offer-51');
    await expect(page.getByText('Mercenaries').first()).toBeVisible();
  });

  test('support opens and ends leagues from the operations console', async ({ page }) => {
    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Leagues' }).click();
    const table = page.getByRole('table', { name: 'Challenge leagues' });
    for (const name of ['Settlers', 'Mercenaries', 'Dawn of the Hunt']) await expect(table).toContainText(name);
    await page.getByLabel('League name').fill('Keepers');
    await page.getByRole('button', { name: 'Open league' }).click();
    await expect(page.getByText('Keepers is open for Path Of Exile.')).toBeVisible();
    const row = page.getByRole('row', { name: /Keepers/ });
    await row.getByRole('button', { name: 'End now' }).click();
    await expect(row.getByText('Ended')).toBeVisible();
  });
});
