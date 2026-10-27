import { expect, test } from '@playwright/test';
import { buy, disputeViaSupport, signIn, signOut } from './helpers';

/** CEO decisions of Oct 23: terms line instead of a checkbox, recurring referral, no seller API, translated chat notices. */
test.describe('launch decisions', () => {
  test('buy box has no checkbox and no terms line: buyers agreed at sign-up (Round 24)', async ({ page }) => {
    await signIn(page, 'Buyer');
    await page.goto('/offers/offer-1');
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByTestId('buy-agree')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Buy now/ })).toBeEnabled();
    await page.goto('/terms');
    await expect(page.getByRole('heading', { name: 'Terms of Service' })).toBeVisible();
    await expect(page.getByTestId('legal-version')).toContainText('Version 2026-10-24');
    await expect(page.getByText(/You must be 18 or older/)).toBeVisible();
    await page.goto('/terms/history');
    await expect(page.getByRole('link', { name: '2026-10-24' })).toBeVisible();
  });

  test('home invites with 20% of our commission and the account page shows the link and earnings', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Invite friends. Earn 20% of our fee.' })).toBeVisible();
    await signIn(page, 'Buyer');
    await page.goto('/account');
    const card = page.getByTestId('invite-friends');
    await expect(card.getByText(/one code per account, at sign-up only/)).toBeVisible();
    await expect(card.getByTestId('invite-link')).toContainText('/login?ref=BZ');
    await expect(card.getByText('$0.68', { exact: true })).toBeVisible(); // two paid orders of one friend
  });

  // Round 24: disputes open from support (staff open them from the buyer's ticket), not the order page.
  test('chat notices from the server come as codes and read in the chosen language', async ({ page }) => {
    await signIn(page, 'Buyer');
    await buy(page, '/offers/offer-14'); // manual delivery
    const orderUrl = await disputeViaSupport(page, 'Paid an hour ago and nothing was traded yet', 'Nothing has arrived since I paid.');
    await signIn(page, 'Buyer');
    await page.goto(orderUrl);
    await page.getByPlaceholder(/Your side for the arbiter/).fill('My trade link is in the chat; nothing has arrived.');
    await page.getByRole('button', { name: 'Add statement' }).click();
    await expect(page.getByText('The buyer added a statement to the dispute. The arbiter reads both sides’ statements with this chat.')).toBeVisible();
    await page.getByLabel('Language', { exact: true }).first().selectOption('ar');
    await expect(page.getByText('أضاف المشتري إفادة إلى النزاع. يقرأ المحكّم إفادات الطرفين مع هذه المحادثة.')).toBeVisible();
  });

  test('there is no seller API: no Developers page, with or without the full catalogue (Round 23c)', async ({ page }) => {
    for (const full of [false, true]) {
      await page.goto('/');
      await page.evaluate((on) => (on ? localStorage.setItem('bz-demo-full', '1') : localStorage.removeItem('bz-demo-full')), full);
      await page.goto('/developers');
      await expect(page.getByRole('heading', { name: /not found/i })).toBeVisible();
      await expect(page.getByRole('link', { name: /developers|seller api/i })).toHaveCount(0);
    }
  });

  test('sign-up needs the 18+ / Terms / Privacy box; legal pages are linked from the footer and help centre', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'New here? Create an account' }).click();
    const box = page.getByRole('checkbox', { name: /18 or older/ });
    await expect(box).toBeVisible();
    await expect(page.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    await page.locator('input[name=displayName]').fill('New Trader');
    await page.locator('input[name=email]').fill(`new-${Date.now()}@example.com`);
    await page.locator('input[name=password]').fill('correct horse battery');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/login/); // the browser refuses the form until the box is ticked
    await box.check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/account/);

    const footer = page.getByRole('contentinfo');
    await footer.getByRole('link', { name: 'Restricted countries' }).click();
    await expect(page.getByTestId('legal-restricted-countries')).toContainText('Version 2026-10-24');
    await expect(footer.getByText('18+ only. Not affiliated with any game publisher.')).toBeVisible();
    await footer.getByRole('link', { name: 'Seller Agreement' }).click();
    await expect(page.getByRole('heading', { name: 'Seller Agreement' })).toBeVisible();
  });
});

test.describe('damage limits (launch gate §4)', () => {
  test('an admin pauses sign-ups from Ops → Controls; the banner shows and sign-up is refused; resume clears it', async ({ page }) => {
    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Controls' }).click();
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('switch-pause_signups').click();
    await expect(page.getByRole('status').filter({ hasText: 'PAUSED' })).toBeVisible();
    await page.goto('/market');
    await expect(page.getByTestId('paused-banner')).toContainText('sign-ups');
    await signOut(page);
    await page.goto('/login');
    await page.getByRole('button', { name: 'New here? Create an account' }).click();
    await page.locator('input[name=displayName]').fill('Late Comer');
    await page.locator('input[name=email]').fill(`late-${Date.now()}@example.com`);
    await page.locator('input[name=password]').fill('correct horse battery');
    await page.getByRole('checkbox', { name: /18 or older/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText('Sign-ups are paused');
    await signIn(page, 'Admin');
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Controls' }).click();
    await page.getByTestId('switch-pause_signups').click();
    await expect(page.getByRole('status').filter({ hasText: 'resumed' })).toBeVisible();
  });

  test('Round 22: when GET /categories fails, no category is shown and a retry brings them back', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('bz.demo.fail', 'categories'));
    await page.goto('/games');
    const retry = page.getByTestId('categories-retry');
    await expect(retry).toBeVisible();
    const cats = page.getByRole('group', { name: 'Category' }).getByRole('button');
    await expect(cats).toHaveCount(1); // only "Everything": never the full list, which would show closed categories
    await page.evaluate(() => localStorage.removeItem('bz.demo.fail'));
    await retry.getByRole('button', { name: 'Try again' }).click();
    await expect(retry).toHaveCount(0);
    await expect(cats.filter({ hasText: 'Accounts' })).toBeVisible();
  });
});
