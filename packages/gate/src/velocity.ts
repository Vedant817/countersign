/**
 * Gate check 12 — the velocity guard. Spec **§8.10 row 12**, §12 **EC-AGT-1** / **EC-AGT-2**.
 *
 * ## Why this check is the one most likely to be written wrongly
 *
 * It is the only check whose failure has a **side effect**: it moves the mandate to `SUSPENDED`. And it
 * is the only check that must run *even when an earlier check already failed* — because the pattern it
 * exists to detect is a flood of BLOCKs. A Gate that short-circuits after check 1 can never see the
 * fourth consecutive BLOCK, so the suspension it promises in EC-AGT-2 would never happen and a
 * compromised agent (§18 Q7: the attacker owns the agent loop entirely) would keep trying forever,
 * unpunished and unremarked.
 *
 * So `evaluate` runs this check unconditionally, and the two rules are independent:
 *
 * | Rule | Spec | Answered by |
 * |---|---|---|
 * | > 5 attempts for one mandate in 10 min | §8.10 row 12 | `countRecentAttempts` |
 * | > 3 BLOCKs in a row | §8.10 row 12, EC-AGT-2 | `listAttemptsForMandate(…, 3)` |
 *
 * ## Off-by-one, stated explicitly because it is the whole test
 *
 * "**more than** 5" and "**more than** 3", so:
 *
 * - 5 attempts in the window → **passes**. The 6th trips it.
 * - 3 consecutive BLOCKs → **passes**. The 4th trips it.
 *
 * Getting this wrong in the *lenient* direction lets an agent hammer a mandate; getting it wrong in the
 * *strict* direction suspends a buyer who made five purchases in ten minutes, which is a normal human
 * shopping pattern. The constants are named, exported, and asserted in `test/velocity.test.ts`.
 */

import { csError, type CsError, type MandateId, type Result } from '@countersign/core'

import { VELOCITY, type AttemptState, type GateDeps, type VelocityVerdict } from './types'

/** States that count as "this attempt was blocked". `GATED_BLOCK` is the one the Gate writes. */
const BLOCKED: ReadonlySet<AttemptState> = new Set<AttemptState>(['GATED_BLOCK'])

/**
 * Count the leading run of BLOCKs in a newest-first list.
 *
 * Stops at the first non-BLOCK, which is what "in a row" means: `BLOCK, ALLOW, BLOCK, BLOCK` is a
 * streak of 2, not 3. A count of *all* blocks in recent history would suspend a mandate for a
 * scattered pattern that is evidence of nothing.
 */
export function consecutiveBlocks(states: readonly AttemptState[]): number {
  let n = 0
  for (const state of states) {
    if (!BLOCKED.has(state)) break
    n += 1
  }
  return n
}

export interface VelocityInput {
  readonly deps: GateDeps
  readonly mandateId: MandateId
  /** The one instant. Same value as every other check. */
  readonly nowSec: number
}

/**
 * Read both counters and decide whether the guard trips.
 *
 * `listAttemptsForMandate(mandateId, VELOCITY.MAX_CONSECUTIVE_BLOCKS)` asks for exactly three: four
 * would be one more than the rule can distinguish from, and a hundred would put every previous
 * attempt's L3 in memory for a question that needs three rows.
 */
