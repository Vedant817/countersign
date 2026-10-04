# PayPal idempotency, per endpoint

Spec §8.6: _"Some endpoints do **not** support idempotency [B14]. For those, after any ambiguous
failure (timeout, 5xx), the client MUST **re-read** the state (GET) before retrying, never blind-retry.
The per-endpoint table is in `packages/paypal/IDEMPOTENCY.md`, and WP-06 fills it from sandbox probes."_

Spec §22.3 **U5**: _"Which PayPal endpoints honour `PayPal-Request-Id`, and the header length limit"_ —
owner WP-06, due Thu 8 Oct. `docs/HUMAN_TODO.md` **H-01** (PayPal credentials) is open, so the probe
has not run.

---

> ## ⚠️ READ THIS BEFORE TRUSTING ANY "yes" IN THE TABLE BELOW
>
> **Every cell is currently UNVERIFIED.** Nothing in this file has been measured against the PayPal
> sandbox. There are three states and only the first two are claims:
>
> | State                              | Meaning                                                                          |
> | ---------------------------------- | -------------------------------------------------------------------------------- |
> | `DOC-CITED`                        | PayPal's documentation states it. A citation, **not** a measurement.             |
> | `UNVERIFIED (needs sandbox probe)` | We do not know. The sandbox probe will answer it.                                |
> | `MEASURED (date)`                  | We ran the probe and wrote down what happened. **No cell is in this state yet.** |
>
> The one thing that **is** measured is the _maximum length our ids can reach_, because that is a
> property of our own formats rather than of PayPal: see "Header length" at the bottom.
>
> This file is the input to spec **EC-IDEM-3**. A wrong "yes" here is a **double-charge bug**: the
> client would blind-retry a side-effecting call that PayPal had already executed, and the second order,
> capture, refund or evidence filing would go through.

---

## The four request-id formats

Fixed by spec §8.6 and implemented in [`src/idempotency.ts`](src/idempotency.ts). Each is a pure
function of our own ids, so a retry of a job that timed out re-sends a byte-identical id.

| Format                                    | Used by                | Why these slots                                                                                            |
| ----------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `cs:{attemptId}:create`                   | `createOrder`          | One order create per checkout attempt (EC-IDEM-1, EC-IDEM-2).                                              |
| `cs:{authId}:cap:{shipmentId}`            | `captureAuthorization` | One capture per shipment against one PayPal authorization (EC-SPLIT-1).                                    |
| `cs:{captureId}:ref:{refundId}`           | `refundCapture`        | One refund per refund row (EC-IDEM-5).                                                                     |
| `cs:{disputeId}:{action}:{packetVersion}` | every dispute action   | Re-filing packet v2 must not dedupe against v1; re-sending v2 after a timeout must (spec §8.15, §8.16 AT). |

Dispute action tokens: `file`, `claim`, `offer`, `msg`, `return`, `support`, `appeal`, `escalate`.
`file` is the one the spec names explicitly (§8.15: _"Idempotency key `cs:{disputeId}:file:{version}`"_).

---

## The table

**Retry policy** is what the code in `src/client.ts` (`ENDPOINT_POLICIES`) actually does:

- `AUTO (same request id)` — PayPal's idempotency is documented, so a retry re-sends the identical
  request and PayPal returns the earlier result. The client retries on its own.
- `RE-READ FIRST` — idempotency is unverified, so the client **does not** auto-retry an ambiguous
  failure (timeout, network error, 5xx). It returns `PP_UNAVAILABLE` with `retryable: true` and
  `details.ambiguous: true`, and the caller must `GET` the resource before deciding (EC-IDEM-3).
  A **429 is still retried** on every row: the request was refused at the edge and never executed.

**Re-read before retrying** names the `GET` a caller should use when the row says `RE-READ FIRST`.

