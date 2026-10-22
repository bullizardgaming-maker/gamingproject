A small pill that states where an order's money is right now.

Three colours exist only for money, and nothing else in the UI may use them:

- **Held** (`held-soft` / `held-ink`): paid, locked in escrow.
- **Released** (`released-soft` / `released-ink`): paid out to the seller's wallet.
- **Disputed** (`disputed-soft` / `disputed-ink`): frozen by a dispute or risk review.
- **Neutral** (no class): staff review, cancelled, refunded.

Always pair the colour with words. The dot is `currentColor`, so it follows the state.
