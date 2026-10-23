import { chromium } from 'playwright';
import fs from 'fs';
const list = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const b = await chromium.launch({ executablePath: process.env.CH });
for (const a of list) {
  const ctx = await b.newContext({ viewport: { width: a.w, height: a.h }, deviceScaleFactor: a.scale });
  const p = await ctx.newPage();
  await p.goto('file://' + process.cwd() + '/html/' + a.name + '.html');
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  fs.mkdirSync('out/' + a.name.split('/')[0], { recursive: true });
  await p.screenshot({ path: 'out/' + a.name + '.png' });
  await ctx.close();
}
await b.close();
