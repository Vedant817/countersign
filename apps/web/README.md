# Countersign web app

## Merchant MCP (WP-14)

`/api/mcp/http` mounts `mcp-handler` with five zod-validated tools:
`search_products`, `get_product`, `create_checkout`, `submit_checkout`, and `get_order_status`.
Amounts returned over MCP use decimal strings in integer minor units.

Every request needs an HS256 bearer issued for an `agt_` subject and the
`countersign-merchant-mcp` audience. Tokens expire after at most 15 minutes.
Set `SESSION_SECRET` through the environment (at least 32 characters), then run
`pnpm mcp:token <agent-id>` locally. The CLI prints a bearer: treat its output as a credential.
There is no public token-minting endpoint. Minting failures return `Result<string, CsError>`.

Start the app with `pnpm dev` and use MCP Inspector's HTTP transport at
`http://localhost:3000/api/mcp/http`, supplying the bearer through its Authorization header.
Missing, invalid, or expired bearers receive 401.

Catalog and checkout sessions share the shop's process-local stores. Creating a checkout requires
the configured VI service to sign its price lock. Submissions run the actual Gate evaluator over
an in-memory world, with VI verification and merchant keys replaced by the configured service;
when VI configuration is absent these checks refuse the chain. This is a transport demonstration,
not a persistent purchase integration: mandate/agent/budget state is still the Gate world's seeded
state. Order creation has no database/PayPal adapter and returns `CS_INTERNAL` after an ALLOW;
order lookup currently returns `CS_NOT_FOUND`. Restarts discard the process-local state.

Validation on 24 October 2026 (IST): 40 web tests, 2,536 repository tests, typecheck, lint, format,
build, and secret scan passed. MCP Inspector 2.12.0 CLI listed all five tools against `next start`;
HTTP initialization, catalog search, missing/forged bearer rejection, and a real Gate BLOCKED
submission passed. No successful purchase or live PayPal transaction was exercised.
