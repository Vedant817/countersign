/**
 * `checkout_attempts` repository — spec §7.2, **EC-IDEM-1**, §8.10 check 7 (`GATE_REPLAY`).
 *
 * This table is the replay boundary for the whole system. Two unique indexes do the work:
 *
 *  - `checkout_attempts_l3_jti_key` on `l3_jti`. The agent's LLM can retry a turn and re-submit the
 *    same signed L3; the second insert hits the index and returns `GATE_REPLAY`, so a duplicate
 *    submission is a *blocked* attempt rather than a second charge.
 *  - `checkout_attempts_idempotency_key_key` on `idempotency_key`. The HTTP-level equivalent, so a
 *    double-clicked submit is one row (AT-M2.4 maps both to `CS_CONFLICT`).
 *
 * Both are enforced by Postgres, not by a read-then-write check. A read-then-write has a window between
 * the SELECT and the INSERT in which two identical submissions both see "not present" — and that
 * window is exactly what an automated retrier is good at finding.
 */
import { and, desc, eq, sql } from 'drizzle-orm'

import type { AttemptId, CheckoutId, CsError, MandateId, Result } from '@countersign/core'

import { db, type Exec } from '../client'
import { checkoutAttempts, type CheckoutAttemptRow, type NewCheckoutAttempt } from '../schema'
import { err, repo } from './index'

/** Spec §3.3 "Checkout attempt", verbatim. */
export type CheckoutAttemptState =
  | 'CREATED'
  | 'GATED_ALLOW'
  | 'GATED_BLOCK'
  | 'ORDER_CREATED'
  | 'AUTHORIZED'
  | 'PARTIALLY_CAPTURED'
  | 'CAPTURED'
  | 'VOIDED'
  | 'AUTH_EXPIRED'
  | 'DECLINED'
  | 'PENDING_REVIEW'

export function createAttempt(
  input: NewCheckoutAttempt,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(checkoutAttempts).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no checkout_attempts row')
      return row as CheckoutAttemptRow
    },
    { table: 'checkout_attempts', id: input.id, l3Jti: input.l3_jti },
  )
}

export function findAttemptById(
  id: AttemptId,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(checkoutAttempts)
        .where(eq(checkoutAttempts.id, id))
        .limit(1)
      return rows[0] as CheckoutAttemptRow | undefined
    },
    { table: 'checkout_attempts', id },
  )
}

export async function requireAttempt(
  id: AttemptId,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow, CsError>> {
  const found = await findAttemptById(id, exec)
  if (!found.ok) return found
  const attempt = found.value
  if (!attempt) {
    return err({
      code: 'CS_NOT_FOUND',
      message: `No checkout_attempts row for ${id}`,
      userMessage: 'We could not find that attempt.',
      retryable: false,
      details: { table: 'checkout_attempts', id },
    })
  }
  return { ok: true, value: attempt }
}

/**
 * EC-IDEM-1, first half: has this exact L3 already been used?
 *
 * The Gate calls this as a *pre-check* so it can report `GATE_REPLAY` (a meaningful refusal the agent
 * can act on) instead of `CS_CONFLICT` from the insert. The insert remains the authority: the
 * pre-check is an optimisation for the message, and a race between it and the insert is still caught.
 */
export function findAttemptByL3Jti(
  l3Jti: string,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(checkoutAttempts)
        .where(eq(checkoutAttempts.l3_jti, l3Jti))
        .limit(1)
      return rows[0] as CheckoutAttemptRow | undefined
    },
    { table: 'checkout_attempts', l3Jti },
  )
}

/** EC-IDEM-1, second half: "the same `checkout_id` + `mandate_id` returns the existing attempt". */
export function findAttemptByCheckoutAndMandate(
  checkoutSessionId: CheckoutId,
  mandateId: MandateId,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(checkoutAttempts)
        .where(
          and(
            eq(checkoutAttempts.checkout_session_id, checkoutSessionId),
            eq(checkoutAttempts.mandate_id, mandateId),
          ),
        )
        .orderBy(desc(checkoutAttempts.created_at))
        .limit(1)
      return rows[0] as CheckoutAttemptRow | undefined
    },
    { table: 'checkout_attempts', checkoutSessionId, mandateId },
  )
}

