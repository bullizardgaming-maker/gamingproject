import { expect, test } from '@playwright/test';
import { buy, disputeViaSupport, payCrypto, signIn, fillCharacter, buyNow } from './helpers';

test.describe('crypto money paths', () => {
  test('buyer pays with a coin that fits the amount, the order funds, and the seller is held until confirmation', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-1'); // Elden Ring key, $32.50 to the buyer
    await buyNow(page);
    await page.waitForURL(/pay=crypto/);
    const checkout = page.locator('.crypto-checkout');
    await expect(checkout.getByRole('heading', { name: 'Pay with crypto' })).toBeVisible();
    // Round 25: payment method first (only Crypto for the beta), then the invoice currency, then the coin.
    await expect(checkout.getByRole('heading', { name: 'Choose payment method' })).toBeVisible();
    await checkout.getByTestId('method-crypto').click();
    await checkout.getByTestId('invoice-USD').click();
    await expect(checkout.getByRole('button', { name: /Bitcoin/ })).toBeVisible();
    await expect(checkout.getByRole('button', { name: /Ethereum/ })).toBeVisible();
    await checkout.getByRole('button', { name: /Bitcoin/ }).click();
    await expect(checkout.getByTestId('pay-address')).toContainText(/^bc1q/);
    await expect(checkout.getByTestId('pay-amount')).toContainText(/BTC$/);
    await expect(checkout).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('.od-amount')).toHaveText('$32.50'); // no "Paid via" line (Round 24)
  });

  test('coins whose minimum is above a small order are greyed out with the reason', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-15'); // Diablo IV item, $12.50
    await fillCharacter(page);
    await buyNow(page);
    await page.waitForURL(/pay=crypto/);
    const checkout = page.locator('.crypto-checkout');
    await checkout.getByTestId('method-crypto').click();
    await checkout.getByTestId('invoice-USD').click();
    await expect(checkout.getByRole('button', { name: /Tether \(TRC-20\)/ })).toBeEnabled();
    const monero = checkout.getByRole('button', { name: /Monero/ }); // $15 minimum
    await expect(monero).toBeDisabled();
    await expect(monero).toContainText("Order is below this coin's minimum ($15.00)");
    await checkout.getByRole('button', { name: /Tether \(TRC-20\)/ }).click();
    await expect(checkout.getByText('Waiting for your transfer')).toBeVisible();
    await expect(checkout).toHaveCount(0, { timeout: 20_000 });
  });

  test('the buyer’s balance is spent first and the summary shows what is left to pay', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.evaluate(() => (window as any).__bzDemo.credit(5_00));
    await page.goto('/offers/offer-15'); // $12.51 to the buyer
    await fillCharacter(page);
    await buyNow(page);
    await page.waitForURL(/pay=crypto/);
    await expect(page.getByTestId('from-balance')).toHaveText('−$5.00');
    await expect(page.locator('.pg-summary .pg-price')).toHaveText('$7.51');
    await expect(page.locator('.crypto-checkout').getByText('To pay $7.51')).toBeVisible();
    await payCrypto(page);
    await expect(page.locator('.od-amount')).toHaveText('$12.51');

    // The balance now covers a whole order: it is paid at once, no coin step.
    await page.evaluate(() => (window as any).__bzDemo.credit(20_00));
    await page.goto('/offers/offer-15');
    await fillCharacter(page);
    await buyNow(page);
    await page.waitForURL(/\/orders\/[^?]+$/);
    await expect(page.locator('.od-amount')).toHaveText('$12.51');
  });

  test('delivered orders wait for the buyer; the seller asks support, support releases', async ({ page }) => {
    await signIn(page, 'Buyer'); // the buyer's sample history (including the stale delivery) is seeded on their first sign-in
    await signIn(page, 'Seller');
    await page.goto('/orders?as=seller');
    await page.getByRole('link', { name: /100k Gold/ }).first().click();
    await page.waitForURL(/\/orders\/[^/]+$/);
    const orderUrl = page.url();
    await expect(page.getByText('Until the buyer confirms')).toBeVisible();
    await page.getByRole('button', { name: 'Ask support to release the payment' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sent. Staff will check your proof.' })).toBeVisible();

    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Releases' }).click();
    const row = page.getByRole('row', { name: /100k Gold/ });
    await expect(row.getByText(/h ago/)).toBeVisible();
    await row.getByLabel(/Release note/).fill('Trade screenshot in the chat matches the listing');
    await row.getByRole('button', { name: 'Release to seller' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Released to the seller' })).toBeVisible();
    await page.goto(orderUrl);
    await expect(page.getByTestId('order-card')).toContainText('Released');
  });

  test('seller withdrawal shows the fee, waits for the CFO, then pays out', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell/money');
    await expect(page.getByText('Payout address', { exact: true })).toBeVisible();
    await expect(page.getByText(/Tether \(TRC-20\)/).first()).toBeVisible();
    await page.getByLabel(/Amount in USD/).fill('20');
    await expect(page.getByTestId('withdrawal-fee')).toContainText('Fee (6%, minimum $1.50)$1.50');
    await expect(page.getByTestId('withdrawal-fee')).toContainText('You receive$18.50');
    await page.getByLabel(/I checked the address and network/).check();
    await page.getByRole('button', { name: 'Withdraw $20.00' }).click();
    await expect(page.getByText(/requested/).first()).toBeVisible();
    await expect(page.getByText('Awaiting approval').first()).toBeVisible();

    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Payouts' }).click();
    const row = page.getByRole('row', { name: /NorthWind Keys/ }).first();
    await expect(row.getByText('$18.50')).toBeVisible();
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Approved' })).toBeVisible();
  });

  // Round 24: disputes open from support (staff open them from the buyer's ticket), not the order page.
  test('a refund on a crypto order lands in the buyer’s balance (no on-chain refund)', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-7'); // 100k Gold, manual delivery
    const orderUrl = await disputeViaSupport(page, 'No gold arrived and the seller stopped answering', 'Paid by crypto, nothing traded, no reply in the chat.');

    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Disputes' }).click();
    await page.locator('.card', { hasText: 'No gold arrived and the seller stopped answering' }).getByRole('button', { name: 'Open case file' }).click();
    await page.getByRole('button', { name: 'Statements', exact: true }).click();
    await page.getByPlaceholder('Decision note (shared in the order record)').fill('No delivery evidence in the chat.');
    await page.getByRole('button', { name: 'Refund buyer' }).click();
    // The decision is saved once the case leaves the queue (its buttons go with it); only then switch accounts.
    await expect(page.getByRole('button', { name: 'Refund buyer' })).toHaveCount(0);
    await expect(page.getByText('No gold arrived and the seller stopped answering')).toHaveCount(0);

    await signIn(page, 'Buyer');
    await page.goto(orderUrl);
    await expect(page.locator('.od-status')).toHaveText('Refunded to balance');
    await expect(page.getByLabel('Address')).toHaveCount(0); // nothing to send on-chain: the money is balance now
    await page.goto('/wallet');
    await expect(page.getByRole('heading', { name: /Balance/ })).toBeVisible();
  });
});

