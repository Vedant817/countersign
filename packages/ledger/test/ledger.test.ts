/**
 * Gate check 11's arithmetic, at the ledger layer. Spec §8.10 row 11, decision **D19**, §8.8's
 * `VIConstraint` shapes.
 *
 * ## Why the recurrence arithmetic is in the ledger and not in `checks.ts`
 *
 * Because it is **pure** and it is the second half of D19. `recurrence` and `agent_recurrence` are
 * constraints the reference Verifiable Intent library reports as network-enforced and never evaluates
 * ([B3]), so Countersign counts them itself. That counting is arithmetic on
 * `(frequency, start_date, end_date, number | max_occurrences)` — no clock, no database, no LLM — which
 * makes it property-testable, and property-testable arithmetic is what stops a window being quietly
 * widened by a refactor.
 *
 * ## The two decisions that are easy to get wrong, and are stated as tests here
 *
 * 1. **Calendar months use the shortest month.** `MNTH` is 28 days, `YEAR` is 365. A window that assumed
 *    31 days would *under*-count near a month end and allow one occurrence too many. A limit is a limit, so
 *    the shorter period is the one that fails closed.
 * 2. **An unmeasurable frequency is not a pass.** `TWOK` (twice weekly) and `TWMN` (three times monthly)
 *    have no single period, so `windowSeconds` is `null` and the Gate reports the check **not applicable**.
 *    Returning `allowed: true` there would be the D19 lie in a new costume: a constraint the user signed,
 *    reported as enforced, having not been.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { MandateId } from '@countersign/core'
import type { BudgetStore } from '@countersign/db'

import {
  FREQUENCY_SECONDS,
  VI_FREQUENCIES,
  WALLET_PERIOD_SECONDS,
  balancesFromEntries,
  commitsInRecurrenceWindow,
  emptyTotals,
  evaluateRecurrence,
  isoDateToEpochSec,
  ledgerInvariant,
  memoryCommitCounter,
  readRecurrenceConstraints,
  reconcileLedger,
  walletPeriodStart,
  zeroMoney,
  type CommitCounter,
  type RecurrenceConstraint,
  type ViFrequency,
} from '../src/index'

const MANDATE = 'mdt_0000000000000000000000000A' as MandateId
const NOW_SEC = 1_760_000_000 // 2025-10-09T08:53:20Z
/** Brackets {@link NOW_SEC}: 2025-01-01 and 2025-12-31. */
const START = '2025-01-01'
const END = '2025-12-31'

