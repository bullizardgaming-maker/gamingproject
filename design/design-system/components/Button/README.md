Buttons carry one action each, and their fill tells the user what happens to the money.

| Variant | Class | When |
|---|---|---|
| Buy | `.bz-btn.buy` | The one purchase action on an offer or checkout. Uses `rune`. Show the buyer price inside it. |
| Primary | `.bz-btn` | Default forward action (Continue, Save listing). `ink` fill. |
| Release | `.bz-btn.release` | Buyer confirms delivery and releases escrow. `released` fill. |
| Dispute | `.bz-btn.dispute` | Opens a dispute. Outline only, never filled, so it is never the easiest button to hit. |
| Ghost | `.bz-btn.ghost` | Secondary actions. |

- Height 44px (34px for `.sm`). Touch targets never go below 34px.
- One `buy` button per view.
- Labels say exactly what happens: "Confirm & release funds", not "OK".
- Release and Dispute never sit side by side with equal weight. Put Dispute in a menu or below.
