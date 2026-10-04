/**
 * Ingest — spec **§8.12** steps 1–5, **§12.3 EC-WH-2/4/6**, **EC-PP-5**, [V14].
 *
 * ## The exported surface
 *
 * ```ts
 * handleWebhook(rawBody: Uint8Array, headers: HeaderBag, deps: WebhookDeps): Promise<WebhookAck>
 * ```
 *
 * Framework-agnostic on purpose. WP-17 owns `app/api/webhooks/paypal/route.ts`; that file reads the raw
 * bytes off the `Request` and calls this. Nothing here imports Next, knows about a `Request`, or returns a
 * `Response` — `WebhookAck` is a status code and a reason, and turning it into HTTP is the adapter's job.
 *
 * ## The order is store → verify → enqueue, and that is a deviation from §8.12's literal numbering
 *
 * §8.12 lists verification as step 2 and the insert as step 3. This module stores first. Two spec rows
 * require it and neither can be satisfied any other way:
 *
 * - **EC-PP-5** — "Latency > 2 s … Respond 200 **after storing**; verify async". A handler that verifies
 *   before storing has nothing to respond *after*, so when verification is slow it either blows §8.12
 *   step 5's 2-second budget or it violates EC-PP-5.
 * - **EC-WH-7** — "Store the event unverified, don't act; retry verification with backoff". Storing
 *   something unverified presupposes a store that runs before verification.
 *
 * The two are not in conflict with §8.12's intent — the numbered steps are a checklist for *one* delivery,
 * and both of these rows are about the delivery that cannot be completed. The ordering that satisfies all
 * three is store → verify → enqueue. Recorded in `README.md` → "Deviations".
 *
 * ## What the ack promises, and what it does not
 *
 * §8.12 step 5: **200 within 2 s even if processing fails**, because processing is asynchronous. So a 200
 * says only "this delivery is durably stored and, if it verified, queued". It is never a claim that the
 * capture is complete, the refund applied or the dispute filed — those happen in `wh.process`, and the
 * reconciler exists because that can fail.
 *
 * The two 400s are both **terminal** answers about the *delivery*, not about the payment: a forged
 * signature, and a body we cannot read an id out of. Both are audited. Neither is stored as `VERIFIED`,
 * because neither is a PayPal delivery at all.
 */
import { csError, newId, type CsError, type Result, type WebhookEventId } from '@countersign/core'
import type { JsonValue, NewWebhookEvent } from '@countersign/db'

import { dedupeDecision, processJobFor } from './dedupe'
import {
  auditForgedDelivery,
  encodeStoredRaw,
  readSignatureHeaders,
  verifyDelivery,
  type HeaderBag,
} from './signature'
import { JOB_PROCESS, type WebhookAck, type WebhookDeps } from './types'

/** §8.12 step 5's budget. Asserted against by AT-M12.6. */
export const ACK_BUDGET_MS = 2_000

/**
 * The three fields a webhook event body must carry for us to be able to store it at all.
 *
 * `id` is the **dedupe key** (§7.2's unique `paypal_event_id`), so its absence is fatal to storing — and
 * fatal in a specific way: without it we have no way to recognise a redelivery, so storing the event would
 * be worse than not storing it. Hence `REJECTED_MALFORMED` with a 400 rather than a 200 that pretends.
 *
 * `resource.id` is **not** required. EC-WH-6 and AT-M12.5 are exactly "an event whose resource we cannot
 * find", and a simulator event or another app's event can legitimately omit it; `resource_id` is
 * `notNull` in the schema, so it is stored as the empty string and processing finds nothing and marks the
 * row ignored. That is the honest handling, and it is covered by its own test.
 */
export interface ParsedWebhookEvent {
  readonly id: string
  readonly eventType: string
  readonly resourceType: string
  readonly resourceId: string
  readonly createTime: Date
  /** The parsed object, stored in `raw` for the case file. Never read for state. */
  readonly body: unknown
}

export type ParseOutcome =
  | { readonly ok: true; readonly value: ParsedWebhookEvent }
  | { readonly ok: false; readonly reason: string }

/**
 * Pull the four stored columns out of a body. Pure.
 *
 * `create_time` is `notNull` and PayPal always sends it, but a body without one must not become a 500: the
 * fallback is the injected clock, and the value is only ever used for retention and for the "is this
 * stale?" pre-check in `jobs.ts`, never as authority over PayPal's own `update_time`.
 */
