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
>
> **Field names are no longer guesses.** On 2026-10-04 every request body, response shape and enum in
> this package was re-checked against PayPal's published OpenAPI and `developer.paypal.com`. The
> report is [`docs/verification/paypal-api-2026-10-04.md`](../../docs/verification/paypal-api-2026-10-04.md);
> it found four fabricated bodies (the sandbox simulators) and a dozen wrong field names, **all now
> fixed**. What remains unverified is *behaviour* — whether a request id deduplicates, whether a header
> is honoured, whether the sandbox accepts our unsigned assertion — and that needs H-01.

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
| `src/multipart.ts` | `multipart/form-data` for evidence, with the EC-DSP-12 limits enforced locally (decimal, as PayPal words them). |
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
client.sandbox.createBuyerDispute(buyerEmail, {
  disputed_transactions: [{ buyer_transaction_id: buyerViewOfTheTransactionId }],
  reason: 'UNAUTHORISED',
  dispute_amount: ppMoney('20.00'),
})
client.sandbox.processChargeback({
  sellerTransactionId: captureId,
  merchantId: paypalMerchantId,
  amount: ppMoney('20.00'),
  reason: 'UNAUTHORISED',
})
client.sandbox.requireEvidence(disputeId, 'SELLER_EVIDENCE')
client.sandbox.adjudicate(disputeId, 'SELLER_FAVOR')
client.sandbox.changeReason(disputeId, { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', note: '…' })
client.sandbox.acceptOffer(disputeId, 'Accepted, thanks.')
client.sandbox.denyOffer(disputeId)
```

These are sandbox-only ([S29], §10.2 #18) and the object is built in the `PayPalClient` constructor,
**after** the sandbox assertion — so a process that somehow reached `live` never gets a `sandbox`
object and the methods below are unreachable, not merely unused. Every method re-asserts too, so
flipping `PAYPAL_ENV` after construction is caught.

**Four of these bodies were wrong before the 2026-10-04 audit, in ways that only a live call would
have exposed.** `createBuyerDispute` is `multipart/form-data` with an `input` part carrying
`disputed_transactions[].buyer_transaction_id` (not a JSON `{transaction_id}`);
`processChargeback` carries PayPal's eight documented fields (not `{transaction_id, reason}`) and reads
its `201` body instead of discarding it; `changeReason` sends the documented `{reason, note,
item_info[]}`; and `acceptOffer` sends `{note}`, not `{payer_note}`, and treats PayPal's documented
**`202 Accepted`** (money movement delayed) as success. `test/simulators.test.ts` pins every one of
those field names.

`createBuyerDispute` is the one that needs the unsigned `PayPal-Auth-Assertion`
(`base64url({"alg":"none","typ":"JWT"}) . base64url({"iss":CLIENT_ID,"email":BUYER_EMAIL}) .` — note the
trailing dot, which is what `alg: none` means, and `typ: JWT` from PayPal's own snippet). It is now
verbatim from <https://developer.paypal.com/disputes/set-up>, but it has never been executed: the REST
app needs the `DISPUTE_CREATE` and `UPDATE_BUYER` scopes and the buyer has to complete an interactive
consent flow first. The other simulator endpoints are merchant-side and use the ordinary bearer token.

## Multipart evidence (EC-DSP-12)

`provideEvidence`, `appeal` and `provideSupportingInfo` send a JSON `input` part plus files.
`Content-Type` is **never** set by hand: the runtime derives `multipart/form-data; boundary=…` from
the `FormData`, and a hand-drawn boundary makes the body unparseable at PayPal with a bare 400 as the
only clue.

The `input` part is PayPal's documented shape — `{"evidences": [{"evidence_type", "evidence_info",
"notes", "documents"}]}`, at most **100** items, and **`notes` is a single string** of ≤ 2000
characters, not an array. Files default to `file1`, `file2`, …, which is the form PayPal's own cURL
uses.

Locally, before anything is sent: single file **< 10 MB**, total **≤ 50 MB** — both decimal, both
**inclusive/exclusive exactly as PayPal words them** ("less than 10 MB per file", "up to 50 MB per API
call") — and only jpg/png/gif/pdf. A rejected file costs no HTTP request at all.

---

## Running the tests

```bash
pnpm --filter @countersign/paypal typecheck
pnpm --filter @countersign/paypal lint
pnpm --filter @countersign/paypal test          # 270 tests, no network, no credentials
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

Every field name and enum in this package was re-checked against PayPal's published OpenAPI and
`developer.paypal.com` on **2026-10-04**; the findings are in
[`docs/verification/paypal-api-2026-10-04.md`](../../docs/verification/paypal-api-2026-10-04.md) and
every fix from it is applied here. What follows is what is **still** not settled — because it needs a
sandbox (H-01), a human, or a PayPal answer.

**Blocked on a human, not on us**

1. **The buyer-dispute simulator needs two REST-app scopes and a consent flow.** `DISPUTE_CREATE`
   (`…/services/disputes/create`) and `UPDATE_BUYER` (`…/services/disputes/update-buyer`) have to come
   from the account manager, and the sandbox buyer must complete an interactive "Log in with PayPal"
   consent **before** the simulator will accept an unsigned `PayPal-Auth-Assertion`. A sandbox probe
   cannot skip that step. Also: `PAYPAL_BUYER_EMAIL` and the PayPal-side transaction id are needed —
   `POST /v1/customer/disputes` takes `buyer_transaction_id`, which is the id from the **buyer's** view
   of the transaction, not the merchant's capture id.
2. **`changeReason` sends `multipart/form-data`; PayPal documents `multipart/related`** (report §30/#13).
   The part name, field names and JSON payload are identical; only the outer media type differs, and
   `fetch` + `FormData` cannot produce `multipart/related` without hand-writing the boundary, which this
   package refuses to do anywhere. The sandbox settles it.
3. **`accept_claim_type` as a *request* field** is described in prose and absent from the OpenAPI
   request body — the one place in disputes where the machine-readable spec is visibly incomplete
   (report §3/#29). We keep sending it; only a probe can confirm.
4. **Which of `dispute_id` / `id` the chargeback simulator returns.** The endpoint has no OpenAPI at
   all, only "Test go live" (report §27). The response schema accepts both.
5. **Whether a bare `input` field is accepted** (PayPal's cURL posts a bare field; we send a named file
   part with `application/json`). A superset, and `FormData` builds the boundary, so the open question is
   only whether PayPal's parser minds the `filename` (report §23).

**Blocked on a sandbox measurement**

6. **The maximum `PayPal-Request-Id` length.** PayPal's two sources contradict each other — the OpenAPI
   declares `maxLength: 10000`, the prose recommends a UUID "because it meets the **38 single-byte
   character limit**". Our worst case is **55**, and four of our five formats already exceed 38;
   `captureRequestId` (`cs:{authId}:cap:{shipmentId}`) is the one whose long slots are PayPal's own ids
   and so cannot be shortened. `REQUEST_ID_MAX_CHARS = 255` is *our* budget, not PayPal's figure. Full
   statement in [`IDEMPOTENCY.md`](IDEMPOTENCY.md) → "Header length".
7. **Which endpoints actually deduplicate.** Documented support is now known per endpoint (see
   `IDEMPOTENCY.md`); whether a replay *behaves* that way is still `UNVERIFIED` everywhere.
8. **Whether `10 MB` means 10⁶ or 2²⁰.** We enforce the decimal reading for both limits — the
   conservative choice, since the old 50 MiB cap was *looser* than PayPal's "up to 50 MB per API call"
   and would have let a 51 MB upload fail remotely. PayPal does not say (report §30).
9. **The unsigned `PayPal-Auth-Assertion`.** Its construction is now verbatim from PayPal's set-up page
   (`{"alg":"none","typ":"JWT"}.{iss,email}.`, empty signature) but has never been executed.

**Carried forward from the spec**

10. `POST /v3/vault/setup-tokens`: `usage_type` (`MERCHANT`), `usage_pattern` (`IMMEDIATE` for the
    one-shot D17 charge) and `customer_type` are now typed and asserted against `SPEC-V`; U6's "copy them
    from the doc at build time" is satisfied, and they live under `payment_source.paypal`.
11. Whether a 429's `Retry-After` is delta-seconds or an HTTP-date in practice. Both are parsed.
12. **PayPal's MCP tool names** cannot be checked without credentials (report §33). Best available
    evidence is the `@paypal/agent-toolkit` README tool list, which is a *different artefact* and not
    the MCP contract. Note the gap: even taking that list at face value it offers `list_disputes`,
    `get_dispute` and `accept_dispute_claim` only — **no evidence-offering tool at all**, so check
    C3(b) cannot currently prove that filing evidence is reachable over MCP.

## Consequences outside this package

The audit's findings are not all contained here:

- **There is no `PAYMENT.AUTHORIZATION.EXPIRED` webhook.** Spec **EC-TIME-5**'s 29-day authorization
  expiry cannot be webhook-driven; it has to poll `GET /v2/payments/authorizations/{id}` and compare
  `expiration_time`. That is a design change for whoever owns the clock.
- **`PAYMENT.REFUND.COMPLETED` was not a real event.** Anything that subscribed to it has never fired;
  refund completion is `PAYMENT.CAPTURE.REFUNDED`. `PAYMENT.CAPTURE.DENIED` is now included.
- **A dispute's capture join moved** to `disputed_transactions[].seller_transaction_id`. The Defender
  (M15/M16) and the ingest path must read it there; `disputeCaptureId()` does it in one line.
- **Appeal eligibility is the `appeal` HATEOAS link**, not `dispute_state === 'APPEALABLE'`
  (`isAppealable()`).
- **`ProcessChargeback`, `SimDisputeReq`, `ProvideEvidenceInput`, `MakeOfferReq`, `AckReturnReq`,
  `DisputeList` and `PaymentToken` all changed shape.** Anything constructing them needs updating.

## Differences from the spec's §8.6 class listing

- **`PayPalClientOpts` gains an optional `env` override** (`{ PAYPAL_ENV?, PAYPAL_API_BASE? }`) plus
  `sleep`, `logger`, `breaker` and `backoff`. Every one has the spec's default; they exist so tests can
  pin the clock, the sleep and the environment instead of reaching for `process.env`. The spec's six
  options keep their names and meanings.
- **`maxRetries` is read as a total attempt count** (default 4 = one initial call plus three retries),
  because the spec's retry bullet says "max 4" and AT-M6.2 needs three attempts to succeed.
- **`sandbox` gains `acceptOffer` / `denyOffer`**, which §10.2 #18 and §8.16 AT list but the §8.6 class
  listing omits.
- **`sandbox.processChargeback` takes an options object, not `(sellerTxnId, reason)`.** The spec's
  two-argument form cannot express the documented body, which needs `merchant_id`, the transaction
  amount and `instrument.instrument_type` — facts about *our* PayPal account and *our* capture that the
  client cannot know. Sending `{transaction_id, reason}` (what the two-argument form implied) would have
  failed at PayPal, so the signature follows the API rather than the listing.
- **`sandbox.changeReason` takes `(id, body)` rather than `(id, reason)`.** Same reason: the documented
  body also carries `note` and `item_info[]`.
- **`appeal` re-reads the dispute before posting.** Gating on the `appeal` HATEOAS link requires observing
  the link, which costs one extra `GET`. The signature is unchanged, and local validation still happens
  first, so a malformed packet costs no request at all.
- **`Dispute.offers` is left as an array** even though PayPal's field is `offer` (singular object). M15/M16
  and `IDEMPOTENCY.md` read `offers`; renaming a field other work packages depend on is not this
  package's call, and the mismatch is recorded in `types.ts` so the next reader is not misled.
- **The seven bodies with `o: CallOpts` keep it**, including `provideEvidence`, so a caller *can* omit
  `requestId`. §8.15 requires one for the filing call, and WP-15 is expected to pass
  `disputeActionRequestId(id, 'file', packetVersion)`. A dispute action with no id is still sent; the
  client does not require it, because the spec's signature does not.
- **`WEBHOOK_EVENT_NAMES` is a documentation list, not an enum.** It is asserted in tests and used for
  the reconciler's coverage check, never to reject an event (EC-WH-6).