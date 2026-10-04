/**
 * Signature verification and EC-WH-4's forged-webhook path — spec **§8.12**, **§12.3**, [V14].
 *
 * ## What this file decides
 *
 * Three outcomes, and they are three outcomes because §8.12 and EC-WH-7 disagree about what to do with a
 * failure and only a caller can tell them apart:
 *
 * | PayPal said | We do | Why |
 * |---|---|---|
 * | `SUCCESS` | store `VERIFIED`, enqueue, **200** | §8.12 step 4 |
 * | `FAILURE` | store `FAILED`, audit, **400**, no enqueue | EC-WH-4: forged |
 * | `PP_UNAVAILABLE` / timeout / anything else | store `PENDING`, **200**, **no enqueue** | EC-WH-7 |
 *
 * The third row is the one that is easy to get wrong. "Could not verify" and "verified as forged" look
 * alike at the call site and mean opposite things: one says *retry later*, the other says *never act on
 * this*. Collapsing them into a boolean is how an unverified event ends up driving a ledger movement, and
 * how a forged event ends up being retried forever.
 *
 * ## The raw bytes are load-bearing
 *
 * `verifyWebhookSignature` re-hashes the **exact** body PayPal sent. §8.12 step 1 says "read the raw body"
 * for that reason: `JSON.parse` followed by `JSON.stringify` reorders keys, drops `\uXXXX` escapes PayPal
 * may have used, and changes `1.0` to `1` — any of which changes the hash. So {@link WebhookVerifyInput}
 * takes the bytes and this module never re-serialises the parsed event for the verify call. The parsed
 * object is only ever used for `id`, `event_type` and `resource`, which are hints, not authority.
 *
 * ## EC-WH-4's alert
 *
 * "alert after 10/h" is a **rate on the count of failed rows**, not on the number of rejections, because
 * the two diverge: one forged POST retried 25 times is one row and twenty-five rejections. Counting the row
 * is what makes the number mean "someone is sending us ten different forged things", which is the thing
 * worth waking someone for.
 */
import { csError, ok, type Clock, type CsError, type Result } from '@countersign/core'
import type { WebhookHeaders, WebhookVerificationStatus } from '@countersign/paypal'

import type { WebhookAudit, WebhookDeps } from './types'

/** The five headers `verify-webhook-signature` requires, and the ones we store nothing from. */
export const REQUIRED_SIGNATURE_HEADERS = [
  'paypal-transmission-id',
  'paypal-transmission-time',
  'paypal-transmission-sig',
  'paypal-cert-url',
  'paypal-auth-algo',
] as const

export type SignatureHeaderName = (typeof REQUIRED_SIGNATURE_HEADERS)[number]

/** Any header bag a framework might hand us. Lower-cased keys are what PayPal's names already are. */
export type HeaderBag = Record<string, string | string[] | undefined>

/**
 * The five headers, or the names of the ones that are missing.
 *
 * Pure and case-insensitive, because HTTP header names are case-insensitive and a Next route that hands us
 * `Headers` will not normalise them for us.
 */
export function readSignatureHeaders(
  headers: HeaderBag,
): { ok: true; value: WebhookHeaders } | { ok: false; missing: readonly string[] } {
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const name of REQUIRED_SIGNATURE_HEADERS) {
    const raw = lookup(headers, name)
    if (raw === undefined || raw.trim() === '') {
      missing.push(name)
      continue
    }
    out[name] = raw
  }
  if (missing.length > 0) return { ok: false, missing }
  return { ok: true, value: out as unknown as WebhookHeaders }
}

function lookup(headers: HeaderBag, name: string): string | undefined {
  const direct = headers[name]
  if (typeof direct === 'string') return direct
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0]
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue
    if (typeof v === 'string') return v
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  }
  return undefined
}

/** The three outcomes, as a union. Narrowing on `outcome` is the whole contract. */
export type VerificationOutcome =
  | { readonly outcome: 'VERIFIED'; readonly status: 'SUCCESS' }
  | { readonly outcome: 'FORGED'; readonly status: 'FAILURE'; readonly error: CsError }
  | {
      readonly outcome: 'UNAVAILABLE'
      readonly status: null
      readonly error: CsError
      /** How long to wait before trying again. EC-WH-7's "retry with backoff". */
      readonly retryAfterSeconds: number
    }

