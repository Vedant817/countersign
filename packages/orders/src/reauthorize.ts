/**
 * Re-authorization — spec **§8.11** (`reauthorizeIfNeeded`), §12.5 **EC-TIME-5**, [B12], [V15].
 *
 * ## The two clocks, and why the honour window is the one that matters
 *
 * A PayPal authorization has **two** deadlines, and confusing them is the whole failure mode here:
 *
 * | Clock | Length | Source | What happens at the end |
 * |---|---|---|---|
 * | **honour period** | **3 days** | [V15]; "If the authorization is more than 3 days old, reauthorize the funds before capturing" (`ORDER_ALREADY_AUTHORIZED`) | funds are no longer guaranteed to be there — but they *usually* are |
 * | **validity** | **29 days** | [V15]; "days four to 29", "if 30 days have transpired" | the authorization is gone; it must be voided and the reservation released |
 *
 * So the day-3 cron asks a question that is *not* "is it still valid?": **"is the money still probably
 * there?"** Reauthorizing is how you find out. And the answer only exists from day 4 onward, because PayPal
 * documents reauthorization as valid exactly then ("You can reauthorize a payment only once from days four
 * to 29") — calling it on day 2 is a 422, not a harmless no-op.
 *
 * Hence {@link ReauthorizeOutcome.TOO_EARLY}: inside the honour window, do nothing. That is not a shrug; it
 * is the documented rule, and it is the single most likely thing to get wrong because "it has not expired,
 * so keep going" reads as obviously correct.
 *
 * ## What happens on the other two answers
 *
 * - **expired** (`now ≥ expiration_time`): `AUTH_EXPIRED`, the authorization row `EXPIRED`, and the
 *   uncaptured remainder **RELEASE**d. §12.5 EC-TIME-5: *"on expiry: state AUTH_EXPIRED, RELEASE"*. The
 *   captured part stays committed (EC-MDT-4: it was authorised when made).
 * - **reauthorized**: the row stays `CREATED` and the expiry moves out by whatever PayPal says. The
 *   reauthorization itself carries **a new 3-day honour period** ([V15]), so the cron will ask again in
 *   three days — and PayPal allows **exactly one** reauthorization, which the day-28 alert exists to warn
 *   about rather than discover.
 *
 * ## The request id
 *
 * §8.6 names four formats and none of them is a reauthorization. The convention here is the same one the
 * authorize fallback uses: `cs:{authId}:reauth`, derived from our own ids, header-safe, and — critically —
 * **stable**, because a cron that runs twice must ask twice about the *same* authorization rather than
 * creating a second one.
 */

import {
  csError,
  err,
  ok,
  type AttemptId,
  type CsError,
  type MandateId,
  type Money,
  type Result,
} from '@countersign/core'
import type { AuthorizationRow, OrderRow } from '@countersign/db'

import { attemptStateFor, notifyReleased, remainingAuthorized } from './budget-hooks'
import { toJsonValue } from './deps'
import type { OrdersDeps, ReauthorizeReport } from './types'

/** `cs:{authId}:reauth` — §8.6 has no format for this call; see the module header. */
export function reauthorizeRequestId(authorizationId: string): string {
  return `cs:${authorizationId}:reauth`
}

/**
 * Is the honour window open?
 *
 * Pure, and the spec's rule stated as an inequality: **days four to 29**, i.e. `honor_expires_at ≤ now <
 * expiration_time`. `<=` on the left because PayPal says "more than 3 days old" — at exactly three days it
 * is not yet more than three, and getting the boundary wrong in the permissive direction is a 422.
 */
export function honourWindowOpen(
  authorization: Pick<AuthorizationRow, 'honor_expires_at' | 'expiration_time'>,
  now: Date,
): { open: boolean; expired: boolean } {
  const expired = now.getTime() >= authorization.expiration_time.getTime()
  const open = !expired && now.getTime() >= authorization.honor_expires_at.getTime()
  return { open, expired }
}

/**
 * §8.11's `reauthorizeIfNeeded(authId, deps)`. The day-3 cron job's primitive.
 *
 * `now` is a **parameter** rather than a clock read for two reasons: EC-TIME-4's discipline that one
 * decision uses one instant, and because the cron's schedule is what decides "is it day 4 yet" — this
 * function should answer the question, not decide when it is asked.
 *
 * @param authId **our** `aut_…` row id, not PayPal's. §8.11's signature says `authId` without saying which,
 * and ours is the one that carries `honor_expires_at` and `expiration_time`; PayPal's id is on the row.
 */
