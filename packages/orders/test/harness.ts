/**
 * The orchestrator's test harness — one `fetch` double, one in-memory world, one `OrdersDeps`.
 *
 * ## What is faked, and what is not
 *
 * AGENTS.md rule 5: *"Never fake PayPal behaviour. No mocking of PayPal outside
 * `packages/paypal/test/fixtures`."* This harness respects that by replacing exactly two things, and no more:
 *
 *  - **the socket** (`fetchImpl`, the seam `PayPalClientOpts` already declares). Every test drives the real
 *    `PayPalClient`, so the request building, the `PayPal-Request-Id` header, the retry loop, the backoff, the
 *    circuit breaker and the zod validation all run for real. The *responses* are doc-derived stubs, which is
 *    the same seam `packages/paypal/test/fixtures/transport-double.ts` uses; nothing here decides what PayPal
 *    would have done, and no test asserts PayPal behaviour from these bodies.
 *  - **our own rows** (`createInMemoryOrderWorld`), which models the unique indexes that *are* the
 *    idempotency defences and the guarded `UPDATE` behind EC-REF-2.
 *
 * The budget is **not** faked at all: it is `createInMemoryBudgetStore` from `@countersign/gate` driven
 * through the real `commitIn`/`releaseIn`/`reverseIn` from `@countersign/db`, so the ledger arithmetic under
 * test is the arithmetic that ships.
 *
 * ## One fixed instant, everywhere
 *
 * `NOW_SEC` and a `fixedClock` mean every timestamp a test asserts is a constant, and no assertion is ever
 * about "roughly now". AGENTS.md rule 10: time is UTC epoch seconds.
 */

import {
  fixedClock,
  type AttemptId,
  type Clock,
  type MandateId,
  type Money,
} from '@countersign/core'
import { createInMemoryBudgetStore, type InMemoryBudgetStore } from '@countersign/gate'
import type {
  CheckoutAttemptRow,
  CheckoutSessionRow,
  DisputeRow,
  GateDecisionRow,
  L1Row,
  MandateRow,
  ProductRow,
  WalletRow,
} from '@countersign/db'
import { PayPalClient } from '@countersign/paypal'

import { budgetHooksFromStore, createInMemoryOrderWorld, recordingNotifier } from '../src/deps'
import { defineOrderDeps } from '../src/types'
import type { OrdersDeps } from '../src/types'

/** Every test's "now". 2026-10-04T00:00:00Z-ish; a constant so no assertion is about wall time. */
export const NOW_SEC = 1_789_000_000

export const ATTEMPT_ID = 'att_00000000000000000000000001' as AttemptId
export const MANDATE_ID = 'mdt_00000000000000000000000001' as MandateId
export const SESSION_ID = 'chk_00000000000000000000000001' as `chk_${string}`
export const DECISION_ID = 'gdc_00000000000000000000000001' as `gdc_${string}`
export const WALLET_ID = 'wal_00000000000000000000000001' as `wal_${string}`
export const USER_ID = 'usr_00000000000000000000000001'
export const MERCHANT_ID = '9KX436DUC84BN'
export const VAULT_ID = '5TY05013RG002845M'

/** PayPal's own ids, from the documentation examples in `packages/paypal/test/fixtures`. */
export const PAYPAL = {
  orderId: '5O190127TN364715T',
  authorizationId: '8AB12345AB6789123',
  captureId: '3C679366HH908993F',
  refundId: '1JU08902781691411',
  trackerId: 'TRACKER-1Z999AA10123456784',
} as const

/* ------------------------------------------------------------------------------------------ */
/* The fetch double                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface RecordedCall {
  readonly index: number
  readonly method: string
  /** Path with the base URL stripped, e.g. `/v2/checkout/orders`. */
  readonly path: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

/** A stubbed HTTP response. Bodies here are **doc-derived**, never captured (H-01 is open). */
export interface StubResponse {
  readonly status?: number
  readonly body?: unknown
  /** Sent verbatim, with no content-type. What PayPal's edge returns on a 503. */
  readonly text?: string
  readonly headers?: Record<string, string>
  /** Throw instead of responding — a connection reset, which is how EC-IDEM-2 is exercised. */
  readonly throws?: Error
}

