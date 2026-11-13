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

import { csError, toBody, type UserId } from '@countersign/core'
import { findUserById } from '@countersign/db'

import { decideDispute } from '@/lib/dispute-approval'
import { currentUserId } from '@/lib/session'

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

/** `CsError.code` → HTTP status. The registry owns the meaning; this owns only the number. */
function statusFor(code: string): number {
  switch (code) {
    case 'CS_VALIDATION':
      return 400
    case 'CS_UNAUTHENTICATED':
      return 401
    case 'CS_FORBIDDEN':
      return 403
    case 'CS_NOT_FOUND':
      return 404
    case 'CS_CONFLICT':
      return 409
    case 'CS_RATE_LIMITED':
      return 429
    default:
      return 500
  }
}

export async function POST(request: Request, context: DecisionRouteContext): Promise<Response> {
  const { id } = await context.params

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

  // --- authorisation: the existing session, and nothing else ---------------------------------------
  // A session is a pointer to a row, not a cache of authority (`lib/session.ts`). So the id is read here
  // and the *row* is read next: a cookie naming a user that no longer exists is not permission, and a
  // cookie that could not be decrypted is "not signed in", not a server fault.
  const session = await currentUserId()
  if (!session.ok) return NextResponse.json(toBody(session.error), { status: 503 })
  if (session.value === undefined) {
    return NextResponse.json(
      toBody(
        csError(
          'CS_UNAUTHENTICATED',
          'Approving a dispute needs a signed-in merchant.',
          undefined,
          { userMessage: 'Sign in before approving or declining a dispute.' },
        ),
      ),
      { status: 401 },
    )
  }

  const user = await findUserById(session.value)
  if (!user.ok) return NextResponse.json(toBody(user.error), { status: statusFor(user.error.code) })
  if (user.value === undefined) {
    return NextResponse.json(
      toBody(
        csError(
          'CS_UNAUTHENTICATED',
          `The session names ${session.value as string}, which has no users row.`,
          undefined,
          {
            userMessage: 'Your session refers to an account that no longer exists. Sign in again.',
          },
        ),
      ),
      { status: 401 },
    )
  }

  const outcome = await decideDispute({
    disputeId: id,
    decision: parsed.data.decision,
    actorUserId: session.value as UserId,
    ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
  })
  if (!outcome.ok) {
    return NextResponse.json(toBody(outcome.error), { status: statusFor(outcome.error.code) })
  }

  return NextResponse.json(outcome.value, { status: 200 })
}
