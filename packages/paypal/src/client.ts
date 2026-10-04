/**
 * `PayPalClient` — spec §8.6 M6 (WP-06), decision D6.
 *
 * One thin typed `fetch` client over the PayPal REST API. The class is the only thing in the
 * repository that is allowed to know a PayPal URL, and the only thing that turns a PayPal failure
 * into a `CsError` from the one registry in `@countersign/core`.
 *
 * ## The five behaviours that are not obvious
 *
 *  1. **Token single-flight.** Fifty concurrent calls share **one** HTTP token request (AT-M6.4).
 *     The mechanism is a shared in-flight promise, not a mutex: a queue would serialise the callers
 *     and a lock would have to be released on every throw path. See {@link PayPalClient.getAccessToken}.
 *  2. **One request id for the whole retry loop.** The id is built and validated *before* the loop,
 *     so every attempt carries the same `PayPal-Request-Id` ([B14], EC-IDEM-2). A fresh id per attempt
 *     would turn a retry into a second order, a second capture or a second refund.
 *  3. **Not every endpoint may be retried blindly.** For endpoints whose idempotency support is
 *     unverified the client refuses to auto-retry an *ambiguous* failure (timeout, network error, 5xx)
 *     and returns a `retryable: true` error tagged `ambiguous`, leaving the caller to re-read the
 *     resource first (EC-IDEM-3). See {@link ENDPOINT_POLICIES} and `IDEMPOTENCY.md`.
 *  4. **`paypal-debug-id` is logged on every single response**, including the ones that succeed. It is
 *     the only thing PayPal support can use to find our request, and the spec requires it
 *     unconditionally (§8.6 "Logging").
 *  5. **`PAYPAL_ENV=live` cannot boot this class** (EC-ENV-1, AT-M6.7).
 */
import type { z } from 'zod'

import { assertSandbox, createLogger, csError, err, ok, toCsError } from '@countersign/core'
import type { Clock, CsError, Logger, Result } from '@countersign/core'

import { CircuitBreaker, breakerKey } from './circuit'
import { DEFAULT_BACKOFF, nextDelayMs, parseRetryAfter, realSleep } from './backoff'
import type { BackoffConfig, Sleep } from './backoff'
import { extractDebugId, headerValue, mapPayPalError, networkError } from './errors'
import type { PayPalErrorBody } from './errors'
import { validateRequestId } from './idempotency'
import { buildEvidenceForm } from './multipart'
import type { EvidenceFile } from './multipart'
import { PayPalSandboxApi } from './sandbox'
import {
  acceptClaimReqSchema,
  ackReturnReqSchema,
  authorizationSchema,
  captureRequestSchema,
  captureSchema,
  createOrderReqSchema,
  disputeListSchema,
  disputeSchema,
  linksSchema,
  listDisputesQuerySchema,
  makeOfferReqSchema,
  oauthTokenSchema,
  orderSchema,
  paymentTokenSchema,
  provideEvidenceInputSchema,
  refundRequestSchema,
  refundSchema,
  reauthorizeRequestSchema,
  setupTokenReqSchema,
  setupTokenSchema,
  trackReqSchema,
  verifyWebhookSignatureResSchema,
} from './types'
import type {
  AcceptClaimReq,
  AckReturnReq,
  Authorization,
  Capture,
  CreateOrderReq,
  Dispute,
  DisputeList,
  Links,
  ListDisputesQuery,
  MakeOfferReq,
  OauthToken,
  Order,
  PaymentToken,
  PPMoney,
  ProvideEvidenceInput,
  Refund,
  SetupToken,
  SetupTokenReq,
  TrackReq,
  WebhookHeaders,
  WebhookVerificationStatus,
} from './types'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Per-call options — spec §8.6 `CallOpts`. */
export interface CallOpts {
  /** Sent as `PayPal-Request-Id`. Must be deterministic ([B14]); see `idempotency.ts`. */
  requestId?: string
  /** `Prefer` header: ask for the resource back or just a status. */
  prefer?: 'return=representation' | 'return=minimal'
  /**
   * `PayPal-Auth-Assertion` header. The sandbox buyer-dispute simulator requires an unsigned
   * assertion ([S29] §10.3); `sandbox.ts` builds it.
   */
  authAssertion?: string
  /** Per-request timeout. Spec default: 15 000 ms. */
  timeoutMs?: number
}

/** Extra constructor knobs beyond the spec's `PayPalClientOpts`, all defaulting to the spec values. */
export interface PayPalClientDeps {
  /** Injected sleep. Tests pass a recorder; production uses {@link realSleep}. */
  readonly sleep?: Sleep
  readonly logger?: Logger
  readonly breaker?: CircuitBreaker
  readonly backoff?: BackoffConfig
  /** Overrides `process.env` for the EC-ENV-1 check. */
  readonly env?: { PAYPAL_ENV?: string | undefined; PAYPAL_API_BASE?: string | undefined }
}

export interface PayPalClientOpts extends PayPalClientDeps {
  baseUrl: string
  clientId: string
  clientSecret: string
  clock: Clock
  fetchImpl?: typeof fetch
  /**
   * Total attempts, spec default **4** — one initial call plus three retries. The spec names the
   * option `maxRetries`; read it as "the retry budget", not "retries after the first".
   */
  maxRetries?: number
}

/** Spec default for `CallOpts.timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Cache a token until this many seconds before it expires (spec §8.6 "cache until exp-60s"). */
export const TOKEN_EXPIRY_SKEW_SECONDS = 60

// ---------------------------------------------------------------------------
// Endpoint retry / idempotency policy — the code side of `IDEMPOTENCY.md`
// ---------------------------------------------------------------------------

/**
 * How a failed attempt may be retried.
 *
 * - `same-request-id` — PayPal documents `PayPal-Request-Id` support for this endpoint ([B14]), so a
 *   retry re-sends the identical request and PayPal returns the earlier result. Safe automatically.
 * - `re-read-required` — idempotency support is **unverified** for this endpoint, so an ambiguous
 *   failure is *not* auto-retried. The error comes back `retryable: true` and `ambiguous: true`, and
 *   the caller must `GET` the resource before deciding (EC-IDEM-3). A 429 is still retried: the
 *   request was refused at the edge and never executed.
 * - `never` — do not retry. Not used today; kept so a newly added endpoint can opt out explicitly
 *   rather than by omission.
 */