export function findAttemptByIdempotencyKey(
  idempotencyKey: string,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(checkoutAttempts)
        .where(eq(checkoutAttempts.idempotency_key, idempotencyKey))
        .limit(1)
      return rows[0] as CheckoutAttemptRow | undefined
    },
    { table: 'checkout_attempts', idempotencyKey },
  )
}

/**
 * Move an attempt along §3.3.
 *
 * The Gate writes `GATED_ALLOW`/`GATED_BLOCK` and the orchestrator writes everything after
 * `ORDER_CREATED`. Terminal states (`CAPTURED`, `VOIDED`, `DECLINED`, `AUTH_EXPIRED`) refuse further
 * movement, which is what stops a late webhook from moving a completed attempt backwards
 * (EC-WH-3's "never downgrade").
 */
export function setAttemptState(
  id: AttemptId,
  state: CheckoutAttemptState,
  at: Date,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(checkoutAttempts)
        .set({ state, updated_at: at })
        .where(eq(checkoutAttempts.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No checkout_attempts row for ${id}`)
      return row as CheckoutAttemptRow
    },
    { table: 'checkout_attempts', id, state },
  )
}

/** Link the attempt to the Gate decision that ruled on it (written by `repos/gate.ts`). */
export function linkGateDecision(
  id: AttemptId,
  gateDecisionId: string,
  at: Date,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(checkoutAttempts)
        .set({ gate_decision_id: gateDecisionId, updated_at: at })
        .where(eq(checkoutAttempts.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No checkout_attempts row for ${id}`)
      return row as CheckoutAttemptRow
    },
    { table: 'checkout_attempts', id, gateDecisionId },
  )
}

/**
 * Gate check 12, velocity guard: "more than 5 attempts per mandate in 10 minutes".
 *
 * Counted from `created_at`, which is the attempt's own timestamp rather than a separate
 * rate-limit table — the number we want *is* the number of attempts.
 */
export function countRecentAttempts(
  mandateId: MandateId,
  since: Date,
  exec?: Exec,
): Promise<Result<number, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select({ id: checkoutAttempts.id })
        .from(checkoutAttempts)
        .where(
          and(
            eq(checkoutAttempts.mandate_id, mandateId),
            // `.toISOString()` is not decoration: drizzle's `sql` template cannot serialise a `Date`
            // parameter (it throws `ERR_INVALID_ARG_TYPE` from `Buffer.from`), and Postgres parses the
            // ISO-8601 string into `timestamptz` from the comparison's context. See
            // docs/contract-issues.md #10.
            sql`${checkoutAttempts.created_at} >= ${since.toISOString()}`,
          ),
        )
      return rows.length
    },
    { table: 'checkout_attempts', mandateId, op: 'count_recent' },
  )
}

/** Gate check 12: "more than 3 BLOCKs in a row" — the newest attempts for one mandate, newest first. */
export function listAttemptsForMandate(
  mandateId: MandateId,
  limit: number,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(checkoutAttempts)
        .where(eq(checkoutAttempts.mandate_id, mandateId))
        .orderBy(desc(checkoutAttempts.created_at))
        .limit(limit)
      return rows as CheckoutAttemptRow[]
    },
    { table: 'checkout_attempts', mandateId, limit },
  )
}

export function listAttemptsForCheckout(
  checkoutSessionId: CheckoutId,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(checkoutAttempts)
        .where(eq(checkoutAttempts.checkout_session_id, checkoutSessionId))
        .orderBy(desc(checkoutAttempts.created_at))
      return rows as CheckoutAttemptRow[]
    },
    { table: 'checkout_attempts', checkoutSessionId },
  )
}

/**
 * Reservations older than 30 min with no order yet (§8.10: "Reservations expire after 30 min without
 * an order (a worker job releases them)").
 *
 * The age filter is on `checkout_attempts.created_at`, matched to `budget_entries.at` written in the
 * same transaction, so a sweep releases exactly the attempts it means to release.
 */
export function findStaleAttempts(
  olderThan: Date,
  exec?: Exec,
): Promise<Result<CheckoutAttemptRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(checkoutAttempts)
        .where(
          and(
            sql`${checkoutAttempts.created_at} < ${olderThan.toISOString()}`,
            sql`${checkoutAttempts.state} in ('GATED_ALLOW','CREATED')`,
          ),
        )
      return rows as CheckoutAttemptRow[]
    },
    { table: 'checkout_attempts', op: 'find_stale' },
  )
}