export function parseWebhookEvent(body: unknown, now: Date): ParseOutcome {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'the body is not a JSON object' }
  }
  const obj = body as Record<string, unknown>
  const id = str(obj['id'])
  if (id === null) return { ok: false, reason: 'the body has no "id"' }
  const eventType = str(obj['event_type'])
  if (eventType === null) return { ok: false, reason: 'the body has no "event_type"' }

  const resource = obj['resource']
  const resourceObj =
    typeof resource === 'object' && resource !== null ? (resource as Record<string, unknown>) : {}
  const resourceType = str(resourceObj['type']) ?? 'UNKNOWN'
  const resourceId = str(resourceObj['id']) ?? ''

  const createTimeMs = Date.parse(str(obj['create_time']) ?? '')
  const createTime = Number.isNaN(createTimeMs) ? now : new Date(createTimeMs)

  return { ok: true, value: { id, eventType, resourceType, resourceId, createTime, body } }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/**
 * `POST /api/webhooks/paypal`.
 *
 * Five steps, in the order §8.12 requires *and* in the order EC-PP-5/EC-WH-7 require:
 *
 * 1. read the raw bytes (they arrive as bytes; nothing re-serialises them),
 * 2. parse only enough to store it,
 * 3. `INSERT … ON CONFLICT DO NOTHING` — **the delivery is now durable**,
 * 4. verify, and act on the answer,
 * 5. acknowledge: 200 for anything stored, 400 for a forged or unreadable body.
 *
 * Never throws. A handler that throws turns PayPal's retry budget into our outage, and the failure modes
 * here (a 503 from verify, a conflict on the insert, a queue that will not take a job) are all outcomes, not
 * exceptions.
 */
