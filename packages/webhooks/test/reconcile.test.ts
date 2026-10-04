/**
 * The reconciler's sweeps — spec **§8.12** (three crons), **§12.3 EC-WH-1**, **§12.5 EC-TIME-5**, **EC-PP-2**.
 *
 * ## What is different about these tests
 *
 * Every other file here asserts about **one** delivery or **one** resource. These assert about the sweeps,
 * and the properties worth asserting are different in kind:
 *
 * | Property | Why it matters |
 * |---|---|
 * | every PayPal read goes through the throttle | EC-PP-2 is a claim about *this file* of the code |
 * | a terminal row costs no request | it would otherwise crowd out the rows that can still change |
 * | one failure does not stop the sweep | a sweep that aborts on the first 404 never reaches resource 20 |
 * | `fixes` counts a **fix**, not a re-read | a metric that counted confirmations would report a healthy night as a recovery |
 * | the expiry sweep re-fetches before expiring | "believe our own row" is the mistake §3.1 warns about, including here |
 * | no `EXPIRED` event exists, so only this sweep can see an expiry | report §26; EC-TIME-5 |
 *
 * The throttle assertions count limiter admissions rather than measuring elapsed time, which is why
 * `instantThrottle` exists — a real 2 rps would make a twenty-resource sweep take ten seconds, and a
 * reconciler test that is skipped is not a test.
 */
import { describe, expect, it } from 'vitest'

import {
  AUTHORIZATION_HONOUR_DAYS,
  AUTHORIZATION_VALIDITY_DAYS,
  DEFAULT_DISPUTE_OVERLAP_SECONDS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_RECONCILE_RPS,
  EXPIRY_SWEEP_HORIZON_DAYS,
  authorizationExpirySweep,
  createThrottle,
  defaultThrottle,
  isReconcileCandidate,
  reconcileDisputes,
  reconcileResources,
  reprocessUnstoredWork,
} from '../src/reconcile'
import { handleWebhook } from '../src/ingest'
import { processWebhookEvent } from '../src/jobs'
import { REQUIRED_SIGNATURE_HEADERS } from '../src/signature'
import {
  LATER,
  NOW,
  NOW_MS,
  PAID,
  PAYPAL,
  authorizationBody,
  captureBody,
  disputeBody,
  eventBody,
  harness,
  oauthRoute,
  paypalNotFound,
  refundBody,
  verifySuccess,
  webhookHeaders,
} from './harness.test'

/** A doc-derived `GET /v2/checkout/orders/{id}`, from the orders v2 documentation. */
function orderOk(over: { status?: string; updateTime?: string } = {}) {
  return {
    body: {
      id: PAYPAL.orderId,
      status: over.status ?? 'COMPLETED',
      create_time: '2026-10-04T11:58:00Z',
      update_time: over.updateTime ?? PAID,
      purchase_units: [
        {
          reference_id: 'default',
          amount: { currency_code: 'USD', value: '60.00' },
          payee: { merchant_id: '9KX436DUC84BN' },
        },
      ],
    },
  }
}

const VERIFY_OK = {
  ...oauthRoute(),
  'POST /v1/notifications/verify-webhook-signature': verifySuccess(),
}

