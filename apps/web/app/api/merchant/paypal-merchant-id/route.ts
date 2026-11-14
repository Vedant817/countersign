/**
 * `POST /api/merchant/paypal-merchant-id` — link a merchant's PayPal merchant ID.
 *
 * ## The order of operations
 *
 * 1. Same-origin: cross-origin POSTs are rejected before inspecting body or session.
 * 2. Authorisation: user must be signed in as a merchant, and their merchant row must resolve.
 * 3. Body validation: strict shape with exactly 13 alphanumeric characters, trimmed and uppercased.
 * 4. Database update: setPaypalMerchantId records the ID; unique violation maps to 409 CS_CONFLICT.
 * 5. Audit log: appendAudit records who changed it and the new public PayPal merchant ID.
 */
import { createHash } from 'node:crypto'

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, HTTP_STATUS_BY_ERROR_CODE, newId, toBody, type CsError } from '@countersign/core'
import { appendAudit, setPaypalMerchantId } from '@countersign/db'

import { requireMerchant } from '@/lib/auth'
import { merchantIdFor } from '@/lib/merchant-context'
import { requireSameOrigin } from '@/lib/same-origin'

export const dynamic = 'force-dynamic'

function ipHash(address: string): string {
  return createHash('sha256').update(address).digest('hex')
}

function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded ?? request.headers.get('x-real-ip')?.trim() ?? 'unknown'
}

function statusFor(error: CsError): number {
  return HTTP_STATUS_BY_ERROR_CODE[error.code] ?? 500
}

const PAYPAL_MERCHANT_ID_REGEX = /^[A-Z0-9]{13}$/

const requestSchema = z
  .object({
    paypalMerchantId: z
      .string()
      .trim()
      .transform((val) => val.toUpperCase())
      .refine((val) => PAYPAL_MERCHANT_ID_REGEX.test(val), {
        message: 'Must be a 13-character alphanumeric PayPal merchant ID.',
      }),
  })
  .strict()

export async function POST(request: Request): Promise<Response> {
  const originRefusal = requireSameOrigin(request)
  if (originRefusal !== null) {
    return NextResponse.json(toBody(originRefusal), { status: 403 })
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

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(
      toBody(
        csError('CS_VALIDATION', 'A JSON body is required.', undefined, {
          userMessage: 'A JSON body is required.',
        }),
      ),
      { status: 400 },
    )
  }

  const parsed = requestSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.')
      return path !== '' ? `${path}: ${issue.message}` : issue.message
    })
    return NextResponse.json(
      toBody(
        csError(
          'CS_VALIDATION',
          'The PayPal merchant ID did not match the expected shape.',
          { issues },
          { userMessage: issues[0] ?? 'Check the PayPal merchant ID and try again.' },
        ),
      ),
      { status: 400 },
    )
  }

  const updated = await setPaypalMerchantId(merchantIdRes.value, parsed.data.paypalMerchantId)
  if (!updated.ok) {
    if (updated.error.code === 'CS_CONFLICT') {
      return NextResponse.json(
        toBody(
          csError('CS_CONFLICT', updated.error.message, updated.error.details, {
            userMessage:
              'That PayPal merchant ID is already linked to another Countersign merchant.',
          }),
        ),
        { status: 409 },
      )
    }
    return NextResponse.json(toBody(updated.error), { status: statusFor(updated.error) })
  }

  await appendAudit({
    id: newId('aud'),
    chainId: merchant.value.id,
    actor: merchant.value.id,
    action: 'merchant.paypal_merchant_id.set',
    subject: merchantIdRes.value,
    ipHash: ipHash(clientAddress(request)),
    details: {
      merchant_id: merchantIdRes.value,
      paypal_merchant_id: parsed.data.paypalMerchantId,
    },
  })

  return NextResponse.json(
    {
      merchantId: merchantIdRes.value,
      paypalMerchantId: parsed.data.paypalMerchantId,
    },
    { status: 200 },
  )
}
