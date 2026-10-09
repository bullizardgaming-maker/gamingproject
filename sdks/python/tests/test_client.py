"""Client tests against a local stand-in server (no network, no real API)."""
import hashlib
import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from bullizard import Bullizard, BullizardError, WebhookVerificationError, construct_webhook_event, verify_webhook_signature

ORDER = {"id": "o-1", "status": "paid", "delivered_at": None, "completed_at": None, "chat_room_id": "r-1"}


class Handler(BaseHTTPRequestHandler):
    calls: list = []
    rate_limit_next = False

    def log_message(self, *args):  # keep test output quiet
        pass

    def _reply(self, status, body, headers=None, content_type="application/json"):
        raw = body if isinstance(body, bytes) else body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _handle(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        Handler.calls.append((method, self.path, body, self.headers.get("Authorization")))
        if self.headers.get("Authorization") != "Bearer mk_test_key":
            return self._reply(401, {"error": {"code": "unauthorized", "message": "Bad key"}})
        if Handler.rate_limit_next:
            Handler.rate_limit_next = False
            return self._reply(429, {"error": {"code": "rate_limited", "message": "Slow down"}}, {"Retry-After": "0"})
        path = self.path.split("?")[0]
        if method == "GET" and path == "/v1/merchant/orders":
            return self._reply(200, [ORDER])
        if method == "POST" and path == "/v1/merchant/orders/o-1/deliver":
            return self._reply(200, {**ORDER, "status": "delivered"})
        if method == "PATCH" and path == "/v1/merchant/prices":
            return self._reply(200, {"results": [{"id": u["offerId"], "ok": True, "price_cents": u["priceCents"]} for u in body["updates"]]})
        if method == "GET" and path == "/v1/merchant/invoices/inv-1/pdf":
            return self._reply(200, b"%PDF-1.4 test", content_type="application/pdf")
        if method == "GET" and path == "/v1/merchant/reports/sales":
            return self._reply(200, "order_id,amount_cents\r\no-1,100\r\n", content_type="text/csv") if "format=csv" in self.path else self._reply(200, {"kind": "sales", "rows": []})
        return self._reply(404, {"error": {"code": "not_found", "message": "Not found"}})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PATCH(self):
        self._handle("PATCH")


@pytest.fixture()
def server():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    Handler.calls = []
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def client(url, **kw):
    return Bullizard(api_key="mk_test_key", base_url=url, sleep=lambda _s: None, **kw)


def test_orders_deliver_and_prices(server):
    bz = client(server)
    assert bz.orders.list(status="paid") == [ORDER]
    method, path, _, auth = Handler.calls[-1]
    assert (method, auth) == ("GET", "Bearer mk_test_key") and path.startswith("/v1/merchant/orders?") and "status=paid" in path
    assert bz.orders.deliver("o-1", "CODE-123")["status"] == "delivered"
    assert Handler.calls[-1][2] == {"payload": "CODE-123"}
    assert bz.prices.update([{"offerId": "f-1", "priceCents": 999}]) == [{"id": "f-1", "ok": True, "price_cents": 999}]


def test_files_reports_and_errors(server):
    bz = client(server)
    assert bz.invoices.pdf("inv-1").startswith(b"%PDF")
    assert bz.reports.get("sales") == {"kind": "sales", "rows": []}
    assert bz.reports.csv("sales").startswith("order_id,amount_cents")
    with pytest.raises(BullizardError) as e:
        bz.orders.get("missing")
    assert (e.value.status, e.value.code) == (404, "not_found")
    with pytest.raises(BullizardError) as e:
        Bullizard(api_key="mk_wrong", base_url=server, max_retries=0).orders.list()
    assert e.value.code == "unauthorized"
    with pytest.raises(ValueError):
        Bullizard(api_key="not-a-key")


def test_retries_rate_limits(server):
    bz = client(server)
    Handler.rate_limit_next = True
    assert bz.orders.list() == [ORDER]
    assert len(Handler.calls) == 2


def test_poll_yields_each_change_once(server):
    bz = client(server)
    seen = []
    for order in bz.orders.poll(interval=0, stop=lambda: len(Handler.calls) >= 3):
        seen.append(order["id"])
    assert seen == ["o-1"]


def test_webhook_signatures():
    secret = "whsec_test"
    raw = json.dumps({"id": "evt_1", "type": "order.created", "data": {"id": "o-1"}}).encode()
    sig = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    assert verify_webhook_signature(raw, sig, secret)
    assert not verify_webhook_signature(raw + b" ", sig, secret)
    assert not verify_webhook_signature(raw, sig, "other")
    assert construct_webhook_event(raw, {"X-Hook-Signature": sig}, secret)["type"] == "order.created"
    with pytest.raises(WebhookVerificationError):
        construct_webhook_event(raw, {}, secret)
