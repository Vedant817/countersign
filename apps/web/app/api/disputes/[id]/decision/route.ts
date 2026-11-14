/**
 * `POST /api/disputes/{id}/decision` — the merchant's approve/decline click, §8.15 / S-17.
 *
 * ## Why this is a `POST` under `/api` and not a Server Action
 *
 * Three reasons, and they are the same three `/v/[packetId]/verify-now` gives for being a route handler:
 *
 * 1. **It is a money-adjacent write, and it should be visible as one.** A request an operator can replay
 *    with `curl` is a request whose authorisation, idempotency and error mapping can be tested directly,
 *    rather than through a React runtime.
 * 2. **It needs the real `CsError` → HTTP mapping.** A refusal is a recorded outcome, not a crash: a
 *    PayPal `404` on a case that vanished must reach the merchant as a sentence, not as a 500. That
 *    mapping lives here, once, the same way every other route in this app maps it.
 * 3. **The response is data, not markup.** The page re-renders from the database after the click, so the
 *    merchant sees the row the filer actually wrote rather than a client-side guess about it.
 *
 * ## What it does not do
 *
 * It does not decide anything. `lib/dispute-approval.ts` owns the guards, the audit row and the call;
 * this file owns the HTTP shape and nothing else. In particular there is **no** branch here that turns a
 * refusal into a success — a refused filing is `ok` at the filer and still answers `200` when the merchant
 * needs to read *why*, and answers `4xx` only when the click itself was not allowed.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, HTTP_STATUS_BY_ERROR_CODE, toBody, type CsError } from '@countersign/core'

import { decideDispute } from '@/lib/dispute-approval'
import { requireMerchant } from '@/lib/auth'
import { merchantIdFor } from '@/lib/merchant-context'
import { requireSameOrigin } from '@/lib/same-origin'

export const dynamic = 'force-dynamic'

/** The note is the merchant's own words, and §8.0's bound-every-input rule applies to it like any other. */
const MAX_NOTE_CHARS = 500

const requestSchema = z
  .object({
    decision: z.enum(['approve', 'decline']),
    note: z.string().max(MAX_NOTE_CHARS).optional(),
  })
  .strict()

/** The context shape Next 16 hands a route handler. Named locally for the reason `/v/` documents. */
interface DecisionRouteContext {
  readonly params: Promise<{ id: string }>
}

/**
 * `CsError.code` → HTTP status.
 *
 * The registry owns the number for every code, so this route cannot quietly turn an unlisted one into a
 * `500`: a hand-written `switch` with a `?? 500` fallback is exactly how a `PP_NOT_FOUND` (a real PayPal
 * absence the merchant must read) becomes a server fault. Reading the table keeps the whole surface honest.
 */
function statusFor(error: CsError): number {
  return HTTP_STATUS_BY_ERROR_CODE[error.code]
}

export async function POST(request: Request, context: DecisionRouteContext): Promise<Response> {
  const { id } = await context.params

  // --- the request came from this deployment -------------------------------------------------------
  // A money-adjacent write should prove its origin before it reads a body, and before it reads a session:
  // the cookie is `sameSite: 'lax'`, and this is the second lock on the same door. A cross-origin `POST`
  // is refused even if it somehow carried a session.
  const originRefusal = requireSameOrigin(request)
  if (originRefusal !== null) {
    return NextResponse.json(toBody(originRefusal), { status: statusFor(originRefusal) })
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
        csError('CS_VALIDATION', 'The decision did not match the expected shape.', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      ),
      { status: 400 },
    )
  }

  // --- authorisation: the merchant role, read from the row -------------------------------------------
  // A session is a pointer to a row, not a cache of authority (`lib/session.ts`), and the persona on that
  // row is what this route checks (`lib/auth.ts`). So a cookie naming a user that no longer exists is not
  // permission, a buyer session is a 403 rather than a silent pass, and a cookie that could not be
  // decrypted is "not signed in" (401) rather than a server fault.
  const merchant = await requireMerchant()
  if (!merchant.ok) {
    return NextResponse.json(toBody(merchant.error), { status: statusFor(merchant.error) })
  }

  const merchantIdRes = await merchantIdFor(merchant.value)
  if (!merchantIdRes.ok) {
    return NextResponse.json(toBody(merchantIdRes.error), {
      status: statusFor(merchantIdRes.error),
    })
  }

  const outcome = await decideDispute({
    disputeId: id,
    merchantId: merchantIdRes.value,
    decision: parsed.data.decision,
    actorUserId: merchant.value.id,
    ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
  })
  if (!outcome.ok) {
    return NextResponse.json(toBody(outcome.error), { status: statusFor(outcome.error) })
  }

  return NextResponse.json(outcome.value, { status: 200 })
}
