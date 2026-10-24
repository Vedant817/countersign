# Merchant MCP boundary verification

2026-10-24 (IST). Base: `32397d1`; branch: `wp/14-mcp-hardening`.
Scope: the MCP token module, route, their tests, and this report only.

## Reproduced before repair

Command: `pnpm exec vitest run --project web lib/mcp-token.test.ts 'app/api/mcp/[transport]/route.test.ts' --maxWorkers=2`.
Against the original implementations with regression tests added: **25 failed, 28 passed**.

- Correctly signed tokens with absent/future/fractional `iat`, excessive or nonpositive lifetime,
  missing/malformed/unknown scopes, and malformed or oversized subjects were accepted. A signed
  read-only token acquired checkout scope. Minting also accepted invalid subjects/timestamps or
  misclassified invalid timestamps as internal errors. These claim attacks require a valid signing
  capability; they do not demonstrate signature forgery.
- A read-only token reached checkout signing and Gate evaluation. A seeded principal's submission
  returned a fixture-backed `BLOCKED` decision instead of reporting absent persisted authority.
  The route retained seeded ACTIVE principals/mandate, budgets and unsigned decision signing from
  `createInMemoryGateWorld`. No forged `ALLOW` or payment was demonstrated: order creation already
  refused. A real VI verifier alone does not make these persistence substitutes authoritative.
- Fresh, otherwise-valid wrong-audience/issuer/subject and HS384 controls already rejected correctly.
  Their tests now include valid lifetime and scopes so another missing claim cannot mask the result.

## Changes and local evidence

- Verification requires safe integer issuance/expiry, positive lifetime at most 900 seconds and no
  issuance more than five seconds ahead. Only signed recognized scopes reach `AuthInfo`; every tool
  checks its own read/checkout grant before work. Existing mint defaults and valid capped TTLs remain.
- Subjects are bounded to 128 ASCII identifier characters including `agt_`; bearers to 8 KiB before
  decoding. Submission chains are bounded to 64 KiB each; IDs to 128 characters. Money filters require
  safe integers. Errors use existing `CS_VALIDATION`, `CS_FORBIDDEN`, `CS_UNAUTHENTICATED`, `CS_INTERNAL`.
- Removed the reachable test-world composition. `submit_checkout` and `get_order_status` return MCP
  tool errors with `CS_INTERNAL` until an authoritative persisted runtime exists. No Gate decision,
  budget reservation, transaction facade or order is fabricated. This containment intentionally leaves
  the full AT-M14 purchase round-trip incomplete.
- All five tools remain discoverable. HTTP and SSE mount paths serve catalog calls. Read-only callers
  retain catalog access and cannot create/submit checkouts. Configured-VI submission makes zero fetch
  calls. `create_checkout` retains the existing shop/real-VI signing port and refuses missing config.

Focused verification: **61 tests passed** across the two owned suites. Independent read-only
investigation and candidate review found no concrete surviving bypass or unintended regression.
Web typecheck, scoped ESLint and Prettier checks passed. Repository lint and money discipline passed;
`pnpm secret-scan` passed both working-tree and 182-commit history scans with no leaks.

Broader checks:

- `pnpm test`: **89 files / 2,580 tests passed, no skips**, 73.48 seconds on the final run. The first
  broader run, concurrent with the production build and other checks, had one unrelated verifier
  checkout-parity timeout (30-second limit), 2,549 passes and 30 skips. After the build completed, the
  unchanged command passed, including that parity case. No timeout settings or verifier files changed.
- `pnpm typecheck`: passed across the workspace.
- `pnpm lint`: passed, including money discipline (117 files across 15 roots).
- `pnpm format:check`: passed across the repository.
- `pnpm --filter @countersign/web build`: passed, including production route generation.
- Final delta: `gitleaks detect --source . --log-opts=32397d1..HEAD --redact --config .gitleaks.toml`
  and `gitleaks dir docs/verification --redact --config .gitleaks.toml`: passed, no leaks.

Code commits: `0fc383a` (bearer contract) and `e446fbb` (persisted-runtime refusal and transport grants).
No merge or push performed. These are local checks; no hosted/CI acceptance is claimed.

## External integration blocker

The route has no persisted composition for tenant-bound mandate/agent/device/L1 lookup, signed Gate
records, durable replay/budget transactions, checkout/order repositories and the WP-11 order runtime.
Adding an adapter would cross the assigned ownership boundary. The parent must compose these before
enabling purchases/order lookup, then verify real VI and captured sandbox PayPal flows, deterministic
request IDs, concurrency, restart/replay and cross-tenant denial. No credentials were inspected and no
network payments or new PayPal fakes were used. Live sandbox, hosted/CI acceptance, currency/country
coverage and a complete international purchase remain unverified by this patch.
