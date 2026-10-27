import { expect, type Page } from '@playwright/test';

export type DemoAccount = 'Buyer' | 'Seller' | 'Admin';

/** Sign in with one of the demo accounts on the login page. */
export async function signIn(page: Page, who: DemoAccount) {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(who) }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Fails on uncaught page errors (console noise from blocked fonts is ignored). */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return () => expect(errors, errors.join('\n')).toEqual([]);
}

export async function expectNoHorizontalScroll(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
}

/** Games that deliver in-game: the details are asked in the delivery pop-up after Buy now (Round 24). Waits for the buy box. */
export async function fillCharacter(page: Page, _name = 'TestChar_01') {
  await expect(page.getByRole('button', { name: /Buy now/ })).toBeVisible();
}

/** Buy now; when the delivery pop-up opens, pick the first method, fill what it asks and continue. */
export async function buyNow(page: Page, name = 'TestChar_01', save = true) {
  await page.getByRole('button', { name: /Buy now/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Delivery method' });
  if (!(await dialog.waitFor({ timeout: 2_000 }).then(() => true, () => false))) return;
  const input = dialog.getByLabel('Character name');
  if (await input.count()) await input.fill(name);
  const city = dialog.getByLabel('City');
  if (await city.count()) await city.selectOption({ index: 1 });
  if (!save) await dialog.getByLabel('Save for my next purchase').uncheck();
  await dialog.getByRole('button', { name: 'Continue to checkout' }).click();
}

/** Pay the crypto checkout on the current page (order or cart): pick a coin, then the demo network confirms it. */
export async function payCrypto(page: Page) {
  const checkout = page.locator('.crypto-checkout');
  await pickCoin(page);
  await expect(checkout.getByText('Waiting for your transfer')).toBeVisible();
  await expect(checkout).toHaveCount(0, { timeout: 20_000 });
}

/** Buy a listing: order page → crypto checkout → paid; ends on the order page. */
export async function buy(page: Page, offerPath: string) {
  await page.goto(offerPath);
  await fillCharacter(page);
  await buyNow(page);
  await page.waitForURL(/\/orders\/.*pay=crypto/);
  await payCrypto(page);
}

/** Sign out from the account menu in the top bar. */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
}

/** Pay (Round 24b): pick Crypto as the payment method, then a coin from the list. */
export async function pickCoin(page: Page, coin: RegExp = /Tether \(TRC-20\)/) {
  const checkout = page.locator('.crypto-checkout');
  await expect(checkout.locator('.pg-coins h3')).toBeVisible();
  if (await checkout.getByRole('heading', { name: 'Payment method' }).count()) await checkout.getByRole('button', { name: /^Crypto/ }).click();
  await checkout.getByRole('button', { name: coin }).click();
}

/**
 * Round 24: the order page has no dispute form. From the order page the buyer writes to support about the order;
 * then an Admin opens the dispute from the ticket (Operations → Support). Ends signed in as Admin on the ticket;
 * returns the order page URL.
 */
export async function disputeViaSupport(page: Page, subject: string, details: string, reason = 'Not delivered') {
  const orderUrl = page.url().replace(/\?.*$/, '');
  const orderId = orderUrl.split('/orders/')[1]!;
  await page.goto(`/support/new?category=order&order=${orderId}`);
  await page.locator('input[name=subject]').fill(subject);
  await page.locator('textarea[name=body]').fill(details);
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();

  await signIn(page, 'Admin');
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Support' }).click();
  await page.getByRole('button', { name: subject }).click();
  await page.getByLabel('Dispute reason').selectOption({ label: reason });
  await page.getByRole('button', { name: 'Open dispute from this ticket' }).click();
  await expect(page.getByTestId('ticket-dispute')).toContainText('open');
  return orderUrl;
}
