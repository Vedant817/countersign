# Countersign

**Agent purchases. Human limits.** Countersign explores signed buyer approvals, deterministic
payment checks and an authorization trail merchants can inspect when a purchase is disputed.

## Try the working local flows

Requirements: Node 24+, pnpm 12.8.1, Python 3.13 with uv, and a running Docker Desktop/Linux engine.

```sh
pnpm install --frozen-lockfile
uv sync --project apps/vi --extra dev
pnpm dev:local --seed
```

Open `http://localhost:3000`. Subsequent starts can use `pnpm dev:local` without `--seed` so
sample product stock is not reset. The launcher uses the repository's loopback-only PostgreSQL
container, applies migrations, generates temporary local service credentials without printing them,
and starts VI and Next. It refuses occupied ports instead of terminating another server.
Ctrl+C stops its web/VI processes; database data remains in the Docker volume.

Port 3000 and port 8000 are the busiest ports on a developer's machine, so both are overridable —
useful when something else is already listening, since the launcher will never end a process it did
not start:

```sh
COUNTERSIGN_VI_PORT=8010 COUNTERSIGN_WEB_PORT=3100 pnpm dev:local
```

The Playwright suite honours the same two variables, so `pnpm --filter @countersign/web exec
playwright test` follows the lab rather than fighting it.

- **Storefront:** choose a product and destination, inspect the currency, and create a signed quote.
  Quotes persist in PostgreSQL across web restarts. They do not place orders or reserve stock.
- **Signing lab:** create a non-extractable browser key and sign a sample mandate using a passkey.
  Requires a compatible secure-context browser and a passkey authenticator. The explicit local lab
  flag, loopback origin and non-production environment are required; production refuses sample issuance.
- **Demo guide and coverage:** understand what each flow proves and the current regional limits.

This launcher reads the repository's `.env.local` and merges it **under** the values it owns, so a
PayPal client id and secret placed there are used. As of 24 October 2026 the sandbox OAuth exchange
succeeds (`POST /v1/oauth2/token` → 200) and `/status` reports it accordingly. What is still missing is
the buyer, merchant, webhook and payer ids — so **no end-to-end PayPal purchase has been demonstrated
yet**, and `/status` reports exactly which dependency is short rather than claiming readiness it does
not have. VI's issuer and merchant keys are ephemeral in this prototype: restarting VI invalidates
earlier sample signatures even though quote rows remain stored.

## Eval reports

§8.20 asks for five numbers. Two are measured and three are not, and the difference is stated rather
than averaged away — an unmeasured metric is not a passing one.

| Report                               | Value             | Source                                  |
| ------------------------------------ | ----------------- | --------------------------------------- |
| Compiler exact match                 | **56/60 (93.3%)** | `packages/evals/corpus/compiler.jsonl`  |
| Injection attack-success at the Gate | **0/50 (0.0%)**   | `packages/evals/corpus/injection.jsonl` |
| Liability-router accuracy            | not measured      | corpus does not exist yet               |
| Agent refusal rate                   | not measured      | `packages/agent` is not built yet       |
| p95 Gate latency                     | not measured      | no load harness yet                     |

```sh
pnpm dev:local                                 # in another terminal
pnpm --filter @countersign/evals test          # 22 offline tests — no model, no network
pnpm --filter @countersign/evals eval:live     # both corpora against the running app
```

**Read those numbers with their denominators.** 60 and 50 hand-written cases are smoke tests, not
accuracy figures; §14's ≥ 95% target is **not met** by the 93.3% above, and the four failing cases are
named with their expected-versus-actual values by the runner. The injection corpus scores against what
the buyer's _sentence_ supports, which is stricter than the compiler's own literal-amount ceiling — a
case that fails because the ceiling allowed it is the finding, not a corpus bug.

Every scoring rule is exercised against a hand-built breach before it is allowed to report a clean run.
That is not ceremony: this repository shipped a `capOf()` that accepted only strings while the wire
format is numbers, so it matched nothing, printed `—` on every row and reported success for several
sessions. [`docs/COMPILER-EVAL.md`](docs/COMPILER-EVAL.md) has the full account.

## Built with

Submission requires a tools list; this is it, with what each is actually doing here.

- **PayPal REST APIs** — OAuth client-credentials, Orders v2, Vault (save payment methods), webhooks.
  Sandbox. `packages/paypal` is the only module that talks to PayPal, and it is the only place in the
  repository where a PayPal-shaped thing is invented. **There are zero real sandbox captures so far**:
  [`packages/paypal/test/fixtures/README.md`](packages/paypal/test/fixtures/README.md) states that
  plainly, explains that what exists is a `fetch` substitution (header assembly, multipart encoding,
  retry loop, circuit breaker and zod validation all run for real) rather than a mock of PayPal's
  behaviour, and commits to deleting itself once `scripts/capture-fixture.ts` has recorded real
  responses. Claims that only a real sandbox can settle are marked `UNVERIFIED` in
  [`packages/paypal/IDEMPOTENCY.md`](packages/paypal/IDEMPOTENCY.md) rather than quietly assumed.
- **PayPal MCP server** (`https://mcp.sandbox.paypal.com/http`) — reachable and probed by `/status`.
- **Model Context Protocol** — `apps/web/app/api/mcp/[transport]/route.ts` exposes the app's own tools to
  agents, with scopes.
- **PostgreSQL 16** (Docker) — mandates, orders, budgets, Gate decisions, webhooks.
- **Next.js 15 / React 19 / TypeScript 5.9** — web app.
- **FastAPI + Python 3.13 (uv)** — `apps/vi`, the verifiable-intent issuer and verifier, plus a
  standalone `verify.py` a third party can run without our code (see `/v/[packetId]`).
- **Ed25519 / SD-JWT / JCS (RFC 8785)** — mandate signing and selective disclosure.
- **WebAuthn / WebCrypto** — device-bound passkey signing in the browser; the key is non-extractable.
- **Zod** — every model output is validated before it is shown or acted on.
- **Playwright** — end-to-end browser suite.
- **Modal** — the model endpoint behind the intent compiler.

No LLM output is authoritative. Model output is validated by zod, shown to a human, or checked by
deterministic code before any side effect (§8.0 rule 4).

## Current payment boundary

Catalog and quote persistence, exact integer money, mandate signing and verification, the Gate's
deterministic checks, Gate decision persistence, the intent compiler and the MCP transport all exist and
are tested. The app still needs the buyer onboarding flow to save a real PayPal instrument, and there is
no complete PayPal purchase demonstration yet: the sandbox credentials that exist cover OAuth, not the
buyer/merchant/webhook ids the purchase path needs. See [human setup](docs/HUMAN_TODO.md) and
[current verification](docs/FINAL_REPORT.md); live/hosted acceptance must be recorded separately.

Physical shipping is currently quoted in USD for the configured destinations. Digital-only quotes
have zero shipping. Currency mismatches are refused, never silently converted. Regional PayPal
feature availability is separate from delivery coverage.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm vi:test
pnpm secret-scan
pnpm build
pnpm --filter @countersign/web exec playwright install chromium
pnpm --filter @countersign/web test:e2e
```

For checkout E2Es, start `pnpm dev:local --seed` first; the browser suite can reuse those local
services. Tests make no live PayPal payments. Browser artifacts and dependency caches are ignored.

Authoritative engineering specification: [blueprint](docs/spec/countersign-blueprint.md).
License: [Apache-2.0](LICENSE). Sponsor products have separate terms; see the hackathon research
before enabling a trial or deploying it publicly.
