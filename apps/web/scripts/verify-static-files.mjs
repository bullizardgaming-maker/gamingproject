// Build-time checks (Round 23a), run after `vite build`:
//  1. /.well-known/security.txt is in the build with exactly the agreed text, and Vercel serves it as text/plain:
//     the SPA rewrite in both vercel.json files leaves /.well-known/ alone, and a header sets the type.
//  2. The page's CSP allows Cloudflare Turnstile only when a site key is configured (VITE_TURNSTILE_SITE_KEY), and
//     the built page never loads its script itself (it is injected by the auth forms only; see Turnstile.tsx).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const SECURITY_TXT =
  'Contact: mailto:security@bullizard.com\n' +
  'Expires: 2027-10-25T00:00:00.000Z\n' +
  'Preferred-Languages: en, ar\n' +
  'Canonical: https://bullizard.com/.well-known/security.txt\n';
let built = '';
try {
  built = readFileSync(path.join(root, 'dist/.well-known/security.txt'), 'utf8');
} catch {
  failures.push('dist/.well-known/security.txt is missing (apps/web/public/.well-known/security.txt)');
}
if (built && built !== SECURITY_TXT) failures.push('security.txt does not match the agreed text');

for (const file of [path.join(root, 'vercel.json'), path.join(root, '../../vercel.json')]) {
  const name = path.relative(path.join(root, '../..'), file);
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  // Vercel sources are path-to-regexp patterns; ours are plain regex groups, so they can be tested as regexes.
  const rewritten = (p) => (cfg.rewrites ?? []).some((r) => new RegExp(`^${r.source}$`).test(p));
  if (rewritten('/.well-known/security.txt')) failures.push(`${name}: the SPA rewrite catches /.well-known/security.txt`);
  if (!rewritten('/market') || !rewritten('/orders/abc')) failures.push(`${name}: the SPA rewrite no longer covers app routes`);
  const type = (cfg.headers ?? [])
    .filter((h) => h.source === '/.well-known/security.txt')
    .flatMap((h) => h.headers)
    .find((h) => h.key.toLowerCase() === 'content-type');
  if (!type || !/^text\/plain\b/.test(type.value)) failures.push(`${name}: /.well-known/security.txt is not served as text/plain`);
}

const html = readFileSync(path.join(root, 'dist/index.html'), 'utf8');
const policy = (/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const directive = (name) => policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
const CF = 'https://challenges.cloudflare.com';
const turnstile = !!process.env.VITE_TURNSTILE_SITE_KEY;
for (const d of ['script-src', 'frame-src']) {
  const has = directive(d).split(/\s+/).includes(CF);
  if (turnstile && !has) failures.push(`CSP ${d} must allow ${CF} when VITE_TURNSTILE_SITE_KEY is set`);
  if (!turnstile && has) failures.push(`CSP ${d} allows ${CF} without a Turnstile site key`);
}
if (html.includes('challenges.cloudflare.com/turnstile')) failures.push('index.html loads the Turnstile script; only the auth forms may inject it');

if (failures.length) {
  console.error('Static file / CSP check failed:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log(`static files ok: security.txt, vercel.json rewrites/headers, CSP (Turnstile ${turnstile ? 'on' : 'off'})`);
