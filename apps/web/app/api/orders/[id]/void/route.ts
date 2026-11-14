/**
 * `POST /api/orders/{id}/void` — "this order will not ship", §8.11 / S-15.
 *
 * The counterpart to `capture`: it releases whatever the authorisation still holds so the buyer is not left
 * with money held for goods that are not coming. Which order status that writes is **not** this route's
 * decision — `OUT_OF_STOCK` → `VOIDED`, `REVOKED` → `CANCELLED` (EC-MDT-3), `EXPIRED` → `AUTH_EXPIRED`
 * (EC-TIME-5), and `packages/orders` owns the mapping and the ledger `RELEASE` that goes with it.
 *
 * A void of an order that is already settled is `ok({ alreadySettled: true })`, not a 409: a webhook, a
 * sweep, a cron and a merchant click can all reach the same order, and only one of them should have to be
 * the first. The response says so, and `paypalCalls` is empty because PayPal was not called.
 *
 * @see POST /v2/payments/authorizations/{id}/void — the PayPal endpoint `packages/orders` calls.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, HTTP_STATUS_BY_ERROR_CODE, toBody, type CsError } from '@countersign/core'

import { requireMerchant } from '@/lib/auth'
import { merchantIdFor } from '@/lib/merchant-context'
import { orderOpsDeps, voidOrderForMerchant } from '@/lib/order-ops'
import { requireSameOrigin } from '@/lib/same-origin'

export const dynamic = 'force-dynamic'

/**
 * §8.11's `reason`, verbatim. The enum is duplicated here rather than imported from `packages/orders`
 * because it is part of the request contract, and a request body that validates against a different
 * definition from the one that reads it is how the two drift.
 */
const VOID_REASONS = ['OUT_OF_STOCK', 'REVOKED', 'CANCELLED', 'EXPIRED'] as const

const requestSchema = z.strictObject({ reason: z.enum(VOID_REASONS) })

interface VoidRouteContext {
  readonly params: Promise<{ id: string }>
}

function statusFor(error: CsError): number {
  return HTTP_STATUS_BY_ERROR_CODE[error.code]
}

export async function POST(request: Request, context: VoidRouteContext): Promise<Response> {
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
        csError('CS_VALIDATION', 'The void request did not match the expected shape.', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      ),
      { status: 400 },
    )
  }

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

  const outcome = await voidOrderForMerchant(
    {
      orderId: id,
      merchantId: merchantIdRes.value,
      actorUserId: merchant.value.id,
      reason: parsed.data.reason,
    },
    built.value,
  )
  if (!outcome.ok) {
    return NextResponse.json(toBody(outcome.error), { status: statusFor(outcome.error) })
  }

  return NextResponse.json(outcome.value, { status: 200 })
}