export type RetryPolicy = 'same-request-id' | 're-read-required' | 'never'

export interface EndpointPolicy {
  readonly retry: RetryPolicy
  /** Whether we send a `PayPal-Request-Id` header at all. */
  readonly sendRequestId: boolean
}

/**
 * Per-endpoint policy, keyed `"<METHOD> <path template>"`.
 *
 * This table and `IDEMPOTENCY.md` are the same fact in two forms: the markdown is what a human reads
 * before a judge asks, this is what the code executes. `client.oauth.test.ts` asserts every path the
 * client can reach appears here.
 *
 * **Provenance.** Orders v2 and Payments v2 idempotency support is cited from [B14]
 * (https://developer.paypal.com/api/rest/reference/idempotency/). Everything else is
 * **UNVERIFIED — needs sandbox probe** (spec U5). PayPal's idempotency reference documents which
 * APIs honour the header; Disputes v1, Vault v3 and the customer-support simulators are not among the
 * ones we have confirmed. Guessing "it probably works" here is a double-charge bug, so the unverified
 * ones get `re-read-required` — while still *sending* the key where the spec mandates one
 * (§8.15 filing guard, §8.16 AT-M16.2).
 */
export const ENDPOINT_POLICIES: Readonly<Record<string, EndpointPolicy>> = {
  // --- auth ---
  'POST /v1/oauth2/token': { retry: 'same-request-id', sendRequestId: false },

  // --- orders v2 [B14] ---
  'POST /v2/checkout/orders': { retry: 'same-request-id', sendRequestId: true },
  'GET /v2/checkout/orders/{id}': { retry: 'same-request-id', sendRequestId: false },
  'POST /v2/checkout/orders/{id}/authorize': { retry: 'same-request-id', sendRequestId: true },
  'POST /v2/checkout/orders/{id}/capture': { retry: 'same-request-id', sendRequestId: true },
  'POST /v2/checkout/orders/{id}/track': { retry: 'same-request-id', sendRequestId: true },

  // --- payments v2 [B14] ---
  'POST /v2/payments/authorizations/{id}/capture': { retry: 'same-request-id', sendRequestId: true },
  'POST /v2/payments/authorizations/{id}/reauthorize': { retry: 'same-request-id', sendRequestId: true },
  'POST /v2/payments/authorizations/{id}/void': { retry: 'same-request-id', sendRequestId: true },
  'GET /v2/payments/authorizations/{id}': { retry: 'same-request-id', sendRequestId: false },
  'GET /v2/payments/captures/{id}': { retry: 'same-request-id', sendRequestId: false },
  'POST /v2/payments/captures/{id}/refund': { retry: 'same-request-id', sendRequestId: true },
  'GET /v2/payments/refunds/{id}': { retry: 'same-request-id', sendRequestId: false },

  // --- vault v3: UNVERIFIED idempotency support (spec U5) ---
  'POST /v3/vault/setup-tokens': { retry: 're-read-required', sendRequestId: false },
  'POST /v3/vault/payment-tokens': { retry: 're-read-required', sendRequestId: false },
  'GET /v3/vault/payment-tokens/{id}': { retry: 'same-request-id', sendRequestId: false },
  // DELETE is idempotent by HTTP semantics: a repeat is a 404, never a second deletion.
  'DELETE /v3/vault/payment-tokens/{id}': { retry: 'same-request-id', sendRequestId: false },

  // --- disputes v1: UNVERIFIED idempotency support (spec U5); key still sent (§8.15, §8.16) ---
  'GET /v1/customer/disputes': { retry: 'same-request-id', sendRequestId: false },
  'GET /v1/customer/disputes/{id}': { retry: 'same-request-id', sendRequestId: false },
  'POST /v1/customer/disputes/{id}/provide-evidence': { retry: 're-read-required', sendRequestId: true },
  'POST /v1/customer/disputes/{id}/accept-claim': { retry: 're-read-required', sendRequestId: true },
  'POST /v1/customer/disputes/{id}/make-offer': { retry: 're-read-required', sendRequestId: true },
  'POST /v1/customer/disputes/{id}/send-message': { retry: 're-read-required', sendRequestId: true },
  'POST /v1/customer/disputes/{id}/appeal': { retry: 're-read-required', sendRequestId: true },
  'POST /v1/customer/disputes/{id}/acknowledge-return-item': { retry: 're-read-required', sendRequestId: true },
  'POST /v1/customer/disputes/{id}/provide-supporting-info': { retry: 're-read-required', sendRequestId: true },
  'POST /v1/customer/disputes/{id}/escalate': { retry: 're-read-required', sendRequestId: true },

  // --- notifications [V14] ---
  // Signature verification has no side effects, so retrying it is harmless. It is also on the
  // webhook hot path where EC-PP-5 (slow verify) says respond 200 and verify afterwards.
  'POST /v1/notifications/verify-webhook-signature': { retry: 'same-request-id', sendRequestId: false },

  // --- sandbox-only simulators [S29]: UNVERIFIED, and unreachable outside a sandbox env ---
  'POST /v1/customer/disputes': { retry: 're-read-required', sendRequestId: false },
  'POST /v2/customer-support/process-chargeback': { retry: 're-read-required', sendRequestId: false },
  'POST /v1/customer/disputes/{id}/require-evidence': { retry: 're-read-required', sendRequestId: false },
  'POST /v1/customer/disputes/{id}/adjudicate': { retry: 're-read-required', sendRequestId: false },
  'POST /v1/customer/disputes/{id}/change-reason': { retry: 're-read-required', sendRequestId: false },
  'POST /v1/customer/disputes/{id}/accept-offer': { retry: 're-read-required', sendRequestId: false },
  'POST /v1/customer/disputes/{id}/deny-offer': { retry: 're-read-required', sendRequestId: false },
} as const

/** Policy for an endpoint. An endpoint missing from the table fails closed. */
export function policyFor(policyKey: string): EndpointPolicy {
  return ENDPOINT_POLICIES[policyKey] ?? { retry: 're-read-required', sendRequestId: false }
}

// ---------------------------------------------------------------------------
// Transport contract (shared with sandbox.ts)
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH'

