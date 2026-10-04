# `@countersign/webhooks` - ingest and reconciler

Spec **§8.12 (M12, WP-12)**, decisions **D12**, **D13**, data model **§7.2**, verification **§10.2**,
acceptance tests **AT-M12.1-6**, edge cases **EC-WH-1..7**, **EC-TIME-5**, **EC-PP-2**, **EC-PP-5**,
**EC-IDEM-4**, **EC-ENV-2**.

PayPal's webhook channel loses, duplicates and reorders messages. This package is the answer to that, and the
answer is one sentence:

> **We never trust payload state.** State comes from re-fetching PayPal, never from the body it sent us.
> — spec §8.12, §3.1

A payload is a _hint about what to re-fetch_ and nothing else. Every status written anywhere in this package
came out of a `GET`.

---

## Using it

Two callers, and they share nothing but the dependency list.

### 1. WP-17's Next route handler (three lines)

```ts
import { handleWebhook } from '@countersign/webhooks'

export async function POST(req: Request): Promise<Response> {
  const ack = await handleWebhook(new Uint8Array(await req.arrayBuffer()), req.headers)
  return Response.json(ack, { status: ack.status })
}
```

`handleWebhook` is framework-agnostic: it takes bytes and a header bag and returns a plain `WebhookAck`. This
package never learns what Next is. The 200-vs-400 decision, the audit entry, the store and the enqueue are
all already made by the time the route sees a value.

### 2. `apps/worker`'s job handlers

```ts
import { processWebhookEvent, reconcileResources } from '@countersign/webhooks'

// §8.12's `wh.process`. The payload is a pointer, not state — this re-reads the row and re-fetches.
const result = await processWebhookEvent(job.data, deps, hooks)

// §8.12's 5-minute and nightly sweeps.
const sweep = await reconcileResources(deps, { lookbackDays: 30 })
```

### 3. WP-15e (Defender / evidence filer)

```ts
import { ingestDispute } from '@countersign/webhooks'

// Writes the dispute and hands back the stage and deadline, so the evidence planner can act on it.
```

---

## The two audit facts that shaped this package

Both are from `docs/verification/paypal-api-2026-10-04.md`, and both change the design rather than just
annotating it.

### `PAYMENT.REFUND.COMPLETED` does not exist

Refund completion is `PAYMENT.CAPTURE.REFUNDED`. The only refund events are `PAYMENT.REFUND.PENDING` and
`PAYMENT.REFUND.FAILED` - and there is no refund completion event among them either. So a **refund row is
written from `getRefund`**, never from a refund webhook, which is also why a dropped refund event is harmless:
the reconciler re-fetches the capture, sees `PARTIALLY_REFUNDED` or `REFUNDED`, and the refund row follows.
`WEBHOOK_EVENT_NAMES` in `@countersign/paypal` has the corrected list with a comment recording this.

### There is no `PAYMENT.AUTHORIZATION.EXPIRED` event at all

**A subscription to it succeeds, the webhook is created, and it silently never fires.** Nothing errors, nothing
alerts, and the authorization sits uncaptured until somebody notices.

So EC-TIME-5 is implemented as a **poll and nothing else**:

- `authorizationExpirySweep` runs every 5 minutes.
- It computes the 29-day expiry and the 3-day honour window from `expiration_time` and `honor_expires_at`,
  which are stamped at authorization time.
- It **re-fetches before writing anything**, because "believe our own row" is the mistake §3.1 warns about
  even here. A row that says `CREATED` can be `VOIDED` at PayPal, and writing `EXPIRED` would tell the
  buyer's ledger the wrong reason the money moved.
- PayPal's own terminal status wins when PayPal has one; our 29-day clock decides only what PayPal is silent
  about.

This is the clearest illustration of why §3.1 puts a reconciler in the architecture at all: **the absence of a
webhook is indistinguishable from a bug in our webhook handling, and only a poll can tell the difference.**

---

## The rank rule, and the table

`status-rank.ts` is the correctness core: pure functions, no I/O, no clock.

```ts
export function compareRankedState(stored: RankedState, fetched: RankedState): RankComparison
```