test.describe('crypto checkout, Round 25', () => {
  test('an EUR invoice uses the held price; a provider outage shows a message and Retry', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('bz.currency', 'EUR'));
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-1');
    await buyNow(page);
    await page.waitForURL(/pay=crypto/);
    const checkout = page.locator('.crypto-checkout');
    await checkout.getByTestId('method-crypto').click();
    await checkout.getByTestId('invoice-EUR').click();
    await expect(checkout.getByTestId('pay-due')).toContainText('€');
    await checkout.getByRole('button', { name: /Tether \(TRC-20\)/ }).click();
    await expect(checkout.getByTestId('pay-breakdown')).toContainText('Invoice: €');
    await expect(checkout).toHaveCount(0, { timeout: 20_000 });

    // The provider is down: a clear message and Retry, never an endless "Loading payment options…".
    await page.evaluate(() => localStorage.setItem('bz.demo.cryptoDown', '1'));
    await page.goto('/offers/offer-1');
    await buyNow(page);
    await page.waitForURL(/pay=crypto/);
    await expect(page.getByTestId('pay-error')).toContainText('Crypto payments are unavailable right now');
    await page.evaluate(() => localStorage.removeItem('bz.demo.cryptoDown'));
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('heading', { name: 'Choose payment method' })).toBeVisible();
  });
});
