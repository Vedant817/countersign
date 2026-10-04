/**
 * The error registry — spec §8.1 M1, §8.0 rule 3.
 *
 * One registry, one shape. Every failure that crosses a module boundary is a `CsError` with a
 * `code` from this file, a machine `message`, and a `userMessage` that is safe to render to a buyer
 * or a merchant without leaking internals.
 *
 * The split between `message` and `userMessage` is deliberate and is the reason judges can read
 * Gate output: the merchant sees `GATE_BUDGET_EXCEEDED` plus a precise number; the buyer sees
 * "Your limit is $130.00 and this cart is $999.00."
 */

/** The closed registry. Adding a code is a spec change; note it in docs/DECISIONS.md. */
export const CS_ERROR_CODES = [
  // --- generic ---
  'CS_VALIDATION',
  'CS_NOT_FOUND',
  'CS_CONFLICT',
  'CS_UNAUTHENTICATED',
  'CS_FORBIDDEN',
  'CS_CURRENCY_MISMATCH',
  'CS_ROUNDING',
  // Not in spec §8.1's original registry; added by DECISIONS D-007, with the reason recorded there.
  //   CS_RATE_LIMITED — *our* rate limiter (vi-service public routes, Judge Mode concurrency cap).
  //                    Deliberately NOT PP_RATE_LIMITED, which would tell a buyer that PayPal is
  //                    throttling us when the constraint is ours.
  //   CS_INTERNAL    — an unhandled fault, so a 500 is never reported to a user as bad input.
  'CS_RATE_LIMITED',
  'CS_INTERNAL',
  // --- verifiable intent chain ---
  'VI_CHAIN_INVALID',
  'VI_SIGNATURE_MISMATCH',
  'VI_EXPIRED',
  'VI_NOT_YET_VALID',
  'VI_CONSTRAINT_VIOLATION',
  // --- gate ---
  'GATE_BLOCKED',
  'GATE_REPLAY',
  'GATE_BUDGET_EXCEEDED',
  'GATE_REVOKED',
  'GATE_PRICE_LOCK_EXPIRED',
  'GATE_OUT_OF_STOCK',
  'GATE_AGENT_SUSPENDED',
  'GATE_WALLET_CAP',
  // --- paypal ---
  'PP_AUTH',
  'PP_RATE_LIMITED',
  'PP_UNAVAILABLE',
  'PP_UNPROCESSABLE',
  'PP_DUPLICATE',
  'PP_NOT_FOUND',
  'PP_INSTRUMENT_DECLINED',
  'PP_PAYER_ACTION_REQUIRED',
  'PP_AUTH_EXPIRED',
  // --- webhooks ---
  'WH_SIGNATURE_INVALID',
  'WH_DUPLICATE',
  // --- dispute defender ---
  'DEF_NO_CHAIN',
  'DEF_CITATION_FAILED',
  'DEF_DEADLINE_PASSED',
  'DEF_WRONG_STATE',
  // --- llm + privacy ---
  'LLM_SCHEMA',
  'LLM_UNAVAILABLE',
  'PRIVACY_LEGAL_HOLD',
] as const

export type CsErrorCode = (typeof CS_ERROR_CODES)[number]

const CODE_SET: ReadonlySet<string> = new Set(CS_ERROR_CODES)

export function isCsErrorCode(value: unknown): value is CsErrorCode {
  return typeof value === 'string' && CODE_SET.has(value)
}

export interface CsError {
  readonly code: CsErrorCode
  /** Precise, for logs, the merchant UI and evidence packets. */
  readonly message: string
  /** Safe to show a buyer. Never contains secrets, tokens or internal ids. */
  readonly userMessage: string
  /** Whether a retry of the same request could succeed. Drives backoff and the UI's advice. */
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  readonly cause?: unknown
}

/** `Result<T, CsError>` — spec §8.1. Never throw across a module boundary; return this. */
export type Result<T, E = CsError> = { ok: true; value: T } | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

/** Codes that a retry can fix. Everything else needs a human or a different request. */
const RETRYABLE: ReadonlySet<CsErrorCode> = new Set<CsErrorCode>([
  'PP_RATE_LIMITED',
  'PP_UNAVAILABLE',
  'LLM_UNAVAILABLE',
  // Our own limiter: a client that backs off and retries will succeed, so it must be told so.
  'CS_RATE_LIMITED',
])

/**
 * Buyer-facing copy. Anything not listed gets a generic-but-honest message from
 * {@link defaultUserMessage}, so a new code can never leak a raw internal message to a user.
 */
