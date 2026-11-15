/**
 * `POST /api/agent/mandate/prepare` — phase 1 of a **buyer-held-key** mandate.
 *
 * This is the HTTP face of `prepareAgentSession`: it takes the buyer's sentence and cap, compiles them,
 * calls vi's `POST /v1/l2/prepare`, and hands back the exact bytes for the buyer's browser to sign. It
 * signs nothing itself — `POST /api/agent/mandate/finalize` (a later commit) is where the signature
 * arrives.
 *
 * ## What is different from `POST /api/agent/session`
 *
 * Three things, all of them deliberate:
 *
 * 1. **The device key comes from the request.** The buyer's browser generated it (`browser-keystore.ts`,
 *    non-extractable, IndexedDB) and sends its public half plus `dev_<thumbprint>`. There is no
 *    server-minted key on this path, so there is no `lib/demo-device.ts` involved and no private half
 *    ever reaches the server.
 * 2. **There is no demo gate.** `COUNTERSIGN_AGENT_DEMO` is not read here. A signed-in buyer with no demo
 *    flag is exactly the caller this route exists for; the deployment's suitability is a separate question
 *    from the caller's identity, and the old route is still the gated one until it is retired.
 * 3. **The body cannot name a buyer.** `user_id` in the body is stripped by the schema and never read;
 *    the buyer is `requireBuyer`'s cookie, and nothing else (D-060).
 *
 * ## Refusals, in order
 *
 * Same-origin (a state-changing `POST`, S-17), then the body's shape, then the account, then the device
 * key. The device key is thumbprinted **here** as well as inside `prepareAgentSession`: a `deviceKid` that
 * is not `dev_<thumbprint of the key it arrived with>` is a request the buyer can fix by reloading, and
 * refusing it before vi is called means the refusal costs no vi call and writes no row.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, formatMoney, money, toBody } from '@countersign/core'
import { readbackSummaryLine } from '@countersign/agent'
import { publicJwkSchema } from '@countersign/vi-client'

import { prepareAgentSession } from '@/lib/agent-session'
import { requireBuyer } from '@/lib/auth'
import { deviceThumbprint } from '@/lib/device-thumbprint'
import { requireSameOrigin } from '@/lib/same-origin'

/** §8.0's "bound every wire input": a cap of 10,000,000.00 is $10M, far past any buyer sentence. */
const MAX_CAP_MINOR = 1_000_000_000n
const MAX_INTENT_CHARS = 200

/**
 * Not `.strict()`, unlike `POST /api/agent/session`.
 *
 * The session route refuses a body that carries an extra key, and that is right for it. Here the extra key
 * in question is `user_id`, and the rule this route is built on is stronger than "refuse it": **the body
 * gets no vote on whose mandate this is**. An unknown key is ignored rather than argued with, and the buyer
 * id used is `requireBuyer`'s, so a body that names someone else changes nothing.
 */
const requestSchema = z.object({
  /** The buyer's own words, trimmed. They become the mandate's `nl_intent` and the read-back's first line. */
  intent: z.string().trim().min(1).max(MAX_INTENT_CHARS),
  /** The per-purchase cap in minor units. A ceiling only: `applyCap` takes the smaller of this and the compiled max. */
  cap_minor: z.number().int().positive(),
  /** `dev_<thumbprint>` of `devicePublicJwk`, computed by the browser. */
  deviceKid: z.string().min(1).max(256),
  /** The browser's P-256 public key, in the shape vi's `device_public_jwk` expects. */
  devicePublicJwk: publicJwkSchema,
})

/** The error → status map of `POST /api/agent/session`, kept identical on purpose. */
function statusFor(code: string): number {
  switch (code) {
    case 'CS_VALIDATION':
      return 400
    case 'CS_NOT_FOUND':
      return 404
    case 'CS_CONFLICT':
      return 409
    case 'CS_FORBIDDEN':
      return 403
    default:
      return 503
  }
}

export async function POST(request: Request): Promise<Response> {
  const originRefusal = requireSameOrigin(request)
  if (originRefusal !== null) {
    return NextResponse.json(toBody(originRefusal), { status: statusFor(originRefusal.code) })
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(toBody(csError('CS_VALIDATION', 'A JSON body is required.')), {
      status: 400,
    })
  }

  const parsed = requestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      toBody(
        csError('CS_VALIDATION', 'The prepare request did not match the expected shape.', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      ),
      { status: 400 },
    )
  }

  const capMinor = BigInt(parsed.data.cap_minor)
  if (capMinor > MAX_CAP_MINOR) {
    return NextResponse.json(
      toBody(
        csError('CS_VALIDATION', `A cap above ${MAX_CAP_MINOR.toString()} minor units is refused.`),
      ),
      { status: 400 },
    )
  }

  // The cookie decides whose mandate this is, and the row behind it decides whether it may be one
  // (D-060). A session that names a row which no longer exists is `currentUser`'s "not signed in", so it
  // lands on the 401 below rather than minting a stranger.
  const buyer = await requireBuyer()
  if (!buyer.ok) {
    return NextResponse.json(toBody(buyer.error), {
      status: buyer.error.code === 'CS_UNAUTHENTICATED' ? 401 : 403,
    })
  }

  // The browser's claim about its own key is verified, not trusted: `deviceKid` must be
  // `dev_<RFC 7638 thumbprint of the key it arrived with>`, the same rule `prepareAgentSession` applies.
  // It is checked twice for the same reason the intent is compiled before any write — this copy refuses
  // before vi is called, and that copy refuses a caller that reached the provisioner another way.
  let jkt: string
  try {
    jkt = await deviceThumbprint(parsed.data.devicePublicJwk)
  } catch (cause) {
    return NextResponse.json(
      toBody(
        csError('CS_VALIDATION', 'The device public key could not be thumbprinted.', undefined, {
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
      { status: 400 },
    )
  }
  if (parsed.data.deviceKid !== `dev_${jkt}`) {
    return NextResponse.json(
      toBody(
        csError(
          'CS_VALIDATION',
          'The device key id is not dev_<thumbprint> of the device public key it arrived with.',
          undefined,
          { userMessage: 'The device key does not match its id. Refresh the page and try again.' },
        ),
      ),
      { status: 400 },
    )
  }

  const prepared = await prepareAgentSession({
    userId: buyer.value.id,
    intent: parsed.data.intent,
    capMinor,
    devicePublicJwk: parsed.data.devicePublicJwk,
    deviceKid: parsed.data.deviceKid,
  })
  if (!prepared.ok) {
    return NextResponse.json(toBody(prepared.error), { status: statusFor(prepared.error.code) })
  }

  return NextResponse.json({
    prepareId: prepared.value.prepareId,
    signingInput: prepared.value.signingInput,
    readback: prepared.value.readback,
    // The mandate chip shows this, not the raw read-back: the raw string starts with the markdown
    // heading `**What you are authorising**`, which is a header and not a limit. One rule, computed
    // once, server-side (packages/agent/src/readback-summary.ts).
    readback_summary: readbackSummaryLine(prepared.value.readback),
    cap_display: formatMoney(money(capMinor, 'USD')),
    expires_at_epoch_sec: prepared.value.expiresAtEpochSec,
    pending: prepared.value.pending,
  })
}
