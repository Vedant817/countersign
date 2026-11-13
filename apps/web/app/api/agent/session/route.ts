/**
 * `POST /api/agent/session` — provision one buyer's mandate for S-10.
 *
 * This is the buyer's onboarding step once they have an account: it creates a wallet, a server-side device
 * key, an agent key minted by vi, a real L1/L2 chain and a mandate — then returns the ids the run route
 * needs. Every artefact is real except the custody of the device key (`lib/demo-device.ts` explains exactly
 * what that means); see `lib/agent-session.ts` for the pipeline.
 *
 * ## Why the request takes an intent and a cap
 *
 * The buyer's sentence and the cap are the two things a viewer will vary ("$50", "$150"), and they are
 * the mandate's `nl_intent` and its `amount_range.max`. Nothing else is configurable: a demo where the
 * caller could also choose the merchant, the currency or the expiry would be a demo of a form, not of a
 * mandate.
 *
 * ## Whose mandate it is (D-060)
 *
 * The session decides, and the body does not get a vote. `requireBuyer` reads the cookie, re-reads the
 * `users` row and answers `401` for an anonymous caller or `403` for a merchant; the id it returns is the
 * one handed to the provisioner. There is no longer a path here that mints a buyer — the previous version
 * created a fresh `usr_…` for a request with no cookie, which is how a browser held an identity nobody had
 * authenticated for.
 *
 * ## Refusals
 *
 * `COUNTERSIGN_AGENT_DEMO=1` and a non-production `NODE_ENV` are required. Without them this answers 403
 * with a sentence, the same way the signing lab does — sample identities must never be issuable by a
 * deployed application. That gate is now the *second* lock on this door; the first is a real account.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, formatMoney, money, toBody } from '@countersign/core'
import { readbackSummaryLine } from '@countersign/agent'

import { agentDemoAllowed, provisionAgentSession } from '@/lib/agent-session'
import { requireBuyer } from '@/lib/auth'

/** §8.0's "bound every wire input": a cap of 10,000,000.00 is $10M, far past any demo sentence. */
const MAX_CAP_MINOR = 1_000_000_000n
const MAX_INTENT_CHARS = 200

const requestSchema = z
  .object({
    intent: z.string().min(1).max(MAX_INTENT_CHARS),
    cap_minor: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .default('5000'),
  })
  .strict()

export async function POST(request: Request): Promise<Response> {
  if (!agentDemoAllowed()) {
    return NextResponse.json(
      toBody(
        csError(
          'CS_FORBIDDEN',
          'The agent demo is available only when COUNTERSIGN_AGENT_DEMO=1 and NODE_ENV is not production.',
          undefined,
          { userMessage: 'The live agent demo is not enabled on this deployment.' },
        ),
      ),
      { status: 403 },
    )
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
        csError('CS_VALIDATION', 'The session request did not match the expected shape.', {
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
        csError(
          'CS_VALIDATION',
          `A demo cap above ${MAX_CAP_MINOR.toString()} minor units is refused.`,
        ),
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

  const provisioned = await provisionAgentSession({
    intent: parsed.data.intent,
    capMinor,
    userId: buyer.value.id,
  })
  if (!provisioned.ok) {
    return NextResponse.json(toBody(provisioned.error), {
      status:
        provisioned.error.code === 'CS_FORBIDDEN'
          ? 403
          : provisioned.error.code === 'CS_NOT_FOUND'
            ? 404
            : 503,
    })
  }

  return NextResponse.json({
    user_id: provisioned.value.userId,
    mandate_id: provisioned.value.mandateId,
    agent_id: provisioned.value.agentId,
    agent_kid: provisioned.value.agentKid,
    readback: provisioned.value.readback,
    // The mandate chip shows this, not the raw read-back: the raw string starts with the markdown
    // heading `**What you are authorising**`, which is a header and not a limit. One rule, computed
    // once, server-side (packages/agent/src/readback-summary.ts) — a client re-implementation is the
    // D-040 shape of bug: two copies that can disagree.
    readback_summary: readbackSummaryLine(provisioned.value.readback),
    cap_minor: capMinor.toString(),
    cap_display: formatMoney(money(capMinor, 'USD')),
    expires_at_epoch_sec: provisioned.value.expiresAtEpochSec,
  })
}
