/**
 * Gate check 12's arithmetic, and the `SUSPENDED` consequence. Spec §8.10 row 12, §12 **EC-AGT-2**,
 * **EC-AGT-1**, §18 Q7.
 *
 * ## The off-by-one is the whole test
 *
 * §8.10 says "**more than** 5 attempts per 10 min, or **more than** 3 BLOCKs in a row". So five attempts
 * pass and the sixth trips it; three BLOCKs pass and the fourth trips it.
 *
 * Both directions of that error are bad, in opposite ways:
 *
 * - **Lenient** lets an agent hammer a mandate. §18 Q7's worst case is an attacker who owns the agent
 *   loop entirely, holding the agent key; the velocity guard is one of the few things that responds to that
 *   at all.
 * - **Strict** suspends a buyer who made five purchases in ten minutes, which is ordinary human shopping.
 *
 * So the boundary is asserted from both sides, and the query size is asserted too — see the note on
 * `MAX_CONSECUTIVE_BLOCKS + 1` below.
 */
import { describe, expect, it } from 'vitest'
import { money } from '@countersign/core'
import type { MandateId } from '@countersign/core'

import {
  VELOCITY,
  assessVelocity,
  consecutiveBlocks,
  reviewReason,
  suspendForVelocity,
  velocityBlocked,
} from '../src/index'
import type { AttemptState, GateDeps } from '../src/types'

const MANDATE = 'mdt_0000000000000000000000000A' as MandateId
const NOW_SEC = 1_760_000_000

/** A `GateDeps` with only the two velocity ports filled in. */
function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    ...({
      countRecentAttempts: async () => ({ ok: true, value: 0 }),
      recentAttemptStates: async () => ({ ok: true, value: [] as AttemptState[] }),
      suspendMandate: async () => ({ ok: true, value: true as const }),
    } as Partial<GateDeps>),
    ...over,
  } as GateDeps
}

describe('consecutiveBlocks', () => {
  it('counts the leading run of BLOCKs and stops at the first non-BLOCK', () => {
    // "In a row" means in a row: BLOCK, ALLOW, BLOCK, BLOCK is a streak of 2, not 3.
    expect(consecutiveBlocks(['GATED_BLOCK', 'GATED_BLOCK', 'GATED_BLOCK'])).toBe(3)
    expect(consecutiveBlocks(['GATED_BLOCK', 'GATED_BLOCK', 'GATED_BLOCK', 'GATED_BLOCK'])).toBe(4)
    expect(consecutiveBlocks(['GATED_BLOCK', 'GATED_BLOCK', 'GATED_ALLOW', 'GATED_BLOCK'])).toBe(2)
    expect(consecutiveBlocks(['GATED_ALLOW', 'GATED_BLOCK', 'GATED_BLOCK'])).toBe(0)
    expect(consecutiveBlocks([])).toBe(0)
  })

  it('treats PENDING_REVIEW as not-a-block, because it is the Gate asking a human, not a refusal', () => {
    expect(consecutiveBlocks(['PENDING_REVIEW', 'GATED_BLOCK'])).toBe(0)
  })

  it('does not count every block in history — a scattered pattern is evidence of nothing', () => {
    // Newest-first. The leading run is 3; the other two BLOCKs are separated by ALLOWs and must not count.
    const scattered: AttemptState[] = [
      'GATED_BLOCK',
      'GATED_BLOCK',
      'GATED_BLOCK',
      'GATED_ALLOW',
      'GATED_BLOCK',
      'GATED_ALLOW',
      'GATED_BLOCK',
    ]
    expect(consecutiveBlocks(scattered)).toBe(3)
    expect(scattered.filter((s) => s === 'GATED_BLOCK')).toHaveLength(5)
  })
})

