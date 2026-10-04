/**
 * The test harness — one `fetch` double, one in-memory `WebhookStore`, one queue, one `WebhookDeps`.
 *
 * ## What is faked, and what is not
 *
 * AGENTS.md rule 5: *"Never fake PayPal behaviour. No mocking of PayPal outside
 * `packages/paypal/test/fixtures`."* This harness replaces exactly two things:
 *
 *  - **the socket**, via `PayPalClientOpts.fetchImpl` — the seam the real client already declares. Every test
 *    drives the real `PayPalClient`, so request building, header assembly, the retry loop, the backoff, the
 *    circuit breaker and the zod validation all run for real. The *responses* are doc-derived stubs, which is
 *    the same seam `packages/paypal/test/fixtures/transport-double.ts` uses; nothing here decides what
 *    PayPal would have done.
 *
 *    **`oauthRoute()` is part of the default route table and must stay there.** The client takes a bearer
 *    token before every call, so a missing `POST /v1/oauth2/token` stub answers 422, the token never
 *    resolves, and *every* call in the test fails as `PP_UNAVAILABLE` — which for the webhook path looks
 *    exactly like EC-WH-7 and would make a green test green for the wrong reason. That mistake was made and
 *    is what the warning on `harness()` is for.
 *  - **our own rows**, via an in-memory {@link WebhookStore}.
 *
 * ## Why the store double's fidelity is the whole point of AT-M12.3
 *
 * "A dropped webhook → the reconciler fixes the state within one cycle" is only a real test if the harness
 * can actually drop one. Three properties make it one, and each of them is a way a lazier double would let a
 * bug through:
 *
 *  1. **The webhook channel is a real channel, and it can drop.** {@link InMemoryWorld.deliver} takes a
 *     decision and, when the decision is `drop`, records the attempt and stores **nothing** — no row, no
 *     queue job, no fetch. A double that "simulates loss" by deleting the row afterwards would still leave
 *     the ingest path's own writes (audit entries, attempts) behind, and the test would be asserting on a
 *     world that never existed. The log of what PayPal *tried* to send is kept separately from what we
 *     stored, so a test can prove "PayPal sent one event, we stored none".
 *  2. **`ON CONFLICT DO NOTHING` is modelled as a constraint, not as a flag.** `webhook_events` is keyed by
 *     `paypal_event_id`, the redelivery does **not** bump `received_at`, does **not** overwrite `raw`, and
 *     does **not** clear `verified`. A double that merged the two deliveries would pass AT-M12.1's "processed
 *     once" while being wrong about the case file.
 *  3. **The aggregate writes are rank-guarded in the store too, and the double refuses visibly.**
 *     `captures.applyFromFetch` returns `applied: false` rather than throwing when a write would move the
 *     rank backwards, so "the monotonic rule held" is an assertion on the double's answer and not only on the
 *     pure function's. The `transactions`/`snapshot` pair exists for the same reason
 *     `createInMemoryOrderWorld` has one: a stand-in that only releases locks would let an aborted write
 *     pass a test the real `withTx` would roll back.
 *
 * ## One fixed instant, everywhere
 *
 * `NOW_SEC` and a `fixedClock` mean every timestamp is a constant and no assertion is about "roughly now"
 * (AGENTS.md rule 10). `NOW_MS` is derived from it so a test can write `NOW_MS - 60_000` and know exactly
 * what "a minute ago" means to the code under test.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  csError,
  fixedClock,
  type Clock,
  type CsError,
  type Logger,
  type OrderId,
  type WebhookEventId,
} from '@countersign/core'
import type {
  AuthorizationRow,
  AuthorizationStatus,
  CaptureRow,
  CaptureStatus,
  DisputeRow,
  DisputeStage,
  DisputeStatus,
  JsonValue,
  Money,
  NewWebhookEvent,
  OrderRow,
  OrderStatus,
  RefundRow,
  RefundStatus,
  WebhookEventRow,
} from '@countersign/db'
import { PayPalClient, type Sleep } from '@countersign/paypal'
import { describe, expect, it } from 'vitest'

import { handleWebhook } from '../src/ingest'
import { encodeStoredRaw } from '../src/signature'
import { isTerminalStatus } from '../src/status-rank'
import type {
  EnqueueOptions,
  JobHandler,
  JobName,
  StoredEvent,
  Throttle,
  UpsertDisputeInput,
  WebhookAck,
  WebhookAudit,
  WebhookDeps,
  WebhookQueue,
  WebhookStore,
} from '../src/types'

/* ------------------------------------------------------------------------------------------ */
/* Constants                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Every test's "now". A constant, so no assertion is about wall time. */
export const NOW_SEC = 1_789_000_000
export const NOW_MS = NOW_SEC * 1000
export const NOW = new Date(NOW_MS)

export const PAID = '2026-10-04T12:00:00Z'
export const LATER = '2026-10-04T12:05:00Z'
export const EARLIER = '2026-10-04T11:55:00Z'

export const PAYPAL = {
  orderId: '5O190127TN364715T',
  authorizationId: '8AB12345AB6789123',
  captureId: '3C679366HH908993F',
  refundId: '1JU08902781691411',
  disputeId: 'PP-D-2781AB12CD34',
  trackerId: 'TRACKER-1Z999AA10123456784',
} as const

export const OUR = {
  orderId: 'ord_00000000000000000000000001' as OrderId,
  authorizationId: 'aut_00000000000000000000000001',
  captureId: 'cap_00000000000000000000000001',
  refundId: 'ref_00000000000000000000000001',
  disputeId: 'dsp_00000000000000000000000001',
} as const

export const WEBHOOK_ID = '0AB12345CD678912E'

export const WEBHOOK_ID_HEADER = 'WH-0000000000000000'

/* ------------------------------------------------------------------------------------------ */
/* The fetch double                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface RecordedCall {
  readonly index: number
  readonly method: string
  readonly path: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

/** A stubbed HTTP response. Doc-derived, never captured (H-01 is open). */
export interface StubResponse {
  readonly status?: number
  readonly body?: unknown
  /** Sent verbatim, no content-type. What PayPal's edge returns on a 503. */
  readonly text?: string
  readonly headers?: Record<string, string>
  /** Throw instead of responding — a connection reset. */
  readonly throws?: Error
}

/**
 * One route's answer.
 *
 * A function may return a `Promise`, which is what makes "the verify endpoint hangs" expressible — a route
 * that never resolves is the only honest way to test a timeout, and pretending otherwise with a fake timer
 * would not exercise the race the timeout exists for.
 */
export type RouteResponder = (call: RecordedCall) => StubResponse | Promise<StubResponse>

export type Routes = Record<string, StubResponse | StubResponse[] | RouteResponder>

/**
 * Segment-wise path matching with `{id}` as a one-segment wildcard.
 *
 * Exact for the reason the orders harness documents it: `/v2/payments/authorizations/{id}/capture` and
 * `/v2/checkout/orders/{id}/capture` share their last two segments, so a substring matcher would answer a
 * payments capture with the order's capture stub and the assertion would pass for the wrong reason.
 */
/**
 * Segment-wise path matching with `{id}` as a one-segment wildcard, and the query string ignored.
 *
 * The segment count is checked on purpose: `/v2/payments/authorizations/{id}/capture` and
 * `/v2/checkout/orders/{id}/capture` share their last two segments, so a substring matcher would answer a
 * payments capture with the order's capture stub and the assertion would pass for the wrong reason.
 *
 * The query is stripped because `GET /v1/customer/disputes` and
 * `GET /v1/customer/disputes?page_size=50` are the same endpoint, and the reconciler's dispute sweep only
 * ever asks for the second one.
 */
export function matchesTemplate(path: string, template: string): boolean {
  const q = path.indexOf('?')
  const bare = q === -1 ? path : path.slice(0, q)
  const a = bare.split('/')
  const b = template.split('/')
  if (a.length !== b.length) return false
  return b.every((seg, i) => seg.startsWith('{') || seg === a[i])
}

function normaliseHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {}
  const h = init?.headers
  if (!h) return out
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v
    })
    return out
  }
  if (Array.isArray(h)) for (const [k, v] of h) out[String(k).toLowerCase()] = String(v)
  for (const [k, v] of Object.entries(h as Record<string, string>)) {
    out[k.toLowerCase()] = String(v)
  }
  return out
}

function toResponse(spec: StubResponse, index: number): Response {
  if (spec.throws) throw spec.throws
  const status = spec.status ?? 200
  const headers = new Headers({
    'paypal-debug-id': `DEBUG-TEST-${index}`,
    ...(spec.headers ?? {}),
  })
  if (status === 204 || status === 205 || status === 304)
    return new Response(null, { status, headers })
  if (spec.text !== undefined) return new Response(spec.text, { status, headers })
  if (spec.body === undefined) return new Response(null, { status, headers })
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(spec.body), { status, headers })
}

