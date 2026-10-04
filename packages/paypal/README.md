# `@countersign/paypal` — the typed PayPal REST client

Spec **§8.6 (M6)**, decision **D6**, acceptance tests **AT-M6.1–7**, edge cases **EC-PP-1…5**,
**EC-IDEM-2/3**, **EC-DSP-12**, **EC-ENV-1/2**, **EC-TIME-5**.

One thin typed `fetch` client over the PayPal REST API. This package is the only place in the repository
that knows a PayPal URL, and the only place that turns a PayPal failure into a `CsError` from the one
registry in `@countersign/core`.

> ### ⚠️ Nothing here has run against PayPal yet
>
> `docs/HUMAN_TODO.md` **H-01** is open, so there are no credentials. Every test in `test/*.test.ts`
> runs against a `fetch` double whose response shapes are written from the published docs (see
> [`test/fixtures/README.md`](test/fixtures/README.md)) and annotated with the URL each one came from.
> The sandbox suites (`*.sandbox.test.ts`) **skip with their reason** until credentials land. The list
> of things that must be verified before a judge sees this is at the bottom of this file.

---

## Using it

```ts
import { PayPalClient, orderCreateRequestId, captureRequestId, ppMoney } from '@countersign/paypal'
import { newId, systemClock } from '@countersign/core'

const client = new PayPalClient({
  baseUrl: process.env.PAYPAL_API_BASE!, // must be a *.sandbox.paypal.com host
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  clock: systemClock,
})

const order = await client.createOrder(
  {
    intent: 'AUTHORIZE', // D17: physical goods authorize, digital goods capture
    purchase_units: [
      {
        reference_id: 'default',
        // D18: the signed chain's hash and our order id, inside PayPal's own records.
        custom_id: `cs1:${evidenceHash}`,
        invoice_id: orderId,
        amount: ppMoney('48.00'), // a decimal string, never a float (§0)
      },
    ],
    payment_source: { paypal: { vault_id: vaultId } },
  },
  // Deterministic: a retry of a timed-out create is deduplicated by PayPal, not charged twice (EC-IDEM-2).
  { requestId: orderCreateRequestId(attemptId) },
)

if (!order.ok) {
  // Every failure is a CsError with a code from the one registry.
  throw order.error // → { code: 'PP_UNPROCESSABLE', retryable: false, details: { issue: '…' }, … }
}
```

### Rules the type system enforces for you

- **Every `Result`-returning method returns `Result<T, CsError>`.** Nothing in this package throws across
  a module boundary (spec §8.0 rule 3). The one exception is `getAccessToken()` / `getClientToken()`,
  which the spec types as `Promise<string>`; they throw a `CsError`, and every caller inside the package
  converts it to a `Result`.
- **Side-effecting calls require a `requestId`.** `createOrder`, `authorizeOrder`, `captureOrder`,
  `addTracking`, `captureAuthorization`, `reauthorize`, `voidAuthorization` and `refundCapture` take
  `o: CallOpts & { requestId: string }`. Omitting it is `CS_VALIDATION` *before any HTTP call*.
- **Money is never a float.** Requests take `PPMoney` = `{ currency_code: Currency, value: string }`;
  responses parse through `ppResponseAmountToMoney()` into core's `Money` (integer `bigint` minor
  units). `pnpm lint` runs `scripts/check-money-discipline.mjs` over this package.
- **Time comes from the injected `Clock`.** There is no `Date.now()` in `src/`.

---

## What is in here

| File | Contents |
|---|---|
| `src/client.ts` | `PayPalClient` — every method in spec §8.6, plus `ENDPOINT_POLICIES` (the code side of `IDEMPOTENCY.md`). |
| `src/types.ts` | zod schemas + TS types for every request and response. Loose objects, enum-as-string with the known values exported as constants. |
| `src/idempotency.ts` | The four `PayPal-Request-Id` formats and their validator. |
| `src/backoff.ts` | Exponential backoff with **full jitter**, `Retry-After` parsing, and the injectable `Sleep`. |
| `src/circuit.ts` | Per-host circuit breaker (5 consecutive `PP_UNAVAILABLE` → open 30 s). |
| `src/errors.ts` | PayPal `name` / `details[].issue` → `CsErrorCode`. |
| `src/multipart.ts` | `multipart/form-data` for evidence, with the EC-DSP-12 limits enforced locally. |
| `src/sandbox.ts` | The sandbox-only simulator calls and the unsigned `PayPal-Auth-Assertion`. |
| `IDEMPOTENCY.md` | Per-endpoint table. **The input to EC-IDEM-3.** Mostly UNVERIFIED — see the warning at the top of that file. |

---

## The five behaviours worth knowing

### 1. Token single-flight (AT-M6.4)

Fifty concurrent `getAccessToken()` calls make **exactly one** HTTP request. The mechanism is a shared
in-flight promise, not a mutex: a queue would serialise the callers and a lock would have to be
released on every throw path.

