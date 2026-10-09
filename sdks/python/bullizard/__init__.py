"""Bullizard seller API client.

    from bullizard import Bullizard
    bz = Bullizard(api_key=os.environ["BULLIZARD_API_KEY"])
    for order in bz.orders.list(status="paid"):
        bz.orders.deliver(order["id"], "your code")
"""
from .client import Bullizard, BullizardError
from .webhooks import WebhookVerificationError, construct_webhook_event, verify_webhook_signature

__all__ = ["Bullizard", "BullizardError", "WebhookVerificationError", "construct_webhook_event", "verify_webhook_signature"]
__version__ = "0.1.0"
