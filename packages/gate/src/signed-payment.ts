/**
 * D-038: read only vi's resolved L3a from the chain verified by check 4.
 * The issuer JWS contains SD hash references, not the disclosed payment. Resolving those hashes
 * belongs exclusively to vi; neither token claims nor our cached columns are a fallback here.
 */
import { schemas, type CsErrorCode, type Money } from '@countersign/core'
import { z } from 'zod'

export const PAYMENT_SOURCE = 'verify.disclosed.l3a.delegate_payload'

const integerMinor = z
  .union([
    z.number().int().nonnegative().refine(Number.isSafeInteger),
    z.string().regex(/^\d+$/),
    z.bigint().nonnegative(),
  ])
  .transform((raw) => schemas.bigintFromJson(raw))

// Terminate in a transform: consumers receive Money, never an unchecked wire amount.
const paymentSchema = z
  .object({
    vct: z.literal('mandate.payment.1'),
    payment_amount: z.object({ amount: integerMinor, currency: schemas.currencySchema }),
    payee: z.object({
      id: z
        .string()
        .min(1)
        .refine((id) => id.trim().length > 0),
    }),
  })
  .transform((payment) => ({
    amount: { minor: payment.payment_amount.amount, currency: payment.payment_amount.currency },
    payeeId: payment.payee.id,
  }))

export type SignedPaymentReading =
  | { readonly found: true; readonly amount: Money; readonly payeeId: string }
  | { readonly found: false; readonly why: string; readonly code: CsErrorCode }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A missing, malformed, unresolved or ambiguous payment is unreadable, never notApplicable. */
export function readSignedPayment(l3a: unknown): SignedPaymentReading {
  if (!object(l3a)) {
    return {
      found: false,
      code: 'CS_VALIDATION',
      why: 'verify.disclosed.l3a is absent or malformed',
    }
  }
  const delegates = l3a['delegate_payload']
  if (!Array.isArray(delegates)) {
    return { found: false, code: 'CS_VALIDATION', why: `${PAYMENT_SOURCE} is absent or malformed` }
  }
  const payments = delegates.filter(
    (entry: unknown) => object(entry) && entry['vct'] === 'mandate.payment.1',
  )
  if (payments.length !== 1) {
    return {
      found: false,
      code: 'CS_VALIDATION',
      why: `${PAYMENT_SOURCE} must disclose exactly one mandate.payment.1 payment; found ${payments.length}`,
    }
  }
  const parsed = paymentSchema.safeParse(payments[0])
  if (!parsed.success) {
    const entry: unknown = payments[0]
    const paymentAmount = object(entry) ? entry['payment_amount'] : undefined
    const raw = object(paymentAmount) ? paymentAmount['amount'] : undefined
    const fractional = typeof raw === 'number' && !Number.isInteger(raw)
    const issue = parsed.error.issues[0]
    return {
      found: false,
      code: fractional ? 'CS_ROUNDING' : 'CS_VALIDATION',
      why: `${PAYMENT_SOURCE}.mandate.payment.1.${issue?.path.join('.') ?? 'payment'} is absent or malformed: ${issue?.message ?? 'no detail'}; amounts must be integer minor units`,
    }
  }
  return { found: true, ...parsed.data }
}
