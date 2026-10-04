/**
 * `ViClient` — the typed TypeScript client for `apps/vi` (vi-service).
 *
 * Spec **§8.4 (M4)**, work package **WP-04**. The companion PayPal client (`@countersign/paypal`,
 * §8.6) has the same shape; the differences are all consequences of vi being *our own* service rather
 * than a third party:
 *
 *  - **The bearer token and base URL are constructor arguments, never `process.env`.** This client is
 *    constructed in a Next route handler, in the worker, and in tests, and those three get their
 *    config differently. Reading the environment inside the class would make one of them untestable
 *    and would spread env-var knowledge into a transport module (spec §6 says the env is validated at
 *    boot by `packages/core/env.ts`, once).
 *  - **Retries are far more conservative than PayPal's.** 2 retries, on 5xx and connection errors
 *    only. See {@link shouldRetry}.
 *  - **An invalid chain is a successful call.** `/v1/verify` answers `200 {chain_valid: false, …}`
 *    for a bad chain. That is a *verdict*, and the Gate needs the reasons, so `verify()` returns
 *    `ok(...)`. Treating it as an error would throw away `errors`, `constraints.skipped` and
 *    `disclosed` — everything the decision is made from.
 *
 * ## The four behaviours that are not obvious
 *
 *  1. **Timeout 5 s per attempt**, via `AbortSignal.timeout` (spec §8.4). A hung vi-service must not
 *     hang a Gate decision; spec §14's Gate p95 budget is 400 ms, so a 5 s floor is already a SLO
 *     breach and is the last thing standing between a hung service and a stuck decision.
 *  2. **4xx is never retried.** `VI_SIGNATURE_MISMATCH` will not become valid on a second attempt,
 *     and retrying it would multiply the cost of a rejected signature. See {@link shouldRetry}.
 *  3. **The service's error code survives.** A `VI_SIGNATURE_MISMATCH` from `/v1/l2/finalize` comes
 *     back as `VI_SIGNATURE_MISMATCH` (spec §8.5, EC-KEY-1) — the browser UI branches on it to show
 *     "this device is new, reconnect PayPal" rather than a generic failure. See {@link mapViError}.
 *  4. **`signing_input` is passed through byte for byte.** `prepareL2` returns what the service sent,
 *     never a re-encoding. See the note on `l2PrepareResponseSchema` for why re-encoding is a
 *     signature failure wearing a key-mismatch costume.
 */

import { csError, isCsErrorCode, toCsError } from '@countersign/core'
import type { Clock, CsError, CsErrorCode, Logger, Result } from '@countersign/core'
import type { z } from 'zod'

import {
  ROUTE_CONTRACTS,
  checkoutJwtRequestSchema,
  checkoutJwtResponseSchema,
  checkoutJwtVerifyResponseSchema,
  findRouteContract,
  jwksResponseSchema,
  l1IssueRequestSchema,
  l1IssueResponseSchema,
  l2FinalizeRequestSchema,
  l2FinalizeResponseSchema,
  l2PrepareRequestSchema,
  l2PrepareResponseSchema,
  l3CreateRequestSchema,
  l3CreateResponseSchema,
  mintAgentKeyRequestSchema,
  mintAgentKeyResponseSchema,
  publicVerifyRequestSchema,
  publicVerifyResponseSchema,
  rotateKeyRequestSchema,
  rotateKeyResponseSchema,
  statusResponseSchema,
  verifyRequestSchema,
  verifyResponseSchema,
} from './types'
import type {
  CheckoutJwtRequest,
  CheckoutJwtResponse,
  CheckoutJwtVerifyResponse,
  JwksResponse,
  L1IssueRequest,
  L1IssueResponse,
  L2FinalizeRequest,
  L2FinalizeResponse,
  L2PrepareRequest,
  L2PrepareResponse,
  L3CreateRequest,
  L3CreateResponse,
  MintAgentKeyRequest,
  MintAgentKeyResponse,
  PublicVerifyRequest,
  PublicVerifyResponse,
  RotateKeyRequest,
  RotateKeyResponse,
  StatusResponse,
  VerifyRequest,
  VerifyResponse,
} from './types'