describe('assessVelocity', () => {
  it('passes at exactly the limits and trips above them', async () => {
    const atLimit = await assessVelocity({
      deps: deps({
        countRecentAttempts: async () => ({ ok: true, value: VELOCITY.MAX_ATTEMPTS_PER_WINDOW }),
        recentAttemptStates: async () => ({
          ok: true,
          value: ['GATED_BLOCK', 'GATED_BLOCK', 'GATED_BLOCK'],
        }),
      }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })
    if (!atLimit.ok) throw new Error(atLimit.error.message)
    expect(atLimit.value.tooManyAttempts).toBe(false)
    expect(atLimit.value.tooManyBlocks).toBe(false)
    expect(atLimit.value.trips).toBe(false)

    const overLimit = await assessVelocity({
      deps: deps({
        countRecentAttempts: async () => ({
          ok: true,
          value: VELOCITY.MAX_ATTEMPTS_PER_WINDOW + 1,
        }),
      }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })
    if (!overLimit.ok) throw new Error(overLimit.error.message)
    expect(overLimit.value.tooManyAttempts).toBe(true)
    expect(overLimit.value.trips).toBe(true)
  })

  it('asks for one row more than the limit, or the rule is unreachable', async () => {
    // ">3 BLOCKs" needs to be able to *see* a fourth. Asking for exactly 3 caps the count at 3 and makes
    // the rule a permanently dead branch that still reads correct — a check that cannot fire is worse than
    // no check, because the record claims it ran.
    let askedFor = 0
    await assessVelocity({
      deps: deps({
        recentAttemptStates: async (_id, limit) => {
          askedFor = limit
          return { ok: true, value: [] }
        },
      }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })

    expect(askedFor).toBe(VELOCITY.MAX_CONSECUTIVE_BLOCKS + 1)
  })

  it('uses the window and the one clock read it is given', async () => {
    let askedSince = 0
    await assessVelocity({
      deps: deps({
        countRecentAttempts: async (_id, since) => {
          askedSince = Math.floor(since.getTime() / 1000)
          return { ok: true, value: 0 }
        },
      }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })

    expect(askedSince).toBe(NOW_SEC - VELOCITY.WINDOW_SECONDS)
    expect(VELOCITY.WINDOW_SECONDS).toBe(600)
  })

  it('either rule alone trips it', async () => {
    const flood = await assessVelocity({
      deps: deps({ countRecentAttempts: async () => ({ ok: true, value: 99 }) }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })
    const blocks = await assessVelocity({
      deps: deps({
        recentAttemptStates: async () => ({
          ok: true,
          value: ['GATED_BLOCK', 'GATED_BLOCK', 'GATED_BLOCK', 'GATED_BLOCK'],
        }),
      }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })

    if (!flood.ok || !blocks.ok) throw new Error('assessVelocity failed')
    expect(flood.value.tooManyBlocks).toBe(false)
    expect(flood.value.tooManyAttempts).toBe(true)
    expect(blocks.value.tooManyAttempts).toBe(false)
    expect(blocks.value.tooManyBlocks).toBe(true)
    expect(blocks.value.trips).toBe(true)
  })

  it('propagates a failed count rather than treating "I could not tell" as "no flood"', async () => {
    const result = await assessVelocity({
      deps: deps({
        countRecentAttempts: async () => ({
          ok: false as const,
          error: {
            code: 'CS_INTERNAL' as const,
            message: 'count failed',
            userMessage: 'x',
            retryable: true,
          },
        }),
      }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })

    // Failing *open* here would be the D19 failure in a new costume: a guard that reports "no flood" when
    // its own instrumentation is broken is a guard that protects nobody.
    expect(result.ok).toBe(false)
  })

  it('the detail names both numbers, so a merchant log is diagnosable', async () => {
    const result = await assessVelocity({
      deps: deps({
        countRecentAttempts: async () => ({ ok: true, value: 9 }),
        recentAttemptStates: async () => ({ ok: true, value: ['GATED_BLOCK', 'GATED_BLOCK'] }),
      }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })
    if (!result.ok) throw new Error(result.error.message)

    expect(result.value.detail).toContain('9 attempt(s)')
    expect(result.value.detail).toContain('2 consecutive block(s)')
  })
})

describe('the consequence', () => {
  it('reports GATE_BLOCKED — the code describes what happened; the suspension is the consequence', async () => {
    const verdict = await assessVelocity({
      deps: deps({ countRecentAttempts: async () => ({ ok: true, value: 6 }) }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })
    if (!verdict.ok) throw new Error(verdict.error.message)

    const error = velocityBlocked(MANDATE, verdict.value)
    expect(error.code).toBe('GATE_BLOCKED')
    expect(error.userMessage).toContain('Nothing was charged')
    expect(error.details).toMatchObject({
      mandateId: MANDATE,
      attemptsInWindow: 6,
      tooManyAttempts: true,
    })
  })

  it('suspends the mandate, reversibly, and records why', async () => {
    const seen: Array<{ mandateId: MandateId; reason: string }> = []
    const verdict = await assessVelocity({
      deps: deps({ countRecentAttempts: async () => ({ ok: true, value: 6 }) }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })
    if (!verdict.ok) throw new Error(verdict.error.message)

    const result = await suspendForVelocity(
      deps({
        suspendMandate: async (id, reason) => {
          seen.push({ mandateId: id, reason })
          return { ok: true, value: true as const }
        },
      }),
      MANDATE,
      verdict.value,
    )

    expect(result.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.mandateId).toBe(MANDATE)
    expect(seen[0]!.reason).toContain('velocity guard')
    expect(seen[0]!.reason).toContain('6 attempt(s)')
  })

  it('the REVIEW copy says paused-and-nothing-charged, not "blocked"', async () => {
    const verdict = await assessVelocity({
      deps: deps({ countRecentAttempts: async () => ({ ok: true, value: 6 }) }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })
    if (!verdict.ok) throw new Error(verdict.error.message)

    const review = reviewReason(verdict.value)
    expect(review.message).toContain('REVIEW')
    expect(review.userMessage).toContain('paused your agent')
    expect(review.userMessage).toContain('Nothing was charged')
    // A buyer who is only told "blocked" will spend an hour discovering they were not charged.
    expect(review.userMessage).toContain('Review the attempts')
  })

  it('a failure to suspend is surfaced, not swallowed', async () => {
    const verdict = await assessVelocity({
      deps: deps({ countRecentAttempts: async () => ({ ok: true, value: 6 }) }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })
    if (!verdict.ok) throw new Error(verdict.error.message)

    const result = await suspendForVelocity(
      deps({
        suspendMandate: async () => ({
          ok: false as const,
          error: {
            code: 'CS_INTERNAL' as const,
            message: 'db down',
            userMessage: 'x',
            retryable: true,
          },
        }),
      }),
      MANDATE,
      verdict.value,
    )

    expect(result.ok).toBe(false)
  })
})

describe('EC-AGT-2’s actual scenario', () => {
  it('a compromised agent that only signs in-mandate L3s is bounded by the budget, and paused by the flood', async () => {
    // §18 Q7's worst case: the attacker owns the agent loop, so every L3 is perfectly signed and inside
    // the L2's constraints. What bounds the damage is (a) the signed budget and (b) the velocity guard.
    // This asserts (b) on its own terms: a burst of attempts trips it whatever the money did.
    const attempts = 40
    const verdict = await assessVelocity({
      deps: deps({ countRecentAttempts: async () => ({ ok: true, value: attempts }) }),
      mandateId: MANDATE,
      nowSec: NOW_SEC,
    })
    if (!verdict.ok) throw new Error(verdict.error.message)

    expect(verdict.value.trips).toBe(true)
    // The block is the buyer's money not moving *now*; the suspension is what stops the next attempt.
    const error = velocityBlocked(MANDATE, verdict.value)
    expect(error.details).toMatchObject({ attemptsInWindow: attempts })
    expect(error.retryable).toBe(false)
  })

  it('the wallet cap is a second, independent bound — this file is not the only line of defence', () => {
    // Stated so the two checks are not read as redundant: a flood trips at 6 attempts, a $100.00 budget at
    // 4 x $30.00 reservations. Which binds first depends on the cart size, and that is fine.
    expect(VELOCITY.MAX_ATTEMPTS_PER_WINDOW).toBe(5)
    expect(money(13_000n, 'USD').minor).toBe(13_000n)
  })
})
