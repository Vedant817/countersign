/**
 * `gate_decisions` repository — spec §7.2, §8.10 (`packages/gate`, WP-10).
 *
 * **This table is append-only and immutable** (§7.2). There is no update function here and there
 * should never be one. The reason is not tidiness: a Gate decision record is the artefact a dispute
 * is fought over, and it is signed (`signed_record`, a JWS by `GATE_KID`). An updatable decision is a
 * decision nobody can rely on — "the Gate said ALLOW, and then someone edited it to BLOCK" would make
 * every verdict meaningless. If the Gate re-runs, it writes a new row.
 *
 * The same immutability is why `reasons` and `checks` are JSON arrays rather than a single
 * "reason_code" column: all twelve checks run even after one fails (§8.10), so a buyer is told
 * everything that was wrong, not just the first thing.
 */
import { desc, eq } from 'drizzle-orm'

import type { AttemptId, CsError, GateDecisionId, Result } from '@countersign/core'

import { db, type Exec } from '../client'
import { gateDecisions, type GateDecisionRow, type NewGateDecision } from '../schema'
import { repo } from './index'

/** Spec §8.10: ALLOW only if every check passed; REVIEW when the velocity guard trips. */
export type GateDecisionOutcome = 'ALLOW' | 'BLOCK' | 'REVIEW'

/** One Gate check, in the order the Gate ran them. */
export interface GateCheck {
  readonly n: number
  readonly code: string
  readonly passed: boolean
  readonly detail?: string
}

/** Why the Gate decided what it decided. `code` is always a registry code from §8.1. */
export interface GateReason {
  readonly code: string
  readonly message: string
  readonly userMessage: string
}

export function createGateDecision(
  input: NewGateDecision,
  exec?: Exec,
): Promise<Result<GateDecisionRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(gateDecisions).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no gate_decisions row')
      return row as GateDecisionRow
    },
    { table: 'gate_decisions', id: input.id, attemptId: input.attempt_id },
  )
}

export function findGateDecisionById(
  id: GateDecisionId,
  exec?: Exec,
): Promise<Result<GateDecisionRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(gateDecisions)
        .where(eq(gateDecisions.id, id))
        .limit(1)
      return rows[0] as GateDecisionRow | undefined
    },
    { table: 'gate_decisions', id },
  )
}

/**
 * The decision for an attempt. `limit(1)` with a descending `decided_at` because a re-run produces a
 * second row and the *latest* one is the operative answer — while every earlier row stays as history.
 */
export function findLatestDecisionForAttempt(
  attemptId: AttemptId,
  exec?: Exec,
): Promise<Result<GateDecisionRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(gateDecisions)
        .where(eq(gateDecisions.attempt_id, attemptId))
        .orderBy(desc(gateDecisions.decided_at))
        .limit(1)
      return rows[0] as GateDecisionRow | undefined
    },
    { table: 'gate_decisions', attemptId },
  )
}

/** Every decision for an attempt, newest first — the attempt detail page and the evidence bundle. */
export function listDecisionsForAttempt(
  attemptId: AttemptId,
  exec?: Exec,
): Promise<Result<GateDecisionRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(gateDecisions)
        .where(eq(gateDecisions.attempt_id, attemptId))
        .orderBy(desc(gateDecisions.decided_at))
      return rows as GateDecisionRow[]
    },
    { table: 'gate_decisions', attemptId },
  )
}

/**
 * The merchant's decision log (S-14). Filterable by outcome; the demo shows BLOCKs prominently
 * because that is the product story.
 */
export function listDecisions(
  filter: { decision?: GateDecisionOutcome; limit?: number },
  exec?: Exec,
): Promise<Result<GateDecisionRow[], CsError>> {
  return repo(
    async () => {
      const query = (exec ?? db()).select().from(gateDecisions)
      const rows = filter.decision
        ? await query
            .where(eq(gateDecisions.decision, filter.decision))
            .orderBy(desc(gateDecisions.decided_at))
            .limit(filter.limit ?? 100)
        : await query.orderBy(desc(gateDecisions.decided_at)).limit(filter.limit ?? 100)
      return rows as GateDecisionRow[]
    },
    { table: 'gate_decisions', filter },
  )
}

/**
 * The decision as the §8.10 `GateDecision` interface wants it: the reasons and checks parsed back out
 * of their JSON columns.
 *
 * Returns `undefined` rather than throwing on malformed JSON: a `raw` column that a hand-edited row
 * ruined is an operator problem, and the merchant log should still render the rest of the row.
 */
export function readDecision(row: GateDecisionRow):
  | {
      decision: GateDecisionOutcome
      reasons: GateReason[]
      checks: GateCheck[]
    }
  | undefined {
  const reasons = parseArray<GateReason>(row.reasons)
  const checks = parseArray<GateCheck>(row.checks)
  if (!reasons || !checks) return undefined
  return { decision: row.decision, reasons, checks }
}

function parseArray<T>(value: unknown): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value as T[]
}
