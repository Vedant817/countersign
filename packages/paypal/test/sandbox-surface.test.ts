/**
 * EC-ENV-2 — "Sandbox vs. live differences".
 *
 * The spec's handling is structural: *"The code paths that call sandbox-only APIs live in `paypal.sandbox.*`
 * and are compiled out when `PAYPAL_ENV=live`."* Two halves, and this file proves both from the inside:
 *
 *  1. **The structure.** The simulator endpoints (`process-chargeback`, `require-evidence`, `adjudicate`,
 *     `change-reason`, `accept-offer`, `deny-offer`) are named in `src/sandbox.ts` and nowhere else in the
 *     package, so a live build's code cannot reach one by accident.
 *  2. **The gate.** A live configuration cannot even construct a {@link PayPalClient}, so an environment
 *     that keeps the surface compiled in still cannot use it. (`SANDBOX_APIS_AVAILABLE` is the
 *     compile-time half; a build flag is not something a unit test can flip, which is why the runtime
 *     refusal is the half asserted here.)
 *
 * The scan asserts it *found* the endpoints before it asserts where they are not — a check whose pattern
 * matches nothing and passes is the failure mode this repository has shipped before.
 * (`docs/CI-FAILURES.md`, and the `capOf()` bug in `docs/COMPILER-EVAL.md`.)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PayPalClient } from '../src/client'

import { fakeFetch, testClock, tokenResponse } from './fixtures/transport-double'

const SRC = join(import.meta.dirname, '..', 'src')
/** The live host, spelled out here so the refusal test cannot pass against a typo'd sandbox URL. */
const LIVE_URL = 'https://api-m.paypal.com'

const CLIENT_ID = 'AY_FAKE_SANDBOX_CLIENT_ID_00000000'
const CLIENT_SECRET = 'EL_FAKE_SANDBOX_SECRET_00000000'

/** The six endpoints only the sandbox exposes (spec §10.2 #18 — [S29], [V3], [B16]). */
const SANDBOX_ONLY = [
  'process-chargeback',
  '/require-evidence',
  '/adjudicate',
  '/change-reason',
  '/accept-offer',
  '/deny-offer',
] as const

/**
 * Does this module *call* the endpoint — i.e. build it as a `path:` for the transport?
 *
 * `client.ts` legitimately **names** every endpoint in its retry/idempotency policy table
 * (`'POST /v1/customer/disputes/{id}/adjudicate': { … }`), and that table has to be complete or the
 * transport refuses the call. What must not exist is a *call site* outside `sandbox.ts`, so the check
 * is for `path:` followed by the endpoint inside one literal (`'…'`, `"…"` or `` `…` ``), not for the
 * bare string.
 */
function callsEndpoint(code: string, endpoint: string): boolean {
  const escaped = endpoint.replace(/[/-]/g, (c) => `\\${c}`)
  return new RegExp(`path:\\s*[\`'"][^\`'"]{0,80}${escaped}`).test(code)
}

/** Modules allowed to *mention* a sandbox-only endpoint: the call sites, and the policy table. */
const MAY_NAME = new Set(['sandbox.ts', 'client.ts'])

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function sourceFiles(): { name: string; code: string }[] {
  return readdirSync(SRC)
    .filter((e) => e.endsWith('.ts'))
    .map((e) => ({ name: e, code: stripComments(readFileSync(join(SRC, e), 'utf8')) }))
}

describe('EC-ENV-2: the sandbox-only API surface is sandbox-only in the code, not just by convention', () => {
  it('EC-ENV-2: calls every simulator endpoint from sandbox.ts, and calls none of them from anywhere else', () => {
    const files = sourceFiles()
    // The scan found the module it is talking about, so the negative below is not vacuous.
    const sandbox = files.find((f) => f.name === 'sandbox.ts')
    expect(sandbox, 'src/sandbox.ts is missing — the scan would pass vacuously').toBeDefined()

    for (const endpoint of SANDBOX_ONLY) {
      expect(
        sandbox!.code,
        `sandbox.ts does not name ${endpoint}; the scan is looking at the wrong thing`,
      ).toContain(endpoint)

      const callers = files.filter((f) => callsEndpoint(f.code, endpoint)).map((f) => f.name)
      expect(callers, `the only call site of ${endpoint} must be sandbox.ts`).toEqual([
        'sandbox.ts',
      ])

      const namers = files.filter((f) => f.code.includes(endpoint)).map((f) => f.name)
      for (const name of namers) {
        expect(
          MAY_NAME.has(name),
          `${name} names the sandbox-only endpoint ${endpoint} — a live build could reach it`,
        ).toBe(true)
      }
    }
  })

  it('cannot construct a client against a live host, so no simulator path is reachable in a live build', () => {
    const fetchImpl = fakeFetch(tokenResponse())
    expect(
      () =>
        new PayPalClient({
          baseUrl: LIVE_URL,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          clock: testClock(),
          fetchImpl,
          env: { PAYPAL_ENV: 'live', PAYPAL_API_BASE: LIVE_URL },
        }),
    ).toThrow(/EC-ENV-1/)
    // The refusal is at boot, not at the first call: nothing was sent, so nothing touched live money.
    expect(fetchImpl.calls).toHaveLength(0)
  })
})