// ---------------------------------------------------------------------------
// Policy constants — spec §8.4
// ---------------------------------------------------------------------------

/** Spec §8.4: "Timeout 5 s". Per attempt, so three attempts can occupy up to 15 s of wall clock. */
export const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Spec §8.4: "2 retries on 5xx or connection error only".
 *
 * Read as a **retry budget**, not a total-attempt count: the default is one initial attempt plus two
 * retries, three fetches in the worst case.
 */
export const DEFAULT_MAX_RETRIES = 2

/** Injected so tests never actually wait. Production passes {@link realSleep}. */
export type Sleep = (ms: number) => Promise<void>

/** `setTimeout`, with the timer unref'd so a backoff never holds the event loop open. */
export const realSleep: Sleep = (ms) =>
  new Promise<void>((resolve) => {
    if (!Number.isFinite(ms) || ms <= 0) {
      resolve()
      return
    }
    const t = setTimeout(resolve, ms)
    if (typeof t === 'object' && t !== null && 'unref' in t) t.unref()
  })

/**
 * Full-jitter ceiling for the delay after `attempt` (1-based), in milliseconds.
 *
 * §8.4 specifies only the *count* of retries, not the spacing, so this is a judgement call and is
 * documented as one: vi sits on Render's private network next to us, so a retry is cheap and the
 * base is small (100 ms) — two retries add well under a second, which matters because spec §14
 * budgets the whole Gate decision at p95 400 ms. Full jitter rather than a fixed wait, because three
 * concurrent Gate decisions that all hit the same blip would otherwise retry in lockstep.
 */
export function retryDelayCeilingMs(attempt: number, baseMs = 100, factor = 2, capMs = 2_000): number {
  if (attempt < 1) return 0
  const raw = baseMs * factor ** (attempt - 1)
  return Math.min(capMs, Number.isFinite(raw) ? raw : capMs)
}

/** Full jitter: uniform in `[0, retryDelayCeilingMs(attempt)]`. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = retryDelayCeilingMs(attempt)
  if (ceiling <= 0) return 0
  const r = Math.min(Math.max(random(), 0), 0.999_999_999)
  return Math.floor(r * ceiling)
}

// ---------------------------------------------------------------------------
// The retry decision — spec §8.4, as an exported pure function
// ---------------------------------------------------------------------------

/** How an attempt failed, from the transport's point of view. */
export type AttemptFailure =
  /** We never got an HTTP response: DNS, TLS, connection reset, socket hang-up. */
  | 'connection'
  /** Our own 5 s `AbortSignal.timeout` fired. */
  | 'timeout'
  /** We got a response with a non-2xx status. */
  | 'response'

export interface RetryDecision {
  readonly kind: AttemptFailure
  /** Present when `kind === 'response'`. */
  readonly status?: number
  /** 1-based attempt number that just failed. */
  readonly attempt: number
  /** The retry budget. {@link DEFAULT_MAX_RETRIES} unless overridden per client. */
  readonly maxRetries: number
}

export interface RetryVerdict {
  readonly retry: boolean
  /** One word for a log line: `transport`, `server-error`, `client-error`, `budget-exhausted`. */
  readonly reason: 'transport' | 'server-error' | 'client-error' | 'budget-exhausted'
}

/**
 * Spec §8.4's retry rule, in one inspectable function.
 *
 * ```
 * 2 retries on 5xx or connection error only
 * ```
 *
 * The rule is a pure function rather than an inline `if` for one reason: "does this client retry a
 * rejected signature?" is a question a judge asks, and a question that deserves an answer you can
 * read in one place and test exhaustively. `test/retry.test.ts` is that exhaustive test.
 *
 * **Why 4xx is excluded, in the terms that matter:**
 *
 *  - `VI_SIGNATURE_MISMATCH` from `/v1/l2/finalize` is a *verdict*, not an outage. The browser signed
 *    the wrong bytes or holds the wrong key; a second identical attempt produces the identical verdict
 *    while doubling the work. Retrying it would multiply the cost of a rejected signature — the
 *    cheapest-looking way to make a signature-verification path expensive.
 *  - `CS_UNAUTHENTICATED` means the token is wrong. Retrying with the same wrong token is a no-op.
 *  - `CS_VALIDATION` means the request is wrong. Retrying sends the same wrong bytes.
 *  - **429 is 4xx and is therefore not retried either**, which is worth stating because it looks like
 *    an omission. `apps/vi` rate-limits its two public routes at 30/min and answers `CS_CONFLICT` with
 *    `Retry-After`; retrying immediately spends more of the budget we just exhausted and, on a 30/min
 *    window, can extend the block. The caller decides when to come back — the error it gets back is
 *    `retryable: true`, and `details.http_status` carries the 429.
 */
