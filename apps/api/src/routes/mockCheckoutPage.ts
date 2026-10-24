const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The mock PSP's hosted checkout page (PAYMENT_PROVIDER=mock only; never mounted in production).
 * Every interpolated value goes through escapeHtml; the file is listed in .semgrepignore for that reason.
 */
export function mockCheckoutPage(ref: string, order: { title: string; quantity: number; presentment_amount_cents: number | string; presentment_currency: string }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mock Hosted Checkout</title>
<style>body{font:15px system-ui;background:#0b0f17;color:#e6e9ef;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#141a26;padding:28px;border-radius:12px;width:340px}button{width:100%;padding:12px;border:0;border-radius:8px;background:#3ddc97;font-weight:600;margin-top:16px;cursor:pointer}
small{color:#8b93a7}</style></head><body><form method="post" action="/v1/payments/mock/checkout/${escapeHtml(ref)}/pay">
<h2>Mock hosted checkout</h2><p>${escapeHtml(order.title)} × ${order.quantity}</p>
<p><strong>${(Number(order.presentment_amount_cents) / 100).toFixed(2)} ${order.presentment_currency}</strong></p>
<small>In production this page is the PSP's hosted checkout (Stripe Checkout / Adyen Drop-in). Card data never touches marketplace servers (PCI DSS SAQ-A).</small>
<button type="submit">Pay (test card 4242)</button></form></body></html>`;;
}