export interface TransportCall<T> {
  readonly method: HttpMethod
  /** Absolute-path form starting with `/`, placeholders already substituted and encoded. */
  readonly path: string
  /** Key into {@link ENDPOINT_POLICIES}. */
  readonly policyKey: string
  /** Response schema. `null` means "expect an empty body" (204). */
  readonly schema: z.ZodType<T> | null
  readonly opts?: CallOpts
  /** `FormData` body: the runtime then sets the multipart `Content-Type` and boundary. */
  readonly form?: FormData
  /** JSON body. Mutually exclusive with `form`. */
  readonly json?: unknown
  /** Pre-encoded `x-www-form-urlencoded` body (the OAuth call). */
  readonly formBody?: string
  /** Headers merged over the defaults. Used by OAuth for Basic auth. */
  readonly headers?: Readonly<Record<string, string>>
  /** Skip the bearer token: used by the token call itself. */
  readonly anonymous?: boolean
}

/** What `sandbox.ts` is handed. Generic so each call site keeps its own response type. */
export type Transport = <T>(call: TransportCall<T>) => Promise<Result<T, CsError>>

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

interface TokenCache {
  readonly token: string
  readonly expiresAtMs: number
}

interface AttemptOutcome<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: CsError
  /** HTTP status, when a response was actually received. Drives the one-shot 401 refresh. */
  readonly status?: number
  /** True when the failure could have reached PayPal's servers (timeout, network error, 5xx). */
  readonly unreachable: boolean
}

export class PayPalClient {
  /**
   * The sandbox-only simulator surface (§10.2 #18, EC-ENV-2).
   *
   * Constructed eagerly so that a misconfigured deployment fails at boot rather than at the moment a
   * test script calls `sandbox.createBuyerDispute` halfway through a dispute.
   */
  readonly sandbox: PayPalSandboxApi

  private readonly baseUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly clock: Clock
  private readonly fetchImpl: typeof fetch
  private readonly log: Logger
  private readonly sleep: Sleep
  private readonly backoff: BackoffConfig
  private readonly breaker: CircuitBreaker
  private readonly maxAttempts: number
  private readonly envLike: { PAYPAL_ENV: string | undefined; PAYPAL_API_BASE: string | undefined }

  private tokenCache: TokenCache | null = null
  /** The shared in-flight token request. See {@link PayPalClient.getAccessToken}. */
  private tokenInFlight: Promise<string> | null = null

  constructor(opts: PayPalClientOpts) {
    const invalid = validateClientOpts(opts)
    if (invalid) throw invalid

    // EC-ENV-1 / AT-M6.7. `assertSandbox` is the one implementation of the rule (core's env.ts), used
    // twice on purpose:
    //   - when `PAYPAL_ENV` is set it must be exactly "sandbox";
    //   - the base URL must always be a sandbox host even when the variable is absent, because the
    //     host is what decides whose money we are about to touch.
    const paypalEnv = opts.env?.PAYPAL_ENV ?? process.env['PAYPAL_ENV']
    const apiBase = opts.env?.PAYPAL_API_BASE ?? opts.baseUrl ?? process.env['PAYPAL_API_BASE']
    if (paypalEnv !== undefined) assertSandbox({ PAYPAL_ENV: paypalEnv, PAYPAL_API_BASE: apiBase })
    assertSandbox({ PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: opts.baseUrl })
    this.envLike = { PAYPAL_ENV: paypalEnv, PAYPAL_API_BASE: apiBase }

    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.clientId = opts.clientId
    this.clientSecret = opts.clientSecret
    this.clock = opts.clock
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.log = (opts.logger ?? createLogger()).child({ component: 'paypal' })
    this.sleep = opts.sleep ?? realSleep
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF
    this.maxAttempts = Math.max(1, opts.maxRetries ?? DEFAULT_BACKOFF.maxAttempts)
    this.breaker = opts.breaker ?? new CircuitBreaker({ clock: this.clock })

    const transport: Transport = (call) => this.execute(call)
    this.sandbox = new PayPalSandboxApi({ transport, clientId: this.clientId, env: this.envLike })
  }

  /** Hostname the circuit breaker is keyed on. */
  get host(): string {
    return breakerKey(this.baseUrl)
  }

  /** Circuit state for this client's host. Read by the status page and by tests. */
  breakerState(): 'closed' | 'open' | 'half-open' {
    return this.breaker.state(this.host)
  }

  /** Reset the breaker. Tests must call this; production never does (EC-PP-1). */
  resetCircuit(): void {
    this.breaker.reset()
  }

