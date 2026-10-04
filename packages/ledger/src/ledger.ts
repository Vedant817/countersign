/**
 * The budget *ledger* — spec **D19**, **§8.10 check 11**, §7.2 (`budget_accounts` is a cache of
 * `budget_entries`), §12 **EC-MA-1** and **EC-MA-2**.
 *
 * `reservation.ts` owns the lifetime of one claim. This file owns the two things a lifetime cannot
 * answer on its own:
 *
 *  1. **Is the cache telling the truth?** `budget_accounts.reserved/spent` is a cache of
 *     `SUM(budget_entries.amount_minor) GROUP BY kind`; spec §7.2 requires a nightly check. The
 *     invariant is `reserved + spent <= cap` and the schema CHECK is only a backstop, so it is
 *     re-derived here from the entries and asserted — a violated invariant is an `err`, never a
 *     warning, because a Gate decision taken against a broken balance is not defensible at dispute.
 *  2. **How many times may this happen again?** Check 11's recurrence windows are arithmetic on
 *     `(frequency, start_date, end_date, number | max_occurrences)`. This is D19's second obligation:
 *     the library reports `recurrence` and `agent_recurrence` as network-enforced and does not
 *     evaluate them, so *we* count. All of it is pure — no clock, no database, no LLM — so it can be
 *     property-tested instead of argued about.
 */

import {
  add,
  compare,
  formatMoney,
  money,
  type CsError,
  type MandateId,
  type Money,
  type Result,
} from '@countersign/core'
import {
  computeFromEntries,
  reconcileIn,
  type BudgetBalance,
  type BudgetStore,
  type ReconcileReport,
  type WalletCapPeriod,
} from '@countersign/db'
import { ok } from '@countersign/core'

import {
  FREQUENCY_SECONDS,
  VI_FREQUENCIES,
  type CommitCounter,
  type LedgerEntryKind,
  type RecurrenceVerdict,
  type ViFrequency,
} from './types'

export { FREQUENCY_SECONDS, VI_FREQUENCIES }
export type { ViFrequency }

/* ------------------------------------------------------------------------------------------ */
/* The invariant                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * `reserved + spent <= cap`, re-derived from the entries.
 *
 * Returns a `CsError` rather than a boolean so the Gate can turn a broken ledger into a BLOCK with a
 * registry code and honest copy, instead of allowing a spend against a balance nobody can explain.
 */
export function ledgerInvariant(balance: BudgetBalance): Result<BudgetBalance, CsError> {
  const committed = add(balance.reserved, balance.spent)
  if (compare(committed, balance.cap) > 0) {
    return {
      ok: false,
      error: {
        code: 'GATE_BUDGET_EXCEEDED',
        message:
          `Ledger invariant violated for ${balance.mandateId}: reserved ${balance.reserved.minor} + ` +
          `spent ${balance.spent.minor} > cap ${balance.cap.minor}`,
        userMessage: 'We could not verify the limit on this mandate, so nothing was charged.',
        retryable: false,
        details: {
          mandateId: balance.mandateId,
          capMinor: balance.cap.minor.toString(),
          spentMinor: balance.spent.minor.toString(),
          reservedMinor: balance.reserved.minor.toString(),
        },
      },
    }
  }
  return ok(balance)
}

/**
 * `budget_accounts` against `budget_entries`. Spec §7.2's "balances must equal the sum of entries
 * (nightly check)".
 *
 * Thin on purpose: the arithmetic and the lock already exist in `packages/db`
 * (`computeFromEntries`, `reconcileIn`). Duplicating them here would create a second answer to
 * "what does the ledger say", which is the failure mode this repository keeps naming.
 */
export function reconcileLedger(
  store: BudgetStore,
  mandateId: MandateId,
): Promise<Result<ReconcileReport, CsError>> {
  return reconcileIn(store, mandateId)
}

/** The zero ledger: what a freshly opened budget looks like. */
export function emptyTotals(): Record<LedgerEntryKind, bigint> {
  return { RESERVE: 0n, RELEASE: 0n, COMMIT: 0n, REVERSE: 0n }
}