export interface VerifyOptions {
  /**
   * The **raw** bytes, byte for byte. Never a re-serialisation of the parsed event (§8.12 step 1).
   */
  readonly rawBody: Uint8Array
  readonly headers: WebhookHeaders
  /** Our configured webhook id. An empty string means the environment is not configured, which is itself
   *  an `UNAVAILABLE` — a missing webhook id must never read as a successful verification. */
  readonly webhookId: string
  readonly clock: Clock
  /**
   * The PayPal port, called as a member.
   *
   * **Not** a detached `verifyWebhookSignature` reference: `PayPalClient`'s methods use `this`, and a
   * detached call throws. That throw is caught and mapped to `UNAVAILABLE`, so the failure is invisible —
   * every verification test would pass as though the endpoint were merely down. See `verifyDelivery`.
   */
  readonly paypal: WebhookDeps['paypal']
  /** Overrides `verifyTimeoutMs`. */
  readonly timeoutMs?: number
  /** EC-WH-7's backoff base. Doubles per attempt; see {@link verificationRetryAfterSeconds}. */
  readonly attempt?: number
}

/** §8.12's ack budget is 2 s, so the synchronous verify gets a slice of it and no more. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 1_500

/** EC-WH-7's backoff: 30 s, 60 s, 120 s … capped at 15 minutes. */
export const VERIFICATION_RETRY_BASE_SECONDS = 30
export const VERIFICATION_RETRY_MAX_SECONDS = 900

/**
 * How long to wait before re-verifying a `PENDING` row. Pure, so the schedule is testable without a clock.
 *
 * Exponential and capped. A plain fixed interval would hammer the one endpoint that is already unwell,
 * which is how a verify outage turns into a self-inflicted rate-limit outage.
 */
export function verificationRetryAfterSeconds(
  attempt: number,
  base: number = VERIFICATION_RETRY_BASE_SECONDS,
  max: number = VERIFICATION_RETRY_MAX_SECONDS,
): number {
  const n = Math.max(0, Math.floor(attempt))
  const delay = base * 2 ** Math.min(n, 20)
  return Math.min(delay, Math.max(base, max))
}

/**
 * Verify a delivery.
 *
 * **Fails closed in three distinct ways**, which is the property worth having:
 *
 * 1. Missing headers → `UNAVAILABLE` (not `FORGED`). A request with no signature is not evidence of
 *    forgery; it is evidence of nothing, and the honest action is to store it unverified and let a human
 *    or the reconciler look. Treating it as forgery would fill `webhook_events` with `FAILED` rows from
 *    health checks and scanners.
 * 2. `FAILURE`, or **any** verification status other than the exact string `SUCCESS` → `FORGED`.
 *    `PayPalClient.verifyWebhookSignature` already fails closed on an unrecognised status; this keeps that
 *    property visible at the port boundary rather than trusting it.
 * 3. The verify call itself errors, or overruns `timeoutMs` → `UNAVAILABLE`. EC-WH-7.
 */
