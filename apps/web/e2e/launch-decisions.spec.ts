import { expect, test } from '@playwright/test';
import { buy, signIn } from './helpers';

/** CEO decisions of Oct 23: terms line instead of a checkbox, recurring referral, hidden Merchant API, translated chat notices. */
test.describe('launch decisions', () => {
  test('buy box has no checkbox: one line under Buy now linking to the Terms page', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-1');
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    const line = page.getByTestId('buy-agree');
    await expect(line).toHaveText('By buying you agree to the Terms');
    await expect(page.getByRole('button', { name: /Buy now/ })).toBeEnabled();
    await line.getByRole('link', { name: 'Terms' }).click();
    await expect(page).toHaveURL(/\/terms$/);
    await expect(page.getByRole('heading', { name: 'Terms of Service' })).toBeVisible();
    await expect(page.getByText('You must be 18 or older.')).toBeVisible();
  });

  test('home invites with 20% of our commission and the account page shows the link and earnings', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Earn 20% of our commission on every friend’s order' })).toBeVisible();
    await signIn(page, 'Buyer');
    await page.goto('/account');
    const card = page.getByTestId('invite-friends');
    await expect(card.getByText(/You earn 20% of Bullizard’s commission on every order your friends make/)).toBeVisible();
    await expect(card.getByTestId('invite-link')).toContainText('/login?ref=BZ');
    await expect(card.getByText('$0.68', { exact: true })).toBeVisible(); // two paid orders of one friend
    await page.goto('/help/invite-friends');
    await expect(page.getByRole('heading', { name: 'Invite friends and earn' })).toBeVisible();
  });

  test('chat notices from the server come as codes and read in the chosen language', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-14'); // manual delivery
    await page.getByText('Open a dispute', { exact: true }).click();
    await page.getByLabel("What's the problem?").selectOption('not_delivered');
    await page.getByPlaceholder(/What happened\?/).fill('Paid an hour ago and nothing was traded yet.');
    await page.getByRole('button', { name: 'Open dispute' }).click();
    await page.getByPlaceholder(/Add your statement/).fill('My trade link is in the chat; nothing has arrived.');
    await page.getByRole('button', { name: 'Add statement' }).click();
    await expect(page.getByText('The buyer added a statement to the dispute. The arbiter reads both sides’ statements with this chat.')).toBeVisible();
    await page.getByLabel('Language', { exact: true }).first().selectOption('ar');
    await expect(page.getByText('أضاف المشتري إفادة إلى النزاع. يقرأ المحكّم إفادات الطرفين مع هذه المحادثة.')).toBeVisible();
  });

  test('the Merchant API is hidden at launch and on with the full catalogue', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('bz-demo-full'));
    await page.goto('/developers');
    await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
    await page.evaluate(() => localStorage.setItem('bz-demo-full', '1'));
    await page.goto('/developers');
    await expect(page.getByText(/API/).first()).toBeVisible();
  });
});
