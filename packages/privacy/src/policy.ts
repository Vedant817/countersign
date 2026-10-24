/**
 * The §12.13 retention schedule, as data — WP-19, M19.
 *
 * The spec's retention table is the contract; this file is its executable copy. Keeping it as data
 * rather than as an `if` chain in a nightly job means the table the privacy page shows, the window
 * the erasure planner applies and the deadline the purge job enforces are all the same numbers.
 *
 * Three of these windows are load-bearing:
 *  - **540 days on mandates/evidence** is `PayPal's dispute windows + the 1-year log floor`, so a
 *    packet filed late still has its source rows;
 *  - **365 days on operational logs** is a *minimum* imposed by DPDP Rule 8(3) [B17] — it is a floor,
 *    not a target, and an erasure request may not shorten it; and
 *  - **48 hours of pre-erasure notice** is DPDP Rule 8(2) practice that §12.13 adopts voluntarily.
 *
 * All times are UTC epoch seconds at the boundary (AGENTS.md rule 10); `timestamptz` in the database
 * and IST only in the UI.
 */
import { csError, err, ok, type CsError, type Result } from '@countersign/core'

export const SECONDS_PER_DAY = 86_400

/** Mandates, L1/L2/L3, gate decisions and evidence packets. §12.13. */
export const EVIDENCE_WINDOW_DAYS = 540

/** DPDP Rule 8(3) [B17] minimum log retention. */
export const LOG_RETENTION_DAYS = 365

/** LLM prompts/outputs: 30 days, then hashes only. §12.13. */
export const LLM_RETENTION_DAYS = 30

/** Webhook raw payloads: ops only. §12.13. */
export const WEBHOOK_RETENTION_DAYS = 90

/** DPDP Rule 8(2) [B17] pre-erasure notice, adopted voluntarily (§12.13). */
export const PRE_ERASURE_NOTICE_HOURS = 48

export type RetentionClassId =
  | 'ACCOUNT_AND_WALLET'
  | 'MANDATES_AND_DECISIONS'
  | 'EVIDENCE_PACKETS'
  | 'OPERATIONAL_LOGS'
  | 'LLM_PROMPTS'
  | 'WEBHOOK_PAYLOADS'

export interface RetentionRule {
  readonly id: RetentionClassId
  /** The `Data` cell of §12.13, verbatim, so the page and the code cannot drift silently. */
  readonly data: string
  /** Days from the reference instant, or `null` for "until account deletion". */
  readonly days: number | null
  /** The `Basis` cell of §12.13. */
  readonly basis: string
  /** The `On erasure request` cell of §12.13. */
  readonly onErasure: string
  /** `true` when the window is a **floor**: an erasure request cannot shorten it. */
  readonly floor: boolean
}

export const RETENTION_POLICY: readonly RetentionRule[] = Object.freeze([
  {
    id: 'ACCOUNT_AND_WALLET',
    data: 'Account, wallet linkage (vault id, payer id, email)',
    days: null,
    basis: 'Contract',
    onErasure: 'Delete the vault token at PayPal; pseudonymise the row',
    floor: false,
  },
  {
    id: 'MANDATES_AND_DECISIONS',
    data: 'Mandates, L1/L2/L3, gate decisions',
    days: EVIDENCE_WINDOW_DAYS,
    basis: 'Legitimate interest / legal claims',
    onErasure:
      'Legal hold if within the window or a dispute is open; otherwise delete tokens and keep only hashes',
    floor: false,
  },
  {
    id: 'EVIDENCE_PACKETS',
    data: 'Evidence packets',
    days: EVIDENCE_WINDOW_DAYS,
    basis: 'Legal claims (GDPR 17(3)(e))',
    onErasure: 'Hold, then delete',
    floor: false,
  },
  {
    id: 'OPERATIONAL_LOGS',
    data: 'Operational logs',
    days: LOG_RETENTION_DAYS,
    basis: 'Legal obligation (DPDP Rule 8(3))',
    onErasure: 'Not erasable before 365 days; PII-redacted at write time',
    floor: true,
  },
  {
    id: 'LLM_PROMPTS',
    data: 'LLM prompts/outputs',
    days: LLM_RETENTION_DAYS,
    basis: 'Debugging',
    onErasure: 'Delete',
    floor: false,
  },
  {
    id: 'WEBHOOK_PAYLOADS',
    data: 'Webhook raw payloads',
    days: WEBHOOK_RETENTION_DAYS,
    basis: 'Ops',
    onErasure: 'Delete',
    floor: false,
  },
] satisfies readonly RetentionRule[])

const BY_ID: ReadonlyMap<string, RetentionRule> = new Map(
  RETENTION_POLICY.map((rule) => [rule.id as string, rule]),
)

/**
 * Look up one rule.
 *
 * Throws rather than returning `undefined`: every caller is passing a compile-time `RetentionClassId`
 * or a value that came out of our own job payload, and a silent `undefined` here would turn "keep
 * this for 540 days" into "purge it now" the first time a class is renamed.
 */
export function retentionRule(id: RetentionClassId): RetentionRule {
  const rule = BY_ID.get(id)
  if (rule === undefined) {
    throw new Error(`No retention rule for "${String(id)}" (spec §12.13)`)
  }
  return rule
}

/**
 * When a row of `id` processed at `processedAtSec` becomes purgeable.
 *
 * Classes with no timer (`ACCOUNT_AND_WALLET`) return `CS_VALIDATION` rather than `Infinity`: the
 * account row is deleted because the subject asked, never because a date passed, and a number here
 * would invite a schedule nobody chose.
 */
export function retentionDeadline(
  id: RetentionClassId,
  processedAtSec: number,
): Result<number, CsError> {
  if (!Number.isInteger(processedAtSec) || processedAtSec < 0) {
    return err(
      csError(
        'CS_VALIDATION',
        `retentionDeadline needs whole epoch seconds, got ${String(processedAtSec)}`,
      ),
    )
  }
  const rule = retentionRule(id)
  if (rule.days === null) {
    return err(
      csError(
        'CS_VALIDATION',
        `${id} has no retention deadline; it ends when the subject asks, not on a timer`,
        { retentionClass: id, onErasure: rule.onErasure },
      ),
    )
  }
  return ok(processedAtSec + rule.days * SECONDS_PER_DAY)
}

/** True while a row of `id` is still inside its window at `nowSec`. */
export function withinRetention(
  id: RetentionClassId,
  processedAtSec: number,
  nowSec: number,
): boolean {
  const deadline = retentionDeadline(id, processedAtSec)
  // "No timer" is not "expired": only the subject's own request ends it.
  if (!deadline.ok) return true
  return nowSec < deadline.value
}
