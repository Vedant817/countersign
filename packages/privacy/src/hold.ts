/**
 * Erasure planning — spec §8.19 M19 ("Erasure: pseudonymise PII and keep crypto hashes. A
 * `PRIVACY_LEGAL_HOLD` applies if an open dispute exists or it is within the evidence window") and
 * EC-PRIV-1.
 *
 * This is deliberately a **pure function of facts the caller supplies**, not a repository call. The
 * question "may this person's data be erased today?" has exactly three inputs — is a dispute open,
 * when was the last capture, and what time is it — and a planner that reached for its own database
 * handle could not be tested against the case that matters most (a dispute that resolves *between*
 * two calls, which is AT-M19.1).
 *
 * **The two holds are different in kind, and the difference is user-visible.**
 *  - An **open dispute** hold has no date. We do not know when the case closes, so the honest answer
 *    is "not yet" and {@link planErasure} says so; promising a date we would then miss is worse than
 *    promising none (EC-PRIV-1's user-facing line is only a date when a window produces one).
 *  - An **evidence-window** hold does have a date: 540 days after the last capture. That one tells
 *    the subject the exact day.
 *
 * **Resolution releases the dispute hold, never the window.** AT-M19.1 says erasure is "blocked by a
 * legal hold, then allowed after resolution". When the case closes, the case-based hold goes; if the
 * capture is still inside its 540-day window, the window hold remains and the answer is still HOLD —
 * with a date instead of an indeterminacy. Deleting inside the window on resolution would destroy
 * exactly the record the window exists to keep, which is the trap this function is written to avoid.
 */
import { csError, err, ok, type CsError, type Result } from '@countersign/core'

import {
  EVIDENCE_WINDOW_DAYS,
  PRE_ERASURE_NOTICE_HOURS,
  SECONDS_PER_DAY,
  retentionRule,
} from './policy'

/** The DPDP Rule 8(2) notice window in seconds. Named so the two uses cannot drift apart. */
const NOTICE_SEC = PRE_ERASURE_NOTICE_HOURS * 3_600

/** The minimum facts about a dispute that decide an erasure. */
export interface OpenDisputeRef {
  readonly disputeId: string
  /** Null when the dispute has not been matched to a Countersign capture yet (R-NOCHAIN-1). */
  readonly captureId: string | null
}

export interface ErasureInput {
  readonly userId: string
  /** Disputes against this user's captures that are **not** in a terminal state. */
  readonly openDisputes: readonly OpenDisputeRef[]
  /** The instant of the user's most recent capture, or `null` if they never bought anything. */
  readonly lastCaptureAtSec: number | null
  readonly nowSec: number
}

export type ErasureAction = 'ERASE' | 'HOLD'

export interface ErasureDecision {
  readonly action: ErasureAction
  /** Present when `action === 'HOLD'`. Goes verbatim into `privacy_requests.legal_hold_reason`. */
  readonly holdReason?: string
  /**
   * The date the subject is told — `privacy_requests.scheduled_for`.
   *
   * Always present, because EC-PRIV-1's user-facing line is *"We'll erase on 2 Jun 2027 because a
   * dispute needs this record"*: a held request that answers "sometime" is not the promised behaviour.
   * When nothing is holding the request this is the end of the 48-hour notice period.
   */
  readonly eraseAfterSec: number
  /**
   * `true` when the date can only move **later**.
   *
   * An open dispute is the one case where the window end is not the answer: the case may still be
   * running when the window closes. The date is still reported — it is the earliest it could legally
   * be — but the subject is told it is provisional, so a moved date is a clarification rather than a
   * broken promise.
   */
  readonly provisional: boolean
  /** What the subject is told. EC-PRIV-1 requires this to name the reason. */
  readonly userMessage: string
}

/** ISO-8601 UTC, date only. Every date in a report to Vedant or a user is UTC until the UI (§0). */
export function isoDate(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10)
}

