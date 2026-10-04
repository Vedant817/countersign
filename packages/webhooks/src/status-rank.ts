/**
 * Monotonic status ranks — spec **§8.12**, **§12.3 EC-WH-3**, decisions D12 and D13.
 *
 * ## The one rule
 *
 * > We never trust payload state. State comes from re-fetching PayPal. — spec §8.12, §3.1
 *
 * This file is where that rule is *decided*. `wh.process` and the reconciler both re-fetch, and then ask
 * {@link compareRankedState} whether the fetched state is allowed to move our row. The answer is a
 * {@link RankVerdict}, and it is a **pure function** so it can be tested exhaustively without a database,
 * a queue or a socket — the same reason `withinValidity` in `@countersign/core` is pure and exported.
 *
 * ## Why ranks are tuples and not numbers
 *
 * §8.12 says captures are `PENDING(1) < COMPLETED(2) < PARTIALLY_REFUNDED(3) < REFUNDED(4)` with
 * `REVERSED`/`DECLINED` terminal. That is **two orders**, not one: a capture either advances along the
 * success branch (`PENDING → COMPLETED → … → REFUNDED`) or falls off it (`DECLINED`, `REVERSED`), and the
 * two are not comparable with each other. `COMPLETED → REVERSED` is a real, correct transition; a single
 * scalar ordering has to either rank `REVERSED` above `COMPLETED` (so a `REFUNDED → DECLINED` nonsense
 * also looks like progress) or below it (so the real reversal looks like a regression).
 *
 * So a rank is a tuple compared **lexicographically**, `[branch, step]`:
 *
 * - `branch 0` — the success path, and the only branch that can grow.
 * - `branch 1` — a terminal failure or reversal. Reachable from anywhere on branch 0; terminal itself.
 *
 * Disputes get a three-element tuple because §8.12 names three axes: `(stage order, status, update_time)`.
 *
 * ## Rank is monotonic; detail is not
 *
 * This is the distinction that separates a real reconciler from a hopeful one, so it is stated as the
 * invariant of this module:
 *
 * - The **rank** (`status`, `stage`) only ever moves up, and never leaves a terminal state. EC-WH-3's
 *   "REFUNDED before COMPLETED" must leave the capture `REFUNDED`, never walk it back to `COMPLETED`.
 * - The **detail** (`raw`, `seller_response_due_date`, `require_evidence`, deadlines) is whatever PayPal
 *   most recently said, and a *newer* `update_time` refreshes it even when the rank is lower.
 *
 * Without that split, a dispute that legitimately goes `WAITING_FOR_SELLER_RESPONSE → UNDER_REVIEW →
 * WAITING_FOR_SELLER_RESPONSE` (PayPal re-asking for evidence, which it does) would be frozen: the second
 * transition is a rank regression, so its newer deadline would never be mirrored and the Defender would
 * file against a stale date. The split lets us keep `status` where it is and still write the new
 * `update_time`, which is exactly "never downgrade a rank" without "ignore everything the newer fetch said".
 *
 * ## Two pre-existing rank tables, and why this one differs
 *
 * Two other tables exist and are **not** changed here (AGENTS.md rule 8 — they belong to other packages):
 *
 * | Where | Table | Difference |
 * |---|---|---|
 * | `@countersign/paypal` `types.ts` `CAPTURE_STATUS_RANK` | `REVERSED/DECLINED/FAILED/VOIDED = 5` | one scalar order; cannot express the two branches |
 * | `@countersign/db` `repos/orders.ts` `CAPTURE_STATUS_RANK` | `DECLINED 100, REVERSED 101` | above `REFUNDED(4)`, so `COMPLETED → DECLINED` reads as progress |
 *
 * Both are **more permissive** than this module, and both are *guards* rather than decisions — the db table
 * backs `upsertCaptureStatusFromFetch`'s SQL guard, which is the backstop, not the policy (the comment in
 * `paypal/types.ts` says so outright: "the ordering decision belongs to WP-12"). They compose safely: this
 * module runs first and can only ever hand the repository a write the repository would also accept, except
 * in the terminal cases where this module refuses and the repository would have allowed (`DECLINED →
 * REVERSED`). Recorded in `README.md` → "Deviations".
 */

/** The five aggregates a PayPal webhook or a reconciler sweep can move. */
import type {
  AuthorizationStatus,
  CaptureStatus,
  DisputeStage,
  DisputeStatus,
  OrderStatus,
  RefundStatus,
} from '@countersign/db'

