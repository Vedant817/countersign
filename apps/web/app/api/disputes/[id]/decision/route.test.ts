/**
 * `POST /api/disputes/{id}/decision` — the HTTP boundary, not the decision — spec §8.15, S-17.
 *
 * `lib/dispute-approval.test.ts` proves the guards and the audit row; this suite proves the shape around
 * them: that an anonymous caller is `401` before any decision is attempted, that a malformed body is a
 * `400` rather than a half-read request, that a cross-origin `POST` is refused before it is parsed, and
 * that every `CsError.code` this route can produce reaches the merchant as the status the registry gives
 * it. The last one matters most: a PayPal `404` on a case that vanished must be a `404` the merchant can
 * read, never a `200` that claims a filing happened.
 *
 * The session, the user lookup and `decideDispute` are doubles: this is the transport, and a transport test
 * that needed a database would be testing two things at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { csError, err, ok } from '@countersign/core'

const auth = vi.hoisted(() => ({ requireMerchant: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireMerchant: auth.requireMerchant }))

const approval = vi.hoisted(() => ({ decideDispute: vi.fn() }))
vi.mock('@/lib/dispute-approval', () => ({ decideDispute: approval.decideDispute }))

import { POST } from './route'

const CONTEXT = { params: Promise.resolve({ id: 'dsp_1' }) }
const URL = 'http://localhost/api/disputes/dsp_1/decision'

const OUTCOME = {
  disputeId: 'dsp_1',
  paypalDisputeId: 'PP-D-1',
  decision: 'approve',
  applied: true,
  awaitingApproval: false,
  awaitingHuman: false,
  disposition: 'FILE',
  filed: true,
  ruleId: 'R-TEST-1',
  refusal: null,
  paypalCalls: ['provideEvidence'],
  auditId: 'aud_test',
  actionRowId: null,
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function read(response: Response): Promise<{
  status: number
  body: {
    error?: { code: string; message: string; userMessage?: string; details?: unknown }
    [key: string]: unknown
  }
}> {
  return { status: response.status, body: (await response.json()) as never }
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.requireMerchant.mockResolvedValue(
    ok({
      id: 'usr_merchant',
      persona: 'MERCHANT',
      displayName: 'Northwind',
      email: 'm@example.test',
    }),
  )
  approval.decideDispute.mockResolvedValue(ok(OUTCOME))
})

describe('POST /api/disputes/[id]/decision', () => {
  it('runs the decision for a signed-in merchant and answers with the outcome', async () => {
    const response = await POST(req({ decision: 'approve' }), CONTEXT)
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body).toEqual(OUTCOME)
    expect(approval.decideDispute).toHaveBeenCalledWith({
      disputeId: 'dsp_1',
      decision: 'approve',
      actorUserId: 'usr_merchant',
    })
  })

  it('passes the merchant’s note through unchanged', async () => {
    await POST(req({ decision: 'approve', note: 'kept the item' }), CONTEXT)
    expect(approval.decideDispute).toHaveBeenCalledWith({
      disputeId: 'dsp_1',
      decision: 'approve',
      actorUserId: 'usr_merchant',
      note: 'kept the item',
    })
  })

  it('refuses an anonymous caller with 401 before any decision is attempted', async () => {
    auth.requireMerchant.mockResolvedValue(
      err(csError('CS_UNAUTHENTICATED', 'A merchant sign-in is required for this route.')),
    )
    const response = await POST(req({ decision: 'approve' }), CONTEXT)
    const { status, body } = await read(response)
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(approval.decideDispute).not.toHaveBeenCalled()
  })

  it('refuses a signed-in buyer with 403, so a non-merchant cannot decide a case', async () => {
    auth.requireMerchant.mockResolvedValue(
      err(
        csError(
          'CS_FORBIDDEN',
          'The signed-in account is a BUYER, and disputes belong to the merchant.',
        ),
      ),
    )
    const response = await POST(req({ decision: 'approve' }), CONTEXT)
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(approval.decideDispute).not.toHaveBeenCalled()
  })

  it('refuses a session whose user row no longer exists with 401, not a server fault', async () => {
    auth.requireMerchant.mockResolvedValue(
      err(csError('CS_UNAUTHENTICATED', 'The session names a user with no row.')),
    )
    const response = await POST(req({ decision: 'approve' }), CONTEXT)
    const { status, body } = await read(response)
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(approval.decideDispute).not.toHaveBeenCalled()
  })

  it('answers 500 when the session itself cannot be read, rather than treating it as anonymous', async () => {
    // A signing secret that is missing or too short is a deployment fault. The old route answered 503; the
    // registry's status for CS_INTERNAL is 500 and every other route uses it, so the login path is not a
    // special case that hides a misconfiguration behind a different number.
    auth.requireMerchant.mockResolvedValue(err(csError('CS_INTERNAL', 'SESSION_SECRET is missing')))
    const response = await POST(req({ decision: 'approve' }), CONTEXT)
    expect((await read(response)).status).toBe(500)
  })

  it('refuses a body that is not JSON with 400', async () => {
    const response = await POST(req('not json at all'), CONTEXT)
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(approval.decideDispute).not.toHaveBeenCalled()
  })

  it('refuses a missing decision with 400 and names the field', async () => {
    const response = await POST(req({}), CONTEXT)
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(body.error?.details).toBeDefined()
  })

  it('refuses an unknown decision value with 400', async () => {
    const response = await POST(req({ decision: 'maybe' }), CONTEXT)
    expect((await read(response)).status).toBe(400)
  })

  it('refuses an extra field rather than silently dropping it', async () => {
    const response = await POST(
      req({ decision: 'approve', actorUserId: 'usr_someone_else' }),
      CONTEXT,
    )
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
  })

  it('refuses a cross-origin POST with 403 before reading the body', async () => {
    const response = await POST(
      req({ decision: 'approve' }, { origin: 'https://attacker.test' }),
      CONTEXT,
    )
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(approval.decideDispute).not.toHaveBeenCalled()
  })

  it('accepts a same-origin POST', async () => {
    const response = await POST(
      req({ decision: 'approve' }, { origin: 'http://localhost' }),
      CONTEXT,
    )
    expect((await read(response)).status).toBe(200)
  })

  it.each([
    ['CS_CONFLICT', 409],
    ['CS_NOT_FOUND', 404],
    ['CS_FORBIDDEN', 403],
    ['CS_RATE_LIMITED', 429],
    ['CS_INTERNAL', 500],
  ] as const)('maps %s to %i', async (code, status) => {
    approval.decideDispute.mockResolvedValue(err(csError(code, `${code} from the decision`)))
    const response = await POST(req({ decision: 'approve' }), CONTEXT)
    const { status: actual, body } = await read(response)
    expect(actual).toBe(status)
    expect(body.error?.code).toBe(code)
  })

  it('propagates a PayPal 404 as 404, never as a success', async () => {
    // The S-17 honesty case: with no real captured payment there is no PayPal dispute to file against, so
    // the route must carry PayPal’s own absence to the merchant rather than a fabricated 200.
    approval.decideDispute.mockResolvedValue(
      err(csError('PP_NOT_FOUND', 'PayPal has no dispute PP-D-ABSENT')),
    )
    const response = await POST(req({ decision: 'approve' }), CONTEXT)
    const { status, body } = await read(response)
    expect(status).toBe(404)
    expect(body.error?.code).toBe('PP_NOT_FOUND')
  })
})
