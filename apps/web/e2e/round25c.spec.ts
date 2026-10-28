import { expect, test } from '@playwright/test';
import { signIn, signOut } from './helpers';

test.describe('sign-in code and "You\'re in" (Round 25c)', () => {
  test('two-step sign-in: six code boxes, a wrong recovery code, then "You\'re in" and on to the shop', async ({ page }) => {
    // Turn on two-factor login for the demo buyer (any 6 digits work in the demo).
    await signIn(page, 'Buyer');
    await page.goto('/account');
    await page.getByRole('button', { name: 'Set up two-factor login' }).click();
    await page.getByPlaceholder('6-digit code').fill('123456');
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByText('On. Signing in asks for a code from your authenticator app.')).toBeVisible();
    await signOut(page);

    await page.clock.install();
    await page.goto('/login');
    await page.getByLabel('Email').fill('buyer@demo.test');
    await page.getByLabel('Password').fill('demo-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Enter your sign-in code' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Sign-in code' }).getByRole('textbox')).toHaveCount(6);

    // A wrong recovery code shows the error and keeps the buyer on the code step.
    await page.getByRole('button', { name: 'Use a recovery code' }).click();
    await page.getByLabel('Recovery code').fill('nope');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Wrong or expired code');
    await page.getByRole('button', { name: 'Use the 6-digit code' }).click();

    // Six digits (pasted here) send themselves; "You're in" shows, then the shop opens.
    await page.getByLabel('Digit 1 of 6').focus();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text', '123456');
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId('youre-in')).toContainText("You're in");
    await page.clock.fastForward(2000);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
  });

  test('a plain sign-in also says "You\'re in" before going to the shop', async ({ page }) => {
    await page.clock.install(); // hold the hand-off so "You're in" can be checked, then let it run
    await page.goto('/login');
    await page.getByLabel('Email').fill('buyer@demo.test');
    await page.getByLabel('Password').fill('demo-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByTestId('youre-in')).toBeVisible();
    await page.clock.fastForward(2000);
    await expect(page).toHaveURL(/\/$/);
  });
});
