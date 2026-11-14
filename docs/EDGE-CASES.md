# WP-14 transport checks

The repository-wide generated ledger remains [EDGE_CASES.md](EDGE_CASES.md).
Spec §12 has no rows tagged M14; WP-14's transport acceptance checks are in
`apps/web/app/api/mcp/[transport]/route.test.ts` and `apps/web/lib/mcp-token.test.ts`.

- Missing, forged, expired, or non-agent bearers are refused before a tool executes.
- Missing signing configuration refuses token issuance/verification.
- Wrong signing keys, missing expiry, and a different audience are rejected.
- Missing VI configuration refuses chain verification; `submit_checkout` returns the real
  Gate's BLOCKED reasons. This does not prove a successful purchase.
- A checkout cart's bigint unit amounts are converted to decimal strings for its JSON row.
- Static signing secrets in tests were replaced with random runtime keys. Historical exceptions
  require an exact value and path and apply only to the triggering Gitleaks rule.

## P0-6 — the payment path, added 2026-10-26

`apps/web/lib/mcp-checkout.ts` composes the Gate for `submit_checkout` and records the decision; its
failure modes are covered by the route test and by `scripts/agent-acceptance.mts`:

- **An unconfigured Gate fails closed, with no outbound call.** Without `GATE_SIGNING_KEY` /
  `VI_SERVICE_*` the tool answers `CS_INTERNAL` and a sentence, and `fetch` is never called
  (`route.test.ts`, "fails closed on submission when the Gate is not configured").
- **An unreadable Gate answer is never permission.** `toGateOutcome` refuses a `submit_checkout`
  result whose `status` is missing or unknown (`packages/agent/test/tools.test.ts`).
- **Order status reads our own table.** An unknown order is `CS_NOT_FOUND`; a database failure is
  reported as a failure, never as "no such order" (`route.test.ts`).
- **The agent cannot aim at another mandate.** `submit_checkout`'s operation refuses a `mandate_id`
  the session is not bound to, before the merchant sees the call
  (`packages/agent/test/tools.test.ts`).
- **The wire shapes are §8.9's.** Tool results carry `price_minor`, `ships_in_days`, `checkout_id`
  and `total_minor`; a route that leaked our internal camelCase made every agent query find zero
  items, which is recorded in the mapper's comment rather than discovered twice.

## P0 post-purchase money movement — the merchant routes, added 2026-11-15

`apps/web/app/api/orders/[id]/{capture,void,refund}/route.ts` + `apps/web/lib/order-ops.ts` (D-061).
The arithmetic, the state machine and the deterministic request ids are `packages/orders`'; these are the
rows tagged to those routes.

- **EC-CAP-3 / EC-CAP-4** — an over-capture is refused before any HTTP request, and a `PENDING` capture
  ships nothing. The route adds no amount of its own (`capture` takes lines, carrier and tracking), and it
  reports `paypalCalls: ['capture']` for a pending capture rather than claiming a tracker
  (`apps/web/lib/order-ops.test.ts`, `packages/orders/test/capture.test.ts`).
- **EC-SPLIT-2** — a tracking-only shipment moves no money and reports `captureId: null`
  (`apps/web/lib/order-ops.test.ts`).
- **EC-REF-2** — an over-refund is refused locally with no PayPal call. The route adds the other half: the
  requested currency must be the capture's, or `CS_CURRENCY_MISMATCH` before `refund()` runs
  (`apps/web/lib/order-ops.test.ts`, `packages/orders/test/refund.test.ts`).
- **EC-REF-4** — an open dispute blocks a direct refund and the refusal reaches the merchant as
  `DEF_WRONG_STATE` (409) with the accept-claim / make-offer routes in `details`; no audit row is written
  (`apps/web/lib/order-ops.test.ts`, `apps/web/app/api/orders/[id]/refund/route.test.ts`).
- **EC-IDEM-5 / EC-IDEM-6** — the refund route **requires** an `idempotencyKey`; a body without one is a
  400 and never reaches the refund, and the same key twice is one refund and one PayPal call
  (`apps/web/app/api/orders/[id]/refund/route.test.ts`, `packages/orders/test/refund.test.ts`).
- **EC-MDT-3 / EC-TIME-5** — `REVOKED` writes `CANCELLED` and `EXPIRED` writes `AUTH_EXPIRED`; the void
  route only closes the enum (`OUT_OF_STOCK`, `REVOKED`, `CANCELLED`, `EXPIRED`) and never picks a status
  itself (`apps/web/app/api/orders/[id]/void/route.test.ts`, `packages/orders/test/void-reauthorize.test.ts`).
- **Merchant isolation (D-059, §7.2)** — a guessed `ord_...`, an order belonging to another merchant, and a
  capture belonging to another merchant are all `CS_NOT_FOUND`, with no PayPal call and no audit row. The
  predicate is the SQL join in `findOrderForMerchant` / `findCaptureForMerchant`, asserted against real
  Postgres (`packages/db/test/repos.orders.live.test.ts`,
  `apps/web/lib/order-ops.test.ts`).
- **A refusal is not an event.** A failed capture, a refused refund and an audit-chain failure write no
  `audit_log` row claiming the money moved (`apps/web/lib/order-ops.test.ts`).
- **§0 money discipline** — every amount out is `{ minor: "<decimal string>", currency }`; a float, an
  exponent or a negative minor is a 400 at the route (`apps/web/app/api/orders/[id]/refund/route.test.ts`).
