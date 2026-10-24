/**
 * Short-lived bearer tokens for the merchant MCP server — spec §8.14.
 *
 * The MCP endpoint is not authenticated by a browser cookie: it is called by an **agent process**, which
 * has no cookie jar and no browser origin. §8.14 therefore gives each agent session a short-lived
 * `agt_` bearer, HS256-signed with `SESSION_SECRET` (the one secret the web app already holds) and valid
 * for 15 minutes.
 *
 * ## Why a separate module rather than a function inside the route
 *
 * Two callers need the same rules: the route, to verify every request, and the operator-facing
 * `scripts/mint-agent-token.ts`, to mint one for MCP Inspector or a local agent run. Putting mint and
 * verify in one file is also what keeps the claim set from drifting: a token is accepted only when it
 * satisfies exactly the contract `mintAgentToken` writes, and there is no second place to forget the
 * `agt_` prefix check.
 *
 * ## What is deliberately *not* here
 *
 * There is no unauthenticated `POST /api/mcp/token` route. The buyer wallet UI (WP-17a) will mint a token
 * only after a signed-in session exists; until then the CLI is the honest entry point, because a public
 * mint endpoint would let any caller act as any agent. The token proves *which agent* is calling; the
 * mandate and the Gate prove *what it may do*.
 */
import { SignJWT, jwtVerify } from 'jose'

import { csError, err, ok, type CsError, type Result } from '@countersign/core'

import type { AuthInfo } from '@modelcontextprotocol/server'

/** §8.14: 15 minutes. Exported so a test and the CLI quote the same number. */
export const MCP_TOKEN_TTL_SECONDS = 15 * 60

/** The token is only ever accepted for this audience; a token minted for another service is useless here. */
export const MCP_TOKEN_AUDIENCE = 'countersign-merchant-mcp'

/** One issuer string, so a verifier cannot accidentally accept a token minted by an unrelated system. */
export const MCP_TOKEN_ISSUER = 'countersign'

/** Capabilities issued together to each authenticated merchant agent. */
export const MCP_READ_SCOPE = 'merchant:read'
export const MCP_CHECKOUT_SCOPE = 'merchant:checkout'

export interface MintAgentTokenOptions {
  /** `agt_…`. Rejected before signing when the prefix is wrong, so a malformed subject cannot be minted. */
  readonly agentId: string
  /** Defaults to {@link MCP_TOKEN_TTL_SECONDS}. Cap it so a caller cannot mint a long-lived token by accident. */
  readonly ttlSeconds?: number
  /** Epoch seconds. Injectable so a test can mint a token that is already expired without sleeping. */
  readonly nowSec?: number
}

function signingKey(): Uint8Array | null {
  const secret = process.env.SESSION_SECRET
  // `packages/core/src/env.ts` requires 32+ characters. Refuse a shorter value here too: a token signed
  // with a weak secret is worse than no token, and `jose` would happily accept it.
  if (secret === undefined || secret.length < 32) return null
  return new TextEncoder().encode(secret)
}

function scopes(): string[] {
  return [MCP_READ_SCOPE, MCP_CHECKOUT_SCOPE]
}

/**
 * Mint an agent bearer.
 *
 * Configuration and validation failures cross the module boundary as registered `CsError` values.
 */
export async function mintAgentToken(
  options: MintAgentTokenOptions,
): Promise<Result<string, CsError>> {
  const key = signingKey()
  if (key === null) {
    return err(
      csError(
        'CS_INTERNAL',
        'SESSION_SECRET must be set to at least 32 characters to mint an MCP agent token.',
      ),
    )
  }
  if (!options.agentId.startsWith('agt_') || options.agentId.length === 4) {
    return err(csError('CS_VALIDATION', 'An MCP agent token subject must be an agt_ id.'))
  }
  const now = options.nowSec ?? Math.floor(Date.now() / 1000)
  const requestedTtl = options.ttlSeconds ?? MCP_TOKEN_TTL_SECONDS
  const ttl = Number.isInteger(requestedTtl)
    ? Math.min(Math.max(requestedTtl, 1), MCP_TOKEN_TTL_SECONDS)
    : MCP_TOKEN_TTL_SECONDS

  try {
    return ok(
      await new SignJWT({ scope: scopes().join(' ') })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(options.agentId)
        .setIssuer(MCP_TOKEN_ISSUER)
        .setAudience(MCP_TOKEN_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .setJti(crypto.randomUUID())
        .sign(key),
    )
  } catch {
    return err(csError('CS_INTERNAL', 'Could not sign the MCP agent token.'))
  }
}

/**
 * Verify a bearer and turn it into the SDK's {@link AuthInfo}.
 *
 * Returns `undefined` for every failure — bad signature, wrong issuer/audience, expired, missing `exp`,
 * wrong subject prefix, or an unconfigured secret. `withMcpAuth` maps that to a `401` challenge; it
 * must not be possible to distinguish "no secret configured" from "forged token" by probing the route.
 *
 * `clockTolerance: 5` matches the rest of the project's skew budget. It is small on purpose: a 15-minute
 * token with a five-minute grace would be a 20-minute token.
 */
export async function verifyAgentToken(token: string): Promise<AuthInfo | undefined> {
  const key = signingKey()
  if (key === null) return undefined
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: MCP_TOKEN_ISSUER,
      audience: MCP_TOKEN_AUDIENCE,
      clockTolerance: 5,
    })
    const subject = payload.sub
    if (typeof subject !== 'string' || !subject.startsWith('agt_') || subject.length === 4) {
      return undefined
    }
    if (typeof payload.exp !== 'number') return undefined

    return {
      token,
      clientId: subject,
      scopes: scopes(),
      expiresAt: payload.exp,
      extra: { agentId: subject },
    }
  } catch {
    return undefined
  }
}

/** The agent id from an `AuthInfo`, or `null` when the caller was not authenticated by this module. */
export function agentIdFromAuth(auth: AuthInfo | undefined): string | null {
  const extra = auth?.extra
  const fromExtra = extra?.['agentId']
  if (typeof fromExtra === 'string' && fromExtra.startsWith('agt_')) return fromExtra
  if (auth !== undefined && auth.clientId.startsWith('agt_')) return auth.clientId
  return null
}
