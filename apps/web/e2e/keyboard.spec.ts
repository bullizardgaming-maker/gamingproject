import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Keyboard-only use: skip link, focus after navigation, search, menus and tabs. */
test.describe('keyboard and screen readers', () => {
  test('the first Tab reaches a skip link that jumps to the content', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });

  test('navigating announces the new page and moves focus to it', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: 'Market', exact: true }).first();
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/market/);
    await expect(page.locator('#main')).toBeFocused();
    await expect(page.locator('[role=status][aria-live=polite]').first()).toContainText(/Bullizard|listings/i);
  });

  test('game search works from the keyboard as a combobox', async ({ page }) => {
    await page.goto('/market');
    const box = page.getByRole('combobox', { name: /search/i }).first();
    await box.fill('elden');
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown');
    const id = await box.getAttribute('aria-activedescendant');
    expect(id).toBeTruthy();
    await expect(page.locator(`[id="${id}"]`)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/games\/elden-ring/);
  });

  test('the notification panel takes focus and Escape returns it', async ({ page }) => {
    await signIn(page, 'Buyer');
    const bell = page.getByRole('button', { name: /notification/i });
    await bell.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(bell).toBeFocused();
  });

  test('staff tabs move with the arrow keys', async ({ page }) => {
    await signIn(page, 'Admin');
    await page.goto('/admin');
    const tabs = page.getByRole('tab');
    const first = tabs.first();
    await first.click();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
  });

  test('errors after an action are announced', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password').fill('wrong-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
  });
});
