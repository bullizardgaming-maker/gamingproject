import { expect, test } from '@playwright/test';

test.describe('installable app', () => {
  test('manifest and icons are served', async ({ page, request }) => {
    await page.goto('/');
    const href = await page.locator('link[rel=manifest]').getAttribute('href');
    const manifest = await (await request.get(href!)).json();
    expect(manifest.display).toBe('standalone');
    for (const icon of manifest.icons) expect((await request.get(icon.src)).ok(), icon.src).toBeTruthy();
  });

  test('service worker shows the offline page when the network is gone', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.goto('/games').catch(() => {});
    await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible();
    await context.setOffline(false);
  });
});
