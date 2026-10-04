# `@countersign/worker` - the process that runs the webhook jobs

Spec **§8.12 (M12, WP-12)**, **§8.10**, **§7.2**, **§6**, decisions **D12**, **D13**.
Acceptance tests inherited from `packages/webhooks`; edge cases **EC-WH-1..7**, **EC-TIME-5**,
**EC-PP-2**, **EC-IDEM-4**.

This package contains no payment logic and no webhook logic. It is the part that **wires**
`packages/webhooks` to a queue and a clock, and its whole value is in the ordering.

---

## The three files

| File            | Contents                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `schedule.ts`   | **Pure data.** Which job runs, how often, and which spec line or edge case asked for it. No imports, no clock, no database.          |
| `job-runner.ts` | The `pg-boss` port (behind an async factory) and the handler table: `JobName` → the `packages/webhooks` function that does the work. |
| `index.ts`      | `startWorker`, the composition helper, and a guarded `main()`.                                                                       |

---

## The three properties worth defending

### 1. Importing this package connects to nothing

```ts
import { handleWebhook } from '@countersign/webhooks' // needs a WebhookQueue
import { JOB_PROCESS } from '@countersign/webhooks' // WP-17's route handler needs the name
```

WP-17's Next route handler lives in `apps/web` and needs the queue port. If `@countersign/worker` opened a
pool at import time, importing the webhook route would open a database pool in a process that only ever
acknowledges an HTTP request - and in a serverless or test environment that pool is never closed.

So `createPgBossQueue` is an **async factory** that does `await import('pg-boss')` inside itself, and
`pg-boss` appears nowhere as a static import. `QUEUE-4` asserts that against the source text: a static import
would execute on import and pull `pg` into every process that touches this file.

Constructing is also not connecting. `start()` is a separate, later call.

### 2. Handlers are registered before schedules

A schedule that fires before its `work()` exists creates a job nobody will ever consume. pg-boss keeps
producing `wh.reconcile` on the five-minute cadence into a queue with no worker, and the backlog grows
silently - nothing errors, nothing alerts, and state quietly stops being repaired.

`registerJobs` therefore registers every handler, then every schedule, and `startWorker` calls `start()`
**last** (pg-boss begins polling on it, so a handler registered afterwards races the first fetch).
`QUEUE-3 every handler is registered before any schedule` asserts the interleaving rather than the outcome,
because the outcome is indistinguishable from a healthy boot.

### 3. A retryable failure is re-thrown; a permanent one is not

pg-boss decides whether to retry from whether the handler throws. So a handler that throws on a **permanent**
failure retries forever against a PayPal 404, and one that swallows a **transient** failure loses the work. The
mapping is explicit and it is the whole retry policy:

| Outcome                                                                                                | pg-boss sees  | Why                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------- |
| `ok` - including `IGNORED`, `UNCHANGED`, `ALREADY_PROCESSED`, `REJECTED_FORGED`, `DEFERRED_UNVERIFIED` | complete      | These are correct conclusions, not failures.                                             |
| `err`, `retryable: true` (`PP_UNAVAILABLE`, `PP_RATE_LIMITED`, `CS_RATE_LIMITED`)                      | **re-thrown** | A retry will probably succeed. Losing a job to a PayPal blip is worse than a slow retry. |
| `err`, `retryable: false` (`PP_NOT_FOUND`, `CS_NOT_FOUND`, `PP_UNPROCESSABLE`)                         | complete      | Retrying cannot change a 404.                                                            |

The verdict comes from `CsError.retryable`, which `@countersign/core` derives from the code. It is **not**
re-decided here, so a new `CsErrorCode` cannot be retryable in one place and permanent in the other.

`QueueHandler` is deliberately **not** `JobHandler`. `packages/webhooks`'s `JobHandler` returns
`Result<unknown, CsError>`, which is right for a function called from another function in the same process and
wrong for one called by a queue: a resolved `Result` that is `ok: false` would look like a success.
`settleForQueue` is the only thing allowed to cross that seam.

---

## The schedule table