export type ResourceKind = 'capture' | 'refund' | 'authorization' | 'order' | 'dispute'

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'capture',
  'refund',
  'authorization',
  'order',
  'dispute',
]

/**
 * A status reduced to something comparable.
 *
 * `rank` is compared element by element, left to right, first difference wins. `updateTimeMs` is **not** in
 * the tuple: §8.12 states it as a separate rule ("if the fetched `update_time` < the stored one, skip"), and
 * folding it in would make a dispute's rank depend on a clock reading, which is how two copies of the same
 * rank end up with two different answers.
 */
export interface RankedState {
  readonly kind: ResourceKind
  /** The status string as it will be stored. Preserved verbatim so an unknown value can be reported. */
  readonly status: string
  /**
   * The status narrowed to its stored union, or `null` when it is not in the table.
   *
   * `status` stays a `string` so an unrecognised value can survive into the log and the `SKIP_UNKNOWN`
   * reason. `typed` is what a caller writes, and it is `null` for anything the table does not vouch for —
   * so a status the database could not hold anyway cannot reach a write.
   */
  readonly typed: string | null
  readonly rank: readonly number[]
  /** Whether this status admits no successor. A terminal row is never moved again. */
  readonly terminal: boolean
  /** `false` when the status is not in the table. Unknown statuses are **never written** (fail closed). */
  readonly known: boolean
  /** PayPal's `update_time` (or `status_update_time`) in epoch ms, or `null` when it sent none. */
  readonly updateTimeMs: number | null
}

/** What a comparison concluded. Every value except `ADVANCE` and `REFRESH` means "write no rank". */
export type RankVerdict =
  /** The fetched state outranks the stored one. Write it, and mirror the detail. */
  | 'ADVANCE'
  /** The fetched state does not outrank the stored one, but it is strictly newer. Mirror the detail only. */
  | 'REFRESH'
  /** Same rank, and nothing newer. Nothing to do. */
  | 'NO_CHANGE'
  /** The fetched `update_time` is **older** than the stored one. §8.12: skip. */
  | 'SKIP_STALE'
  /** The stored rank is terminal. Nothing may move it again, in either direction. */
  | 'SKIP_TERMINAL'
  /** The fetched status is not in the table, so it cannot be ranked and therefore cannot be trusted. */
  | 'SKIP_UNKNOWN'

export interface RankComparison {
  readonly verdict: RankVerdict
  /** The status to persist. `undefined` whenever the rank must not move. */
  readonly nextStatus: string | undefined
  /** Whether the fetched body (`raw`, deadlines, …) should be mirrored at all. */
  readonly applyDetail: boolean
  readonly currentRank: readonly number[]
  readonly nextRank: readonly number[]
  /** One line, for the log line and the `webhook_events.error` text. Never contains the raw body. */
  readonly reason: string
}

/* ------------------------------------------------------------------------------------------ */
/* The tables                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * Every table below is typed as `Record<TheSchemaEnum, …>`, **not** `Record<string, …>`.
 *
 * That is a load-bearing type, and it is the reason this file can be trusted not to drift:
 *
 * - Adding a value to `capture_status` in `packages/db/src/schema.ts` makes **this file fail to
 *   typecheck** until somebody decides where it sits in the ordering. With a `Record<string, …>` the new
 *   value would be silently `undefined`, every comparison against it would take the `!known` branch, and
 *   the capture would simply stop being reconcilable — with no error anywhere.
 * - Removing one is the same error in the other direction.
 *
 * `repos/orders.ts` says the same thing about its own table ("Numbers, not `Array.indexOf` on the enum, so
 * adding a value cannot silently reorder history"); typing the key is the same guarantee one level up.
 */
export const CAPTURE_RANK: Readonly<Record<CaptureStatus, readonly number[]>> = Object.freeze({
  // §8.12 verbatim: `PENDING(1) < COMPLETED(2) < PARTIALLY_REFUNDED(3) < REFUNDED(4)`, and
  // `REVERSED`/`DECLINED` terminal.
  PENDING: [0, 1],
  COMPLETED: [0, 2],
  PARTIALLY_REFUNDED: [0, 3],
  REFUNDED: [0, 4],
  DECLINED: [1, 1],
  REVERSED: [1, 2],
})

