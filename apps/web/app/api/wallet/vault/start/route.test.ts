import { beforeEach, describe, expect, it, vi } from 'vitest'

import { csError, err, ok } from '@countersign/core'

const auth = vi.hoisted(() => ({ requireBuyer: vi.fn() }))
vi.mock('@/lib/auth', () => auth)

const mockCreateSetupToken = vi.fn()
const paypal = vi.hoisted(() => ({
  paypalClient: vi.fn(),
}))
vi.mock('@/lib/paypal-client', () => paypal)

import { POST } from './route'

const URL = 'http://localhost/api/wallet/vault/start'
const BUYER = { id: 'usr_buyer', persona: 'BUYER', displayName: 'asha', email: 'asha@example.test' }

function req(): Request {
  return new Request(URL, {
    method: 'POST',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.requireBuyer.mockResolvedValue(ok(BUYER))
  mockCreateSetupToken.mockResolvedValue(
    ok({
      id: 'setup_tok_test_123',
      links: [
        {
          rel: 'approve',
          href: 'https://www.sandbox.paypal.com/setup?token=setup_tok_test_123',
        },
      ],
    }),
  )
  paypal.paypalClient.mockReturnValue(
    ok({
      createSetupToken: mockCreateSetupToken,
    }),
  )
})

describe('POST /api/wallet/vault/start', () => {
  it('refuses an unauthenticated request with 401 and does not call createSetupToken', async () => {
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

    const response = await POST(req())
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error?: { code: string; message: string } }
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(mockCreateSetupToken).not.toHaveBeenCalled()
  })

  it('redirects with 303 to the approve href and sets the cs_vault_setup cookie on happy path', async () => {
    const response = await POST(req())
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      'https://www.sandbox.paypal.com/setup?token=setup_tok_test_123',
    )
    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('cs_vault_setup=setup_tok_test_123')
    expect(setCookie.toLowerCase()).toContain('httponly')
    expect(setCookie).toContain('Path=/api/wallet/vault')
    expect(mockCreateSetupToken).toHaveBeenCalledTimes(1)
  })

  it('returns 502/503 JSON error and sets no cookie when startVault fails', async () => {
    mockCreateSetupToken.mockResolvedValue(
      err(
        csError(
          'PP_UNAVAILABLE',
          'PayPal unavailable',
          {},
          { retryable: true, userMessage: 'PayPal is temporarily down.' },
        ),
      ),
    )

    const response = await POST(req())
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error?: { code: string } }
    expect(body.error?.code).toBe('PP_UNAVAILABLE')
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})
