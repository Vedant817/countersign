/**
 * `POST /api/intent/compile` — route tests.
 *
 * Tests the HTTP boundary: same-origin enforcement, buyer session authentication,
 * refusal of unrecognized fields (`user_id`), mapping of compiler errors, and ensuring
 * the buyer's session user ID is passed to the compiler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CompiledMandate } from '@countersign/compiler'
import { csError, err, ok } from '@countersign/core'

const auth = vi.hoisted(() => ({ requireBuyer: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireBuyer: auth.requireBuyer }))

const compiler = vi.hoisted(() => ({ compileIntent: vi.fn() }))
vi.mock('@/lib/intent-compiler', () => ({ compileIntent: compiler.compileIntent }))

const merchant = vi.hoisted(() => ({ merchantIdentity: vi.fn() }))
vi.mock('@/lib/merchant', () => ({ merchantIdentity: merchant.merchantIdentity }))

import { POST } from './route'

const URL = 'http://localhost/api/intent/compile'
const BUYER = {
  id: 'usr_buyer_123',
  persona: 'BUYER',
  displayName: 'Asha Buyer',
  email: 'asha@example.test',
}

function sampleMandate(minor: bigint = 5_000n): CompiledMandate {
  return {
    currency: 'USD',
    ttlSeconds: 900,
    expiresAtEpochSec: 1_800_000_000,
    constraints: [
      { type: 'mandate.payment.amount_range', max: minor },
      { type: 'mandate.payment.merchant', merchant_id: 'mrc_northwind' },
    ],
    preferences: {},
    assumptions: ['The limit was taken from the amount you wrote.'],
    ambiguities: [],
  } as unknown as CompiledMandate
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
  auth.requireBuyer.mockResolvedValue(ok(BUYER))
  compiler.compileIntent.mockResolvedValue(ok(sampleMandate()))
  merchant.merchantIdentity.mockReturnValue(
    ok({ id: 'mrc_northwind', name: 'Northwind', website: 'https://example.test' }),
  )
})

describe('POST /api/intent/compile', () => {
  it('compiles an intent for the signed-in buyer, using their session id', async () => {
    const response = await POST(req({ intent: 'Spend at most $50 on shoes' }))
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(compiler.compileIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: BUYER.id,
        text: 'Spend at most $50 on shoes',
      }),
    )
    expect(body['read_back']).toBeDefined()
  })

  it('passes locale through when supplied', async () => {
    const response = await POST(req({ intent: 'Spend at most $50 on shoes', locale: 'en-US' }))
    const { status } = await read(response)
    expect(status).toBe(200)
    expect(compiler.compileIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: 'en-US',
      }),
    )
  })

  it('refuses an anonymous caller with 401 before compiling', async () => {
    auth.requireBuyer.mockResolvedValue(
      err(csError('CS_UNAUTHENTICATED', 'A buyer sign-in is required for this route.')),
    )
    const { status, body } = await read(await POST(req({ intent: 'Spend at most $50' })))
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(compiler.compileIntent).not.toHaveBeenCalled()
  })

  it('refuses a signed-in merchant with 403', async () => {
    auth.requireBuyer.mockResolvedValue(
      err(
        csError(
          'CS_FORBIDDEN',
          'The signed-in account is a MERCHANT, and this surface belongs to a buyer.',
        ),
      ),
    )
    const { status, body } = await read(await POST(req({ intent: 'Spend at most $50' })))
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(compiler.compileIntent).not.toHaveBeenCalled()
  })

  it('refuses a body containing user_id with 400', async () => {
    const { status, body } = await read(
      await POST(req({ intent: 'Spend at most $50', user_id: 'usr_attacker' })),
    )
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(compiler.compileIntent).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin POST with 403 before reading the body', async () => {
    const { status, body } = await read(
      await POST(req({ intent: 'Spend at most $50' }, { origin: 'https://attacker.test' })),
    )
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(compiler.compileIntent).not.toHaveBeenCalled()
  })

  it('refuses an opaque origin with 403 before reading the body', async () => {
    const { status, body } = await read(
      await POST(req({ intent: 'Spend at most $50' }, { origin: 'null' })),
    )
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(compiler.compileIntent).not.toHaveBeenCalled()
  })

  it('refuses a non-JSON body with 400', async () => {
    const { status, body } = await read(await POST(req('not-json')))
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(compiler.compileIntent).not.toHaveBeenCalled()
  })

  it('propagates compiler errors with their mapped HTTP status', async () => {
    compiler.compileIntent.mockResolvedValue(
      err(csError('CS_ROUNDING', 'JPY has 0 minor digits. Refusing to round.')),
    )
    const { status, body } = await read(await POST(req({ intent: 'Buy shoes for 119 JPY' })))
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_ROUNDING')
  })
})
