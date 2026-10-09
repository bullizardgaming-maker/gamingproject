"""HTTP client for the Bullizard seller API (standard library only)."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Iterator, List, Optional

__all__ = ["Bullizard", "BullizardError"]

DEFAULT_BASE_URL = "https://api.bullizard.com"
USER_AGENT = "bullizard-sdk-python/0.1.0"


class BullizardError(Exception):
    """An API error. ``status`` is the HTTP status, ``code`` the machine-readable error code."""

    def __init__(self, status: int, code: str, message: str, details: Any = None, request_id: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.request_id = request_id

    def __repr__(self) -> str:
        return f"BullizardError(status={self.status}, code={self.code!r}, message={self.message!r})"


def _q(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


class _Response:
    def __init__(self, status: int, headers: Dict[str, str], body: bytes):
        self.status, self.headers, self.body = status, headers, body

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8")) if self.body else None


class Bullizard:
    """Bullizard seller API client.

    ``api_key``: a seller API key (``mk_...``) from Account → Developers, with only the scopes your
    bot needs. Rate limits (429) are retried on every call; network errors and 5xx only on reads,
    because a write may already have happened.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        max_retries: int = 2,
        timeout: float = 30.0,
        sleep: Callable[[float], None] = time.sleep,
    ):
        if not api_key or not api_key.startswith("mk_"):
            raise ValueError("api_key must be a seller API key (mk_...)")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.max_retries = max_retries
        self.timeout = timeout
        self._sleep = sleep
        self.orders = _Orders(self)
        self.inventory = _Inventory(self)
        self.prices = _Prices(self)
        self.chat = _Chat(self)
        self.invoices = _Invoices(self)
        self.reports = _Reports(self)
        self.webhooks = _Webhooks(self)

    # -- transport --------------------------------------------------------------------------
    def _send(self, method: str, url: str, body: Optional[bytes]) -> _Response:
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json", "User-Agent": USER_AGENT}
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return _Response(res.status, {k.lower(): v for k, v in res.headers.items()}, res.read())
        except urllib.error.HTTPError as err:
            return _Response(err.code, {k.lower(): v for k, v in err.headers.items()}, err.read())

    def request(self, method: str, path: str, body: Any = None, params: Optional[Dict[str, Any]] = None, raw: bool = False) -> Any:
        query = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
        url = f"{self.base_url}/v1{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        read = method == "GET"
        attempt = 0
        while True:
            try:
                res = self._send(method, url, data)
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if read and attempt < self.max_retries:
                    self._sleep(0.5 * 2**attempt)
                    attempt += 1
                    continue
                raise
            if (res.status == 429 or (read and res.status >= 500)) and attempt < self.max_retries:
                try:
                    wait = min(float(res.headers.get("retry-after", "")), 30.0)
                except ValueError:
                    wait = 0.5 * 2**attempt
                self._sleep(wait)
                attempt += 1
                continue
            if res.status >= 400:
                try:
                    err = (res.json() or {}).get("error", {})
                except ValueError:
                    err = {}
                raise BullizardError(res.status, err.get("code", "http_error"), err.get("message", f"Request failed ({res.status})"), err.get("details"), res.headers.get("x-request-id"))
            if raw:
                return res.body
            if res.status == 204 or not res.body:
                return None
            if "application/json" in res.headers.get("content-type", ""):
                return res.json()
            return res.body.decode("utf-8")