  /** Drop the cached access token. Used by the 401 refresh path and by tests. */
  clearTokenCache(): void {
    this.tokenCache = null
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  /**
   * `POST /v1/oauth2/token` with `grant_type=client_credentials`, cached until `expires_in - 60`.
   *
   * The spec signature is `Promise<string>` (§8.6), so this method **throws** a `CsError` on failure —
   * it is the one place in this package that does. Every `Result`-returning method catches it, so
   * nothing thrown here crosses a module boundary.
   *
   * **Single-flight (AT-M6.4).** On a cache miss the promise is stored in {@link tokenInFlight} and
   * every concurrent caller awaits *that same promise*. Two properties make it safe: `finally` clears
   * the field on every settle path (success, HTTP failure, network throw), and the promise handed out
   * is the settled one, so no caller can observe a half-initialised cache. A mutex would have to be
   * released on every throw path; this has nothing to release.
   */
  async getAccessToken(): Promise<string> {
    const cached = this.tokenCache
    if (cached && this.clock.nowMs() < cached.expiresAtMs) return cached.token

    const existing = this.tokenInFlight
    if (existing) return existing

    const inFlight = this.requestClientCredentialToken('client_credentials').finally(() => {
      if (this.tokenInFlight === inFlight) this.tokenInFlight = null
    })
    this.tokenInFlight = inFlight
    return inFlight
  }

  /**
   * `POST /v1/oauth2/token` with `response_type=client_token` → the token the browser SDK consumes
   * (§10.2 #2, [V9]).
   *
   * Deliberately **not cached**: a client token is short-lived and single-use, and the point of the
   * call is to hand a fresh one to a page load. Caching would put an expired token in the popup, which
   * fails in a browser and not in our tests.
   */
  async getClientToken(): Promise<string> {
    return this.requestClientCredentialToken('client_token')
  }

  private async requestClientCredentialToken(
    responseType: 'client_credentials' | 'client_token',
  ): Promise<string> {
    const body = new URLSearchParams()
    body.set('grant_type', 'client_credentials')
    if (responseType === 'client_token') body.set('response_type', 'client_token')

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64')
    const result = await this.execute<OauthToken>({
      method: 'POST',
      path: '/v1/oauth2/token',
      policyKey: 'POST /v1/oauth2/token',
      schema: oauthTokenSchema,
      anonymous: true,
      formBody: body.toString(),
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })
    if (!result.ok) throw result.error

    const token = result.value.access_token
    if (responseType === 'client_credentials') {
      const skewMs = TOKEN_EXPIRY_SKEW_SECONDS * 1000
      this.tokenCache = {
        token,
        // `expires_in` is seconds, the clock is milliseconds. Expiring 60 s early is the spec's
        // "cache until exp-60s" and is what keeps EC-PP-3 (a token dying mid-flight) rare.
        expiresAtMs: this.clock.nowMs() + Math.max(0, result.value.expires_in * 1000 - skewMs),
      }
    }
    return token
  }

  // -------------------------------------------------------------------------
  // Vault v3 (§10.2 #3, #4, #17)
  // -------------------------------------------------------------------------

  async createSetupToken(body: SetupTokenReq, o?: CallOpts): Promise<Result<SetupToken, CsError>> {
    const parsed = this.parseBody(setupTokenReqSchema, body, 'createSetupToken')
    if (!parsed.ok) return parsed
    return this.execute<SetupToken>({
      method: 'POST',
      path: '/v3/vault/setup-tokens',
      policyKey: 'POST /v3/vault/setup-tokens',
      schema: setupTokenSchema,
      json: parsed.value,
      ...(o ? { opts: o } : {}),
    })
  }

  async createPaymentToken(setupTokenId: string, o?: CallOpts): Promise<Result<PaymentToken, CsError>> {
    if (typeof setupTokenId !== 'string' || setupTokenId.trim() === '') {
      return err(csError('CS_VALIDATION', 'createPaymentToken needs a setupTokenId'))
    }
    return this.execute<PaymentToken>({
      method: 'POST',
      path: '/v3/vault/payment-tokens',
      policyKey: 'POST /v3/vault/payment-tokens',
      schema: paymentTokenSchema,
      // `payment_source.token {id, type:'SETUP_TOKEN'}` — spec §8.7 step 4, [V9].
      json: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
      ...(o ? { opts: o } : {}),
    })
  }

  async getPaymentToken(id: string): Promise<Result<PaymentToken, CsError>> {
    const bad = this.requireId(id, 'getPaymentToken')
    if (bad) return err(bad)
    return this.execute<PaymentToken>({
      method: 'GET',
      path: `/v3/vault/payment-tokens/${encodeURIComponent(id)}`,
      policyKey: 'GET /v3/vault/payment-tokens/{id}',
      schema: paymentTokenSchema,
    })
  }

  /** §10.2 #17: revoke wallet. 204 No Content on success. */
  async deletePaymentToken(id: string): Promise<Result<void, CsError>> {
    const bad = this.requireId(id, 'deletePaymentToken')
    if (bad) return err(bad)
    return this.execute<void>({
      method: 'DELETE',
      path: `/v3/vault/payment-tokens/${encodeURIComponent(id)}`,
      policyKey: 'DELETE /v3/vault/payment-tokens/{id}',
      schema: null,
    })
  }

  // -------------------------------------------------------------------------
  // Orders v2 (§10.2 #5-8)
  // -------------------------------------------------------------------------

  async createOrder(body: CreateOrderReq, o: CallOpts & { requestId: string }): Promise<Result<Order, CsError>> {
    const parsed = this.parseBody(createOrderReqSchema, body, 'createOrder')
    if (!parsed.ok) return parsed
    const bad = this.requireRequestId(o, 'createOrder')
    if (bad) return err(bad)
    return this.execute<Order>({
      method: 'POST',
      path: '/v2/checkout/orders',
      policyKey: 'POST /v2/checkout/orders',
      schema: orderSchema,
      json: parsed.value,
      opts: o,
    })
  }

  async getOrder(id: string): Promise<Result<Order, CsError>> {
    const bad = this.requireId(id, 'getOrder')
    if (bad) return err(bad)
    return this.execute<Order>({
      method: 'GET',
      path: `/v2/checkout/orders/${encodeURIComponent(id)}`,
      policyKey: 'GET /v2/checkout/orders/{id}',
      schema: orderSchema,
    })
  }

  async authorizeOrder(id: string, o: CallOpts & { requestId: string }): Promise<Result<Order, CsError>> {
    const bad = this.requireId(id, 'authorizeOrder')
    if (bad) return err(bad)
    const badId = this.requireRequestId(o, 'authorizeOrder')
    if (badId) return err(badId)
    return this.execute<Order>({
      method: 'POST',
      path: `/v2/checkout/orders/${encodeURIComponent(id)}/authorize`,
      policyKey: 'POST /v2/checkout/orders/{id}/authorize',
      schema: orderSchema,
      json: {},
      opts: o,
    })
  }

  async captureOrder(id: string, o: CallOpts & { requestId: string }): Promise<Result<Order, CsError>> {
    const bad = this.requireId(id, 'captureOrder')
    if (bad) return err(bad)
    const badId = this.requireRequestId(o, 'captureOrder')
    if (badId) return err(badId)
    return this.execute<Order>({
      method: 'POST',
      path: `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
      policyKey: 'POST /v2/checkout/orders/{id}/capture',
      schema: orderSchema,
      json: {},
      opts: o,
    })
  }

  /** §10.2 #8. `capture_id` links the tracking to the capture it proves (EC-SPLIT-2). */
  async addTracking(
    orderId: string,
    body: TrackReq,
    o: CallOpts & { requestId: string },
  ): Promise<Result<Order, CsError>> {
    const bad = this.requireId(orderId, 'addTracking')
    if (bad) return err(bad)
    const parsed = this.parseBody(trackReqSchema, body, 'addTracking')
    if (!parsed.ok) return parsed
    const badId = this.requireRequestId(o, 'addTracking')
    if (badId) return err(badId)
    return this.execute<Order>({
      method: 'POST',
      path: `/v2/checkout/orders/${encodeURIComponent(orderId)}/track`,
      policyKey: 'POST /v2/checkout/orders/{id}/track',
      schema: orderSchema,
      json: parsed.value,
      opts: o,
    })
  }

  // -------------------------------------------------------------------------
  // Payments v2 (§10.2 #7, #9-11)
  // -------------------------------------------------------------------------

  async captureAuthorization(
    authId: string,
    body: { amount?: PPMoney; final_capture: boolean; invoice_id?: string },
    o: CallOpts & { requestId: string },
  ): Promise<Result<Capture, CsError>> {
    const bad = this.requireId(authId, 'captureAuthorization')
    if (bad) return err(bad)
    const parsed = this.parseBody(captureRequestSchema, body, 'captureAuthorization')
    if (!parsed.ok) return parsed
    const badId = this.requireRequestId(o, 'captureAuthorization')
    if (badId) return err(badId)
    return this.execute<Capture>({
      method: 'POST',
      path: `/v2/payments/authorizations/${encodeURIComponent(authId)}/capture`,
      policyKey: 'POST /v2/payments/authorizations/{id}/capture',
      schema: captureSchema,
      json: parsed.value,
      opts: o,
    })
  }

  async reauthorize(
    authId: string,
    body: { amount?: PPMoney },
    o: CallOpts & { requestId: string },
  ): Promise<Result<Authorization, CsError>> {
    const bad = this.requireId(authId, 'reauthorize')
    if (bad) return err(bad)
    const parsed = this.parseBody(reauthorizeRequestSchema, body, 'reauthorize')
    if (!parsed.ok) return parsed
    const badId = this.requireRequestId(o, 'reauthorize')
    if (badId) return err(badId)
    return this.execute<Authorization>({
      method: 'POST',
      path: `/v2/payments/authorizations/${encodeURIComponent(authId)}/reauthorize`,
      policyKey: 'POST /v2/payments/authorizations/{id}/reauthorize',
      schema: authorizationSchema,
      json: parsed.value,
      opts: o,
    })
  }

  /** §10.2 #9: release the remainder of an authorization (EC-STOCK-1). 204 No Content. */
  async voidAuthorization(authId: string, o: CallOpts & { requestId: string }): Promise<Result<void, CsError>> {
    const bad = this.requireId(authId, 'voidAuthorization')
    if (bad) return err(bad)
    const badId = this.requireRequestId(o, 'voidAuthorization')
    if (badId) return err(badId)
    return this.execute<void>({
      method: 'POST',
      path: `/v2/payments/authorizations/${encodeURIComponent(authId)}/void`,
      policyKey: 'POST /v2/payments/authorizations/{id}/void',
      schema: null,
      opts: o,
    })
  }

  async getAuthorization(id: string): Promise<Result<Authorization, CsError>> {
    const bad = this.requireId(id, 'getAuthorization')
    if (bad) return err(bad)
    return this.execute<Authorization>({
      method: 'GET',
      path: `/v2/payments/authorizations/${encodeURIComponent(id)}`,
      policyKey: 'GET /v2/payments/authorizations/{id}',
      schema: authorizationSchema,
    })
  }

  async getCapture(id: string): Promise<Result<Capture, CsError>> {
    const bad = this.requireId(id, 'getCapture')
    if (bad) return err(bad)
    return this.execute<Capture>({
      method: 'GET',
      path: `/v2/payments/captures/${encodeURIComponent(id)}`,
      policyKey: 'GET /v2/payments/captures/{id}',
      schema: captureSchema,
    })
  }

  async refundCapture(
    captureId: string,
    body: { amount?: PPMoney; invoice_id?: string; note_to_payer?: string; custom_id?: string },
    o: CallOpts & { requestId: string },
  ): Promise<Result<Refund, CsError>> {
    const bad = this.requireId(captureId, 'refundCapture')
    if (bad) return err(bad)
    const parsed = this.parseBody(refundRequestSchema, body, 'refundCapture')
    if (!parsed.ok) return parsed
    const badId = this.requireRequestId(o, 'refundCapture')
    if (badId) return err(badId)
    return this.execute<Refund>({
      method: 'POST',
      path: `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      policyKey: 'POST /v2/payments/captures/{id}/refund',
      schema: refundSchema,
      json: parsed.value,
      opts: o,
    })
  }

  async getRefund(id: string): Promise<Result<Refund, CsError>> {
    const bad = this.requireId(id, 'getRefund')
    if (bad) return err(bad)
    return this.execute<Refund>({
      method: 'GET',
      path: `/v2/payments/refunds/${encodeURIComponent(id)}`,
      policyKey: 'GET /v2/payments/refunds/{id}',
      schema: refundSchema,
    })
  }

  // -------------------------------------------------------------------------
  // Disputes v1 (§10.2 #13-17)
  // -------------------------------------------------------------------------

  async listDisputes(q: ListDisputesQuery): Promise<Result<DisputeList, CsError>> {
    const parsed = this.parseBody(listDisputesQuerySchema, q ?? {}, 'listDisputes')
    if (!parsed.ok) return parsed
    const query = toQueryString(parsed.value as Record<string, unknown>)
    const result = await this.execute<DisputeList>({
      method: 'GET',
      path: `/v1/customer/disputes${query}`,
      policyKey: 'GET /v1/customer/disputes',
      schema: disputeListSchema,
    })
    if (!result.ok) return result
    // `items` is what every caller iterates; default it rather than making them write `?? []`.
    return ok({ ...result.value, items: result.value.items ?? [] })
  }

  async getDispute(id: string): Promise<Result<Dispute, CsError>> {
    const bad = this.requireId(id, 'getDispute')
    if (bad) return err(bad)
    return this.execute<Dispute>({
      method: 'GET',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}`,
      policyKey: 'GET /v1/customer/disputes/{id}',
      schema: disputeSchema,
    })
  }

  /** §10.2 #14. `multipart/form-data`: a JSON `input` part plus evidence files (EC-DSP-12). */
  async provideEvidence(
    id: string,
    input: ProvideEvidenceInput,
    files: EvidenceFile[],
    o: CallOpts = {},
  ): Promise<Result<Links, CsError>> {
    const bad = this.requireId(id, 'provideEvidence')
    if (bad) return err(bad)
    const parsed = this.parseBody(provideEvidenceInputSchema, input, 'provideEvidence')
    if (!parsed.ok) return parsed
    const form = await buildEvidenceForm(parsed.value, files)
    if (!form.ok) return form
    return this.execute<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`,
      policyKey: 'POST /v1/customer/disputes/{id}/provide-evidence',
      schema: linksSchema,
      form: form.value,
      opts: o,
    })
  }

