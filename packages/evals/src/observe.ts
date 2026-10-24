/**
 * Turning a real `POST /api/intent/compile` response into something a scorer can read.
 *
 * Kept apart from {@link file://./score.ts} on purpose: scoring is a pure function of what arrived, and
 * this module is the only part that knows the wire format. When the response shape changes, the tests
 * that break are the ones about reading it — not the ones about what the compiler is supposed to do.
 *
 * ## `error` is a first-class outcome, not an exception
 *
 * A transport failure must never be silently scored as a pass or a refusal. An earlier harness called
 * `response.json()` before checking `response.ok`, so an empty-bodied `500` arrived as
 * `SyntaxError: Unexpected end of JSON input` and was filed as a truncation for several sessions while
 * the real cause was a `bigint` that could not be serialised (`docs/COMPILER-EVAL.md`). Here a non-JSON
 * body, a `5xx`, or a thrown fetch is `outcome: 'error'` with the reason recorded, and
 * {@link file://./score.ts} counts it as a breach rather than a clean run.
 */
import type { ObservedOutcome, ObservedResponse } from './score.js'

/** Anything with a JSON body counts; we read it as `unknown` and narrow by hand. */
interface RawBody {
  readonly currency?: unknown
  readonly constraints?: unknown
  readonly ambiguities?: unknown
  readonly read_back?: unknown
  readonly assumptions?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

function asConstraints(body: RawBody): readonly Record<string, unknown>[] {
  return Array.isArray(body.constraints)
    ? (body.constraints.filter((c) => typeof c === 'object' && c !== null) as Record<
        string,
        unknown
      >[])
    : []
}

/** Every `max` on an amount-bearing constraint, in minor units. */
function widestCap(constraints: readonly Record<string, unknown>[]): number | null {
  let widest: number | null = null
  for (const c of constraints) {
    const type = typeof c['type'] === 'string' ? c['type'] : ''
    if (!type.includes('amount_range') && !type.includes('budget')) continue
    const max = c['max']
    // The wire format is a JSON number (`toJsonSafe` converts once and refuses to round); a string is
    // still read, because a body that arrived as a decimal string is readable and skipping it would
    // turn a moved cap into a passing test.
    const value = typeof max === 'number' ? max : typeof max === 'string' ? Number(max) : null
    if (value === null || !Number.isFinite(value)) continue
    if (widest === null || value > widest) widest = value
  }
  return widest
}

/**
 * Merchant ids from every allow-list constraint.
 *
 * Read generically rather than by exact `type` string: the allow-lists have been renamed once already
 * (`allowed_payees` alongside `allowed_merchants`), and a scorer that stopped seeing merchants after a
 * rename would report clean runs forever.
 */
function merchantIds(constraints: readonly Record<string, unknown>[]): string[] {
  const found = new Set<string>()
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (typeof entry === 'string') {
        if (entry.startsWith('mrc_')) found.add(entry)
      } else if (typeof entry === 'object' && entry !== null) {
        const id = (entry as Record<string, unknown>)['id']
        if (typeof id === 'string' && id.startsWith('mrc_')) found.add(id)
      }
    }
  }
  for (const c of constraints) {
    for (const value of Object.values(c)) collect(value)
  }
  return [...found].sort()
}

/** SKU ids anywhere in the constraints, including inside line items. */
function skuIds(constraints: readonly Record<string, unknown>[]): string[] {
  const found = new Set<string>()
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/^NW-\d+$/.test(value)) found.add(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) walk(item)
    }
  }
  for (const c of constraints) walk(c)
  return [...found].sort()
}

/** Frequencies on any recurrence constraint. */
function recurrenceFrequencies(constraints: readonly Record<string, unknown>[]): string[] {
  const found: string[] = []
  for (const c of constraints) {
    const type = typeof c['type'] === 'string' ? c['type'] : ''
    if (!type.includes('recurrence')) continue
    const frequency = c['frequency']
    if (typeof frequency === 'string') found.push(frequency)
  }
  return found
}

/**
 * Read one response.
 *
 * `httpStatus` is passed in rather than read from the `Response` so a test can build a body by hand.
 */
export function observeResponse(httpStatus: number, rawText: string): ObservedResponse {
  const empty = {
    amountMaxMinor: null,
    currency: null,
    merchantIds: [],
    skuIds: [],
    recurrenceFrequencies: [],
    hasRecurrence: false,
    raw: rawText,
  } as const

  let body: RawBody
  try {
    body = JSON.parse(rawText) as RawBody
  } catch {
    return { ...empty, outcome: 'error', code: `HTTP ${httpStatus}, non-JSON body` }
  }

  // A 5xx is never a sanctioned answer, however well-formed the body. `STATUS_BY_CODE` maps every
  // `CsError` to a 4xx or 503; a 500 means the route threw, which is a defect rather than a refusal.
  if (httpStatus >= 500) {
    const code = typeof body.error?.code === 'string' ? body.error.code : `HTTP ${httpStatus}`
    return { ...empty, outcome: 'error', code }
  }

  if (httpStatus >= 400) {
    return {
      ...empty,
      outcome: 'refuse',
      code: typeof body.error?.code === 'string' ? body.error.code : `HTTP ${httpStatus}`,
    }
  }

  const constraints = asConstraints(body)
  const frequencies = recurrenceFrequencies(constraints)
  const ambiguous = Array.isArray(body.ambiguities) && body.ambiguities.length > 0
  const outcome: ObservedOutcome = ambiguous ? 'question' : 'signable'

  return {
    outcome,
    code: null,
    amountMaxMinor: widestCap(constraints),
    currency: typeof body.currency === 'string' ? body.currency : null,
    merchantIds: merchantIds(constraints),
    skuIds: skuIds(constraints),
    recurrenceFrequencies: frequencies,
    hasRecurrence: frequencies.length > 0,
    raw: rawText,
  }
}

/** Where the compile route lives. Overridable so a deployed environment can be scored. */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:3000/api/intent/compile'

/**
 * Call the route for one intent and read it.
 *
 * `connection: close` because keep-alive sockets that the dev server closes mid-response truncate the
 * body silently, which is indistinguishable from a compiler fault at the call site.
 */
export async function observeIntent(
  intent: string,
  endpoint: string = DEFAULT_ENDPOINT,
  timeoutMs = 120_000,
): Promise<ObservedResponse> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ intent }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return observeResponse(response.status, await response.text())
  } catch (error) {
    return {
      outcome: 'error',
      code: `transport: ${error instanceof Error ? error.message : String(error)}`,
      amountMaxMinor: null,
      currency: null,
      merchantIds: [],
      skuIds: [],
      recurrenceFrequencies: [],
      hasRecurrence: false,
      raw: '',
    }
  }
}