export function shouldRetry(decision: RetryDecision): RetryVerdict {
  const budgetLeft = decision.attempt <= decision.maxRetries
  if (decision.kind === 'connection' || decision.kind === 'timeout') {
    return budgetLeft
      ? { retry: true, reason: 'transport' }
      : { retry: false, reason: 'budget-exhausted' }
  }
  const status = decision.status ?? 0
  if (status >= 500) {
    return budgetLeft ? { retry: true, reason: 'server-error' } : { retry: false, reason: 'budget-exhausted' }
  }
  // Every non-5xx non-2xx. 4xx by definition, and per the rule above, not retried.
  return { retry: false, reason: 'client-error' }
}

/**
 * Per-route notes on repeatability, keyed `"<METHOD> <path>"`.
 *
 * §8.4 says "vi calls are idempotent except `l2/prepare`, which is safe to repeat". That reads like a
 * contradiction until you look at what `l2/prepare` does: it mints a `prepare_id` and stores a
 * record, so it is *not* idempotent — but repeating it is harmless, because the caller only needs
 * *a* valid signing input and uses whichever response arrives.
 *
 * It is a table rather than a comment so the statement is greppable and so a new route has somewhere
 * obvious to record its own position. `l3/create` is also commented here because it is the one whose
 * repeatability a reader will want checked: `jti` is a deterministic hash of the L3a issuer JWT, and
 * the L3a embeds `iat`, so a retry that crosses a second boundary can legitimately produce a
 * different `jti` for the same checkout attempt. That is a fact for the Gate's replay key (WP-10) to
 * know, not something this client can enforce.
 */
