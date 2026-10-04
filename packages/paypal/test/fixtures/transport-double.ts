/**
 * Transport double for `packages/paypal`'s tests.
 *
 * ## Read `README.md` in this directory first
 *
 * Spec §8.0 rule 5 says: "Never fake PayPal behaviour. No mocking of PayPal outside
 * `packages/paypal/test/fixtures`." This file is the single place where a PayPal-shaped thing is
 * invented, and it is deliberately a **transport** double, not a PayPal mock:
 *
 *  - It replaces `fetch`, nothing else. The client under test runs its real request-building, real
 *    header assembly, real retry loop, real backoff, real circuit breaker and real zod validation.
 *  - Every response shape below is **hand-written from the published PayPal API documentation**, and
 *    each carries the documentation URL it came from. Nothing here was captured from a sandbox,
 *    because we have no credentials yet (`docs/HUMAN_TODO.md` H-01).
 *  - Nothing here asserts PayPal's *behaviour* (that a given request id dedupes, that a header is
 *    honoured). Those are exactly the claims that need a real sandbox, and they are listed as
 *    UNVERIFIED in `../../IDEMPOTENCY.md`.
 *
 * Once H-01 lands, `scripts/capture-fixture.ts` writes real captured bodies into `fixtures/<date>/`
 * and the tests switch to them. This file is then deleted, not kept "just in case".
 */
import { fixedClock } from '@countersign/core'
import type { Clock, Currency } from '@countersign/core'

import type { PPMoney } from '../../src/types'

import type { Sleep } from '../../src/backoff'

// ---------------------------------------------------------------------------
// Documentation sources. Every invented shape below cites one of these.
// ---------------------------------------------------------------------------
export const DOC = {
  /** OAuth token endpoint. */
  auth: 'https://developer.paypal.com/api/rest/authentication/',
  /** Orders v2. */
  orders: 'https://developer.paypal.com/docs/api/orders/v2/',
  /** Payments v2. */
  payments: 'https://developer.paypal.com/docs/api/payments/v2/',
  /** Vault v3 setup-tokens / payment-tokens. */
  vault: 'https://developer.paypal.com/docs/api/vault/v3/',
  /** Customer Disputes v1. */
  disputes: 'https://developer.paypal.com/docs/api/customer-disputes/v1/',
  /** `provide-evidence` (the multipart upload). Cited by spec §10.2 #14. */
  provideEvidence:
    'https://developer.paypal.com/api/customer-disputes/v1/disputes-provide-evidence',
  /**
   * "Use Disputes API" — the only PayPal page with worked cURL for every seller dispute action, and
   * the source for the `{evidences:[…]}` input shape, the `file1` file field names and the
   * `{note, acknowledgement_type}` acknowledge body (report GUIDE).
   */
  disputesGuide: 'https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api',
  /** Evidence file sizes and types: "Less than 10 MB per file", "Up to 50 MB per API call". */
  evidenceFiles: 'https://developer.paypal.com/disputes/supported-file-sizes-types',
  /** The unsigned `PayPal-Auth-Assertion` construction for the buyer simulator. */
  disputesSetup: 'https://developer.paypal.com/disputes/set-up',
  /** Webhooks, including `verify-webhook-signature`. */
  webhooks: 'https://developer.paypal.com/api/rest/webhooks/event-names/',
  /** Idempotency: `PayPal-Request-Id`. */
  idempotency: 'https://developer.paypal.com/api/rest/reference/idempotency/',
  /** Rate limiting: 429 / `RATE_LIMIT_REACHED`. */
  rateLimiting: 'https://developer.paypal.com/api/rest/reference/rate-limiting/',
  /** Sandbox dispute simulators. */
  sandboxDisputes: 'https://developer.paypal.com/disputes/test-go-live',
} as const

// ---------------------------------------------------------------------------
// Recorded calls
// ---------------------------------------------------------------------------

export interface RecordedCall {
  /** 0-based order in which the client made this call. */
  readonly index: number
  readonly url: string
  readonly method: string
  /** Lower-cased header names. */
  readonly headers: Record<string, string>
  /** Whatever was handed to `fetch` as the body: a string, a `FormData`, or `undefined`. */
  readonly body: unknown
  readonly init: RequestInit | undefined
}