/**
 * The inline `authorizations[0]`/`captures[0]` overrides.
 *
 * `boolean` as a shorthand: `true` = "include it with PayPal's documented defaults", `false` = "omit the
 * whole `payments` block", which is what makes `resolvePayment` take its fallback branch.
 */
type Inline<T> = boolean | T

export interface FakePayPal {
  readonly fetchImpl: typeof fetch
  readonly calls: RecordedCall[]
  /**
   * Calls to one endpoint, by path fragment. A substring, so `'/authorize'` selects
   * `/v2/checkout/orders/{id}/authorize` and `'/capture'` selects the payments capture — which is why the
   * route templates above are exact while the queries stay loose.
   */
  callsTo(fragment: string): RecordedCall[]
  /** The body of the nth call to a path fragment, parsed. Throws if it was not JSON. */
  bodyOf<T = Record<string, unknown>>(fragment: string, nth?: number): T
  /** `PayPal-Request-Id` of the nth call to a path fragment. */
  requestIdOf(fragment: string, nth?: number): string | undefined
  /**
   * Replace the route table and forget the queues.
   *
   * Needed because a queue is consumed per call: a test that stubs `503, 503` and then wants a happy path
   * cannot keep the same table, and building a whole new world per route set would make every test own its
   * fixture rather than describing one scenario.
   */
  setRoutes(routes: Routes): void
  /** Register a hook that runs before a response is produced — for "the world changed mid-call" tests. */
  onBeforeRespond(hook: (call: RecordedCall) => void): void
  reset(): void
}

/**
 * `"<METHOD> <path template>"` → one response, a queue of them, or a function of the call.
 *
 * Templates are matched **segment by segment, with `{id}` standing for any one segment**, and the segment
 * counts must be equal. That precision is not decoration: PayPal's endpoints nest, and
 * `/v2/payments/authorizations/{id}/capture` and `/v2/checkout/orders/{id}/capture` share their last two
 * segments, so a substring or "first declared wins" matcher would answer a capture with the *order's*
 * capture stub and the assertion would pass for the wrong reason. The templates below are the same
 * `"<METHOD> <path template>"` strings `packages/paypal`'s `ENDPOINT_POLICIES` is keyed by, which is why
 * both packages can be read against one table.
 */
export type Routes = Record<
  string,
  StubResponse | StubResponse[] | ((call: RecordedCall) => StubResponse)
>

/** Does `path` match `template`, segment-wise, with `{…}` as a one-segment wildcard? */
export function matchesTemplate(path: string, template: string): boolean {
  const a = path.split('/')
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
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v)
    return out
  }
  for (const [k, v] of Object.entries(h as Record<string, string>))
    out[String(k).toLowerCase()] = String(v)
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

/**
 * A routing `fetch` double.
 *
 * Routes are keyed `"<METHOD> <path fragment>"`, first match wins, and **an unmatched call answers 422**
 * rather than hanging — so a test that reaches an endpoint it did not stub fails loudly with PayPal's own
 * `UNPROCESSABLE_ENTITY` envelope instead of timing out.
 *
 * A queue is consumed **one entry per call** and the last entry repeats, which is how "503, 503, 200" is
 * written. `setRoutes` resets the counters, so a test can stub a failure, watch it fail, then stub success
 * on the same double.
 */
