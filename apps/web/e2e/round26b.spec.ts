import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { pickServer, previewOffer, setSpeed, signIn, startOffer, choose } from './helpers';

test.describe('Round 26b: create offer redesign', () => {
  test('three sections; ".14" is 0.14; unit prices at full precision; the price helper fills the price', async ({ page }) => {
    await signIn(page, 'Seller');
    await startOffer(page, 'currency', 'Albion Online');
    for (const h of ['Details', 'Delivery details', 'Volume discount']) await expect(page.getByRole('heading', { name: h, exact: true })).toBeVisible();
    await expect(page.getByLabel('Product type', { exact: true })).toHaveValue('Currency');
    await expect(page.getByLabel('Game', { exact: true })).toHaveValue('Albion Online');
    await expect(page.locator('input[name="attr.server"]')).toHaveAttribute('placeholder', 'Type to filter');
    await expect(page.locator('input[name=maxQty]')).toHaveCount(0);

    const price = page.locator('input[name=unitPrice]');
    await price.fill('.14');
    await price.blur();
    await expect(price).toHaveValue('0.14');
    await expect(page.getByTestId('you-get')).toHaveText('$0.14');
    // Buyers pay the price with fees on top, never rounded to the cent.
    await expect(page.getByTestId('buyers-pay')).toHaveText(/^\$0\.1\d{2,5}$/);
    await price.fill('0.000123');
    await expect(page.getByTestId('you-get')).toHaveText('$0.000123');

    // Price helper: other sellers on this server, with "Use" buttons.
    await pickServer(page, 'Europe');
    const guide = page.getByTestId('price-guide');
    await expect(guide.getByText('Lowest')).toBeVisible();
    await expect(guide).toContainText(/Active sellers: \d+/);
    await guide.getByRole('button', { name: 'Use the Recommended price' }).click();
    await expect(price).not.toHaveValue('0.000123');
    expect(Number(await price.inputValue())).toBeGreaterThan(0);
  });

  test('a delivery method is required, speed is typed, and a fixed-price tier reaches the offer page', async ({ page }) => {
    await signIn(page, 'Seller');
    await startOffer(page, 'currency', 'Albion Online');
    await pickServer(page, 'Asia');
    await page.locator('input[name=stock]').fill('10000000');
    await page.locator('input[name=unitPrice]').fill('.0002');
    await setSpeed(page, 45, 'minutes');
    await page.locator('textarea[name=description]').fill('Trade at the Caerleon bank. Send your character name in the chat.');
    for (const box of await page.locator('input[name=deliveryMethods]').all()) await box.uncheck();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByText('This field is required')).toBeVisible();
    await page.getByLabel('Face to face', { exact: true }).check();
    await expect(page.getByText('This field is required')).toHaveCount(0);
    // (?) tips explain each method.
    await expect(page.getByRole('button', { name: 'About Face to face' })).toHaveAccessibleDescription(/meet the buyer/);

    await expect(page.getByLabel('Discount 1: from quantity')).toHaveCount(0); // off by default
    await page.getByLabel('Create a volume discount').check();
    await page.getByLabel('Discount 1: from quantity').fill('5000000');
    await choose(page, page.getByLabel('Discount 1: type'), 'Fixed unit price');
    await page.getByLabel('Discount 1: unit price').fill('.00018');
    await page.getByRole('button', { name: 'Add discount' }).click();
    await page.getByLabel('Discount 2: from quantity').fill('8000000');
    await page.getByLabel('Discount 2: percent off').fill('5'); // 5% off 0.0002 = 0.00019: not cheaper than tier 1
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('lower unit price than the one before');
    await page.getByLabel('Discount 2: percent off').fill('20');
    await previewOffer(page);
    const preview = page.getByTestId('listing-preview');
    await expect(preview).toContainText('45 min');
    await expect(preview.locator('.lp-tiers')).toContainText('5,000,000+');
    await page.getByRole('button', { name: 'Publish offer' }).click();
    await expect(page.getByText('Your offer is live.')).toBeVisible();

    const row = page.getByRole('row', { name: /Albion Online · Asia/ }).first();
    await expect(row).toContainText('$0.0002');
    await row.getByRole('link', { name: 'Edit' }).click();
    await expect(page.getByLabel('Create a volume discount')).toBeChecked();
    await expect(page.getByLabel('Discount 1: type')).toHaveValue('Fixed unit price');
    await expect(page.getByLabel('Discount 1: unit price')).toHaveValue('0.00018');
  });

  test('typed text is black in light mode and white in dark mode, in every input', async ({ page }) => {
    await signIn(page, 'Seller');
    await startOffer(page, 'currency', 'Albion Online');
    const colours = () => page.locator('input[name=stock], textarea[name=description], input[name=unitPrice], input[name="attr.server"]').evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    expect(new Set(await colours())).toEqual(new Set(['rgb(0, 0, 0)']));
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect(new Set(await colours())).toEqual(new Set(['rgb(255, 255, 255)']));
  });

  test('the price helper says when nobody else sells on that server', async ({ page }) => {
    await signIn(page, 'Seller');
    await startOffer(page, 'currency', 'Aion');
    await page.locator('input[name="attr.server"]').fill('Zikel');
    await expect(page.getByTestId('price-guide')).toContainText('No other listings yet');
  });

  test('the currency form and its preview pass axe (light and dark)', async ({ page }) => {
    await signIn(page, 'Seller');
    await startOffer(page, 'currency', 'Albion Online');
    await pickServer(page, 'Europe');
    await page.getByLabel('Create a volume discount').check();
    await choose(page, page.getByLabel('Discount 1: type'), 'Fixed unit price');
    await page.keyboard.press('Escape'); // no list left open
    // Colour transitions (buttons fade .14 s) must finish before axe measures contrast, or it reads a mid-fade colour.
    const settled = () => page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
    const axe = async () => (await settled(), new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze());
    expect((await axe()).violations.map((v) => v.id)).toEqual([]);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect((await axe()).violations.map((v) => v.id)).toEqual([]);
  });

  test('edit uses the create layout with list-mode dropdowns, pre-filled, and recovers from a 409', async ({ page }) => {
    await signIn(page, 'Seller');
    await page.goto('/sell');
    await page.getByRole('row', { name: /100M kinah — Siel/ }).getByRole('link', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit listing' })).toBeVisible();
    for (const h of ['Details', 'Delivery details', 'Volume discount']) await expect(page.getByRole('heading', { name: h, exact: true })).toBeVisible();
    await expect(page.getByLabel('Product type', { exact: true })).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Game', { exact: true })).toHaveValue('Aion');
    await expect(page.getByTestId('price-guide')).toBeVisible();
    // Pre-filled from the listing; every choice is a list-mode dropdown (type to filter), methods stay checkboxes.
    await expect(page.locator('input[name="attr.server"]')).toHaveValue('Siel');
    const faction = page.locator('input[name="attr.faction"]');
    await expect(faction).toHaveAttribute('role', 'combobox');
    await expect(faction).toHaveAttribute('placeholder', 'Type to filter');
    await faction.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['Elyos', 'Asmodian']);
    await faction.fill('ely');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['Elyos']);
    await page.getByRole('listbox').getByRole('option', { name: 'Elyos' }).click();
    await expect(faction).toHaveValue('Elyos');
    await expect(page.getByLabel('Delivery speed, unit')).toHaveAttribute('role', 'combobox');
    await expect(page.locator('input[name=deliveryMethods]').first()).toHaveAttribute('type', 'checkbox');
    await setSpeed(page, 2, 'hours');
    await page.getByLabel('Create a volume discount').check();
    await page.getByLabel('Discount 1: from quantity').fill('10');
    await choose(page, page.getByLabel('Discount 1: type'), 'Fixed unit price');
    await page.getByLabel('Discount 1: unit price').fill('.5');

    // Someone else changes the listing before we save: 409 → reload and say so.
    await page.evaluate(() => (window as any).__bzDemo.touchOffer('offer-55', 5));
    await previewOffer(page);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByTestId('edit-conflict')).toHaveText('This listing changed – review and save again');
    await expect(page.locator('input[name=stock]')).toHaveValue('55'); // reloaded with the new values
    await expect(faction).toHaveValue('Asmodian'); // the unsaved choice is gone
    await choose(page, faction, 'Elyos');
    await previewOffer(page);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changes saved.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Aion · Siel · Elyos/ })).toBeVisible();
  });
});