/** `reserved` and `spent` implied by a set of entry totals. Mirrors `packages/db`, re-checked by a test. */
export function balancesFromEntries(totals: Record<LedgerEntryKind, bigint>): {
  reserved: bigint
  spent: bigint
} {
  return computeFromEntries(totals)
}

/* ------------------------------------------------------------------------------------------ */
/* Wallet period                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** Rolling windows, in seconds. `DAY` is 24 h and `MONTH` is 30 d — `packages/db` matches these. */
export const WALLET_PERIOD_SECONDS: Readonly<Record<WalletCapPeriod, number>> = Object.freeze({
  DAY: 24 * 60 * 60,
  MONTH: 30 * 24 * 60 * 60,
})

/** `nowSec - period`, the `since` Gate check 9 hands to `walletCapCheckIn`. */
export function walletPeriodStart(period: WalletCapPeriod, nowSec: number): Date {
  return new Date((nowSec - WALLET_PERIOD_SECONDS[period]) * 1000)
}

/* ------------------------------------------------------------------------------------------ */
/* Recurrence — Gate check 11                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** `YYYY-MM-DD` → epoch seconds at UTC midnight. Rejects anything else rather than guessing. */
export function isoDateToEpochSec(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const ms = Date.UTC(year, month - 1, day)
  const back = new Date(ms)
  // Reject 31 February and friends: Date.UTC happily rolls them over, which would move the window.
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null
  return Math.floor(ms / 1000)
}

export interface RecurrenceInput {
  readonly constraint:
    | {
        type: 'mandate.payment.recurrence'
        frequency: ViFrequency
        start_date: string
        end_date?: string | null
        number?: number | null
      }
    | {
        type: 'mandate.payment.agent_recurrence'
        frequency: ViFrequency
        start_date: string
        end_date: string
        max_occurrences?: number | null
      }
  readonly nowSec: number
  /** COMMITs already recorded for this mandate at or after the window start. */
  readonly commitsInWindow: number
}

/**
 * Check 11. Is one more occurrence inside the limits the user signed?
 *
 * Four separate limits, and **all** of them are evaluated — a recurrence that fails on `number` but
 * passes on `end_date` is still a violation, and the buyer is told which:
 *
 * | Limit | Source | Fails when |
 * |---|---|---|
 * | date window | `start_date` / `end_date` | `nowSec` is outside `[start, end]` |
 * | occurrence count | `number` (recurrence) or `max_occurrences` (agent_recurrence) | `commitsInWindow >= limit` |
 * | frequency | `frequency` | no window to measure (`INDA`/`TWOK`/`TWMN`) |
 *
 * ### Why an unmeasurable frequency is not a pass
 *
 * `TWOK` (twice weekly) and `TWMN` (three times monthly) have no single period, so this returns
 * `windowSeconds: null` and the Gate reports the check **not applicable**. Returning `allowed: true`
 * there would be the D19 lie in a new costume: a constraint the user signed, reported as enforced,
 * having not been. It is a P2 feature (§16 week of 4 Nov), and until it lands the honest answer is
 * "not applicable", which the decision record shows.
 */
export function evaluateRecurrence(input: RecurrenceInput): RecurrenceVerdict {
  const { constraint, nowSec, commitsInWindow } = input
  const windowSeconds = FREQUENCY_SECONDS[constraint.frequency] ?? null
  const startSec = isoDateToEpochSec(constraint.start_date)
  const endRaw = constraint.end_date ?? null
  const endSec = endRaw === null ? null : isoDateToEpochSec(endRaw)

  const outsideDateWindow: RecurrenceVerdict['outsideDateWindow'] =
    startSec === null
      ? null
      : nowSec < startSec
        ? 'BEFORE_START'
        : endSec !== null && nowSec > endSec
          ? 'AFTER_END'
          : null

  const limit =
    constraint.type === 'mandate.payment.recurrence'
      ? (constraint.number ?? null)
      : (constraint.max_occurrences ?? null)

  // The window starts at the constraint's start_date, or `period` before now — whichever is later, so
  // an occurrence from before the mandate began can never count against its limit.
  const windowStartSec =
    windowSeconds === null
      ? nowSec
      : startSec === null
        ? nowSec - windowSeconds
        : Math.max(startSec, nowSec - windowSeconds)

  const dateOk = outsideDateWindow === null && startSec !== null
  const countOk = limit === null ? true : commitsInWindow < limit

  return {
    constraintType: constraint.type,
    frequency: constraint.frequency,
    windowSeconds,
    windowStartSec,
    used: commitsInWindow,
    limit,
    allowed: dateOk && countOk,
    outsideDateWindow,
  }
}