`RankedState` is `{ rank: readonly number[]; updatedAt: Date }`, and `RankComparison` is one of six verdicts.
The comparator returns a **decision**, never a value, and the store is handed that decision with no room to
argue (`RankedWrite.status` is non-optional, so "we decided to do nothing" cannot be spelled by omission).

### The tables

Ranks are **tuples** `[branch, step]`, not scalars. §8.12's capture table is two orders, not one:

| Capture (`capture_status`) | Rank     | Branch           |
| -------------------------- | -------- | ---------------- |
| `PENDING`                  | `[0, 1]` | success          |
| `COMPLETED`                | `[0, 2]` | success          |
| `PARTIALLY_REFUNDED`       | `[0, 3]` | success          |
| `REFUNDED`                 | `[0, 4]` | success          |
| `DECLINED`                 | `[1, 1]` | terminal failure |
| `REVERSED`                 | `[1, 2]` | terminal failure |

A higher branch beats a lower one regardless of step, so `COMPLETED` never "regresses" into `DECLINED` - the
capture was accepted and then reversed, and that is a later fact about a different thing.

| Authorization                     | Refund            | Order (ours)                            | Disputes                             |
| --------------------------------- | ----------------- | --------------------------------------- | ------------------------------------ |
| `PENDING [0,1]` · `CREATED [0,2]` | `PENDING [0,1]`   | `ORDER_CREATED [0,1]`                   | stage: `INQUIRY 1`                   |
| `PARTIALLY_CAPTURED [0,3]`        | `COMPLETED [0,2]` | `PENDING_REVIEW [0,2]`                  | `CHARGEBACK 2`                       |
| `CAPTURED [0,4]`                  | `FAILED [1,1]`    | `AUTHORIZED [0,3]`                      | `PRE_ARBITRATION 3`                  |
| `DENIED [1,1]`                    |                   | `PARTIALLY_CAPTURED [0,4]`              | `ARBITRATION 4`                      |
| `VOIDED [1,2]`                    |                   | `CAPTURED [0,5]`                        | status within a stage:               |
| `EXPIRED [1,3]`                   |                   | `DECLINED [1,1]` … `AUTH_EXPIRED [1,5]` | `open < waiting < review < resolved` |

Three decisions in there are worth stating outright, because each one is a place where the obvious reading of
§8.12 is wrong:

1. **`REFUNDED` is terminal on the success branch**, even though §8.12 does not say so. A fully-refunded
   capture does not come back as `COMPLETED`, so treating it as non-terminal would have the reconciler re-fetch
   it forever and report every cycle as a fix.
2. **`EXPIRED` sits on the failure branch**, with `DENIED` and `VOIDED`. It is **our** answer, derived from
   `expiration_time`, and it means the resource stopped existing - which is what branch 1 means everywhere
   else.
3. **Rank is monotonic; detail is not.** A lower-ranked but _newer_ fetch refreshes detail without lowering
   the rank. PayPal genuinely does `UNDER_REVIEW → WAITING_FOR_SELLER_RESPONSE` on a dispute, and a single
   scalar would strand the newer `seller_response_due_date`. Without this split, EC-REF-4's deadline handling
   breaks on a case PayPal produces in normal operation.

Every table is typed `Record<TheSchemaEnum, …>`, so adding an enum value to `packages/db` is a **`tsc` error
here** rather than a silent `undefined` at runtime.

---

## File map

| File             | Contents                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `types.ts`       | `WebhookDeps` and its ports: seven PayPal reads, the store, the queue, the audit sink, the throttle. |
| `status-rank.ts` | The correctness core. Rank tables and one comparator.                                                |
| `signature.ts`   | Header extraction, the three verification outcomes, EC-WH-4's audit and alert, byte-exact storage.   |
| `dedupe.ts`      | EC-WH-2's `ON CONFLICT DO NOTHING` and the pure decision about what a redelivery does.               |
| `ingest.ts`      | `handleWebhook`: store → verify → enqueue → ack.                                                     |
| `jobs.ts`        | `wh.process`: the four gates, and one re-fetch per resource kind.                                    |
| `reconcile.ts`   | The sweeps, EC-PP-2's throttle, and EC-TIME-5's expiry sweep.                                        |

