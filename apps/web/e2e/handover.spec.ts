import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('handover check: the buyer signs in to the account they bought and can release early with consent', async ({ page }) => {
  await signIn(page, 'Buyer');
  // The demo buyer's history includes a Valorant account that showed a Riot sign-in badge, delivered hours ago.
  await page.goto('/orders');
  await page.getByRole('link', { name: /Diamond 1 smurf/ }).first().click();
  await page.waitForURL(/\/orders\/[^/]+$/);

  const card = page.locator('.checklist');
  const auto = card.getByLabel(/Sign in to the account from Bullizard/);
  await expect(auto).toBeDisabled();
  await expect(auto).not.toBeChecked();
  const confirm = page.getByRole('button', { name: 'Confirm and release payment' });
  await expect(confirm).toBeDisabled();
  await expect(page.getByText('Finish the security changeover first.')).toBeVisible();

  // The platform sign-in completes instantly in the demo and comes back to the order.
  await card.getByRole('button', { name: 'Sign in with Riot to confirm the handover' }).click();
  await expect(page).toHaveURL(/handover=ok/);
  await expect(page.getByRole('status').filter({ hasText: 'Handover confirmed' })).toBeVisible();
  await expect(auto).toBeChecked();
  await expect(card.getByText(/Handover confirmed by Riot sign-in/)).toBeVisible();
  await expect(page.getByText(/signed in to the Riot account from Bullizard/)).toBeVisible(); // in the order chat

  // Early release needs explicit consent while the other steps are open.
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/Release now, before the checklist is finished/).check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText(/Order completed/).first()).toBeVisible();
});