export interface FakePayPal {
  readonly fetchImpl: typeof fetch
  readonly calls: RecordedCall[]
  callsTo(fragment: string): RecordedCall[]
  /** The body of the nth call to a path fragment, parsed. */
  bodyOf<T = Record<string, unknown>>(fragment: string, nth?: number): T
  setRoutes(routes: Routes): void
  onBeforeRespond(hook: (call: RecordedCall) => void): void
  reset(): void
}

/**
 * A routing `fetch` double.
 *
 * **An unmatched call answers 422** rather than hanging, so a test that reaches an unstubbed endpoint fails
 * loudly with PayPal's own `UNPROCESSABLE_ENTITY` envelope instead of timing out at 20 s.
 *
 * A queue is consumed one entry per call and the last entry repeats, which is how "503, 503, 200" is
 * written. `setRoutes` resets the counters.
 */
export function fakePayPal(routes: Routes = {}): FakePayPal {
  const calls: RecordedCall[] = []
  const counters = new Map<string, number>()
  const hooks: ((call: RecordedCall) => void)[] = []
  let table = routes

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const queryAt = path.indexOf('?')
    const pathOnly = queryAt === -1 ? path : path.slice(0, queryAt)
    const method = (init?.method ?? 'GET').toUpperCase()
    const record: RecordedCall = {
      index: calls.length,
      method,
      path,
      url,
      headers: normaliseHeaders(init),
      body: init?.body,
    }
    calls.push(record)

    for (const [key, value] of Object.entries(table)) {
      const [routeMethod, routeTemplate] = key.includes(' ') ? key.split(' ', 2) : [undefined, key]
      if (routeMethod !== undefined && routeMethod.toUpperCase() !== method) continue
      // The query string is **stripped** before matching. A template like `GET /v1/customer/disputes`
      // must match `/v1/customer/disputes?page_size=50&start_time=…`, and segment-count matching would
      // otherwise see two segments against one and answer 422 — which on the reconciler's dispute sweep is
      // indistinguishable from "PayPal has no such endpoint". Six tests failed that way.
      if (!matchesTemplate(pathOnly, routeTemplate ?? key)) continue
      const n = counters.get(key) ?? 0
      counters.set(key, n + 1)
      const spec =
        typeof value === 'function'
          ? (value as (c: RecordedCall) => StubResponse)(record)
          : Array.isArray(value)
            ? (value[Math.min(n, value.length - 1)] as StubResponse)
            : (value as StubResponse)
      for (const hook of hooks) hook(record)
      return toResponse(spec, record.index)
    }

    return toResponse(
      {
        status: 422,
        body: {
          name: 'UNPROCESSABLE_ENTITY',
          message: `No stub for ${method} ${path}`,
          debug_id: 'DEBUG-UNSTUBBED',
          details: [],
        },
      },
      record.index,
    )
  }

  return {
    fetchImpl: impl as typeof fetch,
    calls,
    callsTo: (fragment) => calls.filter((c) => c.path.includes(fragment)),
    bodyOf<T>(fragment: string, nth = 0): T {
      const call = calls.filter((c) => c.path.includes(fragment))[nth]
      if (!call || typeof call.body !== 'string') {
        throw new Error(`No JSON body on call ${nth} to a path containing "${fragment}"`)
      }
      return JSON.parse(call.body) as T
    },
    setRoutes: (next) => {
      table = next
      counters.clear()
    },
    onBeforeRespond: (hook) => {
      hooks.push(hook)
    },
    reset: () => {
      calls.length = 0
      counters.clear()
    },
  }
}

/** A sleep that records instead of waiting. Zero real milliseconds pass anywhere in these tests. */
export function recordingSleep(): { sleep: Sleep; readonly delays: number[] } {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms)
    },
  }
}

export function testClock(): Clock & { set(sec: number): void; advance(sec: number): void } {
  return fixedClock(NOW_SEC)
}

/* ------------------------------------------------------------------------------------------ */
/* Doc-derived PayPal bodies                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** `GET /v2/payments/captures/{id}`. Doc: developer.paypal.com/docs/api/payments/v2/#captures_get */
export function captureBody(
  over: {
    id?: string
    status?: string
    updateTime?: string
    statusUpdateTime?: string
    value?: string
    currency?: string
    finalCapture?: boolean
  } = {},
): StubResponse {
  const updateTime = over.updateTime ?? PAID
  return {
    body: {
      id: over.id ?? PAYPAL.captureId,
      status: over.status ?? 'COMPLETED',
      status_update_time: over.statusUpdateTime ?? updateTime,
      update_time: updateTime,
      create_time: '2026-10-04T11:59:00Z',
      amount: { currency_code: over.currency ?? 'USD', value: over.value ?? '60.00' },
      final_capture: over.finalCapture ?? true,
      invoice_id: 'INV2-0000000000000000',
      custom_id: 'cs:ord_00000000000000000000000001',
      seller_protection: { status: 'ELIGIBLE' },
      disbursement_mode: 'INSTANT',
    },
  }
}

/** `GET /v2/payments/refunds/{id}`. Doc: developer.paypal.com/docs/api/payments/v2/#refunds_get */
export function refundBody(
  over: {
    id?: string
    status?: string
    updateTime?: string
    value?: string
  } = {},
): StubResponse {
  return {
    body: {
      id: over.id ?? PAYPAL.refundId,
      status: over.status ?? 'COMPLETED',
      status_update_time: over.updateTime ?? PAID,
      update_time: over.updateTime ?? PAID,
      create_time: '2026-10-04T12:00:00Z',
      amount: { currency_code: 'USD', value: over.value ?? '60.00' },
      invoice_id: 'INV2-0000000000000000',
      note_to_payer: 'Thanks',
    },
  }
}

/**
 * `GET /v2/payments/authorizations/{id}`.
 *
 * Carries `expiration_time` because that is the field EC-TIME-5's 29-day clock is read from — there is no
 * `PAYMENT.AUTHORIZATION.EXPIRED` webhook, so this response is the only place an expiry can be observed.
 */
export function authorizationBody(
  over: {
    id?: string
    status?: string
    updateTime?: string
    expirationTime?: string
    value?: string
  } = {},
): StubResponse {
  const updateTime = over.updateTime ?? PAID
  return {
    body: {
      id: over.id ?? PAYPAL.authorizationId,
      status: over.status ?? 'CREATED',
      status_update_time: updateTime,
      update_time: updateTime,
      create_time: '2026-10-04T11:59:00Z',
      expiration_time: over.expirationTime ?? '2026-11-02T11:59:00Z',
      amount: { currency_code: 'USD', value: over.value ?? '60.00' },
      invoice_id: 'INV2-0000000000000000',
      seller_protection: { status: 'ELIGIBLE' },
    },
  }
}