export interface FakeResponseSpec {
  readonly status?: number
  /** Serialised as JSON with `content-type: application/json`. */
  readonly body?: unknown
  /** Sent verbatim; takes precedence over `body`. Used for the HTML an edge returns on a 502. */
  readonly text?: string
  readonly headers?: Record<string, string>
  /** Default `PayPal-Debug-Id`, so the client's debug-id logging is exercised on every response. */
  readonly debugId?: string
  /** Throw instead of responding: a connection reset or a timeout. */
  readonly throws?: Error
}

/** Decides what to return for one call. `index` is the 0-based call number. */
export type Responder = (call: RecordedCall) => FakeResponseSpec | Promise<FakeResponseSpec>

export interface FetchDouble {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>
  /** Every call the client made, in order. */
  readonly calls: RecordedCall[]
  /** Calls to one path only. */
  callsTo(pathFragment: string): RecordedCall[]
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
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v)
    return out
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v)
  return out
}

function toResponse(spec: FakeResponseSpec, index: number): Response {
  if (spec.throws) throw spec.throws

  const status = spec.status ?? 200
  // PayPal sends the same id in the `PayPal-Debug-Id` header and in the body's `debug_id`. The double
  // mirrors that, so a test cannot accidentally assert on one while the other says something else.
  const bodyDebugId =
    typeof spec.body === 'object' &&
    spec.body !== null &&
    typeof (spec.body as { debug_id?: unknown }).debug_id === 'string'
      ? (spec.body as { debug_id: string }).debug_id
      : undefined
  const headers = new Headers({
    // The client must log it on every response (spec §8.6).
    'paypal-debug-id': spec.debugId ?? bodyDebugId ?? `DEBUG-FAKE-${index}`,
    ...(spec.headers ?? {}),
  })

  // 204/205/304 must not carry a body, and `new Response(body, {status:204})` throws.
  const bodyless = status === 204 || status === 205 || status === 304
  if (bodyless) return new Response(null, { status, headers })

  if (spec.text !== undefined) {
    if (!headers.has('content-type')) headers.set('content-type', 'text/html')
    return new Response(spec.text, { status, headers })
  }
  if (spec.body === undefined) return new Response(null, { status, headers })

  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(spec.body), { status, headers })
}

/**
 * A response stub, a queue of them (the last entry repeats), or a function that decides per call.
 *
 * A single stub is the common case; the queue is how AT-M6.2 expresses "503, 503, 200".
 */
export type Stub = FakeResponseSpec | FakeResponseSpec[] | Responder

/**
 * Build a `fetch` double.
 *
 * @param responder a function, a queue consumed one entry per call, or a single permanent stub.
 */
export function fakeFetch(responder: Stub): FetchDouble {
  const calls: RecordedCall[] = []
  const queue = Array.isArray(responder) ? [...responder] : null
  const single = !queue && typeof responder !== 'function' ? (responder as FakeResponseSpec) : null

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const record: RecordedCall = {
      index: calls.length,
      url,
      method: init?.method ?? 'GET',
      headers: normaliseHeaders(init),
      body: init?.body,
      init,
    }
    calls.push(record)

    const spec = queue
      ? (queue[Math.min(calls.length - 1, queue.length - 1)] as FakeResponseSpec)
      : (single ?? (await (responder as Responder)(record)))
    return toResponse(spec, record.index)
  }

  const double = impl as FetchDouble
  Object.defineProperties(double, {
    calls: { get: () => calls },
    callsTo: { value: (fragment: string) => calls.filter((c) => c.url.includes(fragment)) },
  })
  return double
}

/**
 * Route by `"<METHOD> <path fragment>"`, falling back to a path-fragment match.
 *
 * Values may be a single spec, a queue, or a function. Every unmatched call answers `404
 * UNPROCESSABLE_ENTITY`, so a test that accidentally calls an endpoint it did not stub fails loudly
 * instead of hanging.
 */
