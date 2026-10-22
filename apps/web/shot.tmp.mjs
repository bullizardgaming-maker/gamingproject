import { chromium } from '@playwright/test';
const out = process.argv[2]; const pages = process.argv.slice(3);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const spec of pages) {
  const [path, w = '1440', h = '1000', name] = spec.split('|');
  const p = await b.newPage({ viewport: { width: +w, height: +h } });
  await p.goto('http://localhost:4173' + path, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${out}/${name || path.replace(/\W+/g, '_')}.png`, fullPage: false });
  await p.close();
}
await b.close();