/**
 * Read the recurrence constraints out of a mandate's signed L2 constraint list.
 *
 * Returns `null` for anything unrecognised rather than guessing: a `type` this file does not know is
 * a **skipped** constraint, and a skipped constraint is exactly the D19 failure mode.
 */
export function readRecurrenceConstraints(
  constraints: readonly unknown[] | undefined,
): Array<
  Extract<
    RecurrenceInput['constraint'],
    { type: 'mandate.payment.recurrence' | 'mandate.payment.agent_recurrence' }
  >
> {
  const out: Array<
    Extract<
      RecurrenceInput['constraint'],
      { type: 'mandate.payment.recurrence' | 'mandate.payment.agent_recurrence' }
    >
  > = []
  for (const c of constraints ?? []) {
    if (typeof c !== 'object' || c === null) continue
    const rec = c as Record<string, unknown>
    const type = rec['type']
    const frequency = rec['frequency']
    const start = rec['start_date']
    if (typeof frequency !== 'string' || !(VI_FREQUENCIES as readonly string[]).includes(frequency))
      continue
    if (typeof start !== 'string') continue
    if (type === 'mandate.payment.recurrence') {
      out.push({
        type,
        frequency: frequency as ViFrequency,
        start_date: start,
        end_date: typeof rec['end_date'] === 'string' ? rec['end_date'] : null,
        number: typeof rec['number'] === 'number' ? rec['number'] : null,
      })
    } else if (type === 'mandate.payment.agent_recurrence') {
      if (typeof rec['end_date'] !== 'string') continue
      out.push({
        type,
        frequency: frequency as ViFrequency,
        start_date: start,
        end_date: rec['end_date'],
        max_occurrences: typeof rec['max_occurrences'] === 'number' ? rec['max_occurrences'] : null,
      })
    }
  }
  return out
}

/**
 * Count the COMMITs a recurrence window needs. The time-bounded half of check 11.
 *
 * Not on `BudgetStore` because that port exposes whole-history sums; `packages/db`'s
 * `countCommitsSince` is the Drizzle implementation of this one-method port.
 */
export async function commitsInRecurrenceWindow(
  counter: CommitCounter,
  mandateId: MandateId,
  windowStartSec: number,
): Promise<Result<number, CsError>> {
  return counter.countCommitsSince(mandateId, new Date(windowStartSec * 1000))
}

/** An in-memory {@link CommitCounter}, for the memory store in the Gate's tests. */
export function memoryCommitCounter(
  totals: ReadonlyMap<MandateId, readonly { atMs: number }[]>,
): CommitCounter {
  return {
    async countCommitsSince(mandateId, since) {
      return ok((totals.get(mandateId) ?? []).filter((e) => e.atMs >= since.getTime()).length)
    },
  }
}

/** A one-line budget summary for the merchant UI's spend bar. */
export function summariseBalance(b: BudgetBalance): string {
  return `${formatMoney(b.spent)} spent · ${formatMoney(b.reserved)} held · ${formatMoney(b.available)} available of ${formatMoney(b.cap)}`
}

/** Zero in a currency. The one place a `Money` is built from a literal, and it is a literal zero. */
export function zeroMoney(currency: BudgetBalance['currency']): Money {
  return money(0n, currency)
}