export function fakePayPal(routes: Routes = {}): FakePayPal {
  const calls: RecordedCall[] = []
  const queues = new Map<string, StubResponse[]>()
  const counters = new Map<string, number>()
  const hooks: ((call: RecordedCall) => void)[] = []
  let table = routes

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = url.replace(/^https?:\/\/[^/]+/, '')
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
      if (!matchesTemplate(path, routeTemplate ?? key)) continue
      const n = counters.get(key) ?? 0
      counters.set(key, n + 1)
      // A queue's last entry repeats, which is how "503, 503" stays a 503 on the second call.
      const spec =
        typeof value === 'function'
          ? (value as (c: RecordedCall) => StubResponse)(record)
          : Array.isArray(value)
            ? (value[Math.min(n, value.length - 1)] as StubResponse)
            : (value as StubResponse)
      // Hooks run last, so a test can mutate the world (flip a mandate, void an authorization) in the
      // window between our request leaving and the response arriving — the window EC-MDT-2 is about.
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
    bodyOf<T>(fragment: string, nth = 0) {
      const call = calls.filter((c) => c.path.includes(fragment))[nth]
      if (!call || typeof call.body !== 'string') {
        throw new Error(`No JSON body on call ${nth} to a path containing "${fragment}"`)
      }
      return JSON.parse(call.body) as T
    },
    requestIdOf: (fragment, nth = 0) => {
      const matching = calls.filter((c) => c.path.includes(fragment))
      return matching[nth]?.headers['paypal-request-id']
    },
    setRoutes: (next) => {
      table = next
      queues.clear()
      counters.clear()
    },
    onBeforeRespond: (hook) => {
      hooks.push(hook)
    },
    reset: () => {
      calls.length = 0
      queues.clear()
      counters.clear()
    },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Doc-derived PayPal bodies                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * `POST /v2/checkout/orders` success.
 *
 * Doc: <https://developer.paypal.com/docs/api/orders/v2/> and the audit's §17 example, whose 201 contains
 * the authorization **inline** for a `vault_id` + `AUTHORIZE` order. `inlineAuthorization: false` produces
 * the shape with no `payments` block, which is what makes `resolvePayment` take its `/authorize` fallback —
 * so the same builder exercises both branches of the C2 question, and the tests say which they took.
 */
export function orderBody(
  overrides: {
    id?: string
    status?: string
    customId?: string
    invoiceId?: string
    value?: string
    currency?: string
    /**
     * `true` for PayPal's documented default, `false` to omit the block entirely (the fallback branch), or
     * an object to override individual fields.
     */
    inlineAuthorization?: Inline<{
      id?: string
      status?: string
      expirationTime?: string
      value?: string
    }>
    inlineCapture?: Inline<{ id?: string; status?: string; value?: string; finalCapture?: boolean }>
  } = {},
): StubResponse {
  const auth = overrides.inlineAuthorization
  const capture = overrides.inlineCapture
  const payments: Record<string, unknown> = {}
  if (auth !== undefined && auth !== false) {
    // `true` means "PayPal's documented shape", which includes `expiration_time`; the **object** form is
    // fully explicit, so `{ id }` alone produces a response with no `expiration_time` at all — which is
    // what exercises `create.ts`'s 29-day fallback.
    const a: { id?: string; status?: string; expirationTime?: string; value?: string } =
      typeof auth === 'boolean'
        ? { expirationTime: '2026-11-02T00:00:00Z' }
        : { ...auth, expirationTime: auth.expirationTime }
    payments['authorizations'] = [
      {
        id: a.id ?? PAYPAL.authorizationId,
        status: a.status ?? 'CREATED',
        amount: {
          currency_code: overrides.currency ?? 'USD',
          value: a.value ?? overrides.value ?? '100.00',
        },
        ...(a.expirationTime !== undefined ? { expiration_time: a.expirationTime } : {}),
        seller_protection: { status: 'ELIGIBLE' },
      },
    ]
  }
  if (capture !== undefined && capture !== false) {
    const c: { id?: string; status?: string; value?: string; finalCapture?: boolean } =
      typeof capture === 'boolean' ? {} : capture
    payments['captures'] = [
      {
        id: c.id ?? PAYPAL.captureId,
        status: c.status ?? 'COMPLETED',
        amount: {
          currency_code: overrides.currency ?? 'USD',
          value: c.value ?? overrides.value ?? '100.00',
        },
        final_capture: c.finalCapture ?? true,
      },
    ]
  }

  return {
    status: 201,
    body: {
      id: overrides.id ?? PAYPAL.orderId,
      intent: 'AUTHORIZE',
      status: overrides.status ?? 'CREATED',
      purchase_units: [
        {
          reference_id: 'default',
          custom_id: overrides.customId ?? `cs1:${'A'.repeat(43)}`,
          invoice_id: overrides.invoiceId ?? 'ord_00000000000000000000000001',
          amount: {
            currency_code: overrides.currency ?? 'USD',
            value: overrides.value ?? '100.00',
          },
          payee: { merchant_id: MERCHANT_ID },
          ...(Object.keys(payments).length > 0 ? { payments } : {}),
        },
      ],
      payer: {},
      create_time: '2026-10-04T00:00:00Z',
      links: [
        {
          href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${overrides.id ?? PAYPAL.orderId}`,
          rel: 'self',
          method: 'GET',
        },
      ],
    },
  }
}

/** `POST /v2/payments/authorizations/{id}/capture`. Doc: <https://developer.paypal.com/docs/api/payments/v2/> */
export function captureBody(
  overrides: {
    id?: string
    status?: string
    value?: string
    currency?: string
    finalCapture?: boolean
  } = {},
): StubResponse {
  return {
    status: 201,
    body: {
      id: overrides.id ?? PAYPAL.captureId,
      status: overrides.status ?? 'COMPLETED',
      status_update_time: '2026-10-04T00:05:00Z',
      amount: { currency_code: overrides.currency ?? 'USD', value: overrides.value ?? '60.00' },
      final_capture: overrides.finalCapture ?? false,
      invoice_id: 'ord_00000000000000000000000001',
      seller_protection: { status: 'ELIGIBLE' },
    },
  }
}

/** The `OrderCancelled`/`INSTRUMENT_DECLINED` envelope [B12]. */
export function declinedCapture(): StubResponse {
  return {
    status: 422,
    body: {
      name: 'UNPROCESSABLE_ENTITY',
      message: 'The instrument presented was either declined by the processor or was not allowed.',
      debug_id: 'DEBUG-DECLINED',
      details: [
        {
          issue: 'INSTRUMENT_DECLINED',
          description:
            'The requested action could not be performed, semantically incorrect, or failed business validation.',
        },
      ],
    },
  }
}

/** `POST /v2/payments/captures/{id}/refund`. Doc: <https://developer.paypal.com/docs/api/payments/v2/> */
export function refundBody(
  overrides: { id?: string; status?: string; value?: string } = {},
): StubResponse {
  return {
    status: 201,
    body: {
      id: overrides.id ?? PAYPAL.refundId,
      status: overrides.status ?? 'COMPLETED',
      status_update_time: '2026-10-04T00:10:00Z',
      amount: { currency_code: 'USD', value: overrides.value ?? '20.00' },
      invoice_id: 'ord_00000000000000000000000001',
    },
  }
}

/**
 * `POST /v2/checkout/orders/{id}/track` — §10.2 #8.
 *
 * The client parses this as an **Order** (`schema: orderSchema`, which requires `id` and `status`), so the
 * stub carries both even though the interesting member is the `rel: "track"` link carrying the tracker id.
 * A response with only `links` would fail the real client's validation, and the test would be measuring my
 * stub rather than the code.
 */
export function trackBody(overrides: { trackerId?: string; orderId?: string } = {}): StubResponse {
  const trackerId = overrides.trackerId ?? PAYPAL.trackerId
  const orderId = overrides.orderId ?? PAYPAL.orderId
  return {
    status: 200,
    body: {
      id: orderId,
      status: 'COMPLETED',
      links: [
        {
          href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`,
          rel: 'self',
          method: 'GET',
        },
        {
          href: `https://api-m.sandbox.paypal.com/v1/shipping/trackers/${trackerId}`,
          rel: 'track',
          method: 'GET',
        },
      ],
    },
  }
}

/** `POST /v2/payments/authorizations/{id}/void` — `204 No Content` [B12]. */
export function voidBody(): StubResponse {
  return { status: 204 }
}

/** `POST /v2/payments/authorizations/{id}/reauthorize`. */
export function reauthorizeBody(overrides: { expirationTime?: string } = {}): StubResponse {
  return {
    status: 201,
    body: {
      id: PAYPAL.authorizationId,
      status: 'CREATED',
      expiration_time: overrides.expirationTime ?? '2026-12-02T00:00:00Z',
      amount: { currency_code: 'USD', value: '100.00' },
    },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The world                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** The default catalog: two physical lines and one digital line, so D17's rule is testable. */
export const DEFAULT_PRODUCTS: ProductRow[] = [
  {
    sku: 'NW-001',
    title: 'Trail Runner',
    description: 'A running shoe.',
    price_minor: 4_500n,
    currency: 'USD',
    stock: 10,
    ships_in_days: 2,
    digital: false,
    listing_html: '<p>A running shoe.</p>',
    created_at: new Date(NOW_SEC * 1000),
    updated_at: new Date(NOW_SEC * 1000),
  },
  {
    sku: 'NW-002',
    title: 'Wool Socks',
    description: 'Two pairs.',
    price_minor: 1_500n,
    currency: 'USD',
    stock: 10,
    ships_in_days: 2,
    digital: false,
    listing_html: '<p>Two pairs.</p>',
    created_at: new Date(NOW_SEC * 1000),
    updated_at: new Date(NOW_SEC * 1000),
  },
  {
    sku: 'NW-024',
    title: 'Gift Card',
    description: 'A digital gift card.',
    price_minor: 1_000n,
    currency: 'USD',
    stock: 999,
    ships_in_days: 0,
    digital: true,
    listing_html: '<p>A digital gift card.</p>',
    created_at: new Date(NOW_SEC * 1000),
    updated_at: new Date(NOW_SEC * 1000),
  },
]

export interface WorldOptions {
  /** Override the catalog. Defaults to {@link DEFAULT_PRODUCTS}. */
  readonly products?: readonly Partial<ProductRow>[]
  /** The cart. Defaults to one of each seeded product. */
  readonly lines?: readonly { sku: string; qty: number }[]
  /** The order total, and therefore the reservation the Gate took. Defaults to the cart total. */
  readonly amount?: Money
  /** The cap the Gate checked against. Defaults to $130.00 (the seeded mandate's read-back). */
  readonly cap?: Money
  readonly mandate?: Partial<MandateRow>
  readonly wallet?: Partial<WalletRow>
  readonly session?: Partial<CheckoutSessionRow>
  readonly attempt?: Partial<CheckoutAttemptRow>
  /** The stored `gate_decisions` row. The orchestrator reads its id, attempt, signed record and commit. */
  readonly decision?: Partial<GateDecisionRow>
  readonly l1?: Partial<L1Row>
  readonly openDisputes?: readonly Partial<DisputeRow>[]
  /** The budget's opening balances. Defaults to a fully-reserved order total against the cap. */
  readonly reserved?: bigint
  readonly spent?: bigint
  readonly nowSec?: number
  /**
   * `PayPalClientOpts.maxRetries` — the **total** attempt count, per §8.6's reading.
   *
   * The default is 1 (no retry) so that "exactly one HTTP request" is assertable, which EC-CAP-3,
   * EC-CAP-4 and AT-M11.4 all need. A test that exercises the retry loop (EC-IDEM-2) raises it.
   */
  readonly maxRetries?: number
  /**
   * Use **this** `PayPalClient` instead of the stub-backed one.
   *
   * The single seam that lets `test/orchestrator.sandbox.test.ts` reuse every world, budget and row helper
   * here while talking to the real sandbox: it passes a client built from real credentials and no
   * `fetchImpl`. This file stays credential-free on purpose — a credential read here would put H-01's
   * dependency into the PR-gate suite.
   */
  readonly client?: PayPalClient
}

/** Everything a test needs: the deps, the world, the ledger, and the notification log. */
export interface Harness {
  readonly deps: OrdersDeps
  readonly world: ReturnType<typeof createInMemoryOrderWorld>
  readonly paypal: FakePayPal
  readonly budget: InMemoryBudgetStore
  readonly notifier: ReturnType<typeof recordingNotifier>
  readonly clock: Clock & { set(sec: number): void; advance(deltaSec: number): void }
  /** Set the captured `now` to a specific second, for EC-TIME-5's window tests. */
  setNow(sec: number): void
  /** The budget ledger entries, for asserting what moved and what did not. */
  entries(): readonly BudgetEntryRowLike[]
  /** `Σ RESERVE − Σ RELEASE − Σ COMMIT`, the ledger's own definition of `reserved`. */
  reserved(): bigint
  /** `Σ COMMIT`. */
  spent(): bigint
}

interface BudgetEntryRowLike {
  readonly kind: 'RESERVE' | 'RELEASE' | 'COMMIT' | 'REVERSE'
  readonly amount_minor: bigint
  readonly capture_id: string | null
  readonly reason: string
}

/**
 * Build a world with everything wired.
 *
 * The budget account opens with the Gate's check-8 reservation already written, because that is the state the
 * orchestrator always meets: a Gate `ALLOW` is by definition a decision whose reservation exists. A test that
 * wants an unreserved world passes `reserved: 0n`.
 */
export function harness(options: WorldOptions = {}): Harness {
  const nowSec = options.nowSec ?? NOW_SEC
  const clock = fixedClock(nowSec)
  const products = options.products ?? DEFAULT_PRODUCTS

  const lines = options.lines ?? products.map((p) => ({ sku: p.sku ?? 'NW-001', qty: 1 }))
  const priced = lines.map((l) => {
    const product = products.find((p) => p.sku === l.sku)
    // `unit_minor` is a `bigint` in memory and a JSON number on the wire. §7.2 stores it as `jsonb`, and
    // `canonicalJson` renders a bigint as a quoted string, so the in-memory form is the honest one — the
    // cast below is the `jsonb` boundary every Drizzle insert also crosses.
    return { sku: l.sku, qty: l.qty, unit_minor: product?.price_minor ?? 1_000n }
  })
  const subtotal = priced.reduce((acc, l) => acc + l.unit_minor * BigInt(l.qty), 0n)
  const shipping = 500n
  const total = subtotal + shipping
  const cap = options.cap ?? { minor: 13_000n, currency: 'USD' as const }
  const amount = options.amount ?? { minor: total, currency: 'USD' as const }

  const world = createInMemoryOrderWorld({
    nowSec,
    products,
    session: {
      cart: { lines: priced } as unknown as CheckoutSessionRow['cart'],
      subtotal_minor: subtotal,
      tax_minor: 0n,
      shipping_minor: shipping,
      total_minor: total,
      currency: amount.currency,
      ...options.session,
    },
    attempt: { amount_minor: amount.minor, currency: amount.currency, ...options.attempt },
    mandate: options.mandate,
    wallet: options.wallet,
    decision: options.decision,
    l1: options.l1,
    openDisputes: options.openDisputes,
  })

  const budget = createInMemoryBudgetStore({
    accounts: [
      {
        mandate_id: MANDATE_ID,
        currency: cap.currency,
        cap_minor: cap.minor,
        reserved_minor: options.reserved ?? amount.minor,
        spent_minor: options.spent ?? 0n,
        version: 1,
        created_at: new Date(nowSec * 1000),
        updated_at: new Date(nowSec * 1000),
      },
    ],
  })
  // The Gate's own RESERVE entry, so `reserved()` reconciles the way §7.2's nightly check expects.
  const initial = options.reserved ?? amount.minor
  if (initial > 0n) {
    void budget.insertBudgetEntry({
      id: 'ben_gate_reserve_0000000001',
      mandate_id: MANDATE_ID,
      attempt_id: ATTEMPT_ID,
      kind: 'RESERVE',
      amount_minor: initial,
      at: new Date(nowSec * 1000),
      reason: 'gate check 8 reserve',
      capture_id: null,
      currency: cap.currency,
    })
  }
  if ((options.spent ?? 0n) > 0n) {
    void budget.insertBudgetEntry({
      id: 'ben_gate_commit_00000000001',
      mandate_id: MANDATE_ID,
      attempt_id: null,
      kind: 'COMMIT',
      amount_minor: options.spent ?? 0n,
      at: new Date(nowSec * 1000),
      reason: 'capture cap_00000000000000000000000001 completed',
      capture_id: 'cap_00000000000000000000000001',
      currency: cap.currency,
    })
  }

  const notifier = recordingNotifier()
  const paypal = fakePayPal()
  // The default table, so a test that only exercises part of the flow still has a working OAuth handshake.
  paypal.setRoutes(defaultRoutes())

  const client =
    options.client ??
    new PayPalClient({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      clientId: 'TEST-CLIENT-ID',
      clientSecret: 'TEST-CLIENT-SECRET',
      clock,
      fetchImpl: paypal.fetchImpl,
      env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' },
      // One attempt by default: a test that wants the retry loop says so (`maxRetries`), and a default of 4
      // would make "exactly one HTTP request" (EC-CAP-3, EC-CAP-4, AT-M11.4) impossible to state.
      maxRetries: options.maxRetries ?? 1,
      sleep: async () => undefined,
    })

  const deps = defineOrderDeps({
    clock,
    paypal: client,
    store: world.store,
    budget: budgetHooksFromStore(budget),
    notify: notifier,
  })

  return {
    deps,
    world,
    paypal,
    budget,
    notifier,
    clock,
    setNow: (sec) => clock.set(sec),
    entries: () => budget.entries() as unknown as BudgetEntryRowLike[],
    reserved: () => {
      const row = budget.accounts().get(MANDATE_ID)
      return row ? row.reserved_minor : 0n
    },
    spent: () => {
      const row = budget.accounts().get(MANDATE_ID)
      return row ? row.spent_minor : 0n
    },
  }
}

/** A `GateDecision` shaped ALLOW. The orchestrator only reads `id`, `decision` and `reasons`. */
export function allowDecision(overrides: { id?: `gdc_${string}` } = {}) {
  return {
    id: overrides.id ?? DECISION_ID,
    decision: 'ALLOW' as const,
    reasons: [],
    checks: [],
    signedRecord: 'eyJhbGciOiJFZERTQSJ9.eyJna2MiOiJnZGMiLCJhdHQiOiJhdHRfMSJ9.sig',
    nowSec: NOW_SEC,
    pendingNetworkEnforcement: [],
    reservation: { amount: { minor: 0n, currency: 'USD' as const }, budgetVersion: 1 },
  }
}

/** A `GateDecision` shaped BLOCK. */
export function blockDecision() {
  return {
    id: DECISION_ID,
    decision: 'BLOCK' as const,
    reasons: [
      {
        code: 'GATE_BUDGET_EXCEEDED' as const,
        message: 'Mandate mdt_1: 10000 requested, 5000 available of a 13000 USD cap',
        userMessage: 'This purchase would take you past the limit you signed.',
      },
    ],
    checks: [],
    signedRecord: 'eyJhbGciOiJFZERTQSJ9.eyJna2MiOiJnZGMiLCJhdHQiOiJhdHRfMSJ9.sig',
    nowSec: NOW_SEC,
    pendingNetworkEnforcement: [],
  }
}

/** The routes a happy-path `AUTHORIZE` order needs. */
export function authorizeRoutes(
  overrides: {
    order?: StubResponse
    capture?: StubResponse[]
    track?: StubResponse
  } = {},
) {
  return {
    'POST /v1/oauth2/token': {
      status: 200,
      body: {
        access_token: 'A21AAFakeAccessToken0000000000000000',
        token_type: 'Bearer',
        expires_in: 32_400,
      },
    },
    'POST /v2/checkout/orders': overrides.order ?? orderBody({ inlineAuthorization: true }),
    'POST /capture': overrides.capture ?? [
      captureBody({ value: '60.00' }),
      captureBody({ value: '40.00', finalCapture: true }),
    ],
    'POST /track': overrides.track ?? trackBody(),
  }
}

/** `Σ` of a list of bigints. Used by the EC-FX-4 property assertions. */
export function sum(values: readonly bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n)
}

/**
 * The route table a harness starts with: OAuth, and a create that authorizes **inline** (audit §17).
 *
 * Enough for `createOrderFromDecision` on the `AUTHORIZE` path. Tests that need something else call
 * `h.paypal.setRoutes({...defaultRoutes(), …})`.
 */
export function defaultRoutes(): Routes {
  return {
    'POST /v1/oauth2/token': {
      status: 200,
      body: {
        access_token: 'A21AAFakeAccessToken0000000000000000',
        token_type: 'Bearer',
        expires_in: 32_400,
      },
    },
    'POST /v2/checkout/orders': orderBody({ inlineAuthorization: true }),
    'POST /v2/checkout/orders/{id}/authorize': orderBody({ inlineAuthorization: true }),
    // The D17 `CAPTURE` path's follow-up. Stubs the documented shape (`purchase_units[].payments.captures[]`),
    // because that is what `captureOrder` parses.
    'POST /v2/checkout/orders/{id}/capture': orderBody({ inlineCapture: true }),
    'POST /v2/payments/authorizations/{id}/capture': [
      captureBody({ value: '60.00' }),
      captureBody({ value: '40.00', finalCapture: true }),
    ],
    'POST /v2/checkout/orders/{id}/track': trackBody(),
    'POST /v2/payments/authorizations/{id}/void': voidBody(),
    'POST /v2/payments/authorizations/{id}/reauthorize': reauthorizeBody(),
    'POST /v2/payments/captures/{id}/refund': refundBody(),
  }
}

/** `defaultRoutes()` plus overrides, as one call. */
export function routes(overrides: Routes): Routes {
  return { ...defaultRoutes(), ...overrides }
}