export async function verifyDelivery(opts: VerifyOptions): Promise<VerificationOutcome> {
  const attempt = opts.attempt ?? 0
  const retryAfterSeconds = verificationRetryAfterSeconds(attempt)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS

  if (opts.webhookId.trim() === '') {
    return {
      outcome: 'UNAVAILABLE',
      status: null,
      retryAfterSeconds,
      error: csError(
        'PP_UNAVAILABLE',
        'PAYPAL_WEBHOOK_ID is not configured, so no webhook signature can be verified',
        { env: 'PAYPAL_WEBHOOK_ID' },
        { retryable: true },
      ),
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<VerificationOutcome>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({
        outcome: 'UNAVAILABLE',
        status: null,
        retryAfterSeconds,
        error: csError(
          'PP_UNAVAILABLE',
          `verify-webhook-signature did not answer within ${timeoutMs} ms`,
          { timeoutMs },
          { retryable: true },
        ),
      })
    }, timeoutMs)
    // Do not hold the process open for a timer whose only job is to lose a race.
    timer.unref?.()
  })

  try {
    // Called as a **member of `opts.paypal`**, not as a bare reference.
    //
    // `PayPalClient.verifyWebhookSignature` reaches `this.execute` and `this.log`, so passing
    // `deps.paypal.verifyWebhookSignature` as a detached function throws `TypeError: Cannot read properties of
    // undefined (reading 'execute')` on the first call. That throw is *caught* here and mapped to
    // `UNAVAILABLE` — which means it is invisible: the row is stored `PENDING`, the ack is 200, and every
    // test that expected a verified or a rejected event quietly passes as EC-WH-7.
    //
    // Taking the whole port and calling it as a member removes the possibility. Found by a test that
    // asserted the PayPal call count was 1 and got 0.
    const call = opts.paypal.verifyWebhookSignature(opts.headers, opts.webhookId, opts.rawBody)
    const settled = await Promise.race([
      call.then(
        (r): VerificationOutcome => toOutcome(r, retryAfterSeconds),
        (cause: unknown): VerificationOutcome => ({
          outcome: 'UNAVAILABLE',
          status: null,
          retryAfterSeconds,
          error: asCsError(cause, 'verify-webhook-signature threw'),
        }),
      ),
      timeout,
    ])
    if (timedOut && settled.outcome !== 'UNAVAILABLE') {
      // The call lost the race; ignore whatever it produced. Nothing was awaited after this point.
      return {
        outcome: 'UNAVAILABLE',
        status: null,
        retryAfterSeconds,
        error: csError(
          'PP_UNAVAILABLE',
          'verify-webhook-signature lost the timeout race',
          undefined,
          {
            retryable: true,
          },
        ),
      }
    }
    return settled
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function toOutcome(
  result: Result<WebhookVerificationStatus, CsError>,
  retryAfterSeconds: number,
): VerificationOutcome {
  if (!result.ok) {
    return {
      outcome: 'UNAVAILABLE',
      status: null,
      retryAfterSeconds,
      error: result.error,
    }
  }
  if (result.value === 'SUCCESS') return { outcome: 'VERIFIED', status: 'SUCCESS' }
  return {
    outcome: 'FORGED',
    status: 'FAILURE',
    error: csError(
      'WH_SIGNATURE_INVALID',
      'PayPal reported verification_status FAILURE, so this delivery is not from PayPal',
      { verification_status: result.value },
      { retryable: false },
    ),
  }
}

function asCsError(cause: unknown, message: string): CsError {
  if (typeof cause === 'object' && cause !== null && 'code' in cause && 'message' in cause) {
    return cause as CsError
  }
  return csError('PP_UNAVAILABLE', message, { cause: String(cause) }, { retryable: true })
}

/* ------------------------------------------------------------------------------------------ */
/* EC-WH-4: the audit entry and the alert threshold                                               */
/* ------------------------------------------------------------------------------------------ */

/** The chain a webhook rejection is appended to. One chain, so `verifyChain` can prove the sequence. */
export const WEBHOOK_AUDIT_CHAIN = 'webhooks'

/** EC-WH-4: "alert after 10/h". */
export const FORGED_ALERT_THRESHOLD_PER_HOUR = 10
const ONE_HOUR_MS = 3_600_000

/**
 * Append the audit entry §8.12 requires for a rejected delivery, and report whether to alert.
 *
 * The details bag carries the transmission id, the cert URL **host** and the auth algorithm — enough to
 * investigate — and deliberately **not** the raw body, the signature, or the transmission time.
 * `webhook_events.raw` already holds the body; copying it into a second table would be a second copy to
 * retain and a second place for a PayPal id to leak from.
 *
 * The alert is computed **after** the append, from the row count rather than from a counter in this
 * process: the count is the durable, restart-surviving number, and it is what survives two worker
 * instances each seeing half the forged deliveries.
 *
 * @param `countFailedSince` `WebhookStore.events.countFailedSince`. Required rather than optional — a
 *   version that silently skipped the count would report `alert: false` forever, which is the failure mode
 *   that leaves a forgery campaign unannounced.
 */
export async function auditForgedDelivery(input: {
  readonly audit: WebhookAudit
  readonly countFailedSince: (since: Date) => Promise<Result<number, CsError>>
  readonly paypalEventId: string | null
  readonly eventType: string
  readonly resourceId: string
  readonly headers: Record<string, string>
  readonly reason: string
  readonly at: Date
  readonly threshold?: number
}): Promise<Result<{ alert: boolean; failedInHour: number }, CsError>> {
  const appended = await input.audit.append({
    chainId: WEBHOOK_AUDIT_CHAIN,
    actor: 'paypal-webhook',
    action: 'webhook.signature_rejected',
    subject: input.paypalEventId ?? input.resourceId,
    at: input.at,
    details: {
      paypalEventId: input.paypalEventId,
      eventType: input.eventType,
      resourceId: input.resourceId,
      reason: input.reason,
      transmissionId: input.headers['paypal-transmission-id'] ?? null,
      authAlgo: input.headers['paypal-auth-algo'] ?? null,
      // The host only: the full URL is a certificate path and a fingerprint, not evidence.
      certHost: certHost(input.headers['paypal-cert-url']),
    },
  })
  if (!appended.ok) return appended

  const since = new Date(input.at.getTime() - ONE_HOUR_MS)
  const counted = await input.countFailedSince(since)
  if (!counted.ok) return counted
  const failedInHour = counted.value
  const alert = shouldAlertForForged({
    failedInHour,
    failedBeforeThisOne: Math.max(0, failedInHour - 1),
    threshold: input.threshold,
  })
  return ok({ alert, failedInHour })
}

/**
 * Should this rejection page someone?
 *
 * Pure, and separated from the write on purpose: the *decision* ("this is the tenth forged delivery in the
 * last hour") is worth testing without a database, and it is the part that is easy to get wrong in the
 * permissive direction — an alert on every rejection turns a scanner into a pager, and an alert on none of
 * them turns a forgery campaign into a log line.
 */
export function shouldAlertForForged(input: {
  readonly failedInHour: number
  readonly threshold?: number
  /** How many failed rows existed before this delivery was counted. */
  readonly failedBeforeThisOne?: number
}): boolean {
  const threshold = input.threshold ?? FORGED_ALERT_THRESHOLD_PER_HOUR
  const before = input.failedBeforeThisOne ?? Math.max(0, input.failedInHour - 1)
  return before < threshold && input.failedInHour >= threshold
}

function certHost(certUrl: string | undefined): string | null {
  if (certUrl === undefined || certUrl.trim() === '') return null
  try {
    return new URL(certUrl).host
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Storing a delivery so it can be verified again (EC-WH-7's retry)                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * What `webhook_events.raw` holds, and why it is not just PayPal's body.
 *
 * **EC-WH-7 says "retry verification with backoff", and that is not possible from a `jsonb` body alone.**
 * Two separate facts make it impossible:
 *
 *  1. `verify-webhook-signature` needs the five `PAYPAL-TRANSMISSION-*` headers, and **§7.2 has no column
 *     for them**. `webhook_events` carries `raw`, `event_type`, `resource_type`, `resource_id`,
 *     `create_time` and the processing columns; the transmission id, cert URL, signature and auth
 *     algorithm are simply not among them.
 *  2. It re-hashes the **exact bytes** PayPal sent. `JSON.parse` → `JSON.stringify` reorders keys, rewrites
 *     `\uXXXX` escapes and turns `1.0` into `1`, so a re-serialised body hashes differently and verification
 *     would fail on a perfectly genuine redelivery. Re-deriving the original bytes from parsed JSON is not
 *     a hard problem, it is an **impossible** one.
 *
 * So the delivery is stored as the body **verbatim** plus the base64 of the exact bytes and the headers.
 * PayPal's body is still in `raw`, unmodified and readable, so the case file and the evidence packet are
 * unaffected — but a caller reading `raw` must go through {@link storedEventBody} rather than assuming it
 * *is* the body.
 *
 * This is a contract gap, not a design choice, and it is reported in `README.md` → "Contract issues": the
 * right fix is a `transmission_headers jsonb` and a `raw_body bytea` column on `webhook_events`, which
 * belongs to WP-02.
 *
 * The fallback if that gap is ever closed differently: redelivery. PayPal retries an event up to 25 times
 * over three days, and a redelivery arrives with its headers attached, which is why `dedupe.ts` re-verifies a
 * `PENDING` row on redelivery — that path needs nothing stored at all, and it is what makes a verify outage
 * recoverable even if these two fields are ever lost.
 */
export interface StoredDelivery {
  /** PayPal's body, verbatim and unmodified. */
  readonly event: unknown
  readonly delivery: {
    /** base64 of the exact request bytes. */
    readonly rawBodyBase64: string
    /** The five signature headers, lower-cased. */
    readonly headers: Record<string, string>
  }
}

export function encodeStoredRaw(
  body: unknown,
  rawBody: Uint8Array,
  headers: Record<string, string>,
): StoredDelivery {
  return {
    event: body,
    delivery: { rawBodyBase64: Buffer.from(rawBody).toString('base64'), headers },
  }
}

/** The `raw` column, if it carries a stored delivery. `null` for a row written before this shape. */
export function decodeStoredRaw(raw: unknown): StoredDelivery | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const delivery = obj['delivery']
  if (typeof delivery !== 'object' || delivery === null) return null
  const d = delivery as Record<string, unknown>
  const b64 = d['rawBodyBase64']
  if (typeof b64 !== 'string') return null
  const headers = d['headers']
  return {
    event: obj['event'] ?? null,
    delivery: {
      rawBodyBase64: b64,
      headers:
        typeof headers === 'object' && headers !== null ? (headers as Record<string, string>) : {},
    },
  }
}

/** PayPal's body out of a stored `raw`, whichever shape the row was written in. */
export function storedEventBody(raw: unknown): unknown {
  const stored = decodeStoredRaw(raw)
  if (stored !== null) return stored.event
  return raw
}

/** The exact request bytes, or `null` when they were never stored. */
export function storedRawBytes(raw: unknown): Uint8Array | null {
  const stored = decodeStoredRaw(raw)
  if (stored === null) return null
  return new Uint8Array(Buffer.from(stored.delivery.rawBodyBase64, 'base64'))
}

/** The five signature headers, or `null` when they were never stored. */
export function storedHeaders(raw: unknown): Record<string, string> | null {
  const stored = decodeStoredRaw(raw)
  return stored === null ? null : stored.delivery.headers
}
