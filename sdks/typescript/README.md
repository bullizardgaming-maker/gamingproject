# @bullizard/sdk

TypeScript/JavaScript client for the Bullizard seller API. It has no dependencies and runs on Node 18+, Deno, Bun and edge runtimes.

```ts
import { Bullizard, constructWebhookEvent } from '@bullizard/sdk';

const bz = new Bullizard({ apiKey: process.env.BULLIZARD_API_KEY! }); // mk_... from Account → Developers

// Deliver every paid manual order as it comes in.
for await (const order of bz.orders.poll({ status: 'paid' })) {
  await bz.chat.send(order.chat_room_id, 'Thanks! Delivering now.');
  await bz.orders.deliver(order.id, await fetchCodeFromYourStock(order));
}

await bz.inventory.upload({ offerId, format: 'txt', content: codes.join('\n') });
await bz.prices.update([{ offerId, priceCents: 19_99, version }]);
const sales = await bz.reports.get('sales', { from: '2026-09-01', to: '2026-10-01' });
```

**Webhooks:** verify the raw body before parsing, and process each event `id` once.

```ts
app.post('/bullizard', express.raw({ type: 'application/json' }), async (req, res) => {
  const event = await constructWebhookEvent(req.body, req.headers, process.env.BULLIZARD_WEBHOOK_SECRET!);
  if (event.type === 'order.created') queueDelivery(event.data.id);
  res.sendStatus(200);
});
```

**Errors** are `BullizardError` with the HTTP `status` and the API's `code` (for example `insufficient_scope`).

**Retries:** rate limits (429) are retried on every call. Network errors and 5xx responses are retried on reads only, because a write may already have gone through.

The full API reference is at `/v1/docs` on your API host. Use a sandbox deployment (`SANDBOX_MODE=true`) to test against simulated buyers.