---

## Deviations

### Store → verify → enqueue, rather than §8.12's literal verify-then-insert order

§8.12 lists verify at step 2 and insert at step 3. This package **stores first**.

Both EC-PP-5 and EC-WH-7 force it:

- **EC-PP-5**: "respond 200 after storing; verify async." There is no row to respond about if verification
  came first and the store had not happened.
- **EC-WH-7**: "store the event unverified, don't act; retry verification with backoff." A row stored
  `PENDING` is the whole mechanism, and it presupposes the insert ran.

The observable behaviour is unchanged and still matches §8.12's contract: a forged signature is a 400 with an
audit entry and no processing; a verified event is a 200; either way the answer arrives well inside the 2-second
budget.

The one ordering that _is_ preserved: **verify before enqueue**. An unverified event is stored and not queued,
which is what makes "don't act" mean something.

### `capture_status` and `authorization_status` have their own enums, not PayPal's

`ORDER_RANK` is over `order_status`, which is our enum. This is unavoidable - `CHECKOUT.ORDER.APPROVED` arrives
against a PayPal order and is written onto our row.

### Two divergent rank tables already exist in the repository

`repos/disputes.ts::STAGE_RANK` and this package's `DISPUTE_STAGE_RANK` are the same four values and are meant
to agree; `repos/orders.ts::isCaptureStatusRegression` overlaps `CAPTURE_RANK` and is the SQL-level backstop.
Neither is wrong today. Two tables that are meant to agree, in two packages, is a drift risk rather than a
duplication - flagged here so a change to one is a deliberate check of the other, and so it is on the record
as something WP-01 may want to centralise.

---

## Contract issues

Places where a port member has **no repository function behind it**. Per AGENTS.md rule 8 these are recorded
here and stubbed behind the interface rather than worked around by reaching past a package boundary.