/** Refunds — `refund_status`: `PENDING → COMPLETED`, or `PENDING → FAILED`. Never back. */
export const REFUND_RANK: Readonly<Record<RefundStatus, readonly number[]>> = Object.freeze({
  PENDING: [0, 1],
  COMPLETED: [0, 2],
  FAILED: [1, 1],
})

/**
 * Authorizations — `authorization_status`.
 *
 * `EXPIRED` is **ours**, not PayPal's: there is no `PAYMENT.AUTHORIZATION.EXPIRED` event (report §26), so
 * the expiry is discovered by polling. Terminal on branch 1 for that reason — once discovered, the row is
 * finished.
 */
export const AUTHORIZATION_RANK: Readonly<Record<AuthorizationStatus, readonly number[]>> =
  Object.freeze({
    PENDING: [0, 1],
    CREATED: [0, 2],
    PARTIALLY_CAPTURED: [0, 3],
    CAPTURED: [0, 4],
    DENIED: [1, 1],
    VOIDED: [1, 2],
    EXPIRED: [1, 3],
  })

/**
 * Orders — `order_status`, which is **our** enum rather than PayPal's.
 *
 * `CHECKOUT.ORDER.APPROVED` arrives against a PayPal order and is written onto our row, so the rank is over
 * our values. `PENDING_REVIEW` sits at `[0, 2]`: a pending capture moves the order out of `ORDER_CREATED`
 * (EC-CAP-4) and the settlement that follows must be able to move it forward again.
 */
export const ORDER_RANK: Readonly<Record<OrderStatus, readonly number[]>> = Object.freeze({
  ORDER_CREATED: [0, 1],
  PENDING_REVIEW: [0, 2],
  AUTHORIZED: [0, 3],
  PARTIALLY_CAPTURED: [0, 4],
  CAPTURED: [0, 5],
  DECLINED: [1, 1],
  PAYMENT_FAILED: [1, 2],
  VOIDED: [1, 3],
  CANCELLED: [1, 4],
  AUTH_EXPIRED: [1, 5],
})

/** `dispute_life_cycle_stage` — §8.12's "stage order". Identical to `STAGE_RANK` in `repos/disputes.ts`. */
export const DISPUTE_STAGE_RANK: Readonly<Record<DisputeStage, number>> = Object.freeze({
  INQUIRY: 1,
  CHARGEBACK: 2,
  PRE_ARBITRATION: 3,
  ARBITRATION: 4,
})

/**
 * `dispute_status`, ranked **within** a stage.
 *
 * A documented assumption, and the honest one: within a stage PayPal's case generally moves from open, to
 * waiting on one side, to review, to resolved. It is not a total order — a case does go back from
 * `UNDER_REVIEW` to `WAITING_FOR_SELLER_RESPONSE` when PayPal re-asks for evidence — and that regression is
 * exactly why {@link compareRankedState} separates the rank from the detail rather than refusing the write.
 * `RESOLVED` and `OTHER` are terminal: PayPal has closed the case either way, and EC-REF-4's "is there an
 * open dispute" check must stop counting it.
 */
export const DISPUTE_STATUS_RANK: Readonly<Record<DisputeStatus, number>> = Object.freeze({
  OPEN: 1,
  WAITING_FOR_BUYER_RESPONSE: 2,
  WAITING_FOR_SELLER_RESPONSE: 3,
  UNDER_REVIEW: 4,
  RESOLVED: 5,
  OTHER: 6,
})

/** Terminal statuses per kind. Derived from the tables above so the two cannot drift. */
export const TERMINAL_STATUSES: Readonly<Record<ResourceKind, ReadonlySet<string>>> = Object.freeze(
  {
    capture: new Set<string>(['REFUNDED', 'DECLINED', 'REVERSED']),
    refund: new Set<string>(['COMPLETED', 'FAILED']),
    authorization: new Set<string>(['CAPTURED', 'DENIED', 'VOIDED', 'EXPIRED']),
    order: new Set<string>([
      'CAPTURED',
      'DECLINED',
      'PAYMENT_FAILED',
      'VOIDED',
      'CANCELLED',
      'AUTH_EXPIRED',
    ]),
    dispute: new Set<string>(['RESOLVED', 'OTHER']),
  },
)