/** `GET /v2/checkout/orders/{id}`. Doc: developer.paypal.com/docs/api/orders/v2/#orders_get */
export function orderBody(
  over: {
    id?: string
    status?: string
    updateTime?: string
  } = {},
): StubResponse {
  return {
    body: {
      id: over.id ?? PAYPAL.orderId,
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
      links: [
        {
          rel: 'self',
          href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${over.id ?? PAYPAL.orderId}`,
        },
      ],
    },
  }
}

/** `GET /v1/customer/disputes/{id}`. Doc: developer.paypal.com/docs/api/customer-disputes/v1/ */
export function disputeBody(
  over: {
    id?: string
    stage?: string
    status?: string
    updateTime?: string
    reason?: string
    value?: string
    sellerResponseDueDate?: string
  } = {},
): StubResponse {
  return {
    body: {
      dispute_id: over.id ?? PAYPAL.disputeId,
      dispute_state: 'REQUIRED_ACTION',
      status: over.status ?? 'WAITING_FOR_SELLER_RESPONSE',
      dispute_life_cycle_stage: over.stage ?? 'CHARGEBACK',
      reason: over.reason ?? 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      update_time: over.updateTime ?? PAID,
      create_time: '2026-10-04T12:00:00Z',
      dispute_amount: { currency_code: 'USD', value: over.value ?? '60.00' },
      dispute_currency: 'USD',
      seller_response_due_date: over.sellerResponseDueDate ?? '2026-10-18T12:00:00Z',
      buyer_response_due_date: '2026-10-25T12:00:00Z',
      disputed_transactions: [
        { seller_transaction_id: PAYPAL.captureId, transaction_id: 'TX-0000000000000000' },
      ],
      require_evidence: { action: 'REQUIRE_EVIDENCE', due_date: '2026-10-18T12:00:00Z' },
    },
  }
}

/** `POST /v1/notifications/verify-webhook-signature`. Doc: developer.paypal.com/api/rest/webhooks/ */
export function verifySuccess(): StubResponse {
  return { body: { verification_status: 'SUCCESS' } }
}

/**
 * A **forged** signature: PayPal answers HTTP 200 with `verification_status: "FAILURE"`.
 *
 * This is the real shape of EC-WH-4 and it is very easy to stub wrongly. A 400 error envelope is **not** a
 * forged signature — `PayPalClient` maps that to `PP_UNPROCESSABLE`, which `verifyDelivery` correctly treats
 * as `UNAVAILABLE` ("we could not check"), so the ingest path would store the event `PENDING` and
 * acknowledge 200 instead of rejecting it.
 *
 * `verify-webhook-signature` answers 200 with a `FAILURE` status precisely so that a forged delivery stays
 * distinguishable from a malformed request. Stubbing it as a 4xx is the mistake this comment exists to
 * prevent, and `test/ingest.test.ts` has a test for the 4xx case precisely because it is the interesting one.
 */
export function verifyFailure(status: string = 'FAILURE'): StubResponse {
  return { body: { verification_status: status } }
}

/**
 * A 400 on the verify endpoint — PayPal rejecting the *request*, not the signature.
 *
 * `PP_UNPROCESSABLE`, so the ingest path must treat it as EC-WH-7's `UNAVAILABLE` rather than as a forgery.
 * A named fixture because that distinction is easy to lose and load-bearing when it is.
 */
export function verifyMalformedRequest(): StubResponse {
  return {
    status: 400,
    body: {
      name: 'INVALID_REQUEST',
      message: 'Invalid request - see details',
      debug_id: 'DEBUG-VERIFY-MALFORMED',
      details: [{ issue: 'INVALID_PARAMETER_VALUE', description: 'webhook_id is required' }],
    },
  }
}

/** 503 with no body — the verify outage of EC-WH-7. */
export function unavailable(): StubResponse {
  return {
    status: 503,
    text: '<html><body>Service Unavailable</body></html>',
    headers: { 'content-type': 'text/html' },
  }
}

/**
 * PayPal's 404 for a resource it does not have. EC-WH-6.
 *
 * Named `paypalNotFound` rather than `notFound` so it cannot be confused with the double's own
 * `notFound(table, id)` — which is a `CsError` about *our* rows and the opposite condition. Mixing those two
 * up is exactly the mistake EC-WH-6 tests exist to catch.
 */
export function paypalNotFound(name = 'RESOURCE_NOT_FOUND'): StubResponse {
  return {
    status: 404,
    body: {
      name,
      message: 'The specified resource does not exist.',
      debug_id: 'DEBUG-NOT-FOUND',
      details: [],
    },
  }
}

export function tokenResponse(): StubResponse {
  return {
    body: { access_token: 'A21AAF', token_type: 'Bearer', expires_in: 32400, scope: 'openid' },
  }
}

/**
 * The OAuth call every `PayPalClient` call makes first.
 *
 * **Spread this into every `setRoutes` table.** `setRoutes` replaces the table wholesale, so a test that
 * overrides the capture route and forgets this loses the token call: it answers 422, the bearer token never
 * resolves, and every subsequent PayPal call fails as `PP_UNAVAILABLE` — which on the webhook path is
 * indistinguishable from EC-WH-7. Nine tests failed that way before this was noticed.
 */
export function oauthRoute(): Routes {
  return { 'POST /v1/oauth2/token': tokenResponse() }
}

/* ------------------------------------------------------------------------------------------ */
/* The in-memory world                                                                           */
/* ------------------------------------------------------------------------------------------ */

/** One delivery PayPal attempted, and what we did with it. */
export interface DeliveryAttempt {
  readonly paypalEventId: string
  /** `deliver` reached `handleWebhook`; `drop` never did. */
  readonly delivered: boolean
  readonly ackStatus: number | null
  readonly ackOutcome: string | null
}

export interface SeedEvent {
  readonly paypalEventId: string
  readonly eventType?: string
  readonly resourceType?: string
  readonly resourceId?: string
  readonly verified?: 'PENDING' | 'VERIFIED' | 'FAILED'
  readonly verifiedAt?: Date | null
  readonly processedAt?: Date | null
  readonly receivedAt?: Date | null
  readonly attempts?: number
  readonly raw?: unknown
}

export interface SeedCapture {
  readonly id?: string
  readonly paypalCaptureId?: string
  readonly status?: CaptureStatus
  readonly orderId?: OrderId | null
  readonly authorizationId?: string | null
  readonly fetchedAt?: Date | null
  readonly raw?: unknown
  readonly amountMinor?: bigint
  readonly refundedMinor?: bigint
}

export interface SeedOrder {
  readonly id?: OrderId
  readonly paypalOrderId?: string | null
  readonly status?: OrderStatus
  readonly fetchedAt?: Date | null
  readonly raw?: unknown
}

export interface SeedAuthorization {
  readonly id?: string
  readonly paypalAuthorizationId?: string
  readonly status?: AuthorizationStatus
  readonly expirationTime?: Date
  readonly honorExpiresAt?: Date
  readonly fetchedAt?: Date | null
  readonly raw?: unknown
}

export interface SeedRefund {
  readonly id?: string
  readonly paypalRefundId?: string
  readonly status?: RefundStatus
  readonly fetchedAt?: Date | null
  readonly raw?: unknown
}

export interface SeedDispute {
  readonly id?: string
  readonly paypalDisputeId?: string
  readonly stage?: DisputeStage
  readonly status?: DisputeStatus
  /** EC-DSP-7/8: the deadline the Defender reads. Override it to prove a `REFRESH` moved it. */
  readonly sellerResponseDueDate?: Date | null
  readonly buyerResponseDueDate?: Date | null
  /**
   * `null` means "never fetched" — the state EC-WH-1's `reconciler_fixes_total` counts a fix against.
   *
   * A `Date` means PayPal's `update_time` has already been mirrored, which is what makes the next
   * re-fetch a `REFRESH` or a `SKIP_STALE` rather than a first learn.
   */
  readonly fetchedAt?: Date | null
  readonly raw?: unknown
  readonly amountMinor?: bigint
  readonly orderId?: string | null
  readonly captureId?: string | null
}

export interface WorldSeed {
  readonly events?: readonly SeedEvent[]
  readonly captures?: readonly SeedCapture[]
  readonly orders?: readonly SeedOrder[]
  readonly authorizations?: readonly SeedAuthorization[]
  readonly refunds?: readonly SeedRefund[]
  readonly disputes?: readonly SeedDispute[]
}

export interface InMemoryWorld {
  readonly store: WebhookStore
  /** The live rows, for assertions and for mutation between reads. */
  readonly rows: {
    readonly events: Map<string, WebhookEventRow>
    readonly captures: Map<string, CaptureRow>
    readonly orders: Map<string, OrderRow>
    readonly authorizations: Map<string, AuthorizationRow>
    readonly refunds: Map<string, RefundRow>
    readonly disputes: Map<string, DisputeRow>
  }
  /** Every delivery PayPal attempted, dropped or not. */
  readonly deliveries: DeliveryAttempt[]
  /** Every write, in order. The cheap way to assert "nothing was written". */
  readonly writes: Array<{ table: string; op: 'insert' | 'update'; id: string; status?: string }>
  /** Writes inside a transaction that later rolled back. Always `0` in a correct run. */
  rolledBackWrites(): number
  /** The `webhook_events` row for a PayPal event id. */
  eventFor(paypalEventId: string): WebhookEventRow | undefined
  /** Every attempt made for a PayPal event id. */
  deliveriesOf(paypalEventId: string): DeliveryAttempt[]
  clearWrites(): void
  /** Fail the next `n` writes to a table, to exercise the "our database is unhappy" branch. */
  failWrites(table: string, times: number, message?: string): void
  /**
   * The webhook channel. The **only** way a test makes a delivery reach `handleWebhook`.
   *
   * `decision` is `'deliver'` or `'drop'`, and `'drop'` is the whole of EC-WH-1 / AT-M12.3:
   *
   *  - `'deliver'` calls `handleWebhook` with the body and headers and records the ack.
   *  - `'drop'` records the attempt and stores **nothing** — no row, no queue job, no audit entry, no
   *    fetch. A test that simulated loss by deleting the row after the fact would leave those side effects
   *    behind and be asserting on a world that never existed.
   *
   * Returns the ack, or `null` when the delivery was dropped. Typed as a union rather than a boolean so a
   * test cannot accidentally treat "dropped" as an ack with a falsy status.
   */
  deliver(
    handle: (rawBody: Uint8Array, headers: Record<string, string>) => Promise<WebhookAck>,
    input: { body: string; headers?: Record<string, string>; paypalEventId?: string },
    decision?: 'deliver' | 'drop',
  ): Promise<WebhookAck | null>
}

let eventCounter = 0
function nextEventId(): WebhookEventId {
  eventCounter += 1
  return `whe_${String(eventCounter).padStart(26, '0')}` as WebhookEventId
}

/** A `CS_NOT_FOUND` shaped exactly as `csError` would build it, so the double's returns typecheck. */
function notFound(table: string, id: string): CsError {
  return csError('CS_NOT_FOUND', `No ${table} row for ${id}`, { table, id })
}

/** Our own database being unhappy. Distinct from every PayPal failure on purpose. */
function writeFailure(table: string, message: string): CsError {
  return csError('CS_INTERNAL', message, { table }, { retryable: true })
}

/**
 * The two `Result` shapes the double returns, so every store method's inferred return type matches the
 * port's `Result<T, CsError>` exactly.
 *
 * Without this, `return failWith(f)` inside a method widens to a union that does not
 * assign back to the interface — and the fix for that is usually a cast, which would defeat the point of
 * checking the double against the port.
 */
function pass<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function failWith(error: CsError): { ok: false; error: CsError } {
  return { ok: false, error }
}

/**
 * An in-memory {@link WebhookStore}. See this file's header for why its fidelity is the point.
 *
 * Three behaviours are modelled rather than stubbed, and each is a place a lazier double hides a bug:
 *
 * - `webhook_events_paypal_event_id_key` is a real key: a redelivery returns the **existing** row untouched.
 * - `captures.applyFromFetch` refuses a rank-downgrade and says so via `applied: false`.
 * - `transaction` **undoes** writes on a thrown error, and the write log is corrected to match.
 */
export function createInMemoryWorld(seed: WorldSeed = {}): InMemoryWorld {
  const at = NOW

  const events = new Map<string, WebhookEventRow>()
  for (const e of seed.events ?? []) {
    const id = nextEventId()
    const row = {
      id,
      paypal_event_id: e.paypalEventId,
      event_type: e.eventType ?? 'PAYMENT.CAPTURE.COMPLETED',
      resource_type: e.resourceType ?? 'capture',
      resource_id: e.resourceId ?? PAYPAL.captureId,
      create_time: at,
      verified: e.verified ?? 'VERIFIED',
      verified_at: e.verifiedAt ?? at,
      // A seeded event gets a **real** {@link StoredDelivery}, not `null`.
      //
      // Every row the ingest path writes carries the exact request bytes and the five signature headers, so
      // a seed that left `raw` null would be a row the production schema cannot produce — and EC-WH-7's retry
      // would report it `UNVERIFIABLE` for a reason that is an artefact of the fixture rather than the code.
      // `test/ingest.test.ts` has a separate test for the genuine legacy-row case, which passes `raw` itself.
      raw: (e.raw ??
        toJsonValue(
          encodeStoredRaw(
            { id: e.paypalEventId, event_type: e.eventType ?? 'PAYMENT.CAPTURE.COMPLETED' },
            bytes(eventBody({ id: e.paypalEventId })),
            webhookHeaders(),
          ),
        )) as WebhookEventRow['raw'],
      received_at: e.receivedAt ?? at,
      processed_at: e.processedAt ?? null,
      attempts: e.attempts ?? 0,
      error: null,
      created_at: at,
      updated_at: at,
    } as unknown as WebhookEventRow
    events.set(row.paypal_event_id, row)
  }

  const orders = new Map<string, OrderRow>(
    (seed.orders ?? [{ paypalOrderId: PAYPAL.orderId, status: 'ORDER_CREATED' }]).map((o, i) => {
      const row = {
        id: o.id ?? (`ord_${String(i + 1).padStart(26, '0')}` as OrderId),
        attempt_id: 'att_00000000000000000000000001',
        mandate_id: 'mdt_00000000000000000000000001',
        checkout_session_id: 'chk_00000000000000000000000001',
        merchant_id: 'NORTHWIND',
        paypal_order_id: o.paypalOrderId === undefined ? PAYPAL.orderId : o.paypalOrderId,
        custom_id: `cs:ord_${String(i + 1).padStart(26, '0')}`,
        status: o.status ?? 'ORDER_CREATED',
        intent: 'AUTHORIZE',
        amount_minor: 6_000n,
        currency: 'USD',
        raw: (o.raw ?? null) as OrderRow['raw'],
        fetched_at: o.fetchedAt ?? null,
        created_at: at,
        updated_at: at,
      } as unknown as OrderRow
      return [row.id, row]
    }),
  )

  const authorizations = new Map<string, AuthorizationRow>(
    (seed.authorizations ?? [{ paypalAuthorizationId: PAYPAL.authorizationId }]).map((a, i) => {
      const row = {
        id: a.id ?? `aut_${String(i + 1).padStart(26, '0')}`,
        order_id: [...orders.keys()][0] ?? OUR.orderId,
        paypal_authorization_id: a.paypalAuthorizationId ?? PAYPAL.authorizationId,
        status: a.status ?? 'CREATED',
        amount_minor: 6_000n,
        currency: 'USD',
        // 29 days, the [V15] validity clock EC-TIME-5 tracks.
        expiration_time: a.expirationTime ?? new Date(NOW_MS + 29 * 86_400_000),
        // 3 days, the [V15] honour period.
        honor_expires_at: a.honorExpiresAt ?? new Date(NOW_MS + 3 * 86_400_000),
        invoice_id: 'INV2-0000000000000000',
        custom_id: 'cs:ord_00000000000000000000000001',
        raw: (a.raw ?? null) as AuthorizationRow['raw'],
        fetched_at: a.fetchedAt ?? null,
        created_at: at,
        updated_at: at,
      } as unknown as AuthorizationRow
      return [row.id, row]
    }),
  )

  const captures = new Map<string, CaptureRow>(
    (seed.captures ?? [{ paypalCaptureId: PAYPAL.captureId, status: 'PENDING' }]).map((c, i) => {
      const row = {
        id: c.id ?? `cap_${String(i + 1).padStart(26, '0')}`,
        order_id: c.orderId === undefined ? OUR.orderId : c.orderId,
        authorization_id:
          c.authorizationId === undefined
            ? (authorizations.keys().next().value ?? null)
            : c.authorizationId,
        paypal_capture_id: c.paypalCaptureId ?? PAYPAL.captureId,
        amount_minor: c.amountMinor ?? 6_000n,
        currency: 'USD',
        final_capture: true,
        status: c.status ?? 'PENDING',
        shipment_id: null,
        refunded_minor: c.refundedMinor ?? 0n,
        reversed: false,
        raw: (c.raw ?? null) as CaptureRow['raw'],
        fetched_at: c.fetchedAt ?? null,
        created_at: at,
        updated_at: at,
      } as unknown as CaptureRow
      return [row.id, row]
    }),
  )

  const refunds = new Map<string, RefundRow>(
    (seed.refunds ?? []).map((r, i) => {
      const row = {
        id: r.id ?? `ref_${String(i + 1).padStart(26, '0')}`,
        capture_id: [...captures.keys()][0] ?? OUR.captureId,
        paypal_refund_id: r.paypalRefundId ?? PAYPAL.refundId,
        amount_minor: 6_000n,
        currency: 'USD',
        status: r.status ?? 'PENDING',
        reason_code: 'MERCHANT_REQUEST',
        initiated_by: 'MERCHANT',
        actor: null,
        note: null,
        raw: (r.raw ?? null) as RefundRow['raw'],
        fetched_at: r.fetchedAt ?? null,
        created_at: at,
        updated_at: at,
      } as unknown as RefundRow
      return [row.id, row]
    }),
  )

  const disputes = new Map<string, DisputeRow>(
    (seed.disputes ?? []).map((d, i) => {
      const row = {
        id: d.id ?? `dsp_${String(i + 1).padStart(26, '0')}`,
        paypal_dispute_id: d.paypalDisputeId ?? PAYPAL.disputeId,
        order_id: d.orderId ?? null,
        capture_id: d.captureId ?? null,
        stage: d.stage ?? 'CHARGEBACK',
        status: d.status ?? 'WAITING_FOR_SELLER_RESPONSE',
        amount_minor: d.amountMinor ?? 6_000n,
        currency: 'USD',
        seller_response_due_date: d.sellerResponseDueDate ?? new Date(NOW_MS + 14 * 86_400_000),
        buyer_response_due_date: d.buyerResponseDueDate ?? new Date(NOW_MS + 21 * 86_400_000),
        defense_state: 'NEW',
        liability: null,
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        raw: (d.raw ?? null) as DisputeRow['raw'],
        // `fetched_at` is `nullable` in the schema, so it must be **present and `null`** rather than absent.
        // `upsertFromFetch` reads `row.fetched_at !== null`, and an absent key reads as `undefined !== null`,
        // which is `true` — so the double would compare against an undefined date and throw. The production
        // column always exists; a seed that omitted it would be a row the database cannot hold.
        fetched_at: d.fetchedAt ?? null,
        router_trace: {},
        created_at: at,
        updated_at: at,
      } as unknown as DisputeRow
      return [row.id, row]
    }),
  )

  // `disputes` is re-keyed to `paypal_dispute_id` rather than the row id, because
  // `findByPaypalId` and `upsertFromFetch` both look disputes up by PayPal's id and the seam between them is
  // where a key mismatch would turn every dispute write into an insert. The production unique constraint is
  // `disputes_paypal_dispute_id_key` (`schema.ts`), so keying by it is the faithful choice.
  const rows: InMemoryWorld['rows'] = {
    events,
    captures,
    orders,
    authorizations,
    refunds,
    disputes: new Map([...disputes].map(([, row]) => [row.paypal_dispute_id, row])),
  }
  const writes: Array<{ table: string; op: 'insert' | 'update'; id: string; status?: string }> = []
  let pendingWrites: typeof writes = []
  let rolledBackTotal = 0
  const failing = new Map<string, { times: number; message: string }>()

  function record(table: string, op: 'insert' | 'update', id: string, status?: string): void {
    writes.push({ table, op, id, status })
    pendingWrites.push({ table, op, id, status })
  }

  /** A configured write failure, as `CS_INTERNAL` — our database being unhappy, never PayPal's fault. */
  function checkFailure(table: string): CsError | null {
    const f = failing.get(table)
    if (f === undefined || f.times <= 0) return null
    f.times -= 1
    return writeFailure(table, f.message)
  }

  const ALL_TABLES = [
    rows.events,
    rows.captures,
    rows.orders,
    rows.authorizations,
    rows.refunds,
    rows.disputes,
  ]

  function snapshot(): Array<Map<string, unknown>> {
    return ALL_TABLES.map((m) => new Map([...m].map(([k, v]) => [k, { ...v }])))
  }

  function restore(saved: Array<Map<string, unknown>>): void {
    ALL_TABLES.forEach((m, i) => {
      m.clear()
      for (const [k, v] of saved[i] ?? []) m.set(k, v as never)
    })
  }

  const store: WebhookStore = {
    events: {
      async ingestEvent(input: NewWebhookEvent) {
        const f = checkFailure('webhook_events')
        if (f !== null) return failWith(f)
        // `webhook_events_paypal_event_id_key` — a redelivery finds the existing row and returns it
        // **untouched**. Not `received_at`, not `raw`, not `verified`: the first copy is the case file.
        const existing = events.get(input.paypal_event_id)
        if (existing !== undefined) return pass({ row: existing, duplicate: true })
        const row = {
          ...input,
          verified_at: null,
          processed_at: null,
          attempts: 0,
          error: null,
          created_at: at,
          updated_at: at,
        } as unknown as WebhookEventRow
        events.set(row.paypal_event_id, row)
        record('webhook_events', 'insert', row.id)
        return pass({ row, duplicate: false })
      },

      async findByPaypalId(paypalEventId) {
        return pass(events.get(paypalEventId))
      },

      async findById(id) {
        for (const row of events.values()) if (row.id === id) return pass(row)
        return pass(undefined)
      },

      async markVerifiedState(id, verified, error, at2) {
        const f = checkFailure('webhook_events')
        if (f !== null) return failWith(f)
        for (const [key, row] of events) {
          if (row.id !== id) continue
          const next = {
            ...row,
            verified,
            verified_at: verified === 'VERIFIED' ? at2 : null,
            error,
            updated_at: at2,
          }
          events.set(key, next)
          record('webhook_events', 'update', id, verified)
          return pass(next)
        }
        return failWith(notFound('webhook_events', id))
      },

      async markProcessed(id, error, at2) {
        const f = checkFailure('webhook_events')
        if (f !== null) return failWith(f)
        for (const [key, row] of events) {
          if (row.id !== id) continue
          const next = {
            ...row,
            // `error === null` means success. **Any** string — including `gave up after N attempts` — sets
            // `processed_at`, because the point of marking it is to stop the unprocessed sweep re-driving
            // the row forever. The repository's own SQL does exactly this
            // (`repos/webhooks.ts::markProcessed`), and a double that left `processed_at` null for every
            // errored row would make `GAVE_UP` untestable and every retry unbounded.
            processed_at: at2,
            error,
            attempts: row.attempts + 1,
            updated_at: at2,
          }
          events.set(key, next)
          record('webhook_events', 'update', id)
          return pass(next)
        }
        return failWith(notFound('webhook_events', id))
      },

      async markIgnored(id, reason, at2) {
        return store.events.markProcessed(id, `ignored: ${reason}`, at2)
      },

      async countFailedSince(since) {
        let n = 0
        for (const row of events.values()) {
          if (row.verified === 'FAILED' && row.received_at.getTime() >= since.getTime()) n += 1
        }
        return pass(n)
      },

      async listUnverified(limit) {
        const out: WebhookEventRow[] = []
        for (const row of events.values()) {
          if (row.verified === 'PENDING') out.push(row)
          if (out.length >= limit) break
        }
        return pass(out)
      },

      async listUnprocessed(limit) {
        const out: WebhookEventRow[] = []
        for (const row of events.values()) {
          if (row.processed_at === null) out.push(row)
          if (out.length >= limit) break
        }
        return pass(out)
      },
    },

    aggregates: {
      orders: {
        async findByPaypalId(paypalOrderId) {
          for (const row of rows.orders.values()) {
            if (row.paypal_order_id === paypalOrderId) return pass(row)
          }
          return pass(undefined)
        },

        async reconcileCandidates(updatedSince) {
          // `findOrdersForReconcile`'s SQL: `updated_at >= since` and the status not in the terminal set.
          const terminal = new Set<OrderStatus>([
            'CAPTURED',
            'VOIDED',
            'CANCELLED',
            'PAYMENT_FAILED',
            'AUTH_EXPIRED',
            'DECLINED',
          ])
          const out = [...orders.values()].filter(
            (o) => o.updated_at.getTime() >= updatedSince.getTime() && !terminal.has(o.status),
          )
          return pass(out)
        },

        async setStatus(id, status, at2) {
          const f = checkFailure('orders')
          if (f !== null) return failWith(f)
          const row = rows.orders.get(id)
          if (row === undefined) return failWith(notFound('orders', id))
          const next = { ...row, status, updated_at: at2 }
          rows.orders.set(id, next)
          record('orders', 'update', id, status)
          return pass(next)
        },

        async recordFetched(id, raw, at2) {
          const row = rows.orders.get(id)
          if (row === undefined) return failWith(notFound('orders', id))
          const next = { ...row, raw, fetched_at: at2, updated_at: at2 }
          rows.orders.set(id, next)
          record('orders', 'update', id)
          return pass(next)
        },
      },

      authorizations: {
        async findByPaypalId(paypalAuthorizationId) {
          for (const row of rows.authorizations.values()) {
            if (row.paypal_authorization_id === paypalAuthorizationId) {
              return pass(row)
            }
          }
          return pass(undefined)
        },

        async reconcileCandidates(before) {
          // `findAuthorizationsExpiring`: `status = 'CREATED'` **and** `expiration_time <= before`.
          const out = [...authorizations.values()].filter(
            (a) => a.status === 'CREATED' && a.expiration_time.getTime() <= before.getTime(),
          )
          out.sort((a, b) => a.expiration_time.getTime() - b.expiration_time.getTime())
          return pass(out)
        },

        async setStatus(id, status, at2) {
          const f = checkFailure('authorizations')
          if (f !== null) return failWith(f)
          const row = rows.authorizations.get(id)
          if (row === undefined) return failWith(notFound('authorizations', id))
          const next = { ...row, status, updated_at: at2 }
          rows.authorizations.set(id, next)
          record('authorizations', 'update', id, status)
          return pass(next)
        },
      },

      captures: {
        async findByPaypalId(paypalCaptureId) {
          for (const row of rows.captures.values()) {
            if (row.paypal_capture_id === paypalCaptureId) return pass(row)
          }
          return pass(undefined)
        },

        async reconcileCandidates(updatedSince, limit) {
          // Non-terminal only — the reconciler has nothing to learn from a `REFUNDED` capture except that
          // it is still refunded, which one read already established.
          const out = [...captures.values()].filter(
            (c) =>
              c.updated_at.getTime() >= updatedSince.getTime() &&
              !isTerminalStatus('capture', c.status),
          )
          return pass(out.slice(0, limit))
        },

        async applyFromFetch(id, write) {
          const f = checkFailure('captures')
          if (f !== null) return failWith(f)
          const row = rows.captures.get(id)
          if (row === undefined) return failWith(notFound('captures', id))
          // The rank guard, enforced in the store rather than trusted from the caller. `applyFromFetch` is
          // handed a decision and still refuses a downgrade, and says so with `applied: false` rather than
          // throwing — "the monotonic rule held" is then an assertion, not a hope.
          if (
            write.status !== undefined &&
            isTerminalStatus('capture', row.status) &&
            row.status !== write.status
          ) {
            return pass({ row, applied: false })
          }
          const next = {
            ...row,
            status: write.status ?? row.status,
            raw: write.raw ?? row.raw,
            fetched_at: write.fetchedAt,
            updated_at: write.fetchedAt,
          } as CaptureRow
          rows.captures.set(id, next)
          record('captures', 'update', id, write.status)
          return pass({ row: next, applied: true })
        },
      },

      refunds: {
        async findByPaypalId(paypalRefundId) {
          for (const row of rows.refunds.values()) {
            if (row.paypal_refund_id === paypalRefundId) return pass(row)
          }
          return pass(undefined)
        },

        async setStatus(id, status, paypalRefundId, raw, at2) {
          const f = checkFailure('refunds')
          if (f !== null) return failWith(f)
          const row = rows.refunds.get(id)
          if (row === undefined) return failWith(notFound('refunds', id))
          // A refund's terminal states are `COMPLETED` and `FAILED`, and a `COMPLETED` refund is never
          // un-completed — the same monotonic rule the captures store enforces.
          if (isTerminalStatus('refund', row.status) && row.status !== status) {
            return failWith(notFound('refunds', id))
          }
          const next = {
            ...row,
            status,
            paypal_refund_id: paypalRefundId,
            raw,
            fetched_at: at2,
            updated_at: at2,
          } as RefundRow
          rows.refunds.set(id, next)
          record('refunds', 'update', id, status)
          return pass(next)
        },
      },

      disputes: {
        async findByPaypalId(paypalDisputeId) {
          for (const row of disputes.values()) {
            if (row.paypal_dispute_id === paypalDisputeId) return pass(row)
          }
          return pass(undefined)
        },

        async upsertFromFetch(input: UpsertDisputeInput) {
          const f = checkFailure('disputes')
          if (f !== null) return failWith(f)
          // A caller must always supply a real `Date`. The production repository would fail loudly here
          // too, and a double that quietly treated a missing value as "now" would let an absent
          // `updated_at` pass as a fresh fetch - the one thing EC-WH-3's stale rule must never allow.
          if (!(input.updatedAt instanceof Date) || Number.isNaN(input.updatedAt.getTime())) {
            return failWith(
              writeFailure('disputes', 'upsertFromFetch was given an invalid updatedAt'),
            )
          }
          for (const [key, row] of rows.disputes) {
            if (row.paypal_dispute_id !== input.paypalDisputeId) continue
            // `isDisputeRegression`, the store-side half: never move the stage backwards, and within a
            // stage never accept an older `update_time`.
            const STAGE: Record<DisputeStage, number> = {
              INQUIRY: 1,
              CHARGEBACK: 2,
              PRE_ARBITRATION: 3,
              ARBITRATION: 4,
            }
            if (STAGE[input.stage] < STAGE[row.stage]) {
              return pass({ row, applied: false })
            }
            if (row.fetched_at !== null && input.updatedAt.getTime() < row.fetched_at.getTime()) {
              return pass({ row, applied: false })
            }
            const next = {
              ...row,
              stage: input.stage,
              status: input.status,
              amount_minor: input.amount.minor,
              currency: input.amount.currency,
              seller_response_due_date: input.sellerResponseDueDate,
              buyer_response_due_date: input.buyerResponseDueDate,
              raw: input.raw,
              fetched_at: input.updatedAt,
              updated_at: input.updatedAt,
            } as DisputeRow
            rows.disputes.set(key, next)
            record('disputes', 'update', row.id, input.status)
            return pass({ row: next, applied: true })
          }
          const row = {
            id: input.id,
            paypal_dispute_id: input.paypalDisputeId,
            order_id: null,
            capture_id: null,
            stage: input.stage,
            status: input.status,
            amount_minor: input.amount.minor,
            currency: input.amount.currency,
            seller_response_due_date: input.sellerResponseDueDate,
            buyer_response_due_date: input.buyerResponseDueDate,
            defense_state: 'NEW',
            liability: null,
            reason: input.reason,
            raw: input.raw,
            router_trace: {},
            created_at: at,
            updated_at: input.updatedAt,
          } as unknown as DisputeRow
          rows.disputes.set(row.paypal_dispute_id, row)
          record('disputes', 'insert', row.id, input.status)
          return pass({ row, applied: true })
        },

        async updatedSince(since) {
          const out = [...disputes.values()].filter(
            (d) => d.updated_at.getTime() >= since.getTime(),
          )
          return pass(out)
        },
      },
    },
  }

  const deliveries: DeliveryAttempt[] = []

  const world: InMemoryWorld = {
    store,
    rows,
    deliveries,
    writes,
    rolledBackWrites: () => rolledBackTotal,
    eventFor: (paypalEventId) => events.get(paypalEventId),
    deliveriesOf: (paypalEventId) => deliveries.filter((d) => d.paypalEventId === paypalEventId),
    clearWrites: () => {
      writes.length = 0
      rolledBackTotal = 0
    },
    failWrites: (table, times, message = `injected write failure on ${table}`) => {
      failing.set(table, { times, message })
    },

    deliver: async (handle, input, decision = 'deliver') => {
      const paypalEventId = input.paypalEventId ?? safeEventId(input.body) ?? 'WH-UNKNOWN'
      if (decision === 'drop') {
        deliveries.push({
          paypalEventId,
          delivered: false,
          ackStatus: null,
          ackOutcome: null,
        })
        return null
      }
      const ack = await handle(bytes(input.body), input.headers ?? webhookHeaders())
      deliveries.push({
        paypalEventId,
        delivered: true,
        ackStatus: ack.status,
        ackOutcome: ack.outcome,
      })
      return ack
    },
  }

  // A transaction stand-in that **undoes** writes, not merely releases locks — the property
  // `createInMemoryOrderWorld` documents and the reason `snapshot`/`restore` exist here. Nothing in this
  // package opens a transaction today; it is here so the port stays honest for the caller that does, and so
  // `rolledBackWrites()` is available to a test that wants to prove a write was undone rather than merely
  // reported as undone.
  ;(world as { transaction?: unknown }).transaction = async (
    fn: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => {
    const saved = snapshot()
    const savedWrites = writes.length
    pendingWrites = []
    try {
      const value = await fn({})
      return { ok: true as const, value }
    } catch (cause) {
      const discarded = pendingWrites.length
      rolledBackTotal += discarded
      writes.length = savedWrites
      restore(saved)
      return {
        ok: false as const,
        error:
          typeof cause === 'object' && cause !== null && 'code' in cause
            ? cause
            : {
                code: 'CS_INTERNAL',
                message: 'transaction aborted',
                userMessage: 'Something went wrong.',
                retryable: true,
              },
      }
    } finally {
      pendingWrites = []
    }
  }

  return world
}

/* ------------------------------------------------------------------------------------------ */
/* The queue double                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface SentJob {
  readonly name: JobName
  readonly data: unknown
  readonly opts: EnqueueOptions | undefined
}

export interface InMemoryQueue extends WebhookQueue {
  readonly sent: SentJob[]
  /** Jobs of one name. */
  sentNamed(name: JobName): SentJob[]
  /** Every job enqueued for one resource — the singleton-key assertion. */
  sentFor(resourceId: string): SentJob[]
  readonly handlers: Map<JobName, JobHandler>
  readonly cron: Map<JobName, string>
  /** Run the jobs queued so far, oldest first. Returns each handler's `Result`. */
  drain(): Promise<Array<{ name: JobName; ok: boolean; error?: string }>>
  /** Fail the next `n` sends, to exercise the "the queue is down" branch of §8.12 step 5. */
  failNextSends(times: number): void
  /** Whether `start()` has been called and `stop()` has not. */
  started(): boolean
  reset(): void
}

/**
 * An in-memory {@link WebhookQueue}.
 *
 * `singletonKey` is **recorded, not enforced**: the enforcement is pg-boss's row lock, and a double that
 * silently dropped a duplicate would make AT-M12.1 pass for the wrong reason. The test asserts on
 * `sentFor(resourceId)` instead, which is the honest check.
 */
export function inMemoryQueue(): InMemoryQueue {
  const sent: SentJob[] = []
  const handlers = new Map<JobName, JobHandler>()
  const cron = new Map<JobName, string>()
  let failures = 0
  let started = false

  return {
    sent,
    handlers,
    cron,

    async send(name, data, opts) {
      if (failures > 0) {
        failures -= 1
        return failWith(csError('CS_INTERNAL', 'the queue is down', {}, { retryable: true }))
      }
      sent.push({ name, data, opts })
      return pass(`job_${sent.length}`)
    },

    async work(name, handler) {
      handlers.set(name, handler)
      return pass(undefined)
    },

    async schedule(name, expression) {
      cron.set(name, expression)
      return pass(undefined)
    },

    async start() {
      started = true
      return pass(undefined)
    },

    async stop() {
      started = false
      return pass(undefined)
    },

    sentNamed: (name) => sent.filter((j) => j.name === name),
    sentFor: (resourceId) =>
      sent.filter(
        (j) =>
          j.opts?.singletonKey === resourceId ||
          (j.data as { resourceId?: string })?.resourceId === resourceId,
      ),

    async drain() {
      const out: Array<{ name: JobName; ok: boolean; error?: string }> = []
      for (const job of [...sent]) {
        const handler = handlers.get(job.name)
        if (handler === undefined) {
          out.push({ name: job.name, ok: false, error: `no handler registered for ${job.name}` })
          continue
        }
        const result = await handler(job.data)
        out.push({
          name: job.name,
          ok: result.ok,
          ...(result.ok ? {} : { error: result.error.code }),
        })
      }
      return out
    },

    failNextSends: (times) => {
      failures = times
    },

    reset: () => {
      sent.length = 0
      handlers.clear()
      cron.clear()
      failures = 0
    },

    started: () => started,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The throttle double                                                                           */
/* ------------------------------------------------------------------------------------------ */

export interface CountingThrottle extends Throttle {
  /** Every task that passed through the limiter. The "was it throttled?" assertion. */
  readonly admissions: number[]
}

/**
 * An instant throttle that **counts** its admissions.
 *
 * `rps` reports 2 — the configured rate — so a caller logging or asserting the limit sees EC-PP-2's number
 * even though no time passed. The count is what a test asserts on: a sweep that made nine PayPal reads went
 * through the limiter nine times, and that is the property EC-PP-2 is about.
 */
export function instantThrottle(rps = 2): CountingThrottle {
  const admissions: number[] = []
  return {
    rps,
    admissions,
    async run<T>(task: () => Promise<T>): Promise<T> {
      admissions.push(admissions.length)
      return task()
    },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The audit double                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface AuditEntry {
  readonly chainId: string
  readonly actor: string
  readonly action: string
  readonly subject: string
  readonly details: Record<string, unknown>
  readonly at: Date
}

export interface RecordingAudit extends WebhookAudit {
  readonly entries: AuditEntry[]
  /** Entries of one action, in order. */
  ofAction(action: string): AuditEntry[]
  clear(): void
}

export function recordingAudit(): RecordingAudit {
  const entries: AuditEntry[] = []
  return {
    entries,
    ofAction: (action) => entries.filter((e) => e.action === action),
    clear: () => {
      entries.length = 0
    },
    async append(input) {
      entries.push({
        chainId: input.chainId,
        actor: input.actor,
        action: input.action,
        subject: input.subject,
        details: input.details,
        at: input.at,
      })
      return { ok: true, value: { id: `aud_${entries.length}` } }
    },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The whole world                                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface HarnessOptions {
  readonly routes?: Routes
  readonly seed?: WorldSeed
  readonly webhookId?: string
  /** Force `verify-webhook-signature` to hang, for the timeout branch. */
  readonly verifyHangs?: boolean
  /**
   * How long the synchronous verify call waits before giving up.
   *
   * Overridable because the default is chosen for production (well under §8.12 step 5's 2-second budget) and
   * a test that wants to cross it would otherwise have to wait that long. The clock is injected, so the wait
   * itself is virtual — only the *assertions* about what happened after it are real.
   */
  readonly verifyTimeoutMs?: number
}

export interface Harness {
  readonly deps: WebhookDeps
  readonly world: InMemoryWorld
  readonly paypal: FakePayPal
  readonly queue: InMemoryQueue
  readonly audit: RecordingAudit
  readonly throttle: CountingThrottle
  readonly clock: ReturnType<typeof testClock>
  readonly client: PayPalClient
  readonly sleeps: number[]
  readonly logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>
}

/**
 * The whole world, wired.
 *
 * The `PayPalClient` is the **real** one with an injected `fetchImpl`, an injected sleep that records, and
 * an injected logger — so `verify-webhook-signature`, `getCapture` and the rest exercise the real request
 * building, the real OAuth single-flight, the real retry loop and the real zod validation. No test in this
 * package waits a real millisecond.
 */
export function harness(options: HarnessOptions = {}): Harness {
  const routes = { ...oauthRoute(), ...(options.routes ?? {}) }
  const paypal = fakePayPal(routes)
  const world = createInMemoryWorld(options.seed ?? {})
  const queue = inMemoryQueue()
  const audit = recordingAudit()
  const throttle = instantThrottle()
  const clock = testClock()
  const { sleep, delays } = recordingSleep()
  const logs: Harness['logs'] = []

  // One logger, built recursively so `child()` is a real `Logger` at every depth rather than a stub — the
  // PayPal client calls `child()` internally for its debug-id context, and a stub there would swallow the
  // request-id fields these tests read.
  const logger = (): Logger => ({
    debug: (m, f) => {
      logs.push({ level: 'debug', msg: m, ...(f ? { fields: f } : {}) })
    },
    info: (m, f) => {
      logs.push({ level: 'info', msg: m, ...(f ? { fields: f } : {}) })
    },
    warn: (m, f) => {
      logs.push({ level: 'warn', msg: m, ...(f ? { fields: f } : {}) })
    },
    error: (m, f) => {
      logs.push({ level: 'error', msg: m, ...(f ? { fields: f } : {}) })
    },
    child: () => logger(),
  })

  const client = new PayPalClient({
    baseUrl: 'https://api-m.sandbox.paypal.com',
    clientId: 'AY_FAKE_SANDBOX_CLIENT_ID_00000000',
    clientSecret: 'EL_FAKE_SANDBOX_SECRET_00000000',
    clock,
    fetchImpl: paypal.fetchImpl,
    sleep,
    maxRetries: 1,
    logger: logger(),
  })

  const deps: WebhookDeps = {
    clock,
    paypal: client,
    store: world.store,
    queue,
    audit,
    throttle,
    webhookId: options.webhookId ?? WEBHOOK_ID,
    logger: logger(),
    // Spread rather than assigned unconditionally, so a test that omits it gets the production default
    // instead of an accidental `undefined` that `verifyDelivery` would treat as "no timeout at all".
    ...(options.verifyTimeoutMs === undefined ? {} : { verifyTimeoutMs: options.verifyTimeoutMs }),
  }

  if (options.verifyHangs === true) {
    paypal.setRoutes({
      ...routes,
      'POST /v1/notifications/verify-webhook-signature': async () =>
        new Promise<never>(() => {
          /* never resolves: the verify endpoint hung */
        }),
    })
  }

  return { deps, world, paypal, queue, audit, throttle, clock, client, sleeps: delays, logs }
}

/* ------------------------------------------------------------------------------------------ */
/* Webhook event bodies                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** A PayPal webhook event body. `over` replaces any field. */
export function eventBody(
  over: {
    id?: string
    eventType?: string
    resourceType?: string
    resourceId?: string
    createTime?: string
  } = {},
): string {
  return JSON.stringify({
    id: over.id ?? 'WH-1AAAAAAAAAAAAAAA',
    event_version: '1.0',
    create_time: over.createTime ?? '2026-10-04T12:00:00Z',
    resource_type: over.resourceType ?? 'capture',
    event_type: over.eventType ?? 'PAYMENT.CAPTURE.COMPLETED',
    summary: 'Payment completed for $60.00 USD',
    resource: {
      id: over.resourceId ?? PAYPAL.captureId,
      type: over.resourceType ?? 'capture',
      status: 'COMPLETED',
      // **Deliberately wrong on purpose.** The payload claims `REFUNDED` while PayPal's GET says
      // `COMPLETED`, so a test that passes by believing the payload fails loudly.
      amount: { currency_code: 'USD', value: '60.00' },
      create_time: '2026-10-04T11:59:00Z',
      update_time: '2026-10-04T12:00:00Z',
    },
  })
}

/** The five headers PayPal sends, with the five we require. */
export function webhookHeaders(over: Record<string, string> = {}): Record<string, string> {
  return {
    'paypal-transmission-id': 'b1c2d3e4-0000-4000-8000-000000000001',
    'paypal-transmission-time': '2026-10-04T12:00:01Z',
    'paypal-transmission-sig': 'SZG-UNFAKEABLE-SIGNATURE',
    'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-360caa42cbc2-9f4b-4d02',
    'paypal-auth-algo': 'SHA256withRSA',
    'user-agent': 'PayPal/AW-007',
    'content-type': 'application/json',
    ...over,
  }
}

/** The bytes of a body, as `handleWebhook` receives them. */
export function bytes(body: string): Uint8Array {
  return new Uint8Array(Buffer.from(body, 'utf8'))
}

/** A PayPal body as a `jsonb` value, the way `raw` is stored. */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** The `id` in a body, without throwing on a malformed one. */
function safeEventId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    return typeof parsed['id'] === 'string' ? parsed['id'] : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Cross-package consistency                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** The `switch` body of `attemptStateFor` in `packages/orders/src/budget-hooks.ts`. */
function ordersAttemptStateSource(): string {
  const src = readFileSync(
    join(import.meta.dirname, '..', '..', 'orders', 'src', 'budget-hooks.ts'),
    'utf8',
  )
  const start = src.indexOf('export function attemptStateFor')
  if (start === -1) {
    throw new Error('attemptStateFor not found in packages/orders/src/budget-hooks.ts')
  }
  return src.slice(start)
}

/**
 * The `packages/orders` checkout-attempt state `applyCaptureOutcome` writes for each of our order statuses.
 *
 * Read from **that package's own file at test time**, not copied here. The two packages must agree, and a
 * copied map is a map that silently stops agreeing when WP-11 adds a case. §8.3's attempt state machine is a
 * shared contract, and this is how a drift between two work packages gets caught without either editing the
 * other (AGENTS.md rule 8) — `test/jobs.test.ts` asserts the webhook path produces the same state WP-11 would.
 *
 * @param orderStatus one of the `order_status` values `applyCaptureOutcome` can write.
 * @returns the `checkout_attempts.state`, or `undefined` for a status WP-11 does not handle.
 */
export function attemptStateFor(orderStatus: string): string | undefined {
  const body = ordersAttemptStateSource()
  // Find the `case '<orderStatus>':` branch and read the first `return '<STATE>'` inside it. Branch-scoped so
  // an `AUTHORIZED` lookup cannot pick up the `PARTIALLY_CAPTURED` return that follows it.
  const caseAt = body.indexOf(`case '${orderStatus}':`)
  if (caseAt === -1) return undefined
  const rest = body.slice(caseAt)
  const nextCase = rest.indexOf('\n    case ')
  const branch = nextCase === -1 ? rest : rest.slice(0, nextCase)
  const returned = /return '([A-Z_]+)'/.exec(branch)
  return returned?.[1]
}

/** Every `order_status` value `applyCaptureOutcome` can write, as WP-11's own switch enumerates them. */
export function ordersHandledOrderStatuses(): string[] {
  const body = ordersAttemptStateSource()
  const switchAt = body.indexOf('switch (status)')
  if (switchAt === -1) return []
  const tail = body.slice(switchAt)
  const end = tail.indexOf('\n}')
  return [...tail.slice(0, end).matchAll(/case '([A-Z_]+)':/g)].map((m) => m[1] as string)
}

/**
 * The capture statuses WP-11's `outcomeFor` maps to a `CaptureOutcome`, read from its own source.
 *
 * The refund states (`PARTIALLY_REFUNDED`, `REFUNDED`) appear as `case` labels in that switch too — they
 * return `undefined` — so a naive case-label read would include them and a test comparing against this would
 * demand that a refund earn a §8.11 hook. It must not: §8.11 gives a refund no movement, and that is exactly
 * the rule this function exists to let a test check.
 *
 * So this reads only the cases whose branch **returns a string**, which is precisely the set of statuses
 * that earn a hook.
 */
export function ordersCaptureOutcomes(): string[] {
  const src = readFileSync(
    join(import.meta.dirname, '..', '..', 'orders', 'src', 'budget-hooks.ts'),
    'utf8',
  )
  const start = src.indexOf('export function outcomeFor')
  if (start === -1) throw new Error('outcomeFor not found in packages/orders/src/budget-hooks.ts')
  const tail = src.slice(start)
  const end = tail.indexOf('\n}')
  const body = tail.slice(0, end)
  const out: string[] = []
  for (const m of body.matchAll(/case '([A-Z_]+)':/g)) {
    const branch = body.slice(m.index, body.indexOf('\n    case ', m.index + 1))
    if (/return '[A-Z_]+'/.test(branch)) out.push(m[1] as string)
  }
  return out
}

/** Re-exported so a test file needs one import for the harness and one for the vocabulary. */
export type { Money, StoredEvent, WebhookDeps }

/* ------------------------------------------------------------------------------------------ */
/* The harness proves itself                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * A harness that cannot drop a webhook cannot make AT-M12.3 a real test, and a harness that merges a
 * redelivery into the first copy cannot make AT-M12.1 a real test. Both are asserted here rather than
 * discovered later.
 */
describe('test harness fidelity', () => {
  it('HARNESS-1 a dropped webhook stores nothing at all', async () => {
    const h = harness({
      routes: { 'POST /v1/notifications/verify-webhook-signature': verifySuccess() },
    })
    const ack = await h.world.deliver(
      (raw, headers) => handleWebhook(raw, headers, h.deps),
      { body: eventBody({ id: 'WH-DROPPED' }) },
      'drop',
    )

    expect(ack).toBeNull()
    // PayPal tried; we stored nothing. No row, no job, no fetch.
    expect(h.world.deliveriesOf('WH-DROPPED')).toHaveLength(1)
    expect(h.world.deliveriesOf('WH-DROPPED')[0]?.delivered).toBe(false)
    expect(h.world.eventFor('WH-DROPPED')).toBeUndefined()
    expect(h.world.rows.events.size).toBe(0)
    expect(h.queue.sent).toHaveLength(0)
    expect(h.paypal.callsTo('verify-webhook-signature')).toHaveLength(0)
  })

  it('HARNESS-2 the paypal_event_id key makes a redelivery return the first copy untouched', async () => {
    const h = harness()
    const input: NewWebhookEvent = {
      id: nextEventId(),
      paypal_event_id: 'WH-DUP',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource_type: 'capture',
      resource_id: PAYPAL.captureId,
      create_time: NOW,
      verified: 'PENDING',
      verified_at: null,
      raw: { first: true } as JsonValue,
      received_at: NOW,
      processed_at: null,
      attempts: 0,
      error: null,
    }
    const first = await h.world.store.events.ingestEvent(input)
    expect(first.ok && first.value.duplicate).toBe(false)
    const before = h.world.eventFor('WH-DUP')

    const second = await h.world.store.events.ingestEvent({
      ...input,
      id: nextEventId(),
      raw: { second: true } as JsonValue,
      received_at: new Date(NOW_MS + 60_000),
    })
    expect(second.ok && second.value.duplicate).toBe(true)
    const after = h.world.eventFor('WH-DUP')

    // Same row id, same `raw`, same `received_at`. The first copy is the case file.
    expect(after?.id).toBe(before?.id)
    expect(after?.raw).toEqual({ first: true })
    expect(after?.received_at.getTime()).toBe(NOW_MS)
    expect(h.world.rows.events.size).toBe(1)
  })

  it('HARNESS-3 the capture store refuses a rank downgrade and says so with applied:false', async () => {
    const h = harness({
      seed: { captures: [{ paypalCaptureId: PAYPAL.captureId, status: 'REFUNDED' }] },
    })
    const row = [...h.world.rows.captures.values()][0]!
    const refused = await h.world.store.aggregates.captures.applyFromFetch(row.id, {
      status: 'COMPLETED',
      raw: null,
      fetchedAt: NOW,
    })
    expect(refused.ok).toBe(true)
    expect(refused.ok && refused.value.applied).toBe(false)
    expect(h.world.rows.captures.get(row.id)?.status).toBe('REFUNDED')
  })

  it('HARNESS-4 the queue records a singletonKey instead of silently dropping a duplicate', () => {
    const q = inMemoryQueue()
    void q.send('wh.process', { resourceId: 'C1' }, { singletonKey: 'C1' })
    void q.send('wh.process', { resourceId: 'C1' }, { singletonKey: 'C1' })
    // Two sends recorded. pg-boss is what collapses them; a double that dropped one would hide that.
    expect(q.sentFor('C1')).toHaveLength(2)
  })
})