| Method | Path                                                      | Sends `PayPal-Request-Id`? | Idempotency support                                                                                       | Safe to blind-retry?                                                 | Retry policy in code     | Re-read before retrying                                                                                                           |
| ------ | --------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/oauth2/token`                                        | no                         | n/a — no side effect                                                                                      | **yes**                                                              | `AUTO (same request id)` | n/a                                                                                                                               |
| POST   | `/v2/checkout/orders`                                     | yes                        | `DOC-CITED` [B14]                                                                                         | **yes, if the id is honoured**                                       | `AUTO (same request id)` | n/a                                                                                                                               |
| GET    | `/v2/checkout/orders/{id}`                                | no                         | n/a — safe method                                                                                         | **yes**                                                              | `AUTO (same request id)` | n/a                                                                                                                               |
| POST   | `/v2/checkout/orders/{id}/authorize`                      | yes                        | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `AUTO (same request id)` | `GET /v2/checkout/orders/{id}`                                                                                                    |
| POST   | `/v2/checkout/orders/{id}/capture`                        | yes                        | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `AUTO (same request id)` | `GET /v2/checkout/orders/{id}`                                                                                                    |
| POST   | `/v2/checkout/orders/{id}/track`                          | no                         | `SPEC-O`: no `paypal_request_id` parameter; idempotency is the `capture_id` + `tracking_number` body pair | **yes, via the body pair**                                           | `AUTO (same request id)` | `GET /v2/checkout/orders/{id}`                                                                                                    |
| POST   | `/v2/payments/authorizations/{id}/capture`                | yes                        | `DOC-CITED` [B12], [B14]                                                                                  | **yes, if the id is honoured**                                       | `AUTO (same request id)` | n/a                                                                                                                               |
| POST   | `/v2/payments/authorizations/{id}/reauthorize`            | yes                        | `DOC-CITED` [B14]                                                                                         | **yes, if the id is honoured**                                       | `AUTO (same request id)` | n/a                                                                                                                               |
| POST   | `/v2/payments/authorizations/{id}/void`                   | yes                        | `DOC-CITED` [B14]                                                                                         | **yes, if the id is honoured**                                       | `AUTO (same request id)` | n/a                                                                                                                               |
| GET    | `/v2/payments/authorizations/{id}`                        | no                         | n/a — safe method                                                                                         | **yes**                                                              | `AUTO (same request id)` | n/a                                                                                                                               |
| GET    | `/v2/payments/captures/{id}`                              | no                         | n/a — safe method                                                                                         | **yes**                                                              | `AUTO (same request id)` | n/a                                                                                                                               |
| POST   | `/v2/payments/captures/{id}/refund`                       | yes                        | `DOC-CITED` [B12], [B14]                                                                                  | **yes, if the id is honoured**                                       | `AUTO (same request id)` | n/a                                                                                                                               |
| GET    | `/v2/payments/refunds/{id}`                               | no                         | n/a — safe method                                                                                         | **yes**                                                              | `AUTO (same request id)` | n/a                                                                                                                               |
| POST   | `/v3/vault/setup-tokens`                                  | no                         | `DOC-CITED` — `SPEC-V` declares the header, "server stores keys for 3 hours"                              | **unknown beyond 3 h**                                               | `RE-READ FIRST`          | `GET /v3/vault/setup-tokens/{id}` — see caveat below                                                                              |
| POST   | `/v3/vault/payment-tokens`                                | no                         | `DOC-CITED` — `SPEC-V` declares the header, "server stores keys for 3 hours"                              | **unknown beyond 3 h**                                               | `RE-READ FIRST`          | `GET /v3/vault/payment-tokens/{id}` — **only reachable with the setup-token id**                                                  |
| GET    | `/v3/vault/payment-tokens/{id}`                           | no                         | n/a — safe method                                                                                         | **yes**                                                              | `AUTO (same request id)` | n/a                                                                                                                               |
| DELETE | `/v3/vault/payment-tokens/{id}`                           | no                         | n/a — idempotent by HTTP semantics (a repeat is a 404)                                                    | **yes**                                                              | `AUTO (same request id)` | n/a                                                                                                                               |
| GET    | `/v1/customer/disputes`                                   | no                         | n/a — safe method                                                                                         | **yes**                                                              | `AUTO (same request id)` | n/a                                                                                                                               |
| GET    | `/v1/customer/disputes/{id}`                              | no                         | n/a — safe method                                                                                         | **yes**                                                              | `AUTO (same request id)` | n/a                                                                                                                               |
| POST   | `/v1/customer/disputes/{id}/provide-evidence`             | yes                        | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown — and a double filing is the worst outcome in the system** | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` then read `evidence.notes`                                                                       |
| POST   | `/v1/customer/disputes/{id}/accept-claim`                 | yes                        | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown — a double concede loses the dispute**                     | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` then read `status`                                                                               |
| POST   | `/v1/customer/disputes/{id}/make-offer`                   | yes                        | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown — two offers is a commercial problem**                     | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` then read `offers`                                                                               |
| POST   | `/v1/customer/disputes/{id}/send-message`                 | yes                        | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown — the buyer sees the duplicate**                           | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` then read `messages`                                                                             |
| POST   | `/v1/customer/disputes/{id}/appeal`                       | yes                        | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` then read `dispute_state`                                                                        |
| POST   | `/v1/customer/disputes/{id}/acknowledge-return-item`      | yes                        | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` then read `status`                                                                               |
| POST   | `/v1/customer/disputes/{id}/provide-supporting-info`      | yes                        | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` then read `evidence.notes`                                                                       |
| POST   | `/v1/customer/disputes/{id}/escalate`                     | yes                        | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` then read `dispute_life_cycle_stage`                                                             |
| POST   | `/v1/notifications/verify-webhook-signature`              | no                         | n/a — no side effect (it only verifies)                                                                   | **yes**                                                              | `AUTO (same request id)` | n/a                                                                                                                               |
| POST   | `/v1/customer/disputes` _(sandbox buyer simulator)_       | no                         | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes?start_time=…` (§10.3 step 3)                                                                           |
| POST   | `/v2/customer-support/process-chargeback` _(sandbox)_     | no                         | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes?start_time=…`                                                                                          |
| POST   | `/v1/customer/disputes/{id}/require-evidence` _(sandbox)_ | no                         | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}`                                                                                                  |
| POST   | `/v1/customer/disputes/{id}/adjudicate` _(sandbox)_       | no                         | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` then read `adjudication_outcome`                                                                 |
| POST   | `/v1/customer/disputes/{id}/change-reason` _(sandbox)_    | no                         | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` then read `dispute_reason`                                                                       |
| POST   | `/v1/customer/disputes/{id}/accept-offer` _(sandbox)_     | no                         | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}` — and note the documented **`202 Accepted`**: the buyer may have accepted while we saw a timeout |
| POST   | `/v1/customer/disputes/{id}/deny-offer` _(sandbox)_       | no                         | `UNVERIFIED (needs sandbox probe)`                                                                        | **unknown**                                                          | `RE-READ FIRST`          | `GET /v1/customer/disputes/{id}`                                                                                                  |

### Two caveats about the `RE-READ FIRST` rows

1. **`POST /v3/vault/setup-tokens` has no usable re-read.** The response only exists if PayPal created
   the token, and we have no id to query before the call returns. So for this endpoint a caller that
   gets an ambiguous failure must re-run the **whole onboarding step** (§8.7), which is safe only
   because it is buyer-present. Recorded here rather than hidden: it is a genuine gap, not an oversight.
2. **`POST /v3/vault/payment-tokens` is reachable for re-read.** The setup-token id is the request's own
   input, so a replay can be checked with `getPaymentToken` after the first token exists. Spec §8.7
   AT-M7.3 (_"A re-run with the same setup token is idempotent — returns the same wallet"_) is a claim
   about **our** layer, not about PayPal's.

### And why vault is still `RE-READ FIRST` even though the header is documented (2026-10-04 audit)

`SPEC-V` declares `PayPal-Request-Id` on both vault operations — so "unverified" was wrong, and the
provenance comment in `ENDPOINT_POLICIES` no longer says so. The remaining objection is narrower and
still real: PayPal documents that **"the server stores keys for 3 hours"**, which does not cover a
retry that arrives after a long outage. `RE-READ FIRST` is therefore a deliberate conservatism about
the _retention window_, not a claim that the header is unsupported. Disputes v1 stay `RE-READ FIRST` for
the opposite reason: `SPEC-D` declares no `paypal_request_id` parameter anywhere.

Note also what the re-read should look at after the audit's field-name corrections:
`provide-evidence` and `provide-supporting-info` re-read **`evidences[].notes`** (not `evidence.notes`),
`make-offer` re-reads `offers` (PayPal's field is `offer`, singular — see the note in `types.ts`),
`appeal` re-reads **the `appeal` HATEOAS link**, `change-reason` re-reads **`reason`**, and
`accept-offer` must assume the buyer may have accepted even if we saw a timeout.

---

## Header length

**Which limit PayPal enforces is UNKNOWN, and PayPal's own two sources contradict each other.**

| Source                                                                        | What it states                                                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPEC-P` / `SPEC-V` → `components.parameters.paypal_request_id`               | `minLength: 1`, **`maxLength: 10000`**, `pattern: ^.*$`, `required: false`                                                                                 |
| <https://developer.paypal.com/api/rest/reference/idempotency> → "Usage notes" | _"PayPal recommends that you use the **UUID standard** for the `PayPal-Request-Id` header value because it meets the **38 single-byte character limit**."_ |

