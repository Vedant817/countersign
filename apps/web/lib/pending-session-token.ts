import 'server-only'

/**
 * The signed token that carries a prepared agent session from `prepare` to `finalize`.
 *
 * ## Why this exists
 *
 * Splitting provisioning into two phases (`prepareAgentSession` → the buyer's browser signs the
 * signing input → `finalizeAgentSession`) needs a way to hand everything the second phase needs —
 * which ids the mandate row is written with, which wallet gets the cap, what the L2 payload was —
 * across a request boundary without re-running the first phase. The server already holds all of it;
 * the only question is how the *second* request proves the state is the server's own.
 *
 * The answer is a stateless, HMAC-signed token in the style of the session cookie (`./session.ts`):
 * the payload is the JSON `finalizeAgentSession` needs, the signature is HMAC-SHA256 under
 * `SESSION_SECRET` (read per call via `sessionSecret()`, so a deployment without the secret fails
 * with a legible `CS_INTERNAL` instead of an import error), and the token carries its own `exp`
 * (ten minutes) so a prepared-but-never-signed session cannot be finalised days later.
 *
 * **What the token deliberately does not carry:** the signing input, the device key, or the
 * signature. The browser holds the signing input it was given and signs it with a key the server
 * never sees; `finalizeAgentSession` passes vi the `prepare_id` and the signature, and vi verifies
 * both against its own stored prepare record. This token only carries the *database* half.
 */
import { z } from 'zod'

import {
  csError,
  err,
  ok,
  systemClock,
  type AgentId,
  type CsError,
  type DeviceId,
  type MandateId,
  type Result,
  type UserId,
  type WalletId,
} from '@countersign/core'

import { base64UrlToBytes, bytesToBase64Url } from './base64url'
import { sessionSecret } from './session'

/** How long a prepared session may sit unsigned before its token expires. */
export const PENDING_SESSION_TTL_SECONDS = 10 * 60

/**
 * Everything `finalizeAgentSession` needs, as plain JSON — no bigints, no `Date`s, no class
 * instances. `capMinor` is a decimal string because a bigint cannot survive `JSON.stringify` and a
 * float must never touch money (§8.0 rule 9).
 */
export interface PendingAgentSession {
  /** vi's prepare-record id. `finalizeAgentSession` refuses a call that names a different one. */
  readonly prepareId: string
  readonly mandateId: MandateId
  readonly userId: UserId
  readonly deviceId: DeviceId
  readonly agentId: AgentId
  /** vi's `kid` for the minted agent key; the AgentSession reports it back. */
  readonly agentKid: string
  readonly walletId: WalletId
  /** vi's L2 payload, already through `toJsonSafe`, exactly what the mandate row stores. */
  readonly l2Payload: Record<string, unknown>
  /** The buyer's own words: the mandate row's `nl_intent`. */
  readonly intent: string
  readonly readback: string
  /** The final constraint set, already through `toJsonSafe`. */
  readonly constraints: unknown[]
  readonly nonce: string
  readonly aud: string
  /** Per-purchase cap in minor units, as a decimal string. */
  readonly capMinor: string
  readonly compilerModel: string
  /** The mandate's expiry, epoch seconds — the fallback when vi's L2 carries no `exp`. */
  readonly expiresAtEpochSec: number
  /** Epoch seconds after which this token is refused, whatever its contents. */
  readonly exp: number
}

/**
 * The token's shape on the wire. `strictObject` so an unknown field is a refusal: a token this
 * server did not mint in exactly this shape is not a token this server minted.
 */
const pendingSessionSchema = z.strictObject({
  prepareId: z.string().min(1),
  mandateId: z.string().min(1),
  userId: z.string().min(1),
  deviceId: z.string().min(1),
  agentId: z.string().min(1),
  agentKid: z.string().min(1),
  walletId: z.string().min(1),
  l2Payload: z.record(z.string(), z.unknown()),
  intent: z.string(),
  readback: z.string(),
  constraints: z.array(z.unknown()),
  nonce: z.string().min(1),
  aud: z.string().min(1),
  capMinor: z.string().regex(/^\d+$/u),
  compilerModel: z.string(),
  expiresAtEpochSec: z.number().int(),
  exp: z.number().int(),
})

