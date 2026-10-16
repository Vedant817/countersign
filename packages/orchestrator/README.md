# `@countersign/orchestrator` — the seam

Spec **§10.2**, **§8.8**, **§8.10**, **§8.11**, **§8.12**, **§8.15**; core invariant **I-1** (§3.1); §12.2,
§12.4, §12.11.

## What this package is

**The order.** Every package beneath it was written and tested as if the one above it existed, and none of
them calls the next:

| Package                 | What it owns                                                             | Who called it before this package |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------- |
| `@countersign/compiler` | words → a zod-validated proposal, plus the deterministic read-back       | nobody                            |
| `@countersign/gate`     | the twelve checks, the reservation, the signed decision record           | nobody                            |
| `@countersign/orders`   | the PayPal order for an `ALLOW`; the refund, void and capture arithmetic | nobody                            |
| `@countersign/defender` | route a dispute, draft cited notes, file the packet                      | nobody                            |
| `@countersign/ledger`   | when a reservation expires                                               | nobody                            |

`git grep "createOrderFromDecision("` and `git grep "evaluate("` over `apps/**` returned nothing but
definitions before this package. This one is not new logic — it is the sequence, in one file, with each step's
`Result` propagated and the run stopping at the first failure.

## The exported surface

| Export                                   | Sequence                                                                                                                                | Stops when                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `createOrderFromIntent(input, deps)`     | `compile` → `readBack` → `evaluate` → `createGateDecision` + `linkGateDecision` → **only if `ALLOW`** `createOrderFromDecisionDetailed` | the first `err`, or a non-`ALLOW` decision (returned as `ok` with `stage: 'REFUSED'`) |
| `runGateEvaluation(input, deps)`         | `findLatestDecisionForAttempt` → **else** `evaluate` → `createGateDecision` + `linkGateDecision`                                        | as above; never creates an order, so it cannot move money                             |
| `ingestAndDefend(source, deps, options)` | `getDispute` → `ingestDisputeToDefender` → `fileDispute`                                                                                | the first `err`; a refused filing is `ok`                                             |
| `releaseExpiredReservations(deps, now)`  | `findStaleAttempts(now − 30 min)` → already-released filter → `expireStaleReservations` → `setAttemptState('AUTH_EXPIRED')`             | never on a per-reservation failure; failures are collected into `errors`              |
| `gateDecisionFromRow(row)`               | —                                                                                                                                       | `null` for a row it cannot read                                                       |
| `orchestratorStoreFromRepos()`           | —                                                                                                                                       | nothing; it _is_ the production `OrchestratorStore`                                   |
| `compilerFrom(deps)`                     | —                                                                                                                                       | binds the real `compile` / `readBack` / `hasBlockingAmbiguities`                      |

## I-1, and where it is proved

§3.1 I-1: _no PayPal money movement happens unless a Gate `ALLOW` decision record exists for exactly that
order, amount, currency and payee._ Two independent guards:

1. `deps.orders.paypal.createOrder` is reachable from **one line** of `src/purchase.ts`, inside
   `if (decision.decision !== 'ALLOW') return …`.
2. `@countersign/orders`' `createOrderFromDecision` refuses a non-`ALLOW` with `GATE_BLOCKED` before touching
   anything.

The second guard matters because this package is not the only possible caller: a future caller that reaches
`createOrderFromDecision` directly still cannot move money without an `ALLOW`.