class _Orders:
    def __init__(self, c: Bullizard):
        self._c = c

    def list(self, status: Optional[str] = None, since: Optional[str] = None, limit: int = 50) -> List[dict]:
        """Your orders, newest first. ``since``: ISO time for incremental polling. Scope: orders:read."""
        return self._c.request("GET", "/merchant/orders", params={"status": status, "since": since, "limit": limit})

    def get(self, order_id: str) -> dict:
        return self._c.request("GET", f"/merchant/orders/{_q(order_id)}")

    def deliver(self, order_id: str, payload: Optional[str] = None) -> dict:
        """Deliver a manual order. ``payload`` is stored encrypted and shown only to the buyer. Scope: orders:write."""
        return self._c.request("POST", f"/merchant/orders/{_q(order_id)}/deliver", {} if payload is None else {"payload": payload})

    def poll(self, status: Optional[str] = None, interval: float = 15.0, since: Optional[str] = None, stop: Callable[[], bool] = lambda: False) -> Iterator[dict]:
        """Yield every order once per change, polling every ``interval`` seconds until ``stop()`` is true."""
        cursor = since or "1970-01-01T00:00:00Z"
        seen: Dict[str, str] = {}
        while not stop():
            started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            for order in reversed(self.list(status=status, since=cursor, limit=200)):
                version = f"{order['status']}|{order.get('delivered_at')}|{order.get('completed_at')}"
                if seen.get(order["id"]) == version:
                    continue
                seen[order["id"]] = version
                yield order
            cursor = started
            if stop():
                return
            self._c._sleep(interval)


class _Inventory:
    def __init__(self, c: Bullizard):
        self._c = c

    def upload(self, offer_id: str, content: str, format: str = "txt") -> dict:
        """Upload codes for an auto-delivery listing; duplicates are skipped. Scope: inventory:write."""
        return self._c.request("POST", "/merchant/inventory", {"offerId": offer_id, "format": format, "content": content})


class _Prices:
    def __init__(self, c: Bullizard):
        self._c = c

    def update(self, updates: List[dict]) -> List[dict]:
        """``updates``: [{"offerId", "priceCents", "version"?}]; each succeeds or fails on its own. Scope: offers:write."""
        return self._c.request("PATCH", "/merchant/prices", {"updates": updates})["results"]


class _Chat:
    def __init__(self, c: Bullizard):
        self._c = c

    def send(self, room_id: str, body: str) -> dict:
        """Message the buyer in an order's recorded chat. Scope: chat:write."""
        return self._c.request("POST", f"/merchant/chat/{_q(room_id)}/messages", {"body": body})


class _Invoices:
    def __init__(self, c: Bullizard):
        self._c = c

    def list(self) -> List[dict]:
        """Monthly commission invoices. Scope: reports:read."""
        return self._c.request("GET", "/merchant/invoices")

    def pdf(self, invoice_id: str) -> bytes:
        return self._c.request("GET", f"/merchant/invoices/{_q(invoice_id)}/pdf", raw=True)


class _Reports:
    def __init__(self, c: Bullizard):
        self._c = c

    def get(self, kind: str, date_from: Optional[str] = None, date_to: Optional[str] = None, currency: Optional[str] = None) -> dict:
        """Accounting export as JSON rows. ``kind``: sales, statement, payouts, invoices, credit_notes. Scope: reports:read."""
        return self._c.request("GET", f"/merchant/reports/{_q(kind)}", params={"from": date_from, "to": date_to, "currency": currency, "format": "json"})

    def csv(self, kind: str, date_from: Optional[str] = None, date_to: Optional[str] = None, currency: Optional[str] = None) -> str:
        return self._c.request("GET", f"/merchant/reports/{_q(kind)}", params={"from": date_from, "to": date_to, "currency": currency, "format": "csv"})


class _Webhooks:
    def __init__(self, c: Bullizard):
        self._c = c

    def deliveries(self, status: str = "failing", endpoint_id: Optional[str] = None, limit: int = 100) -> List[dict]:
        """Deliveries to your endpoints, default the ones still failing. Scope: webhooks:manage."""
        return self._c.request("GET", "/merchant/webhooks/deliveries", params={"status": status, "endpointId": endpoint_id, "limit": limit})

    def redeliver(self, delivery_id: str) -> dict:
        return self._c.request("POST", f"/merchant/webhooks/deliveries/{_q(delivery_id)}/redeliver")

    def replay(self, endpoint_id: str, since: Optional[str] = None) -> dict:
        """Re-queue every dead delivery for an endpoint, e.g. after your outage."""
        return self._c.request("POST", f"/merchant/webhooks/{_q(endpoint_id)}/replay", {"since": since} if since else {})