export function routedFetch(
  routes: Record<string, FakeResponseSpec | FakeResponseSpec[] | Responder>,
  fallback?: FakeResponseSpec,
): FetchDouble {
  const queues = new Map<string, FakeResponseSpec[]>()
  const counters = new Map<string, number>()
  return fakeFetch((call) => {
    const method = call.method.toUpperCase()
    const path = call.url.replace(/^https?:\/\/[^/]+/, '')
    for (const [key, value] of Object.entries(routes)) {
      const [routeMethod, routePath] = key.includes(' ') ? key.split(' ', 2) : [undefined, key]
      if (routeMethod !== undefined && routeMethod.toUpperCase() !== method) continue
      if (!path.includes(routePath)) continue
      if (typeof value === 'function') return value(call)
      const q = queues.get(key) ?? (Array.isArray(value) ? [...value] : [value as FakeResponseSpec])
      queues.set(key, q)
      const n = counters.get(key) ?? 0
      counters.set(key, n + 1)
      return q[Math.min(n, q.length - 1)] as FakeResponseSpec
    }
    return (
      fallback ?? {
        status: 404,
        // Doc: https://developer.paypal.com/api/rest/ — the standard error envelope.
        body: {
          name: 'RESOURCE_NOT_FOUND',
          message: `No stub for ${method} ${path}`,
          debug_id: 'DEBUG-UNSTUBBED',
        },
      }
    )
  })
}

// ---------------------------------------------------------------------------
// Doc-derived PayPal response bodies
// ---------------------------------------------------------------------------

/**
 * `POST /v1/oauth2/token` success. Doc: {@link DOC.auth}.
 *
 * PayPal documents `access_token`, `token_type`, `expires_in`, `scope` and `app_id`. `expires_in` is
 * seconds; the client caches for `expires_in - 60` (spec §8.6).
 */
export function tokenResponse(
  overrides: { expiresIn?: number; token?: string } = {},
): FakeResponseSpec {
  return {
    status: 200,
    body: {
      scope: 'https://uri.paypal.com/services/payments/payment',
      access_token: overrides.token ?? 'A21AAFakeAccessToken0000000000000000',
      token_type: 'Bearer',
      app_id: 'APP-80W284485P519543T',
      expires_in: overrides.expiresIn ?? 32400,
      nonce: '2026-10-04T12:00:00Z0123456789abcdef',
    },
  }
}

/** OAuth failure. Doc: {@link DOC.auth} — `error` / `error_description`, not `name` / `message`. */
export function oauthErrorResponse(
  error: string,
  description: string,
  status = 401,
): FakeResponseSpec {
  return { status, body: { error, error_description: description } }
}

/**
 * Orders v2 `POST /v2/checkout/orders`. Doc: {@link DOC.orders}.
 *
 * Field names used: `id`, `intent`, `status`, `purchase_units[].custom_id` (spec D18), `amount`,
 * `payer`, `create_time`, `links`.
 */
export function orderResponse(
  overrides: {
    id?: string
    status?: string
    intent?: string
    customId?: string
    invoiceId?: string
    authorizationId?: string
    value?: string
    currency?: string
  } = {},
): FakeResponseSpec {
  const id = overrides.id ?? '5O190127TN364715T'
  return {
    status: 201,
    body: {
      id,
      intent: overrides.intent ?? 'CAPTURE',
      status: overrides.status ?? 'CREATED',
      processing_instruction: 'ORDER_SAVED',
      purchase_units: [
        {
          reference_id: 'default',
          // D18: the chain hash, then our own order id.
          custom_id: overrides.customId ?? `cs1:${'A'.repeat(43)}`,
          invoice_id: overrides.invoiceId ?? 'ord_01JC0Z9P7YQ8V2N3M4K5L6R7ST8',
          amount: {
            currency_code: overrides.currency ?? 'USD',
            value: overrides.value ?? '48.00',
          },
          payee: { email_address: 'merchant-4799@example.com', merchant_id: '9KX436DUC84BN' },
        },
      ],
      payer: {},
      create_time: '2026-10-04T12:00:00Z',
      links: [
        {
          href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}`,
          rel: 'self',
          method: 'GET',
        },
        {
          href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}/capture`,
          rel: 'approve',
          method: 'POST',
        },
      ],
    },
  }
}

/**
 * Payments v2 authorization. Doc: {@link DOC.payments}.
 *
 * `expiration_time` matters to spec EC-TIME-5 (29 days, 3-day honour period [V15]).
 */
