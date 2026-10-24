# Main integration and app verification report

Date: 24 October 2026 (IST). Integration merge: `ea2124d` on `main`.

All local work branches are included in `main`. The integration branch combined WP-14 (`cbdce9e`)
and the five outstanding WP-11 branch commits, including the orchestrator binder (`e0fb068`).
Documentation conflicts were resolved by retaining both sets of changes; the binder's duplicate
D-044 decision was renumbered D-047. No application-code conflict occurred. The final application
tree on `main` is identical to the tree that passed the integration gates.

The merchant MCP route registers the five M9 tools, validates wire inputs with zod, verifies
15-minute agent bearers, and routes submissions through the Gate evaluator. Token minting uses
the repository's `Result` error contract. Tests generate runtime signing keys. Historical dummy
values have exact path/value exceptions limited to the two triggering Gitleaks rules.

Local validation passed:

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm secret-scan`, `pnpm build`.
- Full TypeScript suite: 89 files, 2,536 tests. Web suite: four files, 40 tests.
- Python VI suite: 207 tests; Python lint and format checks passed.
- Chromium E2E: all seven existing tests passed against Next and the real local VI service using
  the repository's public test configuration. These cover non-extractable device keys, L2 signing,
  lost-key recovery, P1363 signatures, catalog search, injection labeling, and checkout price locking.
  The first attempt could not launch because Playwright's Chromium binary was absent; installing
  the matching binary resolved this environment issue.
- MCP Inspector 2.12.0 CLI listed five tools against the built `next start` HTTP endpoint.
- The built server accepted initialization and catalog search, rejected missing/forged bearers
  with 401, and returned BLOCKED reasons from the real Gate for a submitted invalid chain.
- Temporary adversarial scans confirmed the historical exception does not suppress new secrets
  in either test file or the historical value at another path.
- The merged production build returned 200 for `/`, `/judge`, `/shop`, `/shop/NW-001`, and
  `/lab/device-sign`. Its MCP initialization, authentication, search and BLOCKED submission checks
  passed again after the merge.

The implemented flows pass their local checks, but the complete payment app is not operational.
In the normal app environment, `/status` returned 503: Postgres, VI and PayPal OAuth were all
`not_configured`. The E2E suite supplies its own local VI configuration; its success does not
prove the normal deployment is configured. No secrets were requested or added during verification.

WP-14 remains in review. The shop checkout store and Gate world are process-local; agent, mandate and
budget state are seeded rather than backed by production repositories. An ALLOW cannot create a
PayPal order, and order lookup has no persisted order source. Connecting these adapters remains
implementation work, detailed in [contract issues](contract-issues.md). Buyer onboarding, agent chat,
merchant workspace and the Judge Mode scenario runner are also unfinished. No successful purchase,
live PayPal transaction, hosted deployment, or CI acceptance is claimed.

The shared preview timed out; browser evidence comes from the repository's Chromium E2E suite.
Test servers were stopped when verification finished. Existing human setup requirements remain in
[HUMAN_TODO.md](HUMAN_TODO.md).

Details: [web README](../apps/web/README.md), [scan triage](verification/secret-scan-triage.md),
[transport checks](EDGE-CASES.md), and [decision D-046](DECISIONS.md).
