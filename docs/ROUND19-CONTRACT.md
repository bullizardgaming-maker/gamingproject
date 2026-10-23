# Round 19 — shared contract between the API work and the web work (Oct 24)

Source docs (read with the Projects tool): `claude/next-tasks.md` (Back-End Round 19), `claude/bullizard-copy-deck.md`
(§0.4, §1–§3, §2.13, §2.15, §4, §5, §6, §8), `claude/legal-pack.md` ("For Back-End"), `claude/support-arbitration-playbook.md`.

## Chat system messages: codes the API emits (web renders `sys.<code>`, copy deck §2.8; never amounts)
| code | kind | params |
|---|---|---|
| order_created | system | — |
| paid | system | character (string or null) |
| delivered | system | — |
| confirmed_early | system | — |
| completed | system | — |
| staff_released | system | — |
| follow_up | system | — |
| dispute_opened | system | — |
| dispute_buyer | system | — |
| dispute_seller | system | — |
| refunded | system | — |
| underpaid | system | — |
| delivery_late | warning | — |
Codes with no `sys.*` key (security_review, dispute_statement, handover_confirmed, checklist_completed, refund_address_given,
account_suspended_offplatform, account_banned_offplatform) keep the `chat.ev.*` keys already in i18n; otherwise show the
English `body`. Messages carry `code` and `params` next to `body`.

## Legal documents (API)
- `GET /v1/legal/:doc?lang=en|ar` — doc ∈ `terms`, `privacy`, `seller-agreement`, `refunds`, `restricted-countries`.
  → `{ doc, locale, version, effective_at, title, content_md, sha256 }` (English when the locale has no row).
- `GET /v1/legal/:doc/history` → `[{ version, effective_at, title, sha256, locale }]` newest first.
- `GET /v1/legal/:doc/versions/:version?lang=` → one past version (same shape as above).
- `GET /v1/features` → adds `legal: { tosVersion, notice: { version, effectiveAt } | null }` — `notice` is set while a
  material change is announced (14 days before it takes effect); the web shows a banner linking to /terms.
- `GET /v1/me/legal` (signed in) → `{ tosVersion, acceptedAt, currentVersion, reacceptanceRequired }`.
- `POST /v1/me/legal/accept {}` → accepts the current Terms version (used after a material change).
- `POST /v1/auth/register` now requires `acceptTerms: true` (18+ and Terms + Privacy); stores `users.tos_version`
  and `users.tos_accepted_at`.
- Orders already carry `tos_version` and `tos_accepted_at` → order page shows "Terms v{version} accepted on {date}".
- Admin: `GET /v1/admin/legal`, `PUT /v1/admin/legal/:doc { lang, version, effectiveAt, title, contentMd, material }`.
Seed: placeholder English rows (version `2026-10-24`) for all five docs; Legal's approved text replaces them through
the admin route.

## Errors
API errors are `{ error: { code, message } }`. Web: show `err.<code>` when the key exists (copy deck §2.13), otherwise the
server message (not `err.generic`, so validation messages stay useful); `err.generic` only for 5xx/unknown, `err.network`
when offline.

## Ranks
`rank.name.<English>` and `rank.perk.<English>` keys (deck §3) wherever a rank name shows; DB keeps English names.

## Rules test
`rules_questions` gets `question_ar`, `options_ar`, `explanation_ar`; `GET /v1/seller/rules-test?lang=ar` returns Arabic
text when present; pass mark 90%; the 13 deck questions are seeded (migration 067).

## Dispute decisions
`POST /v1/admin/disputes/:id/resolve { outcome: 'buyer' | 'seller' | 'split', refundCents?, note }` — `split` refunds
`refundCents` to the buyer's balance and releases the rest to the seller. Chat code `dispute_buyer` / `dispute_seller`
(split → `dispute_buyer` when refundCents > 0 else `dispute_seller`), email `dispute_resolved` with `{ result }` text.

## Listing ban / appeals / Lead flag
- `users.listing_banned_at`: seller can't create or relist offers (403 `listing_banned`); staff set/clear it from
  Ops → Users (`POST /v1/admin/users/:id/listing-ban { on: boolean, reason }`).
- Support ticket category `appeal` (next to order/payment/account/selling/report/other).
- Orders with `amount_cents > 200_00` carry `lead_review: true` in the order list for staff and in Ops → Releases.
