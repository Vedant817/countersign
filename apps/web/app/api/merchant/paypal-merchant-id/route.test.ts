/**
 * `POST /api/merchant/paypal-merchant-id` — the HTTP transport boundary.
 *
 * Verifies that:
 * - cross-origin requests are refused before anything else (403)
 * - anonymous requests are refused (401)
 * - non-merchant (buyer) callers are refused (403)
 * - missing merchant row is refused (403)
 * - malformed PayPal merchant IDs ('abc', 14 chars, symbols) are rejected (400)
 * - valid IDs are trimmed, uppercased, saved via setPaypalMerchantId, audited, and returned (200)
 * - duplicate PayPal merchant IDs map to 409 with the clear user message
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { csError, err, ok } from '@countersign/core'
import type * as DbModule from '@countersign/db'

const auth = vi.hoisted(() => ({ requireMerchant: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireMerchant: auth.requireMerchant }))

const merchantContext = vi.hoisted(() => ({ merchantIdFor: vi.fn() }))
vi.mock('@/lib/merchant-context', () => ({ merchantIdFor: merchantContext.merchantIdFor }))

const dbMock = vi.hoisted(() => ({
  setPaypalMerchantId: vi.fn(),
  appendAudit: vi.fn(),
}))
vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...dbMock,
}))

import { POST } from './route'

const URL = 'http://localhost/api/merchant/paypal-merchant-id'

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

const MERCHANT_USER = {
  id: 'usr_merchant',
  persona: 'MERCHANT',
  displayName: 'Northwind Merchant',
  email: 'merchant@example.test',
}

const MERCHANT_ID = 'mer_01HZX000000000000000000001'

beforeEach(() => {
  vi.clearAllMocks()
  auth.requireMerchant.mockResolvedValue(ok(MERCHANT_USER))
  merchantContext.merchantIdFor.mockResolvedValue(ok(MERCHANT_ID))
  dbMock.setPaypalMerchantId.mockResolvedValue(
    ok({
      id: MERCHANT_ID,
      owner_user_id: MERCHANT_USER.id,
      display_name: MERCHANT_USER.displayName,
      paypal_merchant_id: '2M8QY2W4P5L79',
    }),
  )
  dbMock.appendAudit.mockResolvedValue(ok({ id: 'aud_test' }))
})

describe('POST /api/merchant/paypal-merchant-id', () => {
  it('refuses a cross-origin POST with 403 before reading the body', async () => {
    const response = await POST(
      req({ paypalMerchantId: '2M8QY2W4P5L79' }, { origin: 'https://attacker.test' }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(dbMock.setPaypalMerchantId).not.toHaveBeenCalled()
  })

  it('refuses an anonymous caller with 401', async () => {
    auth.requireMerchant.mockResolvedValue(
      err(csError('CS_UNAUTHENTICATED', 'A merchant sign-in is required for this route.')),
    )
    const response = await POST(req({ paypalMerchantId: '2M8QY2W4P5L79' }))
    const { status, body } = await read(response)
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(dbMock.setPaypalMerchantId).not.toHaveBeenCalled()
  })

  it('refuses a signed-in buyer with 403', async () => {
    auth.requireMerchant.mockResolvedValue(
      err(
        csError(
          'CS_FORBIDDEN',
          'The signed-in account is a BUYER, and disputes belong to the merchant.',
        ),
      ),
    )
    const response = await POST(req({ paypalMerchantId: '2M8QY2W4P5L79' }))
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(dbMock.setPaypalMerchantId).not.toHaveBeenCalled()
  })

  it('refuses when the merchant user has no merchants row with 403', async () => {
    merchantContext.merchantIdFor.mockResolvedValue(
      err(csError('CS_FORBIDDEN', 'Merchant user usr_merchant has no merchants row.')),
    )
    const response = await POST(req({ paypalMerchantId: '2M8QY2W4P5L79' }))
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(dbMock.setPaypalMerchantId).not.toHaveBeenCalled()
  })

  it('refuses a body that is not JSON with 400', async () => {
    const response = await POST(req('not valid json'))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(dbMock.setPaypalMerchantId).not.toHaveBeenCalled()
  })

  it.each([
    ['abc', 'too short'],
    ['12345678901234', '14 characters'],
    ['abc!@#$123456', 'lowercase with symbols'],
    ['2m8qy2w4p5l-!', 'hyphen and exclamation mark'],
    ['', 'empty string'],
  ])('refuses bad id (%s - %s) with 400 CS_VALIDATION', async (badId) => {
    const response = await POST(req({ paypalMerchantId: badId }))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(body.error?.userMessage).toBeDefined()
    expect(dbMock.setPaypalMerchantId).not.toHaveBeenCalled()
  })

  it('refuses extra fields in the request body with 400', async () => {
    const response = await POST(
      req({ paypalMerchantId: '2M8QY2W4P5L79', extraField: 'not allowed' }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(dbMock.setPaypalMerchantId).not.toHaveBeenCalled()
  })

  it('accepts a valid id, uppercasing and trimming it, updates db and records audit', async () => {
    const response = await POST(req({ paypalMerchantId: '  2m8qy2w4p5l79  ' }))
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body).toEqual({
      merchantId: MERCHANT_ID,
      paypalMerchantId: '2M8QY2W4P5L79',
    })
    expect(dbMock.setPaypalMerchantId).toHaveBeenCalledWith(MERCHANT_ID, '2M8QY2W4P5L79')
    expect(dbMock.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merchant.paypal_merchant_id.set',
        actor: MERCHANT_USER.id,
        subject: MERCHANT_ID,
        details: expect.objectContaining({
          merchant_id: MERCHANT_ID,
          paypal_merchant_id: '2M8QY2W4P5L79',
        }),
      }),
    )
  })

  it('returns 409 CS_CONFLICT with userMessage when PayPal merchant ID is already linked', async () => {
    dbMock.setPaypalMerchantId.mockResolvedValue(
      err(
        csError(
          'CS_CONFLICT',
          'Duplicate rejected by unique constraint merchants_paypal_merchant_id_key',
        ),
      ),
    )
    const response = await POST(req({ paypalMerchantId: '2M8QY2W4P5L79' }))
    const { status, body } = await read(response)
    expect(status).toBe(409)
    expect(body.error?.code).toBe('CS_CONFLICT')
    expect(body.error?.userMessage).toBe(
      'That PayPal merchant ID is already linked to another Countersign merchant.',
    )
    expect(dbMock.appendAudit).not.toHaveBeenCalled()
  })

  it('maps other repository errors according to the error registry', async () => {
    dbMock.setPaypalMerchantId.mockResolvedValue(
      err(csError('CS_INTERNAL', 'Database connection unavailable')),
    )
    const response = await POST(req({ paypalMerchantId: '2M8QY2W4P5L79' }))
    const { status, body } = await read(response)
    expect(status).toBe(500)
    expect(body.error?.code).toBe('CS_INTERNAL')
    expect(dbMock.appendAudit).not.toHaveBeenCalled()
  })
})
