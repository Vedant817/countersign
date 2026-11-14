import { beforeEach, describe, expect, it, vi } from 'vitest'

import { csError, err, ok } from '@countersign/core'

const auth = vi.hoisted(() => ({ requireBuyer: vi.fn() }))
vi.mock('@/lib/auth', () => auth)

const mockCreatePaymentToken = vi.fn()
const paypal = vi.hoisted(() => ({
  paypalClient: vi.fn(),
}))
vi.mock('@/lib/paypal-client', () => paypal)

const db = vi.hoisted(() => ({
  upsertWalletByToken: vi.fn(),
}))
vi.mock('@countersign/db', () => db)

import { GET } from './route'

const URL = 'http://localhost/api/wallet/vault/return'
const BUYER = { id: 'usr_buyer', persona: 'BUYER', displayName: 'asha', email: 'asha@example.test' }

function req(query = '?approval_token_id=setup_123', cookie?: string): Request {
  const headers = new Headers()
  if (cookie) {
    headers.set('cookie', cookie)
  }
  return new Request(`${URL}${query}`, {
    method: 'GET',
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.requireBuyer.mockResolvedValue(ok(BUYER))
  mockCreatePaymentToken.mockResolvedValue(
    ok({
      id: 'tok_paypal_123',
      customer: { id: 'cust_456' },
      payment_source: {
        paypal: {
          account_id: 'payer_789',
          email_address: 'buyer@example.test',
        },
      },
    }),
  )
  paypal.paypalClient.mockReturnValue(
    ok({
      createPaymentToken: mockCreatePaymentToken,
    }),
  )
  db.upsertWalletByToken.mockResolvedValue(ok({ id: 'wal_test_123' }))
})

describe('GET /api/wallet/vault/return', () => {
  it('refuses an unauthenticated request with 401', async () => {
    auth.requireBuyer.mockResolvedValue(
      err(
        csError(
          'CS_UNAUTHENTICATED',
          'Sign in required',
          {},
          {
            userMessage: 'Please sign in first.',
          },
        ),
      ),
    )

    const response = await GET(req())
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error?: { code: string } }
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
  })

  it('returns 400 when approval_token_id is missing', async () => {
    const response = await GET(req(''))
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: { code: string; message: string } }
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(body.error?.message).toContain('Missing approval_token_id')
    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('cs_vault_setup=')
    expect(setCookie).toContain('Max-Age=0')
  })

  it('returns 400 and calls neither createPaymentToken nor upsertWalletByToken when cookie is missing', async () => {
    const response = await GET(req('?approval_token_id=setup_123'))
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: { code: string } }
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(mockCreatePaymentToken).not.toHaveBeenCalled()
    expect(db.upsertWalletByToken).not.toHaveBeenCalled()
    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('Max-Age=0')
  })

  it('returns 400 and saves nothing when cookie does not match approval_token_id', async () => {
    const response = await GET(req('?approval_token_id=setup_123', 'cs_vault_setup=other_token'))
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: { code: string } }
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(mockCreatePaymentToken).not.toHaveBeenCalled()
    expect(db.upsertWalletByToken).not.toHaveBeenCalled()
    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('Max-Age=0')
  })

  it('saves the wallet, clears the cookie, and 303 redirects on happy path', async () => {
    const response = await GET(req('?approval_token_id=setup_123', 'cs_vault_setup=setup_123'))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('http://localhost/?wallet=saved')

    expect(db.upsertWalletByToken).toHaveBeenCalledTimes(1)
    expect(db.upsertWalletByToken).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: BUYER.id,
        payment_token_id: 'tok_paypal_123',
        status: 'ACTIVE',
      }),
    )

    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('cs_vault_setup=')
    expect(setCookie).toContain('Max-Age=0')
    expect(setCookie).toContain('Path=/api/wallet/vault')
  })
})
