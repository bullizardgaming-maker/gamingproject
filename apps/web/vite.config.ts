import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from './src/demo/seed';

/**
 * PCI DSS 6.4.3 / 11.6.1: production pages (including those that start checkout)
 * ship a strict CSP that only allows first-party scripts. Violations are reported
 * to the API. Dev mode is exempt because Vite injects inline HMR scripts.
 */
function csp(apiUrl?: string) {
  // A separately hosted API (VITE_API_URL) must be allowed for fetch and the WebSocket.
  let api = '';
  if (apiUrl) {
    const u = new URL(apiUrl);
    api = ` ${u.origin} ${u.origin.replace(/^http/, 'ws')}`;
  }
  return [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  `connect-src 'self' ws: wss:${api}`,
  "frame-src https://checkout.stripe.com https://js.stripe.com",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'none'",
  "object-src 'none'",
  ].join('; ');
}

function cspPlugin(apiUrl?: string): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp(apiUrl) }, injectTo: 'head-prepend' }],
  };
}

/**
 * robots.txt and sitemap.xml for search engines. The sitemap lists the public pages and every
 * game and game/category page in the catalogue (the demo catalogue at build time; point
 * VITE_SITE_URL at the production domain). Private pages (orders, account, operations) are
 * disallowed and also carry noindex.
 */
function seoFilesPlugin(siteUrl: string): Plugin {
  const slug = (g: string) => g.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    name: 'seo-files',
    apply: 'build',
    generateBundle() {
      const base = siteUrl.replace(/\/+$/, '');
      const offers = seed().offers;
      const games = new Map<string, Set<string>>();
      for (const o of offers) games.set(o.game, (games.get(o.game) ?? new Set()).add(o.category_slug));
      const paths = ['/', '/games', '/market', '/sell', '/developers', '/status'];
      for (const [game, cats] of [...games].sort(([a], [b]) => a.localeCompare(b))) {
        paths.push(`/games/${slug(game)}`);
        for (const c of [...cats].sort()) paths.push(`/games/${slug(game)}/${c}`);
      }
      const today = new Date().toISOString().slice(0, 10);
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        paths.map((p) => `  <url><loc>${base}${p}</loc><lastmod>${today}</lastmod><changefreq>${p.startsWith('/games/') ? 'hourly' : 'daily'}</changefreq></url>`).join('\n') +
        `\n</urlset>\n`;
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: xml });
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\nDisallow: /orders\nDisallow: /chat\nDisallow: /account\nDisallow: /admin\nDisallow: /login\nDisallow: /demo-checkout\n\nSitemap: ${base}/sitemap.xml\n`,
      });
    },
  };
}

const siteUrl = () =>
  process.env.VITE_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://bullizard.com');

export default defineConfig(({ mode }) => ({
  resolve: { alias: { '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src') } },
  plugins: [react(), tailwindcss(), cspPlugin(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL || process.env.VITE_API_URL), seoFilesPlugin(siteUrl())],
  build: { sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://localhost:4000', ws: true },
    },
  },
}));
