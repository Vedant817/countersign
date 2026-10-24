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

- **Storefront:** choose a product and destination, inspect the currency, and create a signed quote.
  Quotes persist in PostgreSQL across web restarts. They do not place orders or reserve stock.
- **Signing lab:** create a non-extractable browser key and sign a sample mandate using a passkey.
  Requires a compatible secure-context browser and a passkey authenticator. The explicit local lab
  flag, loopback origin and non-production environment are required; production refuses sample issuance.
- **Demo guide and coverage:** understand what each flow proves and the current regional limits.

This launcher disables PayPal credentials. `/status` therefore reports PayPal as unavailable;
it must not claim that the app can move money. VI's issuer and merchant keys are ephemeral in this
prototype: restarting VI invalidates earlier sample signatures even though quote rows remain stored.

## Current payment boundary

Catalog/quote persistence, exact integer money, signing, MCP authentication/scopes and independent
backend packages exist. The app still needs authenticated wallet/agent onboarding, persisted tenant
authority and budget/replay state connected to the order runtime, and the merchant dispute workspace.
MCP purchase and order-status calls fail closed until that integration exists. There is no complete
PayPal purchase demonstration yet. See [human setup](docs/HUMAN_TODO.md) and
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
