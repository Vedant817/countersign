/**
 * The merchant MCP route — spec §8.14, **AT-M14**.
 *
 * The three acceptance points are exercised at the transport boundary, not by calling the M9 functions
 * again:
 *
 * 1. `tools/list` returns the five tools §8.9 defines;
 * 2. a call without a bearer is `401`, and a forged bearer is refused;
 * 3. `submit_checkout` round-trips through the real `evaluate` and returns a decision with reasons.
 *
 * §8.14's third point says "round-trip", not "happy path": the happy path needs a signed chain, a
 * mandate row and PayPal, none of which a unit test should fabricate. What is proven here is that the
 * tool reaches the Gate, the Gate runs all twelve checks, and the tool returns the answer rather than a
 * transport error.
 */
import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { mintAgentToken as mintAgentTokenResult } from '@/lib/mcp-token'

import { POST } from './route'

const ENDPOINT = 'http://localhost/api/mcp/http'
// The in-memory world's default agent, so checks 2 and 3 get past their lookup and the decision is
// about the chain rather than about an unknown principal.
const AGENT = 'agt_00000000000000000000000001'
const SECRET = randomBytes(32).toString('hex')

let token = ''

async function mintAgentToken(
  options: Parameters<typeof mintAgentTokenResult>[0],
): Promise<string> {
  const result = await mintAgentTokenResult(options)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function rpc(body: unknown, bearer?: string): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`
  return new Request(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function readRpc(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0)
    return JSON.parse(data[data.length - 1] ?? '{}') as Record<string, unknown>
  }
  return JSON.parse(text) as Record<string, unknown>
}

function initialize(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'countersign-vitest', version: '0.0.0' },
    },
  }
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

function toolText(response: Record<string, unknown>): Record<string, unknown> {
  const result = response['result'] as
    | { content?: readonly { type?: string; text?: string }[] }
    | undefined
  const text = result?.content?.find((entry) => entry.type === 'text')?.text
  expect(typeof text).toBe('string')
  return JSON.parse(text ?? '{}') as Record<string, unknown>
}

beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET', SECRET)
  // The route fails closed when the VI service is absent; that is the state this test wants. A developer
  // shell may have these set, so remove them for the duration of the file.
  vi.stubEnv('VI_SERVICE_URL', undefined)
  vi.stubEnv('VI_SERVICE_TOKEN', undefined)
  token = await mintAgentToken({ agentId: AGENT })
})

afterAll(() => vi.unstubAllEnvs())

describe('the merchant MCP route', () => {
  it('lists the five §8.9 tools', async () => {
    const initialized = await POST(rpc(initialize(1), token))
    expect(initialized.status).toBe(200)

    const listed = await POST(
      rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, token),
    )
    expect(listed.status).toBe(200)
    const body = await readRpc(listed)
    const result = body['result'] as { tools?: readonly { name: string }[] }
    const names = (result.tools ?? []).map((tool) => tool.name).sort()

    expect(names).toEqual([
      'create_checkout',
      'get_order_status',
      'get_product',
      'search_products',
      'submit_checkout',
    ])
  })

  it('rejects a call with no bearer', async () => {
    const response = await POST(rpc(initialize(1)))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('rejects a forged bearer', async () => {
    const response = await POST(rpc(initialize(1), 'not.a.token'))
    expect([401, 403]).toContain(response.status)
  })

  it('rejects an expired bearer over HTTP', async () => {
    const expired = await mintAgentToken({
      agentId: AGENT,
      nowSec: Math.floor(Date.now() / 1000) - 3600,
    })
    expect((await POST(rpc(initialize(1), expired))).status).toBe(401)
  })

  it('rejects a bearer minted for another agent id shape', async () => {
    const { SignJWT } = await import('jose')
    const key = new TextEncoder().encode(SECRET)
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('usr_not_an_agent')
      .setIssuer('countersign')
      .setAudience('countersign-merchant-mcp')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(key)

    const response = await POST(rpc(initialize(1), forged))
    expect([401, 403]).toContain(response.status)
  })

  it('serves search_products over the transport', async () => {
    await POST(rpc(initialize(1), token))
    const response = await POST(rpc(toolCall(3, 'search_products', { query: 'trail' }), token))
    expect(response.status).toBe(200)

    const body = await readRpc(response)
    expect(body['error']).toBeUndefined()
    const parsed = toolText(body)
    const items = parsed['items'] as readonly { sku: string }[]
    expect(items.some((item) => item.sku === 'NW-001')).toBe(true)
  })

  it('round-trips submit_checkout through the real Gate', async () => {
    await POST(rpc(initialize(1), token))
    const response = await POST(
      rpc(
        toolCall(4, 'submit_checkout', {
          checkout_id: 'chk_00000000000000000000000001',
          mandate_id: 'mdt_00000000000000000000000001',
          // A structurally valid compact JWS, not a signature the Gate accepts. Check 4 refuses it,
          // which is the point: the tool still returns the Gate's decision instead of throwing.
          l3a: 'aaa.bbb.ccc',
          l3b: 'aaa.bbb.ccc',
        }),
        token,
      ),
    )
    expect(response.status).toBe(200)

    const body = await readRpc(response)
    const parsed = toolText(body)
    expect(parsed['status']).toBe('BLOCKED')
    const reasons = parsed['reasons'] as readonly { code: string; userMessage?: string }[]
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons.every((reason) => typeof reason.code === 'string')).toBe(true)
    // The decision is the Gate's, not the transport's: a missing checkout session is check 5.
    expect(reasons.map((reason) => reason.code)).toContain('VI_CHAIN_INVALID')
  })
})
