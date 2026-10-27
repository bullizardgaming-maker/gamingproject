import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';
import { parseCsv } from '../../api/src/domain/csv';

const toCsv = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

// Round 24b: removed from the seller hub (CEO).
test.skip('a seller downloads listings as CSV, edits them and imports with a preview', async ({ page }) => {
  await signIn(page, 'Seller');
  await page.goto('/sell');
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Edit listings in a spreadsheet' }) });

  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: 'Download CSV' }).click()]);
  const csv = readFileSync((await download.path())!, 'utf8');
  const [header, first, ...rest] = parseCsv(csv);
  expect(header!.join(',')).toBe('id,game,category,title,description,price,currency,delivery,stock,delivery_hours,status,attributes,warranty_days');

  // Change the first listing's price and add a new listing.
  const priceAt = header!.indexOf('price');
  first![priceAt] = (Number(first![priceAt]) + 1).toFixed(2);
  const added = ['', 'Minecraft', 'keys', 'Minecraft Java Edition key', '', '19.99', 'USD', 'instant', '', '', 'active', '', '0'];
  const edited = toCsv([header!, first!, ...rest, added]);

  await card.locator('input[type=file]').setInputFiles({ name: 'listings.csv', mimeType: 'text/csv', buffer: Buffer.from(edited) });
  await expect(card.getByRole('status')).toContainText('Preview: 1 new, 1 updated');
  await expect(card.getByText('Update: price')).toBeVisible();
  await card.getByRole('button', { name: 'Apply 2 changes' }).click();
  await expect(card.getByRole('status')).toContainText('Done: 1 created, 1 updated');
  await expect(page.getByText('Minecraft Java Edition key').first()).toBeVisible();
});
