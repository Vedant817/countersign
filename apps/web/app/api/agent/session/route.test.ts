/**
 * `POST /api/agent/session` — the HTTP boundary, D-060.
 *
 * The pipeline is `lib/agent-session.test.ts`'s subject; this file is about the one thing that changed: whose
 * mandate a request gets. Three answers, in the order the route gives them:
 *
 *  1. **The demo gate first.** It is a property of the deployment, not of the person, so an anonymous caller
 *     on a deployment with no vi-service learns that before learning anything about accounts.
 *  2. **Anonymous is 401, a merchant is 403.** The cookie names the buyer and the row behind it decides
 *     whether it may be one.
 *  3. **The provisioner is handed the session's id**, never one from the body — the body cannot name anyone,
 *     because the schema has no field for it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { err, ok } from '@countersign/core'

const agent = vi.hoisted(() => ({
  agentDemoAllowed: vi.fn(),
  provisionAgentSession: vi.fn(),
}))
vi.mock('@/lib/agent-session', () => agent)

const auth = vi.hoisted(() => ({ requireBuyer: vi.fn() }))
vi.mock('@/lib/auth', () => auth)

import { POST } from './route'

const URL = 'http://localhost/api/agent/session'
const BUYER = { id: 'usr_buyer', persona: 'BUYER', displayName: 'asha', email: 'asha@example.test' }

function req(body: unknown = { intent: 'Buy shoes under $50' }): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function read(response: Response): Promise<{
  status: number
  body: Record<string, unknown> & { error?: { code: string } }
}> {
  return { status: response.status, body: (await response.json()) as never }
}

beforeEach(() => {
  vi.clearAllMocks()
  agent.agentDemoAllowed.mockReturnValue(true)
  auth.requireBuyer.mockResolvedValue(ok(BUYER))
  agent.provisionAgentSession.mockResolvedValue(
    ok({
      userId: BUYER.id,
      mandateId: 'mdt_1',
      agentId: 'agt_1',
      agentKid: 'kid_1',
      readback: '**What you are authorising**\n\nA $50 cap.',
      expiresAtEpochSec: 1_800_000_000,
    }),
  )
})

describe('POST /api/agent/session', () => {
  it('provisions the mandate for the buyer the session names', async () => {
    const response = await POST(req())
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body['user_id']).toBe(BUYER.id)
    expect(agent.provisionAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: BUYER.id }),
    )
  })

  it('refuses an anonymous request with 401 and mints nothing', async () => {
    auth.requireBuyer.mockResolvedValue(
      err({
        code: 'CS_UNAUTHENTICATED',
        message: 'A buyer sign-in is required for this route.',
        retryable: false,
      }),
    )
    const response = await POST(req())
    const { status, body } = await read(response)
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(agent.provisionAgentSession).not.toHaveBeenCalled()
  })

  it('refuses a merchant session with 403', async () => {
    auth.requireBuyer.mockResolvedValue(
      err({
        code: 'CS_FORBIDDEN',
        message: 'The signed-in account is a MERCHANT.',
        retryable: false,
      }),
    )
    const response = await POST(req())
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(agent.provisionAgentSession).not.toHaveBeenCalled()
  })

  it('answers the demo gate before the account check when the deployment has no vi-service', async () => {
    agent.agentDemoAllowed.mockReturnValue(false)
    const response = await POST(req())
    const { status } = await read(response)
    expect(status).toBe(403)
    // The deployment question is answered without consulting the person at all.
    expect(auth.requireBuyer).not.toHaveBeenCalled()
  })

  it('refuses a body that names a buyer rather than trusting it', async () => {
    const response = await POST(req({ intent: 'Buy shoes', user_id: 'usr_someone_else' }))
    const { status } = await read(response)
    expect(status).toBe(400)
    expect(agent.provisionAgentSession).not.toHaveBeenCalled()
  })

  it('answers 404 when the cookie names a row that is gone', async () => {
    agent.provisionAgentSession.mockResolvedValue(
      err({
        code: 'CS_NOT_FOUND',
        message: 'This session names a buyer that does not exist.',
        retryable: false,
      }),
    )
    const response = await POST(req())
    const { status } = await read(response)
    expect(status).toBe(404)
  })
})
