/**
 * Deterministic `PayPal-Request-Id` formats — spec §8.6 "Request IDs", [B14].
 *
 * Every side-effecting call carries a request id that is a **pure function of our own ids**. Two
 * properties follow, and both are the whole point:
 *
 *  1. A retry of a job that timed out after PayPal already executed it re-sends the *same* id, so
 *     PayPal returns the earlier result instead of creating a second order, capture or refund
 *     (spec §8.6 "Retries", EC-IDEM-2).
 *  2. Two different payments never collide, because the id is derived from the row ids rather than
 *     from a clock or a random value. That is why `Math.random()` appears nowhere in this file.
 *
 * The four formats are fixed by the spec and must not drift:
 *
 * ```
 * cs:{attemptId}:create
 * cs:{authId}:cap:{shipmentId}
 * cs:{captureId}:ref:{refundId}
 * cs:{disputeId}:{action}:{packetVersion}
 * ```
 *
 * ## On the length limit — read this before "fixing" the constant
 *
 * **PayPal's own two sources contradict each other** (report §32/#21), and we record the conflict
 * rather than picking one silently:
 *
 * | Source | What it says |
 * |---|---|
 * | `SPEC-P` / `SPEC-V` `components.parameters.paypal_request_id` | `minLength: 1`, **`maxLength: 10000`**, `pattern: ^.*$` |
 * | https://developer.paypal.com/api/rest/reference/idempotency, "Usage notes" | "PayPal recommends that you use the **UUID standard**… because it meets the **38 single-byte character limit**" |
 *
 * These cannot both be the enforced limit. **Which one is real is NOT DOCUMENTED.** The safe
 * engineering position is the smaller one: 38 is the only number PayPal states as a *limit* rather
 * than as a schema maximum, and a schema maximum is not a promise.
 *
 * **Our worst case is 55 characters** — `cs:{17-char PayPal auth id}:cap:{shp_ + 26 ULID}`, measured by
 * {@link observedRequestIdLengths} and asserted in `test/idempotency.test.ts`. If the 38-character
 * figure is enforced anywhere, **`captureRequestId` is the format that breaks first**, because it is
 * the only one whose slot is PayPal's own 17-character id on both sides. The two others that reach
 * 55 do so with our own 30-character ids, which are compressible.
 *
 * {@link REQUEST_ID_MAX_CHARS} therefore stays at 255: it is *our own* budget, not a claim about
 * PayPal, and lowering it to 38 today would reject ids we know we emit. `IDEMPOTENCY.md` records the
 * conflict, and the C-probe settles it.
 */
import { csError, ok, err } from '@countersign/core'
import type { AttemptId, CsError, DisputeId, RefundRowId, Result, ShipmentId } from '@countersign/core'

/**
 * Our local budget for a `PayPal-Request-Id` value, in characters.
 *
 * **This is our number, not PayPal's.** It is an HTTP header-value ceiling we impose so the id can
 * never be the thing that breaks a request; deliberately permissive, because a too-small budget
 * rejects legitimate ids while a too-large one is caught by the HTTP layer.
 *
 * PayPal's two documented figures conflict — the OpenAPI declares `maxLength: 10000` while the
 * idempotency prose recommends a UUID "because it meets the 38 single-byte character limit". The
 * module comment above has the full statement. **Our worst case is 55 chars**, so this budget does not
 * currently protect us against the 38 reading; `captureRequestId` (`cs:{authId}:cap:{shipmentId}`) is
 * the format that would fail first. The sandbox probe (C-probe, `IDEMPOTENCY.md`) replaces this
 * comment with a measurement.
 */
export const REQUEST_ID_MAX_CHARS = 255

/**
 * PayPal's prose figure, kept as a named constant so the conflict is a value in the code and not only
 * a paragraph in a comment — and so the sandbox probe has something to measure against.
 *
 * NOT enforced. `cs:{authId}:cap:{shipmentId}` is 55 characters in our worst case, so enforcing this
 * today would reject ids we genuinely emit on every partial capture (EC-SPLIT-1). It is recorded so
 * that if the probe shows 38 is real, the fix is one comparison in
 * {@link validateRequestId} rather than an archaeology exercise.
 */
export const PAYPAL_DOCUMENTED_REQUEST_ID_MAX_CHARS = 38

/**
 * The OpenAPI figure for the same header (`SPEC-P` / `SPEC-V`
 * `components.parameters.paypal_request_id`, `maxLength: 10000`) — which cannot be reconciled with
 * {@link PAYPAL_DOCUMENTED_REQUEST_ID_MAX_CHARS}. Recorded, not enforced; see the module comment.
 */
export const PAYPAL_OPENAPI_REQUEST_ID_MAX_CHARS = 10_000

