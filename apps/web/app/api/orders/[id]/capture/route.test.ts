/**
 * `POST /api/orders/{id}/capture` — the HTTP boundary, not the capture — spec §8.11, S-15.
 *
 * `lib/order-ops.test.ts` proves the guards, the audit row and the ownership check; this suite proves the
 * shape around them: that an anonymous caller is `401` before any capture is attempted, that a cross-origin
 * `POST` is refused before the body is parsed, that a typo'd field is a `400` rather than a silently
 * ignored one, and that every `CsError.code` the operation can produce reaches the merchant as the status
 * the registry gives it. The last one matters most: a PayPal `404` on an authorisation that vanished must
 * be a `404` the merchant can read, never a `200` claiming money moved.
 *
 * The session, the merchant lookup and the operation are doubles. This is the transport, and a transport
 * test that needed a database would be testing two things at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { csError, err, ok } from '@countersign/core'

const auth = vi.hoisted(() => ({ requireMerchant: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireMerchant: auth.requireMerchant }))

const merchantContext = vi.hoisted(() => ({ merchantIdFor: vi.fn() }))
vi.mock('@/lib/merchant-context', () => ({ merchantIdFor: merchantContext.merchantIdFor }))

const orderOps = vi.hoisted(() => ({
  orderOpsDeps: vi.fn(),
  captureShipmentForMerchant: vi.fn(),
}))
vi.mock('@/lib/order-ops', () => orderOps)

import { POST } from './route'

const CONTEXT = { params: Promise.resolve({ id: 'ord_1' }) }
const URL = 'http://localhost/api/orders/ord_1/capture'

const OUTCOME = {
  orderId: 'ord_1',
  merchantId: 'mer_1',
  actorUserId: 'usr_merchant',
  paypalCalls: ['capture', 'track'],
  auditId: 'aud_1',
  captureId: 'cap_1',
  paypalCaptureId: 'PP-CAP-1',
  captureStatus: 'COMPLETED',
  amount: { minor: '4000', currency: 'USD' },
  remainingAfter: { minor: '6000', currency: 'USD' },
  finalCapture: false,
  pending: false,
  trackingOnly: false,
  shipmentId: 'shp_1',
  requestId: 'cs:auth:cap:shp',
}

const BODY = { carrier: 'DHL', tracking: 'T1', lines: [{ sku: 'NW-001', qty: 1 }] }
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
  orderOps.captureShipmentForMerchant.mockResolvedValue(ok(OUTCOME))
})

describe('POST /api/orders/[id]/capture', () => {
  it('captures for the signed-in merchant and answers with the receipt', async () => {
    const response = await POST(req(BODY), CONTEXT)
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body).toEqual(OUTCOME)
    expect(orderOps.captureShipmentForMerchant).toHaveBeenCalledWith(
      {
        orderId: 'ord_1',
        merchantId: 'mer_1',
        actorUserId: 'usr_merchant',
        shipment: { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'DHL', tracking: 'T1' },
      },
      DEPS,
    )
  })

  it('passes the optional capture note and final_capture through', async () => {
    await POST(req({ ...BODY, noteToPayer: 'On its way.', finalCapture: true }), CONTEXT)
    expect(orderOps.captureShipmentForMerchant).toHaveBeenCalledWith(
      expect.objectContaining({
        shipment: expect.objectContaining({ noteToPayer: 'On its way.', finalCapture: true }),
      }),
      DEPS,
    )
  })

  it('refuses an anonymous caller with 401 before any capture is attempted', async () => {
    auth.requireMerchant.mockResolvedValue(
      err(csError('CS_UNAUTHENTICATED', 'A merchant sign-in is required for this route.')),
    )
    const { status, body } = await read(await POST(req(BODY), CONTEXT))
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(orderOps.captureShipmentForMerchant).not.toHaveBeenCalled()
  })

  it('refuses a signed-in buyer with 403, so money cannot be captured by the other side', async () => {
    auth.requireMerchant.mockResolvedValue(
      err(
        csError(
          'CS_FORBIDDEN',
          'The signed-in account is a BUYER, and orders belong to the merchant.',
        ),
      ),
    )
    const { status, body } = await read(await POST(req(BODY), CONTEXT))
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(orderOps.captureShipmentForMerchant).not.toHaveBeenCalled()
  })

  it('answers 403 when the merchant has no merchants row', async () => {
    merchantContext.merchantIdFor.mockResolvedValue(
      err(csError('CS_FORBIDDEN', 'Merchant user usr_merchant has no merchants row.')),
    )
    const { status } = await read(await POST(req(BODY), CONTEXT))
    expect(status).toBe(403)
    expect(orderOps.captureShipmentForMerchant).not.toHaveBeenCalled()
  })

  it('refuses a body that is not JSON with 400', async () => {
    const { status, body } = await read(await POST(req('not json'), CONTEXT))
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
  })

  it('refuses a shipment with no lines, because there is nothing to capture against', async () => {
    const { status } = await read(await POST(req({ ...BODY, lines: [] }), CONTEXT))
    expect(status).toBe(400)
  })

  it('refuses a zero or negative quantity with 400', async () => {
    expect(
      (await read(await POST(req({ ...BODY, lines: [{ sku: 'NW-001', qty: 0 }] }), CONTEXT)))
        .status,
    ).toBe(400)
    expect(
      (await read(await POST(req({ ...BODY, lines: [{ sku: 'NW-001', qty: -1 }] }), CONTEXT)))
        .status,
    ).toBe(400)
  })

  it('refuses an extra field rather than silently dropping it', async () => {
    // `amount_minor` is the field this route must never accept: the amount is the authorisation's.
    const { status, body } = await read(await POST(req({ ...BODY, amount_minor: '1' }), CONTEXT))
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(orderOps.captureShipmentForMerchant).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin POST with 403 before reading the body', async () => {
    const { status, body } = await read(
      await POST(req(BODY, { origin: 'https://attacker.test' }), CONTEXT),
    )
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(orderOps.captureShipmentForMerchant).not.toHaveBeenCalled()
  })

  it('answers 500 when PayPal is not configured, naming the variable rather than an opaque failure', async () => {
    orderOps.orderOpsDeps.mockReturnValue(
      err(csError('CS_INTERNAL', 'PayPal is not configured: PAYPAL_CLIENT_ID unset')),
    )
    const { status, body } = await read(await POST(req(BODY), CONTEXT))
    expect(status).toBe(500)
    expect(body.error?.code).toBe('CS_INTERNAL')
    expect(orderOps.captureShipmentForMerchant).not.toHaveBeenCalled()
  })

  it.each([
    ['CS_NOT_FOUND', 404],
    ['CS_FORBIDDEN', 403],
    ['CS_VALIDATION', 400],
    ['CS_CONFLICT', 409],
    ['PP_NOT_FOUND', 404],
    ['PP_UNAVAILABLE', 503],
    ['PP_INSTRUMENT_DECLINED', 402],
  ] as const)('maps %s to %i', async (code, status) => {
    orderOps.captureShipmentForMerchant.mockResolvedValue(
      err(csError(code, `${code} from the capture`)),
    )
    const { status: actual, body } = await read(await POST(req(BODY), CONTEXT))
    expect(actual).toBe(status)
    expect(body.error?.code).toBe(code)
  })
})
