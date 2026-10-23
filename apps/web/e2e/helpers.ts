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

/** Games that deliver in-game ask for the buyer's character name (or UID) before paying. */
export async function fillCharacter(page: Page, name = 'TestChar_01') {
  // The buy box (and with it the field) renders once the listing has loaded.
  await expect(page.getByRole('button', { name: /Buy now/ })).toBeVisible();
  const field = page.getByTestId('character-field');
  if (!(await field.count())) return;
  const input = field.getByRole('textbox');
  if (await input.count()) await input.fill(name);
  else await field.getByRole('button', { name: /Confirm/ }).click();
}

/** Pay the crypto checkout on the current page (order or cart): pick a coin, then the demo network confirms it. */
export async function payCrypto(page: Page) {
  const checkout = page.locator('.crypto-checkout');
  await checkout.getByRole('button', { name: /Tether \(TRC-20\)/ }).click();
  await expect(checkout.getByText('Waiting for your transfer')).toBeVisible();
  await expect(checkout).toHaveCount(0, { timeout: 20_000 });
}

/** Buy a listing: order page → crypto checkout → paid; ends on the order page. */
export async function buy(page: Page, offerPath: string) {
  await page.goto(offerPath);
  await fillCharacter(page);
  await page.getByRole('button', { name: /Buy now/ }).click();
  await page.waitForURL(/\/orders\/.*pay=crypto/);
  await payCrypto(page);
}

/** Sign out from the account menu in the top bar. */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
}
