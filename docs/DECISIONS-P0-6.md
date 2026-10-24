# D-055 — The shopping agent is a tool loop over the merchant MCP; its one fixture is key custody

**Date:** 2026-10-26
**Status:** implemented (P0-6 / WP-13 + WP-17b)

**Decision.** `packages/agent` implements §8.13 as a `streamText` loop over **seven declared tools** — the
five merchant MCP tools (`search_products`, `get_product`, `create_checkout`, `submit_checkout`,
`get_order_status`) plus two local ones (`read_my_mandate`, `sign_l3`) — with `stopWhen:
isStepCount(12)`. Merchant tool results are fenced by `fence.ts` before the model sees them. The commerce
surface is **our own merchant MCP** over HTTP with a 15-minute `agt_` bearer, as §8.14 specifies; the
hosted PayPal MCP server is documented below as an alternative transport, not used.

Four consequences are decisions rather than implementation detail:

1. **The merchant tools are declared in `tools.ts`, not taken from `MCPClient.tools()`.** `tools()` maps the
   server's JSON Schema straight to the model and removes the only place a result can be fenced. Declaring
   the seven tools buys that hook; the cost — a tool the merchant adds is not available until we declare it —
   is the intended default, because a merchant should not be able to widen the agent's reach by deploying.
2. **The fence strips its own markers from the content it wraps** (`escapeFenceMarkers`), so a listing cannot
   close the fence early and have its tail read as agent instructions. The detector
   (`inspectUntrustedText`, eight flag kinds) is a pattern table, never a decision: it drives the UI badge
   and is never consulted before a purchase. The advisory classifier is **additive only** — it can raise a
   flag and can never clear a deterministic one.
3. **Two planners, one tool surface.** `runShoppingAgent` drives it with a model;
   `runScriptedShopper` walks the same `AgentOps` in a fixed order with no model, in three behaviours
   (`lawful`, `instructed`, `compromised`). The scripted path is what makes the published refusal rate
   reproducible by a judge with no provider key, and it shares every control with the model path.
4. **The demo's buyer key is generated server-side** (`apps/web/lib/demo-device.ts`), because S-10 has no
   browser tab to hold a non-extractable device key. It is single-use, never persisted, and gated behind
   `COUNTERSIGN_AGENT_DEMO=1` outside production. Everything else in a session is real: vi mints the agent
   key, issues the L1, prepares the L2, verifies the P-256 signature on finalize, and the mandate, budget
   and wallet cap land in Postgres. The one thing lost is _key custody_, and it is stated in the module
   header rather than hidden.

**Reason.** The judge panel scored "agentic commerce" 3/10 with the sentence _"The agent doesn't exist
(WP-13)"_, which was literally true — `packages/agent/src/index.ts` was `export {}`. §8.13 also makes an
architectural claim that is worth being able to demonstrate rather than assert: the agent is allowed to be
wrong, confidently and at length, because every authority in a run is a **tool result**. The `compromised`
behaviour exists to show the consequence: an agent that fabricates an authorisation still gets a Gate BLOCK,
and the block carries a sentence a buyer can read.

**What was rejected.**

- **The hosted PayPal MCP server as the agent's transport.** It works over SSE with a bearer token minted
  from the same client credentials (`scripts/paypal-mcp.mjs`, 46 tools, verified 25 Oct 2026), but its
  catalogue has no vault or webhook tools and `list_transactions` answers 403. Our own merchant MCP is the
  integration surface this project is about; the hosted server stays a probe.
- **Making `sign_l3` pre-check the amount and then reporting that refusal as the Gate's.** A signer refusal
  is `VI_CONSTRAINT_VIOLATION` from vi and a Gate refusal is a decision record; conflating them would make
  the demo report a control it did not exercise. The two are separate outcomes (`SIGNER_REFUSED`,
  `GATE_BLOCKED`) and the refusal corpus reports both.
- **Rendering the read-back by hand in the session provisioner.** `readBack` is the compiler's template, and
  a paraphrased sentence would be a promise the signature does not cover (§8.8). The session builds a
  `CompiledMandate` and calls the real template.

**Related defect fixed in the same branch (see `docs/contract-issues.md` #10).** Two `@countersign/db`
faults made **every** Gate evaluation block with `CS_INTERNAL`, so no purchase could be decided at all:
`Date` parameters inside Drizzle `sql` templates throw `ERR_INVALID_ARG_TYPE` (10 call sites, fixed with
`.toISOString()`), and `sum(bigint)` comes back from postgres.js as a **string** while the code types it
`bigint`, so `claimed + amount.minor` threw _"Cannot mix BigInt and other types"_ in Gate check 9 (fixed
with one `sumToBigInt` boundary helper). Both are recorded because they are the difference between "the
Gate works" and "the Gate has never run".

**Evidence.** `docs/verification/P0-6.md` (acceptance, with real PayPal order and decision ids),
`docs/verification/P0-6-refusal.md` (the 30-case measurement), `packages/agent/test/*` (66 tests),
`apps/web/app/api/mcp/[transport]/route.test.ts` (23 tests), `scripts/agent-acceptance.mts`,
`scripts/agent-refusal.mts`, `scripts/db-debug.mts`.
