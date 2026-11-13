/**
 * `POST /api/agent/run` — the refusal boundary, D-060.
 *
 * A run spends a mandate, so the guards have to run **before** anything is minted or streamed. This file pins
 * that order and each refusal's status; the run itself is `agent-chat.spec.ts`'s subject in a browser.
 *
 * The heavy pieces are doubles: an MCP client, a model and a signer would make a test about *which id* is
 * allowed into a test about networking. What is real here is the sequence — anonymous, wrong buyer, another
 * buyer's mandate, another buyer's agent, and only then a bearer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { err, ok } from '@countersign/core'

const agent = vi.hoisted(() => ({
  agentDemoAllowed: vi.fn(),
  sessionMandatePort: vi.fn(),
  sessionSigner: vi.fn(),
}))
vi.mock('@/lib/agent-session', () => agent)

const auth = vi.hoisted(() => ({ requireBuyer: vi.fn() }))
vi.mock('@/lib/auth', () => auth)

const session = vi.hoisted(() => ({
  guardRunUser: vi.fn(),
  requireOwnedAgent: vi.fn(),
  requireOwnedMandate: vi.fn(),
}))
vi.mock('@/lib/session', () => session)

const token = vi.hoisted(() => ({ mintAgentToken: vi.fn(), MCP_TOKEN_TTL_SECONDS: 60 }))
vi.mock('@/lib/mcp-token', () => token)

const llm = vi.hoisted(() => ({ languageModel: vi.fn() }))
vi.mock('@/lib/llm', () => llm)

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(async () => ({ tools: async () => ({}) })),
}))
vi.mock('@countersign/agent', () => ({
  runScriptedShopper: vi.fn(async function* () {}),
  runShoppingAgent: vi.fn(async function* () {}),
}))

import { POST } from './route'

const URL = 'http://localhost/api/agent/run'
const BUYER = { id: 'usr_buyer', persona: 'BUYER', displayName: 'asha', email: 'asha@example.test' }

const body = {
  user_id: BUYER.id,
  mandate_id: 'mdt_owned',
  agent_id: 'agt_owned',
  message: 'Buy running shoes',
  mode: 'scripted' as const,
}

function req(payload: unknown = body): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function read(
  response: Response,
): Promise<{ status: number; body: { error?: { code: string } } }> {
  return { status: response.status, body: (await response.json()) as never }
}

beforeEach(() => {
  vi.clearAllMocks()
  agent.agentDemoAllowed.mockReturnValue(true)
  agent.sessionMandatePort.mockReturnValue({})
  agent.sessionSigner.mockReturnValue({ sign: vi.fn() })
  auth.requireBuyer.mockResolvedValue(ok(BUYER))
  session.guardRunUser.mockReturnValue(ok(true))
  session.requireOwnedMandate.mockResolvedValue(ok({ id: 'mdt_owned' }))
  session.requireOwnedAgent.mockResolvedValue(ok({ id: 'agt_owned' }))
  token.mintAgentToken.mockResolvedValue(ok('agt_token'))
  llm.languageModel.mockReturnValue(
    err({ code: 'CS_INTERNAL', message: 'no key', retryable: false }),
  )
})

describe('POST /api/agent/run — the ownership guards', () => {
  it('refuses an anonymous run with 401 and mints no token', async () => {
    auth.requireBuyer.mockResolvedValue(
      err({
        code: 'CS_UNAUTHENTICATED',
        message: 'A buyer sign-in is required for this route.',
        retryable: false,
      }),
    )
    const { status, body: refused } = await read(await POST(req()))
    expect(status).toBe(401)
    expect(refused.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(token.mintAgentToken).not.toHaveBeenCalled()
  })

  it('refuses a merchant session with 403', async () => {
    auth.requireBuyer.mockResolvedValue(
      err({
        code: 'CS_FORBIDDEN',
        message: 'The signed-in account is a MERCHANT.',
        retryable: false,
      }),
    )
    const { status } = await read(await POST(req()))
    expect(status).toBe(403)
    expect(token.mintAgentToken).not.toHaveBeenCalled()
  })

  it('refuses a body that names another buyer before a mandate is read', async () => {
    session.guardRunUser.mockReturnValue(
      err({
        code: 'CS_FORBIDDEN',
        message: 'That mandate does not belong to this browser.',
        retryable: false,
      }),
    )
    const { status, body: refused } = await read(
      await POST(req({ ...body, user_id: 'usr_someone_else' })),
    )
    expect(status).toBe(403)
    expect(refused.error?.code).toBe('CS_FORBIDDEN')
    expect(session.requireOwnedMandate).not.toHaveBeenCalled()
    expect(token.mintAgentToken).not.toHaveBeenCalled()
  })

  it("refuses another buyer's mandate with 404, so the id's existence is not confirmed", async () => {
    session.requireOwnedMandate.mockResolvedValue(
      err({
        code: 'CS_NOT_FOUND',
        message: 'No mandate mdt_owned belongs to usr_buyer.',
        retryable: false,
      }),
    )
    const { status, body: refused } = await read(await POST(req()))
    expect(status).toBe(404)
    expect(refused.error?.code).toBe('CS_NOT_FOUND')
    expect(token.mintAgentToken).not.toHaveBeenCalled()
  })

  it("refuses another buyer's agent key with 404 before a bearer exists", async () => {
    session.requireOwnedAgent.mockResolvedValue(
      err({
        code: 'CS_NOT_FOUND',
        message: 'No agent agt_owned belongs to usr_buyer.',
        retryable: false,
      }),
    )
    const { status, body: refused } = await read(await POST(req()))
    expect(status).toBe(404)
    expect(refused.error?.code).toBe('CS_NOT_FOUND')
    // The bearer is the credential this guard exists to protect.
    expect(token.mintAgentToken).not.toHaveBeenCalled()
  })

  it('streams a run the buyer owns', async () => {
    const response = await POST(req())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/)
    // The bearer is minted only for an agent this buyer has a mandate under.
    expect(token.mintAgentToken).toHaveBeenCalledWith({ agentId: 'agt_owned' })
  })
})
