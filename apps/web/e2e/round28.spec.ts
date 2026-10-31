import { expect, test, type Page } from '@playwright/test';
import { buyNow, fillCharacter, pickCoin, signIn } from './helpers';

/** Change the demo's saved listings before the app loads them. */
async function patchOffers(page: Page, patch: Record<string, Record<string, unknown>>) {
  await page.addInitScript((p) => {
    const raw = localStorage.getItem('bz.demo.v29');
    if (!raw) return;
    const s = JSON.parse(raw);
    for (const [id, fields] of Object.entries(p)) Object.assign(s.offers.find((o: { id: string }) => o.id === id) ?? {}, fields);
    localStorage.setItem('bz.demo.v29', JSON.stringify(s));
  }, patch);
}

test.describe('Round 28', () => {
  test('a payment received but not applied for 60 s says so and offers support with the order number', async ({ page }) => {
    await page.clock.install();
    await signIn(page, 'Buyer');
    await page.evaluate(() => localStorage.setItem('bz.demo.cryptoOutcome', 'stuck'));
    await page.goto('/offers/offer-7');
    await fillCharacter(page);
    await buyNow(page);
    await page.waitForURL(/\/orders\/.*pay=crypto/);
    const orderId = page.url().split('/orders/')[1]!.split(/[?#]/)[0]!;
    await pickCoin(page);
    await page.clock.runFor(6_000); // the demo network confirms; the next poll sees "received"
    await expect(page.getByTestId('pay-confirming')).toBeVisible();
    await page.clock.runFor(61_000);
    const slow = page.getByTestId('pay-slow');
    await expect(slow).toContainText('This is taking longer than usual');
    await expect(slow).toContainText(/Your order number: \S+/);
    await expect(slow.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', `/support/new?category=order&order=${orderId}`);
    await expect(page.getByTestId('pay-confirming')).toHaveCount(0);
  });

  test('checkout shows the payment processing fee as its own line; no network-fee estimates', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-7');
    await fillCharacter(page);
    await buyNow(page);
    await page.waitForURL(/\/orders\/.*pay=crypto/);
    const fee = page.getByTestId('processing-fee');
    await expect(page.getByText('Payment processing fee')).toBeVisible();
    const cents = (s: string) => Math.round(Number(s.replace(/[^0-9.]/g, '')) * 100);
    const price = cents(await page.locator('.pg-summary .pg-rows > div').first().locator('.num').innerText());
    const feeCents = cents(await fee.innerText());
    expect(feeCents).toBe(Math.ceil((price * 50) / 10_000)); // 0.5 %, rounded up to the cent
    expect(cents(await page.getByTestId('to-pay').innerText())).toBe(price + feeCents);
    // The coin list has no network-fee lines or per-coin totals.
    const checkout = page.locator('.crypto-checkout');
    await expect(checkout.locator('.pg-coins h3')).toBeVisible();
    if (await checkout.getByRole('heading', { name: 'Choose payment method' }).count()) await checkout.getByTestId('method-crypto').click();
    await expect(checkout.getByRole('heading', { name: /^(Pay in|Choose a coin)$/ })).toBeVisible();
    if (await checkout.getByRole('heading', { name: 'Pay in' }).count()) await checkout.getByTestId('invoice-USD').click();
    await expect(checkout.locator('.pg-coin').first()).toBeVisible();
    await expect(checkout).not.toContainText(/network fee/i);
    await expect(checkout.locator('.pg-coin-total')).toHaveCount(0);
    await expect(checkout.getByTestId('pay-due')).toContainText(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((price + feeCents) / 100));
  });

  test('below the minimum the minimum is the stock left; sold out leaves the market and can’t be bought', async ({ page }) => {
    await patchOffers(page, { 'offer-7': { min_qty: 30, stock: 20 }, 'offer-14': { stock: 0 } });
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-7');
    await expect(page.locator('#of-qty')).toHaveValue('20');
    await expect(page.locator('.of-unitprice')).toContainText('Min. 20');
    await expect(page.getByRole('button', { name: /Buy now/ })).toBeEnabled();
    await page.goto('/offers/offer-14');
    await expect(page.getByTestId('sold-out')).toBeVisible();
    await expect(page.getByRole('button', { name: /Buy now/ })).toHaveCount(0);
    await page.goto('/games/counter-strike-2/items');
    await expect(page.getByText('AK-47 | Redline (Field-Tested)')).toHaveCount(0);
  });
});
