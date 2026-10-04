/**
 * Transport double for `packages/vi-client`'s tests. See `README.md` in this directory first.
 *
 * This replaces `fetch` and nothing else: the client under test runs its real header assembly, real
 * URL building, real retry loop, real backoff and real zod validation.
 *
 * **Every response body below is transcribed from `apps/vi/src/vi_service/models.py`** and cites the
 * pydantic class it came from. That provenance is the whole point: this package's failure mode is not a
 * fake service, it is a fake *schema*. A shape invented here that the service does not send would let
 * the drift check pass while the client was wrong. Nothing here asserts vi's behaviour — "a wrong
 * browser signature really yields `VI_SIGNATURE_MISMATCH`" belongs to `apps/vi`'s own pytest suite and
 * to `client.contract.test.ts`.
 */
import { fixedClock } from '@countersign/core'
import type { Clock } from '@countersign/core'

import type { Sleep } from '../../src/client'

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
  /** Whatever was handed to `fetch` as the body: a string or `undefined`. */
  readonly body: unknown
  readonly init: RequestInit | undefined
}

export interface FakeResponseSpec {
  readonly status?: number
  /** Serialised as JSON with `content-type: application/json`. */
  readonly body?: unknown
  /** Sent verbatim; takes precedence over `body`. */
  readonly text?: string
  readonly headers?: Record<string, string>
  /** Throw instead of responding: a connection reset, or a timeout. */
  readonly throws?: Error
  /**
   * Never settle until the request's `AbortSignal` fires, then reject with a `TimeoutError`.
   *
   * This is how the 5 s timeout is tested for real, on real timers, in milliseconds.
   */
  readonly hangUntilAbort?: boolean
}

export type Responder = (call: RecordedCall) => FakeResponseSpec | Promise<FakeResponseSpec>

/** A single spec, a queue of them (the last entry repeats), or a function that decides per call. */
export type Stub = FakeResponseSpec | readonly FakeResponseSpec[] | Responder

export interface FetchDouble {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>
  /** Every call the client made, in order. */
  readonly calls: RecordedCall[]
  callsTo(pathFragment: string): RecordedCall[]
}

function normaliseHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {}
  const h = init?.headers
  if (!h) return out
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v)
    return out
  }
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v
    })
    return out
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = v
  return out
}

function toResponse(spec: FakeResponseSpec): Response {
  if (spec.throws) throw spec.throws
  const status = spec.status ?? 200
  const headers = new Headers({ 'content-type': 'application/json', ...(spec.headers ?? {}) })
  if (spec.text !== undefined) return new Response(spec.text, { status, headers })
  if (spec.body === undefined) return new Response(null, { status, headers })
  return new Response(JSON.stringify(spec.body), { status, headers })
}

export function fakeFetch(responder: Stub): FetchDouble {
  const calls: RecordedCall[] = []
  const queue = Array.isArray(responder) ? [...responder] : null
  const single = !queue && typeof responder !== 'function' ? (responder as FakeResponseSpec) : null

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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
      : single ?? (await (responder as Responder)(record))

    if (spec.hangUntilAbort) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error('hangUntilAbort needs a request signal; the client did not send one'))
          return
        }
        signal.addEventListener('abort', () => {
          // Exactly what `AbortSignal.timeout` rejects with, so the client classifies it as a timeout.
          reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
        })
      })
    }
    return toResponse(spec)
  }

  const double = impl as FetchDouble
  Object.defineProperties(double, {
    calls: { get: () => calls },
    callsTo: { value: (fragment: string) => calls.filter((c) => c.url.includes(fragment)) },
  })
  return double
}

// ---------------------------------------------------------------------------
// Values transcribed from models.py
// ---------------------------------------------------------------------------

/**
 * A P-256 public JWK. `vi_service.models.PublicJwk` — `kty`, `crv`, `x`, `y`, `extra="allow"`.
 *
 * The return type is the literal shape rather than `Record<string, string>`, because the client's request
 * schemas demand `kty: 'EC'` and `crv: 'P-256'` and a loose helper would hide that. The default `x`/`y`
 * are 43 base64url characters, i.e. a real 32-byte coordinate.
 */
export function publicJwk(
  x = 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y = 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
): { kty: 'EC'; crv: 'P-256'; x: string; y: string } {
  return { kty: 'EC', crv: 'P-256', x, y }
}

/**
 * A valid `l2/prepare` response. `vi_service.models.L2PrepareResponse`.
 *
 * `signing_input` is built the way `l2.py::_signing_input_of` builds it: the first two segments of the
 * library's own compact JWS, joined with a dot. Building it here from `header` and `payload` is safe
 * *for a fixture* — the client must never rebuild it, and `test/types.test.ts` asserts it does not.
 */
export function prepareResponse(overrides: { prepareId?: string; expiresAt?: number } = {}): Record<string, unknown> {
  const header = { alg: 'ES256', typ: 'JWT', kid: 'dev_key_test_1' }
  const payload = {
    iss: 'https://wallet.countersign.test',
    sub: 'usr_test_user',
    aud: ['https://agent.countersign.test'],
    iat: 1_790_000_000,
    exp: 1_790_086_400,
    _sd: ['nonce', 'merchant_1', 'amount'],
    nonce: 'nonce-test-1',
    cnf: { jkt: '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2NgcN3IQCE67EE' },
  }
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')
  return {
    prepare_id: overrides.prepareId ?? 'prep_0f9c2b7d4e6a4c1b8d3f2a5e7c9b0d4f',
    signing_input: `${enc(header)}.${enc(payload)}`,
    header,
    payload,
    expires_at: overrides.expiresAt ?? 1_790_000_300,
    prepare_ttl_seconds: 300,
  }
}

