import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('account warranty: buyer claims after release, seller answers, an arbiter refunds', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, 'Buyer');
  await page.goto('/offers/offer-9'); // WoW account with a 30-day warranty
  await expect(page.getByText('30-day warranty').first()).toBeVisible();
  // The demo buyer's history includes this account, delivered a day ago and still in escrow.
  await page.goto('/orders');
  await page.getByRole('link', { name: /Lvl 80 Warrior/ }).first().click();
  await page.waitForURL(/\/orders\/[^/]+$/);
  const order = new URL(page.url()).pathname;

  const boxes = page.locator('.checklist input[type=checkbox]');
  await expect(boxes.first()).toBeVisible();
  for (let i = 0; i < (await boxes.count()); i++) {
    await boxes.nth(i).click();
    await expect(boxes.nth(i)).toBeChecked();
  }
  await page.getByRole('button', { name: 'Confirm and release payment' }).click();
  const card = page.locator('section', { has: page.getByRole('heading', { name: '30-day account warranty' }) });
  await expect(card).toBeVisible();
  await card.getByText('Make a warranty claim').click();
  await card.getByLabel('What happened?').selectOption('recovered');
  await card.getByLabel('Details for the seller').fill('The original owner reset the email this morning.');
  await card.getByRole('button', { name: 'Send claim' }).click();
  await expect(card.getByText('Waiting for the seller')).toBeVisible();

  await signIn(page, 'Seller');
  await page.goto(order);
  await card.getByRole('button', { name: 'It’s fixed' }).click();
  await expect(card.getByText('Seller says it’s fixed')).toBeVisible();

  await signIn(page, 'Buyer');
  await page.goto(order);
  await card.getByRole('button', { name: 'Still broken: ask an arbiter' }).click();
  await expect(card.getByText('With an arbiter')).toBeVisible();

  await signIn(page, 'Admin');
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Warranty claims' }).click();
  const claim = page.locator('.card', { hasText: 'The original owner reset the email' });
  await claim.getByLabel('Decision note (shown to both)').fill('Chat shows the email was reset by the previous owner.');
  await claim.getByRole('button', { name: 'Refund buyer' }).click();
  await expect(claim).toHaveCount(0);

  await signIn(page, 'Buyer');
  await page.goto(order);
  await expect(card.getByText('Refunded', { exact: true })).toBeVisible();
  await expect(card.getByText(/Arbiter: Chat shows the email was reset/)).toBeVisible();
});