export function authorizationResponse(
  overrides: { id?: string; status?: string; expirationTime?: string; invoiceId?: string } = {},
): FakeResponseSpec {
  const id = overrides.id ?? '8AB12345AB6789123'
  return {
    status: 201,
    body: {
      id,
      status: overrides.status ?? 'CREATED',
      status_update_time: '2026-10-04T12:00:01Z',
      expiration_time: overrides.expirationTime ?? '2026-11-02T12:00:00Z',
      amount: { currency_code: 'USD', value: '48.00' },
      invoice_id: overrides.invoiceId ?? 'ord_01JC0Z9P7YQ8V2N3M4K5L6R7ST8',
      create_time: '2026-10-04T12:00:00Z',
      update_time: '2026-10-04T12:00:01Z',
      seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED'] },
      links: [
        {
          href: `https://api-m.sandbox.paypal.com/v2/payments/authorizations/${id}`,
          rel: 'self',
          method: 'GET',
        },
      ],
    },
  }
}

/**
 * Payments v2 capture. Doc: {@link DOC.payments}, [B12].
 *
 * `final_capture` and `seller_receivable_breakdown` are the fields the receipt and EC-FX-2 read.
 */
export function captureResponse(
  overrides: {
    id?: string
    status?: string
    value?: string
    finalCapture?: boolean
    invoiceId?: string
  } = {},
): FakeResponseSpec {
  const id = overrides.id ?? '3C679366HH908993F'
  return {
    status: 201,
    body: {
      id,
      status: overrides.status ?? 'COMPLETED',
      status_update_time: '2026-10-04T12:05:00Z',
      amount: { currency_code: 'USD', value: overrides.value ?? '48.00' },
      final_capture: overrides.finalCapture ?? true,
      invoice_id: overrides.invoiceId ?? 'ord_01JC0Z9P7YQ8V2N3M4K5L6R7ST8',
      seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED'] },
      seller_receivable_breakdown: {
        gross_amount: { currency_code: 'USD', value: overrides.value ?? '48.00' },
        paypal_fee: { currency_code: 'USD', value: '-1.62' },
        net_amount: { currency_code: 'USD', value: '46.38' },
        exchange_rate: '1.00',
      },
      create_time: '2026-10-04T12:04:59Z',
      update_time: '2026-10-04T12:05:00Z',
      links: [
        {
          href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${id}`,
          rel: 'self',
          method: 'GET',
        },
      ],
    },
  }
}

/**
 * Payments v2 refund. Doc: {@link DOC.payments}, [B12].
 *
 * `note_to_payer` and `seller_payable_breakdown` are documented fields of `refund_request`/`Refund`.
 */
export function refundResponse(
  overrides: { id?: string; status?: string; value?: string } = {},
): FakeResponseSpec {
  const id = overrides.id ?? '1JU08902781691411'
  return {
    status: 201,
    body: {
      id,
      status: overrides.status ?? 'COMPLETED',
      status_update_time: '2026-10-04T12:10:00Z',
      amount: { currency_code: 'USD', value: overrides.value ?? '12.34' },
      note_to_payer: 'Partial refund for the missing size 9 pair.',
      seller_payable_breakdown: {
        gross_amount: { currency_code: 'USD', value: '12.34' },
        paypal_fee: { currency_code: 'USD', value: '-0.42' },
        net_amount: { currency_code: 'USD', value: '11.92' },
      },
      create_time: '2026-10-04T12:09:59Z',
      update_time: '2026-10-04T12:10:00Z',
      links: [
        {
          href: `https://api-m.sandbox.paypal.com/v2/payments/refunds/${id}`,
          rel: 'self',
          method: 'GET',
        },
      ],
    },
  }
}

/**
 * Vault v3 setup token. Doc: {@link DOC.vault}.
 *
 * `usage_type`/`usage_pattern` come back under `payment_source.paypal`, and the documented `201`
 * includes a `rel: "confirm"` link to `/v3/vault/payment-token` (report §21/#27) — the alternative to
 * exchanging the setup token with a separate `POST /v3/vault/payment-tokens`.
 */
export function setupTokenResponse(overrides: { id?: string } = {}): FakeResponseSpec {
  const id = overrides.id ?? '8CM364183LM392832'
  return {
    status: 201,
    body: {
      id,
      status: 'CREATED',
      payment_source: {
        paypal: {
          usage_type: 'MERCHANT',
          usage_pattern: 'IMMEDIATE',
          experience_context: { return_url: 'x' },
        },
      },
      links: [
        {
          href: `https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/${id}/confirm-payment-source`,
          rel: 'approve',
          method: 'POST',
        },
        {
          href: `https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/${id}`,
          rel: 'self',
          method: 'GET',
        },
      ],
    },
  }
}

