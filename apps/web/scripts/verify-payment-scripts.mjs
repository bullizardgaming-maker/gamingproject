// Build-time check for PCI DSS 4.0.1 req. 6.4.3: every <script> on the built page must
// be in payment-scripts.json, be first-party, and be covered by the CSP. Also records a
// SHA-384 of each script so changes between releases are visible in CI logs (req. 11.6.1).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(readFileSync(path.join(root, 'payment-scripts.json'), 'utf8'));
const html = readFileSync(path.join(root, 'dist/index.html'), 'utf8');

const failures = [];
if (!/http-equiv="Content-Security-Policy"/.test(html)) failures.push('built page has no Content-Security-Policy');
if (/<script(?![^>]*\bsrc=)[^>]*>[^<]+<\/script>/.test(html)) failures.push('inline <script> found; CSP forbids inline scripts');

const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
for (const src of srcs) {
  if (/^https?:\/\//.test(src)) {
    if (!inventory.thirdParty.some((t) => t.src === src)) failures.push(`unlisted third-party script: ${src}`);
    continue;
  }
  const entry = inventory.scripts.find((s) => new RegExp(s.pattern).test(src));
  if (!entry) {
    failures.push(`unlisted script: ${src}`);
    continue;
  }
  const digest = createHash('sha384').update(readFileSync(path.join(root, 'dist', src))).digest('base64');
  console.log(`payment-page script ok: ${src} sha384-${digest}`);
}

if (failures.length) {
  console.error('Payment page script inventory check failed:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log(`payment page script inventory: ${srcs.length} script(s) verified`);