| Gap                                                         | Why it is needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captures.reconcileCandidates(updatedSince, limit)`         | §8.12's sweep says "captures not terminal and updated in the last 30 days", which needs a capture reached **through its order**. `repos/orders.ts` has `findOrdersForReconcile` and `findAuthorizationsExpiring` but nothing that joins a capture to its order.                                                                                                                                                                                                                                 |
| No `repos/webhooks.ts` function returning a `WebhookStore`  | The repository functions exist and are correct; nothing assembles them into the port. `apps/worker`'s `productionDeps` is where that adapter belongs, and it is the one thing between this package and a live database.                                                                                                                                                                                                                                                                         |
| No `WebhookAudit` implementation                            | `packages/db`'s `appendAudit` is hash-chained; nothing adapts it to the port. EC-WH-4's audit entry is therefore tested against a recorder, not a chain.                                                                                                                                                                                                                                                                                                                                        |
| `webhook_events` has no column for the transmission headers | EC-WH-7's retry re-runs `verify-webhook-signature`, which needs `PAYPAL-TRANSMISSION-ID/TIME/SIG`, `PAYPAL-CERT-URL` and `PAYPAL-AUTH-ALGO` - and the exact bytes, because the signature covers them. The exact bytes cannot be reconstructed from parsed JSON. `raw` therefore stores a `StoredDelivery` (`{event, delivery:{rawBodyBase64, headers}}`) rather than the event body alone. PayPal's own redelivery (25 attempts over 3 days) remains the fallback for rows written before this. |

---

## Testing without credentials or a database

Every test drives the **real** `PayPalClient` through an injected `fetchImpl`, so request building, the OAuth
single-flight, the retry loop, the backoff, the circuit breaker and the zod validation all run for real.
AGENTS.md rule 5 forbids faking PayPal's _behaviour_; replacing the socket is the same seam
`packages/paypal/test/fixtures/transport-double.ts` uses. Our own rows are backed by an in-memory
`WebhookStore` in `test/harness.test.ts`.

> ### Nothing here has run against PayPal yet
>
> `docs/HUMAN_TODO.md` **H-01** is open, so there are no credentials. The response bodies are written from
> PayPal's published docs, not captured. Fixtures captured from real sandbox responses land via
> `scripts/capture-fixture.ts` once H-01 is closed.

| File                  | Tests | What it covers                                                                         |
| --------------------- | ----- | -------------------------------------------------------------------------------------- |
| `harness.test.ts`     | 4     | The double's own fidelity, including that it can actually **drop** a webhook.          |
| `status-rank.test.ts` | 45    | All six verdicts, table-driven over every status.                                      |
| `ingest.test.ts`      | 64    | AT-M12.1-6 and EC-WH-1..7.                                                             |
| `reconcile.test.ts`   | 40    | The three sweeps, EC-PP-2's throttle, EC-TIME-5, and an end-to-end lost-webhook chain. |

### AT-M12.6, measured

200 events through `handleWebhook`, p95 acknowledgement time over 200 samples:

```
p50=0.40ms  p95=0.67ms  p99=0.98ms  max=1.76ms   throughput=2307/s
```

Target is 200/min (3.3/s) with p95 < 300 ms. The figure is **printed by the test on every run** rather than
pinned as a constant, because a number in a README that nothing recomputes is the first thing to go stale.

### How AT-M12.3 is a real test

AT-M12.3 is "a dropped webhook → the reconciler fixes the state within one cycle", and the risk is that it
passes vacuously. Three things make it real:

1. The harness's `deliver(body, { drop: true })` **never inserts a row and never enqueues a job** - the loss is
   at the network boundary, not simulated by skipping an assertion.
2. The in-memory store models the three things the fix depends on: the `paypal_event_id` unique key (EC-WH-2),
   the monotonic rank guard on the capture write, and `processed_at`/`attempts` as the honest record of how far
   processing got.
3. The test then asserts the state PayPal reports **arrives in our row** without any webhook having mentioned
   it, and that `fixedWithoutWebhook` is `true` - so a run that only confirmed an existing state fails.

### How EC-WH-7 is handled and asserted

The verify endpoint is made to return `503`, so `PayPalClient` produces `PP_UNAVAILABLE`. The assertions are:

- the event row exists, with `verified = 'PENDING'` and the stored bytes present;
- the acknowledgement is **200**, not 400 and not 500;
- **no job was enqueued** - "don't act" is asserted by the absence of a queue write;
- an audit entry records the unavailable verification;
- after the endpoint recovers, `retryPendingVerifications` moves the row to `VERIFIED` **and** enqueues
  `wh.process`, and the state converges.

A row stored `PENDING` is never marked processed and never retried by `wh.process`: gate 3 returns
`DEFERRED_UNVERIFIED`, which is a normal conclusion rather than an error, so the queue does not retry a job
that cannot succeed until the verify endpoint does.

### EC-PP-2, the throttle

`createThrottle` is a **spacing** limiter (one admission every `1000/rps` ms), not a token bucket that allows a
burst. A burst is the wrong shape for EC-PP-2: PayPal's limit is on the average rate, and a cron that fires
100 requests in the first 200 ms of a 5-minute window is more likely to be sitting behind a shared rate limiter
than one that paces itself.

The limit is a **port**, so the reconciler tests are instant. They do not get instantism by giving up the
assertion: `instantThrottle` still **counts** its admissions, so "every PayPal read in this sweep passed
through the limiter" is a statement about a number.

### EC-TIME-5's horizon is derived, not chosen

`EXPIRY_SWEEP_HORIZON_DAYS = 29 - 3 = 26`.

`honor_expires_at = created + 3d` and `expiration_time = created + 29d` are both stamped at authorization time,
so a row's honour window is open exactly when `expiration_time <= now + 26d`. A tighter horizon - five days is
the obvious choice - silently skips most of the honour window, and the rows it skips are exactly the ones where
reauthorization is still legal. The sweep would report nothing for twenty days and then expire them.

`AUTH-EXPIRY-1 the horizon is 29 − 3 days…` pins this, so the bug cannot come back as a taste call.
