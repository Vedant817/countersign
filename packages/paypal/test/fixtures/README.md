# `test/fixtures` — what is real, what is invented, and what replaces it

Spec §8.0 engineering rule 5:

> **Never fake PayPal behaviour.** No mocking of PayPal outside `packages/paypal/test/fixtures`.
> Fixtures must be captured from real sandbox responses (`scripts/capture-fixture.ts`) and committed
> with the capture date.

This directory is the only place in the repository where a PayPal-shaped thing is invented. This file
exists so nobody has to guess which half of it is real.

---

## Current state: **zero real captures**

`docs/HUMAN_TODO.md` **H-01** is open — there are no PayPal credentials yet, so nothing here has been
captured from a sandbox, and **there is deliberately no `fixtures/<date>/` directory**. Creating one
with hand-written JSON would be the exact dishonesty rule 5 forbids: a future reader could not tell a
capture from a guess, and a test built on a guess would look identical to a test built on the API.

| Path                     | Status                   | What it is                                                                                   |
| ------------------------ | ------------------------ | -------------------------------------------------------------------------------------------- |
| `fixtures/<date>/*.json` | **absent**               | Reserved for real captures. Created only by `scripts/capture-fixture.ts`.                    |
| `transport-double.ts`    | **doc-derived stand-in** | A `fetch` substitute plus hand-written PayPal _response shapes_.                             |
| `sandbox-env.ts`         | **real**                 | Reads real credentials from the environment and builds a real client for the sandbox suites. |

## `transport-double.ts` — a transport double, not a PayPal mock

The distinction matters, so it is worth being precise:

- **It replaces `fetch`.** Nothing else. The code under test runs its real header assembly, real URL
  building, real multipart encoding, real retry loop, real backoff, real circuit breaker, real zod
  validation and real error mapping. If the client forgets a header, writes a hand-drawn multipart
  boundary, retries with a different request id or fails to honour `Retry-After`, these tests fail.
- **It does not mock PayPal's behaviour.** Nothing here asserts that a given `PayPal-Request-Id`
  deduplicates, that a header is honoured, or that a dispute simulator works. Those are exactly the
  claims that need a real sandbox, and they are listed as `UNVERIFIED` in
  [`../../IDEMPOTENCY.md`](../../IDEMPOTENCY.md).
- **Every response shape is written from the published PayPal documentation**, and each carries its
  source URL in a doc comment. The `DOC` map at the top of the file is the index:

  | Constant              | Document                                                                         |
  | --------------------- | -------------------------------------------------------------------------------- |
  | `DOC.auth`            | https://developer.paypal.com/api/rest/authentication/                            |
  | `DOC.orders`          | https://developer.paypal.com/docs/api/orders/v2/                                 |
  | `DOC.payments`        | https://developer.paypal.com/docs/api/payments/v2/                               |
  | `DOC.vault`           | https://developer.paypal.com/docs/api/vault/v3/                                  |
  | `DOC.disputes`        | https://developer.paypal.com/docs/api/customer-disputes/v1/                      |
  | `DOC.provideEvidence` | https://developer.paypal.com/api/customer-disputes/v1/disputes-provide-evidence  |
  | `DOC.disputesGuide`   | https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api |
  | `DOC.evidenceFiles`   | https://developer.paypal.com/disputes/supported-file-sizes-types                 |
  | `DOC.disputesSetup`   | https://developer.paypal.com/disputes/set-up                                     |
  | `DOC.webhooks`        | https://developer.paypal.com/api/rest/webhooks/event-names/                      |
  | `DOC.idempotency`     | https://developer.paypal.com/api/rest/reference/idempotency/                     |
  | `DOC.rateLimiting`    | https://developer.paypal.com/api/rest/reference/rate-limiting/                   |
  | `DOC.sandboxDisputes` | https://developer.paypal.com/disputes/test-go-live                               |

- **The shapes here were audited on 2026-10-04** against the OpenAPI and `developer.paypal.com`
  ([`../../../docs/verification/paypal-api-2026-10-04.md`](../../../docs/verification/paypal-api-2026-10-04.md)).
  That audit found this file was **wrong** about `reason` vs `dispute_reason`, `evidences` vs
  `evidence`, the top-level `payer` on a payment token, and `total_pages`/`total_items` on the dispute
  list — so "written from the docs" was previously a claim without a check behind it. It is now a
  checked claim, and `docs/verification/…md` is the receipt.

- **It also carries the time and logging doubles** (`fixedClock`-based `testClock`, `recordingSleep`,
  `capturingLogger`). Those are not PayPal fakes at all: `Date.now()` is banned in this codebase
  (spec §8.1) and a retry that really slept would be both slow and incapable of asserting a _duration_.

## The three things the double deliberately does not do

1. **It never returns a 2xx with a shape we have not modelled**, unless a test asks for one. The
   client's schemas are `loose`, so a field PayPal adds later cannot break them — and if it ever does,
   the error is `CS_INTERNAL` with the issue list, not a silent `undefined`.
2. **It never invents a PayPal _limit_.** No maximum header length, no rate-limit threshold, no
   maximum file size. Where a real limit is needed it is written `UNVERIFIED` in code and in
   `IDEMPOTENCY.md`. The one exception is the evidence file sizes, which PayPal _does_ document
   ("less than 10 MB per file", "up to 50 MB per API call") and which are enforced as decimal —
   `MAX_EVIDENCE_FILE_BYTES` / `MAX_EVIDENCE_TOTAL_BYTES` in `src/multipart.ts` are that page's numbers,
   not this file's.
3. **It never asserts idempotency.** The 503 → 503 → 200 sequence in `client.retry.test.ts` proves the
   _client_ re-sends the same request id. It cannot prove PayPal deduplicates it. The probe that can is
   `client.sandbox.test.ts`, gated behind real credentials.

## What replaces this file

Once **H-01** lands:

```bash
# One-time: create packages/paypal/.env with the sandbox REST app's credentials
#   PAYPAL_CLIENT_ID=...
#   PAYPAL_CLIENT_SECRET=...
#   PAYPAL_ENV=sandbox
#   PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
#   PAYPAL_BUYER_EMAIL=buyer-...@sandbox.paypal.com

# Record real responses, redacted, into fixtures/<today>/
pnpm --filter @countersign/paypal exec tsx ../../scripts/capture-fixture.ts createOrder
# …one invocation per endpoint to capture

# Run the probes that only a real sandbox can answer
pnpm --filter @countersign/paypal test:sandbox
```

Then:

1. `capture-fixture.ts` writes real bodies to `fixtures/<YYYY-MM-DD>/<endpoint>.json`.
2. The response-shape functions in `transport-double.ts` are replaced by imports of those files, and
   the doc comments above them are replaced by a `Captured 2026-10-XX from sandbox` line.
3. **This file is deleted, not kept "just in case"** — a directory containing both real captures and
   invented shapes is how a fake becomes permanent.
4. `IDEMPOTENCY.md` gets its `UNVERIFIED (needs sandbox probe)` cells replaced with measured answers,
   including whether replaying a request id returns the earlier result and what the real maximum header
   length is.

Until step 4 happens, every claim in `IDEMPOTENCY.md` marked `UNVERIFIED` is **still unverified**,
regardless of what the unit tests say.