export async function handleWebhook(
  rawBody: Uint8Array,
  headers: HeaderBag,
  deps: WebhookDeps,
): Promise<WebhookAck> {
  const at = new Date(deps.clock.nowMs())
  const parsed = parseWebhookEvent(decode(rawBody), at)
  if (!parsed.ok) {
    // Audited even though nothing is stored. A 400 with no audit entry is an event that vanished: the
    // endpoint is being probed with garbage and the only evidence is whatever access log survives. The
    // entry carries no `paypalEventId` because we could not read one — which is itself the useful fact.
    const audit = await auditUnreadable(deps, parsed.reason, at)
    return finishAudit(
      deps,
      ack(400, 'REJECTED_MALFORMED', null, malformed(parsed.reason), at),
      audit,
    )
  }
  const event = parsed.value

  const sig = readSignatureHeaders(headers)
  if (!sig.ok) {
    // Not stored: §8.12 step 2 is verification, and without the five headers there is nothing to verify.
    // Recorded in the audit trail so "someone posted at us with no signature" is visible without becoming
    // a `FAILED` row, which EC-WH-4 reserves for a body PayPal actually signed and we rejected.
    const audit = await auditForgedDelivery({
      audit: deps.audit,
      countFailedSince: (since) => deps.store.events.countFailedSince(since),
      paypalEventId: event.id,
      eventType: event.eventType,
      resourceId: event.resourceId,
      headers: {},
      reason: `missing signature headers: ${sig.missing.join(', ')}`,
      at,
    })
    return finishAudit(
      deps,
      ack(
        400,
        'REJECTED_SIGNATURE',
        null,
        csError(
          'WH_SIGNATURE_INVALID',
          `Webhook is missing ${sig.missing.length} of the 5 signature headers`,
          { missing: [...sig.missing], paypalEventId: event.id },
          { retryable: false },
        ),
        at,
      ),
      audit,
    )
  }

  // ---- step 3: store first. Everything after this point can fail without losing the delivery. --------
  const input: NewWebhookEvent = {
    id: newId('whe') as WebhookEventId,
    paypal_event_id: event.id,
    event_type: event.eventType,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    create_time: event.createTime,
    verified: 'PENDING',
    verified_at: null,
    // `raw` is the **delivery**, not just PayPal's body: the exact request bytes and the five signature
    // headers are stored alongside the verbatim body so EC-WH-7's "retry verification with backoff" is
    // actually possible. See `signature.ts` → `StoredDelivery` for why §7.2's columns cannot do this.
    raw: toJsonValue(encodeStoredRaw(event.body, rawBody, headerRecord(headers))),
    received_at: at,
    processed_at: null,
    attempts: 0,
    error: null,
  }
  const stored = await deps.store.events.ingestEvent(input)
  if (!stored.ok) {
    // The one case where we cannot even store it. 200 anyway: the delivery was well-formed and PayPal is
    // not at fault, and a 5xx would earn 25 retries of a request we cannot durably accept.
    deps.logger?.error('webhook ingest failed', {
      paypal_event_id: event.id,
      code: stored.error.code,
    })
    return ack(
      200,
      'STORED_UNVERIFIED',
      event.id,
      csError(
        'CS_INTERNAL',
        'The webhook could not be stored; the reconciler will pick the state up',
        { paypalEventId: event.id },
      ),
      at,
    )
  }

  const decision = dedupeDecision(stored.value.row, !stored.value.duplicate)

  // ---- step 4: verify, and let the answer decide what happens next. -------------------------------
  if (!decision.verify) {
    // Reachable only on the conflict path: a redelivery of an event we have already decided.
    //
    //  - `VERIFIED` acks 200 as a duplicate. Re-verifying would spend a call to learn what we know.
    //  - `FAILED` acks **400 again**, not 200. Answering 200 to a delivery we already called forged would
    //   stop PayPal retrying it — which is the right outcome for the forgery, but it would also mean our
    //   own logs stop distinguishing the first rejection from the twenty-fourth, and EC-WH-4's audit trail
    //   is precisely a trail of how many times somebody sent this.
    if (decision.row.verified === 'FAILED') {
      return ack(
        400,
        'REJECTED_SIGNATURE',
        decision.row.paypal_event_id,
        csError(
          'WH_SIGNATURE_INVALID',
          'This delivery was already rejected as forged',
          { paypalEventId: decision.row.paypal_event_id },
          { retryable: false },
        ),
        at,
      )
    }
    return ack(200, 'DUPLICATE', decision.row.paypal_event_id, null, at)
  }

  const verified = await verifyDelivery({
    rawBody,
    headers: sig.value,
    webhookId: deps.webhookId,
    clock: deps.clock,
    paypal: deps.paypal,
    timeoutMs: deps.verifyTimeoutMs,
    attempt: decision.row.attempts,
  })

  if (verified.outcome === 'FORGED') {
    await deps.store.events.markVerifiedState(
      decision.row.id,
      'FAILED',
      'verify-webhook-signature returned FAILURE',
      at,
    )
    // Never processed, not even enqueued: §8.12's "400 plus an audit entry; no processing".
    await deps.store.events.markProcessed(
      decision.row.id,
      'ignored: signature verification failed',
      at,
    )
    deps.logger?.warn('webhook signature rejected', {
      paypal_event_id: decision.row.paypal_event_id,
      event_type: decision.row.event_type,
    })
    const audit = await auditForgedDelivery({
      audit: deps.audit,
      countFailedSince: (since) => deps.store.events.countFailedSince(since),
      paypalEventId: decision.row.paypal_event_id,
      eventType: decision.row.event_type,
      resourceId: decision.row.resource_id,
      headers: headerRecord(headers),
      reason: verified.status === 'FAILURE' ? 'verification_status FAILURE' : 'verification failed',
      at,
    })
    return finishAudit(
      deps,
      ack(400, 'REJECTED_SIGNATURE', decision.row.paypal_event_id, verified.error, at),
      audit,
    )
  }

  if (verified.outcome === 'UNAVAILABLE') {
    // EC-WH-7. The row stays `PENDING`, nothing is enqueued, and the ack is 200: we are not telling
    // PayPal the delivery is bad, we are telling it we have it.
    await deps.store.events.markVerifiedState(
      decision.row.id,
      'PENDING',
      `verify unavailable: ${verified.error.message}`,
      at,
    )
    deps.logger?.warn('webhook signature verification deferred', {
      paypal_event_id: decision.row.paypal_event_id,
      code: verified.error.code,
      retry_after_seconds: verified.retryAfterSeconds,
    })
    return ack(200, 'STORED_UNVERIFIED', decision.row.paypal_event_id, null, at)
  }

  // SUCCESS. Mark verified first, then enqueue: a job that runs before the row says `VERIFIED` would find
  // a `PENDING` row and decline to act, which is a lost cycle for no benefit.
  const marked = await deps.store.events.markVerifiedState(decision.row.id, 'VERIFIED', null, at)
  if (!marked.ok) {
    deps.logger?.error('webhook verified but the row could not be marked', {
      webhook_event_id: decision.row.id,
      code: marked.error.code,
    })
    return ack(200, 'STORED_UNVERIFIED', decision.row.paypal_event_id, null, at)
  }

  if (decision.enqueue) {
    const job = processJobFor(marked.value)
    const queued = await deps.queue.send(
      JOB_PROCESS,
      {
        webhookEventId: job.webhookEventId,
        resourceId: job.resourceId,
        resourceType: job.resourceType,
        eventType: job.eventType,
      },
      {
        // §8.12 step 4: singletonKey = resource_id, so one capture is never processed twice at once.
        singletonKey: job.singletonKey,
        // Idempotent by construction (AGENTS.md rule 6), so a generous retry budget is free.
        retryLimit: 5,
        retryBackoff: true,
        retryDelaySeconds: 5,
      },
    )
    if (!queued.ok) {
      // §8.12 step 5: still 200. The row is stored and `processed_at IS NULL`, so `wh.verify` and the
      // reconciler's unprocessed sweep both find it — this is the crash-window EC-WH-1 and EC-WH-5 cover.
      deps.logger?.error('webhook verified but could not be enqueued', {
        webhook_event_id: decision.row.id,
        code: queued.error.code,
      })
    }
  }

  // The outcome reports whether **this delivery** was the first one, not whether the row is now verified.
  // A `PENDING` redelivery that verifies successfully is still a duplicate *delivery* — it inserted nothing
  // — and reporting it as `ACCEPTED` would tell an operator a new event had arrived when it had not. What
  // changed is the row's `verified`, which is what the caller can read from `deps.store` or the ack's id.
  return ack(
    200,
    decision.inserted ? 'ACCEPTED' : 'DUPLICATE',
    decision.row.paypal_event_id,
    null,
    at,
  )
}