export async function reauthorizeIfNeeded(
  authId: string,
  deps: OrdersDeps,
  now: Date = new Date(deps.clock.nowMs()),
): Promise<Result<ReauthorizeReport, CsError>> {
  const authorization = await deps.store.authorizations.findById(authId)
  if (!authorization.ok) return authorization
  if (!authorization.value) {
    return err(
      csError('CS_NOT_FOUND', `No authorizations row for ${authId}`, {
        table: 'authorizations',
        id: authId,
      }),
    )
  }
  const row = authorization.value

  // A fully-captured authorization has nothing to reauthorize and asking would be a 422. A
  // `PARTIALLY_CAPTURED` one **is** still live (EC-SPLIT-1: a remainder is still drawable), so it falls
  // through to the window logic below — which is the point of the split-shipment path.
  if (
    row.status === 'VOIDED' ||
    row.status === 'DENIED' ||
    row.status === 'EXPIRED' ||
    row.status === 'CAPTURED'
  ) {
    return ok({ outcome: 'SETTLED', authorizationId: authId, requestId: null, released: null })
  }

  const window = honourWindowOpen(row, now)
  if (window.expired) {
    return expireAuthorization(deps, row, now)
  }
  if (!window.open) {
    // [V15]: reauthorization is valid from day 4. Doing it earlier is refused by PayPal, so the honest
    // answer here is "not yet" rather than an optimistic call.
    return ok({ outcome: 'TOO_EARLY', authorizationId: authId, requestId: null, released: null })
  }

  const requestId = reauthorizeRequestId(row.paypal_authorization_id)
  const renewed = await deps.paypal.reauthorize(row.paypal_authorization_id, {}, { requestId })
  if (!renewed.ok) return renewed

  // **CONTRACT GAP (reported, not worked around).** PayPal's response is the authority on the new expiry —
  // [V15]'s reauthorization has "a new honor period of three days" and the extension is geography-dependent
  // (up to 115% in the US) — so `authorizations.expiration_time` should be restamped from
  // `renewed.value.expiration_time`. `repos/orders.ts` has no writer for that column (`setAuthorizationStatus`
  // takes only a status), and adding one would mean editing another work package's files (AGENTS.md rule 8).
  //
  // Until that exists, the row keeps PayPal's *original* `expiration_time`, which is **conservative in the
  // safe direction**: `honourWindowOpen` will report `expired` at the old date, so the worst outcome is that
  // the day-28/29 cron expires a row that could have been captured, rather than that we keep waiting on an
  // authorization PayPal has already dropped. §11's C2 check and `README.md` → "Contract issues" both name it.
  const stated = renewed.value.expiration_time
  const renewedExpiry = stated ? Date.parse(stated) : Number.NaN
  deps.logger?.info('paypal authorization reauthorized', {
    authorizationId: authId,
    requestId,
    storedExpiration: row.expiration_time.toISOString(),
    paypalExpiration: Number.isNaN(renewedExpiry) ? null : new Date(renewedExpiry).toISOString(),
    expiryRestamped: false,
  })

  const updated = await deps.store.authorizations.setStatus(row.id, 'CREATED', now)
  if (!updated.ok) return updated
  return ok({
    outcome: 'REAUTHORIZED',
    authorizationId: authId,
    requestId,
    released: null,
  })
}

/**
 * EC-TIME-5: past `expiration_time` the authorization is `EXPIRED` and its uncaptured remainder is released.
 *
 * The release is the whole point. An expired authorization that holds a reservation is a buyer whose money
 * is unusable and un-releasable: the money left their account, the goods were never bought, and the budget
 * says the amount is still spoken for. The captured part is untouched (EC-MDT-4).
 */
async function expireAuthorization(
  deps: OrdersDeps,
  row: AuthorizationRow,
  at: Date,
): Promise<Result<ReauthorizeReport, CsError>> {
  await deps.store.authorizations.setStatus(row.id, 'EXPIRED', at)

  const order = await deps.store.orders.findById(row.order_id as OrderRow['id'])
  if (!order.ok) return order
  if (!order.value) {
    return ok({
      outcome: 'EXPIRED',
      authorizationId: row.id,
      requestId: null,
      released: { minor: 0n, currency: row.currency },
    })
  }

  await deps.store.orders.setStatus(order.value.id, 'AUTH_EXPIRED', at)
  await deps.store.attempts.setState(
    order.value.attempt_id as AttemptId,
    attemptStateFor('AUTH_EXPIRED'),
    at,
  )

  const remaining = await remainingAuthorized(deps, row, at)
  if (!remaining.ok) return remaining
  if (remaining.value === 0n) {
    return ok({ outcome: 'EXPIRED', authorizationId: row.id, requestId: null, released: null })
  }

  const subject = await subjectOf(deps, order.value)
  if (!subject.ok) return subject

  const released: Money = { minor: remaining.value, currency: row.currency }
  const hook = await deps.budget.release({
    mandateId: subject.value.mandateId,
    attemptId: subject.value.attemptId,
    captureId: row.id,
    amount: released,
    at,
    reason: 'EXPIRED',
  })
  if (!hook.ok) return hook

  await notifyReleased(deps, {
    order: order.value,
    userId: subject.value.userId,
    amount: released,
    reason: 'EXPIRED',
    at,
  })

  return ok({ outcome: 'EXPIRED', authorizationId: row.id, requestId: null, released })
}

async function subjectOf(
  deps: OrdersDeps,
  order: OrderRow,
): Promise<Result<{ mandateId: MandateId; attemptId: AttemptId; userId: string }, CsError>> {
  const attempt = await deps.store.attempt(order.attempt_id as AttemptId)
  if (!attempt.ok) return attempt
  if (!attempt.value) {
    return err(
      csError('CS_NOT_FOUND', `No checkout_attempts row for ${order.attempt_id}`, {
        table: 'checkout_attempts',
        id: order.attempt_id,
      }),
    )
  }
  const mandateId = attempt.value.mandate_id as MandateId
  const mandate = await deps.store.mandate(mandateId)
  if (!mandate.ok) return mandate
  if (!mandate.value) {
    return err(
      csError('CS_NOT_FOUND', `No mandates row for ${mandateId}`, {
        table: 'mandates',
        id: mandateId,
      }),
    )
  }
  return ok({ mandateId, attemptId: attempt.value.id, userId: mandate.value.user_id })
}

export { toJsonValue }
