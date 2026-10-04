# `@countersign/vi-client`

The typed TypeScript client for **`apps/vi`** (vi-service, the FastAPI crypto oracle). Spec **§8.4
(M4)**, work package **WP-04**.

One `fetch` client, one method per route, and hand-written zod schemas that mirror
`apps/vi/src/vi_service/models.py`. Nothing in this package knows a vi URL except `ViClient`, and nothing
in the repository turns a vi failure into an error except it.

```bash
pnpm --filter @countersign/vi-client typecheck
pnpm --filter @countersign/vi-client lint
pnpm --filter @countersign/vi-client test          # no network, no service needed
```

## The routes

Auth is per spec §8.3: everything needs `Authorization: Bearer $VI_SERVICE_TOKEN` except the two routes
marked **public**, which are rate-limited to 30 req/min/IP. The client reads this from a table
(`ROUTE_CONTRACTS` in `src/types.ts`) rather than hard-coding it, so a route added to the service without a
bearer token cannot be reached by accident.

| Method | Route                     | Client method            | Auth       | Returns                     |
| ------ | ------------------------- | ------------------------ | ---------- | --------------------------- |
| `POST` | `/v1/keys/agent`          | `mintAgentKey(req)`      | bearer     | `MintAgentKeyResponse`      |
| `POST` | `/v1/keys/rotate`         | `rotateKey(req)`         | bearer     | `RotateKeyResponse`         |
| `GET`  | `/v1/jwks`                | `jwks()`                 | **public** | `JwksResponse`              |
| `POST` | `/v1/l1/issue`            | `issueL1(req)`           | bearer     | `L1IssueResponse`           |
| `POST` | `/v1/l2/prepare`          | `prepareL2(req)`         | bearer     | `L2PrepareResponse`         |
| `POST` | `/v1/l2/finalize`         | `finalizeL2(req)`        | bearer     | `L2FinalizeResponse`        |
| `POST` | `/v1/checkout-jwt`        | `createCheckoutJwt(req)` | bearer     | `CheckoutJwtResponse`       |
| `POST` | `/v1/l3/create`           | `createL3(req)`          | bearer     | `L3CreateResponse`          |
| `POST` | `/v1/verify`              | `verify(req)`            | bearer     | `VerifyResponse`            |
| `POST` | `/v1/public/verify`       | `publicVerify(req)`      | **public** | `PublicVerifyResponse`      |
| `GET`  | `/v1/status`              | `status()`               | **public** | `StatusResponse`            |
| `GET`  | `/v1/checkout-jwt/verify` | `verifyCheckoutJwt(jwt)` | bearer     | `CheckoutJwtVerifyResponse` |

`GET /v1/status` is also public: it is the liveness probe and carries no secrets. Every method returns
`Promise<Result<T, CsError>>` and never throws across the boundary (spec §8.0 rule 3).

Constructor: `{ baseUrl, token, clock, fetchImpl?, sleep?, logger?, timeoutMs?, maxRetries? }`. Base URL
and token are **arguments, not `process.env` reads** — this client is constructed in a Next route handler,
in the worker and in tests, and those three get config differently. `clock` is required: `Clock` is the
only time source in the codebase (spec §8.0 rule 10) and there is no `Date.now()` here.

## Five behaviours that are not obvious

### 1. `chain_valid: false` is a **success**

`POST /v1/verify` answers `200 {chain_valid: false, errors: […]}` for an invalid chain. That is a _verdict_,
so `verify()` returns `ok(...)` and the Gate reads `chain_valid`, `errors`, `constraints`, `disclosed` and
`keys`. Returning `err(...)` would discard every input the decision is made from and leave the Gate unable
to tell "the chain is invalid" from "we could not ask".