/** `vi_service.models.L1IssueResponse`. */
export function l1Response(): Record<string, unknown> {
  return {
    l1: 'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJodHRwczovL3dhbGxldC5jb3VudGVyc2lnbi50ZXN0In0.sig~',
    iat: 1_790_000_000,
    exp: 1_821_560_000,
    issuer_kid: 'issuer-key-1',
    card_id: '9f2b7c4d1e6a4c1b8d3f2a5e7c9b0d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0',
    device_jkt: '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2NgcN3IQCE67EE',
  }
}

/**
 * The reason `apps/vi` appends to each network-enforced entry of `skipped`.
 *
 * Transcribed verbatim from `vi_service/verify.py::classify_constraint_report`, and confirmed against a
 * running service. It matters that this text exists: it makes every `skipped` entry an annotated string
 * rather than a bare constraint type, so `skipped.includes('mandate.payment.budget')` is always false. See
 * `skippedConstraintTypes` in `src/types.ts`.
 */
export const NETWORK_ENFORCED_REASON =
  'Network-enforced constraints. Not evaluated by verifiable_intent; Countersign’s Gate enforces it ' +
  '(spec D19). NOT satisfied by this response.'

/**
 * A `verify` response. `vi_service.models.VerifyResponse`.
 *
 * `constraints.skipped` carries the annotated entries the service really sends — including one free-form
 * note — because a fixture that put bare type names there would teach the one mistake this field invites.
 * That is spec D19's whole point, and the Gate's ability to see what it still owes depends on it.
 */
export function verifyResponse(
  overrides: {
    chainValid?: boolean
    errors?: string[]
    satisfied?: boolean
    violations?: string[]
    checked?: string[]
    /**
     * Accepts both wire shapes on purpose: `{type, reason}` is what `apps/vi` emits after
     * DECISIONS D-019, and the legacy annotated string is what a not-yet-redeployed service still
     * sends. A fixture that only modelled one of them would let a regression in the other pass.
     */
    skipped?: Array<string | { type: string; reason: string }>
    atTimeNotHonoured?: boolean
  } = {},
): Record<string, unknown> {
  return {
    chain_valid: overrides.chainValid ?? true,
    errors: overrides.errors ?? [],
    constraints: {
      satisfied: overrides.satisfied ?? true,
      violations: overrides.violations ?? [],
      checked: overrides.checked ?? [
        'mandate.payment.amount_range',
        'mandate.payment.allowed_payees',
        'mandate.payment.reference',
      ],
      skipped: overrides.skipped ?? [
        `mandate.payment.budget — ${NETWORK_ENFORCED_REASON}`,
        `mandate.payment.recurrence — ${NETWORK_ENFORCED_REASON}`,
        `mandate.payment.agent_recurrence — ${NETWORK_ENFORCED_REASON}`,
      ],
    },
    disclosed: { l1: {}, l2: {}, l3a: {}, l3b: {} },
    keys: {
      issuer_kid: 'issuer-key-1',
      device_jkt: '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2NgcN3IQCE67EE',
      agent_kid: 'agt_k_01JC0Z9P7YQ8V2N3M4K5K6R7ST8',
      device_kid: 'dev_key_test_1',
      merchant_kid: 'merchant-key-1',
    },
    checks_performed: ['chain', 'constraints', 'clock_skew'],
    checks_skipped: ['at_time'],
    verified_at: 1_790_000_000,
    clock_skew_seconds: 300,
    at_time_not_honoured: overrides.atTimeNotHonoured ?? false,
    at_time_reason: null,
    at_time_check: null,
  }
}

/**
 * The `CsErrorBody` vi raises. `apps/vi/src/vi_service/errors.py::CsError.to_body`.
 *
 * The shape is fixed by spec §8.0 rule 3 and must match `packages/core`'s `toBody()` byte for byte.
 */
export function csErrorBody(
  code: string,
  message: string,
  overrides: { userMessage?: string; retryable?: boolean; details?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    error: {
      code,
      message,
      userMessage: overrides.userMessage ?? 'Something went wrong. Nothing was charged. Please try again.',
      retryable: overrides.retryable ?? false,
      ...(overrides.details ? { details: overrides.details } : {}),
    },
  }
}

/** A 500 as `apps/vi`'s catch-all handler answers it. See the WP-04 findings: it uses `CS_VALIDATION`. */
export function viUnhandledError(): FakeResponseSpec {
  return {
    status: 500,
    body: csErrorBody(
      'CS_VALIDATION',
      'The service failed to handle this request (KeyError). Nothing was signed.',
    ),
  }
}

// ---------------------------------------------------------------------------
// Time and waiting
// ---------------------------------------------------------------------------

export type TestClock = Clock & { set(sec: number): void; advance(deltaSec: number): void }

/** A clock pinned at a fixed second. Never `Date.now()` in a test (spec §8.1, §8.0 rule 10). */
export function testClock(startSec = 1_790_000_000): TestClock {
  return fixedClock(startSec) as TestClock
}

export interface RecordingSleep {
  readonly sleep: Sleep
  /** Every delay the client asked for, in order. */
  readonly delays: number[]
}

/** A sleep that records instead of waiting, so a retry backoff costs the suite nothing. */
export function recordingSleep(): RecordingSleep {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms)
    },
  }
}

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