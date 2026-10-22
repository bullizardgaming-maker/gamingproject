import { expect, test } from '@playwright/test';
import { payCrypto, signIn, signOut } from './helpers';

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
    const pay = page.getByRole('button', { name: /Pay .* into escrow/ });
    await page.getByLabel(/I accept the Terms of Service/).check();
    await expect(pay).toBeDisabled(); // no character yet
    await page.getByLabel('Deliver to character').fill('Kaisinel_Pat');
    await expect(page.getByRole('link', { name: 'How in-game delivery works' })).toHaveAttribute('href', '/help/delivery-in-game');
    await pay.click();
    await page.waitForURL(/\/orders\/.*pay=crypto/);
    await payCrypto(page);
    await expect(page.getByTestId('order-character')).toContainText('Kaisinel_Pat');
    const orderUrl = page.url().split('?')[0]!;

    // Next time the name is remembered: one tap to confirm, or change it.
    await page.goto('/offers/offer-55');
    const field = page.getByTestId('character-field');
    await expect(field).toContainText('Kaisinel_Pat');
    await expect(field.getByRole('button', { name: /Confirm/ })).toBeVisible();
    await expect(field.getByRole('button', { name: 'Change' })).toBeVisible();

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
    await page.goto('/sell');
    await page.locator('select[name=categorySlug]').selectOption('currency');
    await page.locator('input[name=game]').fill('Path of Exile');
    const league = page.locator('select[name="attr.league"]');
    await expect(league).toBeVisible();
    await expect(league.locator('option')).toContainText(['Standard', 'Hardcore', 'Mercenaries']);
    await expect(league.locator('option', { hasText: 'Settlers' })).toHaveCount(0); // ended
    await expect(page.locator('select[name="attr.mode"]').locator('option')).toContainText(['Softcore', 'Hardcore']);
    await page.locator('input[name=game]').fill('Albion Online');
    await expect(page.locator('select[name="attr.server"]').locator('option')).toContainText(['Americas', 'Europe', 'Asia']);
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