/**
 * Every character a `PayPal-Request-Id` may contain here.
 *
 * Header-safe and deliberately narrow: alphanumerics plus `:` (our separator), `_` (in our id
 * prefixes) and `-`. No spaces, no CR/LF (header injection), no non-ASCII, no `,` or `;`. A value
 * containing anything else is rejected locally rather than handed to `fetch`.
 */
const SAFE_CHARS = /^[A-Za-z0-9:_-]+$/

/** Every ULID is 26 Crockford chars; our ids are `<3-char prefix>_<26 chars>`. */
const OUR_ID = /^[a-z][a-z0-9]{1,2}_[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * The dispute-action slot of `cs:{disputeId}:{action}:{packetVersion}`.
 *
 * One token per §8.6 client method that touches a dispute, plus `file`, which is the slot the spec
 * names explicitly for the evidence upload (§8.15 filing guards: `cs:{disputeId}:file:{version}`).
 * These strings are wire-visible, so they are a closed set.
 */
export const DISPUTE_ACTIONS = [
  'file', // provide-evidence (§8.15 "Idempotency key cs:{disputeId}:file:{version}")
  'claim', // accept-claim
  'offer', // make-offer
  'msg', // send-message
  'return', // acknowledge-return-item
  'support', // provide-supporting-info
  'appeal', // appeal
  'escalate', // escalate
] as const

export type DisputeActionToken = (typeof DISPUTE_ACTIONS)[number]

/** `cs:` — the namespace prefix on every id we generate, so PayPal-side logs are greppable. */
export const REQUEST_ID_PREFIX = 'cs:'

/** `cs:{attemptId}:create` — one order create per checkout attempt (EC-IDEM-1, EC-IDEM-2). */
export function orderCreateRequestId(attemptId: AttemptId): string {
  return `${REQUEST_ID_PREFIX}${attemptId}:create`
}

/**
 * `cs:{authId}:cap:{shipmentId}` — one capture per shipment against an existing authorization
 * (spec D17 `AUTHORIZE` intent, EC-SPLIT-1).
 *
 * `authId` is PayPal's own authorization id (e.g. `8AB12345AB6789123`), not one of ours, because
 * the capture must be deduplicated against the *PayPal* authorization it targets.
 *
 * **This is the format that breaks first if PayPal's 38-character limit is real** (report §32/#21):
 * 55 characters in our worst case, and the 17-character `authId` slot is not compressible the way our
 * own ULID slots are. Do not shorten it by dropping the `cap:` marker or the `cs:` prefix — the prefix
 * is what makes a PayPal-side log greppable, and the marker is what stops two captures against the
 * same authorization from colliding.
 */
export function captureRequestId(authId: string, shipmentId: ShipmentId): string {
  return `${REQUEST_ID_PREFIX}${authId}:cap:${shipmentId}`
}

/** `cs:{captureId}:ref:{refundId}` — one refund per refund row (EC-REF-* / EC-IDEM-5). */
export function refundRequestId(captureId: string, refundId: RefundRowId): string {
  return `${REQUEST_ID_PREFIX}${captureId}:ref:${refundId}`
}

/**
 * `cs:{disputeId}:{action}:{packetVersion}` — §8.15, §8.16.
 *
 * `packetVersion` is the evidence-packet version, not a timestamp: re-filing version 2 must not be
 * deduplicated against version 1, and re-sending version 2 after a timeout must be.
 */
export function disputeActionRequestId(
  disputeId: DisputeId,
  action: DisputeActionToken,
  packetVersion: number | string,
): string {
  // Runtime guard as well as the type: `scripts/*.ts` are JavaScript-shaped callers too, and a typo'd
  // action must not become a wire-visible request id that silently deduplicates against another action.
  if (!DISPUTE_ACTIONS.includes(action)) {
    throw csError('CS_VALIDATION', `Unknown dispute action token: ${JSON.stringify(action)}`, {
      action: String(action),
      allowed: [...DISPUTE_ACTIONS],
    })
  }
  return `${REQUEST_ID_PREFIX}${disputeId}:${action}:${normaliseVersion(packetVersion)}`
}

function normaliseVersion(version: number | string): string {
  if (typeof version === 'number') {
    if (!Number.isInteger(version) || version < 0 || version > 999_999_999) {
      throw csError('CS_VALIDATION', `packetVersion must be a non-negative integer, got ${String(version)}`, {
        packetVersion: String(version),
      })
    }
    return String(version)
  }
  const v = version.trim()
  if (v === '' || !SAFE_CHARS.test(v)) {
    throw csError('CS_VALIDATION', `packetVersion is not a safe id token: ${JSON.stringify(version)}`, {
      packetVersion: v,
    })
  }
  return v
}

export interface RequestIdLengthReport {
  /** The generated id. */
  readonly value: string
  /** Its length in characters. */
  readonly length: number
  /** Whether it is within {@link REQUEST_ID_MAX_CHARS}. */
  readonly withinBudget: boolean
}

/**
 * Validate a request id without throwing.
 *
 * Checks, in order: it is a string, it is non-empty, every character is header-safe, and it is
 * within our length budget. Returns `Result` rather than throwing because it sits on the boundary
 * between our id space and an HTTP header (spec §8.0 rule 3).
 */
export function validateRequestId(value: unknown): Result<string, CsError> {
  if (typeof value !== 'string') {
    return err(
      csError('CS_VALIDATION', `PayPal-Request-Id must be a string, got ${typeof value}`, {
        received: typeof value,
      }),
    )
  }
  if (value === '') {
    return err(csError('CS_VALIDATION', 'PayPal-Request-Id must not be empty'))
  }
  const bad = [...value].find((ch) => !SAFE_CHARS.test(ch))
  if (bad !== undefined) {
    return err(
      csError('CS_VALIDATION', `PayPal-Request-Id contains a character that is not header-safe: ${JSON.stringify(bad)}`, {
        character: bad,
        value,
      }),
    )
  }
  if (value.length > REQUEST_ID_MAX_CHARS) {
    return err(
      csError(
        'CS_VALIDATION',
        `PayPal-Request-Id is ${value.length} characters, over our ${REQUEST_ID_MAX_CHARS}-character budget ` +
          '(the limit PayPal actually enforces is UNVERIFIED — see IDEMPOTENCY.md, spec U5; PayPal documents ' +
          'both maxLength 10000 in the OpenAPI and a "38 single-byte character limit" in prose)',
        { length: value.length, budget: REQUEST_ID_MAX_CHARS },
      ),
    )
  }
  return ok(value)
}

/**
 * Validate and measure in one step. Used by the tests that pin the observed maximum length, which is
 * the evidence `IDEMPOTENCY.md` needs before the sandbox probe exists.
 */
export function measureRequestId(value: unknown): Result<RequestIdLengthReport, CsError> {
  const valid = validateRequestId(value)
  if (!valid.ok) return valid
  const length = valid.value.length
  return ok({ value: valid.value, length, withinBudget: length <= REQUEST_ID_MAX_CHARS })
}

/**
 * Build every format from one representative set of ids and report the longest.
 *
 * This is the measurement the sandbox probe will place next to PayPal's two conflicting figures. Until
 * then it is the honest answer to "how long can these get?": a number computed from the actual formats,
 * not an assumed maximum.
 *
 * The number to compare against PayPal's prose is {@link PAYPAL_DOCUMENTED_REQUEST_ID_MAX_CHARS} (38).
 * `cs:{authId}:cap:{shipmentId}` and `cs:{captureId}:ref:{refundId}` are 55, so both exceed it today —
 * which is exactly why the C-probe matters and why `test/idempotency.test.ts` pins these numbers
 * rather than assuming them.
 */
export function observedRequestIdLengths(): Record<string, RequestIdLengthReport> {
  // Worst realistic case: every ULID slot at its full 26 chars, a 17-char PayPal authorization id,
  // and the longest action token.
  const attemptId = `att_${'0'.repeat(26)}` as AttemptId
  const shipmentId = `shp_${'0'.repeat(26)}` as ShipmentId
  const refundId = `ref_${'0'.repeat(26)}` as RefundRowId
  const disputeId = `dsp_${'0'.repeat(26)}` as DisputeId
  const paypalAuthId = 'ABCDEFGHIJ1234567'

  const cases: Record<string, unknown> = {
    'cs:{attemptId}:create': orderCreateRequestId(attemptId),
    'cs:{authId}:cap:{shipmentId}': captureRequestId(paypalAuthId, shipmentId),
    'cs:{captureId}:ref:{refundId}': refundRequestId(paypalAuthId, refundId),
    'cs:{disputeId}:{action}:{packetVersion}': disputeActionRequestId(disputeId, 'escalate', 999_999_999),
    // PayPal's own dispute ids (e.g. PP-D-2781XXXX) must also be usable in the slot.
    'cs:{paypalDisputeId}:file:1': disputeActionRequestId('PP-D-2781AB12CD34' as DisputeId, 'file', 1),
  }

  const out: Record<string, RequestIdLengthReport> = {}
  for (const [fmt, value] of Object.entries(cases)) {
    const report = measureRequestId(value)
    if (!report.ok) {
      throw csError('CS_INTERNAL', `Generated request id failed validation: ${report.error.message}`, {
        format: fmt,
      })
    }
    out[fmt] = report.value
  }
  return out
}

/** True when `value` looks like one of our prefixed ULID ids (`att_…`, `dsp_…`). */
export function isOurPrefixedId(value: string): boolean {
  return OUR_ID.test(value)
}