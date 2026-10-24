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
