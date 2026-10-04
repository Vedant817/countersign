/**
 * PayPal `name` / `issue` → `CsErrorCode` — spec §8.6 "Error mapping", §8.1 error registry.
 *
 * The mapping is the whole reason this package exists instead of a `fetch` call: every failure that
 * leaves M6 has to be a `CsError` with a code from the one registry, because the Gate, the queue and
 * the UI all branch on that code (`PP_INSTRUMENT_DECLINED` prompts "update your card";
 * `PP_UNAVAILABLE` queues a retry; `PP_UNPROCESSABLE` is a bug report).
 *
 * ## The subtlety: `name` is usually generic, the `issue` is specific
 *
 * On Orders v2 and Payments v2 a declined card comes back as
 *
 * ```json
 * { "name": "UNPROCESSABLE_ENTITY",
 *   "details": [{ "issue": "PAYER_ACTION_REQUIRED", "description": "…" }] }
 * ```
 *
 * so mapping only on `name` — the reading of the spec's arrow list that is easiest to implement —
 * would report every decline as `PP_UNPROCESSABLE` and the "PayPal needs you to approve something"
 * branch (spec §8.6) would never fire. The table is therefore consulted for **each
 * `details[].issue` first**, and only then for `name`. Every entry is annotated with where it comes
 * from; anything not in the table falls back to the status code and says so in `details.unmapped`.
 */
import { csError } from '@countersign/core'
import type { CsError, CsErrorCode } from '@countersign/core'

/** PayPal's standard error body [B12, B16]. Only the fields we act on are typed. */
export interface PayPalIssue {
  readonly issue?: string
  readonly issue_type?: string
  readonly description?: string
  readonly field?: string
  readonly value?: string
  readonly location?: string
}

export interface PayPalErrorBody {
  readonly name?: string
  readonly message?: string
  readonly debug_id?: string
  readonly http_status_code?: number
  readonly details?: readonly PayPalIssue[]
  readonly links?: readonly { href?: string; rel?: string; method?: string }[]
  /** OAuth (`/v1/oauth2/token`) uses `error` / `error_description` instead of `name`/`message`. */
  readonly error?: string
  readonly error_description?: string
}

/**
 * The registry mapping. Keys are PayPal's own vocabulary, so a lookup failure is visible in the code
 * rather than inferred from a status number.
 *
 * Only names this package can cite are listed. An unmapped name is not an error: it falls back to the
 * status code and is reported in `details.unmapped_name`, which is how a new PayPal error becomes a
 * line in a log instead of a silent misclassification.
 */
export const NAME_TO_CODE: Readonly<Record<string, CsErrorCode>> = {
  // --- the five the spec names explicitly (§8.6 "Error mapping") ---
  UNPROCESSABLE_ENTITY: 'PP_UNPROCESSABLE',
  INSTRUMENT_DECLINED: 'PP_INSTRUMENT_DECLINED',
  PAYER_ACTION_REQUIRED: 'PP_PAYER_ACTION_REQUIRED',
  AUTHORIZATION_EXPIRED: 'PP_AUTH_EXPIRED',
  RATE_LIMIT_REACHED: 'PP_RATE_LIMITED',
  // --- names the same endpoints return in `details[].issue` [B12, V15] ---
  PAYER_CANNOT_PAY: 'PP_INSTRUMENT_DECLINED',
  // `TRANSACTION_REFUSED` is the sandbox's blunt "no": a card the sandbox will not accept. Reported
  // as unprocessable rather than declined because it is not the payer's instrument failing.
  TRANSACTION_REFUSED: 'PP_UNPROCESSABLE',
  CARD_EXPIRED: 'PP_INSTRUMENT_DECLINED',
  // --- resource and idempotency ---
  RESOURCE_NOT_FOUND: 'PP_NOT_FOUND',
  DUPLICATE_INVOICE_ID: 'PP_DUPLICATE',
  DUPLICATE_WEBHOOK_EVENT: 'PP_DUPLICATE',
  INVALID_REQUEST_ID: 'PP_DUPLICATE',
  // --- disputes / merchant action ---
  DISPUTE_HAS_NO_EVIDENCE: 'PP_UNPROCESSABLE',
  DISPUTE_STATE_NOT_ALLOWED: 'PP_UNPROCESSABLE',
  // --- OAuth ---
  invalid_client: 'PP_AUTH',
  invalid_grant: 'PP_AUTH',
  unauthorized_client: 'PP_AUTH',
  invalid_request: 'PP_UNPROCESSABLE',
  invalid_scope: 'PP_UNPROCESSABLE',
  unsupported_grant_type: 'PP_UNPROCESSABLE',
}