const USER_MESSAGES: Partial<Record<CsErrorCode, string>> = {
  CS_VALIDATION: 'Some of that information is not valid. Please check and try again.',
  CS_NOT_FOUND: 'We could not find that. It may have been removed.',
  CS_CONFLICT: 'That conflicts with something we already saved. Refresh and try again.',
  CS_UNAUTHENTICATED: 'Please sign in and try again.',
  CS_FORBIDDEN: 'You do not have access to that.',
  CS_CURRENCY_MISMATCH:
    'Your limit and this purchase are in different currencies, so we did not convert them. Create a mandate in the store currency.',
  CS_ROUNDING:
    'That amount has more decimal places than its currency allows, so we refused to round it.',
  CS_RATE_LIMITED: 'Too many requests just now. Please wait a moment and try again.',
  CS_INTERNAL:
    'Something went wrong on our side. Nothing was charged. We have the details and will fix it.',
  VI_CHAIN_INVALID: 'The signed mandate could not be verified, so we stopped.',
  VI_SIGNATURE_MISMATCH: 'The signature did not match the key in the mandate, so we stopped.',
  VI_EXPIRED: 'Your mandate expired. Ask for a new one and we will continue.',
  VI_NOT_YET_VALID: 'That mandate is not valid yet.',
  VI_CONSTRAINT_VIOLATION: 'This purchase is outside the limits you signed.',
  GATE_BLOCKED: 'The merchant’s Gate blocked this purchase. The reasons are listed for you.',
  GATE_REPLAY: 'This exact authorisation was already used once, so it was not used again.',
  GATE_BUDGET_EXCEEDED: 'This purchase would take you past the limit you signed.',
  GATE_REVOKED: 'You revoked this mandate, so nothing further can be charged under it.',
  GATE_PRICE_LOCK_EXPIRED: 'The locked price expired, so the agent needs to re-quote.',
  GATE_OUT_OF_STOCK: 'That item just sold out.',
  GATE_AGENT_SUSPENDED: 'That agent is suspended, so it cannot spend right now.',
  GATE_WALLET_CAP: 'This purchase would pass your wallet-level cap.',
  PP_AUTH: 'We could not authorise with PayPal. Please try again shortly.',
  PP_RATE_LIMITED: 'PayPal is asking us to slow down. We will retry automatically.',
  PP_UNAVAILABLE: 'PayPal is having trouble. Nothing is charged twice; we will retry.',
  PP_UNPROCESSABLE: 'PayPal rejected the request details.',
  PP_DUPLICATE: 'That request was already made.',
  PP_NOT_FOUND: 'PayPal could not find that record.',
  PP_INSTRUMENT_DECLINED:
    'PayPal declined the payment. Nothing was charged. Update PayPal and retry.',
  PP_PAYER_ACTION_REQUIRED: 'PayPal needs you to approve something before this can complete.',
  PP_AUTH_EXPIRED: 'The authorisation expired before it was captured, so it was released.',
  WH_SIGNATURE_INVALID: 'A webhook failed its signature check and was rejected.',
  WH_DUPLICATE: 'That webhook was already processed.',
  DEF_NO_CHAIN: 'We cannot prove what was authorised for this payment.',
  DEF_CITATION_FAILED: 'The draft evidence contained claims without a source, so it was not filed.',
  DEF_DEADLINE_PASSED: 'PayPal’s response deadline has passed.',
  DEF_WRONG_STATE: 'This dispute is not in a state where that action is allowed.',
  LLM_SCHEMA: 'The model’s answer did not match the expected shape, so we asked again.',
  LLM_UNAVAILABLE: 'The model is unavailable. You can do this part by hand.',
  PRIVACY_LEGAL_HOLD: 'We must keep this record for now because a dispute needs it.',
}

/**
 * Fallback for a code with no hand-written copy. Generic on purpose: it must never leak the internal
 * `message`, which can contain amounts, ids or upstream response bodies.
 */
function defaultUserMessage(): string {
  return 'Something went wrong. Nothing was charged. Please try again.'
}

export interface CsErrorOptions {
  /** Override the buyer-facing sentence. Only for cases the registry copy cannot express. */
  readonly userMessage?: string
  /** Override the retryability default. */
  readonly retryable?: boolean
  /** The original throw, kept for logs. Never serialised into a response body. */
  readonly cause?: unknown
}

/**
 * Build a `CsError`.
 *
 * The third parameter is the **details bag** (structured context for logs, Gate reasons and
 * evidence packets) and the fourth carries behavioural options. They are separate parameters on
 * purpose: with one merged object it is easy to write `{ value: '1.005' }` into a signature that
 * expects `{ details: {...} }` and lose the details without any error — which is exactly the bug
 * this signature exists to make impossible.
 */