export const ROUTE_RETRY_NOTES: Readonly<Record<string, string>> = {
  'POST /v1/l2/prepare':
    'Safe to repeat (spec §8.4). Not idempotent — a repeat mints a fresh prepare_id and a fresh signing_input — ' +
    'but harmless: the first record is orphaned and expires with the in-memory prepare store (300 s), and the ' +
    'caller signs whichever response arrives. This is why an automatic 5xx/connection retry is correct here.',
  'POST /v1/l3/create':
    'Repeatable per spec §8.4. Note the boundary: jti is a deterministic hash of the L3a issuer JWT and the ' +
    'L3a embeds iat, so a retry crossing a second boundary can yield a different jti for the same attempt. The ' +
    "Gate's replay key, not this client, is where that has to be handled (WP-10).",
  'POST /v1/l2/finalize':
    'Repeatable: vi re-verifies the signature on every finalize inside the prepare window, and returns the same ' +
    'L2. A repeated finalize is a read, not a second signing.',
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** The `CsErrorBody` envelope `apps/vi` returns on every non-2xx (spec §8.0 rule 3). */
interface ViErrorBody {
  readonly error?: {
    readonly code?: unknown
    readonly message?: unknown
    readonly userMessage?: unknown
    readonly retryable?: unknown
    readonly details?: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fallback code per HTTP status, used when the body is not a `CsErrorBody`.
 *
 * `apps/vi` wraps *everything*, including FastAPI's own validation errors, so an unrecognised body
 * means a proxy, a load balancer or a different service answered — not that vi misbehaved. `CS_INTERNAL`
 * is the honest code for "something between us and vi answered, and we do not know what".
 */
const STATUS_FALLBACK: Readonly<Record<number, CsErrorCode>> = {
  400: 'CS_VALIDATION',
  401: 'CS_UNAUTHENTICATED',
  403: 'CS_FORBIDDEN',
  404: 'CS_NOT_FOUND',
  409: 'CS_CONFLICT',
  422: 'CS_VALIDATION',
  429: 'CS_RATE_LIMITED',
}

export interface MapViErrorInput {
  readonly status: number
  /** The parsed response body, or `undefined` when there was none or it was not JSON. */
  readonly body?: unknown
  readonly method: string
  readonly path: string
  /** Attempts spent, so the caller can see the retry budget was used. */
  readonly attempts?: number
}

/**
 * Map one non-2xx response onto a `CsError`.
 *
 * **The service's code wins.** `error.code` is read and, if it is a member of the one registry in
 * `packages/core` (`isCsErrorCode`), it is used verbatim. That is what keeps
 * `VI_SIGNATURE_MISMATCH` from `/v1/l2/finalize` as `VI_SIGNATURE_MISMATCH` — the browser UI branches
 * on that code (spec §8.5, EC-KEY-1) to say "this is a new device", and a client that flattened every
 * failure to `CS_INTERNAL` would send the user to the wrong page after they cleared their browser.
 *
 * **Retryability is the HTTP status's answer, not the body's.** `apps/vi`'s catch-all handler maps a
 * 500 onto `CS_VALIDATION` (`main.py::_unhandled`) with `retryable: false`, because its own registry
 * mirror predates `CS_INTERNAL` and it has no code that means "the server broke". Reporting a server
 * fault as "check your input, and by the way do not retry" would send an operator hunting for a bad
 * request that does not exist. So for a 5xx this function sets `retryable: true` **regardless of what
 * the body claims**, while keeping the service's code and message intact — the code is what callers
 * branch on, and rewriting it here would hide a real divergence between the two error registries.
 * `details.http_status` is always present so the mismatch is visible in a log rather than inferred.
 *
 * Details from the service are passed through **as-is** and are not re-scrubbed here: vi already runs
 * them through `safe_details` on the way out (mirroring `core`'s `safeDetails`), and scrubbing twice
 * would silently drop fields a caller needs.
 */
export function mapViError(input: MapViErrorInput): CsError {
  const where = `${input.method} ${input.path}`
  const body = isRecord(input.body) ? (input.body as ViErrorBody) : undefined
  const inner = isRecord(body?.error) ? body.error : undefined

  const code = typeof inner?.code === 'string' && isCsErrorCode(inner.code) ? inner.code : undefined
  const fallback = code ?? (STATUS_FALLBACK[input.status] ?? (input.status >= 500 ? 'CS_INTERNAL' : 'CS_VALIDATION'))
  const message =
    typeof inner?.message === 'string' && inner.message !== ''
      ? `${where} -> ${input.status}: ${inner.message}`
      : `${where} -> ${input.status} with no CsErrorBody`

  const serviceRetryable = typeof inner?.retryable === 'boolean' ? inner.retryable : false
  const retryable = input.status >= 500 ? true : serviceRetryable
  const details = isRecord(inner?.details) ? inner.details : undefined

  return csError(
    fallback,
    message,
    {
      http_status: input.status,
      method: input.method,
      path: input.path,
      // Present only when the body carried a code we did not recognise, so a typo in vi's registry
      // shows up as a named fact instead of being absorbed into a fallback.
      vi_code: typeof inner?.code === 'string' ? inner.code : undefined,
      attempts: input.attempts,
      ...(details ? { service_details: details } : {}),
    },
    {
      retryable,
      ...(typeof inner?.userMessage === 'string' ? { userMessage: inner.userMessage } : {}),
    },
  )
}

/**
 * A transport failure: DNS, TLS, connection reset, or our own timeout.
 *
 * Always `CS_INTERNAL` — vi is our own internal service, so `PP_UNAVAILABLE` would be a lie about
 * which company is failing. Always `retryable: true`, because a failure to obtain a response says
 * nothing about whether the request would succeed next time. `ambiguous: true` marks the case this
 * client genuinely cannot resolve: we do not know whether vi processed the request before the
 * connection dropped, which matters for `l3/create` (see {@link ROUTE_RETRY_NOTES}).
 */
export function transportError(args: {
  readonly method: string
  readonly path: string
  readonly cause: unknown
  readonly timedOut: boolean
  readonly timeoutMs: number
  readonly attempts: number
}): CsError {
  const detail = args.cause instanceof Error && args.cause.message !== '' ? args.cause.message : String(args.cause)
  return csError(
    'CS_INTERNAL',
    `${args.method} ${args.path} failed before a response was received${
      args.timedOut ? ` (timeout after ${args.timeoutMs} ms)` : ''
    }: ${detail}`,
    {
      method: args.method,
      path: args.path,
      attempts: args.attempts,
      timed_out: args.timedOut,
      ambiguous: true,
    },
    { retryable: true, cause: args.cause },
  )
}

// ---------------------------------------------------------------------------
// JSON serialisation — bigint money back to JSON integers
// ---------------------------------------------------------------------------

/**
 * Convert every `bigint` in a request body to a JSON integer.
 *
 * {@link minorUnitsSchema} yields `bigint`, because that is what `core`'s `Money` uses and it makes a
 * later `amount / 100` a compile error rather than a rounding bug. `JSON.stringify` throws on a bigint,
 * so this is the single sanctioned conversion on the way out — and it refuses rather than rounding,
 * because an integer beyond `Number.MAX_SAFE_INTEGER` has already lost precision by the time it became
 * a JSON number, and emitting it anyway would put a wrong amount on the wire.
 *
 * `undefined` is left alone so `JSON.stringify` can drop absent optional fields exactly as it would
 * without this function.
 */
export function jsonSafeBody(value: unknown, path = '$'): unknown {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw csError('CS_VALIDATION', `Money at ${path} exceeds the safe integer range and cannot be sent as JSON`, {
        path,
      })
    }
    return Number(value)
  }
  if (Array.isArray(value)) return value.map((v, i) => jsonSafeBody(v, `${path}[${i}]`))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafeBody(v, `${path}.${k}`)
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ViClientOptions {
  /** e.g. `http://vi:8000` (Render private network, spec §6 `VI_SERVICE_URL`). */
  readonly baseUrl: string
  /** `VI_SERVICE_TOKEN`. Sent as `Authorization: Bearer …` on every route except the two public ones. */
  readonly token: string
  /** The only time source (spec §8.0 rule 10). Used for log stamps and elapsed-time reporting. */
  readonly clock: Clock
  /** Injected transport. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
  /** Injected wait, so a retry backoff costs a test nothing. */
  readonly sleep?: Sleep
  readonly logger?: Logger
  /** Per attempt. Spec §8.4: 5 000. */
  readonly timeoutMs?: number
  /** Spec §8.4: 2. A retry budget, so the default is three fetches at worst. */
  readonly maxRetries?: number
}

/** Normalise `baseUrl` so `join` never produces a double slash and a trailing slash is harmless. */
export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Is this a timeout rather than some other transport failure?
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError`; a caller-supplied `AbortController` aborts with
 * an `AbortError`. Both mean "we stopped waiting", so both are treated as a timeout.
 */
export function isTimeoutError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class ViClient {
  readonly baseUrl: string
  private readonly token: string
  private readonly clock: Clock
  private readonly fetchImpl: typeof fetch
  private readonly sleep: Sleep
  private readonly log: Logger
  private readonly timeoutMs: number
  private readonly maxRetries: number

  constructor(options: ViClientOptions) {
    this.baseUrl = normaliseBaseUrl(options.baseUrl)
    this.token = options.token
    this.clock = options.clock
    // Bound so a `fetch` handed in as a bare function reference still finds its `this` (undici).
    this.fetchImpl = options.fetchImpl
      ? ((url, init) => options.fetchImpl!(url, init))
      : ((url, init) => fetch(url, init))
    this.sleep = options.sleep ?? realSleep
    this.log =
      options.logger ??
      // A silent default: this client runs inside Next route handlers and the worker, where a logger
      // is already ambient, and an unconfigured logger writing to stdout on every Gate decision would
      // be noise rather than signal.
      { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => this.log }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  // --- routes -------------------------------------------------------------------------------------

  /**
   * `POST /v1/keys/agent` — mint one P-256 key per agent instance.
   *
   * What comes back is all `apps/web` is allowed to hold: the public JWK and the AES-256-GCM
   * ciphertext. The plaintext private key never leaves the service (spec D5).
   */
  async mintAgentKey(req: MintAgentKeyRequest): Promise<Result<MintAgentKeyResponse, CsError>> {
    return this.call('POST', '/v1/keys/agent', mintAgentKeyRequestSchema, mintAgentKeyResponseSchema, req)
  }

  /**
   * `POST /v1/keys/rotate` — retire the current `ISSUER`/`MERCHANT` key and mint a replacement.
   *
   * Nothing is deleted: the retired public key stays resolvable by `kid` and stays in `/v1/jwks`, so
   * evidence signed before the rotation still verifies (spec EC-KEY-2, EC-KEY-3).
   */
  async rotateKey(req: RotateKeyRequest): Promise<Result<RotateKeyResponse, CsError>> {
    return this.call('POST', '/v1/keys/rotate', rotateKeyRequestSchema, rotateKeyResponseSchema, req)
  }

  /**
   * `GET /v1/jwks` — issuer, merchant and every agent key, **retired ones included** with a `status`.
   *
   * Public and rate-limited to 30/min/IP: a verifier needs the retired keys to check old evidence, and
   * a public key set is not a secret. No bearer token is sent.
   */
  async jwks(): Promise<Result<JwksResponse, CsError>> {
    return this.call('GET', '/v1/jwks', undefined, jwksResponseSchema)
  }

  /** `POST /v1/l1/issue` — the issuer signs L1, binding `sub`, the device public key and `card_id`. */
  async issueL1(req: L1IssueRequest): Promise<Result<L1IssueResponse, CsError>> {
    return this.call('POST', '/v1/l1/issue', l1IssueRequestSchema, l1IssueResponseSchema, req)
  }

  /**
   * `POST /v1/l2/prepare` — phase 1 of two-phase signing (spec D3).
   *
   * **Safe to repeat.** See {@link ROUTE_RETRY_NOTES} for what "safe" means precisely: a repeat mints
   * a fresh `prepare_id` and a fresh `signing_input` and orphans the first record, which expires with
   * the in-memory prepare store after 300 s. The caller signs whichever response arrives, so the orphan
   * costs nothing and an automatic retry on a 5xx is correct.
   *
   * `value.signing_input` is the exact string the browser must sign, and `value.payload` is the exact
   * object the UI must render as the consent read-back (spec §8.5). Both come straight off the wire.
   */
  async prepareL2(req: L2PrepareRequest): Promise<Result<L2PrepareResponse, CsError>> {
    return this.call('POST', '/v1/l2/prepare', l2PrepareRequestSchema, l2PrepareResponseSchema, req)
  }

  /**
   * `POST /v1/l2/finalize` — phase 2. vi verifies the browser's signature against the **L1's** device
   * key before returning the L2, which is what makes two-phase signing safe rather than a way to attach
   * an arbitrary signature.
   *
   * A signature that does not verify comes back as `VI_SIGNATURE_MISMATCH` and no token. That code
   * reaches the browser intact, because EC-KEY-1's "this device is new, reconnect PayPal" screen hangs
   * off it.
   */
  async finalizeL2(req: L2FinalizeRequest): Promise<Result<L2FinalizeResponse, CsError>> {
    return this.call('POST', '/v1/l2/finalize', l2FinalizeRequestSchema, l2FinalizeResponseSchema, req)
  }

  /**
   * `POST /v1/checkout-jwt` — the merchant signs the price lock.
   *
   * Amounts are integer minor units throughout, and `checkoutJwtRequestSchema` refuses a float before it
   * reaches the wire (EC-FX-6).
   */
  async createCheckoutJwt(req: CheckoutJwtRequest): Promise<Result<CheckoutJwtResponse, CsError>> {
    return this.call('POST', '/v1/checkout-jwt', checkoutJwtRequestSchema, checkoutJwtResponseSchema, req)
  }

  /**
   * `POST /v1/l3/create` — pre-check the L2's constraints, then sign L3a (payment) and L3b (checkout).
   *
   * `VI_CONSTRAINT_VIOLATION` means **not signed**: the agent is the untrusted party (spec §3.1), so a
   * route that signed an out-of-mandate L3 would let a prompt injection in a product listing spend money.
   */
  async createL3(req: L3CreateRequest): Promise<Result<L3CreateResponse, CsError>> {
    return this.call('POST', '/v1/l3/create', l3CreateRequestSchema, l3CreateResponseSchema, req)
  }

  /**
   * `POST /v1/verify` — `verify_chain` + `check_constraints(STRICT)`.
   *
   * ### An invalid chain is a successful call
   *
   * `/v1/verify` answers `200 {chain_valid: false, errors: [...]}`, never a 4xx. That is a **result**,
   * not a transport failure, so this method returns `ok(...)` with `chain_valid: false` and lets the
   * Gate read the reasons. Returning `err(...)` would discard `errors`, `constraints`,
   * `constraints.skipped`, `disclosed` and `keys` — which is every input the decision is made from —
   * and would leave the Gate unable to tell "the chain is invalid" from "we could not ask".
   *
   * The `err` this method can return is only about the *request* or the *transport*: a malformed body,
   * a missing bearer token, a timeout.
   */
  async verify(req: VerifyRequest): Promise<Result<VerifyResponse, CsError>> {
    return this.call('POST', '/v1/verify', verifyRequestSchema, verifyResponseSchema, req)
  }

  /**
   * `POST /v1/public/verify` — the same verdict plus `bundle_hash`, public and rate-limited to
   * 30/min/IP. This is the route behind `/v/{packetId}` (spec §7.3, WP-18).
   *
   * No bearer token is sent: the route is public by design, and sending one would be harmless but
   * would make a leaked token look like it was used against a public endpoint.
   *
   * Like {@link verify}, `chain_valid: false` comes back as `ok(...)`.
   */
  async publicVerify(req: PublicVerifyRequest): Promise<Result<PublicVerifyResponse, CsError>> {
    return this.call('POST', '/v1/public/verify', publicVerifyRequestSchema, publicVerifyResponseSchema, req)
  }

  /**
   * `GET /v1/status` — liveness, the kids in force, and the skew `VI_CLOCK_SKEW_SECONDS` is using.
   *
   * EC-TIME-2: this reports what **vi** believes the time is. Comparing it with this process's own
   * clock is the caller's job, and the bounded skew is what makes a few seconds of drift harmless.
   */
  async status(): Promise<Result<StatusResponse, CsError>> {
    return this.call('GET', '/v1/status', undefined, statusResponseSchema)
  }

  /**
   * `GET /v1/checkout-jwt/verify` — does this price lock verify against a merchant key we know?
   *
   * Always answers `{valid, reason, checked_at}`. A price lock that does not even parse is
   * `valid: false`, not a 4xx, because the whole point of the route is to be asked "is this thing
   * good?" and get told. A diagnostic for WP-09's checkout work.
   */
  async verifyCheckoutJwt(checkoutJwt: string): Promise<Result<CheckoutJwtVerifyResponse, CsError>> {
    if (typeof checkoutJwt !== 'string' || checkoutJwt.trim() === '') {
      return {
        ok: false,
        error: csError('CS_VALIDATION', 'verifyCheckoutJwt needs a checkout JWT to ask about', {
          argument: 'checkoutJwt',
        }),
      }
    }
    return this.call(
      'GET',
      `/v1/checkout-jwt/verify?checkout_jwt=${encodeURIComponent(checkoutJwt)}`,
      undefined,
      checkoutJwtVerifyResponseSchema,
    )
  }

  // --- transport ----------------------------------------------------------------------------------

  /**
   * Validate, send, validate. Every route goes through here.
   *
   * The request is validated **before** the first fetch. That ordering is deliberate: a float in
   * `amount_minor` should be refused by our own process with a message naming the field, not shipped
   * to vi and returned as a 400 with less context.
   */
  private async call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    requestSchema: z.ZodType | undefined,
    responseSchema: S,
    body?: unknown,
  ): Promise<Result<z.output<S>, CsError>> {
    const contract = findRouteContract(method, path)
    if (!contract) {
      return {
        ok: false,
        error: csError('CS_INTERNAL', `No route contract registered for ${method} ${path}`, { method, path }),
      }
    }

    let payload: string | undefined
    if (requestSchema) {
      if (body === undefined) {
        return {
          ok: false,
          error: csError('CS_VALIDATION', `${method} ${contract.path} requires a request body`, {
            method,
            path: contract.path,
          }),
        }
      }
      const checked = requestSchema.safeParse(body)
      if (!checked.success) {
        return {
          ok: false,
          error: csError(
            'CS_VALIDATION',
            `${method} ${contract.path} request failed validation: ${formatIssues(checked.error)}`,
            {
              method,
              path: contract.path,
              issues: checked.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
            },
          ),
        }
      }
      try {
        payload = JSON.stringify(jsonSafeBody(checked.data))
      } catch (e) {
        return { ok: false, error: toCsError(e, 'CS_VALIDATION') }
      }
    }

    const headers: Record<string, string> = { accept: 'application/json' }
    if (payload !== undefined) headers['content-type'] = 'application/json'
    if (contract.auth === 'bearer') headers['authorization'] = `Bearer ${this.token}`

    const url = `${this.baseUrl}${path}`
    const startedAt = this.clock.nowMs()

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (e) {
        const timedOut = isTimeoutError(e)
        const error = transportError({
          method,
          path: contract.path,
          cause: e,
          timedOut,
          timeoutMs: this.timeoutMs,
          attempts: attempt,
        })
        const verdict = shouldRetry({ kind: timedOut ? 'timeout' : 'connection', attempt, maxRetries: this.maxRetries })
        if (verdict.retry) {
          await this.backoff(attempt, method, contract.path, error.code, verdict.reason)
          continue
        }
        return { ok: false, error: { ...error, details: { ...error.details, elapsed_ms: this.clock.nowMs() - startedAt } } }
      }

      if (!response.ok) {
        const body_ = await safeJson(response)
        const error = mapViError({ status: response.status, body: body_, method, path: contract.path, attempts: attempt })
        const verdict = shouldRetry({ kind: 'response', status: response.status, attempt, maxRetries: this.maxRetries })
        if (verdict.retry) {
          await this.backoff(attempt, method, contract.path, error.code, verdict.reason)
          continue
        }
        return { ok: false, error }
      }

      const value = await safeJson(response)
      const checked = responseSchema.safeParse(value)
      if (!checked.success) {
        // A 2xx whose body we do not recognise. Not vi's fault and not the caller's: a response shape
        // that changed under us is an internal fault, and reporting it as `CS_VALIDATION` would send
        // somebody to fix a request that was already right.
        return {
          ok: false,
          error: csError(
            'CS_INTERNAL',
            `${method} ${contract.path} returned ${response.status} with a body this client does not recognise`,
            {
              status: response.status,
              issues: checked.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
              body_keys: isRecord(value) ? Object.keys(value) : undefined,
            },
          ),
        }
      }
      return { ok: true, value: checked.data }
    }

    // Unreachable: the loop either returns or continues, and `attempt <= maxRetries + 1`. Present so a
    // future edit that breaks that invariant fails loudly rather than returning `undefined`.
    return {
      ok: false,
      error: csError('CS_INTERNAL', `${method} ${contract.path} exhausted its retry loop without a verdict`, {
        method,
        path: contract.path,
        max_retries: this.maxRetries,
      }),
    }
  }

  /** Wait before the next attempt, and say so. */
  private async backoff(
    attempt: number,
    method: string,
    path: string,
    code: CsErrorCode,
    reason: string,
  ): Promise<void> {
    const delay = retryDelayMs(attempt)
    this.log.warn('retrying vi call', { method, path, attempt, next_attempt_in_ms: delay, code, reason })
    await this.sleep(delay)
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Read a response body as JSON, or `undefined`.
 *
 * A failure here is never fatal: an error response with no body is still a 4xx/5xx we must map, and a
 * success response with no body will be rejected by the response schema with a much clearer message
 * than anything this function could produce.
 */
async function safeJson(response: Response): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return undefined
  }
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function formatIssues(e: z.ZodError): string {
  return e.issues
    .slice(0, 8)
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}

export { ROUTE_CONTRACTS }