/** Read the checkout mandate vi resolved while verifying the L3b SD-JWT. */
import { z } from 'zod'

export const CHECKOUT_SOURCE =
  'verify.disclosed.l3b.delegate_payload[vct="mandate.checkout.1"].checkout_hash'

const checkoutSchema = z.object({
  vct: z.literal('mandate.checkout.1'),
  checkout_hash: z.string().min(1),
})

export type SignedCheckoutReading =
  | { readonly found: true; readonly checkoutHash: string }
  | { readonly found: false; readonly why: string }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Missing, malformed, unresolved or ambiguous disclosures block; no decoded-claim fallback. */
export function readSignedCheckout(l3b: unknown): SignedCheckoutReading {
  if (!object(l3b) || !Array.isArray(l3b['delegate_payload'])) {
    return { found: false, why: `${CHECKOUT_SOURCE} is absent or malformed` }
  }
  const checkouts = l3b['delegate_payload'].filter(
    (entry: unknown) => object(entry) && entry['vct'] === 'mandate.checkout.1',
  )
  if (checkouts.length !== 1) {
    return {
      found: false,
      why: `${CHECKOUT_SOURCE} must disclose exactly one checkout mandate; found ${checkouts.length}`,
    }
  }
  const parsed = checkoutSchema.safeParse(checkouts[0])
  if (!parsed.success) return { found: false, why: `${CHECKOUT_SOURCE} is absent or malformed` }
  return { found: true, checkoutHash: parsed.data.checkout_hash }
}
