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
