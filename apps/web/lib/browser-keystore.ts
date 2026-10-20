import type { UserId } from '@countersign/core'

import { bytesToBase64Url } from './base64url'
import {
  KEYS_STORE,
  openCountersignDatabase,
  requestToPromise,
  transactionDone,
  USER_INDEX,
} from './idb'

export interface DeviceKey {
  kid: string
  publicJwk: JsonWebKey
  jkt: string
  createdAt: number
}

interface StoredDeviceKey extends DeviceKey {
  userId: UserId
  privateKey: CryptoKey
}

const ECDSA_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } satisfies EcKeyGenParams
const ECDSA_SIGNATURE_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } satisfies EcdsaParams
const SIGNATURE_BYTES = 64
const KID_PREFIX = 'dev_'

const pendingKeys = new Map<UserId, Promise<DeviceKey>>()

export function deviceKeyId(thumbprint: string): string {
  return `${KID_PREFIX}${thumbprint}`
}

export async function deviceKeyThumbprint(publicJwk: JsonWebKey): Promise<string> {
  if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256') {
    throw new DOMException('Only P-256 EC public keys can be thumbprinted', 'NotSupportedError')
  }

  const { x, y } = publicJwk
  if (typeof x !== 'string' || typeof y !== 'string') {
    throw new DOMException('The public key is missing its coordinates', 'DataError')
  }

  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x, y })
  const digest = await crypto.subtle.digest('SHA-256', utf8(canonical))
  return bytesToBase64Url(new Uint8Array(digest))
}

export function getOrCreateDeviceKey(userId: UserId): Promise<DeviceKey> {
  const pending = pendingKeys.get(userId)
  if (pending !== undefined) {
    return pending
  }

  const created = createDeviceKey(userId).finally(() => {
    pendingKeys.delete(userId)
  })
  pendingKeys.set(userId, created)
  return created
}

async function createDeviceKey(userId: UserId): Promise<DeviceKey> {
  const existing = await readDeviceKey(userId)
  if (existing !== null) {
    return toDeviceKey(existing)
  }

  const keyPair = await crypto.subtle.generateKey(ECDSA_PARAMS, false, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const jkt = await deviceKeyThumbprint(publicJwk)
  const record: StoredDeviceKey = {
    kid: deviceKeyId(jkt),
    publicJwk,
    jkt,
    createdAt: Math.floor(Date.now() / 1000),
    userId,
    privateKey: keyPair.privateKey,
  }

  const database = await openCountersignDatabase()
  const transaction = database.transaction(KEYS_STORE, 'readwrite')
  const done = transactionDone(transaction)
  const request = transaction.objectStore(KEYS_STORE).add(record)

  try {
    await requestToPromise(request)
    await done
    return toDeviceKey(record)
  } catch (error) {
    await done.catch(() => undefined)
    if (error instanceof DOMException && error.name === 'ConstraintError') {
      const winner = await readDeviceKey(userId)
      if (winner !== null) {
        return toDeviceKey(winner)
      }
    }
    throw error
  }
}

export async function signSigningInput(kid: string, signingInputAscii: string): Promise<string> {
  const database = await openCountersignDatabase()
  const transaction = database.transaction(KEYS_STORE, 'readonly')
  const done = transactionDone(transaction)
  const request = transaction.objectStore(KEYS_STORE).get(kid) as IDBRequest<
    StoredDeviceKey | undefined
  >
  const [record] = await Promise.all([requestToPromise(request), done])

  if (record === undefined) {
    throw new DOMException(`No device key is stored for ${kid}`, 'NotFoundError')
  }

  const signature = await crypto.subtle.sign(
    ECDSA_SIGNATURE_PARAMS,
    record.privateKey,
    utf8(signingInputAscii),
  )
  const bytes = new Uint8Array(signature)
  if (bytes.length !== SIGNATURE_BYTES) {
    throw new DOMException('The ECDSA signature was not in P1363 form', 'OperationError')
  }
  return bytesToBase64Url(bytes)
}

export async function deviceKeyExists(userId: UserId): Promise<boolean> {
  const database = await openCountersignDatabase()
  const transaction = database.transaction(KEYS_STORE, 'readonly')
  const done = transactionDone(transaction)
  const request = transaction.objectStore(KEYS_STORE).index(USER_INDEX).count(userId)
  const [count] = await Promise.all([requestToPromise(request), done])
  return count > 0
}

async function readDeviceKey(userId: UserId): Promise<StoredDeviceKey | null> {
  const database = await openCountersignDatabase()
  const transaction = database.transaction(KEYS_STORE, 'readonly')
  const done = transactionDone(transaction)
  const request = transaction.objectStore(KEYS_STORE).index(USER_INDEX).get(userId) as IDBRequest<
    StoredDeviceKey | undefined
  >
  const [record] = await Promise.all([requestToPromise(request), done])
  return record ?? null
}

function toDeviceKey(record: StoredDeviceKey): DeviceKey {
  return {
    kid: record.kid,
    publicJwk: record.publicJwk,
    jkt: record.jkt,
    createdAt: record.createdAt,
  }
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value)
}
