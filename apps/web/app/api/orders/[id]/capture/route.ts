/**
 * `POST /api/orders/{id}/capture` — the merchant's "this parcel has shipped", §8.11 / S-15.
 *
 * ## Why a route and not a Server Action
 *
 * The same three reasons `/api/disputes/{id}/decision` gives: a money-adjacent write should be replayable
 * with `curl` so its authorisation, its idempotency and its error mapping can be tested directly; a refusal
 * must reach the merchant as a sentence rather than a 500; and the response is data the page re-reads,
 * not markup. A capture is the most expensive of the three to get wrong — it is the call that takes the
 * buyer's money — so it is the one that most needs to be a request you can see.
 *
 * ## What this file owns, and what it does not
 *
 * It owns the HTTP shape: origin, session, merchant, a strict body, and `CsError` → status. Everything
 * about the money — the allocation, the over-capture guard (EC-CAP-3), `final_capture`, the capture itself,
 * the budget commit and the tracker (EC-CAP-4) — belongs to `packages/orders`, and the ownership check plus
 * the audit row belong to `lib/order-ops.ts`. There is no amount in this body on purpose: the merchant
 * ships *lines*, and the amount is derived from the authorisation the buyer already agreed to. A route that
 * accepted an amount would be a route that could over-capture.
 *
 * @see POST /v2/payments/authorizations/{id}/capture — the PayPal endpoint `packages/orders` calls.
 * @see POST /v2/checkout/orders/{id}/track — called only once the capture is `COMPLETED` (EC-CAP-4).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, HTTP_STATUS_BY_ERROR_CODE, toBody, type CsError } from '@countersign/core'

import { requireMerchant } from '@/lib/auth'
import { merchantIdFor } from '@/lib/merchant-context'
import { captureShipmentForMerchant, orderOpsDeps } from '@/lib/order-ops'
import { requireSameOrigin } from '@/lib/same-origin'

export const dynamic = 'force-dynamic'

/** A carrier or tracking number is an opaque string to us, but it is not unbounded. */
const MAX_CODE_CHARS = 120

const requestSchema = z.strictObject({
  carrier: z.string().min(1).max(MAX_CODE_CHARS),
  tracking: z.string().min(1).max(MAX_CODE_CHARS),
  lines: z
    .array(
      z.strictObject({
        sku: z.string().min(1).max(MAX_CODE_CHARS),
        // A quantity is not money: it is a count, and §0's integer rule is about minor units. Bounded so a
        // single request cannot ask for a billion units of a line.
        qty: z.number().int().positive().max(1_000),
      }),
    )
    .min(1)
    .max(100),
  /** `note_to_payer` on the capture (0–255 chars, [B12]). */
  noteToPayer: z.string().max(255).optional(),
  /** Force `final_capture` (EC-STOCK-1). `undefined` derives it from what is left. */
  finalCapture: z.boolean().optional(),
})

/** The context shape Next hands a route handler. Named locally, as `/api/disputes/[id]/decision` does. */
interface CaptureRouteContext {
  readonly params: Promise<{ id: string }>
}

function statusFor(error: CsError): number {
  return HTTP_STATUS_BY_ERROR_CODE[error.code]
}

export async function POST(request: Request, context: CaptureRouteContext): Promise<Response> {
  const { id } = await context.params

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
        csError('CS_VALIDATION', 'The shipment did not match the expected shape.', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      ),
      { status: 400 },
    )
  }

  // The merchant role, read from the row — a session is a pointer to a row, not a cache of authority.
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

  const built = orderOpsDeps()
  if (!built.ok) {
    return NextResponse.json(toBody(built.error), { status: statusFor(built.error) })
  }

  const outcome = await captureShipmentForMerchant(
    {
      orderId: id,
      merchantId: merchantIdRes.value,
      actorUserId: merchant.value.id,
      shipment: {
        lines: parsed.data.lines,
        carrier: parsed.data.carrier,
        tracking: parsed.data.tracking,
        ...(parsed.data.noteToPayer === undefined ? {} : { noteToPayer: parsed.data.noteToPayer }),
        ...(parsed.data.finalCapture === undefined
          ? {}
          : { finalCapture: parsed.data.finalCapture }),
      },
    },
    built.value,
  )
  if (!outcome.ok) {
    return NextResponse.json(toBody(outcome.error), { status: statusFor(outcome.error) })
  }

  return NextResponse.json(outcome.value, { status: 200 })
}
