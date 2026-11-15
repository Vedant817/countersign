/**
 * The buyer-side signing flow — `signMandate` in `./mandate-sign`.
 *
 * The subject is the **order and the refusals**, not crypto: `getOrCreateDeviceKey` and
 * `signSigningInput` are the real browser modules' contracts (their own tests cover the bytes), and
 * `stepUp` is doubled because a passkey ceremony cannot run in Node. What this file pins down is the
 * property the commit exists for — **nothing is signed on any refusal path** — plus the exact
 * `signingInput` that reaches the signer, byte for byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const keystore = vi.hoisted(() => ({
  getOrCreateDeviceKey: vi.fn(),
  signSigningInput: vi.fn(),
}))
vi.mock('@/lib/browser-keystore', () => keystore)

const webauthn = vi.hoisted(() => ({ stepUp: vi.fn() }))
vi.mock('@/lib/webauthn', () => webauthn)

import { signMandate } from './mandate-sign'

const USER_ID = 'usr_01J8ZQ3V2X4K9C1B7N6M5P4Q3R2' as const

const DEVICE_KEY = {
  kid: 'dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  publicJwk: {
    kty: 'EC',
    crv: 'P-256',
    x: 'O4FtJe276NHEecbpaZH18gKk9elqvIWCVIskodeuvRU',
    y: 'Ub3ywThuUxNRzlQ_KlC8tmSATIC6CymFmdoVWTNvLVk',
  },
  jkt: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  createdAt: 1_800_000_000,
}

const PREPARE_OK = {
  prepareId: 'prepare_1',
  signingInput: 'header.payload',
  readback: '**What you are authorising**\n\nA $50 cap.',
  readback_summary: 'A $50 cap.',
  cap_display: '$50.00',
  expires_at_epoch_sec: 1_800_086_400,
  pending: 'pending-token',
}

const FINALIZE_OK = {
  user_id: USER_ID,
  mandate_id: 'mdt_1',
  agent_id: 'agt_1',
  agent_kid: 'agent-key-1',
  readback: '**What you are authorising**\n\nA $50 cap.',
  readback_summary: 'A $50 cap.',
  expires_at_epoch_sec: 1_800_086_400,
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function baseInput(overrides: Partial<Parameters<typeof signMandate>[0]> = {}) {
  return {
    userId: USER_ID as never,
    intent: 'Buy running shoes under $50',
    capMinor: 5000n,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  keystore.getOrCreateDeviceKey.mockResolvedValue(DEVICE_KEY)
  keystore.signSigningInput.mockResolvedValue('c2lnbmF0dXJlLWJ5dGVz')
  webauthn.stepUp.mockResolvedValue({
    credentialId: 'cred_1',
    authenticatorData: 'YQ',
    clientDataJson: 'eyJ',
    signature: 'c2ln',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('signMandate — the happy path', () => {
  it('calls prepare -> stepUp -> sign -> finalize in order, signing the exact signingInput', async () => {
    const calls: string[] = []
    keystore.getOrCreateDeviceKey.mockImplementation(async () => {
      calls.push('key')
      return DEVICE_KEY
    })
    webauthn.stepUp.mockImplementation(async (_userId: unknown, challenge: string) => {
      calls.push(`stepUp:${challenge}`)
      return {
        credentialId: 'cred_1',
        authenticatorData: 'YQ',
        clientDataJson: 'eyJ',
        signature: 'c2ln',
      }
    })
    keystore.signSigningInput.mockImplementation(async (kid: string, input: string) => {
      calls.push(`sign:${kid}:${input}`)
      return 'c2lnbmF0dXJlLWJ5dGVz'
    })
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push(`fetch:${url}:${JSON.stringify(body)}`)
      if (url === '/api/agent/mandate/prepare') {
        return jsonResponse(200, PREPARE_OK)
      }
      return jsonResponse(200, FINALIZE_OK)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await signMandate(baseInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.mandateId).toBe('mdt_1')
    expect(result.session.readbackSummary).toBe('A $50 cap.')

    // The order is the contract: nothing is signed before the ceremony, nothing is finalized before
    // the signature.
    expect(calls[0]).toBe('key')
    expect(calls[1]).toContain('fetch:/api/agent/mandate/prepare:')
    expect(calls[2]).toBe(`stepUp:${PREPARE_OK.signingInput}`)
    expect(calls[3]).toBe(`sign:${DEVICE_KEY.kid}:${PREPARE_OK.signingInput}`)
    expect(calls[4]).toContain('fetch:/api/agent/mandate/finalize:')

    // The prepare body carries the browser's own device key, and nothing else identifies the buyer.
    const prepareBody = JSON.parse(
      calls[1]!.slice('fetch:/api/agent/mandate/prepare:'.length),
    ) as Record<string, unknown>
    expect(prepareBody).toEqual({
      intent: 'Buy running shoes under $50',
      cap_minor: 5000,
      deviceKid: DEVICE_KEY.kid,
      devicePublicJwk: DEVICE_KEY.publicJwk,
    })

    // The finalize body carries exactly what the finalize route's schema accepts — and no `user_id`.
    const finalizeBody = JSON.parse(
      calls[4]!.slice('fetch:/api/agent/mandate/finalize:'.length),
    ) as Record<string, unknown>
    expect(finalizeBody).toEqual({
      pending: PREPARE_OK.pending,
      prepareId: PREPARE_OK.prepareId,
      signatureB64Url: 'c2lnbmF0dXJlLWJ5dGVz',
    })
  })

  it('shows the prepare read-back to the buyer before the passkey prompt', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/agent/mandate/prepare'
          ? jsonResponse(200, PREPARE_OK)
          : jsonResponse(200, FINALIZE_OK),
      ),
    )
    webauthn.stepUp.mockImplementation(async () => {
      seen.push('stepUp')
      return {
        credentialId: 'cred_1',
        authenticatorData: 'YQ',
        clientDataJson: 'eyJ',
        signature: 'c2ln',
      }
    })

    let prepared: { readbackSummary: string; capDisplay: string } | null = null
    await signMandate(
      baseInput({
        onPrepared: (view) => {
          prepared = { readbackSummary: view.readbackSummary, capDisplay: view.capDisplay }
          seen.push('onPrepared')
        },
      }),
    )

    expect(prepared).toEqual({ readbackSummary: 'A $50 cap.', capDisplay: '$50.00' })
    expect(seen).toEqual(['onPrepared', 'stepUp'])
  })
})

describe('signMandate — refusals sign nothing', () => {
  it('a prepare 400 surfaces the server’s question and never calls stepUp or sign', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, {
        error: {
          code: 'CS_VALIDATION',
          message: 'the intent is ambiguous',
          userMessage: 'What is the most you would pay?',
          retryable: false,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await signMandate(baseInput({ intent: 'something warm for the trip' }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('refused')
    expect(result.userMessage).toBe('What is the most you would pay?')
    expect(webauthn.stepUp).not.toHaveBeenCalled()
    expect(keystore.signSigningInput).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('/api/agent/mandate/prepare')
  })

  it('stepUp returning null means no sign and no finalize', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/agent/mandate/prepare'
        ? jsonResponse(200, PREPARE_OK)
        : jsonResponse(200, FINALIZE_OK),
    )
    vi.stubGlobal('fetch', fetchMock)
    webauthn.stepUp.mockResolvedValue(null)

    const result = await signMandate(baseInput())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('cancelled')
    expect(result.userMessage).toBe(
      'Confirmation with your passkey was cancelled — nothing was signed.',
    )
    expect(keystore.signSigningInput).not.toHaveBeenCalled()
    // Only the prepare call was made; the mandate was never written.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stepUp throwing means no sign and no finalize, and says why', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/agent/mandate/prepare'
        ? jsonResponse(200, PREPARE_OK)
        : jsonResponse(200, FINALIZE_OK),
    )
    vi.stubGlobal('fetch', fetchMock)
    webauthn.stepUp.mockRejectedValue(new Error('the authenticator is busy'))

    const result = await signMandate(baseInput())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('cancelled')
    expect(result.userMessage).toContain('the authenticator is busy')
    expect(result.userMessage).toContain('Nothing was signed')
    expect(keystore.signSigningInput).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a finalize 403 surfaces the server’s sentence and does not pretend the mandate exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/agent/mandate/prepare'
          ? jsonResponse(200, PREPARE_OK)
          : jsonResponse(403, {
              error: {
                code: 'CS_FORBIDDEN',
                message: 'the token names another buyer',
                userMessage: 'That mandate is not yours.',
                retryable: false,
              },
            }),
      ),
    )

    const result = await signMandate(baseInput())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('refused')
    expect(result.userMessage).toBe('That mandate is not yours.')
    // The signature was still produced (the key is the browser's own), but nothing was finalized.
    expect(keystore.signSigningInput).toHaveBeenCalledTimes(1)
  })
})
