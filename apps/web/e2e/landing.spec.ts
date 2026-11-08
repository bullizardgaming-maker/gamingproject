import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

// CEO, 8 Nov: the landing page and the top bar's region control.
test('landing: eye hero, trust line, trending games, two ways to earn, ways to pay, footer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /Bullizard\s*Digital Marketplace/ })).toBeVisible();
  await expect(page.getByTestId('hero-eye')).toBeVisible();
  await expect(page.getByText('Bullizard Protector')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Trending games' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Get paid with Bullizard' })).toBeVisible();
  const earn = page.getByRole('link', { name: 'Start Earning Today' });
  await expect(earn).toHaveCount(2);
  await expect(earn.first()).toHaveAttribute('href', '/signup'); // affiliate: visitors sign up first
  await expect(earn.last()).toHaveAttribute('href', '/sell');
  const strip = page.getByTestId('payment-strip');
  await expect(strip.getByText('Bitcoin').first()).toBeVisible();
  await expect(strip.getByText('Soon').first()).toBeVisible();
  const footer = page.getByRole('contentinfo');
  for (const name of ['About Us', 'Legal', 'Terms of Service', 'Privacy Policy', 'Help Center']) await expect(footer.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(footer.getByRole('link', { name: 'Instagram' })).toHaveAttribute('href', 'https://www.instagram.com/bullizardhq');
  await footer.getByRole('link', { name: 'About Us' }).click();
  await expect(page.getByRole('heading', { name: 'About Bullizard' })).toBeVisible();
});

test('recently bought and the affiliate link for a signed-in buyer; creator code request pre-fills support', async ({ page }) => {
  await signIn(page, 'Buyer');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recently bought' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start Earning Today' }).first()).toHaveAttribute('href', '/account#invite');
  await page.getByRole('link', { name: /Ask for a creator code/ }).click();
  await expect(page.locator('input[name=subject]')).toHaveValue('Creator program');
});

test('the region changes in the top bar without a phone number, and a signed-in account keeps it', async ({ page }) => {
  await signIn(page, 'Buyer');
  await page.goto('/');
  await page.getByRole('button', { name: /^Region:/ }).click();
  const panel = page.getByRole('dialog', { name: 'Localization settings' });
  await expect(panel.getByText('No phone number needed.')).toBeVisible();
  await panel.getByLabel('Region').selectOption('asia');
  await panel.getByLabel('Currency').selectOption('USD');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('prefs-region')).toHaveText('Asia');
  await expect(page.getByTestId('prefs-currency')).toHaveText('USD');
  await page.goto('/account');
  await expect(page.getByTestId('region-settings').getByRole('radio', { name: 'Asia' })).toBeChecked();
});
