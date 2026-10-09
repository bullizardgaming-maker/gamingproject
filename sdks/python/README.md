# bullizard (Python)

Python client for the Bullizard seller API. It needs Python 3.9+ and has no dependencies.

```python
import os
from bullizard import Bullizard, construct_webhook_event

bz = Bullizard(api_key=os.environ["BULLIZARD_API_KEY"])  # mk_... from Account → Developers

for order in bz.orders.poll(status="paid"):          # each order once per change
    bz.chat.send(order["chat_room_id"], "Thanks! Delivering now.")
    bz.orders.deliver(order["id"], next_code())

bz.inventory.upload(offer_id, "\n".join(codes))
bz.prices.update([{"offerId": offer_id, "priceCents": 1999, "version": version}])
csv_text = bz.reports.csv("sales", date_from="2026-09-01", date_to="2026-10-01")
```

**Webhooks:** verify the raw body before parsing, and process each event `id` once.

```python
event = construct_webhook_event(request.body, request.headers, os.environ["BULLIZARD_WEBHOOK_SECRET"])
if event["type"] == "order.created":
    queue_delivery(event["data"]["id"])
```

**Errors** raise `BullizardError` with `.status` and `.code`.

**Retries:** rate limits (429) are retried on every call. Network errors and 5xx responses are retried on reads only.

Run the tests with `pip install -e ".[test]" && pytest`.
