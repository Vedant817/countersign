/**
 * The status-rank table and comparator — spec **§8.12** "Status rank tables", **§12.3 EC-WH-3**.
 *
 * Table-driven on purpose. Every ordering §8.12 names gets a row, including the cases that are easy to get
 * wrong and the two that only exist because a value exists at all:
 *
 * | Case | §8.12 |
 * |---|---|
 * | `PENDING < COMPLETED < PARTIALLY_REFUNDED < REFUNDED` | the capture ladder, verbatim |
 * | `REVERSED` and `DECLINED` are terminal | "and `REVERSED`/`DECLINED` are terminal" |
 * | equal rank is not a change | EC-WH-3's equal-rank case |
 * | a fetch older than the stored one is skipped | "if the fetched `update_time` < the stored one, skip" |
 * | disputes rank by `(stage, status, update_time)` | "Disputes: rank by …" |
 *
 * Everything here is pure and needs no clock, no socket and no database — which is the point of the split
 * documented in `status-rank.ts`.
 */
import { describe, expect, it } from 'vitest'

import {
  AUTHORIZATION_RANK,
  CAPTURE_RANK,
  DISPUTE_STAGE_RANK,
  DISPUTE_STATUS_RANK,
  ORDER_RANK,
  REFUND_RANK,
  RESOURCE_KINDS,
  TERMINAL_STATUSES,
  compareRankedState,
  compareRanks,
  disputeStageOf,
  disputeStatusOf,
  hookOwed,
  isTerminalStatus,
  parseUpdateTime,
  rankAuthorization,
  rankCapture,
  rankDispute,
  rankOrder,
  rankRefund,
  rankOf,
  statusRankTable,
  typedStatus,
} from '../src/status-rank'

/* ------------------------------------------------------------------------------------------ */
/* The tables themselves                                                                         */
/* ------------------------------------------------------------------------------------------ */

describe('§8.12 capture rank table', () => {
  it('RANK-1 orders PENDING < COMPLETED < PARTIALLY_REFUNDED < REFUNDED', () => {
    expect(CAPTURE_RANK.PENDING).toEqual([0, 1])
    expect(CAPTURE_RANK.COMPLETED).toEqual([0, 2])
    expect(CAPTURE_RANK.PARTIALLY_REFUNDED).toEqual([0, 3])
    expect(CAPTURE_RANK.REFUNDED).toEqual([0, 4])
  })

  it('RANK-2 REVERSED and DECLINED are terminal, and so is REFUNDED', () => {
    expect(isTerminalStatus('capture', 'REVERSED')).toBe(true)
    expect(isTerminalStatus('capture', 'DECLINED')).toBe(true)
    // `REFUNDED` is terminal even though §8.12 does not say so. A capture PayPal has fully refunded does
    // not come back as `COMPLETED`, and a table that let it would walk a refunded capture backwards on the
    // next sweep.
    expect(isTerminalStatus('capture', 'REFUNDED')).toBe(true)
    expect(isTerminalStatus('capture', 'COMPLETED')).toBe(false)
    expect(isTerminalStatus('capture', 'PENDING')).toBe(false)
    expect(isTerminalStatus('capture', 'PARTIALLY_REFUNDED')).toBe(false)
  })

  it('RANK-3 an unranked capture status is known:false and never written', () => {
    // `FAILED` is a real PayPal capture status and is **not** in `capture_status`. It must come back unknown
    // rather than silently ranking above or below something.
    const failed = rankCapture('FAILED')
    expect(failed.known).toBe(false)
    expect(failed.typed).toBeNull()
    expect(failed.terminal).toBe(false)

    const unknown = rankCapture('SOMETHING_NEW')
    expect(unknown.known).toBe(false)
    expect(typedStatus('capture', 'SOMETHING_NEW')).toBeNull()
    expect(typedStatus('capture', 'COMPLETED')).toBe('COMPLETED')
  })

  it('RANK-4 every kind has a table, and dispute is the one with two', () => {
    expect(RESOURCE_KINDS).toEqual(['capture', 'refund', 'authorization', 'order', 'dispute'])
    for (const kind of ['capture', 'refund', 'authorization', 'order'] as const) {
      const table = statusRankTable<string>(kind)
      expect(table).not.toBeNull()
      // Every terminal status must be rankable, or `isTerminalStatus` could name a value the comparator
      // could never see — a terminal rule that never fires.
      for (const status of TERMINAL_STATUSES[kind]) {
        expect(rankOf(kind, status)).toBeDefined()
      }
    }
    expect(statusRankTable('dispute')).toBeNull()
    expect(rankOf('dispute', 'CHARGEBACK')).toBeUndefined()
  })
})

