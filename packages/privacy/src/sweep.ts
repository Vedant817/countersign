/**
 * The retention sweep, as a plan — spec §8.19 ("retention jobs per §12.13").
 *
 * This module decides **what a purge would delete**; it does not delete anything. That split is the
 * point. A job that walks a table and deletes rows past a date is six lines long and is the single
 * most destructive thing in the repository, so the arithmetic lives here where it can be read,
 * reviewed and tested against the clock faults that turn "delete yesterday's logs" into "delete
 * everything":
 *
 *  - **A clock in the past deletes the future.** If `nowSec` is wrong — a container with no RTC, a
 *    timezone applied to epoch seconds, a test that forgot to inject a clock — every row looks
 *    overdue. {@link planSweep} refuses a `nowSec` earlier than {@link EARLIEST_PLAUSIBLE_SEC}
 *    outright rather than planning a purge nobody meant.
 *  - **A clock far in the future deletes everything.** Caught by the same floor: the sweep is bounded
 *    to rows whose deadline has passed *and* which are not implausibly old, so a runaway clock
 *    produces a smaller plan, not a bigger one.
 *  - **A unknown class is not a no-op.** An unrecognised `class` fails the whole plan. Skipping it
 *    would leave rows that the policy page claims are being purged, and nobody would notice.
 *
 * The caller executes the result with an `id`-scoped delete per class, and is expected to run it in
 * dry-run first. Nothing here holds a database handle, so nothing here can surprise you at import.
 */
import { csError, err, ok, type CsError, type Result } from '@countersign/core'

import { RETENTION_POLICY, retentionDeadline, type RetentionClassId } from './policy'

/**
 * 2026-01-01T00:00:00Z.
 *
 * A sweep running before the project existed is a clock fault, not a quiet day. Refusing early is
 * cheap and the failure mode it prevents is unrecoverable.
 */
export const EARLIEST_PLAUSIBLE_SEC = Date.UTC(2026, 0, 1) / 1000

export interface SweepCandidate {
  readonly class: RetentionClassId
  /** Primary key of the row, as a string. Opaque here; the caller owns the tables. */
  readonly id: string
  /** The instant the class counts from — §12.13's "processing" or "last capture". */
  readonly processedAtSec: number
}

export interface PurgeItem {
  readonly class: RetentionClassId
  readonly id: string
  /** The deadline that has passed. Kept in the plan so a log line can say *why* this row went. */
  readonly deadlineSec: number
}

export interface KeptItem {
  readonly class: RetentionClassId
  readonly id: string
  /** When it will become purgeable. */
  readonly deadlineSec: number
}

export interface SweepPlan {
  readonly nowSec: number
  readonly purge: readonly PurgeItem[]
  readonly keep: readonly KeptItem[]
  /** Per-class counts, so a dry run reads at a glance. */
  readonly byClass: Readonly<Record<string, { purge: number; keep: number }>>
}

/** Classes with no timer are never swept: only the subject's own request ends them (§12.13). */
export function sweepableClasses(): readonly RetentionClassId[] {
  return RETENTION_POLICY.filter((rule) => rule.days !== null).map((rule) => rule.id)
}

/**
 * Decide which rows a purge may delete at `nowSec`.
 *
 * Deterministic and order-preserving: the same batch always yields the same plan, so a dry run and
 * the run that follows it agree.
 */
export function planSweep(
  candidates: readonly SweepCandidate[],
  nowSec: number,
): Result<SweepPlan, CsError> {
  if (!Number.isInteger(nowSec) || nowSec < 0) {
    return err(
      csError('CS_VALIDATION', `planSweep needs whole epoch seconds, got ${String(nowSec)}`),
    )
  }
  if (nowSec < EARLIEST_PLAUSIBLE_SEC) {
    return err(
      csError(
        'CS_VALIDATION',
        `Refusing to plan a purge at ${new Date(nowSec * 1000).toISOString()} — the clock is before ` +
          `Countersign existed, so every row would look overdue. Check the clock, not the data.`,
        { nowSec, earliestPlausibleSec: EARLIEST_PLAUSIBLE_SEC },
      ),
    )
  }

  const purge: PurgeItem[] = []
  const keep: KeptItem[] = []
  const byClass: Record<string, { purge: number; keep: number }> = {}

  for (const candidate of candidates) {
    const deadline = retentionDeadline(candidate.class, candidate.processedAtSec)
    if (!deadline.ok) {
      // A timer-less class in a sweep batch is a caller bug: the row it names is deleted only when
      // its subject asks, and silently keeping it would hide the mistake.
      return err(
        csError(
          'CS_VALIDATION',
          `${candidate.class} has no retention deadline, so row ${candidate.id} cannot be swept`,
          { retentionClass: candidate.class, id: candidate.id },
        ),
      )
    }

    const bucket = (byClass[candidate.class] ??= { purge: 0, keep: 0 })
    if (nowSec >= deadline.value) {
      purge.push({ class: candidate.class, id: candidate.id, deadlineSec: deadline.value })
      bucket.purge += 1
    } else {
      keep.push({ class: candidate.class, id: candidate.id, deadlineSec: deadline.value })
      bucket.keep += 1
    }
  }

  return ok({ nowSec, purge, keep, byClass })
}

/**
 * One line per class for a job log, so an operator reading the sweep's output sees the shape of what
 * it did without parsing JSON.
 */
export function describeSweep(plan: SweepPlan): string {
  const parts = Object.entries(plan.byClass)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, counts]) => `${id}: ${counts.purge} purged, ${counts.keep} kept`)
  return parts.length === 0 ? 'nothing to sweep' : parts.join(' · ')
}