/**
 * Vault v3 payment token (the vault id). Doc: {@link DOC.vault}, [V10].
 *
 * `customer.id` and `payment_source.paypal.{email_address,payer_id,account_id}` are what §8.7 step 5
 * stores. **There is no top-level `payer`** — `payment_token_response` is `{id, customer,
 * payment_source, links}` (report §16).
 *
 * `payerId: false` reproduces PayPal's published example, which carries **only `account_id`**; the
 * client's `paymentTokenPayerId` falls back to it.
 */
export function paymentTokenResponse(
  overrides: { id?: string; email?: string; payerId?: string | false; accountId?: string } = {},
): FakeResponseSpec {
  const id = overrides.id ?? '5TY05013RG002845M'
  const payerId = overrides.payerId === undefined ? 'PAYER9DX42987Y' : overrides.payerId
  return {
    status: 201,
    body: {
      id,
      status: 'ACTIVE',
      customer: { id: 'CUSTOMER-9WB781254L9893217' },
      payment_source: {
        paypal: {
          ...(payerId === false ? {} : { payer_id: payerId }),
          account_id: overrides.accountId ?? 'VYYFH3WJ4JPJQ',
          account_status: 'VERIFIED',
          ...(overrides.email !== undefined ? { email_address: overrides.email } : {}),
        },
      },
      create_time: '2026-10-04T12:00:00Z',
      update_time: '2026-10-04T12:00:00Z',
      links: [
        {
          href: `https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/${id}`,
          rel: 'self',
          method: 'GET',
        },
      ],
    },
  }
}

/**
 * Customer Disputes v1 dispute. Doc: {@link DOC.disputes}, [V3], [B16].
 *
 * Field names used, all verified against the OpenAPI (report §11):
 *
 *  - `dispute_id`, `dispute_state` (the six-value enum), `status`, `dispute_life_cycle_stage`
 *  - **`reason`**, not `dispute_reason`
 *  - `seller_response_due_date` (RFC 3339 — we store UTC, display IST, EC-TIME-6)
 *  - **`disputed_transactions[]`**, the array that carries `seller_transaction_id` / `buyer_transaction_id`
 *  - `dispute_amount`
 *  - **`evidences[]`** (plural), each entry's `notes` a **string**
 *  - `messages[].posted_by`, not `.sender`
 *  - `require_evidence.action`, `allowed_response_options`, `adjudication_outcome`
 *
 * `links` includes an `appeal` HATEOAS link unless `appealable: false`, because that link — not
 * `dispute_state` — is what determines whether the dispute may be appealed (report §9/#17).
 */
export function disputeResponse(
  overrides: {
    id?: string
    status?: string
    state?: string
    reason?: string
    stage?: string
    sellerTransactionId?: string
    buyerTransactionId?: string
    dueDate?: string
    /** One entry of `evidences[]`; `notes` is a single string, ≤ 2000 chars. */
    notes?: string
    appealable?: boolean
  } = {},
): FakeResponseSpec {
  const id = overrides.id ?? 'PP-D-2781AB12CD34'
  const base = `https://api-m.sandbox.paypal.com/v1/customer/disputes/${id}`
  const links: Record<string, unknown>[] = [
    { href: base, rel: 'self', method: 'GET' },
    { href: `${base}/provide-evidence`, rel: 'provide-evidence', method: 'POST' },
  ]
  if (overrides.appealable !== false)
    links.push({ href: `${base}/appeal`, rel: 'appeal', method: 'POST' })
  return {
    status: 200,
    body: {
      dispute_id: id,
      dispute_state: overrides.state ?? 'REQUIRED_ACTION',
      reason: overrides.reason ?? 'UNAUTHORISED',
      dispute_life_cycle_stage: overrides.stage ?? 'CHARGEBACK',
      dispute_channel: 'INTERNAL',
      status: overrides.status ?? 'WAITING_FOR_SELLER_RESPONSE',
      // RFC 3339; we store UTC and display IST (EC-TIME-6).
      seller_response_due_date: overrides.dueDate ?? '2026-10-11T09:59:59Z',
      buyer_response_due_date: '2026-10-18T09:59:59Z',
      create_time: '2026-10-04T12:00:00Z',
      update_time: '2026-10-04T12:00:01Z',
      // The capture the dispute is against lives in here, not at the top level.
      disputed_transactions: [
        {
          buyer_transaction_id: overrides.buyerTransactionId ?? '7XQ12345AB6789123',
          seller_transaction_id: overrides.sellerTransactionId ?? '3C679366HH908993F',
        },
      ],
      dispute_amount: { currency_code: 'USD', value: '48.00' },
      dispute_currency: 'USD',
      dispute_summary: 'Buyer says they did not authorise this purchase.',
      acceptance_claim_reason: 'UNSUCCESSFUL_OR_UNKNOWN',
      require_evidence: { action: 'SELLER_EVIDENCE', due_date: '2026-10-11T09:59:59Z' },
      evidences: [
        {
          evidence_type: 'PROOF_OF_FULFILLMENT',
          notes: overrides.notes ?? 'Shipped 1 Oct via UPS.',
          date: '2026-10-04T12:00:00Z',
          evidence_info: {
            tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z999AA10123456784' }],
          },
          documents: [{ name: 'label.pdf', size: 1_024, type: 'application/pdf' }],
        },
      ],
      messages: [{ content: 'Please see the attached label.', posted_by: 'SELLER' }],
      allowed_response_options: {
        acknowledge_return_item: { acknowledgement_types: ['ITEM_RECEIVED', 'DAMAGED'] },
        accept_claim: { accept_claim_types: ['REFUND', 'PARTIAL_REFUND'] },
        make_offer: { offer_types: ['REFUND', 'REFUND_WITH_RETURN', 'REPLACEMENT_WITHOUT_REFUND'] },
      },
      items: [{ item_name: 'Trail Runner, size 9', purchase_date: '2026-10-01' }],
      links,
    },
  }
}

