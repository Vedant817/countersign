# `@countersign/ledger`

The budget ledger: reservation lifetime and recurrence arithmetic. Spec **D19**, **§8.10** checks 8, 9
and 11, **§7.2**, §12 **EC-MDT-2**, **EC-MA-1**, **EC-STOCK-3**, **EC-TIME-4**.

```bash
pnpm --filter @countersign/ledger typecheck
pnpm --filter @countersign/ledger lint
pnpm --filter @countersign/ledger test     # 50 tests, no database, no network
```

## What this package owns

Spec **D19** is the whole reason it exists. The reference Verifiable Intent library lists `budget`,
`recurrence` and `agent_recurrence` as _network-enforced_ and **does not evaluate them** ([B3]). Whoever
plays the network role has to enforce them. That is this package:

| Concern                                            | Where                                | Called by                   |
| -------------------------------------------------- | ------------------------------------ | --------------------------- |
| Reserve `amount` against a cap, under a row lock   | `reserveForAttempt`                  | Gate check 8                |
| Give it back, idempotently, with a recorded reason | `releaseReservation`                 | Gate compensation, M11 void |
| Expire reservations that never became an order     | `expireStaleReservations`            | the worker job              |
| Decide a signed recurrence window                  | `evaluateRecurrence`                 | Gate check 11               |
| Prove the cached balance still matches the entries | `ledgerInvariant`, `reconcileLedger` | the nightly check (§7.2)    |
| Where a wallet-cap period starts                   | `walletPeriodStart`                  | Gate check 9                |

## What it does **not** own, and why that is the point

- **No SQL.** `SELECT … FOR UPDATE` lives in `packages/db/repos/budget.ts` (WP-02). This package consumes
  the `BudgetStore` port that file exports and calls `reserveIn` / `releaseIn` / `walletCapCheckIn` /
  `reconcileIn` through it. A second `reserved += amount` anywhere is the one budget hazard this project
  names, so the arithmetic and the lock are **imported, never re-derived** — and there is no way to write
  the optimistic path here, because the only thing this package can reach is the port.
- **No second budget port.** `BudgetStore` is re-exported from `@countersign/db`, not redefined. The
  Gate's tests inject one; the app injects `drizzleStore(exec)`. Two ports would be two answers to "what
  does the ledger say", which is the failure mode this repository keeps naming.
- **No clock, no network, no LLM.** Every function takes `nowSec` as a number, so §12.5 **EC-TIME-4** can
  hold: one `clock.nowSec()`, captured once at Gate start, used by every expiry comparison in the
  decision. A reservation that read the clock itself would be stamped a second later than every other
  check, and the price-lock boundary race EC-TIME-4 exists for would come back through this door.
- **No money as a float.** Every amount is `bigint` minor units plus an ISO-4217 code (`@countersign/core`
  `Money`), and `scripts/check-money-discipline.mjs` fails CI on a float in a money position — this
  package's roots were added to that scan and the scan was proven to fire on both of them.

## The three properties this package guarantees

### 1. A retry cannot double-write

Every entry id is **derived from our own ids** (§8.0 rule 6), not generated:

```ts
ledgerEntryId({ kind: 'RESERVE', mandateId, attemptId }) // ben_ + 26 hex of SHA-256 over the canonical scope
```

Re-running a reserve for the same attempt hits the `budget_entries` primary key instead of claiming the
buyer's budget twice. The scope is hashed through `canonicalJson`, so key order in the caller's object
cannot change the id. The id is minted _before_ the write, which is why `packages/db` requires one rather
than defaulting it — a random id would be generated twice on a retry and would write twice.

The same derivation makes a **swept-then-voided** reservation write one `RELEASE`, not two.

### 2. A failure after check 8 gives the money back

`releaseReservation` is the compensation the Gate calls when any later check fails (AT-M10.4) and the
orchestrator calls when no order is created. `releaseIn` **clamps at the current `reserved`**, so neither
a retry nor a sweep racing an explicit void can credit authority that was never reserved — and the reason
is written to `budget_entries.reason`, verbatim, from `RELEASE_REASONS`:

| Reason         | When                                                                               |
| -------------- | ---------------------------------------------------------------------------------- |
| `GATE_BLOCKED` | the Gate decided BLOCK after check 8 reserved                                      |
| `OUT_OF_STOCK` | stock ran out between check 10 and the order (EC-STOCK-3)                          |
| `REVOKED`      | the mandate was revoked or suspended while the attempt was in flight (EC-MDT-2)    |
| `CANCELLED`    | the buyer cancelled                                                                |
| `EXPIRED`      | the mandate or the price lock expired                                              |
| `NO_ORDER`     | the 30 minutes ran out with no order — the sweeper's default, and what §8.10 names |
| `MANUAL`       | a human said so                                                                    |