**The assertion** (`test/purchase.test.ts`, "I-1 the one ALLOW call carries exactly the decision's order,
amount, currency and payee") does not decode a JWT and compare strings. It verifies the decision record's
**real Ed25519 signature** against the harness's JWKS, then compares the verified payload field by field with
the single recorded `POST /v2/checkout/orders` body:

```ts
expect(unit.amount.value).toBe(signed.amount) // '30.00'
expect(unit.amount.currency_code).toBe(signed.currency) // 'USD'
expect(unit.payee.merchant_id).toBe(signed.payee) // the L3a-signed merchant
expect(unit.invoice_id).toBe(result.orderId) // our ord_…
```

And the `BLOCK` half is asserted as **zero recorded calls of any kind**, not "no create-order call" — a
status page that reports "OpenAI: OK" because a key is set is worse than no status page, and an assertion
that only counted one endpoint would be the same kind of soft claim.

## What survives a retry

| Property                                            | Mechanism                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A duplicate submission performs **one** PayPal call | `decisionForAttempt` recovers the recorded decision, so `evaluate` — whose check 7 is a replay **detector**, not an idempotent replay — is not re-run. `createOrderFromDecision` then finds the order and returns it (`orders_attempt_id_key`). |
| A crash between the decision and the order resumes  | the decision row is written **first**, so the retry re-enters `createOrderFromDecision` with the same `cs:{attemptId}:create` request id and PayPal collapses it onto the order it already made.                                                |
| A sweep run twice releases once                     | two layers: the derived `releaseEntryId` primary key (backstop) and a pre-write filter that reports an already-released reservation instead of hitting it.                                                                                      |
| A retried dispute ingest does not double-file       | `ingestDisputeToDefender` upserts under a derived `dsp_…` id; `fileDispute` records `dispute_actions` under a derived idempotency key.                                                                                                          |

## The one thing this package adds to the Gate

**`gate_decisions` had a definition and no caller.** `git grep createGateDecision` before this package found
the function in `@countersign/db` and nothing that called it, while `createOrderFromDecision` re-reads
`gate_decisions` **by id** and refuses with `CS_NOT_FOUND` when the row is absent. So without a writer, every
`ALLOW` in the system would have been followed by a failure and no order would ever exist.
`OrchestratorStore.decide` is that writer, and it is the only member of the port that does not exist in
some other package's `deps.ts`.

## Contract issues — reported, not worked around

1. **`DefenderRefunds` cannot be satisfied.** `fileDispute`'s own documentation says to wire
   `DefenderRefunds.refund` to `orders.refund(...)`. `orders.refund()` refuses while a dispute is open on the
   capture — that is EC-REF-4's detection working — so the `REFUND` posture is refused by construction and
   §8.15's "if the agent was at fault, say refund" is dead as documented.
   **Not worked around.** A workaround would have to either refund outside the over-refund guard or refund
   twice; QA-orders-2 is exactly the second outcome. The fix belongs in `@countersign/orders`: the refusal
   needs an explicit, audited "merchant conceded a disputed capture" mode rather than the absence of one.

2. **`createInMemoryDefenderWorld` is not exported** from `@countersign/defender`'s index, so this package
   cannot drive the real Defender without restating a twenty-member port. That is why `test/dispute.test.ts`
   uses recording doubles for the two Defender calls and asserts only the orchestrator's ordering. One export
   line fixes it.

3. **`FileDeps` / `FileOptions` / `FileOutcome` are not exported** either. Recovered in `types.ts` with
   `Parameters<typeof fileDispute>` / `Extract<Awaited<ReturnType<…>>, { ok: true }>['value']`, which cannot
   drift. Re-exporting them would be tidier.

4. **`gate_decisions` has no `pending_network_enforcement` column.** D-019's obligation is derived at Gate
   time from what vi reported skipping, so it cannot be read back. `gateDecisionFromRow` reconstructs it as
   `[]`, which is safe **for its only caller** because `createOrderFromDecision` never reads the field. Any
   future caller that needs it must re-verify the chain rather than trust the reconstruction.

5. **The 30-minute boundary is decided by the candidate query, not by the ledger.**
   `reservationHasExpired` says the window is over at `created + 1800` (`>=`), while `findStaleAttempts`
   filters `created_at < olderThan` and the sweep hands it `now − 1800s`. So a reservation is released
   somewhere in `(created + 1800s, created + 1800s + cron]` — between 30 and 35 minutes, because
   `release.reservations` runs every five minutes. §8.10 holds; the granularity is the cron's. Stated in the
   test that pins both sides.

6. **`drizzle-orm@0.45.3` cannot bind a JS `Date`, so `releaseExpiredReservations` cannot run against a real
   database.** Found by running the sweep against a live Postgres rather than a double. `findStaleAttempts`
   binds `olderThan: Date`, and drizzle's postgres-js session hands the value to postgres.js's binary `Bind`
   untouched, where `Buffer.byteLength(Date)` throws `ERR_INVALID_ARG_TYPE`. Isolated to three probes:

   | probe                                                            | result                          |
   | ---------------------------------------------------------------- | ------------------------------- |
   | raw `postgres.js`, `unsafe(sql, [new Date()])`                   | **OK**                          |
   | drizzle `where(sql\`col < ${new Date()}\`)`                      | **FAIL** `ERR_INVALID_ARG_TYPE` |
   | drizzle `where(sql\`col < ${date.toISOString()}::timestamptz\`)` | **OK**                          |

   So the driver is sound and the ORM binding is not. This is not confined to one query: `Date` parameters
   appear throughout `packages/db/src/repos/` (`attempts`, `audit`, `budget`, `checkout`, `devices`,
   `disputes`, `agents`), so any repository method that filters on a timestamp is dead against a real
   database. `packages/db` is not this work package's file, so it is reported rather than patched; a fix
   belongs in the repositories (bind an ISO string with an explicit `timestamptz` cast) or in the ORM pin.

   **Why the tests here did not catch it, and why that is not a defence:** every repository member reaches the
   store through a port, and this package's harness supplies `storeDouble`. The suite proves the _sequence_,
   which is what this package owns. It cannot prove the binding, because the binding is somebody else's
   layer. That gap is exactly why the composition has to be booted against a real database at least once.

## The Gate stays LLM-free

`OrchestratorDeps` has exactly one member that reaches a language model: `compiler`, through
`IntentCompiler.compile`. The Gate receives `deps.gate` **by reference, unaltered** — asserted by a `Proxy`
that records every property read and fails on `llm` / `model` / `openai`. That is the structural half of
D-018's ESLint ban: `GateDeps` has no member through which a model could be reached, and this package does
not wrap it in one.

## Testing without credentials or a database

`test/harness.ts` drives the **real** `evaluate`, the **real** `createOrderFromDecisionDetailed`, the **real**
`PayPalClient` (with `fetchImpl` replaced — the seam `PayPalClientOpts` already declares) and the **real**
`reserveIn`/`releaseIn`/`commitIn` over `createInMemoryBudgetStore`. AGENTS.md rule 5 forbids faking PayPal's
_behaviour_; replacing the socket is the seam `packages/paypal/test/fixtures` uses, and the doc-derived
response bodies are never used to assert PayPal behaviour.

The one double is the compiler, and it is justified in the harness header: this package asserts sequencing,
and `compile` has 285 tests of its own.

The one seam worth reading twice is `OrchestratorStoreDouble.decide`: it copies the attempt row **the Gate
actually inserted** into the order world, so the I-1 comparison runs against values that travelled through
the Gate rather than numbers a test typed in two places.