These cannot both be the enforced limit, and **nothing PayPal publishes says which is real.** 38 is the
only number stated as a _limit_; 10 000 is a schema maximum, and a schema maximum is not a promise.
Both are kept as named constants in `src/idempotency.ts` (`PAYPAL_DOCUMENTED_REQUEST_ID_MAX_CHARS`,
`PAYPAL_OPENAPI_REQUEST_ID_MAX_CHARS`) so the C-probe has something to measure against.

**Our worst case is 55 characters**, computed from the formats themselves by
`observedRequestIdLengths()` in `src/idempotency.ts`:

| Format                                                          | Worst realistic length | Over the 38-char prose figure? |
| --------------------------------------------------------------- | ---------------------- | ------------------------------ |
| `cs:{attemptId}:create`                                         | 40                     | yes                            |
| `cs:{authId}:cap:{shipmentId}`                                  | 55                     | yes                            |
| `cs:{captureId}:ref:{refundId}`                                 | 55                     | yes                            |
| `cs:{disputeId}:{action}:{packetVersion}`                       | 52                     | yes                            |
| `cs:{paypalDisputeId}:file:1` (a PayPal dispute id in the slot) | 27                     | no                             |

(`attemptId` and friends are `att_` + a 26-char ULID; the PayPal auth/capture slot is 17 chars; the
longest action token is `escalate` at 8; the largest packet version we emit is 9 digits.)