/**
 * Fallback per HTTP status, used when neither an `issue` nor a `name` maps.
 *
 * Deliberately conservative: a status we have no better information about becomes
 * `PP_UNPROCESSABLE` (retrying will not help, the request needs fixing) rather than something
 * retryable.
 */
const STATUS_TO_CODE: Readonly<Record<number, CsErrorCode>> = {
  400: 'PP_UNPROCESSABLE',
  401: 'PP_AUTH',
  403: 'CS_FORBIDDEN',
  404: 'PP_NOT_FOUND',
  409: 'PP_DUPLICATE',
  422: 'PP_UNPROCESSABLE',
  429: 'PP_RATE_LIMITED',
}

/** Codes whose retryability the registry in `@countersign/core` already sets to `true`. */
const RETRYABLE_CODES: ReadonlySet<CsErrorCode> = new Set<CsErrorCode>([
  'PP_RATE_LIMITED',
  'PP_UNAVAILABLE',
])

export type HeaderBag =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | undefined

/**
 * Read one header, case-insensitively, from anything `fetch` might have handed us.
 *
 * A `Headers` object is already case-insensitive, but a fake `fetch` in a test may hand over a plain
 * object with the header spelled `PayPal-Debug-Id`; scanning case-insensitively means the debug-id
 * logging (spec §8.6 "Always log paypal-debug-id") does not silently evaporate in tests and then in
 * production. Returns the first value when a header repeats.
 */
export function headerValue(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== wanted || v === undefined) continue
    if (typeof v === 'string') return v
    return v[0]
  }
  return undefined
}

/** `paypal-debug-id` from a response. The one header we must never fail to capture. */
export function extractDebugId(headers: HeaderBag): string | undefined {
  return headerValue(headers, 'paypal-debug-id')
}

/** The error `name`, falling back to the OAuth `error` field. */
export function paypalName(body: PayPalErrorBody | undefined): string | undefined {
  return body?.name ?? body?.error
}

/** Every issue token in the body, in PayPal's order, de-duplicated. */
export function issueTokens(body: PayPalErrorBody | undefined): string[] {
  const out: string[] = []
  for (const d of body?.details ?? []) {
    for (const t of [d.issue, d.issue_type]) {
      if (typeof t === 'string' && t !== '' && !out.includes(t)) out.push(t)
    }
  }
  return out
}

/** The first `details[].issue`, which is the field the spec asks us to keep on `PP_UNPROCESSABLE`. */
export function firstIssue(body: PayPalErrorBody | undefined): PayPalIssue | undefined {
  return body?.details?.[0]
}

export interface MapErrorInput {
  readonly status: number
  /** Parsed JSON body, or `undefined` when the response had no body or unparseable JSON. */
  readonly body?: PayPalErrorBody | undefined
  readonly headers?: HeaderBag
  /** Already extracted, when the caller has it; otherwise read from `headers`. */
  readonly debugId?: string | undefined
  /** Raw `Retry-After` header, kept verbatim so the retry loop can parse it against the clock. */
  readonly retryAfterHeader?: string | undefined
  readonly method: string
  readonly path: string
  readonly requestId?: string | undefined
}

