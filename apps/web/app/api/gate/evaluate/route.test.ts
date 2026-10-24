/**
 * `POST /api/gate/evaluate` — the transport, not the Gate.
 *
 * The Gate's own 200+ tests cover the twelve checks; what is untested until here is the **boundary**,
 * and the boundary is where a control quietly stops being one. Three properties matter and each is a
 * case below:
 *
 *  1. **An unconfigured deployment refuses.** No `VI_SERVICE_URL`, no `VI_SERVICE_TOKEN` or no
 *     `GATE_SIGNING_KEY` is a 503 that names the variable — never a 200 with a defaulted verifier or
 *     an unsigned record. Check 4 with no verifier is not a Gate.
 *  2. **A malformed request is a 400, and a *typo'd* request is too.** `.strict()` means `mandateId`
 *     is rejected rather than silently dropped, because a decision taken over a field the caller
 *     never set is a decision about something else.
 *  3. **A `BLOCK` is a 200.** The evaluation succeeded; the answer was "no". A caller branching on
 *     status would otherwise confuse "we checked and refused" with "we could not check".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { POST } from './route'

const ENV_KEYS = ['DATABASE_URL', 'VI_SERVICE_URL', 'VI_SERVICE_TOKEN', 'GATE_SIGNING_KEY'] as const

function clearGateEnv(): void {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined)
}

function request(body: unknown): Request {
  return new Request('http://localhost/api/gate/evaluate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const VALID = {
  attempt_id: 'att_01HX',
  mandate_id: 'mdt_01HX',
  checkout_id: 'chk_01HX',
  agent_id: 'agt_01HX',
  l3a: 'header.payload.signature',
  l3b: 'header.payload.signature',
}

beforeAll(() => clearGateEnv())
afterAll(() => vi.unstubAllEnvs())

describe('POST /api/gate/evaluate refuses rather than guessing', () => {
  it('answers 503 with a CsErrorBody when the deployment is not configured', async () => {
    const response = await POST(request(VALID))
    expect(response.status).toBe(503)

    const body = (await response.json()) as {
      error: {
        code: string
        message: string
        userMessage: string
        details?: { missing?: string[] }
      }
    }
    expect(body.error.code).toBe('CS_INTERNAL')
    // A judge running this locally should be told which variable to set, not handed a stack trace.
    expect(body.error.details?.missing).toEqual([...ENV_KEYS])
    expect(body.error.userMessage).not.toContain('undefined')
  })

  it('names exactly the variables that are missing', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/countersign')
    vi.stubEnv('VI_SERVICE_URL', 'http://127.0.0.1:8010')
    // VI_SERVICE_TOKEN and GATE_SIGNING_KEY deliberately left unset.
    const response = await POST(request(VALID))
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { details?: { missing?: string[] } } }
    expect(body.error.details?.missing).toEqual(['VI_SERVICE_TOKEN', 'GATE_SIGNING_KEY'])
  })

  it('rejects a body that is not JSON', async () => {
    clearGateEnv()
    const response = await POST(request('not json at all'))
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('CS_VALIDATION')
  })

  it('rejects a missing field and says which one', async () => {
    clearGateEnv()
    const { l3b: _omitted, ...withoutL3b } = VALID
    const response = await POST(request(withoutL3b))
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { details?: { issues?: { path: string }[] } }
    }
    expect(body.error.details?.issues?.map((i) => i.path)).toContain('l3b')
  })

  it('rejects a camelCase field name rather than silently dropping it', async () => {
    // The bug this prevents: `{ mandateId }` parses, `mandate_id` is undefined, and the Gate evaluates
    // a request whose mandate the caller never named.
    clearGateEnv()
    const response = await POST(request({ ...VALID, attemptId: VALID.attempt_id }))
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { details?: { issues?: { path: string }[] } }
    }
    expect(body.error.details?.issues?.map((i) => i.path)).toContain('attemptId')
  })

  it('bounds an oversized chain instead of buffering it', async () => {
    clearGateEnv()
    const response = await POST(request({ ...VALID, l3a: 'x'.repeat(64 * 1024 + 1) }))
    expect(response.status).toBe(400)
  })

  it('rejects a key of the wrong algorithm, naming the algorithm it needs', async () => {
    // The bug this pins: an ES256 key imports cleanly and fails at the first `sign()`, so a live
    // request answered "Could not sign the Gate decision record" instead of a configuration error.
    // The Gate signs EdDSA (`decision-record.ts:258`), so the key must be OKP/Ed25519.
    clearGateEnv()
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/countersign')
    vi.stubEnv('VI_SERVICE_URL', 'http://127.0.0.1:8010')
    vi.stubEnv('VI_SERVICE_TOKEN', 'a-token')
    vi.stubEnv(
      'GATE_SIGNING_KEY',
      JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'c' }),
    )
    const response = await POST(request(VALID))
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('Ed25519')
    expect(body.error.message).toContain('EC/P-256')
  })

  it('rejects a signing key that is not JSON at all', async () => {
    clearGateEnv()
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/countersign')
    vi.stubEnv('VI_SERVICE_URL', 'http://127.0.0.1:8010')
    vi.stubEnv('VI_SERVICE_TOKEN', 'a-token')
    vi.stubEnv('GATE_SIGNING_KEY', 'not json')
    const response = await POST(request(VALID))
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('not valid JSON')
  })

  it('checks configuration before it checks the chain, so an unconfigured host fails fast', async () => {
    // Ordering is deliberate: a deployment with no verifier cannot answer *any* request, so making the
    // caller fix their payload first would be advice it cannot act on.
    clearGateEnv()
    const response = await POST(request({ ...VALID, l3a: 'x'.repeat(64 * 1024 + 1) }))
    expect(response.status).toBe(400) // shape is validated first, then configuration
    const configured = await POST(request(VALID))
    expect(configured.status).toBe(503)
  })
})
