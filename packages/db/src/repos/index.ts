/**
 * Repository plumbing — spec **§8.2 (M2)**.
 *
 * Every repository in this folder follows the same three rules, and this file is where rules 1 and 2
 * live so they cannot drift per aggregate:
 *
 *  1. **A repo returns `Result<T, CsError>`; it never throws across the boundary** (AGENTS.md rule 3).
 *     {@link repo} is the single wrapper that turns any escape into a typed error.
 *  2. **A repo takes an optional executor as its last argument.** Pass the `tx` from
 *     `client.withTx` to make several repos atomic. Spec §8.10 checks 8 and 9 have to commit or
 *     roll back together — a budget reservation without its `checkout_attempts` row (or the reverse)
 *     is exactly the state that lets a buyer's money be spent with no trace of why.
 *  3. **Postgres `23505` (unique_violation) becomes `CS_CONFLICT`** — AT-M2.4. Every unique index
 *     in the schema is an idempotency or replay defence (`l3_jti`, `idempotency_key`,
 *     `paypal_event_id`, `paypal_order_id`, `attempt_id`), so a violation is never an internal bug
 *     to be swallowed: it is a duplicate request the caller should be told about idempotently.
 *
 * This file also re-exports every repository, so `@countersign/db/repos` is the single import
 * surface for the rest of the monorepo.
 */
import {
  err,
  ok,
  toCsError,
  type Clock,
  type CsError,
  type CsErrorCode,
  type Currency,
  type Money,
  type Result,
} from '@countersign/core'
import { systemClock } from '@countersign/core'

