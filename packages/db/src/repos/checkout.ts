/**
 * `checkout_sessions` repository — spec §7.2, §8.9 (`create_checkout`), Gate check 6 (§8.10).
 *
 * A session is the merchant's signed, price-locked cart. `checkout_jwt` + `checkout_hash` are what
 * Gate check 5 compares against the L3b, and `price_lock_exp` is what check 6 compares against the
 * clock — so both are stored, not derived.
 *
 * Money here is four `bigint` columns plus one `char(3)`, and the schema CHECK
 * `checkout_sessions_total_matches_parts` keeps `total = subtotal + tax + shipping`. That CHECK is
 * worth having: the failure mode it prevents is a cart whose total disagrees with its own breakdown,
 * which would make every later amount (L3a, authorization, capture, dispute) subtly wrong at the same
 * time.
 */
import { and, eq, lte, sql } from 'drizzle-orm'

import type { CheckoutId, CsError, Money, Result } from '@countersign/core'

import { db, type Exec } from '../client'
import { checkoutSessions, type CheckoutSessionRow, type NewCheckoutSession } from '../schema'
import { err, repo } from './index'

export interface CartLine {
  readonly sku: string
  readonly qty: number
  /** Unit price locked at checkout time, in minor units. What the split capture allocates from. */
  readonly unitMinor: bigint
}

export type CheckoutSessionStatus = 'CREATED' | 'SUBMITTED' | 'COMPLETED' | 'EXPIRED' | 'ABANDONED'

export function createCheckoutSession(
  input: NewCheckoutSession,
  exec?: Exec,
): Promise<Result<CheckoutSessionRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(checkoutSessions).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no checkout_sessions row')
      return row as CheckoutSessionRow
    },
    { table: 'checkout_sessions', id: input.id },
  )
}

/** Gate check 6 reads one session; the merchant cart page lists the recent ones. */
export function findCheckoutSessionById(
  id: CheckoutId,
  exec?: Exec,
): Promise<Result<CheckoutSessionRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(checkoutSessions)
        .where(eq(checkoutSessions.id, id))
        .limit(1)
      return rows[0] as CheckoutSessionRow | undefined
    },
    { table: 'checkout_sessions', id },
  )
}

export async function requireCheckoutSession(
  id: CheckoutId,
  exec?: Exec,
): Promise<Result<CheckoutSessionRow, CsError>> {
  const found = await findCheckoutSessionById(id, exec)
  if (!found.ok) return found
  const session = found.value
  if (!session) {
    return err({
      code: 'CS_NOT_FOUND',
      message: `No checkout_sessions row for ${id}`,
      userMessage: 'We could not find that cart.',
      retryable: false,
      details: { table: 'checkout_sessions', id },
    })
  }
  return { ok: true, value: session }
}

export function setCheckoutSessionStatus(
  id: CheckoutId,
  status: CheckoutSessionStatus,
  at: Date,
  exec?: Exec,
): Promise<Result<CheckoutSessionRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(checkoutSessions)
        .set({ status, updated_at: at })
        .where(eq(checkoutSessions.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No checkout_sessions row for ${id}`)
      return row as CheckoutSessionRow
    },
    { table: 'checkout_sessions', id, status },
  )
}

/**
 * Gate check 6: has the price lock expired? `GATE_PRICE_LOCK_EXPIRED` when it has.
 *
 * The boundary is a single comparison against one `now` the caller captured at Gate start
 * (EC-TIME-4): taking a second `Date.now()` here would make a lock that expires mid-Gate pass or
 * fail depending on scheduling, which is the race the spec calls out by name.
 */
export function assertPriceLockValid(
  session: CheckoutSessionRow,
  now: Date,
): Result<true, CsError> {
  if (session.price_lock_exp.getTime() <= now.getTime()) {
    return err({
      code: 'GATE_PRICE_LOCK_EXPIRED',
      message: `Price lock for ${session.id} expired at ${session.price_lock_exp.toISOString()}`,
      userMessage: 'The locked price expired, so the agent needs to re-quote.',
      retryable: false,
      details: {
        table: 'checkout_sessions',
        id: session.id,
        priceLockExp: session.price_lock_exp.toISOString(),
      },
    })
  }
  return { ok: true, value: true }
}

/**
 * Gate check 6, second half: do the locked totals equal the L3a amount, in the same currency?
 *
 * EC-FX-1: a currency mismatch is `CS_CURRENCY_MISMATCH`, never a conversion. The Gate blocks and the
 * buyer is told to create a mandate in the store currency.
 */
export function assertAmountMatchesSession(
  session: CheckoutSessionRow,
  amount: Money,
): Result<true, CsError> {
  if (session.currency !== amount.currency) {
    return err({
      code: 'CS_CURRENCY_MISMATCH',
      message: `Session ${session.id} is ${session.currency}; L3a amount is ${amount.currency}`,
      userMessage:
        'Your limit and this store charges in a different currency, so we did not convert them. Create a mandate in the store currency.',
      retryable: false,
      details: {
        table: 'checkout_sessions',
        id: session.id,
        sessionCurrency: session.currency,
        amountCurrency: amount.currency,
      },
    })
  }
  if (session.total_minor !== amount.minor) {
    return err({
      code: 'VI_CONSTRAINT_VIOLATION',
      message: `Session ${session.id} total ${session.total_minor} != L3a amount ${amount.minor}`,
      userMessage: 'That purchase is outside the limits you signed.',
      retryable: false,
      details: {
        table: 'checkout_sessions',
        id: session.id,
        sessionTotalMinor: session.total_minor.toString(),
        amountMinor: amount.minor.toString(),
      },
    })
  }
  return { ok: true, value: true }
}

/**
 * The expired-price-lock sweep.
 *
 * EC-PRICE-1: after `price_lock_exp` a new checkout is needed and the agent re-quotes — an expired
 * session is never silently refreshed, because the point of the lock is that the price the user
 * approved is the price charged.
 */
export function findExpiredSessions(
  before: Date,
  exec?: Exec,
): Promise<Result<CheckoutSessionRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(checkoutSessions)
        .where(
          and(eq(checkoutSessions.status, 'CREATED'), lte(checkoutSessions.price_lock_exp, before)),
        )
      return rows as CheckoutSessionRow[]
    },
    { table: 'checkout_sessions', op: 'find_expired' },
  )
}

export function findCheckoutSessionsByMerchant(
  merchantId: string,
  exec?: Exec,
): Promise<Result<CheckoutSessionRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(checkoutSessions)
        .where(eq(checkoutSessions.merchant_id, merchantId))
        .orderBy(sql`${checkoutSessions.created_at} desc`)
      return rows as CheckoutSessionRow[]
    },
    { table: 'checkout_sessions', merchantId },
  )
}

/** The stored total, re-assembled from its two columns. No float anywhere on this path. */
export function sessionTotal(session: CheckoutSessionRow): Money {
  return { minor: session.total_minor, currency: session.currency }
}