/**
 * The audit entry for a body we could not read.
 *
 * Counted against EC-WH-4's forged rows rather than adding a second counter, because "somebody is posting
 * unreadable bodies at us" and "somebody is forging signatures at us" are the same concern — a hostile sender
 * — and one alert covering both is the behaviour EC-WH-4 asks for. A body with no id cannot become a
 * `webhook_events` row, so this count will never move the threshold on its own; the entry exists so the
 * attempt is attributable in the audit chain.
 */
async function auditUnreadable(
  deps: WebhookDeps,
  reason: string,
  at: Date,
): Promise<Result<{ alert: boolean; failedInHour: number }, CsError>> {
  return auditForgedDelivery({
    audit: deps.audit,
    countFailedSince: (since) => deps.store.events.countFailedSince(since),
    paypalEventId: null,
    eventType: 'UNKNOWN',
    resourceId: '',
    headers: {},
    reason: `unreadable body: ${reason}`,
    at,
  })
}

function malformed(reason: string): CsError {
  return csError(
    'CS_VALIDATION',
    `The webhook body could not be read: ${reason}`,
    { reason },
    { retryable: false },
  )
}

function ack(
  status: number,
  outcome: WebhookAck['outcome'],
  paypalEventId: string | null,
  error: CsError | null,
  at: Date,
): WebhookAck {
  return { status, outcome, paypalEventId, error, atMs: at.getTime() }
}

function finishAudit(
  deps: WebhookDeps,
  acknowledgement: WebhookAck,
  audit: Result<{ alert: boolean; failedInHour: number }, CsError>,
): WebhookAck {
  if (!audit.ok) {
    // The 400 stands even if the audit write failed: the delivery was still forged, and losing the audit
    // row is a problem to report rather than a reason to accept it.
    deps.logger?.error('forged webhook audit append failed', { code: audit.error.code })
    return acknowledgement
  }
  if (audit.value.alert) {
    deps.logger?.error('forged webhook alert threshold crossed', {
      failed_in_hour: audit.value.failedInHour,
    })
  }
  return acknowledgement
}

function headerRecord(headers: HeaderBag): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v
    else if (Array.isArray(v) && typeof v[0] === 'string') out[k.toLowerCase()] = v[0]
  }
  return out
}

/** `TextDecoder` over the raw bytes, lenient about a BOM, never throwing on malformed UTF-8. */
function decode(raw: Uint8Array): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(raw)
  } catch {
    return null
  }
  const trimmed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

/**
 * A PayPal body as a `jsonb` value.
 *
 * `JSON.parse(JSON.stringify(x))` is the honest conversion for a body that arrived as JSON, and it is also
 * the step that would fail loudly if PayPal ever sent something a `jsonb` column cannot hold — `undefined`
 * and functions become `null`, which is the failure we want to see here rather than at the driver.
 *
 * Defined here rather than imported because `@countersign/orders` owns the other copy and this package does
 * not depend on it (its three dependencies are `core`, `db` and `paypal`, and adding a fourth for a
 * four-line function would put the orchestrator in the webhook trust path).
 */
function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
