/**
 * `POST /api/agent/mandate/finalize` — phase 2 of a **buyer-held-key** mandate.
 *
 * This is the HTTP face of `finalizeAgentSession`: it takes the `pending` token the prepare route handed
 * out, the `prepareId` it named, and the buyer's own ES256 signature over `signingInput`, and it writes
 * the mandate. **The server signs nothing here.** There is no server-held device key on this path and no
 * `lib/demo-device.ts` import; the signature arrives from the browser's non-extractable P-256 key, and vi
 * verifies it against its own stored prepare record before a single row is written.
 *
 * ## What is different from `POST /api/agent/session`
 *
 * Same three deliberate differences as the prepare route:
 *
 * 1. **The signature comes from the request.** The buyer's browser holds the only private half.
 * 2. **There is no demo gate.** `COUNTERSIGN_AGENT_DEMO` is not read here. A signed-in buyer with no demo
 *    flag is exactly the caller this route exists for; the gated route is retired in a later commit.
 * 3. **The body cannot name a buyer.** `user_id` in the body is stripped by the schema and never read;
 *    the buyer is `requireBuyer`'s cookie, and nothing else (D-060).
 *
 * ## Refusals, in order
 *
 * Same-origin (a state-changing `POST`, S-17), then the body's shape, then the account, then the session
 * functions. `finalizeAgentSession` opens the token in the order signature → shape → expiry → buyer →
 * `prepareId` (`lib/pending-session-token.ts:151`, `lib/agent-session.ts:626`), so a token minted for a
 * different buyer is `CS_FORBIDDEN` and an expired one is `CS_VALIDATION` before vi is called at all.
 *
 * The response carries what the agent chat needs to render the mandate — the same ids and read-back
 * `POST /api/agent/session` returns — and **no `pending` token**: a spent token has no second use, and
 * handing it back would invite a retry against a prepare record vi has already closed.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, toBody } from '@countersign/core'
import { readbackSummaryLine } from '@countersign/agent'

import { finalizeAgentSession } from '@/lib/agent-session'
import { requireBuyer } from '@/lib/auth'
import { requireSameOrigin } from '@/lib/same-origin'

/**
 * An ES256 signature is 64 raw bytes, 86 base64url characters. The ceiling is deliberately generous — a
 * signature that arrives in a slightly different encoding still reaches vi, whose verification is the
 * authority on the bytes — while a megabyte of "signature" is refused at the boundary.
 */
const MAX_SIGNATURE_CHARS = 512

/**
 * Not `.strict()`, for the same reason as the prepare route: the extra key in question is `user_id`, and
 * the rule here is stronger than "refuse it" — **the body gets no vote on whose mandate this is**. An
 * unknown key is ignored rather than argued with, and the buyer id used is `requireBuyer`'s.
 */
const requestSchema = z.object({
  /** The `pending` token `POST /api/agent/mandate/prepare` returned. */
  pending: z.string().trim().min(1).max(8192),
  /** vi's prepare-record id, the one the prepare phase returned. Must be the one the token names. */
  prepareId: z.string().trim().min(1).max(256),
  /** ES256 over `signingInput`, raw P1363 r‖s, base64url — from the buyer's own device key. */
  signatureB64Url: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u, 'The signature must be base64url (no padding, no + or /).')
    .min(1)
    .max(MAX_SIGNATURE_CHARS),
})

/** The error → status map of `POST /api/agent/mandate/prepare`, kept identical on purpose. */
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
    // vi's verdict on the signature itself: the bytes did not verify against the prepare record, which is
    // a client error the browser can retry with a fresh prepare. It is deliberately *not* a 503 — a
    // signature that does not match is not an outage (packages/core/src/errors.ts:139).
    case 'VI_SIGNATURE_MISMATCH':
    case 'VI_EXPIRED':
    case 'VI_NOT_YET_VALID':
    case 'VI_CHAIN_INVALID':
      return 400
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
        csError('CS_VALIDATION', 'The finalize request did not match the expected shape.', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      ),
      { status: 400 },
    )
  }

  // The cookie decides whose mandate this is, and the row behind it decides whether it may be one
  // (D-060). The token is verified against this id inside `finalizeAgentSession`, so a token minted for
  // another buyer is refused there rather than here — one copy of that rule, not two.
  const buyer = await requireBuyer()
  if (!buyer.ok) {
    return NextResponse.json(toBody(buyer.error), {
      status: buyer.error.code === 'CS_UNAUTHENTICATED' ? 401 : 403,
    })
  }

  const finalized = await finalizeAgentSession({
    userId: buyer.value.id,
    pending: parsed.data.pending,
    prepareId: parsed.data.prepareId,
    signatureB64Url: parsed.data.signatureB64Url,
  })
  if (!finalized.ok) {
    return NextResponse.json(toBody(finalized.error), {
      status: statusFor(finalized.error.code),
    })
  }

  return NextResponse.json({
    user_id: finalized.value.userId,
    mandate_id: finalized.value.mandateId,
    agent_id: finalized.value.agentId,
    agent_kid: finalized.value.agentKid,
    readback: finalized.value.readback,
    // Same one-rule rendering as the prepare route: the chip shows the summary line, not the raw
    // read-back, which starts with a markdown heading rather than a limit (D-040).
    readback_summary: readbackSummaryLine(finalized.value.readback),
    expires_at_epoch_sec: finalized.value.expiresAtEpochSec,
  })
}
