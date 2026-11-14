/**
 * `POST /api/orders/{id}/refund` — the merchant returns money, §8.11 / S-15.
 *
 * ## The two ids in this route, and why both exist
 *
 * The URL carries **our** order id; the body carries **our** capture row id (`cap_…`). Neither is PayPal's.
 * `lib/order-ops.ts` resolves the capture for this merchant, checks it sits on the order in the URL, and
 * only then hands PayPal's own `paypal_capture_id` to `packages/orders`. A merchant therefore cannot name a
 * capture they cannot see, and a mis-pointed UI button gets a sentence rather than a refund.
 *
 * ## Why `idempotencyKey` is required
 *
 * EC-IDEM-5: a double-clicked button must be one refund, and EC-IDEM-6: two identical refunds must be two.
 * Nothing in the request can tell those apart, so the caller has to say which one it is — the merchant UI
 * mints a key per rendered form, and a script mints one per intended refund. `packages/orders` keys the
 * refund row by it, so a replay is the same row and one PayPal call.
 *
 * @see POST /v2/payments/captures/{id}/refund — the PayPal endpoint `packages/orders` calls.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import {
  CURRENCIES,
  csError,
  HTTP_STATUS_BY_ERROR_CODE,
  money,
  toBody,
  type CsError,
} from '@countersign/core'
import { REFUND_REASONS } from '@countersign/orders'

import { requireMerchant } from '@/lib/auth'
import { merchantIdFor } from '@/lib/merchant-context'
import { orderOpsDeps, refundForMerchant } from '@/lib/order-ops'
import { requireSameOrigin } from '@/lib/same-origin'

export const dynamic = 'force-dynamic'

/**
 * An amount is either `'FULL'` — the exact remainder, which `packages/orders` computes — or exact integer
 * minor units **as a decimal string**. A string because `bigint` is not JSON and a float is forbidden
 * (§0), and digits-only because `Number('1e3')` and `'-5'` are both things a JSON body can carry that a
 * money field must not.
 */
const amountSchema = z.union([
  z.literal('FULL'),
  z.strictObject({
    minor: z.string().regex(/^\d+$/, 'minor must be a non-negative integer as a decimal string'),
    currency: z.enum(CURRENCIES),
  }),
])

const requestSchema = z.strictObject({
  captureId: z.string().regex(/^cap_[A-Za-z0-9]+$/, 'captureId must be one of our cap_… row ids'),
  amount: amountSchema,
  reason: z.enum(REFUND_REASONS),
  /** EC-IDEM-5's form nonce. Bounded and charset-checked: it is hashed into a refund row id. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,80}$/),
  /** `note_to_payer`, the merchant's words to the buyer (0–255 chars, [B12]). */
  noteToPayer: z.string().max(255).optional(),
  /** The justification stored on the refund row (audit §15). */
  note: z.string().max(500).optional(),
})

interface RefundRouteContext {
  readonly params: Promise<{ id: string }>
}

function statusFor(error: CsError): number {
  return HTTP_STATUS_BY_ERROR_CODE[error.code]
}

export async function POST(request: Request, context: RefundRouteContext): Promise<Response> {
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
        csError('CS_VALIDATION', 'The refund did not match the expected shape.', {
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

  // Built here rather than in `lib/order-ops.ts`: the body's `currency` is validated by zod, so this is the
  // one place that turns the parsed pair back into a `Money` — a `bigint`, never a number.
  const amount =
    parsed.data.amount === 'FULL'
      ? ('FULL' as const)
      : money(BigInt(parsed.data.amount.minor), parsed.data.amount.currency)

  const outcome = await refundForMerchant(
    {
      orderId: id,
      merchantId: merchantIdRes.value,
      actorUserId: merchant.value.id,
      captureId: parsed.data.captureId,
      amount,
      reason: parsed.data.reason,
      idempotencyKey: parsed.data.idempotencyKey,
      ...(parsed.data.noteToPayer === undefined ? {} : { noteToPayer: parsed.data.noteToPayer }),
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    },
    built.value,
  )
  if (!outcome.ok) {
    return NextResponse.json(toBody(outcome.error), { status: statusFor(outcome.error) })
  }

  return NextResponse.json(outcome.value, { status: 200 })
}