| Job                    | Cadence            | Why                                                                                                                                                                                           |
| ---------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wh.reconcile`         | every 5 min        | §8.12 verbatim. The user-visible promise is "a lost webhook is fixed within 5 minutes" (EC-WH-1, EC-WH-5), so this number is a feature claim.                                                 |
| `wh.disputes`          | every 2 min        | §8.12 verbatim. Faster than the resource sweep because a dispute carries a §8.11 filing deadline.                                                                                             |
| `wh.auth-expiry`       | every 5 min        | EC-TIME-5. **No `PAYMENT.AUTHORIZATION.EXPIRED` event exists**, so polling is the only way an expiry is ever observed.                                                                        |
| `release.reservations` | every 5 min        | §8.10: reservations expire after 30 min with no order. 5 min against a 30-min TTL.                                                                                                            |
| `budget.reconcile`     | nightly, 02:17 UTC | §7.2: "`budget_accounts` is a cache; balances must equal the sum of entries".                                                                                                                 |
| `wh.verify`            | every 5 min        | EC-WH-7's retry. Deliberately loose: the verify call has its own timeout and exponential backoff, and a tight loop would hammer the endpoint during exactly the outage it exists to ride out. |
| `wh.process`           | **none**           | Enqueued by `handleWebhook` (§8.12 step 4). A cron would be a second, competing source of jobs for the same queue name.                                                                       |

Every expression is **UTC**: these crons are about intervals, and "every five minutes" is the same instant
everywhere. IST appears only in the UI and in reports to Vedant (AGENTS.md rule 10).

The nightly check runs at **02:17**, not 02:00. A build pipeline, a `pg_dump` or another scheduler on the hour
is the usual reason a job finds the database already busy.

**Cron expressions are validated at registration.** pg-boss reports a malformed expression on the **first
tick** - up to a day later, for the nightly job - so a typo is caught at boot instead of discovered by
absence. `isPlausibleCron` checks the shape against a deliberately small grammar. It is not a cron parser and
does not claim to be; `SCHEDULE-2` asserts that limitation so it cannot quietly grow into a claim of
completeness.

---

## Idempotency

AGENTS.md rule 6 requires that re-running any job is safe, and these handlers are:

- `wh.process` re-reads the `webhook_events` row and re-fetches from PayPal. The payload's `resourceId` is
  **not** used as a source of state - a payload can be re-sent, hand-edited or written by an older worker.
- The sweeps re-fetch every candidate and write through the monotonic rank, so a replay converges rather than
  double-applying.
- `wh.reconcile` also calls `reprocessUnstoredWork`, which re-drives rows that were durably stored but never
  enqueued. §8.12 step 5's "200 even if processing fails" is only safe because of this: the insert and the
  enqueue are two writes, and the window between them is otherwise a lost event until PayPal's 25 redeliveries
  run out.

§8.12 step 4's `singletonKey = resource_id` is the other half, and it is set by
`packages/webhooks`'s ingest path rather than here.

---

## A missing ledger port does not stop the webhook half

`release.reservations` and `budget.reconcile` are **caller-supplied handlers**, and an unwired one is a logged
no-op rather than a throw. A worker that refuses to start because a ledger port was not wired would make the
webhook half unavailable during a wiring mistake in the other half - the wrong trade, since the webhook half is
the one that moves no money and therefore the one that should keep running.

Both are `ok({ skipped: true })`, so pg-boss completes them and `QUEUE-2` asserts they are logged at `warn`.

---

## Boot failures, and the exit codes

| Failure                      | Result                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| Malformed cron               | `err(CS_VALIDATION)`, nothing registered, nothing started       |
| Any registration error       | `err(CS_INTERNAL)`, `boss.start()` never called                 |
| pg-boss will not start       | `err(CS_INTERNAL, retryable: true)`                             |
| Missing environment variable | `main()` prints the missing keys and exits **78** (`EX_CONFIG`) |
| A job the queue retries      | exit **75** (`EX_TEMPFAIL`)                                     |

`main()` handles a `CsError` as well as an `Error`. That is not pedantry: `env()` throws a `CsError`, so an
`instanceof Error` check would print `[object Object]` - precisely the failure mode the branch exists to
prevent.

`stop()` is idempotent, because a container orchestrator sends `SIGTERM` and then `SIGKILL`, and a
double-stop that throws turns a clean drain into exit 1.

---

## Contract issues

| Gap                                                  | Why it is needed                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No production `WebhookStore` adapter.**            | `packages/db` exports the repository functions and they are correct; nothing assembles them into the port. `productionDeps` throws and says so, rather than starting a worker that would 500 on its first tick. **This is the one thing between this process and running against a live database.** |
| **No `WebhookAudit` implementation.**                | `packages/db`'s `appendAudit` is hash-chained; nothing adapts it to the port.                                                                                                                                                                                                                       |
| **`captures.reconcileCandidates`**                   | §8.12's sweep needs a capture reached through its order; no repository function does that. Inherited from `packages/webhooks` and recorded in its README too.                                                                                                                                       |
| `release.reservations` / `budget.reconcile` handlers | `@countersign/ledger`'s primitives exist (`expireStaleReservations`, `reconcileLedger`) and `repos/attempts.ts::findStaleAttempts` finds the candidates, but composing them needs a `BudgetStore` and a mandate list, which is composition this package leaves to its caller rather than inventing. |

The three that are **not** gaps, and are worth saying so it is clear they were considered:

- `CaptureOutcomeHooks` (§8.11's ledger movements) is an **optional port**, not a call into
  `@countersign/orders`. Deciding _when_ a capture outcome owes a movement is §8.12's rank decision; deciding
  _what_ the movement is, is WP-11's.
- The event-driven `wh.process` needs no cron, so no scheduler is involved in AT-M12.1-6.

---

## Tests

54 tests, no credentials, no database, no network.

| File                 | Tests | What it defends                                                                                                                  |
| -------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `schedule.test.ts`   | 17    | Every cadence is traceable to a spec line or an EC id; `wh.process` has no cron; expressions are well-formed.                    |
| `job-runner.test.ts` | 28    | The retry table exhaustively; all seven job names wired; handlers before schedules; `pg-boss` only dynamically imported.         |
| `worker.test.ts`     | 9     | A malformed cron and a registration failure both fail the boot; `stop()` is idempotent; the whole schedule table is registrable. |

`test/harness.ts` provides a fake `WebhookStore` and a recording pg-boss double. The double can invoke the
handler pg-boss registered, so `WORKER-3` drives `wh.reconcile` end to end - real `packages/webhooks` code,
no database.

One thing worth naming, because it is an easy way to make a whole suite lie: the harness builds failures with
`csError(code, message)` rather than hand-writing `{ code, message, retryable: false }`. `retryable` is
**derived** from the code, so a hand-written `PP_UNAVAILABLE` marked permanent would make a job that should be
retried complete instead - and the entire retry policy would look correct while being inverted.