/** `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>` — the same two-segment shape a JWT uses. */
const TOKEN_SEGMENTS = 2

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/**
 * Seal a prepared session into its token, or the refusal that says sealing was not possible (no
 * usable `SESSION_SECRET`). The payload is serialised exactly once; the MAC covers those bytes.
 */
export async function signPendingSessionToken(
  payload: PendingAgentSession,
): Promise<Result<string, CsError>> {
  const secret = sessionSecret()
  if (!secret.ok) return secret
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(payload))
    const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret.value), encoded)
    return ok(
      `${bytesToBase64Url(new Uint8Array(encoded))}.${bytesToBase64Url(new Uint8Array(mac))}`,
    )
  } catch (cause) {
    return err(
      csError('CS_INTERNAL', 'The pending session token could not be signed.', {
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    )
  }
}

/**
 * Open a token: signature first, then shape, then expiry, then the buyer it belongs to.
 *
 * The order is not decoration. A token whose signature does not check out is untrusted bytes, so
 * nothing inside it (including its `exp`) is read as fact until the MAC verifies. A valid token
 * whose `exp` has passed is refused — a prepared session that was never signed is not a mandate
 * waiting to happen. A valid, live token naming a different buyer is `CS_FORBIDDEN` rather than
 * `CS_VALIDATION`: the token itself is fine, this caller is simply not the one it was issued to,
 * which is the same distinction `guardRunUser` draws.
 */
export async function verifyPendingSessionToken(
  token: string,
  expected: { readonly userId: UserId },
): Promise<Result<PendingAgentSession, CsError>> {
  const secret = sessionSecret()
  if (!secret.ok) return secret

  const parts = token.split('.')
  if (parts.length !== TOKEN_SEGMENTS || parts.some((part) => part.length === 0)) {
    return err(
      csError(
        'CS_VALIDATION',
        'The pending session token is malformed: expected "<payload>.<signature>".',
        undefined,
        { userMessage: 'Start the mandate again from the beginning.' },
      ),
    )
  }
  const [encodedPayload = '', encodedMac = ''] = parts

  let verified = false
  try {
    const mac = base64UrlToBytes(encodedMac)
    const payloadBytes = base64UrlToBytes(encodedPayload)
    verified = await crypto.subtle.verify('HMAC', await hmacKey(secret.value), mac, payloadBytes)
  } catch {
    verified = false
  }
  if (!verified) {
    return err(
      csError(
        'CS_VALIDATION',
        'The pending session token failed its signature check, so it will not be trusted.',
        undefined,
        { userMessage: 'This pending session is not valid. Start again from the beginning.' },
      ),
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload)))
  } catch {
    return err(
      csError(
        'CS_VALIDATION',
        'The pending session token carried bytes that are not JSON, despite a valid signature.',
      ),
    )
  }
  const shape = pendingSessionSchema.safeParse(parsed)
  if (!shape.success) {
    return err(
      csError('CS_VALIDATION', 'The pending session token is not in the shape this server mints.', {
        issues: shape.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      }),
    )
  }
  const payload = shape.data as PendingAgentSession

  const nowSec = Math.floor(systemClock.nowMs() / 1000)
  if (nowSec > payload.exp) {
    return err(
      csError(
        'CS_VALIDATION',
        `The pending session token expired at ${payload.exp}; now ${nowSec}.`,
        undefined,
        { userMessage: 'The pending session expired. Start again from the beginning.' },
      ),
    )
  }
  if (payload.userId !== expected.userId) {
    return err(
      csError(
        'CS_FORBIDDEN',
        `The pending session belongs to ${payload.userId}, not to ${expected.userId}.`,
        undefined,
        { userMessage: 'That pending session does not belong to this browser.' },
      ),
    )
  }
  return ok(payload)
}