  async acceptClaim(id: string, body: AcceptClaimReq, o: CallOpts = {}): Promise<Result<Links, CsError>> {
    const bad = this.requireId(id, 'acceptClaim')
    if (bad) return err(bad)
    const parsed = this.parseBody(acceptClaimReqSchema, body, 'acceptClaim')
    if (!parsed.ok) return parsed
    return this.execute<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`,
      policyKey: 'POST /v1/customer/disputes/{id}/accept-claim',
      schema: linksSchema,
      json: parsed.value,
      opts: o,
    })
  }

  async makeOffer(id: string, body: MakeOfferReq, o: CallOpts = {}): Promise<Result<Links, CsError>> {
    const bad = this.requireId(id, 'makeOffer')
    if (bad) return err(bad)
    const parsed = this.parseBody(makeOfferReqSchema, body, 'makeOffer')
    if (!parsed.ok) return parsed
    return this.execute<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/make-offer`,
      policyKey: 'POST /v1/customer/disputes/{id}/make-offer',
      schema: linksSchema,
      json: parsed.value,
      opts: o,
    })
  }

  async sendMessage(id: string, message: string, o: CallOpts = {}): Promise<Result<Links, CsError>> {
    const bad = this.requireId(id, 'sendMessage')
    if (bad) return err(bad)
    if (typeof message !== 'string' || message.trim() === '') {
      return err(csError('CS_VALIDATION', 'sendMessage needs a non-empty message'))
    }
    return this.execute<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/send-message`,
      policyKey: 'POST /v1/customer/disputes/{id}/send-message',
      schema: linksSchema,
      json: { message },
      opts: o,
    })
  }

  /** §10.2 #16. Same multipart encoding as `provideEvidence`; only the path differs. */
  async appeal(
    id: string,
    input: ProvideEvidenceInput,
    files: EvidenceFile[],
    o: CallOpts = {},
  ): Promise<Result<Links, CsError>> {
    const bad = this.requireId(id, 'appeal')
    if (bad) return err(bad)
    const parsed = this.parseBody(provideEvidenceInputSchema, input, 'appeal')
    if (!parsed.ok) return parsed
    const form = await buildEvidenceForm(parsed.value, files)
    if (!form.ok) return form
    return this.execute<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/appeal`,
      policyKey: 'POST /v1/customer/disputes/{id}/appeal',
      schema: linksSchema,
      form: form.value,
      opts: o,
    })
  }

  async acknowledgeReturnItem(id: string, body: AckReturnReq, o: CallOpts = {}): Promise<Result<Links, CsError>> {
    const bad = this.requireId(id, 'acknowledgeReturnItem')
    if (bad) return err(bad)
    const parsed = this.parseBody(ackReturnReqSchema, body, 'acknowledgeReturnItem')
    if (!parsed.ok) return parsed
    return this.execute<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/acknowledge-return-item`,
      policyKey: 'POST /v1/customer/disputes/{id}/acknowledge-return-item',
      schema: linksSchema,
      json: parsed.value,
      opts: o,
    })
  }

  /**
   * §10.2 #16. Multipart: a JSON `input` part carrying the notes, plus supporting files.
   *
   * TODO(verify against docs): whether `input` here is `{notes}` or `{message}`. See README.
   */
  async provideSupportingInfo(
    id: string,
    notes: string,
    files: EvidenceFile[],
    o: CallOpts = {},
  ): Promise<Result<Links, CsError>> {
    const bad = this.requireId(id, 'provideSupportingInfo')
    if (bad) return err(bad)
    if (typeof notes !== 'string' || notes.trim() === '') {
      return err(csError('CS_VALIDATION', 'provideSupportingInfo needs non-empty notes'))
    }
    const form = await buildEvidenceForm({ notes }, files)
    if (!form.ok) return form
    return this.execute<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/provide-supporting-info`,
      policyKey: 'POST /v1/customer/disputes/{id}/provide-supporting-info',
      schema: linksSchema,
      form: form.value,
      opts: o,
    })
  }

  /**
   * §10.2 #16. Escalate to arbitration.
   *
   * TODO(verify against docs): whether the body is `{note}` or a bare `note` form field, and whether
   * this endpoint takes JSON at all. See README.
   */
  async escalate(id: string, note: string, o: CallOpts = {}): Promise<Result<Links, CsError>> {
    const bad = this.requireId(id, 'escalate')
    if (bad) return err(bad)
    if (typeof note !== 'string' || note.trim() === '') {
      return err(csError('CS_VALIDATION', 'escalate needs a non-empty note'))
    }
    return this.execute<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/escalate`,
      policyKey: 'POST /v1/customer/disputes/{id}/escalate',
      schema: linksSchema,
      json: { note },
      opts: o,
    })
  }

  // -------------------------------------------------------------------------
  // Webhooks (§10.2 #12, [V14])
  // -------------------------------------------------------------------------

  /**
   * `POST /v1/notifications/verify-webhook-signature` [V14].
   *
   * Fails **closed**: anything other than the exact string `SUCCESS` returns `'FAILURE'`, including a
   * verification status we have never heard of. A check that returns a permissive default for an
   * unknown value is not a check (spec §8.12 EC-WH-4).
   */
  async verifyWebhookSignature(
    h: WebhookHeaders,
    webhookId: string,
    rawEvent: unknown,
  ): Promise<Result<WebhookVerificationStatus, CsError>> {
    if (typeof webhookId !== 'string' || webhookId.trim() === '') {
      return err(csError('CS_VALIDATION', 'verifyWebhookSignature needs the webhook id'))
    }
    const event = coerceWebhookEvent(rawEvent)
    if (!event.ok) return event

    const result = await this.execute<{ verification_status?: string }>({
      method: 'POST',
      path: '/v1/notifications/verify-webhook-signature',
      policyKey: 'POST /v1/notifications/verify-webhook-signature',
      schema: verifyWebhookSignatureResSchema,
      json: {
        auth_algo: h['paypal-auth-algo'],
        cert_url: h['paypal-cert-url'],
        transmission_id: h['paypal-transmission-id'],
        transmission_sig: h['paypal-transmission-sig'],
        transmission_time: h['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: event.value,
      },
    })
    if (!result.ok) return result

    const status = result.value.verification_status
    if (status === 'SUCCESS') return ok('SUCCESS')
    this.log.warn('webhook signature verification failed', { verification_status: status })
    return ok('FAILURE')
  }

  // -------------------------------------------------------------------------
  // The request pipeline
  // -------------------------------------------------------------------------

  /** One attempt, with no retry logic. Every call in this package goes through here. */
  private async rawCall<T>(call: TransportCall<T>, attempt: number): Promise<Result<T, CsError>> {
    const timeoutMs = call.opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const headers: Record<string, string> = {
      accept: 'application/json',
      'accept-language': 'en_US',
      ...call.headers,
    }
    if (!call.anonymous) {
      let token: string
      try {
        token = await this.getAccessToken()
      } catch (e) {
        return err(toCsError(e))
      }
      headers['authorization'] = `Bearer ${token}`
    }
    if (call.opts?.requestId) headers['paypal-request-id'] = call.opts.requestId
    if (call.opts?.prefer) headers['prefer'] = call.opts.prefer
    if (call.opts?.authAssertion) headers['paypal-auth-assertion'] = call.opts.authAssertion

    let body: string | FormData | undefined
    if (call.form !== undefined) {
      body = call.form
      // NOTE: no `content-type` header here, and never one with a hand-written boundary. The runtime
      // derives the boundary from the FormData we just built.
    } else if (call.formBody !== undefined) {
      body = call.formBody
    } else if (call.json !== undefined) {
      body = JSON.stringify(call.json)
      if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
    }

    const url = `${this.baseUrl}${call.path}`
    const init: RequestInit = {
      method: call.method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body }),
    }

    this.log.debug('paypal request', {
      method: call.method,
      path: call.path,
      policy_key: call.policyKey,
      attempt,
      request_id: call.opts?.requestId,
    })

    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      return err(
        networkError({
          method: call.method,
          path: call.path,
          cause: e,
          ...(call.opts?.requestId !== undefined ? { requestId: call.opts.requestId } : {}),
          timedOut,
        }),
      )
    }

    const debugId = extractDebugId(response.headers)
    const text = await safeText(response)
    const contentType = headerValue(response.headers, 'content-type') ?? ''
    const body_ = contentType.includes('json') ? (parseJson(text) as PayPalErrorBody | undefined) : undefined
    const retryAfterHeader = headerValue(response.headers, 'retry-after')

    // §8.6 "Always log paypal-debug-id": on success as much as on failure.
    const logFields: Record<string, unknown> = {
      method: call.method,
      path: call.path,
      status: response.status,
      paypal_debug_id: debugId ?? null,
      request_id: call.opts?.requestId ?? null,
      attempt,
    }
    if (response.ok) this.log.debug('paypal response', logFields)
    else if (response.status >= 500) this.log.error('paypal response error', logFields)
    else this.log.warn('paypal response rejected', logFields)

    if (!response.ok) {
      return err(
        mapPayPalError({
          status: response.status,
          body: body_,
          headers: response.headers,
          method: call.method,
          path: call.path,
          ...(call.opts?.requestId !== undefined ? { requestId: call.opts.requestId } : {}),
          ...(retryAfterHeader !== undefined ? { retryAfterHeader } : {}),
          ...(debugId !== undefined ? { debugId } : {}),
        }),
      )
    }

    if (call.schema === null) return ok(undefined as T)

    const value = parseJson(text)
    const checked = call.schema.safeParse(value)
    if (!checked.success) {
      // A 2xx whose body we do not recognise. Not a PayPal failure and not the caller's input: an
      // unexpected response is `CS_INTERNAL` with the issue list, never a validation error the caller
      // would try to "fix" by changing something that was already right.
      return err(
        csError(
          'CS_INTERNAL',
          `${call.method} ${call.path} returned ${response.status} with a body this client does not recognise`,
          {
            status: response.status,
            paypal_debug_id: debugId,
            issues: checked.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
            body_keys: typeof value === 'object' && value !== null ? Object.keys(value) : undefined,
          },
        ),
      )
    }
    return ok(checked.data)
  }

  /**
   * The whole pipeline for one call: circuit breaker, request-id validation, retry budget, and at most
   * one token refresh (EC-PP-3).
   */
  private async execute<T>(call: TransportCall<T>): Promise<Result<T, CsError>> {
    const host = this.host
    const gate = this.breaker.preflight(host)
    if (!gate.ok) return err(gate.error)

    const policy = policyFor(call.policyKey)
    // The id is validated once, before the loop: every attempt below reuses this exact string.
    let requestId = call.opts?.requestId
    if (requestId !== undefined) {
      const valid = validateRequestId(requestId)
      if (!valid.ok) {
        this.breaker.recordReachable(host)
        return err(valid.error)
      }
      requestId = valid.value
    }
    if (requestId !== undefined && !policy.sendRequestId) {
      this.log.warn('requestId ignored: this endpoint does not get a PayPal-Request-Id header', {
        policy_key: call.policyKey,
      })
      requestId = undefined
    }

    let refreshed = false
    // Fold the request-id decision into `opts` once, here. Doing it before the loop is what
    // guarantees the header is identical on every attempt, and it means a "dropped" id cannot leak
    // back in through the original `call.opts` on a later attempt.
    const effective: TransportCall<T> = {
      ...call,
      ...(call.opts === undefined ? {} : { opts: { ...call.opts, requestId } }),
    }
    for (;;) {
      const outcome = await this.attemptBudgetLoop<T>(effective, policy)

      if (outcome.status === 401 && !refreshed && !call.anonymous) {
        refreshed = true
        this.log.info('paypal 401: refreshing the access token once', { path: call.path })
        // The host answered, so it is reachable; the circuit must not record this as an outage.
        this.breaker.recordReachable(host)
        this.clearTokenCache()
        continue
      }

      if (outcome.unreachable) this.breaker.recordUnavailable(host)
      else this.breaker.recordReachable(host)

      if (outcome.ok) return ok(outcome.value as T)
      return err(outcome.error ?? csError('CS_INTERNAL', 'PayPal call failed without an error'))
    }
  }

  /**
   * Spend the retry budget on one generation of the access token.
   *
   * `unreachable: true` only when the last failure could have reached PayPal's servers (timeout,
   * network error, 5xx). A 429 is **not** unreachable — PayPal is up and asking us to slow down, so it
   * must not count toward the outage that opens the circuit breaker.
   */
  private async attemptBudgetLoop<T>(call: TransportCall<T>, policy: EndpointPolicy): Promise<AttemptOutcome<T>> {
    let lastError: CsError = csError('CS_INTERNAL', 'no attempt was made')
    let unreachable = false

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const result = await this.rawCall<T>(call, attempt)

      if (result.ok) return { ok: true, value: result.value, unreachable: false }

      lastError = result.error
      unreachable = lastError.code === 'PP_UNAVAILABLE'
      const status = numericDetail(lastError, 'status')

      if (!lastError.retryable || attempt >= this.maxAttempts || policy.retry === 'never') {
        return { ok: false, error: lastError, unreachable, ...(status !== undefined ? { status } : {}) }
      }

      // EC-IDEM-3. An ambiguous failure on an endpoint whose idempotency support is unverified must
      // not be retried blindly: the caller re-reads the resource (GET order/capture/dispute) and
      // decides. A 429 is exempt — the request was refused, not executed.
      const ambiguous = lastError.details?.['ambiguous'] === true
      if (policy.retry === 're-read-required' && ambiguous && lastError.code !== 'PP_RATE_LIMITED') {
        this.log.warn('not auto-retrying an ambiguous failure on a non-idempotent endpoint', {
          path: call.path,
          policy_key: call.policyKey,
          code: lastError.code,
        })
        return { ok: false, error: lastError, unreachable, ...(status !== undefined ? { status } : {}) }
      }

      // `Retry-After` is honoured as a floor: with `Retry-After: 2` we wait at least 2 000 ms even if
      // the jitter drew 3 ms (AT-M6.3).
      const retryAfterMs = parseRetryAfter(
        typeof lastError.details?.['retry_after'] === 'string' ? lastError.details['retry_after'] : undefined,
        this.clock.nowMs(),
      )
      const delay = nextDelayMs({ attempt, retryAfterMs, cfg: this.backoff })
      this.log.warn('retrying paypal call', {
        path: call.path,
        attempt,
        next_attempt_in_ms: delay,
        code: lastError.code,
        retry_after_ms: retryAfterMs ?? null,
      })
      await this.sleep(delay)
    }

    return { ok: false, error: lastError, unreachable }
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  /** A resource id for a URL path. An empty id would produce `//` and a confusing 404. */
  private requireId(value: string, method: string): CsError | null {
    if (typeof value !== 'string' || value.trim() === '') {
      return csError('CS_VALIDATION', `${method} needs a resource id`, { method })
    }
    return null
  }

  /**
   * The deterministic `requestId` a side-effecting call must carry.
   *
   * Required by the spec's signature (`o: CallOpts & { requestId: string }`) and load-bearing per
   * [B14]. Refusing locally is the difference between a retryable job and an invisible double refund,
   * so this returns an error instead of calling PayPal without one.
   */
  private requireRequestId(o: CallOpts & { requestId?: string }, method: string): CsError | null {
    const requestId = o?.requestId
    if (requestId === undefined || requestId === '') {
      return csError(
        'CS_VALIDATION',
        `${method} requires a deterministic requestId ([B14]); build one with idempotency.ts`,
        { method },
      )
    }
    const valid = validateRequestId(requestId)
    return valid.ok ? null : valid.error
  }

  /** Validate a request body before it becomes a network call. */
  private parseBody<S extends z.ZodType>(schema: S, value: unknown, method: string): Result<z.output<S>, CsError> {
    const parsed = schema.safeParse(value)
    if (parsed.success) return ok(parsed.data)
    return err(
      csError('CS_VALIDATION', `${method} received a body that does not match the PayPal schema`, {
        method,
        issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function validateClientOpts(opts: PayPalClientOpts): CsError | null {
  const missing: string[] = []
  if (typeof opts?.baseUrl !== 'string' || opts.baseUrl.trim() === '') missing.push('baseUrl')
  if (typeof opts?.clientId !== 'string' || opts.clientId.trim() === '') missing.push('clientId')
  if (typeof opts?.clientSecret !== 'string' || opts.clientSecret.trim() === '') missing.push('clientSecret')
  if (!opts?.clock || typeof opts.clock.nowMs !== 'function') missing.push('clock')
  if (missing.length > 0) {
    return csError('CS_VALIDATION', `PayPalClient is missing required options: ${missing.join(', ')}`, {
      missing,
    })
  }
  try {
    new URL(opts.baseUrl)
  } catch {
    return csError('CS_VALIDATION', `baseUrl is not a valid URL: ${JSON.stringify(opts.baseUrl)}`)
  }
  return null
}

/** `?a=1&b=2`, skipping undefined. Keys are sorted so a request URL is reproducible in a test. */
export function toQueryString(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (entries.length === 0) return ''
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const search = new URLSearchParams()
  for (const [k, v] of entries) search.set(k, String(v))
  return `?${search.toString()}`
}

function numericDetail(e: CsError, key: string): number | undefined {
  const v = e.details?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * Parse a body as JSON, or `undefined`.
 *
 * A non-JSON body is not an error here: PayPal's edge returns HTML on some failures, and the mapped
 * `CsError` should say "HTTP 502 with an HTML body", not crash the worker.
 */
function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * The webhook event PayPal must re-hash, as an object.
 *
 * Accepts the raw request body as a string because `POST /api/webhooks/paypal` reads the raw body for
 * signature verification (spec §8.12) and has both to hand.
 */
function coerceWebhookEvent(raw: unknown): Result<unknown, CsError> {
  if (typeof raw === 'string') {
    try {
      return ok(JSON.parse(raw) as unknown)
    } catch (e) {
      return err(
        csError('CS_VALIDATION', 'The webhook body is not valid JSON, so it cannot be verified', undefined, {
          cause: e,
        }),
      )
    }
  }
  if (typeof raw === 'object' && raw !== null) return ok(raw)
  return err(csError('CS_VALIDATION', 'verifyWebhookSignature needs the webhook event object'))
}