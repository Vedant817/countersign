/**
 * `POST /api/orders/{id}/void` — the HTTP boundary, not the release — spec §8.11, S-15.
 *
 * The interesting property here is the one the route must **not** have: it does not decide an order status.
 * `OUT_OF_STOCK`, `REVOKED`, `CANCELLED` and `EXPIRED` are the four the spec allows, and which status each
 * writes is `packages/orders`' business — so this suite asserts that the enum is closed (a fifth reason is
 * a `400`, not a silent default) and that everything else about the request is the same shape as its
 * neighbours: origin, session, merchant, and one status per `CsError.code`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { csError, err, ok } from '@countersign/core'

const auth = vi.hoisted(() => ({ requireMerchant: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireMerchant: auth.requireMerchant }))

const merchantContext = vi.hoisted(() => ({ merchantIdFor: vi.fn() }))
vi.mock('@/lib/merchant-context', () => ({ merchantIdFor: merchantContext.merchantIdFor }))

const orderOps = vi.hoisted(() => ({ orderOpsDeps: vi.fn(), voidOrderForMerchant: vi.fn() }))
vi.mock('@/lib/order-ops', () => orderOps)

import { POST } from './route'

const CONTEXT = { params: Promise.resolve({ id: 'ord_1' }) }
const URL = 'http://localhost/api/orders/ord_1/void'

const OUTCOME = {
  orderId: 'ord_1',
  merchantId: 'mer_1',
  actorUserId: 'usr_merchant',
  paypalCalls: ['void'],
  auditId: 'aud_1',
  released: { minor: '6000', currency: 'USD' },
  orderStatus: 'VOIDED',
  viaAuthorizationVoid: false,
  alreadySettled: false,
}

const DEPS = { tagged: 'deps' }

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
  merchantContext.merchantIdFor.mockResolvedValue(ok('mer_1'))
  orderOps.orderOpsDeps.mockReturnValue(ok(DEPS))
  orderOps.voidOrderForMerchant.mockResolvedValue(ok(OUTCOME))
})

describe('POST /api/orders/[id]/void', () => {
  it('releases the remainder for the signed-in merchant and answers with what was released', async () => {
    const response = await POST(req({ reason: 'OUT_OF_STOCK' }), CONTEXT)
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body).toEqual(OUTCOME)
    expect(orderOps.voidOrderForMerchant).toHaveBeenCalledWith(
      {
        orderId: 'ord_1',
        merchantId: 'mer_1',
        actorUserId: 'usr_merchant',
        reason: 'OUT_OF_STOCK',
      },
      DEPS,
    )
  })

  it.each(['OUT_OF_STOCK', 'REVOKED', 'CANCELLED', 'EXPIRED'] as const)(
    'accepts the reason %s',
    async (reason) => {
      const { status } = await read(await POST(req({ reason }), CONTEXT))
      expect(status).toBe(200)
    },
  )

  it('refuses a reason outside the spec’s four with 400, rather than defaulting one', async () => {
    const { status } = await read(await POST(req({ reason: 'BECAUSE' }), CONTEXT))
    expect(status).toBe(400)
    expect(orderOps.voidOrderForMerchant).not.toHaveBeenCalled()
  })

  it('refuses an anonymous caller with 401 before any release', async () => {
    auth.requireMerchant.mockResolvedValue(err(csError('CS_UNAUTHENTICATED', 'Sign in first.')))
    const { status, body } = await read(await POST(req({ reason: 'CANCELLED' }), CONTEXT))
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(orderOps.voidOrderForMerchant).not.toHaveBeenCalled()
  })

  it('refuses a signed-in buyer with 403', async () => {
    auth.requireMerchant.mockResolvedValue(
      err(csError('CS_FORBIDDEN', 'Buyers do not void orders.')),
    )
    const { status } = await read(await POST(req({ reason: 'CANCELLED' }), CONTEXT))
    expect(status).toBe(403)
    expect(orderOps.voidOrderForMerchant).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin POST with 403 before reading the body', async () => {
    const { status } = await read(
      await POST(req({ reason: 'CANCELLED' }, { origin: 'https://attacker.test' }), CONTEXT),
    )
    expect(status).toBe(403)
    expect(orderOps.voidOrderForMerchant).not.toHaveBeenCalled()
  })

  it('passes a settled order through as ok, with no PayPal call claimed', async () => {
    orderOps.voidOrderForMerchant.mockResolvedValue(
      ok({
        ...OUTCOME,
        paypalCalls: [],
        alreadySettled: true,
        released: { minor: '0', currency: 'USD' },
      }),
    )
    const { status, body } = await read(await POST(req({ reason: 'OUT_OF_STOCK' }), CONTEXT))
    expect(status).toBe(200)
    expect(body['paypalCalls']).toEqual([])
    expect(body['alreadySettled']).toBe(true)
  })

  it.each([
    ['CS_NOT_FOUND', 404],
    ['CS_VALIDATION', 400],
    ['PP_NOT_FOUND', 404],
    ['PP_AUTH_EXPIRED', 409],
    ['PP_UNAVAILABLE', 503],
  ] as const)('maps %s to %i', async (code, status) => {
    orderOps.voidOrderForMerchant.mockResolvedValue(err(csError(code, `${code} from the void`)))
    const { status: actual, body } = await read(await POST(req({ reason: 'CANCELLED' }), CONTEXT))
    expect(actual).toBe(status)
    expect(body.error?.code).toBe(code)
  })
})