**`captureRequestId` is the format to look at first.** `cs:{authId}:cap:{shipmentId}` is tied for
longest at 55, and unlike the others its long slots are _PayPal's_ ids — the 17-character
authorization id and the capture id — which is why they cannot be shortened the way our own ULID slots
could. If the C-probe reports 38 as real, this format has to change shape (for example a hash of the
authorization id in place of the id itself), and that is a spec-level decision because §8.6 fixes the
four formats.

These five numbers are asserted by `test/idempotency.test.ts` ("measures the real formats rather than
assuming a maximum" and "flags `captureRequestId` as the format that breaks first"), so they cannot
silently drift away from the code.

Until the probe reports a limit, `REQUEST_ID_MAX_CHARS = 255` in `src/idempotency.ts` is **our own
budget, not a statement about PayPal's API**. It exists so a malformed id cannot become an HTTP header
failure. It does **not** currently protect us against the 38-character reading — four of the five
formats above are already longer than that. `validateRequestId` returns `CS_VALIDATION` for anything
non-alphanumeric, longer than the budget, or containing a space, CR or LF.

---

## What the probe has to do (C-probe)

For each row above, in sandbox:

1. Send the call **twice with the same `PayPal-Request-Id`** and record:
   - does the second call return the **same resource id**, a **409**, or create a **second resource**?
   - the HTTP status and the `PayPal-Debug-Id` of each response (that is what makes the report checkable
     by a human later).
2. Send the call **twice with different request ids** and confirm two resources are created — otherwise
   the key is being ignored and deduplication is coming from somewhere else.
3. For rows marked `DOC-CITED [B14]`, the answer must be read off the docs page _and_ confirmed by (1),
   because "documented" and "deduplicates in practice" are different claims.
4. Record the date, the sandbox app name and the debug ids in the cell, and move it to
   `MEASURED (YYYY-MM-DD)`.
5. **New, from the 2026-10-04 audit — settle the length conflict.** Send a header value of **38
   characters** and one of **39** to an endpoint that declares the header (e.g.
   `POST /v2/payments/authorizations/{id}/capture`), and one of **10 001**, and record which are
   accepted. This single experiment replaces both constants above with a measurement.

`test/client.sandbox.test.ts` already performs steps 1–2 for
`POST /v2/checkout/orders` (the _"re-sending the same create request id"_ test) and fails with a message
that says exactly which cell in this table to update. It runs only with
`pnpm --filter @countersign/paypal test:sandbox` and real credentials.

---

## Where this is enforced in code

| Concern                                       | Location                                                           |
| --------------------------------------------- | ------------------------------------------------------------------ |
| The four formats                              | [`src/idempotency.ts`](src/idempotency.ts)                         |
| Per-endpoint retry/send policy                | `ENDPOINT_POLICIES` in [`src/client.ts`](src/client.ts)            |
| One id for the whole retry loop               | `PayPalClient.execute` → `attemptBudgetLoop`                       |
| Re-read instead of blind retry                | the `ambiguous` branch in `attemptBudgetLoop`                      |
| A side-effecting call with no id              | `PayPalClient.requireRequestId` → `CS_VALIDATION`, before any HTTP |
| A malformed id                                | `validateRequestId` → `CS_VALIDATION`, before any HTTP             |
| AT-M6.2 (same id on both retries)             | `test/client.retry.test.ts`                                        |
| EC-IDEM-3 (no blind retry on `RE-READ FIRST`) | `test/client.retry.test.ts`                                        |