/** Is this a failure where we genuinely do not know whether PayPal executed the request? */
export function isAmbiguousStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/**
 * Map one failed PayPal response onto a `CsError`.
 *
 * @param input the response context. `method`/`path` go into `details` so a log line names the call
 *   without any of its inputs (which may contain amounts or a vault id).
 */
export function mapPayPalError(input: MapErrorInput): CsError {
  const body = input.body
  const name = paypalName(body)
  const issues = issueTokens(body)
  const debugId = input.debugId ?? body?.debug_id ?? extractDebugId(input.headers)
  const issue = firstIssue(body)

  // 1. The specific issues, before the generic name. See the module comment for why.
  let code: CsErrorCode | undefined
  let matchedToken: string | undefined
  for (const token of issues) {
    const mapped = NAME_TO_CODE[token]
    if (mapped) {
      code = mapped
      matchedToken = token
      break
    }
  }
  // 2. Then the name.
  if (!code && name && NAME_TO_CODE[name]) {
    code = NAME_TO_CODE[name]
    matchedToken = name
  }
  // 3. Then the status.
  if (!code) code = statusCodeFallback(input.status)

  const retryable = input.status === 429 || input.status >= 500 || RETRYABLE_CODES.has(code)

  const messageParts = [
    `${input.method} ${input.path} -> ${input.status}`,
    name ? `name=${name}` : undefined,
    issue?.issue ? `issue=${issue.issue}` : undefined,
    body?.error_description ?? body?.message ?? undefined,
  ].filter((p): p is string => typeof p === 'string' && p !== '')

  return csError(
    code,
    messageParts.join(' | '),
    {
      status: input.status,
      // Kept because the spec requires it: the issue is the actionable part of a 422.
      issue: issue?.issue,
      issue_description: issue?.description,
      issue_field: issue?.field,
      paypal_name: name,
      matched_token: matchedToken,
      unmapped_name: name !== undefined && !matchedToken ? name : undefined,
      paypal_debug_id: debugId,
      request_id: input.requestId,
      // Kept verbatim; `backoff.parseRetryAfter` turns it into a duration against the injected clock.
      retry_after: input.retryAfterHeader,
      path: input.path,
      method: input.method,
      ...(isAmbiguousStatus(input.status) ? { ambiguous: true } : {}),
    },
    { retryable },
  )
}

function statusCodeFallback(status: number): CsErrorCode {
  if (STATUS_TO_CODE[status]) return STATUS_TO_CODE[status]
  if (status >= 500) return 'PP_UNAVAILABLE'
  if (status >= 400) return 'PP_UNPROCESSABLE'
  // A non-error status reaching this function means our own parsing went wrong, not that PayPal
  // complained. `CS_INTERNAL` keeps that distinguishable in the logs.
  return 'CS_INTERNAL'
}

/**
 * A network failure: DNS, TLS, connection reset, or our own timeout.
 *
 * Always `PP_UNAVAILABLE` and always `retryable`, because we cannot tell whether PayPal executed the
 * request — that ambiguity is exactly what `details.ambiguous` is for, and it is why the retry
 * policy for non-idempotent endpoints re-reads instead of blindly retrying (EC-IDEM-3).
 */
export function networkError(args: {
  method: string
  path: string
  cause: unknown
  requestId?: string | undefined
  timedOut?: boolean
}): CsError {
  const message =
    args.cause instanceof Error && args.cause.message !== ''
      ? args.cause.message
      : String(args.cause)
  return csError(
    'PP_UNAVAILABLE',
    `${args.method} ${args.path} failed before a response was received${args.timedOut ? ' (timeout)' : ''}: ${message}`,
    {
      method: args.method,
      path: args.path,
      request_id: args.requestId,
      ambiguous: true,
      timed_out: args.timedOut ?? false,
    },
    { retryable: true, cause: args.cause },
  )
}
