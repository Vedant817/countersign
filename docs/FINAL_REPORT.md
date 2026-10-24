# WP-14 verification report

Date: 24 October 2026 (IST). Branch: `wp/14-merchant-mcp`.

The merchant MCP route registers the five M9 tools, validates wire inputs with zod, verifies
15-minute agent bearers, and routes submissions through the Gate evaluator. Token minting uses
the repository's `Result` error contract. Tests generate runtime signing keys. Historical dummy
values have exact path/value exceptions limited to the two triggering Gitleaks rules.

Local validation passed:

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm secret-scan`, `pnpm build`.
- Full suite: 89 files, 2,536 tests. Web suite: four files, 40 tests.
- MCP Inspector 2.12.0 CLI listed five tools against the built `next start` HTTP endpoint.
- The built server accepted initialization and catalog search, rejected missing/forged bearers
  with 401, and returned BLOCKED reasons from the real Gate for a submitted invalid chain.
- Temporary adversarial scans confirmed the historical exception does not suppress new secrets
  in either test file or the historical value at another path.

WP-14 is in review. The shop checkout store and Gate world are process-local; agent, mandate and
budget state are seeded rather than backed by production repositories. An ALLOW cannot create a
PayPal order, and order lookup has no persisted order source. Connecting these adapters remains
implementation work. No successful purchase, live PayPal transaction, hosted deployment, or CI
acceptance is claimed. `main` has not been merged or modified.

Details: [web README](../apps/web/README.md), [scan triage](verification/secret-scan-triage.md),
[transport checks](EDGE-CASES.md), and [decision D-046](DECISIONS.md).
