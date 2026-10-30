import { expect, test, type Page } from '@playwright/test';
import { buy, buyNow, fillCharacter, pickCoin, previewOffer, signIn, startOffer } from './helpers';

const SELLER_ID = 'u-sell1-0000-4000-8000-000000000002';

/** Buyer starts a crypto payment for a listing with the demo network set to `outcome`. */
async function payWith(page: Page, outcome: string, offerPath = '/offers/offer-7') {
  await signIn(page, 'Buyer');
  await page.evaluate((o) => localStorage.setItem('bz.demo.cryptoOutcome', o), outcome);
  await page.goto(offerPath);
  await fillCharacter(page);
  await buyNow(page);
  await page.waitForURL(/\/orders\/.*pay=crypto/);
  await pickCoin(page);
}

test.describe('Round 26: crypto never goes blank (A4)', () => {
  test('a slow confirmation shows “Payment received — confirming your order…”, then the paid order', async ({ page }) => {
    await payWith(page, 'slow');
    await expect(page.getByTestId('pay-confirming')).toContainText('Payment received — confirming your order…', { timeout: 15_000 });
    await expect(page.locator('.crypto-checkout')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(/Paid|In escrow|Waiting for delivery/).first()).toBeVisible();
  });

  test('held for review and credited to balance each get their own message', async ({ page }) => {
    await payWith(page, 'held');
    await expect(page.getByTestId('pay-held')).toContainText('our team is checking it', { timeout: 15_000 });
    await payWith(page, 'credited');
    const credited = page.getByTestId('pay-credited');
    await expect(credited).toContainText('added to your Bullizard balance', { timeout: 15_000 });
    await expect(credited.getByRole('link', { name: 'See my balance' })).toBeVisible();
  });

  test('a failed or expired payment says so and lets the buyer pick a coin again', async ({ page }) => {
    await payWith(page, 'expired');
    await expect(page.getByTestId('pay-lapsed')).toContainText('expired before it arrived', { timeout: 15_000 });
    await expect(page.locator('.crypto-checkout')).toBeVisible();
  });

  test('staff see crypto payments and can re-check one', async ({ page }) => {
    await payWith(page, 'held');
    await expect(page.getByTestId('pay-held')).toBeVisible({ timeout: 15_000 });
    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Crypto payments' }).click();
    const table = page.getByTestId('crypto-payments');
    await expect(table.getByText('Held for review').first()).toBeVisible();
    await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('held_for_review');
    await table.getByRole('button', { name: 'Re-check with NOWPayments' }).first().click();
    await expect(page.getByRole('status').filter({ hasText: /^Re-checked/ })).toBeVisible();
  });
});