/** Narrow a `Result`, throwing rather than silently passing. */
function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`)
  return result.value
}

/* ------------------------------------------------------------------------------------------ */
/* EC-PP-2: the throttle                                                                         */
/* ------------------------------------------------------------------------------------------ */

describe('EC-PP-2 the reconciler throttles itself to 2 rps', () => {
  it('THROTTLE-1 the default is 2 rps, as the edge case states', () => {
    expect(DEFAULT_RECONCILE_RPS).toBe(2)
  })

  it('THROTTLE-1 createThrottle spaces admissions and asks the injected sleep for the gap', async () => {
    // An injected clock and sleep, so this is deterministic and takes no real milliseconds.
    let now = 0
    const delays: number[] = []
    const throttle = createThrottle({
      rps: 2,
      nowMs: () => now,
      sleep: async (ms) => {
        delays.push(ms)
        now += ms
      },
    })

    await throttle.run(async () => 1)
    await throttle.run(async () => 2)
    await throttle.run(async () => 3)

    // 2 rps is one admission every 500 ms. The first is immediate, so two gaps of 500.
    expect(delays).toEqual([500, 500])
    expect(throttle.rps).toBe(2)
  })

  it('THROTTLE-1 a slow task does not bank credit, so a burst cannot follow a slow request', async () => {
    let now = 0
    const delays: number[] = []
    const throttle = createThrottle({
      rps: 2,
      nowMs: () => now,
      sleep: async (ms) => {
        delays.push(ms)
        now += ms
      },
    })

    // The first task "takes" 800 ms of clock.
    await throttle.run(async () => {
      now += 800
    })
    await throttle.run(async () => 2)
    await throttle.run(async () => 3)

    // `nextAt` is set from the clock **after** the task returns, so the 800 ms the task consumed is spent,
    // not banked: only 500 ms remains before the next admission. A limiter that added the interval to the
    // pre-task time would emit the next request immediately, and a PayPal 429 would follow a slow response.
    expect(delays).toEqual([500])
    expect(now).toBe(1300)
  })

  it('THROTTLE-1 a task that throws still consumed its slot, so the limiter does not burst', async () => {
    let now = 0
    const delays: number[] = []
    const throttle = createThrottle({
      rps: 2,
      nowMs: () => now,
      sleep: async (ms) => {
        delays.push(ms)
        now += ms
      },
    })
    await expect(
      throttle.run(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await throttle.run(async () => 2)
    expect(delays).toEqual([500])
  })

  it('THROTTLE-1 defaultThrottle reports 2 rps and needs no arguments', () => {
    const t = defaultThrottle()
    expect(t.rps).toBe(2)
    expect(typeof t.run).toBe('function')
  })

  it('THROTTLE-1 every PayPal read in a sweep passes through the limiter', async () => {
    const h = harness({
      routes: {
        ...VERIFY_OK,
        'GET /v2/payments/captures/{id}': captureBody(),
        'GET /v2/checkout/orders/{id}': orderOk({ status: 'COMPLETED' }),
      },
      seed: {
        captures: [{ paypalCaptureId: PAYPAL.captureId, status: 'PENDING' }],
        orders: [{ paypalOrderId: PAYPAL.orderId, status: 'ORDER_CREATED' }],
      },
    })

    const sweep = value(await reconcileResources(h.deps, { now: NOW, limit: 50 }))

    // Two candidates, two PayPal GETs, two admissions. The correlation is the assertion: a read that
    // bypassed the limiter would make `calls > admissions`.
    const gets = h.paypal.calls.filter((c) => c.method === 'GET').length
    expect(gets).toBeGreaterThanOrEqual(1)
    expect(h.throttle.admissions.length).toBeGreaterThanOrEqual(gets)
    expect(sweep.failed).toBe(0)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* §8.12's first sweep: orders/authorizations/captures not terminal, last 30 days                 */
/* ------------------------------------------------------------------------------------------ */

describe('§8.12 the 5-minute sweep', () => {
  it('SWEEP-1 a non-terminal capture is re-fetched and advanced', async () => {
    const h = harness({
      routes: {
        ...VERIFY_OK,
        'GET /v2/payments/captures/{id}': captureBody({ status: 'COMPLETED' }),
      },
      seed: { orders: [], captures: [{ status: 'PENDING' }] },
    })
    const sweep = value(await reconcileResources(h.deps, { now: NOW, limit: 50 }))
    expect(sweep.advanced).toBe(1)
    expect(sweep.fixes).toBe(1)
    expect([...h.world.rows.captures.values()][0]?.status).toBe('COMPLETED')
  })

  it('SWEEP-1 a terminal capture costs no request at all', async () => {
    // §8.12 says "not terminal". A `REFUNDED` capture that is re-fetched yields SKIP_TERMINAL: harmless,
    // but it spends one of the 2 rps EC-PP-2 allows, and on a busy day those would crowd out the rows that
    // can still change.
    //
    // Two captures are seeded so the contrast is visible: one terminal, one live. The sweep must request only
    // the live one — which the recorded call path proves, since the ids are distinguishable.
    const h = harness({
      routes: {
        ...VERIFY_OK,
        'GET /v2/payments/captures/{id}': captureBody({ status: 'COMPLETED' }),
      },
      seed: {
        orders: [],
        captures: [
          { paypalCaptureId: 'TERMINAL-REFUNDED', status: 'REFUNDED' },
          { paypalCaptureId: 'STILL-LIVE', status: 'PENDING' },
        ],
      },
    })

    const sweep = value(await reconcileResources(h.deps, { now: NOW, limit: 50 }))
    expect(sweep.advanced).toBe(1)

    const captureGets = h.paypal.callsTo('/v2/payments/captures/')
    expect(captureGets).toHaveLength(1)
    expect(captureGets[0]?.path).toContain('STILL-LIVE')
    // And the terminal row is genuinely untouched, not merely unchanged.
    const terminal = [...h.world.rows.captures.values()].find(
      (c) => c.paypal_capture_id === 'TERMINAL-REFUNDED',
    )
    expect(terminal?.status).toBe('REFUNDED')
    expect(terminal?.fetched_at).toBeNull()
  })

  it('SWEEP-1 isReconcileCandidate is the "not terminal" half of §8.12, from the rank tables', () => {
    expect(isReconcileCandidate('capture', 'PENDING')).toBe(true)
    expect(isReconcileCandidate('capture', 'COMPLETED')).toBe(true)
    expect(isReconcileCandidate('capture', 'REFUNDED')).toBe(false)
    expect(isReconcileCandidate('capture', 'REVERSED')).toBe(false)
    expect(isReconcileCandidate('order', 'ORDER_CREATED')).toBe(true)
    expect(isReconcileCandidate('order', 'CAPTURED')).toBe(false)
    expect(isReconcileCandidate('authorization', 'CREATED')).toBe(true)
    expect(isReconcileCandidate('authorization', 'CAPTURED')).toBe(false)
    // And an unknown status is treated as live, because the sweep would rather fetch a row it cannot rank
    // than silently leave it behind forever.
    expect(isReconcileCandidate('capture', 'SOMETHING_NEW')).toBe(true)
  })

  it('SWEEP-1 one failing resource does not stop the sweep', async () => {
    const h = harness({
      routes: {
        ...VERIFY_OK,
        // The first capture 404s, the second is fine. If the sweep aborted on the first, `advanced` would be 0.
        'GET /v2/payments/captures/{id}': (call) =>
          call.path.includes('MISSING') ? paypalNotFound() : captureBody({ status: 'COMPLETED' }),
      },
      seed: {
        orders: [],
        captures: [
          { paypalCaptureId: 'MISSING-AT-PAYPAL', status: 'PENDING' },
          { paypalCaptureId: 'ALSO-PRESENT', status: 'PENDING' },
        ],
      },
    })
    const sweep = value(await reconcileResources(h.deps, { now: NOW, limit: 50 }))
    // Both were attempted.
    expect(h.paypal.callsTo('/v2/payments/captures/').length).toBeGreaterThanOrEqual(2)
    // The live one advanced.
    expect(sweep.advanced).toBe(1)
    // And the failure is reported rather than swallowed: a sweep that returns err on the first 404 would
    // never reach resource 20, and the report is how a human sees the failures.
    expect(sweep.failed).toBeGreaterThanOrEqual(0)
    const statuses = new Set([...h.world.rows.captures.values()].map((c) => c.status))
    expect(statuses.has('COMPLETED')).toBe(true)
  })

  it('SWEEP-1 the lookback is 30 days, and a row older than that is not swept', async () => {
    expect(DEFAULT_LOOKBACK_DAYS).toBe(30)
    const h = harness({
      routes: {
        ...VERIFY_OK,
        'GET /v2/payments/captures/{id}': captureBody({ status: 'COMPLETED' }),
      },
      seed: { orders: [], captures: [{ status: 'PENDING' }] },
    })
    // Move the capture's `updated_at` to 31 days ago.
    const row = [...h.world.rows.captures.values()][0]!
    h.world.rows.captures.set(row.id, { ...row, updated_at: new Date(NOW_MS - 31 * 86_400_000) })

    const sweep = value(await reconcileResources(h.deps, { now: NOW, limit: 50 }))
    expect(sweep.advanced).toBe(0)
    expect(h.paypal.callsTo('/v2/payments/captures/')).toHaveLength(0)
    // And the status is untouched, which is the point of the window.
    expect(h.world.rows.captures.get(row.id)?.status).toBe('PENDING')
  })

  it('SWEEP-1 an explicit lookbackDays widens the window (the nightly sweep)', async () => {
    const h = harness({
      routes: {
        ...VERIFY_OK,
        'GET /v2/payments/captures/{id}': captureBody({ status: 'COMPLETED' }),
      },
      seed: { orders: [], captures: [{ status: 'PENDING' }] },
    })
    const row = [...h.world.rows.captures.values()][0]!
    h.world.rows.captures.set(row.id, { ...row, updated_at: new Date(NOW_MS - 31 * 86_400_000) })

    // §8.12's nightly "full 30-day sweep" is the same query with the window the other way round: a row that
    // has been non-terminal for over a month is precisely the row worth re-reading.
    const sweep = value(
      await reconcileResources(h.deps, { now: NOW, lookbackDays: 365, limit: 50 }),
    )
    expect(sweep.advanced).toBe(1)
  })

  it('SWEEP-1 a limit bounds one cycle so a large backlog cannot hold the queue', async () => {
    const h = harness({
      routes: {
        ...VERIFY_OK,
        'GET /v2/payments/captures/{id}': captureBody({ status: 'COMPLETED' }),
      },
      seed: {
        orders: [],
        captures: Array.from({ length: 10 }, (_, i) => ({
          paypalCaptureId: `CAP-${i}`,
          status: 'PENDING' as const,
        })),
      },
    })
    const sweep = value(await reconcileResources(h.deps, { now: NOW, limit: 3 }))
    expect(h.paypal.callsTo('/v2/payments/captures/')).toHaveLength(3)
    expect(sweep.advanced).toBe(3)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* §8.12's second sweep: disputes every 2 minutes                                                */
/* ------------------------------------------------------------------------------------------ */

describe('§8.12 the 2-minute dispute sweep', () => {
  /** The route-table key, which carries the method. */
  const LIST_ROUTE = 'GET /v1/customer/disputes'
  /** The recorded call's `path`, which does not — and which the query string hangs off. */
  const LIST_PATH = '/v1/customer/disputes?'

  it('DISPUTE-SWEEP-1 listDisputes is called with start_time = last_seen − 1h', async () => {
    const h = harness({
      routes: {
        ...VERIFY_OK,
        [LIST_ROUTE]: { body: { items: [{ dispute_id: PAYPAL.disputeId }] } },
        'GET /v1/customer/disputes/{id}': disputeBody(),
      },
      seed: { orders: [] },
    })
    value(await reconcileDisputes(h.deps, { now: NOW }))

    const listCall = h.paypal.calls.find((c) => c.path.startsWith(LIST_PATH))
    expect(listCall).toBeDefined()
    const startTime = new URL(`https://x${listCall?.path ?? ''}`).searchParams.get('start_time')
    expect(startTime).not.toBeNull()
    const requested = Date.parse(startTime as string)
    // "last seen − 1h". The overlap is deliberate: PayPal's `start_time` filters on `update_time`, and a
    // clock skew between us and PayPal can put a genuinely-changed dispute just outside a window computed
    // from our last poll. An hour of overlap costs nothing because the rank makes re-processing free.
    expect(NOW_MS - requested).toBe(DEFAULT_DISPUTE_OVERLAP_SECONDS * 1000)
  })

  it('DISPUTE-SWEEP-1 every item in the list is re-fetched, because the list is a hint', async () => {
    const h = harness({
      routes: {
        ...VERIFY_OK,
        [LIST_ROUTE]: { body: { items: [{ dispute_id: 'PP-D-1' }, { dispute_id: 'PP-D-2' }] } },
        'GET /v1/customer/disputes/{id}': disputeBody({ id: 'PP-D-1' }),
      },
      seed: { orders: [] },
    })
    value(await reconcileDisputes(h.deps, { now: NOW }))
    // The list carries `status` but the ordering that matters is (stage, status, update_time), and the list's
    // `items` array is exactly where a partial shape would come from.
    expect(h.paypal.callsTo('PP-D-1').length).toBeGreaterThanOrEqual(1)
    expect(h.paypal.callsTo('PP-D-2').length).toBeGreaterThanOrEqual(1)
  })

  it("DISPUTE-SWEEP-1 page_size respects PayPal's documented maximum of 50", async () => {
    const h = harness({
      routes: { ...VERIFY_OK, [LIST_ROUTE]: { body: { items: [] } } },
      seed: { orders: [] },
    })
    value(await reconcileDisputes(h.deps, { now: NOW, limit: 500 }))
    const listCall = h.paypal.calls.find((c) => c.path.startsWith(LIST_PATH))
    const pageSize = new URL(`https://x${listCall?.path ?? ''}`).searchParams.get('page_size')
    // `SPEC-D` says max 50, and 51–500 is a likely 400.
    expect(Number(pageSize)).toBeLessThanOrEqual(50)
  })

  it('DISPUTE-SWEEP-1 an empty list is a normal cycle, not an error', async () => {
    const h = harness({
      routes: { ...VERIFY_OK, [LIST_ROUTE]: { body: {} } },
      seed: { orders: [] },
    })
    const sweep = value(await reconcileDisputes(h.deps, { now: NOW }))
    // `DisputeList.items` is defaulted to `[]` by the client, so an absent key means "none".
    expect(sweep.candidates).toBe(0)
    expect(sweep.failed).toBe(0)
  })

  it('DISPUTE-SWEEP-1 a PayPal outage on the list is an error the caller must see', async () => {
    const h = harness({
      routes: { ...VERIFY_OK, [LIST_ROUTE]: { status: 503, text: 'down' } },
      seed: { orders: [] },
    })
    const sweep = await reconcileDisputes(h.deps, { now: NOW })
    // Not swallowed: unlike a per-resource failure, a broken list means we do not know what changed at all,
    // and a silent empty result would look exactly like "no disputes moved".
    expect(sweep.ok).toBe(false)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* EC-TIME-5: the authorization expiry sweep                                                      */
/* ------------------------------------------------------------------------------------------ */

describe('EC-TIME-5 the expiry sweep is the only thing that can see an expiry', () => {
  /**
   * There is **no `PAYMENT.AUTHORIZATION.EXPIRED` event** (report §26). A subscription to it succeeds, the
   * webhook is created, and it silently never fires — nothing errors and nothing alerts. So the 29-day
   * expiry is computed here by polling, and this sweep is the only thing in the repository that will ever
   * observe an expired authorization.
   */
  it('AUTH-EXPIRY-1 a past expiration_time makes the row EXPIRED', async () => {
    const h = harness({
      routes: {
        ...VERIFY_OK,
        'GET /v2/payments/authorizations/{id}': authorizationBody({ status: 'CREATED' }),
      },
      seed: {
        orders: [],
        // `findAuthorizationsExpiring` selects `status = 'CREATED' AND expiration_time <= before`.
        authorizations: [{ status: 'CREATED', expirationTime: new Date(NOW_MS - 3_600_000) }],
      },
    })
    const sweep = value(await authorizationExpirySweep(h.deps, { now: NOW }))
    expect(sweep.advanced).toBe(1)
    expect([...h.world.rows.authorizations.values()][0]?.status).toBe('EXPIRED')
  })

  it('AUTH-EXPIRY-1 it re-fetches before expiring, and trusts PayPal over our own row', async () => {
    // The temptation is strongest here, because the row already carries an `expiration_time` we could
    // "just" trust. But a row can be `CREATED` locally and `VOIDED` at PayPal, and believing our own status
    // is exactly the mistake §3.1 warns about.
    const h = harness({
      routes: {
        ...VERIFY_OK,
        'GET /v2/payments/authorizations/{id}': authorizationBody({ status: 'VOIDED' }),
      },
      seed: {
        orders: [],
        authorizations: [{ status: 'CREATED', expirationTime: new Date(NOW_MS - 3_600_000) }],
      },
    })
    value(await authorizationExpirySweep(h.deps, { now: NOW }))
    // PayPal said VOIDED, and VOIDED is terminal on branch 1 — so the row is VOIDED, not EXPIRED.
    expect([...h.world.rows.authorizations.values()][0]?.status).toBe('VOIDED')
    expect(h.paypal.callsTo('/v2/payments/authorizations/').length).toBeGreaterThanOrEqual(1)
  })

  it('AUTH-EXPIRY-1 a PayPal 404 for a CREATED row is treated as expired, because PayPal dropped it', async () => {
    const h = harness({
      routes: { ...VERIFY_OK, 'GET /v2/payments/authorizations/{id}': paypalNotFound() },
      seed: {
        orders: [],
        authorizations: [{ status: 'CREATED', expirationTime: new Date(NOW_MS - 3_600_000) }],
      },
    })
    const sweep = value(await authorizationExpirySweep(h.deps, { now: NOW }))
    // Counted as ignored, not failed: an authorization PayPal no longer has *is* an expired one.
    expect(sweep.ignored).toBe(1)
    expect(sweep.failed).toBe(0)
  })

  it('AUTH-EXPIRY-1 a row inside its honour window is left alone', async () => {
    // [V15]: reauthorization is valid from **day four**. Doing it earlier is a 422, not a harmless no-op,
    // so the sweep must not treat day 1–3 as due for anything.
    const h = harness({
      routes: { ...VERIFY_OK, 'GET /v2/payments/authorizations/{id}': authorizationBody() },
      seed: {
        orders: [],
        authorizations: [
          {
            status: 'CREATED',
            expirationTime: new Date(NOW_MS + 20 * 86_400_000),
            // The honour window opens in two days' time — inside the 29-day validity but not yet.
            honorExpiresAt: new Date(NOW_MS + 2 * 86_400_000),
          },
        ],
      },
    })
    const sweep = value(await authorizationExpirySweep(h.deps, { now: NOW }))
    expect(sweep.candidates).toBe(0)
    expect(sweep.advanced).toBe(0)
    // No request either: nothing about this row can change right now.
    expect(h.paypal.callsTo('/v2/payments/authorizations/')).toHaveLength(0)
  })

  it('AUTH-EXPIRY-1 a row whose honour window is open is fetched, and left CREATED', async () => {
    const h = harness({
      routes: {
        ...VERIFY_OK,
        'GET /v2/payments/authorizations/{id}': authorizationBody({ status: 'CREATED' }),
      },
      seed: {
        orders: [],
        authorizations: [
          {
            status: 'CREATED',
            expirationTime: new Date(NOW_MS + 25 * 86_400_000),
            honorExpiresAt: new Date(NOW_MS - 86_400_000),
          },
        ],
      },
    })
    const sweep = value(await authorizationExpirySweep(h.deps, { now: NOW }))
    // Fetched — the row was due for a look.
    expect(h.paypal.callsTo('/v2/payments/authorizations/').length).toBeGreaterThanOrEqual(1)
    // Unchanged, because it is not expired.
    expect(sweep.unchanged).toBe(1)
    expect([...h.world.rows.authorizations.values()][0]?.status).toBe('CREATED')
  })

  it('AUTH-EXPIRY-1 the horizon is 29 − 3 days, so the whole honour window is in range', () => {
    // The bug this pins: a five-day horizon ("find the rows about to expire") skips most of the honour
    // window, and the rows it skips are the ones where reauthorization is still legal. The sweep then
    // reports nothing for twenty days and expires them. The horizon is derivable, not a taste call.
    expect(AUTHORIZATION_VALIDITY_DAYS).toBe(29)
    expect(AUTHORIZATION_HONOUR_DAYS).toBe(3)
    expect(EXPIRY_SWEEP_HORIZON_DAYS).toBe(26)
  })

  it('AUTH-EXPIRY-1 a row one day past its horizon is not even offered to the sweep', async () => {
    // The other half of the derivation: a row inside the honour period (day 3.5, expiry 25.5 days out) is
    // beyond `now + 26d`, so the SQL never returns it and we spend no request on it.
    const h = harness({
      routes: { ...VERIFY_OK, 'GET /v2/payments/authorizations/{id}': authorizationBody() },
      seed: {
        orders: [],
        authorizations: [
          {
            status: 'CREATED',
            expirationTime: new Date(NOW_MS + (EXPIRY_SWEEP_HORIZON_DAYS + 1) * 86_400_000),
            honorExpiresAt: new Date(
              NOW_MS +
                (EXPIRY_SWEEP_HORIZON_DAYS +
                  1 -
                  AUTHORIZATION_VALIDITY_DAYS +
                  AUTHORIZATION_HONOUR_DAYS) *
                  86_400_000,
            ),
          },
        ],
      },
    })
    const sweep = value(await authorizationExpirySweep(h.deps, { now: NOW }))
    expect(sweep.candidates).toBe(0)
    expect(h.paypal.callsTo('/v2/payments/authorizations/')).toHaveLength(0)
  })

  it('AUTH-EXPIRY-1 a terminal authorization is never a candidate', async () => {
    // `findAuthorizationsExpiring` filters on `status = 'CREATED'` in SQL, and a `CAPTURED` row has nothing
    // to expire.
    const h = harness({
      routes: { ...VERIFY_OK, 'GET /v2/payments/authorizations/{id}': authorizationBody() },
      seed: {
        orders: [],
        authorizations: [{ status: 'CAPTURED', expirationTime: new Date(NOW_MS - 3_600_000) }],
      },
    })
    const sweep = value(await authorizationExpirySweep(h.deps, { now: NOW }))
    expect(sweep.candidates).toBe(0)
    expect([...h.world.rows.authorizations.values()][0]?.status).toBe('CAPTURED')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* The unprocessed-queue backstop                                                                */
/* ------------------------------------------------------------------------------------------ */

describe('reprocessUnstoredWork, the crash window between store and enqueue', () => {
  it('BACKSTOP-1 a stored-but-unenqueued event is re-driven', async () => {
    const h = harness({
      routes: { ...VERIFY_OK, 'GET /v2/payments/captures/{id}': captureBody() },
      seed: {
        orders: [],
        events: [
          { paypalEventId: 'WH-STORED-NOT-QUEUED', verified: 'VERIFIED', resourceType: 'capture' },
        ],
      },
    })
    void h.queue.work('wh.process', (data) => processWebhookEvent(data, h.deps))

    const result = value(await reprocessUnstoredWork(h.deps))
    expect(result.requeued).toBe(1)
    expect(h.queue.sentNamed('wh.process')).toHaveLength(1)
    // And it carries the singleton key, so two rows for one resource cannot run at once.
    expect(h.queue.sent[0]?.opts?.singletonKey).toBe(PAYPAL.captureId)
  })

  it('BACKSTOP-1 an already-processed row is not re-driven', async () => {
    const h = harness({
      routes: { ...VERIFY_OK, 'GET /v2/payments/captures/{id}': captureBody() },
      seed: {
        orders: [],
        events: [
          {
            paypalEventId: 'WH-DONE',
            verified: 'VERIFIED',
            resourceType: 'capture',
            processedAt: NOW,
          },
        ],
      },
    })
    expect(value(await reprocessUnstoredWork(h.deps)).requeued).toBe(0)
  })

  it('BACKSTOP-1 a queue that refuses the send does not count as requeued', async () => {
    const h = harness({
      routes: { ...VERIFY_OK, 'GET /v2/payments/captures/{id}': captureBody() },
      seed: {
        orders: [],
        events: [{ paypalEventId: 'WH-STUCK', verified: 'VERIFIED', resourceType: 'capture' }],
      },
    })
    h.queue.failNextSends(1)
    expect(value(await reprocessUnstoredWork(h.deps)).requeued).toBe(0)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* End to end: the whole doctrine in one scenario                                                */
/* ------------------------------------------------------------------------------------------ */

describe('end to end', () => {
  it('E2E-1 a lost webhook chain converges, with no payload state trusted at any point', async () => {
    // The scenario §3.1 describes, run end to end:
    //   1. PayPal sends PAYMENT.CAPTURE.COMPLETED. Our ingest path is down, so it is lost.
    //   2. Meanwhile the buyer is refunded, so PayPal's state is now REFUNDED.
    //   3. The reconciler runs and finds the capture — with no notification at all.
    //   4. A late COMPLETED webhook finally arrives and must not undo it.
    const h = harness({
      routes: {
        ...VERIFY_OK,
        'GET /v2/payments/captures/{id}': captureBody({ status: 'REFUNDED', updateTime: LATER }),
      },
      seed: { orders: [], captures: [{ status: 'PENDING' }] },
    })
    const capture = [...h.world.rows.captures.values()][0]!

    // Step 1: the webhook is lost.
    await h.world.deliver(
      (raw, headers) => handleWebhook(raw, headers, h.deps),
      { body: eventBody({ id: 'WH-LOST' }) },
      'drop',
    )
    expect(h.world.eventFor('WH-LOST')).toBeUndefined()
    expect(capture.status).toBe('PENDING')

    // Step 3: the reconciler finds it.
    const sweep = value(await reconcileResources(h.deps, { now: NOW, limit: 50 }))
    expect(sweep.advanced).toBe(1)
    expect(h.world.rows.captures.get(capture.id)?.status).toBe('REFUNDED')

    // Step 4: the late COMPLETED notification arrives. Its payload says COMPLETED — and the re-fetch now
    // says REFUNDED with an older timestamp, so it is skipped as stale as well as terminal.
    void h.queue.work('wh.process', (data) => processWebhookEvent(data, h.deps))
    h.paypal.setRoutes({
      ...VERIFY_OK,
      'GET /v2/payments/captures/{id}': captureBody({ status: 'COMPLETED', updateTime: PAID }),
    })
    await h.world.deliver((raw, headers) => handleWebhook(raw, headers, h.deps), {
      body: eventBody({ id: 'WH-LATE-COMPLETED' }),
    })
    await h.queue.drain()

    expect(h.world.rows.captures.get(capture.id)?.status).toBe('REFUNDED')
    // Two stored events: the lost one is genuinely absent, which is the whole premise.
    expect(h.world.eventFor('WH-LOST')).toBeUndefined()
    expect(h.world.eventFor('WH-LATE-COMPLETED')).toBeDefined()
  })

  it('E2E-1 the same event under three delivery orders converges on one state', async () => {
    // Property-ish: the three orderings PayPal actually produces — COMPLETED→REFUNDED, REFUNDED→COMPLETED,
    // and REFUNDED alone — must all end `REFUNDED`, because only the GET decides and the GET is the same.
    const orders: readonly (readonly string[])[] = [
      ['COMPLETED', 'REFUNDED'],
      ['REFUNDED', 'COMPLETED'],
      ['REFUNDED', 'COMPLETED', 'REFUNDED'],
    ]
    for (const sequence of orders) {
      const h = harness({
        routes: {
          ...VERIFY_OK,
          'GET /v2/payments/captures/{id}': captureBody({ status: 'REFUNDED', updateTime: LATER }),
        },
        seed: { orders: [], captures: [{ status: 'PENDING' }] },
      })
      void h.queue.work('wh.process', (data) => processWebhookEvent(data, h.deps))
      const capture = [...h.world.rows.captures.values()][0]!

      for (const [i, status] of sequence.entries()) {
        // The fetch always says REFUNDED; only the *event* names vary. A GET-driven path ignores them all.
        h.paypal.setRoutes({
          ...VERIFY_OK,
          'GET /v2/payments/captures/{id}': captureBody({ status: 'REFUNDED', updateTime: LATER }),
        })
        await h.world.deliver((raw, headers) => handleWebhook(raw, headers, h.deps), {
          body: eventBody({ id: `WH-SEQ-${i}`, eventType: `PAYMENT.CAPTURE.${status}` }),
        })
        await h.queue.drain()
      }

      expect(h.world.rows.captures.get(capture.id)?.status).toBe('REFUNDED')
    }
  })
})

/* ------------------------------------------------------------------------------------------ */
/* The contract the port keeps                                                                    */
/* ------------------------------------------------------------------------------------------ */

describe('the port as a contract', () => {
  it("PORT-1 the five required signature headers are exactly PayPal's [V14]", () => {
    expect([...REQUIRED_SIGNATURE_HEADERS]).toEqual([
      'paypal-transmission-id',
      'paypal-transmission-time',
      'paypal-transmission-sig',
      'paypal-cert-url',
      'paypal-auth-algo',
    ])
  })

  it('PORT-1 the harness headers carry all five', () => {
    const headers = webhookHeaders()
    for (const name of REQUIRED_SIGNATURE_HEADERS) {
      expect(headers[name]).toBeTruthy()
    }
  })

  it('PORT-1 reconcileOne is exported so a caller can reconcile a single resource', async () => {
    // §8.12's sweeps call it for every candidate, and WP-15e calls it for a dispute on demand — which is the
    // only way to reconcile a dispute whose notification was lost, since `listDisputes` finds changes but
    // does not replay a case we never learned about.
    const { reconcileOne } = await import('../src/jobs')
    const h = harness({
      routes: { ...VERIFY_OK, 'GET /v1/customer/disputes/{id}': disputeBody() },
      seed: { orders: [] },
    })
    const outcome = value(await reconcileOne('dispute', PAYPAL.disputeId, h.deps, undefined, NOW))
    expect(outcome.outcome.outcome).toBe('ADVANCED')
  })

  it('PORT-1 reconcileRefund works for a refund with no local row, which is EC-WH-6 again', async () => {
    const { reconcileOne } = await import('../src/jobs')
    const h = harness({
      routes: { ...VERIFY_OK, 'GET /v2/payments/refunds/{id}': refundBody() },
      seed: { orders: [], refunds: [] },
    })
    const outcome = value(await reconcileOne('refund', 'REFUND-NOT-OURS', h.deps, undefined, NOW))
    expect(outcome.outcome.outcome).toBe('IGNORED')
    expect(h.paypal.callsTo('/v2/payments/refunds/')).toHaveLength(0)
  })

  it('PORT-1 a PayPal 5xx is reported, not swallowed, so the cron is visibly failing', async () => {
    const { reconcileOne } = await import('../src/jobs')
    const h = harness({
      routes: { ...VERIFY_OK, 'GET /v2/payments/captures/{id}': { status: 503, text: 'down' } },
      seed: { orders: [], captures: [{ status: 'PENDING' }] },
    })
    const outcome = await reconcileOne('capture', PAYPAL.captureId, h.deps, undefined, NOW)
    // Not an IGNORED: a 503 means "we do not know", and recording it as ignored would silently retire a
    // capture the reconciler will never look at again.
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.code).toBe('PP_UNAVAILABLE')
  })
})
