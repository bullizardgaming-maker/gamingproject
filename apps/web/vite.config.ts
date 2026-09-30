import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * PCI DSS 6.4.3 / 11.6.1: production pages (including those that start checkout)
 * ship a strict CSP that only allows first-party scripts. Violations are reported
 * to the API. Dev mode is exempt because Vite injects inline HMR scripts.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src https://checkout.stripe.com https://js.stripe.com",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig({
  plugins: [react(), cspPlugin()],
  build: { sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://localhost:4000', ws: true },
    },
  },
});