One trap inside that verdict, measured against a running service: `chain_valid` is
`chain.valid and not chain_errors and constraints.satisfied`, so a constraint violation makes
`chain_valid: false` **while `errors` is empty** — the explanation lives in `constraints.violations`.
"no errors" does not mean "valid". Also, a verify with no L3 and no `checkout_jwt` is always
`chain_valid: false`, because both fulfilment inputs are missing and vi fails closed on that.

### 2. `constraints.skipped` is how spec D19 reaches the Gate — and it is **not** a list of bare types

The pinned library appends `mandate.payment.budget`, `mandate.payment.recurrence` and
`mandate.payment.agent_recurrence` to `checked` while evaluating **none** of them. vi moves them into
`skipped` so the Gate can see what it still owes. But it moves them **with a reason appended**:

```jsonc
"checked": ["mandate.payment.amount_range", "mandate.payment.allowed_payees"],
"skipped": [
  "mandate.payment.budget — Network-enforced constraints. Not evaluated by verifiable_intent; Countersign's Gate enforces it (spec D19). NOT satisfied by this response.",
  "checkout constraint evaluation (needs the checkout_jwt cart)"
]
```

So `skipped.includes('mandate.payment.budget')` is **`false`, always**, and a Gate written that way would
conclude it owes nothing while a budget cap sits unevaluated — the precise failure D19 exists to prevent.
`checked` _is_ bare type names, so the two lists on one object have different element formats.

Use the helpers. They are the reason this package can hand the Gate a safe reading of that field:

```ts
pendingNetworkEnforcement(res.constraints.skipped) // ['mandate.payment.budget', …] — what the Gate owes
skippedConstraintTypes(res.constraints.skipped) // every registered type present, unannotated notes dropped
```

A non-empty result means "disclosed but evaluated by nobody". An **empty** result means none of those three
types were disclosed — a different and equally important fact, not the same as "nothing to do".

### 3. The retry rule, and why 4xx is not retried

Spec §8.4, verbatim: **2 retries on 5xx or connection error only.** It is an exported pure function,
`shouldRetry`, so the policy is one readable screen and `test/retry.test.ts` tables it exhaustively.

| Failure                           | Retried?                  |
| --------------------------------- | ------------------------- |
| connection error, our 5 s timeout | yes, while budget remains |
| 5xx                               | yes, while budget remains |
| **any 4xx**                       | **never**                 |

`VI_SIGNATURE_MISMATCH` is the reason this matters. It is a _verdict_, not an outage: the browser signed
the wrong bytes or holds the wrong key, a second identical attempt produces the identical verdict, and
retrying multiplies the cost of a rejected signature. `CS_UNAUTHENTICATED` means the token is wrong.
`CS_VALIDATION` means the request is wrong. **429 is 4xx and is therefore not retried either** — which looks
like an omission and is not: vi rate-limits its public routes at 30/min and answers with `Retry-After`, so
an immediate retry spends more of the window just exhausted and can extend the block. That error still
comes back `retryable: true` and the caller decides when to return.

The default backoff is full jitter from a 100 ms base, capped at 2 s — about 300 ms worst case for the whole
budget. §8.4 specifies the retry _count_ but not the spacing; the base is small because spec §14 budgets a
Gate decision at p95 400 ms. Inject `sleep` and the waits cost a test nothing.

### 4. The timeout is 5 s per attempt, and it is real

`AbortSignal.timeout(5000)` per attempt, so a hung vi-service cannot hang a Gate decision. Three attempts
can occupy up to 15 s of wall clock, which is already a breach of the 400 ms budget — the timeout is the
floor, not the fix. A timeout is classified distinctly from a connection reset (`details.timed_out`) and is
reported `CS_INTERNAL` + `retryable: true` + `ambiguous: true`: vi is our own internal service, so
`PP_UNAVAILABLE` would be a lie about which company is failing.

### 5. `signing_input` is passed through byte for byte

`prepareL2` returns the service's string verbatim, never a re-encoding, and the schema _asserts_ the
invariant: exactly two non-empty base64url segments, no trailing dot, each decoding to JSON, and each
matching the `header`/`payload` the same response returns.

