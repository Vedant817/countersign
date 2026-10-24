/**
 * The MCP bearer contract — spec §8.14.
 *
 * Four properties matter, and each one is a way the endpoint could be open when it should be shut:
 * a token names an `agt_` subject, it expires, it is scoped to this audience, and a missing secret
 * verifies nothing rather than everything.
 */
import { randomBytes } from 'node:crypto'
import { SignJWT, type JWTPayload } from 'jose'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MCP_CHECKOUT_SCOPE,
  MCP_READ_SCOPE,
  MCP_TOKEN_AUDIENCE,
  MCP_TOKEN_ISSUER,
  MCP_TOKEN_TTL_SECONDS,
  agentIdFromAuth,
  mintAgentToken as mintAgentTokenResult,
  verifyAgentToken,
} from './mcp-token'

const SECRET = randomBytes(32).toString('hex')
const AGENT = 'agt_01J00000000000000000000001'

const originalSecret = process.env.SESSION_SECRET

async function signedClaims(overrides: JWTPayload = {}, alg = 'HS256'): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    sub: AGENT,
    iss: MCP_TOKEN_ISSUER,
    aud: MCP_TOKEN_AUDIENCE,
    iat: now,
    exp: now + 900,
    scope: `${MCP_READ_SCOPE} ${MCP_CHECKOUT_SCOPE}`,
    ...overrides,
  })
    .setProtectedHeader({ alg, typ: 'JWT' })
    .sign(new TextEncoder().encode(SECRET))
}

async function mintAgentToken(
  options: Parameters<typeof mintAgentTokenResult>[0],
): Promise<string> {
  const result = await mintAgentTokenResult(options)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET
})

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.SESSION_SECRET
  } else {
    process.env.SESSION_SECRET = originalSecret
  }
})

describe('mintAgentToken', () => {
  it.each(['agt_', 'agt_has spaces', `agt_${'x'.repeat(125)}`])(
    'rejects unbounded or malformed subjects: %s',
    async (agentId) => {
      const result = await mintAgentTokenResult({ agentId })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CS_VALIDATION')
    },
  )

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
    'rejects invalid issuance time: %s',
    async (nowSec) => {
      const result = await mintAgentTokenResult({ agentId: AGENT, nowSec })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CS_VALIDATION')
    },
  )

  it('mints a token that verifies as the same agt_ subject', async () => {
    const token = await mintAgentToken({ agentId: AGENT })
    const auth = await verifyAgentToken(token)

    expect(auth).toBeDefined()
    expect(auth?.clientId).toBe(AGENT)
    expect(auth?.scopes).toEqual([MCP_READ_SCOPE, MCP_CHECKOUT_SCOPE])
    expect(auth?.token).toBe(token)
    expect(agentIdFromAuth(auth)).toBe(AGENT)
  })

  it('defaults to the 15-minute lifetime §8.14 names', async () => {
    const nowSec = 1_760_000_000
    const token = await mintAgentToken({ agentId: AGENT, nowSec })
    const [, payload] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
      exp?: number
      iat?: number
      iss?: string
      aud?: string
    }

    expect(claims.iat).toBe(nowSec)
    expect(claims.exp).toBe(nowSec + MCP_TOKEN_TTL_SECONDS)
    expect(claims.iss).toBe(MCP_TOKEN_ISSUER)
    expect(claims.aud).toBe(MCP_TOKEN_AUDIENCE)
  })

  it('caps a caller-requested TTL at 15 minutes', async () => {
    const nowSec = 1_760_000_000
    const token = await mintAgentToken({ agentId: AGENT, nowSec, ttlSeconds: 86_400 })
    const [, payload] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
      exp?: number
    }

    expect((claims.exp ?? 0) - nowSec).toBe(MCP_TOKEN_TTL_SECONDS)
  })

  it('refuses a subject that is not an agt_ id', async () => {
    const result = await mintAgentTokenResult({ agentId: 'usr_not-an-agent' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CS_VALIDATION')
  })

  it('refuses to mint without a 32-character SESSION_SECRET', async () => {
    process.env.SESSION_SECRET = 'too-short'
    const result = await mintAgentTokenResult({ agentId: AGENT })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CS_INTERNAL')
  })
})

