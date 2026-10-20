import type { UserId } from '@countersign/core'

import { base64UrlToBytes, bytesToBase64Url } from './base64url'
import { openCountersignDatabase, PASSKEYS_STORE, requestToPromise, transactionDone } from './idb'

export interface WebAuthnAssertion {
  credentialId: string
  authenticatorData: string
  clientDataJson: string
  signature: string
}

interface StoredPasskey {
  userId: UserId
  credentialId: string
}

const RP_NAME = 'Countersign'
const TIMEOUT_MS = 60_000
const ES256 = -7

export async function stepUp(userId: UserId, challenge: string): Promise<WebAuthnAssertion | null> {
  if (!isAvailable()) {
    return null
  }

  const credentialId = (await readCredentialId(userId)) ?? (await createPasskey(userId))
  if (credentialId === null) {
    return null
  }

  return assertPasskey(credentialId, challenge)
}

function isAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials !== 'undefined' &&
    typeof navigator.credentials.create === 'function' &&
    typeof navigator.credentials.get === 'function' &&
    typeof PublicKeyCredential !== 'undefined'
  )
}

async function createPasskey(userId: UserId): Promise<string | null> {
  const credential = await navigator.credentials
    .create({
      publicKey: {
        rp: { id: location.hostname, name: RP_NAME },
        user: { id: utf8(userId), name: userId, displayName: userId },
        challenge: await challengeDigest(`${userId}:${crypto.randomUUID()}`),
        pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
        timeout: TIMEOUT_MS,
        attestation: 'none',
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
      },
    })
    .catch(handleCeremonyError)

  if (credential === null) {
    return null
  }

  if (!(credential instanceof PublicKeyCredential)) {
    throw new DOMException('The authenticator did not return a credential', 'NotSupportedError')
  }

  const credentialId = bytesToBase64Url(new Uint8Array(credential.rawId))
  await storeCredentialId(userId, credentialId)
  return credentialId
}

async function assertPasskey(
  credentialId: string,
  challenge: string,
): Promise<WebAuthnAssertion | null> {
  const credential = await navigator.credentials
    .get({
      publicKey: {
        challenge: await challengeDigest(challenge),
        timeout: TIMEOUT_MS,
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: base64UrlToBytes(credentialId) }],
        userVerification: 'required',
      },
    })
    .catch(handleCeremonyError)

  if (credential === null) {
    return null
  }

  if (!(credential instanceof PublicKeyCredential)) {
    throw new DOMException('The authenticator did not return an assertion', 'NotSupportedError')
  }

  const { response } = credential
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    throw new DOMException('The authenticator did not return an assertion', 'NotSupportedError')
  }

  return {
    credentialId,
    authenticatorData: bytesToBase64Url(new Uint8Array(response.authenticatorData)),
    clientDataJson: bytesToBase64Url(new Uint8Array(response.clientDataJSON)),
    signature: bytesToBase64Url(new Uint8Array(response.signature)),
  }
}

function handleCeremonyError(error: unknown): null {
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'AbortError')
  ) {
    return null
  }
  throw error
}

async function challengeDigest(challenge: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(challenge))
  return new Uint8Array(digest)
}

async function readCredentialId(userId: UserId): Promise<string | null> {
  const database = await openCountersignDatabase()
  const transaction = database.transaction(PASSKEYS_STORE, 'readonly')
  const done = transactionDone(transaction)
  const request = transaction.objectStore(PASSKEYS_STORE).get(userId) as IDBRequest<
    StoredPasskey | undefined
  >
  const [record] = await Promise.all([requestToPromise(request), done])
  return record?.credentialId ?? null
}

async function storeCredentialId(userId: UserId, credentialId: string): Promise<void> {
  const database = await openCountersignDatabase()
  const transaction = database.transaction(PASSKEYS_STORE, 'readwrite')
  const done = transactionDone(transaction)
  const record: StoredPasskey = { userId, credentialId }
  const request = transaction.objectStore(PASSKEYS_STORE).put(record)
  await requestToPromise(request)
  await done
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value)
}
