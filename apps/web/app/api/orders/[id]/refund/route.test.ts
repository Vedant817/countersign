/**
 * `POST /api/orders/{id}/refund` — the HTTP boundary, not the refund — spec §8.11, S-15.
 *
 * Three things this suite owns that `lib/order-ops.test.ts` cannot:
 *
 *  1. **The amount is a string, not a number.** `minor` is validated as decimal digits and rebuilt as a
 *     `bigint` before it reaches `packages/orders`; a JSON float, an exponent or a negative is a `400`.
 *  2. **`idempotencyKey` is mandatory.** EC-IDEM-5's "a double-clicked button is one refund" is only true
 *     if the caller says which click it was, so a body without one never reaches the refund.
 *  3. **A capture id is ours.** `cap_…`, not PayPal's `PP-CAP-…`; the route hands `packages/orders` the
 *     PayPal id it looked up, and this is the check that keeps a PayPal-shaped guess out.
 *
 * The session, the merchant lookup and the operation are doubles.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { csError, err, ok } from '@countersign/core'

const auth = vi.hoisted(() => ({ requireMerchant: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireMerchant: auth.requireMerchant }))

const merchantContext = vi.hoisted(() => ({ merchantIdFor: vi.fn() }))
vi.mock('@/lib/merchant-context', () => ({ merchantIdFor: merchantContext.merchantIdFor }))

const orderOps = vi.hoisted(() => ({ orderOpsDeps: vi.fn(), refundForMerchant: vi.fn() }))
vi.mock('@/lib/order-ops', () => orderOps)

import { POST } from './route'

const CONTEXT = { params: Promise.resolve({ id: 'ord_1' }) }
const URL = 'http://localhost/api/orders/ord_1/refund'

const OUTCOME = {
  orderId: 'ord_1',
  merchantId: 'mer_1',
  actorUserId: 'usr_merchant',
  paypalCalls: ['refund'],
  auditId: 'aud_1',
  refundId: 'ref_1',
  captureId: 'cap_1',
  paypalCaptureId: 'PP-CAP-1',
  paypalRefundId: 'PP-REF-1',
  refundStatus: 'PENDING',
  amount: { minor: '2000', currency: 'USD' },
  refundableAfter: { minor: '8000', currency: 'USD' },
  reason: 'RETURN',
  requestId: 'cs:PP-CAP-1:ref:ref_1',
  blockedByDispute: null,
}

const DEPS = { tagged: 'deps' }

const BODY = {
  captureId: 'cap_1',
  amount: { minor: '2000', currency: 'USD' },
  reason: 'RETURN',
  idempotencyKey: 'form-nonce-abc123',
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
  merchantContext.merchantIdFor.mockResolvedValue(ok('mer_1'))
  orderOps.orderOpsDeps.mockReturnValue(ok(DEPS))
  orderOps.refundForMerchant.mockResolvedValue(ok(OUTCOME))
})

describe('POST /api/orders/[id]/refund', () => {
  it('refunds the exact amount for the signed-in merchant and answers with the receipt', async () => {
    const response = await POST(req(BODY), CONTEXT)
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body).toEqual(OUTCOME)
    expect(orderOps.refundForMerchant).toHaveBeenCalledWith(
      {
        orderId: 'ord_1',
        merchantId: 'mer_1',
        actorUserId: 'usr_merchant',
        captureId: 'cap_1',
        // A `bigint`, built from the decimal string — never a float, never a `number`.
        amount: { minor: 2_000n, currency: 'USD' },
        reason: 'RETURN',
        idempotencyKey: 'form-nonce-abc123',
      },
      DEPS,
    )
  })

  it("passes 'FULL' through as the exact remainder, without inventing an amount", async () => {
    const { status } = await read(await POST(req({ ...BODY, amount: 'FULL' }), CONTEXT))
    expect(status).toBe(200)
    expect(orderOps.refundForMerchant).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 'FULL' }),
      DEPS,
    )
  })

  it('passes the note to the payer and the stored justification through', async () => {
    await POST(req({ ...BODY, noteToPayer: 'Sorry about that.', note: 'arrived damaged' }), CONTEXT)
    expect(orderOps.refundForMerchant).toHaveBeenCalledWith(
      expect.objectContaining({ noteToPayer: 'Sorry about that.', note: 'arrived damaged' }),
      DEPS,
    )
  })

  it('refuses a float amount with 400, because money is integer minor units', async () => {
    const { status } = await read(
      await POST(req({ ...BODY, amount: { minor: '20.00', currency: 'USD' } }), CONTEXT),
    )
    expect(status).toBe(400)
    expect(orderOps.refundForMerchant).not.toHaveBeenCalled()
  })

  it.each(['-1', '1e3', '0x10', ' 1'] as const)(
    'refuses the amount %s as not-a-decimal-integer',
    async (minor) => {
      const { status } = await read(
        await POST(req({ ...BODY, amount: { minor, currency: 'USD' } }), CONTEXT),
      )
      expect(status).toBe(400)
    },
  )

  it('refuses a currency outside the registry with 400', async () => {
    const { status } = await read(
      await POST(req({ ...BODY, amount: { minor: '2000', currency: 'XYZ' } }), CONTEXT),
    )
    expect(status).toBe(400)
  })

  it('refuses a PayPal-shaped capture id with 400, so only our own rows are addressable', async () => {
    const { status, body } = await read(
      await POST(req({ ...BODY, captureId: 'PP-CAP-1' }), CONTEXT),
    )
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(orderOps.refundForMerchant).not.toHaveBeenCalled()
  })

  it('EC-IDEM-5: refuses a body with no idempotency key, so a double click cannot double-refund', async () => {
    const { idempotencyKey: _omitted, ...rest } = BODY
    const { status } = await read(await POST(req(rest), CONTEXT))
    expect(status).toBe(400)
    expect(orderOps.refundForMerchant).not.toHaveBeenCalled()
  })

  it('refuses a key too short to be a nonce with 400', async () => {
    const { status } = await read(await POST(req({ ...BODY, idempotencyKey: 'abc' }), CONTEXT))
    expect(status).toBe(400)
  })

  it('refuses an unknown refund reason with 400', async () => {
    const { status } = await read(await POST(req({ ...BODY, reason: 'VIBES' }), CONTEXT))
    expect(status).toBe(400)
  })

  it('refuses an extra field rather than silently dropping it', async () => {
    const { status } = await read(
      await POST(req({ ...BODY, actorUserId: 'usr_someone_else' }), CONTEXT),
    )
    expect(status).toBe(400)
    expect(orderOps.refundForMerchant).not.toHaveBeenCalled()
  })

  it('refuses an anonymous caller with 401 before any refund', async () => {
    auth.requireMerchant.mockResolvedValue(err(csError('CS_UNAUTHENTICATED', 'Sign in first.')))
    const { status, body } = await read(await POST(req(BODY), CONTEXT))
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(orderOps.refundForMerchant).not.toHaveBeenCalled()
  })

  it('refuses a signed-in buyer with 403', async () => {
    auth.requireMerchant.mockResolvedValue(
      err(csError('CS_FORBIDDEN', 'Buyers do not refund orders.')),
    )
    const { status } = await read(await POST(req(BODY), CONTEXT))
    expect(status).toBe(403)
    expect(orderOps.refundForMerchant).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin POST with 403 before reading the body', async () => {
    const { status } = await read(
      await POST(req(BODY, { origin: 'https://attacker.test' }), CONTEXT),
    )
    expect(status).toBe(403)
    expect(orderOps.refundForMerchant).not.toHaveBeenCalled()
  })

  it('propagates an over-refund refusal as 400, with no PayPal call implied', async () => {
    orderOps.refundForMerchant.mockResolvedValue(
      err(
        csError('CS_VALIDATION', 'Only 500 remains refundable.', undefined, {
          userMessage: 'Only $5.00 remains refundable.',
        }),
      ),
    )
    const { status, body } = await read(await POST(req(BODY), CONTEXT))
    expect(status).toBe(400)
    expect(body.error?.userMessage).toBe('Only $5.00 remains refundable.')
  })

  it('EC-REF-4: an open dispute is 409 with the dispute routes, never a success', async () => {
    orderOps.refundForMerchant.mockResolvedValue(
      err(
        csError('DEF_WRONG_STATE', 'Dispute PP-D-1 is open', {
          routes: ['POST /v1/customer/disputes/PP-D-1/accept-claim'],
        }),
      ),
    )
    const { status, body } = await read(await POST(req(BODY), CONTEXT))
    expect(status).toBe(409)
    expect(body.error?.code).toBe('DEF_WRONG_STATE')
  })

  it.each([
    ['CS_NOT_FOUND', 404],
    ['CS_CURRENCY_MISMATCH', 400],
    ['CS_CONFLICT', 409],
    ['PP_NOT_FOUND', 404],
    ['PP_UNAVAILABLE', 503],
  ] as const)('maps %s to %i', async (code, status) => {
    orderOps.refundForMerchant.mockResolvedValue(err(csError(code, `${code} from the refund`)))
    const { status: actual, body } = await read(await POST(req(BODY), CONTEXT))
    expect(actual).toBe(status)
    expect(body.error?.code).toBe(code)
  })
})
