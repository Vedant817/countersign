/**
 * `voidRemainder` and `reauthorizeIfNeeded` — spec §8.11, §12.4 **EC-MDT-3/4**, §12.5 **EC-TIME-5**, [V15].
 *
 * `capture.test.ts` already covers the happy split (AT-M11.2) and the stock restore (EC-STOCK-1). This file
 * covers the two modules' **decisions** rather than their plumbing:
 *
 *  - which `orders.status` each `voidRemainder` reason produces, because `REVOKED → CANCELLED` and
 *    `EXPIRED → AUTH_EXPIRED` are spec sentences, not implementation detail — a buyer reads the difference;
 *  - that a **failed** void moves no money (the reason the writes are step 4, after the call);
 *  - EC-TIME-5's **two clocks**. The 3-day honour window and the 29-day validity are different deadlines
 *    with different consequences, and `TOO_EARLY` existing at all is the evidence that they are not
 *    collapsed into "has it expired?".
 */

import { describe, expect, it } from 'vitest'

import type { OrderId } from '@countersign/core'
import type { AuthorizationRow, OrderRow } from '@countersign/db'

import {
  abortVoidRequestId,
  captureShipment,
  createOrderFromDecision,
  honourWindowOpen,
  reauthorizeIfNeeded,
  reauthorizeRequestId,
  voidRemainder,
  voidRequestId,
} from '../src'
import { NOW_SEC, allowDecision, harness, routes, type Harness } from './harness'

const DAY = 86_400

describe('voidRemainder — the four reasons and the status each implies', () => {
  it('OUT_OF_STOCK → VOIDED, and the whole authorization is released', async () => {
    const h = await authorized()
    const result = await voidRemainder(orderIdOf(h), 'OUT_OF_STOCK', h.deps)
    expect(result.ok, describeErr(result)).toBe(true)
    if (!result.ok) return
    // $50.00 authorized ($45.00 + $5.00 shipping), nothing captured, so all of it comes back.
    expect(result.value.released.minor).toBe(5_000n)
    expect(result.value.orderStatus).toBe('VOIDED')
    expect(result.value.viaAuthorizationVoid).toBe(true)
    expect(h.reserved()).toBe(0n)
    expect(h.notifier.ofKind('REMAINDER_RELEASED')).toHaveLength(1)
  })

  it('CANCELLED → VOIDED', async () => {
    const h = await authorized()
    const result = await voidRemainder(orderIdOf(h), 'CANCELLED', h.deps)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.orderStatus).toBe('VOIDED')
  })

  it('EC-MDT-3: REVOKED → CANCELLED, not VOIDED', async () => {
    // §12.4: "the order is CANCELLED". The two statuses are different stories to a buyer — VOIDED is a
    // merchant/fulfilment event, CANCELLED is "you stopped this" — so this mapping is load-bearing copy,
    // not a synonym.
    const h = await authorized()
    const result = await voidRemainder(orderIdOf(h), 'REVOKED', h.deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.orderStatus).toBe('CANCELLED')
    // The money still comes back either way; only the story differs.
    expect(result.value.released.minor).toBe(5_000n)
    expect(orderOf(h)?.status).toBe('CANCELLED')
  })

  it('EC-TIME-5: EXPIRED → AUTH_EXPIRED, the same state the reauthorize cron writes', async () => {
    const h = await authorized()
    const result = await voidRemainder(orderIdOf(h), 'EXPIRED', h.deps)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.orderStatus).toBe('AUTH_EXPIRED')
    expect(attemptStateOf(h)).toBe('AUTH_EXPIRED')
  })

  it('the void carries cs:{authId}:void, derived from our own authorization id', async () => {
    const h = await authorized()
    await voidRemainder(orderIdOf(h), 'CANCELLED', h.deps)
    const auth = authorizationOf(h)
    expect(voidRequestId(auth.paypal_authorization_id)).toBe(
      `cs:${auth.paypal_authorization_id}:void`,
    )
    expect(h.paypal.requestIdOf('/void')).toBe(`cs:${auth.paypal_authorization_id}:void`)
  })

  it('a retried void sends the identical request id, so PayPal deduplicates it', async () => {
    // EC-IDEM-2's shape applied to the void: the id is a pure function of the authorization, so a cron that
    // fires twice cannot ask PayPal to void the same authorization twice.
    const h = await authorized()
    await voidRemainder(orderIdOf(h), 'CANCELLED', h.deps)
    const first = h.paypal.requestIdOf('/void')
    await voidRemainder(orderIdOf(h), 'CANCELLED', h.deps)
    // The second call is `alreadySettled` and makes no request at all — an even stronger guarantee than a
    // repeated id, and the assertion that both agree.
    expect(h.paypal.callsTo('/void')).toHaveLength(1)
    expect(h.paypal.requestIdOf('/void')).toBe(first)
  })
})

