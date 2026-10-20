import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { base64UrlToBytes, bytesToBase64Url } from './base64url'
import { deviceKeyId, deviceKeyThumbprint } from './browser-keystore'

const PUBLIC_JWK: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
}

const EXPECTED_THUMBPRINT = createHash('sha256')
  .update(
    JSON.stringify({
      crv: 'P-256',
      kty: 'EC',
      x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
      y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
    }),
    'utf8',
  )
  .digest('base64url')

const KEY_WITH_EXTRA_MEMBERS: JsonWebKey & { kid: string } = {
  ...PUBLIC_JWK,
  kid: 'ignored',
  alg: 'ES256',
  use: 'sig',
  key_ops: ['verify'],
  d: 'ignored',
}

describe('deviceKeyThumbprint', () => {
  it('derives the RFC 7638 thumbprint from the required members only', async () => {
    await expect(deviceKeyThumbprint(KEY_WITH_EXTRA_MEMBERS)).resolves.toBe(EXPECTED_THUMBPRINT)
  })

  it('rejects keys that are not P-256 EC', async () => {
    await expect(deviceKeyThumbprint({ kty: 'RSA', n: 'n', e: 'AQAB' })).rejects.toMatchObject({
      name: 'NotSupportedError',
    })
    await expect(deviceKeyThumbprint({ ...PUBLIC_JWK, crv: 'P-384' })).rejects.toMatchObject({
      name: 'NotSupportedError',
    })
  })

  it('rejects keys without coordinates', async () => {
    await expect(deviceKeyThumbprint({ kty: 'EC', crv: 'P-256' })).rejects.toMatchObject({
      name: 'DataError',
    })
  })
})

describe('deviceKeyId', () => {
  it('prefixes the thumbprint', () => {
    expect(deviceKeyId('abc')).toBe('dev_abc')
  })
})

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const encoded = bytesToBase64Url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(base64UrlToBytes(encoded)).toEqual(bytes)
  })

  it('matches known vectors', () => {
    expect(bytesToBase64Url(new Uint8Array())).toBe('')
    expect(base64UrlToBytes('AQID')).toEqual(new Uint8Array([1, 2, 3]))
  })
})