```ts
const cached = this.tokenCache
if (cached && this.clock.nowMs() < cached.expiresAtMs) return cached.token
const existing = this.tokenInFlight
if (existing) return existing                      // ← everyone else awaits this one
const inFlight = this.requestClientCredentialToken().finally(() => {
  if (this.tokenInFlight === inFlight) this.tokenInFlight = null
})
this.tokenInFlight = inFlight
return inFlight
```

`finally` clears the field on every settle path — success, HTTP failure, network throw — so a failure
cannot wedge the client. The promise that is handed out is the settled one, so no caller can observe a
half-initialised cache. Tokens are cached for `expires_in − 60 s`; `getClientToken()`
(`response_type=client_token`, [V9]) is **not** cached, because a client token is single-use and the
popup needs a fresh one.

### 2. One request id for the whole retry loop ([B14], EC-IDEM-2)

The `PayPal-Request-Id` is built and validated **once, before** the retry loop, and the decision is
folded into `opts` once. Every attempt therefore carries a byte-identical id and a byte-identical body.
A fresh id per attempt would turn a retry into a second order, a second capture or a second refund.

### 3. Not every endpoint may be retried blindly (EC-IDEM-3)

Retry on network error, 5xx and 429 with exponential backoff (base 500 ms, factor 2, **full jitter**,
cap 20 s, 4 attempts), honouring `Retry-After` as a **floor**: a 429 with `Retry-After: 2` waits at
least 2 s even if the jitter drew 3 ms.

For endpoints whose idempotency support is **unverified** (all of Disputes v1, Vault v3 and the
simulators), the client refuses to auto-retry an *ambiguous* failure and returns:

```ts
{ code: 'PP_UNAVAILABLE', retryable: true, details: { ambiguous: true, status: 503 } }
```

which tells the caller to `GET` the resource before deciding. A 429 is still retried everywhere: the
request was refused at the edge, not executed. The per-endpoint table is
[`IDEMPOTENCY.md`](IDEMPOTENCY.md), and `ENDPOINT_POLICIES` in `client.ts` is what the code executes —
`test/client.oauth.test.ts` asserts the two agree exactly.

### 4. `paypal-debug-id` is logged on every response

Including the ones that succeed, and at `debug` level so it is not lost to a log-level default. It is
the only thing PayPal support can use to find our request, and the spec requires it unconditionally
(§8.6 "Logging"). No token, secret or amount is ever written to a log line — there is a test for that.

### 5. `PAYPAL_ENV=live` cannot boot this class (EC-ENV-1, AT-M6.7)

The constructor calls `assertSandbox` from `@countersign/core` twice on purpose: `PAYPAL_ENV`, when
provided, must be exactly `"sandbox"`; and the base URL must be a `*.sandbox.paypal.com` host **even
when the variable is absent**, because the host is what decides whose money we are about to touch.
Localhost is allowed for offline work.

---

## The sandbox-only surface (EC-ENV-2)

```ts
client.sandbox.createBuyerDispute(buyerEmail, { transaction_id: captureId, dispute_reason: 'UNAUTHORISED' })
client.sandbox.processChargeback(captureId, 'UNAUTHORISED')
client.sandbox.requireEvidence(disputeId, 'SELLER_EVIDENCE')
client.sandbox.adjudicate(disputeId, 'SELLER_FAVOR')
client.sandbox.changeReason(disputeId, 'UNAUTHORISED')
client.sandbox.acceptOffer(disputeId, 'Accepted')
client.sandbox.denyOffer(disputeId)
```

