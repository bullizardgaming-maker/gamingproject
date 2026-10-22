import { expect, test } from '@playwright/test';
import { buy, payCrypto, signIn, fillCharacter } from './helpers';

test.describe('crypto money paths', () => {
  test('buyer pays with a coin that fits the amount, the order funds, and the seller is held until confirmation', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-1'); // Elden Ring key, $32.50 to the buyer
    await page.getByLabel(/I accept the Terms of Service/).check();
    await page.getByRole('button', { name: /Buy now/ }).click();
    await page.waitForURL(/pay=crypto/);
    const checkout = page.locator('.crypto-checkout');
    await expect(checkout.getByRole('heading', { name: 'Pay with crypto' })).toBeVisible();
    // Coins whose minimum exceeds $32.50 are not offered.
    await expect(checkout.getByRole('button', { name: /Bitcoin/ })).toBeVisible();
    await expect(checkout.getByRole('button', { name: /Ethereum/ })).toBeVisible();
    await checkout.getByRole('button', { name: /Bitcoin/ }).click();
    await expect(checkout.getByTestId('pay-address')).toContainText(/^bc1q/);
    await expect(checkout.getByTestId('pay-amount')).toContainText(/BTC$/);
    await expect(checkout).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(/Paid \$32\.50 via crypto/)).toBeVisible();
  });

  test('coins whose minimum is above a small order are greyed out with the reason', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-15'); // Diablo IV item, $12.50
    await fillCharacter(page);
    await page.getByLabel(/I accept the Terms of Service/).check();
    await page.getByRole('button', { name: /Buy now/ }).click();
    await page.waitForURL(/pay=crypto/);
    const checkout = page.locator('.crypto-checkout');
    await expect(checkout.getByRole('button', { name: /Tether \(TRC-20\)/ })).toBeEnabled();
    const monero = checkout.getByRole('button', { name: /Monero/ }); // $15 minimum
    await expect(monero).toBeDisabled();
    await expect(monero).toContainText('Too small for this coin (min $15.00)');
    await payCrypto(page);
  });

  test('the buyer’s balance is spent first and the summary shows what is left to pay', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.evaluate(() => (window as any).__bzDemo.credit(5_00));
    await page.goto('/offers/offer-15'); // $12.51 to the buyer
    await fillCharacter(page);
    await page.getByLabel(/I accept the Terms of Service/).check();
    await page.getByRole('button', { name: /Buy now/ }).click();
    await page.waitForURL(/pay=crypto/);
    await expect(page.getByTestId('from-balance')).toHaveText('−$5.00');
    await expect(page.locator('.pg-summary .pg-price')).toHaveText('$7.51');
    await expect(page.locator('.crypto-checkout').getByText('To pay $7.51')).toBeVisible();
    await payCrypto(page);
    await expect(page.getByText(/Paid \$12\.51 via crypto/)).toBeVisible();

    // The balance now covers a whole order: it is paid at once, no coin step.
    await page.evaluate(() => (window as any).__bzDemo.credit(20_00));
    await page.goto('/offers/offer-15');
    await fillCharacter(page);
    await page.getByLabel(/I accept the Terms of Service/).check();
    await page.getByRole('button', { name: /Buy now/ }).click();
    await page.waitForURL(/\/orders\/[^?]+$/);
    await expect(page.getByText(/Paid \$12\.51/)).toBeVisible();
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
    await expect(page.getByRole('status').filter({ hasText: 'Support has your request' })).toBeVisible();

    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Releases' }).click();
    const row = page.getByRole('row', { name: /100k Gold/ });
    await expect(row.getByText(/h ago/)).toBeVisible();
    await row.getByLabel(/Release note/).fill('Trade screenshot in the chat matches the listing');
    await row.getByRole('button', { name: 'Release to seller' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Released to the seller' })).toBeVisible();
    await page.goto(orderUrl);
    await expect(page.getByText('Order completed').first()).toBeVisible();
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

  test('a refund on a crypto order asks the buyer for an address and the CFO records the transaction', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-7'); // 100k Gold, manual delivery
    const orderUrl = page.url().replace(/\?.*$/, '');
    await page.getByText('Open a dispute', { exact: true }).click();
    await page.getByLabel("What's the problem?").selectOption('not_delivered');
    await page.getByPlaceholder(/What happened\?/).fill('No gold arrived and the seller stopped answering in the chat.');
    await page.getByRole('button', { name: 'Open dispute' }).click();
    await expect(page.getByText('Buyer statement')).toBeVisible();

    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Disputes' }).click();
    await page.locator('.card', { hasText: 'No gold arrived and the seller stopped answering' }).getByRole('button', { name: 'Open case file' }).click();
    await page.getByRole('button', { name: 'Statements', exact: true }).click();
    await page.getByPlaceholder('Decision note (shared in the order record)').fill('No delivery evidence in the chat.');
    await page.getByRole('button', { name: 'Refund buyer' }).click();
    await expect(page.getByText('No gold arrived and the seller stopped answering')).toHaveCount(0);

    await signIn(page, 'Buyer');
    await page.goto(orderUrl);
    await page.getByLabel('Address').fill('TBuyerRefundAddress123456');
    await page.getByRole('button', { name: 'Send my refund here' }).click();
    await expect(page.getByText(/The treasury sends it to/)).toBeVisible();

    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Crypto refunds' }).click();
    const rr = page.getByRole('row', { name: /Pixel Pat/ }).first();
    await rr.getByLabel(/Transaction hash/).fill('0xabc123def456');
    await rr.getByRole('button', { name: 'Mark sent' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Recorded' })).toBeVisible();
  });
});