describe('the other three tables', () => {
  it('RANK-5 refunds are PENDING → COMPLETED or PENDING → FAILED, and both ends are terminal', () => {
    expect(REFUND_RANK.PENDING).toEqual([0, 1])
    expect(REFUND_RANK.COMPLETED).toEqual([0, 2])
    expect(REFUND_RANK.FAILED).toEqual([1, 1])
    expect(isTerminalStatus('refund', 'COMPLETED')).toBe(true)
    expect(isTerminalStatus('refund', 'FAILED')).toBe(true)
    expect(isTerminalStatus('refund', 'PENDING')).toBe(false)
  })

  it('RANK-6 EXPIRED is a terminal authorization state, and it is ours', () => {
    expect(AUTHORIZATION_RANK.EXPIRED).toEqual([1, 3])
    expect(isTerminalStatus('authorization', 'EXPIRED')).toBe(true)
    expect(isTerminalStatus('authorization', 'CAPTURED')).toBe(true)
    expect(isTerminalStatus('authorization', 'VOIDED')).toBe(true)
    expect(isTerminalStatus('authorization', 'DENIED')).toBe(true)
    expect(isTerminalStatus('authorization', 'CREATED')).toBe(false)
    // PayPal has no `PAYMENT.AUTHORIZATION.EXPIRED` **event** (report §26), which is why this status is
    // reachable at all. `reconcile.ts`'s expiry sweep is the only thing that produces it.
    expect(rankOf('authorization', 'EXPIRED')).toBeDefined()
  })

  it('RANK-7 PENDING_REVIEW sits above ORDER_CREATED so a settlement can follow it (EC-CAP-4)', () => {
    expect(ORDER_RANK.ORDER_CREATED).toEqual([0, 1])
    expect(ORDER_RANK.PENDING_REVIEW).toEqual([0, 2])
    expect(ORDER_RANK.AUTHORIZED).toEqual([0, 3])
    expect(ORDER_RANK.CAPTURED).toEqual([0, 5])
    expect(compareRanks(ORDER_RANK.PENDING_REVIEW, ORDER_RANK.ORDER_CREATED)).toBe(1)
    expect(compareRanks(ORDER_RANK.CAPTURED, ORDER_RANK.PENDING_REVIEW)).toBe(1)
    for (const s of [
      'CAPTURED',
      'DECLINED',
      'PAYMENT_FAILED',
      'VOIDED',
      'CANCELLED',
      'AUTH_EXPIRED',
    ]) {
      expect(isTerminalStatus('order', s)).toBe(true)
    }
  })
})