A release that could not complete is an `err`, never a partial success reported as success:
`expireStaleReservations` returns per-reservation detail, because "the buyer still has $60 held" is a bug
somebody has to chase and a bare `ok([])` would hide it.

### 3. The cache is never trusted over the ledger

§7.2 stores `budget_accounts.reserved/spent` as a **cache** of
`SUM(budget_entries.amount_minor) GROUP BY kind` and requires a nightly check. `ledgerInvariant`
re-derives `reserved + spent <= cap` from the entries and returns a `CsError` — never a boolean, never a
warning — because a Gate decision taken against a balance nobody can explain is not defensible at dispute.
`reconcileLedger` reports the drift between the cache and the append-only ledger.

## The recurrence arithmetic (check 11)

D19's second obligation: the library reports `recurrence` and `agent_recurrence` as network-enforced, so
**we** count. It is all pure functions over `(frequency, start_date, end_date, number | max_occurrences)`,
which is why it is property-tested rather than argued about.

Three decisions worth stating, because each has a lenient and a strict reading:

| Decision               | What this package does                                                           | Why                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| At the limit           | **refuses** (`used < limit` is strict)                                           | §8.10 row 11: "count of COMMITs within the period < limit". Strict-at-the-limit is what a buyer would call correct.                                                                                    |
| Calendar frequencies   | `MNTH`/`TOMN` use **28** days, `QUTR` 28, `SEMI` 14, `FOMN` 7, `YEAR`/`TYEA` 365 | A window that assumed 31 days would _under_-count near a month end and allow one occurrence too many. A window is a limit, so the shorter period fails closed.                                         |
| `INDA`, `TWOK`, `TWMN` | **no measurable window** → `notApplicable`                                       | Indefinite, twice-a-week and three-times-a-month are not expressible as one window. Reporting "no window" is honest; reporting "allowed" would be a pass nobody earned, and "violated" would be a lie. |

`isoDateToEpochSec` returns `null` for anything malformed — including `31 February`, which
`Date.UTC` would silently roll into March. A recurrence constraint that cannot be parsed **refuses**;
defaulting it to "now" would silently widen a window the buyer signed.

`agent_recurrence` reads `max_occurrences` where `recurrence` reads `number`, and both are pinned by a
monotonicity test: more occurrences can only ever be less permissive.

## Wallet-cap periods

`WALLET_PERIOD_SECONDS` is `{ DAY: 86400, MONTH: 2592000 }` and `walletPeriodStart(period, nowSec)`
returns `nowSec - period`. These are **rolling** windows, matching `packages/db`, and that is a
deliberate demo decision: a calendar month boundary would make a demo's wallet cap reset at midnight,
which looks like a bug to a judge and is not one.

## Tests

| File                  | What it covers                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reservation.test.ts` | deterministic entry identity, reserve/release idempotency, the 30-minute boundary (`>=`), the sweep, and AT-M10.4's release-then-re-reserve shape                |
| `ledger.test.ts`      | `isoDateToEpochSec` (including a property round-trip), the frequency table, `evaluateRecurrence`'s limits and monotonicity, the invariant, drift, wallet periods |

The property tests are the load-bearing ones: the partition of expired reservations is total, disjoint
and threshold-exact; `allowed` is always exactly `used < limit` inside the date window; an accepted date
round-trips to the same calendar day. Those are the three places a plausible refactor introduces an
off-by-one that no example would catch.

## Known limits

- **`COMMITTED` beats `EXPIRED`** in `reservationStatus`, so a late sweep never releases settled money.
  The consequence is that a reservation committed _after_ its 30 minutes is reported `COMMITTED` and the
  window is silently not enforced for it. That is the right trade — the capture happened — but it means the
  window is a _liveness_ bound, not a validity bound.
- **The sweeper is not scheduled here.** `expireStaleReservations` is a function; WP-11's worker owns the
  cron. Until that runs, a buyer's money is held for as long as the process is up.
- **`reconcileLedger` reuses `packages/db`'s `reconcileIn`** rather than re-deriving the sums. The
  nightly check is therefore only as good as that query, and a test here asserts the two agree rather
  than asserting the SQL.