This matters more than it looks. If the client re-encoded that string, the browser would sign different
bytes, `l2/finalize` would answer `VI_SIGNATURE_MISMATCH`, and the symptom looks exactly like a wrong device
key — sending a human after the wrong problem for hours. vi takes the same care (`l2.py::_signing_input_of`
reads the segments out of the library's own `issuer_jwt` rather than re-encoding the decoded dicts). The
`header`/`payload` cross-check matters too, because spec §8.5 requires the UI to render **the service's**
`payload` as the consent read-back: if it were not the payload being signed, the user would be consenting to
text the signature does not cover.

## Error mapping

The service's code survives verbatim, which is what keeps `VI_SIGNATURE_MISMATCH` from `l2/finalize` as
`VI_SIGNATURE_MISMATCH` — the browser UI branches on it to show "this device is new" (spec §8.5, EC-KEY-1).
Service `details` are passed through unscrubbed (vi already runs them through its `safe_details`).

One deliberate override: for a **5xx**, `retryable` is forced to `true` regardless of the body. vi's
catch-all handler maps a 500 onto `CS_VALIDATION` because its registry mirror predates `CS_INTERNAL`, and
"check your input, and do not retry" would send an operator hunting for a bad request that does not exist.
The **code is kept** — rewriting it would hide a real divergence between the two error registries — and
`details.http_status` is always present so the mismatch is visible in a log rather than inferred.

## Money

Integer minor units, everywhere. `minorUnitsSchema` refuses a non-integral number, a numeric string, a
negative, and anything past `Number.MAX_SAFE_INTEGER`, and yields **`bigint`** so that a later `amount / 100`
is a compile error rather than a rounding bug. `jsonSafeBody` is the single place that turns `bigint` back
into a JSON integer, and it refuses rather than rounding.

EC-FX-5 / EC-FX-6 caveat, stated because it is a real limit: vi's `_minor_before` rejects a Python `float`,
so `{"unit_minor": 13000.0}` is a `CS_VALIDATION` there. **A TypeScript client cannot reproduce that
check** — `JSON.parse("13000.0")` and `JSON.parse("13000")` produce the identical double, so the evidence
that a decimal point was written is gone by the time the request reaches us. What is preserved is the part
that matters: the value that reaches vi is an exact integer, so nothing is rounded.

## The schema drift check — AT-M4.2

Spec §8.4: _"vi exposes `/openapi.json`, and a script fails CI if the request/response fields differ from the
zod schemas."_

```bash
# against a running service
VI_SERVICE_URL=http://localhost:8000 pnpm --filter @countersign/vi-client schema-drift
# against a local file
pnpm --filter @countersign/vi-client schema-drift -- ./openapi.json
# machine-readable
pnpm --filter @countersign/vi-client schema-drift -- --json ./openapi.json
```

Exit codes: **0** no differences · **1** differences found · **2** the document could not be read. 2 is
deliberately not 1 — "I could not check" must never look like "I checked and it was fine".

**Compared**, per route and per side, recursively: field presence, required-vs-optional, `type` (as an
intersecting set), `enum`/`const` sets, and `additionalProperties`. Every difference fails, and each one
names the route, the side, the field path and the **direction** — a field the service has and we do not,
and a field we require and the service does not. The one-way check is the trap: it would pass while the
client demanded a field the service stopped sending.

**Not compared: numeric bounds and string lengths.** pydantic and zod express the same bound with different
JSON Schema keywords (`ge`/`le` → `minimum`/`maximum`, `gt`/`lt` → `exclusiveMinimum`/`exclusiveMaximum`)
and pydantic renders them as floats (`365.0`), so a bounds comparison would produce cosmetic CI failures
with little marginal signal. The drift that actually breaks a caller — a field changing type, appearing or
disappearing — is all caught above. This is a scoping decision, stated rather than hidden.

**Opaque positions are reported, not passed over.** vi declares `public_jwk`, `header`, `payload`, each JWKS
entry and both constraint arrays as bare `dict[str, Any]`, and gives `GET /v1/checkout-jwt/verify` no schema
at all. Those positions appear in the output as **unverifiable**, with a reason. They do not fail the check,
because claiming a match that cannot be made would be worse — but they are visible, so "cannot check" is
never confused with "checked". Note this client _does_ type the constraint arrays (as the tagged union of the
eight registered types, spec §8.8), refusing a constraint vi would reject before spending the round trip;
that is why those two positions are worth printing.

## Running the contract tests — AT-M4.1

`contract/at-m4.contract.ts` needs a **running vi-service** and is kept out of `pnpm test`, which must pass
with no network at all. The filename deliberately does not end in `.test.ts`: the root `vitest.workspace.ts`
run does file discovery with its own default pattern rather than each project's `include`/`exclude`, so a
`*.test.ts` name anywhere in this package would be pulled into the default run anyway. A name no include
pattern can match is the version of that guarantee which cannot regress.

With `VI_SERVICE_URL` unset the suite skips with a message saying why and how to run it — it never fails (a
missing service is not a client bug) and never passes silently (a skipped contract suite must not read as a
green one). The reason string is itself asserted by a test.

```bash
# 1. start the service
cd apps/vi && uv run uvicorn vi_service.main:app --port 8000

# 2. run the suite (or `docker compose` in CI, per §8.4)
cd packages/vi-client
VI_SERVICE_URL=http://localhost:8000 \
VI_SERVICE_TOKEN=… \
pnpm test:contract
```

The suite's centrepiece is one round trip: **issue L1 → prepare L2 → sign `signing_input` with a
locally generated P-256 key via WebCrypto → finalize → verify**. That is the real two-phase signing flow
over real HTTP, and `finalize` succeeding is a statement about the service verifying a real ES256 signature
against the key bound in the L1 — not about this client's plumbing. It also asserts that a _wrong_ key gets
`VI_SIGNATURE_MISMATCH`. Alongside it: auth enforcement, JWKS retired keys, agent-key minting (and that the
private half never appears in the response), the full autonomous chain with a price lock and an L3,
out-of-mandate refusal, the checkout diagnostic, key rotation with the retired kid still resolvable, and the
drift check against the running service.

## Tests

| File                         | What it covers                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.test.ts`              | the four mirroring rules, money, the constraint registry, the `signing_input` invariant, `skipped` / D19 helpers                               |
| `retry.test.ts`              | the retry policy as an exhaustive table, the backoff, timeout classification                                                                   |
| `client.test.ts`             | transport against an injected `fetch`: auth, error mapping for every code vi can return, retry wiring, the real timeout, request serialisation |
| `schema-drift.test.ts`       | AT-M4.2 against the committed fixture, **plus every injected drift** in both directions                                                        |
| `contract/at-m4.contract.ts` | AT-M4.1 against a live service; skipped without one                                                                                            |

No test in the unit suite opens a socket. `test/fixtures/README.md` explains where each shape came from and
how to regenerate the OpenAPI fixture when `apps/vi` changes a pydantic model.

## Known limits

- **Bounds and lengths are not drift-checked** — see above, deliberately.
- **`13000.0` cannot be distinguished from `13000`** on the TypeScript side of a JSON boundary.
- **`skipped` needs a helper to be readable** — see §2. The wire format is the service's, faithfully
  mirrored; the interpretation is ours.
- **`l3/create` retry safety has a boundary.** §8.4 says vi calls are idempotent, and `jti` is a
  deterministic hash of the L3a — but the L3a embeds `iat`, so a retry that crosses a second boundary can
  legitimately produce a different `jti` for the same checkout attempt. The Gate's replay key (WP-10), not
  this client, is where that has to be handled. Recorded in `ROUTE_RETRY_NOTES`.