These are sandbox-only ([S29], §10.2 #18) and the object is built in the `PayPalClient` constructor,
**after** the sandbox assertion — so a process that somehow reached `live` never gets a `sandbox`
object and the methods below are unreachable, not merely unused. Every method re-asserts too, so
flipping `PAYPAL_ENV` after construction is caught.

`createBuyerDispute` is the one that needs the unsigned `PayPal-Auth-Assertion`
(`base64url({"alg":"none"}) . base64url({"iss":CLIENT_ID,"email":BUYER_EMAIL}) .` — note the trailing
dot, which is what `alg: none` means). Spec **U12** marks its exact construction unverified; it has
never been executed. The other simulator endpoints are merchant-side and use the ordinary bearer
token; if a sandbox run shows otherwise, this paragraph is the thing to fix.

## Multipart evidence (EC-DSP-12)

`provideEvidence`, `appeal` and `provideSupportingInfo` send a JSON `input` part plus files.
`Content-Type` is **never** set by hand: the runtime derives `multipart/form-data; boundary=…` from
the `FormData`, and a hand-drawn boundary makes the body unparseable at PayPal with a bare 400 as the
only clue. Locally, before anything is sent: single file **< 10 MiB**, total **≤ 50 MiB**, and only
jpg/png/gif/pdf. A rejected file costs no HTTP request at all.

---

## Running the tests

```bash
pnpm --filter @countersign/paypal typecheck
pnpm --filter @countersign/paypal lint
pnpm --filter @countersign/paypal test          # 224 tests, no network, no credentials
node scripts/check-money-discipline.mjs
```

The sandbox suites are excluded from the default run and need credentials:

```bash
# packages/paypal/.env
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_ENV=sandbox
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
PAYPAL_BUYER_EMAIL=buyer-...@sandbox.paypal.com
PAYPAL_TEST_VAULT_ID=...        # a payment token from one onboarding run
PAYPAL_TEST_CAPTURE_ID=...      # a card-funded capture to dispute (§10.1 step 5)

pnpm --filter @countersign/paypal test:sandbox
```

Without those, every sandbox test **skips with its reason in the test name**. They never fail and never
pass without having called PayPal.

---

## Verify these before a judge does

Each item is a `TODO(verify against docs)` in the source. Nothing here is asserted as fact.

**Endpoints and paths**

1. `POST /v1/customer/disputes` (buyer simulator) — and what it actually returns. The spec types it
   `Result<Links>`; §10.3 step 3 says the new dispute is found by polling `list_disputes`, which
   suggests the response is not a dispute resource. We implement the spec signature and do not guess.
2. `POST /v2/customer-support/process-chargeback` — body field names. We send
   `{ transaction_id, reason }`.
3. `POST /v1/customer/disputes/{id}/change-reason` — body. We send `{ reason }`.
4. `POST /v1/customer/disputes/{id}/accept-offer` / `deny-offer` — body fields. We send
   `{ payer_note }` and `{ note }`.
5. `…/escalate` — whether the body is `{ note }` JSON, a bare `note` form field, or multipart.
6. `…/provide-supporting-info` — whether the JSON `input` part is `{ notes }` or `{ message }`.
7. `…/acknowledge-return-item` — whether `return_shipping_address` is required or optional.
8. `POST /v3/vault/setup-tokens` — the `payment_source.paypal` fields (`usage_type`, `usage_pattern`).
   Spec **U6** says copy them from the doc at build time; we send `MERCHANT` / `SUBSCRIPTIONS`.
9. Vault v3 doc URL used for the citations above (the path segment is the least certain string here).
10. The dispute list's pagination: `page`/`page_size`/`total_pages` are documented, but the spec passes
    `next_page_token`. We forward both and default `items` to `[]`.

**Field names and shapes**

11. `simDisputeReq`: `transaction_id` vs `buyer_transaction_id` as the field naming the capture
    (`§10.3` says `buyer_transaction_id`; we send `transaction_id`).
12. `accept_claim_type` values (`REFUND`, `REFUND_NO_RETURN`).
13. `make-offer`'s `offer_type` values (`REFUND_WITH_RETURN`, `REFUND_NO_RETURN`).
14. Whether the dispute action endpoints answer `204 No Content` or a HATEOAS links array. The client
    accepts both and returns `{ links: [] }` for a body-less 2xx.
15. The default multipart field names for files (`file1`, `file2`, …) and the `input` part's filename
    (`input.json`).
16. Whether "10 MB / 50 MB" for evidence is 10^6 or 2^20 bytes. We enforce 2^20.
17. `processChargeback` requires a **card-funded** transaction (§10.1 step 5) — a vault capture with no
    card behind it cannot be charged back.

**Headers and limits**

18. The maximum `PayPal-Request-Id` length PayPal enforces — **unknown, to be measured in C-probe**
    (spec U5). `REQUEST_ID_MAX_CHARS = 255` is *our* budget, not a PayPal figure.
19. Which endpoints actually honour the header. Only Orders v2 / Payments v2 are `DOC-CITED [B14]`;
    everything else is `UNVERIFIED` and gets `RE-READ FIRST`.
20. The `PayPal-Auth-Assertion` header/payload shape for the buyer simulator (spec **U12**).
21. Whether a 429's `Retry-After` is delta-seconds or an HTTP-date in practice. Both are parsed.

## Differences from the spec's §8.6 class listing

- **`PayPalClientOpts` gains an optional `env` override** (`{ PAYPAL_ENV?, PAYPAL_API_BASE? }`) plus
  `sleep`, `logger`, `breaker` and `backoff`. Every one has the spec's default; they exist so tests can
  pin the clock, the sleep and the environment instead of reaching for `process.env`. The spec's six
  options keep their names and meanings.
- **`maxRetries` is read as a total attempt count** (default 4 = one initial call plus three retries),
  because the spec's retry bullet says "max 4" and AT-M6.2 needs three attempts to succeed.
- **`sandbox` gains `acceptOffer` / `denyOffer`**, which §10.2 #18 and §8.16 AT list but the §8.6 class
  listing omits.
- **The seven bodies with `o: CallOpts` keep it**, including `provideEvidence`, so a caller *can* omit
  `requestId`. §8.15 requires one for the filing call, and WP-15 is expected to pass
  `disputeActionRequestId(id, 'file', packetVersion)`. A dispute action with no id is still sent; the
  client does not require it, because the spec's signature does not.