export function csError(
  code: CsErrorCode,
  message: string,
  details?: Record<string, unknown>,
  options?: CsErrorOptions,
): CsError {
  const base: CsError = {
    code,
    message,
    userMessage: options?.userMessage ?? USER_MESSAGES[code] ?? defaultUserMessage(),
    retryable: options?.retryable ?? RETRYABLE.has(code),
  }
  const cause = options?.cause
  return {
    ...base,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
    ...(cause !== undefined ? { cause } : {}),
  }
}

/** The Python side raises `HTTPException` with this body (spec §8.0 rule 3). Keep them in sync. */
export interface CsErrorBody {
  error: {
    code: CsErrorCode
    message: string
    userMessage: string
    retryable: boolean
    details?: Record<string, unknown>
  }
}

/**
 * Serialise for an HTTP response. This is the exact shape `apps/vi` raises in Python, so the two
 * services produce one error contract (spec §8.0 rule 3).
 *
 * Defence in depth: a `details` bag can hold anything, including a `cause` Error, a stack trace, or
 * a credential someone threaded through by mistake. Those are stripped here rather than trusted,
 * because this function's output crosses a trust boundary to a browser.
 *
 * The patterns are **unanchored on the left and `\b`-terminated on the right**, which is the only
 * shape that catches compound names. `_` is a word character in JavaScript, so `\bkey\b` does *not*
 * match `signing_key` and `\btoken\b` does *not* match `access_token` — an earlier version of this
 * file had exactly that bug, and a test now pins the behaviour.
 */
const NEVER_SERIALISE =
  /(cause|stack|secret|password|token|authorization|cookie|credential|private|key|kid|client_id|session_id|clientid)/i

function safeDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(details)) {
    if (NEVER_SERIALISE.test(k)) continue
    if (v instanceof Error) continue
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function toBody(e: CsError): CsErrorBody {
  const details = safeDetails(e.details)
  return {
    error: {
      code: e.code,
      message: e.message,
      userMessage: e.userMessage,
      retryable: e.retryable,
      ...(details ? { details } : {}),
    },
  }
}

/**
 * Turn anything thrown into a `CsError`. Never let a raw `unknown` escape a module.
 *
 * Defaults to `CS_INTERNAL` rather than `CS_VALIDATION`, because an exception that reaches this
 * function is an unhandled fault, not user input.
 */
export function toCsError(cause: unknown, fallbackCode: CsErrorCode = 'CS_INTERNAL'): CsError {
  if (typeof cause === 'object' && cause !== null && 'code' in cause && 'message' in cause) {
    const maybe = cause as {
      code: unknown
      message: unknown
      userMessage?: unknown
      details?: unknown
    }
    if (isCsErrorCode(maybe.code) && typeof maybe.message === 'string') {
      return csError(
        maybe.code,
        maybe.message,
        (maybe.details ?? undefined) as Record<string, unknown> | undefined,
        {
          cause,
          ...(typeof maybe.userMessage === 'string' ? { userMessage: maybe.userMessage } : {}),
        },
      )
    }
  }
  if (cause instanceof Error) {
    return csError(fallbackCode, cause.message, undefined, { cause })
  }
  return csError(
    fallbackCode,
    typeof cause === 'string' ? cause : JSON.stringify(cause),
    undefined,
    { cause },
  )
}

/**
 * Run `fn`, converting any throw into `err(toCsError(e))`. The workhorse of the `Result` style.
 *
 * The fallback code defaults to `CS_INTERNAL`, not `CS_VALIDATION`: an exception reaching this point
 * is an unhandled fault, and reporting it to a user as "check your input" sends them off to fix
 * something that was never wrong (DECISIONS D-007).
 */
export async function attempt<T>(
  fn: () => Promise<T>,
  fallbackCode?: CsErrorCode,
): Promise<Result<T, CsError>> {
  try {
    return ok(await fn())
  } catch (e) {
    return err(toCsError(e, fallbackCode ?? 'CS_INTERNAL'))
  }
}

/** Synchronous twin of {@link attempt}. */
export function attemptSync<T>(fn: () => T, fallbackCode?: CsErrorCode): Result<T, CsError> {
  try {
    return ok(fn())
  } catch (e) {
    return err(toCsError(e, fallbackCode))
  }
}

/** Unwrap or throw. Only for call sites already inside a `try`. */
export function unwrap<T>(r: Result<T, CsError>): T {
  if (r.ok) return r.value
  throw r.error
}

/** Map the success value, leaving errors untouched (still wrapped in the `Result` envelope). */
export function mapResult<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : { ok: false, error: r.error }
}

/**
 * Human-readable one-liner for logs: `CS_VALIDATION: message`.
 * `userMessage` is deliberately excluded so logs stay operator-facing (EC-PRIV-3 style).
 */
export function formatError(e: CsError): string {
  return `${e.code}: ${e.message}`
}