test.describe('Round 26: create and manage listings (B1–B10)', () => {
  test('Aion currency asks for a faction, and the preview shows the buyer price with min and max per order', async ({ page }) => {
    await signIn(page, 'Seller');
    await startOffer(page, 'currency', 'Albion Online');
    await expect(page.locator('select[name="attr.faction"]')).toHaveCount(0);
    await startOffer(page, 'currency', 'Aion');
    await expect(page.locator('input[name=title]')).toHaveCount(0); // currency titles are made from game and server
    await page.locator('input[name="attr.server"]').fill('Israphel');
    await page.locator('select[name="attr.faction"]').selectOption('Asmodian');
    await page.locator('select[name="attr.region"]').selectOption('Europe');
    await page.locator('input[name=stock]').fill('500');
    await page.locator('input[name=unitPrice]').fill('0.5');
    await page.locator('input[name=minQty]').fill('10');
    await page.locator('input[name=maxQty]').fill('5');
    await page.locator('select[name=deliveryTime]').selectOption('1h');
    await page.locator('textarea[name=description]').fill('Face to face in Pandaemonium. Whisper me when you are online.');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    // A max below the min is refused before anything is sent.
    expect(await page.locator('input[name=maxQty]').evaluate((e: HTMLInputElement) => e.validity.rangeUnderflow)).toBe(true);
    await expect(page.getByTestId('listing-preview')).toHaveCount(0);
    await page.locator('input[name=maxQty]').fill('200');
    await previewOffer(page);

    const preview = page.getByTestId('listing-preview');
    await expect(preview).toContainText('as buyers will see it');
    await expect(preview.locator('.of-rows').first()).toContainText('Asmodian');
    await expect(preview).toContainText('Face to face in Pandaemonium');
    await expect(preview.locator('.lp-limits')).toContainText('10');
    await expect(preview.locator('.lp-limits')).toContainText('200');
    // The buyer pays more than the seller's $0.50 (fees on top): 10 × more than $0.50.
    const total = Number((await preview.getByTestId('preview-total').innerText()).replace(/[^0-9.]/g, ''));
    expect(total).toBeGreaterThan(5);
    await preview.getByRole('button', { name: 'Back to edit' }).click();
    await expect(page.locator('input[name=maxQty]')).toHaveValue('200');
    await previewOffer(page);
    await page.getByRole('button', { name: 'Publish offer' }).click();
    await expect(page.getByText('Your offer is live.')).toBeVisible();

    const row = page.getByRole('row', { name: /Aion · .* · Asmodian/ });
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit listing' })).toBeVisible();
    await expect(page.locator('input[name=minQty]')).toHaveValue('10');
    await page.locator('input[name=maxQty]').fill('150');
    await previewOffer(page);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changes saved.')).toBeVisible();
  });

  test('a listing with an open order can be paused but not deleted; one without can be deleted', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-12');
    await signIn(page, 'Seller');
    await page.goto('/sell');
    const busy = page.getByRole('row', { name: /Gold IV → Platinum IV/ });
    await expect(busy.getByRole('button', { name: 'Delete' })).toBeDisabled();
    await expect(busy).toContainText(/Open orders: \d+\. Pause it instead/);
    await busy.getByRole('button', { name: 'Pause' }).click();
    await expect(busy.getByText('Paused')).toBeVisible();
    await busy.getByRole('button', { name: 'Resume' }).click();
    await expect(busy.getByRole('button', { name: 'Pause' })).toBeVisible();

    const free = page.getByRole('row', { name: /AK-47 \| Redline/ });
    await free.getByRole('button', { name: 'Delete' }).click();
    await free.getByRole('button', { name: 'Delete listing' }).click();
    await expect(page.getByRole('row', { name: /AK-47 \| Redline/ })).toHaveCount(0);
  });

  test('duplicate to another server copies the listing with its own stock', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    const row = page.getByRole('row', { name: /100M kinah — Siel/ });
    await row.getByRole('button', { name: 'Duplicate to another server' }).click();
    const form = page.getByRole('form', { name: /Duplicate/ });
    await form.getByLabel(/^New /).fill('Siel');
    await form.getByLabel('Stock').fill('25');
    await form.getByRole('button', { name: 'Create copy' }).click();
    await expect(form.getByRole('alert')).toHaveText('Pick a different server.'); // same server and faction as the original
    await form.getByLabel(/^New /).fill('Israphel');
    await form.getByLabel('Faction').selectOption('Elyos');
    await form.getByRole('button', { name: 'Create copy' }).click();
    await expect(page.getByRole('row', { name: /Aion · Israphel · Elyos/ })).toContainText('25');
    await expect(page.getByRole('row', { name: /100M kinah — Siel/ })).toBeVisible(); // the original stays
  });

  test('out of stock shows on the seller’s listing only', async ({ page }) => {
    await signIn(page, 'Seller');
    // Sold out: set the listing's stock to 0 before the demo loads its saved state.
    await page.addInitScript(() => {
      const raw = localStorage.getItem('bz.demo.v29');
      if (!raw) return;
      const s = JSON.parse(raw);
      s.offers.find((o: { id: string }) => o.id === 'offer-14').stock = 0;
      localStorage.setItem('bz.demo.v29', JSON.stringify(s));
    });
    await page.goto('/sell');
    await expect(page.getByRole('row', { name: /AK-47 \| Redline/ }).getByTestId('out-of-stock')).toHaveText('Out of stock – hidden until you restock');
    await page.goto(`/sellers/${SELLER_ID}`);
    await expect(page.getByRole('link', { name: 'Elden Ring — Steam key (Global)' }).first()).toBeVisible();
    await expect(page.getByText('AK-47 | Redline')).toHaveCount(0);
    await expect(page.getByText('hidden until you restock')).toHaveCount(0);
  });

  test('the offer page caps the quantity at the max per order', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    await page.getByRole('row', { name: /100k Gold — Stormrage/ }).getByRole('link', { name: 'Edit' }).click();
    await page.locator('input[name=maxQty]').fill('3');
    await previewOffer(page);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changes saved.')).toBeVisible();
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-7');
    await expect(page.getByTestId('offer-max')).toContainText('Max. 3');
    await page.locator('#of-qty').fill('3');
    await expect(page.getByRole('button', { name: 'More' })).toBeDisabled();
  });
});
