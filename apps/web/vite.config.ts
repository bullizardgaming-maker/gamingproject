import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export default defineConfig(({ mode }) => ({
  resolve: { alias: { '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src') } },
  plugins: [react(), tailwindcss(), cspPlugin(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL || process.env.VITE_API_URL)],
  build: { sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://localhost:4000', ws: true },
    },
  },
}));