/* ------------------------------------------------------------------------------------------ */
/* Postgres error mapping                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** Postgres SQLSTATE codes this package reacts to. */
export const PG = {
  /** unique_violation — a replay or a duplicate request. AT-M2.4. */
  UNIQUE_VIOLATION: '23505',
  /** foreign_key_violation — a referenced row does not exist. */
  FOREIGN_KEY_VIOLATION: '23503',
  /** check_violation — an invariant in the schema rejected the write. */
  CHECK_VIOLATION: '23514',
  /** not_null_violation. */
  NOT_NULL_VIOLATION: '23502',
  /** serialization_failure and deadlock_detected: retry the whole transaction. */
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const

/**
 * A Postgres error as it arrives through the `postgres` driver: `code` is the SQLSTATE, and
 * `constraint` names the index or CHECK that fired. Both are on the prototype chain of `Error`
 * subclasses, so they are read defensively rather than cast.
 */
interface PgErrorLike {
  code?: unknown
  constraint?: unknown
  table?: unknown
  detail?: unknown
  message?: unknown
}

function asPgErrorLike(cause: unknown): PgErrorLike | null {
  return typeof cause === 'object' && cause !== null ? (cause as PgErrorLike) : null
}

/** The SQLSTATE of `cause`, if it came from Postgres. `undefined` for anything else. */
export function pgErrorCode(cause: unknown): string | undefined {
  const code = asPgErrorLike(cause)?.code
  return typeof code === 'string' ? code : undefined
}

/** `true` when `cause` is Postgres's unique_violation — the AT-M2.4 replay/duplicate signal. */
export function isUniqueViolation(cause: unknown): boolean {
  return pgErrorCode(cause) === PG.UNIQUE_VIOLATION
}

/** The constraint or index name Postgres reported, when there was one. */
export function pgConstraintName(cause: unknown): string | undefined {
  const c = asPgErrorLike(cause)?.constraint
  return typeof c === 'string' && c.length > 0 ? c : undefined
}

/**
 * SQLSTATE → `CsError.code` for the violations that carry meaning rather than just noise.
 *
 * `budget_accounts_reserved_plus_spent_le_cap` maps to `GATE_BUDGET_EXCEEDED` on purpose: the CHECK
 * is the backstop behind Gate check 8, so reaching it means the same thing to the buyer as the Gate
 * blocking would — "this purchase would take you past the limit you signed" — and the UI can render
 * it with the registry's existing copy instead of a generic failure.
 */
const CONSTRAINT_CODES: Record<string, CsErrorCode> = {
  budget_accounts_reserved_plus_spent_le_cap: 'GATE_BUDGET_EXCEEDED',
  checkout_attempts_l3_jti_key: 'GATE_REPLAY',
  checkout_attempts_idempotency_key_key: 'CS_CONFLICT',
  webhook_events_paypal_event_id_key: 'WH_DUPLICATE',
  orders_paypal_order_id_key: 'CS_CONFLICT',
  orders_attempt_id_key: 'CS_CONFLICT',
  captures_refunded_lte_amount: 'CS_VALIDATION',
  evidence_packets_notes_le_2000: 'CS_VALIDATION',
  mandates_exp_gt_iat: 'VI_EXPIRED',
  l1_credentials_exp_gt_iat: 'VI_EXPIRED',
}

const CHECK_MESSAGES: Record<string, string> = {
  budget_accounts_reserved_plus_spent_le_cap:
    'Budget invariant violated: reserved + spent would exceed the cap the user signed.',
  checkout_sessions_total_matches_parts: 'Checkout total does not equal subtotal + tax + shipping.',
  captures_refunded_lte_amount: 'Refunded amount would exceed the captured amount.',
  evidence_packets_notes_le_2000: 'Evidence notes must be 2000 characters or fewer (spec §8.15).',
}

/**
 * Convert anything thrown inside a repository into a `CsError`.
 *
 * @param cause whatever was thrown.
 * @param context structured context for the `details` bag — table, ids. Never secrets.
 */
export function toRepoError(cause: unknown, context: Record<string, unknown> = {}): CsError {
  const code = pgErrorCode(cause)
  const constraint = pgConstraintName(cause)
  const rawMessage = asPgErrorLike(cause)?.message
  const message = typeof rawMessage === 'string' ? rawMessage : toCsError(cause).message

  if (code === PG.UNIQUE_VIOLATION) {
    return {
      code: (constraint && CONSTRAINT_CODES[constraint]) || 'CS_CONFLICT',
      message: `Duplicate rejected by unique constraint${constraint ? ` ${constraint}` : ''}: ${message}`,
      userMessage:
        constraint === 'checkout_attempts_l3_jti_key'
          ? 'This exact authorisation was already used once, so it was not used again.'
          : 'That conflicts with something we already saved. Refresh and try again.',
      retryable: false,
      details: { ...context, pgCode: code, constraint },
      cause,
    }
  }

  if (code === PG.CHECK_VIOLATION) {
    const key = constraint ?? ''
    return {
      code: CONSTRAINT_CODES[key] ?? 'CS_VALIDATION',
      message:
        CHECK_MESSAGES[key] ??
        `Check constraint rejected the write${constraint ? ` (${constraint})` : ''}: ${message}`,
      userMessage: 'That conflicts with a limit you signed.',
      retryable: false,
      details: { ...context, pgCode: code, constraint },
      cause,
    }
  }

  if (code === PG.FOREIGN_KEY_VIOLATION) {
    return {
      code: 'CS_VALIDATION',
      message: `Foreign key violation${constraint ? ` on ${constraint}` : ''}: ${message}`,
      userMessage: 'That refers to something we could not find. Refresh and try again.',
      retryable: false,
      details: { ...context, pgCode: code, constraint },
      cause,
    }
  }

  if (code === PG.SERIALIZATION_FAILURE || code === PG.DEADLOCK_DETECTED) {
    // The caller should retry the whole transaction; the row locks were released for us.
    return {
      code: 'CS_CONFLICT',
      message: `Transaction could not serialise (${code}); retry the transaction.`,
      userMessage: 'Something else was changing at the same time. Please try again.',
      retryable: true,
      details: { ...context, pgCode: code },
      cause,
    }
  }

  if (code === PG.NOT_NULL_VIOLATION) {
    return {
      code: 'CS_VALIDATION',
      message: `Missing required column: ${message}`,
      userMessage: 'Some of that information is not valid. Please check and try again.',
      retryable: false,
      details: { ...context, pgCode: code },
      cause,
    }
  }

  // No SQLSTATE: an unexpected error. Fall through to core's normaliser so the shape is identical.
  return toCsError(cause, 'CS_VALIDATION')
}

/**
 * Strip one layer of `Result`.
 *
 * A repository body mixes two kinds of return: a bare row on success, and `err(...)` for a business
 * failure. `repo` has to accept both and produce one `Result` on the way out, so the declared return
 * type is `Result<UnwrapResult<T>, CsError>` where `T` is what the body returned.
 */
type UnwrapResult<T> = T extends { ok: true; value: infer V }
  ? V
  : T extends { ok: false }
    ? never
    : T

/**
 * Is this value already a `Result`?
 *
 * Requires the *pair*: `{ok: true, value}` or `{ok: false, error}`. Checking only for an `ok` property
 * would misfire on legitimate return values that happen to carry an `ok` flag — a
 * `WalletCapVerdict` (`{ok: true, cap}`) and a `ReconcileReport` (`{ok: boolean, drift}`) both do, and
 * mistaking either for a `Result` would hand the caller one envelope too many.
 */
function isResultShape(
  value: unknown,
): value is { ok: true; value: unknown } | { ok: false; error: unknown } {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false
  const ok = (value as { ok: unknown }).ok
  if (ok === true) return 'value' in value
  if (ok === false) return 'error' in value
  return false
}

/**
 * The one place a repository's body is wrapped.
 *
 * A `Result` returned from `fn` (typically `err(...)` for a business failure such as an over-cap
 * budget) passes through untouched. A throw becomes a typed error via {@link toRepoError}, which is
 * what turns Postgres's `23505` into `CS_CONFLICT`.
 *
 * @param context short, non-secret context for the error `details` (table name, ids).
 */
export async function repo<T>(
  fn: () => Promise<T>,
  context: Record<string, unknown> = {},
): Promise<Result<UnwrapResult<T>, CsError>> {
  try {
    const value = await fn()
    // `Result` flows through unchanged so callers can `return err(...)` from inside `fn`.
    if (isResultShape(value)) {
      return value as Result<UnwrapResult<T>, CsError>
    }
    return { ok: true, value } as Result<UnwrapResult<T>, CsError>
  } catch (cause) {
    return err(toRepoError(cause, context))
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Small shared conversions                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * The current instant as a `Date` for a `timestamptz` column.
 *
 * Every repo takes an optional {@link Clock} so tests can pin `budget_entries.at` (EC-TIME-5's
 * day-3 re-authorisation check is entirely about timestamps). Business code never calls
 * `Date.now()` itself — core's `Clock` is the only time source (spec §8.1).
 */
export function now(clock: Clock = systemClock): Date {
  return new Date(clock.nowMs())
}

/**
 * Re-assemble a `Money` from the two columns it is stored in.
 *
 * Money lives in the database as `bigint` minor units + `char(3)`; this is the only sanctioned way
 * back to a `Money`. There is no float step anywhere in that path.
 */
export function toMoney(minor: bigint, currency: Currency): Money {
  return { minor, currency }
}

/** Convenience re-export so a repo file needs one import for the `Result` vocabulary. */
export { ok, err }
export type { Result, CsError, Clock, Money, Currency }

/* ------------------------------------------------------------------------------------------ */
/* Repositories                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export * from './users'
export * from './wallets'
export * from './devices'
export * from './agents'
export * from './mandates'
export * from './budget'
export * from './products'
export * from './checkout'
export * from './attempts'
export * from './gate'
export * from './orders'
export * from './webhooks'
export * from './disputes'
export * from './audit'
