/**
 * MCP transport regression coverage — spec §8.14, AT-M14.
 * Five tools remain discoverable; catalog calls work, grants constrain execution, and purchase
 * submission reports unavailable persisted authority without inventing a Gate decision or order.
 * A full purchase round-trip remains an external integration requirement.
 */
import { randomBytes } from 'node:crypto'
import { SignJWT } from 'jose'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { mintAgentToken as mintAgentTokenResult } from '@/lib/mcp-token'

import { POST } from './route'

const ENDPOINT = 'http://localhost/api/mcp/http'
// The former fixture principal must not acquire payment authority from its identifier.
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
  it('refuses unavailable order status without pretending the order is absent', async () => {
    const body = await readRpc(
      await POST(rpc(toolCall(30, 'get_order_status', { order_id: 'ord_example' }), token)),
    )
    expect(toolText(body)['error']).toMatchObject({ code: 'CS_INTERNAL' })
  })

  it('does no external work on submission even with VI configured', async () => {
    vi.stubEnv('VI_SERVICE_URL', 'https://vi.invalid')
    vi.stubEnv('VI_SERVICE_TOKEN', randomBytes(32).toString('hex'))
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected network call'))
    try {
      const body = await readRpc(
        await POST(
          rpc(
            toolCall(31, 'submit_checkout', {
              checkout_id: 'chk_00000000000000000000000001',
              mandate_id: 'mdt_00000000000000000000000001',
              l3a: 'aaa.bbb.ccc',
              l3b: 'aaa.bbb.ccc',
            }),
            token,
          ),
        ),
      )
      expect(toolText(body)['error']).toMatchObject({ code: 'CS_INTERNAL' })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
      vi.stubEnv('VI_SERVICE_URL', undefined)
      vi.stubEnv('VI_SERVICE_TOKEN', undefined)
    }
  })

  it.each([
    [{ aud: 'other-service' }, 'HS256'],
    [{ sub: 'usr_not_an_agent' }, 'HS256'],
    [{}, 'HS384'],
    [{ iat: Math.floor(Date.now() / 1000) - 3600 }, 'HS256'],
    [{ scope: '' }, 'HS256'],
  ])('rejects fresh signed invalid claims over HTTP: %j %s', async (claims, alg) => {
    const now = Math.floor(Date.now() / 1000)
    const bearer = await new SignJWT({
      sub: AGENT,
      iss: 'countersign',
      aud: 'countersign-merchant-mcp',
      iat: now,
      exp: now + 900,
      scope: 'merchant:read merchant:checkout',
      ...claims,
    })
      .setProtectedHeader({ alg })
      .sign(new TextEncoder().encode(SECRET))
    expect((await POST(rpc(initialize(1), bearer))).status).toBe(401)
  })

  it.each(['create_checkout', 'submit_checkout'])(
    'refuses %s to a read-only agent before work',
    async (name) => {
      const now = Math.floor(Date.now() / 1000)
      const readOnly = await new SignJWT({ scope: 'merchant:read' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(AGENT)
        .setIssuer('countersign')
        .setAudience('countersign-merchant-mcp')
        .setIssuedAt(now)
        .setExpirationTime(now + 900)
        .sign(new TextEncoder().encode(SECRET))
      const args =
        name === 'create_checkout'
          ? { lines: [{ sku: 'NW-001', qty: 1 }], ship_to_country: 'US' }
          : {
              checkout_id: 'chk_seed',
              mandate_id: 'mdt_seed',
              l3a: 'aaa.bbb.ccc',
              l3b: 'aaa.bbb.ccc',
            }
      const body = await readRpc(await POST(rpc(toolCall(20, name, args), readOnly)))
      expect(toolText(body)['error']).toMatchObject({ code: 'CS_FORBIDDEN' })
      const catalog = toolText(
        await readRpc(await POST(rpc(toolCall(22, 'get_product', { sku: 'NW-001' }), readOnly))),
      )
      expect(catalog['error']).toBeUndefined()
      expect(catalog['sku']).toBe('NW-001')
    },
  )

  it.each([
    ['search_products', { query: 'x'.repeat(201) }],
    ['search_products', { max_price_minor: Number.MAX_SAFE_INTEGER + 1 }],
    ['get_product', { sku: '../secret' }],
    ['create_checkout', { lines: [{ sku: 'NW-001', qty: 0 }], ship_to_country: 'US' }],
    [
      'submit_checkout',
      { checkout_id: 'chk_seed', mandate_id: 'mdt_seed', l3a: 'x'.repeat(65537), l3b: 'x' },
    ],
  ])('rejects invalid tool input for %s', async (name, args) => {
    const body = await readRpc(
      await POST(rpc(toolCall(21, name as string, args as Record<string, unknown>), token)),
    )
    const result = body['result'] as { isError?: boolean; content?: unknown } | undefined
    expect(body['error'] !== undefined || result?.isError === true).toBe(true)
    expect(JSON.stringify(body)).not.toContain('CS_INTERNAL')
  })

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

  it('keeps the sse mount authenticated and the catalog usable', async () => {
    const request = rpc(toolCall(25, 'search_products', { query: 'trail' }), token)
    const response = await POST(new Request('http://localhost/api/mcp/sse', request))
    expect(response.status).toBe(200)
    expect(toolText(await readRpc(response))['items']).toBeInstanceOf(Array)
  })

  it('refuses payment evaluation without persisted authority, even for seeded identities', async () => {
    await POST(rpc(initialize(1), token))
    const response = await POST(
      rpc(
        toolCall(4, 'submit_checkout', {
          checkout_id: 'chk_00000000000000000000000001',
          mandate_id: 'mdt_00000000000000000000000001',
          // Submission must refuse the absent runtime before evaluating any supplied chain.
          l3a: 'aaa.bbb.ccc',
          l3b: 'aaa.bbb.ccc',
        }),
        token,
      ),
    )
    expect(response.status).toBe(200)

    const body = await readRpc(response)
    const parsed = toolText(body)
    expect(parsed['status']).toBeUndefined()
    expect(parsed['error']).toMatchObject({ code: 'CS_INTERNAL' })
    expect((body['result'] as { isError?: boolean }).isError).toBe(true)
  })
})