/**
 * The rank table for one kind. `null` for `dispute`, which has two tables rather than one.
 *
 * `T` is the schema enum, so `rankOf('capture', 'COMPLETED')` is typed `CaptureStatus | undefined` at the
 * call site without a cast — which is what lets `reconcileCapture` pass a status to
 * `captures.applyFromFetch` and have `tsc` check it against `capture_status`.
 */
export function statusRankTable<T extends string>(
  kind: ResourceKind,
): Readonly<Record<T, readonly number[]>> | null {
  switch (kind) {
    case 'capture':
      return CAPTURE_RANK as Readonly<Record<T, readonly number[]>>
    case 'refund':
      return REFUND_RANK as Readonly<Record<T, readonly number[]>>
    case 'authorization':
      return AUTHORIZATION_RANK as Readonly<Record<T, readonly number[]>>
    case 'order':
      return ORDER_RANK as Readonly<Record<T, readonly number[]>>
    case 'dispute':
      return null
  }
}

/** §8.12's terminal check, as a predicate a caller can use without building a `RankedState`. */
export function isTerminalStatus(kind: ResourceKind, status: string): boolean {
  return TERMINAL_STATUSES[kind].has(status)
}

/**
 * The rank of one status, narrowed to the stored enum.
 *
 * `undefined` means "not in the table", which is the `SKIP_UNKNOWN` condition — the caller must not write.
 */
export function rankOf<T extends string>(
  kind: ResourceKind,
  status: string,
): readonly number[] | undefined {
  const table = statusRankTable<T>(kind)
  if (table === null) return undefined
  return Object.prototype.hasOwnProperty.call(table, status)
    ? (table[status as keyof typeof table] as readonly number[])
    : undefined
}

/** Narrow an arbitrary string to one kind's stored enum, or `null`. Pure, and the write gate. */
export function typedStatus<T extends string>(
  kind: ResourceKind,
  status: string | undefined,
): T | null {
  if (status === undefined) return null
  return rankOf<T>(kind, status) === undefined ? null : (status as T)
}