describe('isoDateToEpochSec', () => {
  it('parses a plain YYYY-MM-DD at UTC midnight', () => {
    expect(isoDateToEpochSec('1970-01-01')).toBe(0)
    expect(isoDateToEpochSec('2025-10-09')).toBe(Math.floor(Date.UTC(2025, 9, 9) / 1000))
  })

  it('returns null rather than guessing at anything malformed', () => {
    // The constraints are user-signed, so a malformed date is a data problem, not something to coerce.
    for (const bad of [
      '',
      '2025-1-1',
      '01-10-2025',
      '2025-13-01',
      '2025-02-31',
      'yesterday',
      '2025-10-09T00:00Z',
    ]) {
      expect(isoDateToEpochSec(bad), bad).toBeNull()
    }
  })

  it('rejects 31 February rather than letting Date.UTC roll it into March', () => {
    // `Date.UTC(2025, 1, 31)` is 3 March. Silently rolling a date window forward is how a recurrence
    // outlives the month it was signed for.
    expect(isoDateToEpochSec('2025-02-31')).toBeNull()
    expect(isoDateToEpochSec('2025-04-31')).toBeNull()
    expect(isoDateToEpochSec('2024-02-29')).not.toBeNull() // a real leap day
  })

  it('is a property: a date it accepts round-trips to the same calendar day', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1970, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (year, month, day) => {
          const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const sec = isoDateToEpochSec(iso)
          expect(sec).not.toBeNull()
          const back = new Date(sec! * 1000)
          expect(back.getUTCFullYear()).toBe(year)
          expect(back.getUTCMonth() + 1).toBe(month)
          expect(back.getUTCDate()).toBe(day)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('the frequency table', () => {
  it('is the VI enum verbatim — a renamed value would silently widen a signed window', () => {
    expect(VI_FREQUENCIES).toEqual([
      'INDA',
      'DAIL',
      'WEEK',
      'TWOK',
      'TWMN',
      'MNTH',
      'TOMN',
      'QUTR',
      'FOMN',
      'SEMI',
      'YEAR',
      'TYEA',
    ])
    // Every one has an entry, so a new frequency is a compile-visible gap rather than `undefined`.
    for (const f of VI_FREQUENCIES) expect(FREQUENCY_SECONDS[f]).toBeDefined()
  })

  it('calendar periods use the shortest period, so a window errs towards refusing', () => {
    // A 31-day month would under-count near a month end and allow one occurrence too many.
    expect(FREQUENCY_SECONDS['MNTH']).toBe(28 * 86_400)
    expect(FREQUENCY_SECONDS['YEAR']).toBe(365 * 86_400)
    expect(FREQUENCY_SECONDS['DAIL']).toBe(86_400)
    expect(FREQUENCY_SECONDS['WEEK']).toBe(7 * 86_400)
  })

  it('indefinite and sub-monthly frequencies have no window at all', () => {
    for (const f of ['INDA', 'TWOK', 'TWMN'] as const) {
      expect(FREQUENCY_SECONDS[f], f).toBeNull()
    }
  })
})

describe('evaluateRecurrence', () => {
  const recurrence = (over: Partial<RecurrenceConstraint> = {}): RecurrenceConstraint => ({
    type: 'mandate.payment.recurrence',
    frequency: 'MNTH',
    start_date: START,
    end_date: END,
    number: 2,
    ...over,
  })

  it('allows while under the signed occurrence limit', () => {
    const verdict = evaluateRecurrence({
      constraint: recurrence(),
      nowSec: NOW_SEC,
      commitsInWindow: 1,
    })
    expect(verdict.allowed).toBe(true)
    expect(verdict.used).toBe(1)
    expect(verdict.limit).toBe(2)
  })

  it('refuses at the limit — "count of COMMITs within the period < limit" is strict', () => {
    const verdict = evaluateRecurrence({
      constraint: recurrence(),
      nowSec: NOW_SEC,
      commitsInWindow: 2,
    })
    expect(verdict.allowed).toBe(false)
  })

  it('refuses outside the date window, and says which side', () => {
    const before = evaluateRecurrence({
      constraint: recurrence({ start_date: '2027-01-01' }),
      nowSec: NOW_SEC,
      commitsInWindow: 0,
    })
    expect(before.outsideDateWindow).toBe('BEFORE_START')
    expect(before.allowed).toBe(false)

    const after = evaluateRecurrence({
      constraint: recurrence({ end_date: '2025-01-31' }),
      nowSec: NOW_SEC,
      commitsInWindow: 0,
    })
    expect(after.outsideDateWindow).toBe('AFTER_END')
    expect(after.allowed).toBe(false)
  })

  it('a malformed start_date refuses rather than defaulting to "now"', () => {
    // `start_date: null` would make `windowStartSec = now − period`, which counts occurrences from
    // before the mandate existed.
    const verdict = evaluateRecurrence({
      constraint: recurrence({ start_date: 'whenever' }),
      nowSec: NOW_SEC,
      commitsInWindow: 0,
    })
    expect(verdict.allowed).toBe(false)
    expect(verdict.outsideDateWindow).toBeNull()
  })

  it('an absent numeric limit means the date window is the whole limit', () => {
    const verdict = evaluateRecurrence({
      constraint: recurrence({ number: null }),
      nowSec: NOW_SEC,
      commitsInWindow: 999,
    })
    expect(verdict.limit).toBeNull()
    expect(verdict.allowed).toBe(true)
  })

  it('an unmeasurable frequency reports no window rather than a pass', () => {
    const verdict = evaluateRecurrence({
      constraint: recurrence({ frequency: 'TWMN' }),
      nowSec: NOW_SEC,
      commitsInWindow: 0,
    })
    expect(verdict.windowSeconds).toBeNull()
    // `allowed` is the answer to "is one more occurrence inside the limits"; with no measurable window the
    // Gate reports *not applicable*, and this is the flag it keys that off.
    expect(verdict.constraintType).toBe('mandate.payment.recurrence')
  })

  it('the window never starts before the constraint did', () => {
    // An occurrence from before the mandate was signed must not count against its limit.
    const verdict = evaluateRecurrence({
      constraint: recurrence({ frequency: 'WEEK' }),
      nowSec: NOW_SEC,
      commitsInWindow: 0,
    })
    expect(verdict.windowStartSec).toBeGreaterThanOrEqual(isoDateToEpochSec(START)!)
  })

  it('reads `max_occurrences` for agent_recurrence', () => {
    const verdict = evaluateRecurrence({
      constraint: {
        type: 'mandate.payment.agent_recurrence',
        frequency: 'DAIL',
        start_date: START,
        end_date: END,
        max_occurrences: 1,
      },
      nowSec: NOW_SEC,
      commitsInWindow: 1,
    })
    expect(verdict.limit).toBe(1)
    expect(verdict.allowed).toBe(false)
    expect(verdict.constraintType).toBe('mandate.payment.agent_recurrence')
  })

  it('is monotone: more occurrences can only ever be less permissive', () => {
    // A window that got *wider* as occurrences accumulated would be the exact bug this arithmetic exists
    // to prevent, so it is asserted over every frequency rather than reasoned about.
    for (const frequency of VI_FREQUENCIES) {
      let previous = true
      for (let used = 0; used <= 5; used++) {
        const verdict = evaluateRecurrence({
          constraint: recurrence({ frequency, number: 3 }),
          nowSec: NOW_SEC,
          commitsInWindow: used,
        })
        if (previous === false) expect(verdict.allowed, `${frequency} at ${used}`).toBe(false)
        previous = verdict.allowed
      }
    }
  })

  it('is a property: `allowed` is always exactly `used < limit` inside the date window', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VI_FREQUENCIES),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 5 }),
        (frequency, used, limit) => {
          const verdict = evaluateRecurrence({
            constraint: recurrence({ frequency, number: limit }),
            nowSec: NOW_SEC,
            commitsInWindow: used,
          })
          expect(verdict.windowSeconds).toBe(FREQUENCY_SECONDS[frequency as ViFrequency])
          expect(verdict.used).toBe(used)
          expect(verdict.limit).toBe(limit)
          // Inside the date window, the count is the whole story.
          expect(verdict.allowed).toBe(used < limit)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('readRecurrenceConstraints', () => {
  it('finds both recurrence types in a signed constraint list', () => {
    const found = readRecurrenceConstraints([
      { type: 'mandate.payment.amount_range', currency: 'USD', max: 13_000 },
      { type: 'mandate.payment.recurrence', frequency: 'WEEK', start_date: START, number: 2 },
      {
        type: 'mandate.payment.agent_recurrence',
        frequency: 'DAIL',
        start_date: START,
        end_date: END,
        max_occurrences: 3,
      },
    ])

    expect(found).toHaveLength(2)
    expect(found.map((c) => c.type)).toEqual([
      'mandate.payment.recurrence',
      'mandate.payment.agent_recurrence',
    ])
  })

  it('skips anything it does not recognise rather than guessing', () => {
    // A `type` this file does not know is a **skipped** constraint, and a skipped constraint is exactly
    // the D19 failure mode: silently treating an unknown constraint as absent would un-enforce it.
    const found = readRecurrenceConstraints([
      { type: 'mandate.payment.recurrence', frequency: 'FORTNIGHTLY', start_date: START },
      { type: 'mandate.payment.recurrence', frequency: 'WEEK' },
      { type: 'mandate.payment.recurrence', start_date: START },
      { type: 'mandate.payment.agent_recurrence', frequency: 'WEEK', start_date: START },
      'not an object',
      null,
      { type: 'mandate.payment.amount_range', currency: 'USD', max: 13_000 },
    ])

    expect(found).toHaveLength(0)
  })

  it('tolerates a missing or non-array constraints column', () => {
    expect(readRecurrenceConstraints(undefined)).toEqual([])
    expect(readRecurrenceConstraints([])).toEqual([])
  })
})

describe('commitsInRecurrenceWindow', () => {
  it('asks the counter for the window start check 11 computed', async () => {
    const asked: Date[] = []
    const counter: CommitCounter = {
      async countCommitsSince(mandateId, since) {
        asked.push(since)
        expect(mandateId).toBe(MANDATE)
        return { ok: true as const, value: 3 }
      },
    }

    const verdict = evaluateRecurrence({
      constraint: {
        type: 'mandate.payment.recurrence',
        frequency: 'WEEK',
        start_date: START,
        number: 5,
      },
      nowSec: NOW_SEC,
      commitsInWindow: 0,
    })
    const count = await commitsInRecurrenceWindow(counter, MANDATE, verdict.windowStartSec)

    if (!count.ok) throw new Error(count.error.message)
    expect(count.value).toBe(3)
    expect(asked).toHaveLength(1)
    expect(Math.floor(asked[0]!.getTime() / 1000)).toBe(verdict.windowStartSec)
  })

  it('the in-memory counter counts only what is inside the window', async () => {
    const commits = [
      { atMs: (NOW_SEC - 86_400) * 1000 },
      { atMs: (NOW_SEC - 100) * 1000 },
      { atMs: (NOW_SEC - 86_400 * 400) * 1000 },
    ]
    const counter = memoryCommitCounter(new Map([[MANDATE, commits]]))

    const recent = await counter.countCommitsSince(MANDATE, new Date((NOW_SEC - 86_400) * 1000))
    const all = await counter.countCommitsSince(MANDATE, new Date(0))

    if (!recent.ok || !all.ok) throw new Error('counter failed')
    expect(recent.value).toBe(2)
    expect(all.value).toBe(3)
    // A mandate with no commits at all is zero, not an error.
    const none = await counter.countCommitsSince('mdt_nothing' as MandateId, new Date(0))
    expect(none.ok && none.value).toBe(0)
  })
})

describe('the ledger invariant', () => {
  const balance = (over: Partial<Parameters<typeof ledgerInvariant>[0]> = {}) => ({
    mandateId: MANDATE,
    currency: 'USD' as const,
    cap: { minor: 13_000n, currency: 'USD' as const },
    reserved: { minor: 0n, currency: 'USD' as const },
    spent: { minor: 0n, currency: 'USD' as const },
    available: { minor: 13_000n, currency: 'USD' as const },
    version: 0,
    ...over,
  })

  it('passes while reserved + spent <= cap', () => {
    expect(ledgerInvariant(balance({ reserved: zeroMoney('USD') })).ok).toBe(true)
    expect(
      ledgerInvariant(
        balance({ reserved: { minor: 13_000n, currency: 'USD' }, spent: zeroMoney('USD') }),
      ).ok,
    ).toBe(true)
  })

  it('fails loudly when the cache disagrees with the cap, because a decision against it is indefensible', () => {
    const broken = ledgerInvariant(
      balance({
        reserved: { minor: 10_000n, currency: 'USD' },
        spent: { minor: 5_000n, currency: 'USD' },
      }),
    )
    expect(broken.ok).toBe(false)
    if (broken.ok) return
    expect(broken.error.code).toBe('GATE_BUDGET_EXCEEDED')
    expect(broken.error.userMessage).toContain('could not verify')
  })

  it('balancesFromEntries mirrors packages/db, and is checked against it here', () => {
    // COMMIT appears in both legs: it moves money out of `reserved` and into `spent` in one step, so
    // leaving it out of the reserved leg would make every settled purchase look like a leak.
    expect(balancesFromEntries(emptyTotals())).toEqual({ reserved: 0n, spent: 0n })
    expect(
      balancesFromEntries({ RESERVE: 5_000n, RELEASE: 0n, COMMIT: 2_000n, REVERSE: 0n }),
    ).toEqual({
      reserved: 3_000n,
      spent: 2_000n,
    })
    // A refund does **not** return authority: RELEASE lowers `reserved`, it never lowers `spent`.
    expect(
      balancesFromEntries({ RESERVE: 5_000n, RELEASE: 1_000n, COMMIT: 2_000n, REVERSE: 0n }),
    ).toEqual({
      reserved: 2_000n,
      spent: 2_000n,
    })
  })

  it('reconcileLedger reports drift between the cache and the append-only ledger', async () => {
    // A minimal store: this test needs `readBudgetAccount` and `sumEntriesByKind` and nothing else, so
    // rather than import a double from another package (`test/reservation.test.ts` has a fuller one for
    // the reserve/release path) this states exactly the two statements being made.
    const stored = {
      mandate_id: MANDATE,
      currency: 'USD' as const,
      cap_minor: 13_000n,
      reserved_minor: 4_000n,
      spent_minor: 0n,
      version: 2,
      created_at: new Date(0),
      updated_at: new Date(0),
    }
    const store = {
      async readBudgetAccount() {
        return stored
      },
      async sumEntriesByKind() {
        return { RESERVE: 3_000n, RELEASE: 0n, COMMIT: 0n, REVERSE: 0n }
      },
    } as unknown as BudgetStore

    const report = await reconcileLedger(store, MANDATE)
    if (!report.ok) throw new Error(report.error.message)
    // Stored 4000, entries say 3000 — a drift a nightly check has to surface rather than silently repair.
    expect(report.value.ok).toBe(false)
    expect(report.value.stored.reserved.minor).toBe(4_000n)
    expect(report.value.computed.reserved.minor).toBe(3_000n)
    expect(report.value.drift.reserved.minor).toBe(1_000n)
  })

  it('reconcileLedger reports ok when the cache matches the ledger exactly', async () => {
    const store = {
      async readBudgetAccount() {
        return {
          mandate_id: MANDATE,
          currency: 'USD' as const,
          cap_minor: 13_000n,
          reserved_minor: 1_000n,
          spent_minor: 2_000n,
          version: 3,
          created_at: new Date(0),
          updated_at: new Date(0),
        }
      },
      async sumEntriesByKind() {
        return { RESERVE: 3_000n, RELEASE: 0n, COMMIT: 2_000n, REVERSE: 0n }
      },
    } as unknown as BudgetStore

    const report = await reconcileLedger(store, MANDATE)
    if (!report.ok) throw new Error(report.error.message)
    expect(report.value.ok).toBe(true)
    expect(report.value.drift.reserved.minor).toBe(0n)
    expect(report.value.drift.spent.minor).toBe(0n)
  })
})

describe('wallet periods', () => {
  it('are rolling, matching packages/db, so no calendar boundary can surprise a demo at midnight', () => {
    expect(WALLET_PERIOD_SECONDS).toEqual({ DAY: 86_400, MONTH: 2_592_000 })
    expect(Math.floor(walletPeriodStart('DAY', NOW_SEC).getTime() / 1000)).toBe(NOW_SEC - 86_400)
    expect(Math.floor(walletPeriodStart('MONTH', NOW_SEC).getTime() / 1000)).toBe(
      NOW_SEC - 2_592_000,
    )
  })
})