/**
 * `GET /v1/customer/disputes` envelope. Doc: {@link DOC.disputes}.
 *
 * The response is `{items, links}` (`SPEC-D` `dispute_search`): **no `total_pages`, no `total_items`** —
 * those were never PayPal fields (report §10). Forward paging is the `next` HATEOAS link.
 */
export function disputeListResponse(count = 1): FakeResponseSpec {
  return {
    status: 200,
    body: {
      items: Array.from(
        { length: count },
        (_v, i) => disputeResponse({ id: `PP-D-2781AB12CD3${i}` }).body as Record<string, unknown>,
      ),
      links: [
        {
          href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=10',
          rel: 'self',
          method: 'GET',
        },
      ],
    },
  }
}

/**
 * `POST /v2/customer-support/process-chargeback` response. Doc: {@link DOC.sandboxDisputes}
 * ("Test go live" → Simulate PayPal actions → Create chargeback).
 *
 * **201 Created with a body** (report §27/#2) — the previous `schema: null` discarded it. There is no
 * OpenAPI for this endpoint at all, so which of `dispute_id` / `id` is the real field is the sandbox
 * probe's answer; the response schema accepts both.
 */
export function chargebackResponse(
  overrides: { disputeId?: string; status?: number } = {},
): FakeResponseSpec {
  const disputeId = overrides.disputeId ?? 'PP-CB-2781AB12CD34'
  return {
    status: overrides.status ?? 201,
    body: {
      dispute_id: disputeId,
      status: 'CREATED',
      links: [
        {
          href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${disputeId}`,
          rel: 'self',
          method: 'GET',
        },
      ],
    },
  }
}

/**
 * The HATEOAS envelope the dispute action endpoints return. Doc: {@link DOC.disputes}.
 *
 * `200 OK` with `{links: […]}`, **not** `204 No Content` (report §2/#24) — every documented seller
 * dispute action answers this way. The client still tolerates a body-less 2xx because `void` and the
 * payment-token `DELETE` genuinely answer 204.
 */
export function linksResponse(rel = 'self'): FakeResponseSpec {
  return {
    status: 200,
    body: {
      links: [
        {
          href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-2781AB12CD34',
          rel,
          method: 'GET',
        },
      ],
    },
  }
}

/**
 * The standard PayPal error envelope. Doc: {@link DOC.payments} / {@link DOC.orders}.
 *
 * `details[].issue` is the field the spec asks us to keep on `PP_UNPROCESSABLE` (§8.6).
 */
export function paypalErrorResponse(
  name: string,
  issue: string | undefined,
  status: number,
  description = 'The requested action could not be performed.',
): FakeResponseSpec {
  return {
    status,
    body: {
      name,
      message: description,
      debug_id: `DEBUG-${name}`,
      details:
        issue === undefined
          ? []
          : [{ issue, description, field: "/purchase_units/@reference_id=='default'" }],
      links: [
        {
          href: 'https://developer.paypal.com/docs/api/orders/v2/#error-UNPROCESSABLE_ENTITY',
          rel: 'information_link',
          method: 'GET',
        },
      ],
    },
  }
}

/** 503 from the edge, which is what AT-M6.2 replays twice. */
export function serviceUnavailableResponse(): FakeResponseSpec {
  // PayPal's edge sometimes returns an HTML error page rather than JSON. Both are handled, and this
  // one is the harder case, so the retry tests use it.
  return {
    status: 503,
    text: '<html><head><title>503 Service Temporarily Unavailable</title></head></html>',
  }
}

/** 429 with `Retry-After`. Doc: {@link DOC.rateLimiting}. */
export function rateLimitedResponse(retryAfterSeconds = 2): FakeResponseSpec {
  return {
    status: 429,
    headers: { 'retry-after': String(retryAfterSeconds) },
    body: {
      name: 'RATE_LIMIT_REACHED',
      message: 'Too many requests. Retry after the indicated period.',
      debug_id: 'DEBUG-RATE-LIMITED',
      details: [],
    },
  }
}

/** 401 with the standard PayPal auth error body. */
export function unauthorizedResponse(): FakeResponseSpec {
  return {
    status: 401,
    body: {
      name: 'AUTHENTICATION_FAILURE',
      message: 'Authentication failed due to invalid authentication credentials.',
      debug_id: 'DEBUG-UNAUTHORIZED',
      links: [
        {
          href: 'https://developer.paypal.com/api/rest/authentication/',
          rel: 'information_link',
          method: 'GET',
        },
      ],
    },
  }
}

/** `verify-webhook-signature` response. Doc: {@link DOC.webhooks}. */
export function verifyWebhookResponse(
  status: 'SUCCESS' | 'FAILURE' | 'SOMETHING_NEW' = 'SUCCESS',
): FakeResponseSpec {
  return { status: 200, body: { verification_status: status } }
}

/**
 * A valid `CreateOrderReq` for the merchant-initiated (vault) path of spec §10.2 #5 and D17.
 *
 * `custom_id` is the evidence hash D18 stamps into PayPal's own records and `invoice_id` is our
 * `ord_…`. The amount is a **decimal string**, because that is PayPal's money shape — never a float.
 */
export function createOrderTestDouble(
  overrides: {
    intent?: 'CAPTURE' | 'AUTHORIZE'
    value?: string
    vaultId?: string
    invoiceId?: string
    customId?: string
  } = {},
): {
  intent: 'CAPTURE' | 'AUTHORIZE'
  purchase_units: {
    reference_id: string
    custom_id: string
    invoice_id: string
    amount: { currency_code: string; value: string }
  }[]
  payment_source: { paypal: { vault_id: string } }
} {
  return {
    intent: overrides.intent ?? 'CAPTURE',
    purchase_units: [
      {
        reference_id: 'default',
        custom_id: overrides.customId ?? `cs1:${'A'.repeat(43)}`,
        invoice_id: overrides.invoiceId ?? 'ord_01JC0Z9P7YQ8V2N3M4K5K6R7ST8',
        amount: { currency_code: 'USD', value: overrides.value ?? '48.00' },
      },
    ],
    payment_source: { paypal: { vault_id: overrides.vaultId ?? '5TY05013RG002845M' } },
  }
}

/**
 * A small `PPMoney` request amount.
 *
 * Typed as `PPMoney`, so `currency_code` is one of the currencies we actually support (spec §2) rather
 * than any three letters — the strictness is the point of having a request-side money type.
 */
export function ppMoney(value = '48.00', currency: Currency = 'USD'): PPMoney {
  return { currency_code: currency, value }
}

// ---------------------------------------------------------------------------
// Time and logging doubles
// ---------------------------------------------------------------------------

export interface TestClock extends Clock {
  nowMs(): number
  nowSec(): number
  set(sec: number): void
  advance(deltaSec: number): void
}

/** A clock pinned at a fixed second. Never `Date.now()` in a test (spec §8.1). */
export function testClock(startSec = 1_760_000_000): TestClock {
  return fixedClock(startSec) as TestClock
}

export interface RecordingSleep {
  readonly sleep: Sleep
  /** Every delay the client asked for, in order. */
  readonly delays: number[]
  /** Sum of every requested delay. The "did we actually wait?" assertion reads this. */
  totalMs(): number
}

/**
 * A sleep that records instead of waiting, and advances the fake clock.
 *
 * Advancing the clock is what makes the Retry-After test meaningful: after the client "waits" 2 s, a
 * subsequent token-cache check sees the new time. Zero real milliseconds pass either way.
 */
export function recordingSleep(clock?: TestClock): RecordingSleep {
  const delays: number[] = []
  return {
    delays,
    totalMs: () => delays.reduce((a, b) => a + b, 0),
    sleep: async (ms: number) => {
      delays.push(ms)
      if (clock && Number.isFinite(ms) && ms > 0) clock.advance(ms / 1000)
    },
  }
}

/** A deterministic stand-in for `Math.random` in the jitter formula: always the same value. */
export function fixedRandom(value = 0.5): () => number {
  return () => value
}

/**
 * One captured log line. `createLogger` writes a flat JSON object — `{ts, level, msg, ...fields}` —
 * so the logger's own fields sit alongside `ts`/`level`/`msg` rather than under a `fields` key.
 */
export type CapturedLog = { level: string; msg: string } & Record<string, unknown>

export interface CapturingLogger {
  /** The level this capture was created at, so a caller can pass it straight to `createLogger`. */
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly sink: { write: (line: string) => void }
  readonly logs: CapturedLog[]
  /** Every line that carried this key, across all levels. */
  fieldsWith(key: string): CapturedLog[]
  clear(): void
}

/**
 * Capture log lines so a test can assert that `paypal-debug-id` was recorded on **every** response
 * (spec §8.6 "Logging"). The level defaults to `debug` deliberately: the success log lives at debug,
 * so a logger left at `info` would hide the very thing the requirement is about.
 */
export function capturingLogger(
  level: 'debug' | 'info' | 'warn' | 'error' = 'debug',
): CapturingLogger {
  const logs: CapturedLog[] = []
  return {
    level,
    logs,
    sink: {
      write: (line: string) => {
        try {
          logs.push(JSON.parse(line) as CapturedLog)
        } catch {
          logs.push({ level: 'raw', msg: line })
        }
      },
    },
    fieldsWith: (key: string) => logs.filter((l) => key in l),
    clear: () => {
      logs.length = 0
    },
  }
}

// ---------------------------------------------------------------------------
// Call inspection helpers
// ---------------------------------------------------------------------------

/** One header from a recorded call, case-insensitively. */
export function headerOf(call: RecordedCall, name: string): string | undefined {
  return call.headers[name.toLowerCase()]
}

/** The JSON body of a recorded call. Throws if it is not JSON — a failing test should say so. */
export function jsonBody<T = Record<string, unknown>>(call: RecordedCall): T {
  if (typeof call.body !== 'string') {
    throw new Error(`Expected a JSON body on ${call.method} ${call.url}, got ${typeof call.body}`)
  }
  return JSON.parse(call.body) as T
}

/** One multipart field. `FormDataEntryValue` is a DOM type, so it is spelled out here. */
export type FormPartValue = string | Blob

/** Every multipart field on a recorded call, as `{name, value, fileName}` triples. */
export function formParts(
  call: RecordedCall,
): { name: string; value: FormPartValue; fileName?: string }[] {
  if (!(call.body instanceof FormData)) {
    throw new Error(
      `Expected a FormData body on ${call.method} ${call.url}, got ${typeof call.body}`,
    )
  }
  const out: { name: string; value: FormPartValue; fileName?: string }[] = []
  call.body.forEach((value, name) => {
    out.push({
      name,
      value: value as FormPartValue,
      fileName: value instanceof File ? value.name : undefined,
    })
  })
  return out
}

/** Read a multipart file part back as text. */
export async function partText(part: FormPartValue): Promise<string> {
  if (typeof part === 'string') return part
  if (part instanceof Blob) return part.text()
  throw new Error('FormData value is neither a string nor a Blob')
}

/** A tiny valid 1-page PDF, so the multipart test uploads real bytes rather than a placeholder. */
export function onePagePdfBytes(): Uint8Array {
  return new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n%%EOF\n',
  )
}