describe('§8.12 dispute rank: (stage order, status, update_time)', () => {
  it('RANK-8 the stage order is INQUIRY < CHARGEBACK < PRE_ARBITRATION < ARBITRATION', () => {
    expect(DISPUTE_STAGE_RANK).toEqual({
      INQUIRY: 1,
      CHARGEBACK: 2,
      PRE_ARBITRATION: 3,
      ARBITRATION: 4,
    })
  })

  it('RANK-9 stage is the PRIMARY key, so CHARGEBACK+OPEN outranks INQUIRY+WAITING_FOR_SELLER_RESPONSE', () => {
    // EC-WH-3's dispute case, exactly: a dispute that moves **backwards** in `status` (3 → 1) while
    // advancing in `stage` (1 → 2). That is what happens when `CUSTOMER.DISPUTE.UPDATED` is delivered before
    // `CREATED` — the UPDATE is the later, truer state and it looks like a status regression. A comparison
    // that led with `status` would refuse it and strand a live chargeback at inquiry stage.
    const decision = compareRankedState(
      rankDispute({ stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE' }),
      rankDispute({ stage: 'CHARGEBACK', status: 'OPEN' }),
    )
    expect(decision.verdict).toBe('ADVANCE')
    expect(decision.nextStatus).toBe('OPEN')
    expect(decision.reason).toContain('outranks')
  })

  it('RANK-9a a terminal dispute is not revived by a stage advance', () => {
    // The terminal rule is checked before the rank, and deliberately so. A `RESOLVED` inquiry is closed;
    // letting a later `CHARGEBACK` fetch move it would resurrect a case PayPal has already finished, and
    // EC-REF-4's "is there an open dispute" check would start counting it again.
    const decision = compareRankedState(
      rankDispute({ stage: 'INQUIRY', status: 'RESOLVED' }),
      rankDispute({ stage: 'CHARGEBACK', status: 'OPEN' }),
    )
    expect(decision.verdict).toBe('SKIP_TERMINAL')
    expect(decision.applyDetail).toBe(false)
  })

  it('RANK-10 within a stage, status rank decides, and RESOLVED/OTHER are terminal', () => {
    expect(DISPUTE_STATUS_RANK.OPEN).toBeLessThan(DISPUTE_STATUS_RANK.WAITING_FOR_SELLER_RESPONSE)
    expect(DISPUTE_STATUS_RANK.WAITING_FOR_SELLER_RESPONSE).toBeLessThan(
      DISPUTE_STATUS_RANK.UNDER_REVIEW,
    )
    expect(isTerminalStatus('dispute', 'RESOLVED')).toBe(true)
    expect(isTerminalStatus('dispute', 'OTHER')).toBe(true)
    expect(isTerminalStatus('dispute', 'UNDER_REVIEW')).toBe(false)

    const decision = compareRankedState(
      rankDispute({ stage: 'CHARGEBACK', status: 'UNDER_REVIEW' }),
      rankDispute({ stage: 'CHARGEBACK', status: 'RESOLVED' }),
    )
    expect(decision.verdict).toBe('ADVANCE')
    expect(decision.nextStatus).toBe('RESOLVED')
  })

  it('RANK-11 a status regression within a stage keeps the rank but refreshes the detail', () => {
    // PayPal really does go back from `UNDER_REVIEW` to `WAITING_FOR_SELLER_RESPONSE` when it re-asks for
    // evidence. Refusing the write would strand a newer `seller_response_due_date`, and the Defender would
    // file against a stale date. The rank stays; the detail moves.
    const decision = compareRankedState(
      rankDispute({
        stage: 'CHARGEBACK',
        status: 'UNDER_REVIEW',
        updateTime: '2026-10-04T12:00:00Z',
      }),
      rankDispute({
        stage: 'CHARGEBACK',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        updateTime: '2026-10-05T09:00:00Z',
      }),
    )
    expect(decision.verdict).toBe('REFRESH')
    expect(decision.nextStatus).toBeUndefined()
    expect(decision.applyDetail).toBe(true)
    expect(decision.reason).toContain('does not outrank')
  })

  it('RANK-12 an incomplete fetch is refused outright rather than half-applied', () => {
    // Either field missing ⇒ `known: false` ⇒ `SKIP_UNKNOWN`. A list response that populates `status` but
    // not `dispute_life_cycle_stage` must not be half-written.
    for (const partial of [
      { status: 'WAITING_FOR_SELLER_RESPONSE' },
      { stage: 'CHARGEBACK' },
      { stage: 'CHARGEBACK', status: 'SOMETHING_NEW' },
      { stage: 'NEW_STAGE', status: 'WAITING_FOR_SELLER_RESPONSE' },
      {},
    ]) {
      const state = rankDispute(partial)
      expect(state.known).toBe(false)
      const decision = compareRankedState(
        rankDispute({ stage: 'CHARGEBACK', status: 'OPEN' }),
        state,
      )
      expect(decision.verdict).toBe('SKIP_UNKNOWN')
      expect(decision.applyDetail).toBe(false)
    }
  })

  it('RANK-13 disputeStageOf and disputeStatusOf recover the typed values, and refuse to guess', () => {
    const state = rankDispute({ stage: 'PRE_ARBITRATION', status: 'UNDER_REVIEW' })
    expect(disputeStageOf(state)).toBe('PRE_ARBITRATION')
    expect(disputeStatusOf(state)).toBe('UNDER_REVIEW')

    const unknown = rankDispute({ stage: 'CHARGEBACK', status: 'MYSTERY' })
    expect(disputeStageOf(unknown)).toBeNull()
    expect(disputeStatusOf(unknown)).toBeNull()
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Lexicographic comparison                                                                      */
/* ------------------------------------------------------------------------------------------ */

describe('compareRanks', () => {
  it('RANK-14 compares left to right, first difference wins', () => {
    expect(compareRanks([0, 1], [0, 2])).toBe(-1)
    expect(compareRanks([0, 3], [0, 2])).toBe(1)
    expect(compareRanks([0, 2], [0, 2])).toBe(0)
    // A branch difference dominates any step difference, which is why the rank is a tuple at all.
    expect(compareRanks([0, 9], [1, 1])).toBe(-1)
    expect(compareRanks([1, 1], [0, 9])).toBe(1)
  })

  it('RANK-15 a missing element sorts as -Infinity, and an empty array is the lowest rank', () => {
    expect(compareRanks([0], [0, 1])).toBe(-1)
    expect(compareRanks([0, 1], [0])).toBe(1)
    // `[]` is the "no stored row" case, and it must sort below everything.
    expect(compareRanks([], [0, 1])).toBe(-1)
    expect(compareRanks([], [])).toBe(0)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* The comparator: one row per §8.12 rule                                                         */
/* ------------------------------------------------------------------------------------------ */

const T1 = '2026-10-04T12:00:00Z'
const T2 = '2026-10-04T12:05:00Z'

interface Row {
  readonly from: string
  readonly to: string
  readonly fromTime?: string
  readonly toTime?: string
  readonly expectVerdict: string
  readonly expectNext: string | undefined
  readonly expectDetail: boolean
  readonly why: string
}

const CAPTURE_ROWS: readonly Row[] = [
  // --- the ladder, in order ---
  {
    from: 'PENDING',
    to: 'COMPLETED',
    expectVerdict: 'ADVANCE',
    expectNext: 'COMPLETED',
    expectDetail: true,
    why: 'the ordinary completion',
  },
  {
    from: 'COMPLETED',
    to: 'PARTIALLY_REFUNDED',
    expectVerdict: 'ADVANCE',
    expectNext: 'PARTIALLY_REFUNDED',
    expectDetail: true,
    why: 'a partial refund advances the ladder',
  },
  {
    from: 'PARTIALLY_REFUNDED',
    to: 'REFUNDED',
    expectVerdict: 'ADVANCE',
    expectNext: 'REFUNDED',
    expectDetail: true,
    why: 'the rest of the refund completes it',
  },
  // --- the regressions EC-WH-3 names, in both directions ---
  {
    from: 'REFUNDED',
    to: 'COMPLETED',
    expectVerdict: 'SKIP_TERMINAL',
    expectNext: undefined,
    expectDetail: false,
    why: 'AT-M12.2 — a REFUNDED capture is terminal and a late COMPLETED cannot walk it back',
  },
  {
    from: 'REFUNDED',
    to: 'PENDING',
    expectVerdict: 'SKIP_TERMINAL',
    expectNext: undefined,
    expectDetail: false,
    why: 'even the bottom of the ladder cannot revive a terminal row',
  },
  {
    from: 'PARTIALLY_REFUNDED',
    to: 'COMPLETED',
    expectVerdict: 'REFRESH',
    expectNext: undefined,
    fromTime: T1,
    toTime: T2,
    expectDetail: true,
    why: 'a newer fetch that ranks lower refreshes the detail and leaves the rank alone',
  },
  {
    from: 'PARTIALLY_REFUNDED',
    to: 'COMPLETED',
    expectVerdict: 'SKIP_STALE',
    expectNext: undefined,
    fromTime: T2,
    toTime: T1,
    expectDetail: false,
    why: '§8.12 verbatim — a fetch older than the stored one is skipped outright',
  },
  {
    from: 'COMPLETED',
    to: 'PENDING',
    expectVerdict: 'SKIP_STALE',
    expectNext: undefined,
    fromTime: T2,
    toTime: T1,
    expectDetail: false,
    why: 'the stale check precedes the rank check, so an older PENDING never looks like a change',
  },
  // --- the terminal pair ---
  {
    from: 'COMPLETED',
    to: 'REVERSED',
    expectVerdict: 'ADVANCE',
    expectNext: 'REVERSED',
    expectDetail: true,
    why: 'a reversal after completion is real and must be applied',
  },
  {
    from: 'COMPLETED',
    to: 'DECLINED',
    expectVerdict: 'ADVANCE',
    expectNext: 'DECLINED',
    expectDetail: true,
    why: 'we trust the re-fetch over our own row, including when it is surprising',
  },
  {
    from: 'REVERSED',
    to: 'COMPLETED',
    expectVerdict: 'SKIP_TERMINAL',
    expectNext: undefined,
    expectDetail: false,
    why: 'a terminal reversal is not undone by a redelivery',
  },
  {
    from: 'DECLINED',
    to: 'REVERSED',
    expectVerdict: 'SKIP_TERMINAL',
    expectNext: undefined,
    expectDetail: false,
    why: 'terminal beats terminal: neither outranks the other and nothing may move',
  },
  // --- the equal-rank case EC-WH-3 names ---
  {
    from: 'COMPLETED',
    to: 'COMPLETED',
    expectVerdict: 'NO_CHANGE',
    expectNext: undefined,
    expectDetail: false,
    why: 'the same status at the same time is not an update',
  },
  {
    from: 'COMPLETED',
    to: 'COMPLETED',
    expectVerdict: 'REFRESH',
    expectNext: undefined,
    fromTime: T1,
    toTime: T2,
    expectDetail: true,
    why: 'the same status with a newer update_time is still worth mirroring',
  },
  {
    from: 'COMPLETED',
    to: 'COMPLETED',
    expectVerdict: 'NO_CHANGE',
    expectNext: undefined,
    fromTime: T2,
    toTime: T2,
    expectDetail: false,
    why: 'an EQUAL timestamp is not newer, so it is a no-op rather than a refresh',
  },
  // --- the unrankable case ---
  {
    from: 'COMPLETED',
    to: 'FAILED',
    expectVerdict: 'SKIP_UNKNOWN',
    expectNext: undefined,
    expectDetail: false,
    why: 'a status we cannot rank is a status we cannot write, even from a newer fetch',
  },
  {
    from: 'REVERSED',
    to: 'SOMETHING_NEW',
    expectVerdict: 'SKIP_UNKNOWN',
    expectNext: undefined,
    expectDetail: false,
    why: 'SKIP_UNKNOWN precedes the terminal rule: "we do not know this" is the louder answer',
  },
]

describe('compareRankedState over the capture ladder', () => {
  it('RANK-16 exercises every verdict the comparator can return', () => {
    expect(CAPTURE_ROWS.length).toBeGreaterThanOrEqual(16)
    const seen = new Set(CAPTURE_ROWS.map((c) => c.expectVerdict))
    expect([...seen].sort()).toEqual(
      ['ADVANCE', 'NO_CHANGE', 'REFRESH', 'SKIP_STALE', 'SKIP_TERMINAL', 'SKIP_UNKNOWN'].sort(),
    )
  })

  for (const row of CAPTURE_ROWS) {
    it(`RANK-16 ${row.from} → ${row.to} is ${row.expectVerdict}: ${row.why}`, () => {
      const decision = compareRankedState(
        rankCapture(row.from, row.fromTime ?? null),
        rankCapture(row.to, row.toTime ?? null),
      )
      expect(decision.verdict).toBe(row.expectVerdict)
      expect(decision.nextStatus).toBe(row.expectNext)
      expect(decision.applyDetail).toBe(row.expectDetail)
      // A reason is always present, and never carries a body.
      expect(decision.reason.length).toBeGreaterThan(0)
      expect(decision.reason).not.toContain('value')
    })
  }
})

describe('compareRankedState when there is no stored row', () => {
  it('RANK-17 the fetch is authoritative — this is the AT-M12.3 path', () => {
    // A dropped webhook leaves no row, so the reconciler meets a `null` current. That must be an ADVANCE, not
    // a "nothing to compare" shrug, or EC-WH-1 has no fix.
    const decision = compareRankedState(null, rankCapture('COMPLETED', T1))
    expect(decision.verdict).toBe('ADVANCE')
    expect(decision.nextStatus).toBe('COMPLETED')
    expect(decision.applyDetail).toBe(true)
    expect(decision.currentRank).toEqual([])
    expect(decision.reason).toContain('no stored row')
  })

  it('RANK-18 an unranked fetch is still refused when there is no stored row', () => {
    const decision = compareRankedState(null, rankCapture('MADE_UP'))
    expect(decision.verdict).toBe('SKIP_UNKNOWN')
    expect(decision.applyDetail).toBe(false)
  })
})

describe('compareRankedState with an unknown update_time', () => {
  it('RANK-19 a missing update_time never causes a stale skip', () => {
    // §8.12's rule is about a fetch that is *older*. PayPal omitting the timestamp is not that, and
    // treating it as stale would freeze every row whose first fetch lacked a timestamp.
    expect(
      compareRankedState(rankCapture('COMPLETED', T2), rankCapture('REFUNDED', null)).verdict,
    ).toBe('ADVANCE')
  })

  it('RANK-20 with no timestamps at all, only the rank decides', () => {
    expect(compareRankedState(rankCapture('COMPLETED'), rankCapture('REFUNDED')).verdict).toBe(
      'ADVANCE',
    )
    expect(compareRankedState(rankCapture('REFUNDED'), rankCapture('COMPLETED')).verdict).toBe(
      'SKIP_TERMINAL',
    )
    expect(compareRankedState(rankCapture('COMPLETED'), rankCapture('COMPLETED')).verdict).toBe(
      'NO_CHANGE',
    )
  })
})

describe('the other kinds through the same comparator', () => {
  it('RANK-21 a refund never un-completes', () => {
    expect(compareRankedState(rankRefund('COMPLETED'), rankRefund('PENDING')).verdict).toBe(
      'SKIP_TERMINAL',
    )
    expect(compareRankedState(rankRefund('PENDING'), rankRefund('FAILED')).verdict).toBe('ADVANCE')
  })

  it('RANK-22 an authorization expires but is never un-expired', () => {
    expect(
      compareRankedState(rankAuthorization('EXPIRED'), rankAuthorization('CREATED')).verdict,
    ).toBe('SKIP_TERMINAL')
    expect(
      compareRankedState(rankAuthorization('CREATED'), rankAuthorization('EXPIRED')).verdict,
    ).toBe('ADVANCE')
    // The EC-TIME-5 direction that matters: a `CREATED` row whose PayPal state is `VOIDED`.
    expect(
      compareRankedState(rankAuthorization('CREATED'), rankAuthorization('VOIDED')).verdict,
    ).toBe('ADVANCE')
  })

  it('RANK-23 an order advances through PENDING_REVIEW to CAPTURED', () => {
    expect(
      compareRankedState(rankOrder('ORDER_CREATED'), rankOrder('PENDING_REVIEW')).verdict,
    ).toBe('ADVANCE')
    expect(compareRankedState(rankOrder('PENDING_REVIEW'), rankOrder('CAPTURED')).verdict).toBe(
      'ADVANCE',
    )
    expect(compareRankedState(rankOrder('CAPTURED'), rankOrder('AUTHORIZED')).verdict).toBe(
      'SKIP_TERMINAL',
    )
  })
})

/* ------------------------------------------------------------------------------------------ */
/* parseUpdateTime                                                                               */
/* ------------------------------------------------------------------------------------------ */

describe('parseUpdateTime', () => {
  it('RANK-24 parses RFC 3339, and returns null rather than throwing for anything else', () => {
    expect(parseUpdateTime(T1)).toBe(Date.parse(T1))
    expect(parseUpdateTime('2026-10-04T12:00:00.123+05:30')).not.toBeNull()
    for (const bad of [null, undefined, '', '   ', 'not a date', 'yesterday']) {
      expect(parseUpdateTime(bad)).toBeNull()
    }
  })

  it('RANK-25 takes the LATER of update_time and status_update_time', () => {
    // `status_update_time` moves when the status does and `update_time` when anything does. Comparing only
    // one of them misses changes PayPal recorded in the other.
    expect(rankCapture('COMPLETED', T1, T2).updateTimeMs).toBe(Date.parse(T2))
    expect(rankCapture('COMPLETED', T2, T1).updateTimeMs).toBe(Date.parse(T2))
  })
})

/* ------------------------------------------------------------------------------------------ */
/* hookOwed                                                                                      */
/* ------------------------------------------------------------------------------------------ */

describe('hookOwed', () => {
  it('RANK-26 is true only for an ADVANCE', () => {
    expect(hookOwed(rankCapture('PENDING'), rankCapture('COMPLETED'))).toBe(true)
    expect(hookOwed(rankCapture('COMPLETED'), rankCapture('PENDING'))).toBe(false)
    expect(hookOwed(rankCapture('COMPLETED'), rankCapture('COMPLETED'))).toBe(false)
    expect(hookOwed(null, rankCapture('COMPLETED'))).toBe(true)
  })

  it('RANK-27 a PARTIALLY_REFUNDED advance is a rank move but earns no §8.11 hook', () => {
    // The two questions are separate. `hookOwed` answers only "did the rank move", so a caller mapping to a
    // §8.11 movement must still exclude the refund states — `packages/orders`' `outcomeFor` does, and
    // `test/jobs.test.ts` pins that agreement from WP-11's own source.
    expect(hookOwed(rankCapture('COMPLETED'), rankCapture('PARTIALLY_REFUNDED'))).toBe(true)
  })
})
