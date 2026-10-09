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

/** Buy a listing through the demo hosted checkout; ends on the order page. */
export async function buy(page: Page, offerPath: string) {
  await page.goto(offerPath);
  await page.getByLabel(/I accept the Terms of Service/).check();
  await page.getByRole('button', { name: /Pay .* into escrow/ }).click();
  await page.waitForURL(/demo-checkout/);
  await page.getByRole('button', { name: /^Pay / }).click();
  await page.waitForURL(/\/orders\//);
}