function validate(input: ErasureInput): Result<ErasureInput, CsError> {
  if (!Number.isInteger(input.nowSec) || input.nowSec < 0) {
    return err(
      csError('CS_VALIDATION', `nowSec must be whole epoch seconds, got ${String(input.nowSec)}`),
    )
  }
  if (
    input.lastCaptureAtSec !== null &&
    (!Number.isInteger(input.lastCaptureAtSec) || input.lastCaptureAtSec < 0)
  ) {
    return err(
      csError(
        'CS_VALIDATION',
        `lastCaptureAtSec must be null or whole epoch seconds, got ${String(input.lastCaptureAtSec)}`,
      ),
    )
  }
  for (const dispute of input.openDisputes) {
    // An empty id would produce `open dispute ` in the reason, which reads like a bug in the notice.
    if (dispute.disputeId.trim() === '') {
      return err(csError('CS_VALIDATION', 'openDisputes[].disputeId must be a non-empty id'))
    }
  }
  return ok(input)
}

/** When the 540-day evidence window on the user's last capture closes, or `null` if it never opened. */
export function evidenceWindowEndsAtSec(lastCaptureAtSec: number | null): number | null {
  if (lastCaptureAtSec === null) return null
  return lastCaptureAtSec + EVIDENCE_WINDOW_DAYS * SECONDS_PER_DAY
}

/**
 * Decide what an erasure request does **today**.
 *
 * Pure: the same inputs always produce the same decision, so AT-M19.1 can call it twice with a
 * changed dispute list and get the two answers the acceptance test names.
 */
export function planErasure(input: ErasureInput): Result<ErasureDecision, CsError> {
  const valid = validate(input)
  if (!valid.ok) return valid

  const { openDisputes, lastCaptureAtSec, nowSec } = input
  const windowEnds = evidenceWindowEndsAtSec(lastCaptureAtSec)
  const noticeFloor = nowSec + NOTICE_SEC

  if (openDisputes.length > 0) {
    const ids = openDisputes.map((d) => d.disputeId).sort()
    // The earliest this could legally run: the later of the notice floor and the evidence window.
    const earliest = windowEnds !== null && windowEnds > noticeFloor ? windowEnds : noticeFloor
    return ok({
      action: 'HOLD',
      holdReason: `open dispute ${ids.join(', ')}`,
      eraseAfterSec: earliest,
      // The case may outlast the window, so this date can only move later.
      provisional: true,
      userMessage:
        `We cannot erase this yet because ${ids.length === 1 ? 'a dispute' : `${ids.length} disputes`} ` +
        `needs the record (${ids.join(', ')}). The earliest we can erase is ${isoDate(earliest)}; ` +
        `if the case is still open then, that date moves and we will tell you.`,
    })
  }

  if (windowEnds !== null && nowSec < windowEnds) {
    return ok({
      action: 'HOLD',
      holdReason: `evidence window until ${isoDate(windowEnds)}`,
      eraseAfterSec: windowEnds,
      // No dispute is open and the window end is arithmetic, so this date is final.
      provisional: false,
      userMessage: `We will erase this on ${isoDate(windowEnds)} because a purchase record inside the evidence window is still needed.`,
    })
  }

  // Proceed. The 48-hour notice is not a hold — the subject asked for this — but it is a floor on
  // how *fast* the purge may run, so the request cannot be satisfied in the same breath as it arrives
  // (DPDP Rule 8(2), §12.13).
  const noticeRule = retentionRule('ACCOUNT_AND_WALLET')
  return ok({
    action: 'ERASE',
    eraseAfterSec: nowSec + NOTICE_SEC,
    provisional: false,
    userMessage:
      `We will erase this on ${isoDate(nowSec + NOTICE_SEC)}. ` +
      `${noticeRule.onErasure}. Raw log lines are kept until their own retention date but are PII-redacted at write time.`,
  })
}

/** The `CsError` an HTTP boundary returns when a held request is attempted. */
export function legalHoldError(decision: ErasureDecision): CsError {
  return csError(
    'PRIVACY_LEGAL_HOLD',
    decision.holdReason ?? 'Erasure is on legal hold.',
    undefined,
    {
      userMessage: decision.userMessage,
      retryable: false,
    },
  )
}