export async function assessVelocity(
  input: VelocityInput,
): Promise<Result<VelocityVerdict, CsError>> {
  const since = new Date((input.nowSec - VELOCITY.WINDOW_SECONDS) * 1000)

  const attempts = await input.deps.countRecentAttempts(input.mandateId, since)
  if (!attempts.ok) return attempts

  // `MAX_CONSECUTIVE_BLOCKS + 1`, not `MAX_CONSECUTIVE_BLOCKS`. The rule is "**more than** 3", so three
  // BLOCKs is a pass and only the *fourth* trips it — which means the query has to be able to see a
  // fourth. Asking for exactly 3 would cap the count at 3 and make the rule unreachable: a permanently
  // dead branch that reads correct. One extra row is the whole difference between a working guard and a
  // decoration.
  const states = await input.deps.recentAttemptStates(
    input.mandateId,
    VELOCITY.MAX_CONSECUTIVE_BLOCKS + 1,
  )
  if (!states.ok) return states

  const attemptsInWindow = attempts.value
  const blocks = consecutiveBlocks(states.value)

  const tooManyAttempts = attemptsInWindow > VELOCITY.MAX_ATTEMPTS_PER_WINDOW
  const tooManyBlocks = blocks > VELOCITY.MAX_CONSECUTIVE_BLOCKS
  const trips = tooManyAttempts || tooManyBlocks

  const detail = trips
    ? `${attemptsInWindow} attempt(s) in ${VELOCITY.WINDOW_SECONDS / 60} min (limit ${VELOCITY.MAX_ATTEMPTS_PER_WINDOW}), ` +
      `${blocks} consecutive block(s) (limit ${VELOCITY.MAX_CONSECUTIVE_BLOCKS})`
    : `${attemptsInWindow} attempt(s) in window, ${blocks} consecutive block(s)`

  return {
    ok: true,
    value: {
      attemptsInWindow,
      consecutiveBlocks: blocks,
      tooManyAttempts,
      tooManyBlocks,
      trips,
      detail,
    },
  }
}

/**
 * The failure check 12 reports: `GATE_BLOCKED`.
 *
 * `GATE_BLOCKED` and not `GATE_AGENT_SUSPENDED` because the code describes *what happened* — this
 * purchase is blocked — while the suspension is the *consequence*, and it is visible in the mandate row
 * and in the `REVIEW` outcome. `GATE_BLOCKED`'s registry copy is the one a buyer can act on ("the reasons
 * are listed for you"), and EC-AGT-1's demo line is the push the buyer gets.
 */
export function velocityBlocked(mandateId: MandateId, verdict: VelocityVerdict): CsError {
  return csError(
    'GATE_BLOCKED',
    `Velocity guard tripped for ${mandateId}: ${verdict.detail}`,
    {
      mandateId,
      attemptsInWindow: verdict.attemptsInWindow,
      consecutiveBlocks: verdict.consecutiveBlocks,
      tooManyAttempts: verdict.tooManyAttempts,
      tooManyBlocks: verdict.tooManyBlocks,
    },
    {
      userMessage:
        'Your agent tried this purchase too many times in a row, so the merchant paused it and asked you to take a look. ' +
        'Nothing was charged.',
    },
  )
}

/**
 * Move the mandate to `SUSPENDED`. **§12 EC-AGT-2**: "push/email (stub) 'Your agent was suspended after
 * 3 blocked attempts'".
 *
 * A suspension is reversible (`SUSPENDED` returns to `ACTIVE` in §3.3's state machine) and it is *not*
 * a revocation: nothing is deleted, and every reservation already taken stays on the ledger. Suspending
 * rather than revoking is the conservative choice — a burst of BLOCKs is much more often a confused
 * agent or an injection than a compromised key, and an irreversible action taken on a signal that can
 * fire on a legitimate user is the worse error.
 */
export async function suspendForVelocity(
  deps: GateDeps,
  mandateId: MandateId,
  verdict: VelocityVerdict,
): Promise<Result<true, CsError>> {
  const reason = `velocity guard: ${verdict.detail}`
  const suspended = await deps.suspendMandate(mandateId, reason)
  if (!suspended.ok) return suspended
  return { ok: true, value: true }
}

/**
 * The `REVIEW` reason appended alongside `GATE_BLOCKED`.
 *
 * REVIEW means *a human needs to look*, and the honest copy says so: the agent was paused, the reasons
 * are listed, and nothing was charged. Saying only "blocked" would make a paused mandate look like a
 * spent cap, and the buyer would spend an hour discovering they had not been charged.
 */
export function reviewReason(verdict: VelocityVerdict): { message: string; userMessage: string } {
  return {
    message: `Decision escalated to REVIEW: ${verdict.detail}. Mandate suspended for a human to confirm.`,
    userMessage:
      'We paused this purchase and paused your agent, because it tried the same thing too many times. ' +
      'Nothing was charged. Review the attempts and resume the mandate whenever you like.',
  }
}
