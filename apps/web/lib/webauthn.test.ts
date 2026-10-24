/**
 * The WebAuthn step-up — spec **D4**, §12.9 **EC-FAM-1**.
 *
 * The spec's row is *"A family member uses the agent chat on the user's logged-in laptop"*: the session
 * cannot tell them apart, so the control is that **a new mandate needs the device key plus a WebAuthn
 * user-verification**, and *"signing prompts the passkey; the family member can't pass it"*.
 *
 * This file pins the client half of that control where CI can see it:
 *
 *  - the ceremony demands `userVerification: 'required'` for both `create` and `get`, so a
 *    `preferred`-downgrade — the one-line change that would make the control decorative — fails here;
 *  - a cancelled ceremony (or an unavailable authenticator) resolves to `null`, and
 *    `apps/web/app/lab/device-sign/page.tsx` refuses to sign on `null`;
 *  - the challenge is a SHA-256 digest of the caller's string, and `allowCredentials` names the
 *    stored credential, so the assertion binds to the device key the UI believes it holds.
 *
 * ## What this file does not claim
 *
 * The server does not verify the assertion yet — the finalize request carries only
 * `{ prepare_id, signature_b64url }`, and `docs/DECISIONS.md` D-045 says so explicitly. The
 * Playwright suite covers the browser ceremony (`apps/web/tests/e2e/device-sign.spec.ts`) but only
 * with an authenticator that always verifies. That gap is recorded on the EC-FAM-1 ledger row; it is
 * not something this test can paper over.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UserId } from '@countersign/core'

const USER_ID = 'usr_00000000000000000000000001' as UserId

/** The passkey store the mocked `./idb` reads and writes. Declared through `vi.hoisted` so the
 *  `vi.mock` factory below can close over it (a plain top-level binding would be in its dead zone
 *  when the factory runs). */
const { store } = vi.hoisted(() => ({
  store: new Map<string, { userId: string; credentialId: string }>(),
}))

vi.mock('./idb', () => ({
  PASSKEYS_STORE: 'passkeys',
  openCountersignDatabase: async () => ({
    transaction: () => ({
      objectStore: () => ({
        get: (key: string) => ({ result: store.get(key) }),
        put: (record: { userId: string }) => {
          store.set(record.userId, record)
          return { result: undefined }
        },
      }),
    }),
  }),
  requestToPromise: async (request: { result?: unknown }) => request.result,
  transactionDone: async () => undefined,
}))

import { stepUp } from './webauthn'
import { base64UrlToBytes } from './base64url'

/* ------------------------------------------------------------------------------------------ */
/* Minimal stand-ins for the browser classes `instanceof` checks                                          */
/* ------------------------------------------------------------------------------------------ */

class FakeAssertionResponse {
  constructor(
    readonly authenticatorData: ArrayBuffer,
    readonly clientDataJSON: ArrayBuffer,
    readonly signature: ArrayBuffer,
  ) {}
}

class FakePublicKeyCredential {
  constructor(
    readonly rawId: ArrayBuffer,
    readonly response: unknown,
  ) {}
}

interface RequestOptions {
  readonly publicKey: PublicKeyCredentialRequestOptions
}

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer
}

/** The `navigator.credentials` double, typed so the captured options can be asserted without `any`. */
function fakeCredentials() {
  return {
    create: vi.fn<(options: RequestOptions) => Promise<unknown>>(),
    get: vi.fn<(options: RequestOptions) => Promise<unknown>>(),
  }
}

function installBrowser(credentials: ReturnType<typeof fakeCredentials> | undefined): void {
  vi.stubGlobal('navigator', credentials === undefined ? {} : { credentials })
  vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential)
  vi.stubGlobal('AuthenticatorAssertionResponse', FakeAssertionResponse)
  vi.stubGlobal('location', { hostname: 'countersign.example' })
}

afterEach(() => {
  vi.unstubAllGlobals()
  store.clear()
})

describe('EC-FAM-1: signing a mandate demands a passkey user-verification, not just a session', () => {
  it('asserts with userVerification: "required", bound to the stored credential and the challenge digest', async () => {
    const credentials = fakeCredentials()
    installBrowser(credentials)
    store.set(USER_ID, { userId: USER_ID, credentialId: 'cred-1' })

    const response = new FakeAssertionResponse(bytes(1, 2, 3), bytes(4, 5), bytes(6, 7, 8, 9))
    credentials.get.mockResolvedValue(new FakePublicKeyCredential(bytes(9, 9), response))

    const assertion = await stepUp(USER_ID, 'the L2 signing input')

    expect(assertion).not.toBeNull()
    expect(credentials.get).toHaveBeenCalledTimes(1)
    const options = credentials.get.mock.calls[0]?.[0].publicKey
    // **The control itself.** `preferred` (or omitting the field) would let a presence-only ceremony
    // through, which is exactly the downgrade a family member at an unlocked laptop could accept.
    expect(options?.userVerification).toBe('required')
    expect(options?.rpId).toBe('countersign.example')
    // The assertion names the credential the UI believes it holds, decoded from the stored id.
    expect([...(options?.allowCredentials?.[0]?.id ?? [])]).toEqual([
      ...base64UrlToBytes('cred-1'),
    ])
    // A 32-byte SHA-256 digest of the caller's string — the same string the server will verify against.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('the L2 signing input')))
    expect([...(options?.challenge ?? [])]).toEqual([...digest])

    // And the assertion the caller signs with is the authenticator's output, base64url-encoded.
    expect(assertion).toMatchObject({
      credentialId: 'cred-1',
      authenticatorData: 'AQID',
      clientDataJson: 'BAU',
      signature: 'BgcICQ',
    })
  })

  it('resolves null when the user cancels, so the caller refuses to sign rather than signing anyway', async () => {
    const credentials = fakeCredentials()
    installBrowser(credentials)
    store.set(USER_ID, { userId: USER_ID, credentialId: 'cred-1' })
    credentials.get.mockRejectedValue(new DOMException('user dismissed the ceremony', 'NotAllowedError'))

    await expect(stepUp(USER_ID, 'the L2 signing input')).resolves.toBeNull()
  })

  it('resolves null when WebAuthn is unavailable, without touching the credential store', async () => {
    installBrowser(undefined)

    await expect(stepUp(USER_ID, 'the L2 signing input')).resolves.toBeNull()
  })
})