describe('voidRemainder — the writes come after the call', () => {
  it('a void PayPal refuses leaves the ledger, the order and the authorization untouched', async () => {
    // The ordering is the property. Releasing the budget for money PayPal still holds is the
    // "buyer can spend money that is also being spent" bug, so a failed void must be a no-op everywhere.
    const h = harness({ lines: [{ sku: 'NW-001', qty: 1 }] })
    h.paypal.setRoutes(
      routes({
        'POST /v2/payments/authorizations/{id}/void': {
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            message: 'The requested action could not be performed.',
            debug_id: 'DEBUG-VOID-FAIL',
            details: [],
          },
        },
      }),
    )
    await createOrder(h)

    const before = h.entries().length
    const result = await voidRemainder(orderIdOf(h), 'CANCELLED', h.deps)
    expect(result.ok).toBe(false)
    // Nothing moved: no RELEASE, no status change, no notification.
    expect(h.entries()).toHaveLength(before)
    expect(h.reserved()).toBe(5_000n)
    expect(orderOf(h)?.status).toBe('AUTHORIZED')
    expect(authorizationOf(h).status).toBe('CREATED')
    expect(h.notifier.ofKind('REMAINDER_RELEASED')).toHaveLength(0)
  })

  it('EC-MDT-4: a void releases the remainder only, never touching a COMPLETED capture', async () => {
    // §12.4: "capture time < revoked_at — the purchase stands (it was authorised when made)". So a
    // revocation afterwards is a statement about the *future*, not a retraction of what was already charged.
    const h = await authorized()
    const captured = await captureShipment(
      orderIdOf(h),
      { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-VOID-A' },
      h.deps,
    )
    expect(captured.ok).toBe(true)

    const spentBefore = h.spent()
    const result = await voidRemainder(orderIdOf(h), 'REVOKED', h.deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The whole $50.00 was captured by the first shipment, so there is nothing left to release.
    expect(result.value.released.minor).toBe(0n)
    expect(h.spent()).toBe(spentBefore)
    const capture = [...h.world.rows.captures.values()][0]
    expect(capture?.status).toBe('COMPLETED')
    expect(capture?.refunded_minor).toBe(0n)
  })

  it('an order with no voidable authorization is alreadySettled, not an error', async () => {
    // A webhook, a sweep and a merchant action can all reach a settled order. A retry is not a failure.
    const h = await authorized()
    h.world.rows.orders.get(orderIdOf(h))!.status = 'VOIDED'
    const result = await voidRemainder(orderIdOf(h), 'CANCELLED', h.deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.alreadySettled).toBe(true)
    expect(result.value.released.minor).toBe(0n)
    expect(h.paypal.callsTo('/void')).toHaveLength(0)
  })

  it('an unknown order id is CS_NOT_FOUND, not a crash', async () => {
    const h = await authorized()
    const result = await voidRemainder(
      'ord_0000000000000000000000dead' as OrderId,
      'CANCELLED',
      h.deps,
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.code).toBe('CS_NOT_FOUND')
  })

  it('the aborted-create compensation void uses its own request id, not the void one', async () => {
    // `create.ts` voids an authorization it created moments earlier and then aborts the order. Sharing
    // `cs:{authId}:void` with a merchant-initiated void would make PayPal treat the compensation as a retry
    // of it, so the two must be distinguishable.
    const h = await authorized()
    const authId = authorizationOf(h).paypal_authorization_id
    expect(abortVoidRequestId(authId)).not.toBe(voidRequestId(authId))
    expect(abortVoidRequestId(authId)).toBe(`cs:${authId}:abort-void`)
  })
})

describe('EC-TIME-5 — the honour window and the validity are two clocks', () => {
  it('the window is closed before the honour deadline and open at it, exactly', () => {
    const row = authorizationLike({
      honor_expires_at: new Date(3 * DAY * 1000),
      expiration_time: new Date(29 * DAY * 1000),
    })
    // Day 2: PayPal refuses a reauthorization ("valid from days four to 29"), so this must not be open.
    expect(honourWindowOpen(row, new Date(2 * DAY * 1000))).toEqual({ open: false, expired: false })
    // Exactly the honour deadline: `>=`, because PayPal says "more than 3 days old". Getting this boundary
    // wrong in the permissive direction is a 422 on a cron that runs exactly once a day.
    expect(honourWindowOpen(row, new Date(3 * DAY * 1000))).toEqual({ open: true, expired: false })
    // Day 29 minus a second: still reauthorizable, still valid.
    expect(honourWindowOpen(row, new Date(29 * DAY * 1000 - 1))).toEqual({
      open: true,
      expired: false,
    })
    // Exactly the expiry: closed, and expired — the two flags are not exclusive at the boundary.
    expect(honourWindowOpen(row, new Date(29 * DAY * 1000))).toEqual({ open: false, expired: true })
  })

  it('reauthorizeIfNeeded on day 1 is TOO_EARLY and makes no call', async () => {
    const h = await authorized()
    const result = await reauthorizeIfNeeded(authRowId(h), h.deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe('TOO_EARLY')
    expect(result.value.requestId).toBeNull()
    // The point of the whole branch: no request was made, so there is no 422 to retry.
    expect(h.paypal.callsTo('/reauthorize')).toHaveLength(0)
    expect(h.entries()).toHaveLength(1) // the Gate's RESERVE, untouched
  })

  it('on day 4 it reauthorizes, carries cs:{authId}:reauth, and moves no money', async () => {
    const h = await authorized()
    h.setNow(NOW_SEC + 4 * DAY)
    const result = await reauthorizeIfNeeded(authRowId(h), h.deps)
    expect(result.ok, describeErr(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe('REAUTHORIZED')
    const auth = authorizationOf(h)
    expect(result.value.requestId).toBe(`cs:${auth.paypal_authorization_id}:reauth`)
    expect(reauthorizeRequestId(auth.paypal_authorization_id)).toBe(result.value.requestId)
    expect(h.paypal.requestIdOf('/reauthorize')).toBe(result.value.requestId)
    expect(h.paypal.callsTo('/reauthorize')).toHaveLength(1)
    // The row stays live, and the money is untouched: reauthorizing finds out whether the funds are still
    // there, it does not move the reservation.
    expect(authorizationOf(h).status).toBe('CREATED')
    expect(h.reserved()).toBe(5_000n)
  })

  it('a partially-captured authorization is still live, so the cron reauthorizes it', async () => {
    // EC-SPLIT-1: a remainder that has not shipped is still drawable, so the cron must keep it alive. If a
    // `PARTIALLY_CAPTURED` authorization counted as settled, a split shipment would expire mid-flight and
    // the second shipment would fail on the day the first shipped.
    const h = await authorized({ sku: 'NW-001', qty: 2 })
    const shipped = await captureShipment(
      orderIdOf(h),
      { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-SPLIT-A' },
      h.deps,
    )
    expect(shipped.ok).toBe(true)
    // $45.00 + its half of the $5.00 shipping fee (per **unit**, EC-FX-4): the rest is still authorized.
    expect(shipped.ok && shipped.value.amount.minor).toBe(4_750n)
    expect(authorizationOf(h).status).toBe('PARTIALLY_CAPTURED')

    h.setNow(NOW_SEC + 4 * DAY)
    const result = await reauthorizeIfNeeded(authRowId(h), h.deps)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.outcome).toBe('REAUTHORIZED')
    expect(h.paypal.callsTo('/reauthorize')).toHaveLength(1)
  })

  it('past the validity it is EXPIRED: AUTH_EXPIRED, RELEASE, and no PayPal call', async () => {
    // §12.5 EC-TIME-5: "on expiry: state AUTH_EXPIRED, RELEASE". Nothing is asked of PayPal — the
    // authorization is already gone, and asking to void or reauthorize it is a 422.
    const h = await authorized()
    // Read the row's own deadline rather than counting days: the stub states `2026-11-02`, and a test that
    // assumed 29 days would silently stop testing the boundary if that changed.
    const expirySec = Math.floor(authorizationOf(h).expiration_time.getTime() / 1000)
    h.setNow(expirySec + 1)

    const result = await reauthorizeIfNeeded(authRowId(h), h.deps)
    expect(result.ok, describeErr(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe('EXPIRED')
    expect(result.value.released?.minor).toBe(5_000n)
    expect(h.paypal.callsTo('/reauthorize')).toHaveLength(0)
    expect(authorizationOf(h).status).toBe('EXPIRED')
    expect(orderOf(h)?.status).toBe('AUTH_EXPIRED')
    expect(attemptStateOf(h)).toBe('AUTH_EXPIRED')
    expect(h.reserved()).toBe(0n)
    expect(h.notifier.ofKind('REMAINDER_RELEASED')).toHaveLength(1)
  })

  it('EC-MDT-4: expiry releases the remainder and leaves the captured amount committed', async () => {
    // The pairing EC-TIME-5 and EC-MDT-4 exist for. One of two units shipped, so the authorization holds a
    // real remainder: the expiry must hand **that** back and nothing else, because the shipped unit was
    // authorised when it was captured and cannot be un-charged by a later expiry.
    const h = await authorized({ sku: 'NW-001', qty: 2 })
    const shipped = await captureShipment(
      orderIdOf(h),
      { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-EXP-A' },
      h.deps,
    )
    expect(shipped.ok).toBe(true)
    // COMMIT 4_750, RESERVE 9_500, so `reserved` is exactly the unshipped remainder.
    expect(h.spent()).toBe(4_750n)
    expect(h.reserved()).toBe(4_750n)

    const expirySec = Math.floor(authorizationOf(h).expiration_time.getTime() / 1000)
    h.setNow(expirySec + 1)
    const result = await reauthorizeIfNeeded(authRowId(h), h.deps)
    expect(result.ok, describeErr(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe('EXPIRED')
    expect(result.value.released?.minor).toBe(4_750n)
    // The committed half is untouched; only the reservation went back.
    expect(h.spent()).toBe(4_750n)
    expect(h.reserved()).toBe(0n)
    expect(authorizationOf(h).status).toBe('EXPIRED')
    expect(orderOf(h)?.status).toBe('AUTH_EXPIRED')
  })

  it('a VOIDED or fully CAPTURED authorization is SETTLED, with no call', async () => {
    const h = await authorized()
    for (const status of ['VOIDED', 'CAPTURED', 'DENIED', 'EXPIRED'] as const) {
      h.world.rows.authorizations.get(authRowId(h))!.status = status
      h.setNow(NOW_SEC + 4 * DAY)
      const result = await reauthorizeIfNeeded(authRowId(h), h.deps)
      expect(result.ok).toBe(true)
      expect(result.ok && result.value.outcome, status).toBe('SETTLED')
    }
    expect(h.paypal.callsTo('/reauthorize')).toHaveLength(0)
  })

  it('an unknown authorization id is CS_NOT_FOUND', async () => {
    const h = await authorized()
    const result = await reauthorizeIfNeeded('aut_0000000000000000000000dead', h.deps)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.code).toBe('CS_NOT_FOUND')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Fixtures                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** NW-001 at $45.00 plus a flat $5.00 shipping fee: one authorized line worth $50.00. */
async function createOrder(h: Harness) {
  const order = await createOrderFromDecision(allowDecision(), h.deps)
  if (!order.ok) throw new Error(`order create failed: ${order.error.code} ${order.error.message}`)
  return order.value
}

/** An `AUTHORIZE` order with a live authorization and nothing captured. */
async function authorized(
  line: { sku: string; qty: number } = { sku: 'NW-001', qty: 1 },
): Promise<Harness> {
  const h = harness({ lines: [line] })
  await createOrder(h)
  return h
}

function orderIdOf(h: Harness): OrderId {
  return orderOf(h)?.id as OrderId
}

function orderOf(h: Harness): OrderRow | undefined {
  return [...h.world.rows.orders.values()][0]
}

/** The one authorization, as our `aut_…` row id. */
function authRowId(h: Harness): string {
  return [...h.world.rows.authorizations.keys()][0] ?? ''
}

function authorizationOf(h: Harness): AuthorizationRow {
  return [...h.world.rows.authorizations.values()][0] as AuthorizationRow
}

function attemptStateOf(h: Harness): string {
  return [...h.world.rows.attempts.values()][0]?.state ?? ''
}

/** A minimal authorization for the pure `honourWindowOpen` cases, which need no world at all. */
function authorizationLike(over: {
  honor_expires_at: Date
  expiration_time: Date
}): Pick<AuthorizationRow, 'honor_expires_at' | 'expiration_time'> {
  return over
}

function describeErr(r: { ok: boolean; error?: { code: string; message: string } }): string {
  return r.ok ? '' : `${r.error?.code}: ${r.error?.message}`
}