describe('verifyAgentToken', () => {
  it.each([
    { iat: undefined },
    { iat: Math.floor(Date.now() / 1000) + 60 },
    { iat: Math.floor(Date.now() / 1000) - 3600 },
    { exp: Math.floor(Date.now() / 1000) + 3600 },
    { iat: Math.floor(Date.now() / 1000) + 0.5 },
    { exp: Math.floor(Date.now() / 1000) + 900.5 },
    { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) },
    { scope: undefined },
    { scope: '' },
    { scope: ['merchant:read'] },
    { scope: 'merchant:admin' },
    { sub: 'agt_has spaces' },
    { sub: `agt_${'x'.repeat(125)}` },
  ])('rejects signed claims outside the session contract: %j', async (claims) => {
    expect(await verifyAgentToken(await signedClaims(claims))).toBeUndefined()
  })

  it('preserves a read-only grant without adding checkout authority', async () => {
    const auth = await verifyAgentToken(await signedClaims({ scope: MCP_READ_SCOPE }))
    expect(auth?.scopes).toEqual([MCP_READ_SCOPE])
  })

  it('accepts a shorter session and five seconds of issuance clock skew', async () => {
    const now = Math.floor(Date.now() / 1000)
    expect(
      await verifyAgentToken(await signedClaims({ iat: now + 5, exp: now + 65 })),
    ).toBeDefined()
  })

  it('refuses an oversized bearer', async () => {
    const oversized = await signedClaims({ metadata: 'x'.repeat(8192) })
    expect(oversized.length).toBeGreaterThan(8192)
    expect(await verifyAgentToken(oversized)).toBeUndefined()
  })

  it.each([
    { aud: 'another-service' },
    { iss: 'another-issuer' },
    { sub: 'usr_not_an_agent' },
    { sub: 'agt_' },
  ])('rejects fresh otherwise-valid identity claims: %j', async (claims) => {
    expect(await verifyAgentToken(await signedClaims(claims))).toBeUndefined()
  })

  it('rejects a fresh HS384 token with otherwise-valid claims', async () => {
    expect(await verifyAgentToken(await signedClaims({}, 'HS384'))).toBeUndefined()
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await mintAgentToken({ agentId: AGENT })
    process.env.SESSION_SECRET = randomBytes(32).toString('hex')

    expect(await verifyAgentToken(token)).toBeUndefined()
  })

  it('rejects an expired token', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await mintAgentToken({ agentId: AGENT, nowSec: nowSec - 3_600, ttlSeconds: 60 })

    expect(await verifyAgentToken(token)).toBeUndefined()
  })

  it('rejects a token with no exp claim', async () => {
    const { SignJWT } = await import('jose')
    const key = new TextEncoder().encode(SECRET)
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(AGENT)
      .setIssuer(MCP_TOKEN_ISSUER)
      .setAudience(MCP_TOKEN_AUDIENCE)
      .setIssuedAt(1_760_000_000)
      .sign(key)

    expect(await verifyAgentToken(token)).toBeUndefined()
  })

  it('fails closed when SESSION_SECRET is missing', async () => {
    const token = await mintAgentToken({ agentId: AGENT })
    delete process.env.SESSION_SECRET

    expect(await verifyAgentToken(token)).toBeUndefined()
  })

  it('rejects a token minted for another audience', async () => {
    const { SignJWT } = await import('jose')
    const key = new TextEncoder().encode(SECRET)
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(AGENT)
      .setIssuer(MCP_TOKEN_ISSUER)
      .setAudience('some-other-service')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key)

    expect(await verifyAgentToken(token)).toBeUndefined()
  })
})
