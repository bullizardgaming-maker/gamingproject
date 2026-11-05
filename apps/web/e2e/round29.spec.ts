import { expect, test, type Page } from '@playwright/test';
import { signIn, signOut } from './helpers';

/** Round 29: regions (no country names), no crypto from Egypt connections, country only in the withdrawal form, every badge + rating, no cart, real 503 messages, Ops fixes, support links. */

async function openSignUp(page: Page, name: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign up, it’s free!' }).click();
  await page.locator('input[name=displayName]').fill(name);
  await page.locator('input[name=email]').fill(`${name.toLowerCase().replace(/\W/g, '')}-${Date.now()}@example.com`);
  await page.locator('input[name=password]').fill('correct horse battery');
}
/** The demo's stand-in for Cloudflare's CF-IPCountry (the connection's country). */
const connectFrom = (page: Page, country: string | null) =>
  page.evaluate((c) => (c ? localStorage.setItem('bz.demo.ipCountry', c) : localStorage.removeItem('bz.demo.ipCountry')), country);

test.describe('regions, not countries', () => {
  test('sign-up asks for no country; Account has a region choice; the profile shows the region, never a country', async ({ page }) => {
    await openSignUp(page, 'Region Trader');
    await expect(page.locator('input[name=country]')).toHaveCount(0);
    await page.getByRole('checkbox', { name: /18 or older/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/account/);
    const region = page.getByTestId('region-settings');
    await expect(region.getByRole('radio', { name: 'Global' })).toBeChecked();
    for (const r of ['Asia', 'Middle East', 'America', 'Europe']) await expect(region.getByRole('radio', { name: r })).toBeVisible();
    await region.getByRole('radio', { name: 'Middle East' }).check();
    await expect(region.getByText('Region saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('region-settings').getByRole('radio', { name: 'Middle East' })).toBeChecked();

    await page.goto('/sellers/u-sell1-0000-4000-8000-000000000002');
    await expect(page.getByTestId('sp-region')).toHaveText('Europe');
    await expect(page.getByRole('main')).not.toContainText(/Germany|Egypt|United States/);
  });

  test('Arabic: the region names are translated', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.getByLabel('Language', { exact: true }).first().selectOption('ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.goto('/account');
    for (const r of ['آسيا', 'الشرق الأوسط', 'أمريكا', 'أوروبا', 'عالمي']) await expect(page.getByTestId('region-settings').getByText(r, { exact: true })).toBeVisible();
  });
});

test.describe('connection country (never shown)', () => {
  test('connecting from Egypt hides crypto: “This payment method isn’t available here yet”; elsewhere it’s back', async ({ page }) => {
    await signIn(page, 'Buyer');
    await connectFrom(page, 'EG');
    await page.goto('/offers/offer-2');
    await expect(page.getByTestId('pay-unavailable')).toHaveText('This payment method isn’t available here yet — you can still browse and sell.');
    await expect(page.getByRole('button', { name: /Buy now/ })).toHaveCount(0);
    await expect(page.getByRole('main')).not.toContainText('Egypt');
    await connectFrom(page, null);
    await page.reload();
    await expect(page.getByTestId('pay-unavailable')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Buy now/ })).toBeVisible();
  });

  test('a sanctioned connection can’t sign up: “Bullizard isn’t available here”', async ({ page }) => {
    await page.goto('/login');
    await connectFrom(page, 'CU');
    await openSignUp(page, 'Blocked Trader');
    await page.getByRole('checkbox', { name: /18 or older/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText('Bullizard isn’t available here.');
    await expect(page).toHaveURL(/\/login/);
  });
});

test('payout method: country first, then the methods there, then what the method asks for; the withdrawal uses it', async ({ page }) => {
  await signIn(page, 'Seller');
  await page.goto('/sell/money');
  const card = page.locator('#payout-address');
  await expect(card.getByTestId('payout-current')).toContainText('Tether (TRC-20)');
  const country = card.locator('input[name="withdrawCountry"]');

  await country.fill('Cub');
  await page.getByRole('listbox').getByRole('option', { name: 'Cuba', exact: true }).click();
  await expect(card.getByTestId('withdraw-blocked')).toHaveText('Bullizard isn’t available here.');

  await country.fill('German');
  await page.getByRole('listbox').getByRole('option', { name: 'Germany', exact: true }).click();
  await expect(card.getByTestId('withdraw-methods').getByRole('radio')).toHaveCount(1); // USDT only
  await expect(card.getByRole('radio', { name: /USDT/ })).toBeChecked();
  await expect(card.getByLabel('Address')).toBeVisible();

  await country.fill('Egyp');
  await page.getByRole('listbox').getByRole('option', { name: 'Egypt', exact: true }).click();
  const methods = card.getByTestId('withdraw-methods');
  await expect(methods.getByRole('radio')).toHaveCount(3);
  await expect(methods).toContainText('Fee 6%, min $1.50');
  await methods.getByRole('radio', { name: /Mobile wallet/ }).check();
  await card.getByLabel('Wallet phone number').fill('01012345678');
  await card.getByRole('button', { name: 'Use this method' }).click();
  await expect(page).toHaveURL(/\/sell\/payout-address\/confirm/);
  await page.getByLabel('Code from the email').fill('123456');
  await page.getByRole('button', { name: /Confirm/ }).first().click();
  await expect(page).toHaveURL(/\/sell\/money/); // confirmed: back on the money page
  await expect(page.getByTestId('withdraw-to')).toContainText('Mobile wallet');
  await expect(page.getByTestId('withdraw-to')).toContainText('•••• 5678');
  await page.getByLabel(/Amount in USD/).fill('20');
  await expect(page.getByTestId('withdrawal-fee')).toContainText('You receive$18.50');
  await page.getByLabel(/I checked the address and network/).check();
  await page.getByRole('button', { name: 'Withdraw $20.00' }).click();
  await expect(page.getByText('Awaiting approval').first()).toBeVisible();
});

test('the seller profile shows every badge and the rating', async ({ page }) => {
  await page.goto('/sellers/u-sell1-0000-4000-8000-000000000002');
  await expect(page.getByText('Founding Seller').first()).toBeVisible();
  await expect(page.locator('.sp-head, main').getByText(/Hatchling|Scale|Fang|Basilisk|Dragon/).first()).toBeVisible();
  await expect(page.getByTestId('sp-rating')).toContainText(/\d\.\d\d/);
});

test('there is no cart: no cart button and no checkout page', async ({ page }) => {
  await signIn(page, 'Buyer');
  await page.goto('/offers/offer-2');
  await expect(page.getByRole('button', { name: /cart/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /cart/i })).toHaveCount(0);
  await page.goto('/checkouts/abc/pay');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('a 503 with a known code shows the server’s own message, not “Something broke”', async ({ page }) => {
  await signIn(page, 'Buyer');
  // Before the app's own scripts on the next load, so the running demo can't write its state over the change.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('r29.paused')) return;
    sessionStorage.setItem('r29.paused', '1');
    const key = 'bz.demo.v30';
    const s = JSON.parse(localStorage.getItem(key)!);
    s.controls.pause_orders = true;
    s.controls.pause_message = 'New orders are back at 14:00 UTC.';
    localStorage.setItem(key, JSON.stringify(s));
  });
  await page.goto('/offers/offer-2');
  await page.getByRole('button', { name: /Buy now/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Delivery method' });
  if (await dialog.waitFor({ timeout: 2_000 }).then(() => true, () => false)) {
    const input = dialog.getByLabel('Character name');
    if (await input.count()) await input.fill('TestChar_01');
    await dialog.getByRole('button', { name: /Buy now|Continue/ }).last().click();
  }
  await expect(page.getByText('New orders are back at 14:00 UTC.').first()).toBeVisible();
  await expect(page.getByText(/Something broke/)).toHaveCount(0);
});

test.describe('Ops', () => {
  test('Compliance: the sanctions lists show their date and can be refreshed', async ({ page }) => {
    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Compliance' }).click();
    const lists = page.getByTestId('sanctions-lists');
    await expect(lists).toBeVisible();
    await lists.getByRole('button', { name: 'Refresh sanctions lists' }).click();
    await expect(page.getByText(/Lists refreshed: 1 changed, 4 sellers re-screened\./)).toBeVisible();
  });

  test('Payouts: a failed send shows the provider’s real error; staging can mark it sent by hand', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell/money');
    await page.getByLabel(/Amount in USD/).fill('20');
    await page.getByLabel(/I checked the address and network/).check();
    await page.getByRole('button', { name: 'Withdraw $20.00' }).click();
    await expect(page.getByText('Awaiting approval').first()).toBeVisible();

    await signIn(page, 'Admin');
    await page.evaluate(() => localStorage.setItem('bz.demo.payoutOutcome', 'error'));
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Payouts' }).click();
    const row = page.getByRole('row', { name: /NorthWind Keys/ }).first();
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('status').filter({ hasText: /NOWPayments 403: .*IP_NOT_WHITELISTED/ })).toBeVisible();
    await expect(page.getByTestId('payout-provider-error').first()).toContainText('IP_NOT_WHITELISTED');

    // Staging only: record the payout sent by hand (one asks, the other role confirms).
    const stuck = page.getByRole('row', { name: /NorthWind Keys.*Provider error/ }).first();
    await stuck.getByRole('button', { name: 'Resolve' }).click();
    const panel = page.getByRole('dialog', { name: /Withdrawal · NorthWind Keys/ });
    await expect(panel.getByText(/IP_NOT_WHITELISTED/).first()).toBeVisible();
    await expect(panel.getByText('Staging only')).toBeVisible();
    await panel.getByLabel(/Transaction ID/).fill('0xabc1234567890def');
    await panel.getByLabel(/Note on the manual send/).fill('Sent from the treasury wallet');
    await panel.getByRole('button', { name: 'Mark as sent manually' }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'A second person (Finance + Lead) must confirm' })).toBeVisible();
  });
});

test('support links: footer “Contact support” + “My requests”, and the order page', async ({ page }) => {
  await signIn(page, 'Buyer');
  const footer = page.getByRole('contentinfo');
  await expect(footer.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support/new');
  await expect(footer.getByRole('link', { name: 'My requests' })).toHaveAttribute('href', '/support');
  await page.goto('/orders');
  await page.locator('a[href^="/orders/"]').first().click();
  const link = page.getByTestId('order-support').getByRole('link', { name: 'Contact support' });
  await expect(link).toHaveAttribute('href', /\/support\/new\?category=order&order=/);
  await link.click();
  await expect(page).toHaveURL(/\/support\/new/);
  await signOut(page);
});
