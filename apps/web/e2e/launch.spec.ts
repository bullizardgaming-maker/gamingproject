import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('launch extras', () => {
  test('Founding Sellers carry a badge and feature listings for free; featured listings lead the market', async ({ page }) => {
    await page.goto('/market?category=keys&sort=newest');
    const first = page.getByRole('listitem').first();
    await expect(first).toContainText('Elden Ring — Steam key (Global)'); // featured, though not the newest
    await expect(first.getByTestId('featured-chip')).toBeVisible();
    await expect(first.getByTestId('founding-badge')).toBeVisible();
    await page.goto('/sellers/u-sell1-0000-4000-8000-000000000002');
    await expect(page.getByTestId('founding-badge')).toBeVisible();

    await signIn(page, 'Seller');
    await page.goto('/sell');
    await expect(page.getByTestId('founding-card')).toContainText('1 of 2 free featured spots in use');
    const row = page.getByRole('row', { name: /Baldur’s Gate 3/ }).or(page.getByRole('row', { name: /Cyberpunk 2077/ })).first();
    await row.getByRole('button', { name: 'Feature' }).click();
    await expect(page.getByTestId('founding-card')).toContainText('2 of 2 free featured spots in use');
    await expect(page.getByRole('button', { name: 'Feature', exact: true }).first()).toBeDisabled();
    await row.getByRole('button', { name: 'Unfeature' }).click();
    await expect(page.getByTestId('founding-card')).toContainText('1 of 2 free featured spots in use');
  });

  test('anyone signed in can suggest and vote for the next game', async ({ page }) => {
    await page.goto('/games');
    await page.getByRole('link', { name: 'Vote for the next game' }).click();
    await expect(page.getByRole('heading', { name: 'Which game next?' })).toBeVisible();
    await expect(page.getByTestId('vote-board')).toContainText('Lost Ark');
    await expect(page.getByTestId('vote-board').getByText('Planned')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vote for Lost Ark' })).toBeDisabled(); // signed out

    await signIn(page, 'Buyer');
    await page.goto('/games/vote');
    const tl = page.getByRole('button', { name: 'Vote for Throne and Liberty' });
    await expect(tl).toContainText('97');
    await tl.click();
    await expect(tl).toContainText('98');
    await expect(tl).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Suggest a game').fill('Guild Wars 2');
    await page.getByRole('button', { name: 'Add and vote' }).click();
    await expect(page.getByRole('button', { name: 'Vote for Guild Wars 2' })).toContainText('1');
    await page.getByLabel('Suggest a game').fill('Valorant');
    await page.getByRole('button', { name: 'Add and vote' }).click();
    await expect(page.getByRole('alert')).toContainText('already on the market');
  });

  test('a buyer applies a creator code once; finance manages codes', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/account');
    const card = page.getByTestId('creator-code');
    await card.getByPlaceholder('e.g. STREAMER-X').fill('nope-1');
    await card.getByRole('button', { name: 'Apply code' }).click();
    await expect(card.getByRole('alert')).toContainText('not valid');
    await card.getByPlaceholder('e.g. STREAMER-X').fill('arcane-tv');
    await card.getByRole('button', { name: 'Apply code' }).click();
    await expect(card.getByRole('status')).toContainText('Code ARCANE-TV is on your account');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Creator codes' }).click();
    const table = page.getByRole('table', { name: 'Creator codes' });
    await expect(table).toContainText('ARCANE-TV');
    await expect(table.getByRole('row', { name: /ARCANE-TV/ })).toContainText('1'); // one buyer
    await table.getByRole('button', { name: 'Pause' }).click();
    await expect(table.getByRole('row', { name: /ARCANE-TV/ }).getByText('Paused')).toBeVisible();
  });

  test('the chat warns in the launch wording and lets account handovers carry an email', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/orders');
    await page.getByRole('link', { name: /Diamond 1 smurf/ }).first().click();
    // Human order ID, the official order card and the staff-managed safety panel.
    await expect(page.getByTestId('order-ref')).toContainText(/order#[A-Z2-9]{7}/);
    const card = page.getByTestId('order-card').first();
    await expect(card).toContainText('Bullizard');
    await expect(card).toContainText(/order#[A-Z2-9]{7}/);
    await expect(page.getByTestId('order-card').last()).toContainText('Delivered');
    const safety = page.getByTestId('safety-panel');
    await expect(safety).toContainText('Keep the whole trade in this chat.');
    await safety.getByRole('button', { name: /Stay safe/ }).click();
    await expect(safety).not.toContainText('Keep the whole trade in this chat.');
    await safety.getByRole('button', { name: /Stay safe/ }).click();
    await page.getByPlaceholder(/Write a message/).fill('Recovery email is pat@example.com, please add it');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Recovery email is pat@example.com, please add it')).toBeVisible();
    // The safety panel carries the same sentence; no warning message was posted in the log.
    await expect(page.locator('.msg.warning')).toHaveCount(0);
    // Outside contact is blocked, not delivered: the sender sees "Not sent".
    await page.getByPlaceholder(/Write a message/).fill('or d1scord me: pat#1234');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Not sent. Sharing outside contacts can get your account banned right away.')).toBeVisible();
    await expect(page.locator('.msg', { hasText: 'd1scord' })).toHaveCount(0);
  });
});