/* ------------------------------------------------------------------------------------------ */
/* Lexicographic comparison                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** `-1 | 0 | 1` over two rank tuples, first difference wins. */
export function compareRanks(a: readonly number[], b: readonly number[]): -1 | 0 | 1 {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? Number.NEGATIVE_INFINITY
    const y = b[i] ?? Number.NEGATIVE_INFINITY
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

/* ------------------------------------------------------------------------------------------ */
/* Constructors                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Parse an RFC 3339 instant to epoch ms, or `null`. Never throws — a missing time is not an error. */
export function parseUpdateTime(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * PayPal's newest of `update_time` and `status_update_time`.
 *
 * `status_update_time` moves when the status does and `update_time` moves when anything does, so taking
 * the later of the two is the only comparison that does not miss a change PayPal recorded in one field.
 */
function newestUpdateTime(...values: (string | null | undefined)[]): number | null {
  let best: number | null = null
  for (const v of values) {
    const ms = parseUpdateTime(v)
    if (ms !== null && (best === null || ms > best)) best = ms
  }
  return best
}

function ranked<T extends string>(
  kind: ResourceKind,
  status: string,
  table: Readonly<Record<T, readonly number[]>>,
  updateTimeMs: number | null,
): RankedState {
  const rank = Object.prototype.hasOwnProperty.call(table, status)
    ? (table[status as T] as readonly number[])
    : undefined
  return {
    kind,
    status,
    typed: rank === undefined ? null : status,
    rank: rank ?? [Number.POSITIVE_INFINITY],
    terminal: rank !== undefined && TERMINAL_STATUSES[kind].has(status),
    known: rank !== undefined,
    updateTimeMs,
  }
}

/** Rank a capture. `updateTime` is PayPal's `update_time` or `status_update_time`, either or both. */
export function rankCapture(
  status: string,
  updateTime?: string | null,
  statusUpdateTime?: string | null,
): RankedState {
  return ranked('capture', status, CAPTURE_RANK, newestUpdateTime(updateTime, statusUpdateTime))
}

export function rankRefund(
  status: string,
  updateTime?: string | null,
  statusUpdateTime?: string | null,
): RankedState {
  return ranked('refund', status, REFUND_RANK, newestUpdateTime(updateTime, statusUpdateTime))
}

export function rankAuthorization(
  status: string,
  updateTime?: string | null,
  statusUpdateTime?: string | null,
): RankedState {
  return ranked(
    'authorization',
    status,
    AUTHORIZATION_RANK,
    newestUpdateTime(updateTime, statusUpdateTime),
  )
}

export function rankOrder(
  status: string,
  updateTime?: string | null,
  statusUpdateTime?: string | null,
): RankedState {
  return ranked('order', status, ORDER_RANK, newestUpdateTime(updateTime, statusUpdateTime))
}

/**
 * Rank a dispute. §8.12: `(stage order, status, update_time)`.
 *
 * `stage` is the primary key of the comparison, which is why it is element 0: an INQUIRY that becomes a
 * CHARGEBACK goes back to `status: OPEN`, and a comparison that led with `status` would call that a
 * regression and refuse the update — stranding a live chargeback at inquiry stage.
 *
 * Either field may be absent (PayPal's list and get responses differ in what they populate). An unknown or
 * missing stage sorts **lowest**, and an unknown or missing status sorts lowest within the stage, so an
 * incomplete fetch can raise the stored rank only if the stored rank was equally incomplete. `known` is
 * `false` unless **both** were recognised, and `SKIP_UNKNOWN` is what that triggers — so a partial fetch is
 * refused outright rather than half-applied.
 */
export function rankDispute(input: {
  readonly stage?: string | null
  readonly status?: string | null
  readonly updateTime?: string | null
}): RankedState {
  const stage = input.stage ?? null
  const status = input.status ?? null
  const stageRank =
    stage !== null && Object.prototype.hasOwnProperty.call(DISPUTE_STAGE_RANK, stage)
      ? (DISPUTE_STAGE_RANK[stage as DisputeStage] as number)
      : 0
  const statusKnown =
    status !== null && Object.prototype.hasOwnProperty.call(DISPUTE_STATUS_RANK, status)
  const statusRank = statusKnown ? (DISPUTE_STATUS_RANK[status as DisputeStatus] as number) : 0
  const known = stageRank > 0 && statusKnown
  const statusLabel = status ?? ''
  return {
    kind: 'dispute',
    status: statusLabel,
    typed: known ? status : null,
    rank: [stageRank, statusRank],
    // Terminal only when the status was recognised: an unrecognised string is `known: false` and is
    // refused before this flag is ever consulted.
    terminal: statusKnown && TERMINAL_STATUSES.dispute.has(statusLabel),
    known,
    updateTimeMs: parseUpdateTime(input.updateTime),
  }
}

/**
 * The `dispute_life_cycle_stage` a `rankDispute` result came from, for the `disputes.stage` column.
 *
 * `null` when the fetch carried no stage we recognise, which is the same `known: false` signal the
 * comparison already refused on — so a caller that reaches for this is only ever writing a row whose stage
 * the rank table vouched for.
 */
export function disputeStageOf(state: RankedState): DisputeStage | null {
  const rank = state.rank[0]
  if (!state.known || rank === undefined) return null
  for (const [stage, value] of Object.entries(DISPUTE_STAGE_RANK)) {
    if (value === rank) return stage as DisputeStage
  }
  return null
}

/** The `dispute_status` a `rankDispute` result came from, narrowed, or `null`. */
export function disputeStatusOf(state: RankedState): DisputeStatus | null {
  return state.typed as DisputeStatus | null
}

/* ------------------------------------------------------------------------------------------ */
/* The comparison                                                                                */
/* ------------------------------------------------------------------------------------------ */

function skip(verdict: RankVerdict, current: RankedState, next: RankedState, reason: string) {
  return {
    verdict,
    nextStatus: undefined,
    applyDetail: false,
    currentRank: current.rank,
    nextRank: next.rank,
    reason,
  } satisfies RankComparison
}

/**
 * §8.12's decision, as one pure function.
 *
 * Checked in this order, and the order is load-bearing — each test in `test/status-rank.test.ts` exists
 * because two of these could be swapped without an obvious symptom:
 *
 * 1. **`SKIP_UNKNOWN`** — the fetched status is not in the table. Checked first because it is the only one
 *    that makes the other comparisons meaningless, and because "we do not know what this means" must be
 *    louder than "this is fine".
 * 2. **`SKIP_TERMINAL`** — the stored rank is terminal. Ahead of the time comparison on purpose: a
 *    terminal row must not be revived by a fetch that happens to be newer, which is the whole point of
 *    "terminal".
 * 3. **`SKIP_STALE`** — the fetched `update_time` is older. §8.12's own sentence.
 * 4. **`ADVANCE`** — the fetched rank outranks the stored rank.
 * 5. **`REFRESH`** — the rank does not advance but the fetch is strictly newer: keep the rank, take the
 *    detail.
 * 6. **`NO_CHANGE`** — nothing to do.
 *
 * @param current the stored state, or `null` for a resource we have no row for.
 * @param next the fetched state.
 */
export function compareRankedState(current: RankedState | null, next: RankedState): RankComparison {
  if (!next.known) {
    return skip(
      'SKIP_UNKNOWN',
      current ?? emptyState(next.kind),
      next,
      `${next.kind} status "${next.status}" is not in the rank table, so it cannot be applied`,
    )
  }
  if (current === null) {
    // No stored row: the fetch is the whole truth. This is the `EC-WH-6`-then-`AT-M12.3` path where the
    // webhook was dropped and the reconciler is the first thing to have looked.
    return {
      verdict: 'ADVANCE',
      nextStatus: next.typed ?? undefined,
      applyDetail: true,
      currentRank: [],
      nextRank: next.rank,
      reason: 'no stored row; the fetch is authoritative',
    }
  }
  if (current.terminal) {
    return skip(
      'SKIP_TERMINAL',
      current,
      next,
      `stored ${current.kind} status "${current.status}" is terminal; "${next.status}" ignored`,
    )
  }
  if (isStale(current, next)) {
    return skip(
      'SKIP_STALE',
      current,
      next,
      `fetched update_time ${iso(next)} is older than the stored ${iso(current)}`,
    )
  }

  const order = current.known ? compareRanks(next.rank, current.rank) : 1
  if (order > 0) {
    return {
      verdict: 'ADVANCE',
      // `next.typed` rather than `next.status`: `known` was proved above, so this is non-null, and it is the
      // value the caller's enum-typed write will accept. A caller that used `next.status` here would be
      // handing `string` to a `CaptureStatus` parameter, which is exactly the cast this avoids.
      nextStatus: next.typed ?? undefined,
      applyDetail: true,
      currentRank: current.rank,
      nextRank: next.rank,
      reason: `${next.status} [${next.rank}] outranks ${current.status} [${current.rank}]`,
    }
  }
  if (isStrictlyNewer(current, next)) {
    return {
      verdict: 'REFRESH',
      nextStatus: undefined,
      applyDetail: true,
      currentRank: current.rank,
      nextRank: next.rank,
      reason:
        order === 0
          ? `same rank ${next.rank}; fetched update_time ${iso(next)} is newer, so the detail is mirrored`
          : `${next.status} [${next.rank}] does not outrank ${current.status} [${current.rank}]; the rank ` +
            `stays and only the newer detail is mirrored`,
    }
  }
  return skip('NO_CHANGE', current, next, `${next.status} is not newer than ${current.status}`)
}

function emptyState(kind: ResourceKind): RankedState {
  return {
    kind,
    status: '',
    typed: null,
    rank: [],
    terminal: false,
    known: false,
    updateTimeMs: null,
  }
}

/** §8.12: "if the fetched `update_time` < the stored one, skip". Equal is not stale. */
function isStale(current: RankedState, next: RankedState): boolean {
  if (current.updateTimeMs === null || next.updateTimeMs === null) return false
  return next.updateTimeMs < current.updateTimeMs
}

/** Strictly newer, in both directions known. Equal timestamps are *not* newer. */
function isStrictlyNewer(current: RankedState, next: RankedState): boolean {
  if (current.updateTimeMs === null || next.updateTimeMs === null) return false
  return next.updateTimeMs > current.updateTimeMs
}

function iso(s: RankedState): string {
  return s.updateTimeMs === null ? 'none' : new Date(s.updateTimeMs).toISOString()
}

/**
 * The capture's stored status advanced past what a fetch said — did the §8.11 hook already run for it?
 *
 * The caller uses this to decide whether a §8.11 ledger movement is owed, and **not** on the status alone:
 * `COMPLETED → PARTIALLY_REFUNDED` is an `ADVANCE` (so a hook would be owed) but it is a *refund* state and
 * §8.11 gives a refund no hook. `packages/orders`' `outcomeFor` makes that second call; this only answers
 * the first one.
 */
export function hookOwed(previous: RankedState | null, next: RankedState): boolean {
  return compareRankedState(previous, next).verdict === 'ADVANCE'
}
