/**
 * PayPal request and response shapes — spec §8.6, [B12] [B14] [B15] [B16].
 *
 * ## Three rules for every schema in this file
 *
 *  1. **`looseObject`, never `strict`.** PayPal returns fields we do not model, and adds more without
 *     a version bump. A `z.strictObject` here would turn a PayPal-side addition into a total outage
 *     of the payment path. Unknown keys pass through; the fields we actually use are typed.
 *  2. **Required means *we* need it, not that PayPal promises it.** `id` and `status` are required on
 *     a resource because every caller in this repo branches on them. Timestamps and breakdowns are
 *     optional even though PayPal usually sends them.
 *  3. **Enums are `string`, with the known values exported as constants.** A zod enum for
 *     `dispute_state` would reject the day PayPal adds a state — and a dispute API rejecting a new
 *     state is exactly when you least want a validation error. The constants document what exists
 *     today; the helpers (`isDisputeState`, …) are where behaviour actually branches.
 *
 * ## Money
 *
 * Amounts are `{ currency_code, value }` with `value` a **decimal string** — PayPal's own shape
 * ([B12] payments v2, orders v2). Requests reuse `schemas.ppAmountSchema` from `@countersign/core`,
 * which is the strict one (our currencies, exact minor digits). Responses use
 * {@link ppAmountResponseSchema}, which is tolerant about the currency but still refuses a JSON
 * number for `value`: a number in that position means a float was created upstream and the precision
 * is already gone (spec §8.1, `packages/core/src/money.ts`).
 *
 * ## Provenance
 *
 * Each schema names the doc it was written from. Anything uncertain is marked
 * `TODO(verify against docs)` and listed in `README.md`; do not delete those markers, resolve them.
 */
import { z } from 'zod'

import { schemas, currency, fromPayPalValue } from '@countersign/core'
import type { CsError, Currency, Money, Result } from '@countersign/core'

/** Strict amount for a request we build: our currencies, exact minor digits. */
export const ppAmountSchema = schemas.ppAmountSchema
export type PPMoney = { currency_code: Currency; value: string }

/**
 * Tolerant amount for a response. Currency is any 3-letter code (PayPal can settle in one we do not
 * support); `value` must still be a string.
 */
export const ppAmountResponseSchema = z.looseObject({
  currency_code: z.string().length(3),
  value: z.string(),
})
export type PPMoneyResponse = { currency_code: string; value: string; [key: string]: unknown }

/**
 * Convert a PayPal amount object into the repo's canonical `Money` (integer minor units).
 *
 * Returns `Result` rather than throwing because the currency on a *response* may be one we do not
 * support: `CURRENCIES` is the demo's list (spec §2), but PayPal settles in whatever it likes
 * (EC-FX-2). An unsupported code therefore surfaces as the `CS_VALIDATION` that `currency()` already
 * produces in core, rather than a translation invented in this package.
 *
 * `value` goes through `fromPayPalValue`, so `"1.005"` is rejected as `CS_ROUNDING` rather than
 * silently rounded (spec §8.1 AT-M1.2).
 */
export function ppResponseAmountToMoney(m: PPMoneyResponse): Result<Money, CsError> {
  try {
    return { ok: true, value: fromPayPalValue(m.value, currency(m.currency_code)) }
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
      return { ok: false, error: e as CsError }
    }
    throw e
  }
}

/** `PayPal-Money`-ish breakdown on a capture (EC-FX-2: what the buyer was actually charged). */
export const sellerReceivableBreakdownSchema = z.looseObject({
  gross_amount: ppAmountResponseSchema.optional(),
  paypal_fee: ppAmountResponseSchema.optional(),
  paypal_fee_in_transaction_currency: ppAmountResponseSchema.optional(),
  net_amount: ppAmountResponseSchema.optional(),
  exchange_rate: z.string().optional(),
  exchange_rate_id: z.string().optional(),
  fees: z.looseObject({}).optional(),
  platform_fees: z.array(z.looseObject({})).optional(),
})

/** `seller_protection` — the dispute window PayPal gives us on a capture/authorization [V15]. */
export const sellerProtectionSchema = z.looseObject({
  status: z.string().optional(),
  dispute_categories: z.array(z.string()).optional(),
})

/** PayPal HATEOAS links. The spec's return type for every dispute action is `Links`. */
export const paypalLinkSchema = z.looseObject({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
})
export type PaypalLink = { href: string; rel: string; method?: string; [key: string]: unknown }

/**
 * `Links` — the HATEOAS envelope.
 *
 * `links` is always present after parsing, and an absent or empty body is normal: the dispute action
 * endpoints answer `204 No Content` (TODO(verify against docs) — see README's unverified list), which
 * becomes `{ links: [] }` rather than forcing `?? []` onto every caller.
 */
export type Links = { links: PaypalLink[]; [key: string]: unknown }

export const linksSchema = z
  .preprocess(
    // `204 No Content` means `undefined`, not `{}`. Accepting it here is what keeps a successful
    // accept-claim from being reported as an unexpected response.
    (v) => (v === undefined || v === null ? {} : v),
    z.looseObject({ links: z.array(paypalLinkSchema).optional() }),
  )
  .transform((v): Links => ({ ...v, links: v.links ?? [] }))

// ---------------------------------------------------------------------------
// OAuth (§10.2 #1 and #2, https://developer.paypal.com/api/rest/authentication/)
// ---------------------------------------------------------------------------

export const oauthTokenSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  app_id: z.string().optional(),
  nonce: z.string().optional(),
})
export type OauthToken = {
  access_token: string
  token_type?: string
  expires_in: number
  scope?: string
  app_id?: string
  nonce?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Vault v3 (§10.2 #3 and #4, [V9] [V10])
// https://developer.paypal.com/docs/api/vault/v3/token_type/setup-tokens/tokens/create
// ---------------------------------------------------------------------------

export const vaultPaymentSourcePaypalSchema = z.looseObject({
  // `vault_id` is the merchant-initiated payment source for an order (spec §10.2 #5).
  vault_id: z.string().optional(),
  account_id: z.string().optional(),
  account_status: z.string().optional(),
  email_address: z.string().optional(),
  name: z.looseObject({ given_name: z.string().optional(), surname: z.string().optional() }).optional(),
  address: z.looseObject({}).optional(),
})
export type VaultPaymentSourcePaypal = { [key: string]: unknown }

/** `payment_source` — exactly one of `paypal`, `card`, `bank`, or a token reference. */
export const paymentSourceSchema = z.looseObject({
  paypal: vaultPaymentSourcePaypalSchema.optional(),
  card: z.looseObject({}).optional(),
  bank: z.looseObject({}).optional(),
})
export type PaymentSource = { [key: string]: unknown }

/** `POST /v3/vault/setup-tokens` (client_credentials or a request id), [V9]. */
export const setupTokenReqSchema = z.looseObject({
  payment_source: paymentSourceSchema.optional(),
  customer: z.looseObject({}).optional(),
  experience_context: z.looseObject({}).optional(),
  mandate: z.looseObject({}).optional(),
})
export type SetupTokenReq = {
  /** `usage_type: MERCHANT`, `usage_pattern` — spec §8.7 step 3, U6 says copy verbatim from the doc. */
  payment_source?: { paypal?: { usage_type?: string; usage_pattern?: string } }
  experience_context?: { return_url?: string; cancel_url?: string; user_action?: string; [key: string]: unknown }
  [key: string]: unknown
}

export const setupTokenSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().optional(),
  customer: z.looseObject({}).optional(),
  payment_source: paymentSourceSchema.optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(paypalLinkSchema).optional(),
})
export type SetupToken = {
  id: string
  status?: string
  customer?: { id?: string; [key: string]: unknown }
  payment_source?: PaymentSource
  create_time?: string
  update_time?: string
  links?: PaypalLink[]
  [key: string]: unknown
}

/** `POST /v3/vault/payment-tokens` with `payment_source.token {id, type: 'SETUP_TOKEN'}` [V9]. */
export const paymentTokenSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().optional(),
  customer: z.looseObject({ id: z.string().optional() }).optional(),
  payer: z.looseObject({}).optional(),
  payment_source: paymentSourceSchema.optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(paypalLinkSchema).optional(),
})
export type PaymentToken = {
  /** The vault id used as `payment_source.paypal.vault_id` on an order (§10.2 #4-5). */
  id: string
  status?: string
  customer?: { id?: string; [key: string]: unknown }
  payer?: { email_address?: string; payer_id?: string; [key: string]: unknown }
  payment_source?: PaymentSource
  create_time?: string
  update_time?: string
  links?: PaypalLink[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Orders v2 (§10.2 #5-8, [V11])
// https://developer.paypal.com/docs/api/orders/v2/
// ---------------------------------------------------------------------------

/**
 * A purchase unit's `payments` block — an AUTHORIZE or CAPTURE order reports the ids it created here,
 * under `purchase_units[].payments`. Those ids are what the orchestrator and the reconciler join on,
 * so they are typed rather than left as an opaque object.
 */
export const orderPaymentsSchema = z.looseObject({
  authorizations: z.array(z.looseObject({ id: z.string().optional() })).optional(),
  captures: z.array(z.looseObject({ id: z.string().optional() })).optional(),
  refunds: z.array(z.looseObject({ id: z.string().optional() })).optional(),
})
export type OrderPayments = {
  authorizations?: { id?: string }[]
  captures?: { id?: string }[]
  refunds?: { id?: string }[]
  [key: string]: unknown
}

/**
 * One purchase unit. `custom_id` and `invoice_id` are the two fields spec D18 depends on:
 * `custom_id` carries the evidence hash and `invoice_id` our `ord_…` id.
 */
export const purchaseUnitSchema = z.looseObject({
  reference_id: z.string().optional(),
  id: z.string().optional(),
  amount: ppAmountResponseSchema.optional(),
  payee: z.looseObject({}).optional(),
  payment_instruction: z.looseObject({}).optional(),
  description: z.string().optional(),
  /** D18: `cs1:` + 43 base64url chars — the chain hash, inside PayPal's own records. */
  custom_id: z.string().optional(),
  /** D18: `ord_…`. */
  invoice_id: z.string().optional(),
  soft_descriptor: z.string().optional(),
  items: z.array(z.looseObject({})).optional(),
  shipping: z.looseObject({}).optional(),
  payments: orderPaymentsSchema.optional(),
})
export type PurchaseUnit = {
  reference_id?: string
  id?: string
  amount?: PPMoneyResponse
  description?: string
  custom_id?: string
  invoice_id?: string
  items?: { name?: string; quantity?: string; unit_amount?: PPMoneyResponse; [key: string]: unknown }[]
  /** Where an AUTHORIZE or CAPTURE order reports the ids it created. */
  payments?: OrderPayments
  [key: string]: unknown
}

/** `POST /v2/checkout/orders` — spec §10.2 #5, D17 (`AUTHORIZE` | `CAPTURE`). */
export const createOrderReqSchema = z.looseObject({
  intent: z.enum(['CAPTURE', 'AUTHORIZE']),
  purchase_units: z.array(purchaseUnitSchema).min(1),
  payment_source: paymentSourceSchema.optional(),
  application_context: z.looseObject({}).optional(),
  payer: z.looseObject({}).optional(),
})
export type CreateOrderReq = {
  intent: 'CAPTURE' | 'AUTHORIZE'
  purchase_units: PurchaseUnit[]
  /** `payment_source.paypal.vault_id` — merchant-initiated, no buyer present (spec C2). */
  payment_source?: { paypal?: { vault_id?: string; [key: string]: unknown } }
  application_context?: { return_url?: string; cancel_url?: string; [key: string]: unknown }
  [key: string]: unknown
}

export const orderSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  intent: z.string().optional(),
  processing_instruction: z.string().optional(),
  purchase_units: z.array(purchaseUnitSchema).optional(),
  payer: z.looseObject({}).optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(paypalLinkSchema).optional(),
})
export type Order = {
  id: string
  status: string
  intent?: string
  purchase_units?: PurchaseUnit[]
  create_time?: string
  update_time?: string
  links?: PaypalLink[]
  [key: string]: unknown
}

/**
 * `POST /v2/checkout/orders/{id}/track` body [V11] (§10.2 #8).
 *
 * `capture_id` links tracking to the capture it proves — which is what EC-SPLIT-2's "track twice
 * against the same capture" needs.
 */
export const trackReqSchema = z.looseObject({
  capture_id: z.string().min(1),
  tracking_number: z.string().min(1),
  carrier: z.string().optional(),
  items: z.array(z.looseObject({})).optional(),
})
export type TrackReq = {
  capture_id: string
  tracking_number: string
  carrier?: string
  items?: { sku?: string; name?: string; quantity?: string; [key: string]: unknown }[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Payments v2 (§10.2 #7, #9-11, [B12])
// https://developer.paypal.com/docs/api/payments/v2/
// ---------------------------------------------------------------------------

/** `POST /v2/payments/authorizations/{id}/capture` body [B12]. */
export const captureRequestSchema = z.looseObject({
  amount: ppAmountSchema.optional(),
  final_capture: z.boolean(),
  invoice_id: z.string().optional(),
  note_to_payer: z.string().optional(),
  soft_descriptor: z.string().optional(),
})
export type CaptureRequestBody = {
  /** Omitted to capture the full authorized amount (B12: "to capture a portion of the full amount"). */
  amount?: PPMoney
  /** `true` on the last capture of an authorization; the remainder is released (spec EC-STOCK-1). */
  final_capture: boolean
  invoice_id?: string
  note_to_payer?: string
  [key: string]: unknown
}

/** `POST /v2/payments/authorizations/{id}/reauthorize` body [B12], [V15]. */
export const reauthorizeRequestSchema = z.looseObject({
  amount: ppAmountSchema.optional(),
})
export type ReauthorizeRequestBody = { amount?: PPMoney; [key: string]: unknown }

export const authorizationSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  status_update_time: z.string().optional(),
  /** RFC 3339; the 29-day clock spec EC-TIME-5 tracks (29 days, 3-day honour period [V15]). */
  expiration_time: z.string().optional(),
  amount: ppAmountResponseSchema.optional(),
  invoice_id: z.string().optional(),
  custom_id: z.string().optional(),
  seller_protection: sellerProtectionSchema.optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(paypalLinkSchema).optional(),
})
export type Authorization = {
  id: string
  status: string
  expiration_time?: string
  amount?: PPMoneyResponse
  invoice_id?: string
  custom_id?: string
  seller_protection?: { status?: string; dispute_categories?: string[]; [key: string]: unknown }
  [key: string]: unknown
}

export const captureSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  status_update_time: z.string().optional(),
  amount: ppAmountResponseSchema.optional(),
  final_capture: z.boolean().optional(),
  invoice_id: z.string().optional(),
  custom_id: z.string().optional(),
  seller_protection: sellerProtectionSchema.optional(),
  seller_receivable_breakdown: sellerReceivableBreakdownSchema.optional(),
  disbursement_mode: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(paypalLinkSchema).optional(),
})
export type Capture = {
  id: string
  status: string
  amount?: PPMoneyResponse
  final_capture?: boolean
  invoice_id?: string
  custom_id?: string
  /** EC-FX-2: what the buyer paid in their own currency. */
  seller_receivable_breakdown?: { gross_amount?: PPMoneyResponse; net_amount?: PPMoneyResponse; [key: string]: unknown }
  [key: string]: unknown
}

/** `POST /v2/payments/captures/{id}/refund` body [B12]. */
export const refundRequestSchema = z.looseObject({
  amount: ppAmountSchema.optional(),
  invoice_id: z.string().optional(),
  note_to_payer: z.string().optional(),
  custom_id: z.string().optional(),
})
export type RefundRequestBody = {
  /** Omitted refunds the full capture (spec §12.1 partial refunds). */
  amount?: PPMoney
  invoice_id?: string
  note_to_payer?: string
  custom_id?: string
  [key: string]: unknown
}

export const refundSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  status_update_time: z.string().optional(),
  amount: ppAmountResponseSchema.optional(),
  invoice_id: z.string().optional(),
  custom_id: z.string().optional(),
  note_to_payer: z.string().optional(),
  seller_payable_breakdown: sellerReceivableBreakdownSchema.optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(paypalLinkSchema).optional(),
})
export type Refund = {
  id: string
  status: string
  amount?: PPMoneyResponse
  note_to_payer?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Disputes v1 (§10.2 #13-17, [V3] [B16])
// https://developer.paypal.com/docs/api/customer-disputes/v1/
// ---------------------------------------------------------------------------

/** Known `dispute_life_cycle_stage` values [B16]. A string is still accepted; see the module note. */
export const DISPUTE_LIFE_CYCLE_STAGES = [
  'INQUIRY',
  'CHARGEBACK',
  'PRE_ARBITRATION',
  'ARBITRATION',
] as const

/** Known `dispute_state` values [B16], including `APPEALABLE` (spec §8.16). */
export const DISPUTE_STATES = [
  'OPEN',
  'WAITING_FOR_BUYER_RESPONSE',
  'WAITING_FOR_SELLER_RESPONSE',
  'UNDER_REVIEW',
  'RESOLVED',
  'CANCELED',
  'ACCEPTED',
  'REFUNDED',
  'APPEALABLE',
  'PENDING',
] as const

/** Known `status` values [B16]. The filing guard keys on `WAITING_FOR_SELLER_RESPONSE` (§8.15). */
export const DISPUTE_STATUSES = [
  'OPEN',
  'WAITING_FOR_BUYER_RESPONSE',
  'WAITING_FOR_SELLER_RESPONSE',
  'UNDER_REVIEW',
  'RESOLVED',
  'CANCELED',
  'ACCEPTED',
  'REFUNDED',
  'PENDING',
] as const

/** Known `dispute_reason` values [B16] (the ones the Defender router switches on). */
export const DISPUTE_REASONS = [
  'UNAUTHORISED',
  'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
  'MERCHANDISE_OR_SERVICE_NOT_RECEIVED_2',
  'CREDIT_NOT_PROCESSED',
  'DUPLICATE_TRANSACTION',
  'INCORRECT_AMOUNT',
  'CANCELED_RECURRING_BILLING',
  'UNPAID_AMOUNT',
  'REFUND_NOT_AS_DESCRIBED',
  'PAYOUT_DECLINED',
  'ACCOUNT_COMPROMISED',
  'OTHER',
] as const

/** `evidence_type` values [B16] that the Defender's plan references (§8.15 evidence table). */
export const EVIDENCE_TYPES = [
  'PROOF_OF_FULFILLMENT',
  'PROOF_OF_REFUND',
  'DETAILS_OF_PURCHASE',
  'ONLINE_TRACKING_INFORMATION',
  'ORDER_DETAILS',
  'ITEM_DESCRIPTION',
  'PROOF_OF_RECEIPT_COPY',
  'CHECKOUT_PAGE',
  'CANCELLED_RECURING_BILLING_AGREEMENT',
  'CUSTOMER_COMMUNICATION',
  'FULFILLMENT_DOCUMENTATION',
  'PROOF_OF_RETURN',
  'REFUND_POLICY',
  'TERMS_OF_SERVICE',
  'UNCONTROLLED_WEB_CONTENT',
  'OTHER',
] as const

export type DisputeLifeCycleStage = string
export type DisputeState = string
export type DisputeStatus = string
export type DisputeReason = string
export type EvidenceType = string

/** Evidence already on file — `evidence.notes` is what the router must not contradict (EC-DSP-5). */
export const disputeEvidenceSchema = z.looseObject({
  evidence_type: z.string().optional(),
  date: z.string().optional(),
  notes: z.array(z.string()).optional(),
  proof: z.looseObject({}).optional(),
})
export type DisputeEvidence = {
  evidence_type?: string
  date?: string
  notes?: string[]
  [key: string]: unknown
}

export const disputeOfferSchema = z.looseObject({
  offer_time: z.string().optional(),
  offer_type: z.string().optional(),
  terms: z.string().optional(),
  expiration_time: z.string().optional(),
  buyer_response_due_date: z.string().optional(),
  note: z.string().optional(),
  offer_amount: ppAmountResponseSchema.optional(),
  reacceptance_deadline: z.string().optional(),
  status: z.string().optional(),
})

export const disputeSchema = z.looseObject({
  dispute_id: z.string().min(1),
  dispute_state: z.string().optional(),
  /** EC-DSP-7/8: the deadline is RFC 3339 and we store UTC, display IST. */
  seller_response_due_date: z.string().optional(),
  buyer_response_due_date: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  dispute_reason: z.string().optional(),
  dispute_life_cycle_stage: z.string().optional(),
  dispute_channel: z.string().optional(),
  status: z.string().optional(),
  /** The capture the dispute is against — the join key to our order. */
  seller_transaction_id: z.string().optional(),
  buyer_transaction_id: z.string().optional(),
  dispute_amount: ppAmountResponseSchema.optional(),
  dispute_currency: z.string().optional(),
  dispute_summary: z.string().optional(),
  dispute_summary_evidence: z.string().optional(),
  accept_claim_type: z.string().optional(),
  adjudication_outcome: z.string().optional(),
  escalation_deadline: z.string().optional(),
  return_eligibility_deadline: z.string().optional(),
  require_evidence: z.looseObject({ action: z.string().optional(), due_date: z.string().optional() }).optional(),
  items: z.array(z.looseObject({})).optional(),
  offers: z.array(disputeOfferSchema).optional(),
  messages: z.array(z.looseObject({})).optional(),
  evidence: disputeEvidenceSchema.optional(),
  eligibility_claims: z.array(z.looseObject({})).optional(),
  links: z.array(paypalLinkSchema).optional(),
})
export type Dispute = {
  dispute_id: string
  dispute_state?: DisputeState
  dispute_reason?: DisputeReason
  dispute_life_cycle_stage?: DisputeLifeCycleStage
  status?: DisputeStatus
  seller_transaction_id?: string
  buyer_transaction_id?: string
  dispute_amount?: PPMoneyResponse
  /** EC-DSP-7: our deadline alert reads this. */
  seller_response_due_date?: string
  adjudication_outcome?: string
  require_evidence?: { action?: string; due_date?: string; [key: string]: unknown }
  evidence?: DisputeEvidence
  /** §8.16: the strategist proposes accepting or denying an offer from here. */
  offers?: { offer_type?: string; terms?: string; offer_amount?: PPMoneyResponse; [key: string]: unknown }[]
  messages?: { content?: string; sender?: string; [key: string]: unknown }[]
  [key: string]: unknown
}

/**
 * `GET /v1/customer/disputes` response envelope.
 *
 * `items` is defaulted to `[]` on the way out: the reconciler iterates it every two minutes
 * (spec §8.12) and an absent key should mean "none", not a crash in a cron.
 */
export type DisputeList = {
  items: Dispute[]
  total_pages?: number
  total_items?: number
  next_page_token?: string
  [key: string]: unknown
}

export const disputeListSchema = z
  .looseObject({
    items: z.array(disputeSchema).optional(),
    total_pages: z.number().optional(),
    total_items: z.number().optional(),
    next_page_token: z.string().optional(),
    prev_page_token: z.string().optional(),
  })
  .transform((v): DisputeList => ({ ...v, items: v.items ?? [] }))

/**
 * `GET /v1/customer/disputes` query. Spec §8.6 passes `next_page_token`; PayPal's disputes list is
 * documented with `page`/`page_size`/`total_pages` [V3], so both are sent and both are forwarded
 * unchanged rather than assuming one pagination model (see README's unverified list).
 */
export const listDisputesQuerySchema = z.looseObject({
  start_time: z.string().optional(),
  dispute_state: z.string().optional(),
  page_size: z.number().int().positive().max(500).optional(),
  page: z.number().int().positive().optional(),
  next_page_token: z.string().optional(),
})
export type ListDisputesQuery = {
  start_time?: string
  dispute_state?: string
  page_size?: number
  page?: number
  next_page_token?: string
  [key: string]: unknown
}

/**
 * The `input` part of a `provide-evidence` / `appeal` multipart upload [V3],
 * https://developer.paypal.com/api/customer-disputes/v1/disputes-provide-evidence.
 */
export const provideEvidenceInputSchema = z.looseObject({
  evidence_type: z.string().min(1),
  date: z.string().optional(),
  notes: z.array(z.string()).optional(),
})
export type ProvideEvidenceInput = {
  evidence_type: string
  date?: string
  notes?: string[]
  [key: string]: unknown
}

/** `POST …/accept-claim` body. Multipart per [B16]; the known values are [V3]. */
export const acceptClaimReqSchema = z.looseObject({
  accept_claim_type: z.string().min(1),
  note: z.string().optional(),
})
export type AcceptClaimReq = { accept_claim_type: string; note?: string; [key: string]: unknown }

/** `POST …/make-offer` body [V3]. `REFUND_WITH_RETURN` is what spec EC-BUY-1 recommends. */
export const makeOfferReqSchema = z.looseObject({
  offer_amount: ppAmountSchema,
  offer_type: z.string().min(1),
  terms: z.string().optional(),
  expiration_time: z.string().optional(),
  buyer_response_due_date: z.string().optional(),
  note: z.string().optional(),
})
export type MakeOfferReq = {
  offer_amount: PPMoney
  /** `REFUND_WITH_RETURN` | `REFUND_NO_RETURN` — verify against the doc (see README). */
  offer_type: string
  terms?: string
  expiration_time?: string
  note?: string
  [key: string]: unknown
}

/** `POST …/acknowledge-return-item` body [V3]. */
export const ackReturnReqSchema = z.looseObject({
  note: z.string().optional(),
  return_shipping_address: z.looseObject({}).optional(),
})
export type AckReturnReq = { note?: string; return_shipping_address?: Record<string, unknown>; [key: string]: unknown }

// ---------------------------------------------------------------------------
// Sandbox-only simulators (§10.2 #18, §10.3, [S29] [V3])
// https://developer.paypal.com/disputes/test-go-live
// ---------------------------------------------------------------------------

/**
 * `POST /v1/customer/disputes` (buyer-side simulator) body [S29].
 *
 * TODO(verify against docs): the exact field for the transaction being disputed. We send
 * `transaction_id` (the capture id) and, when supplied, `buyer_transaction_id`.
 */
export const simDisputeReqSchema = z.looseObject({
  transaction_id: z.string().min(1),
  dispute_reason: z.string().min(1),
  dispute_life_cycle_stage: z.string().optional(),
  reason_code: z.string().optional(),
  invoice_number: z.string().optional(),
})
export type SimDisputeReq = {
  /** The capture id the buyer is disputing. */
  transaction_id: string
  /** One of `DISPUTE_REASONS`. */
  dispute_reason: string
  dispute_life_cycle_stage?: string
  [key: string]: unknown
}

/** `POST /v1/customer/disputes/{id}/require-evidence` body [B16]. */
export const requireEvidenceReqSchema = z.looseObject({
  action: z.enum(['BUYER_EVIDENCE', 'SELLER_EVIDENCE']),
})
export type RequireEvidenceAction = 'BUYER_EVIDENCE' | 'SELLER_EVIDENCE'

/** `POST /v1/customer/disputes/{id}/adjudicate` body [B16]. */
export const adjudicateReqSchema = z.looseObject({
  adjudication_outcome: z.enum(['BUYER_FAVOR', 'SELLER_FAVOR']),
})
export type AdjudicationOutcome = 'BUYER_FAVOR' | 'SELLER_FAVOR'

/** `POST /v1/customer/disputes/{id}/change-reason` body. TODO(verify against docs): field name. */
export const changeReasonReqSchema = z.looseObject({
  reason: z.string().min(1),
})
export type ChangeReasonReq = { reason: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// Webhooks (§10.2 #12, [V14])
// ---------------------------------------------------------------------------

/** The transmission headers PayPal sends, which `verify-webhook-signature` requires [V14]. */
export const webhookHeadersSchema = z.looseObject({
  'paypal-transmission-id': z.string().min(1),
  'paypal-transmission-time': z.string().min(1),
  'paypal-transmission-sig': z.string().min(1),
  'paypal-cert-url': z.string().min(1),
  'paypal-auth-algo': z.string().min(1),
})
export type WebhookHeaders = {
  'paypal-transmission-id': string
  'paypal-transmission-time': string
  'paypal-transmission-sig': string
  'paypal-cert-url': string
  'paypal-auth-algo': string
  [key: string]: unknown
}

export const verifyWebhookSignatureReqSchema = z.looseObject({
  auth_algo: z.string(),
  cert_url: z.string(),
  transmission_id: z.string(),
  transmission_sig: z.string(),
  transmission_time: z.string(),
  webhook_id: z.string(),
  webhook_event: z.looseObject({}),
})
export const verifyWebhookSignatureResSchema = z.looseObject({
  verification_status: z.string(),
})
export type WebhookVerificationStatus = 'SUCCESS' | 'FAILURE'

/**
 * The subscribed event names (spec §8.12 [B13]).
 *
 * Used for logging and for the reconciler's coverage check, never to reject an event: an unknown
 * event name must still be stored (§8.12 EC-WH-6).
 */
export const WEBHOOK_EVENT_NAMES = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.REFUND.PENDING',
  'PAYMENT.REFUND.FAILED',
  'PAYMENT.REFUND.COMPLETED',
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'CHECKOUT.ORDER.APPROVED',
  'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
  'VAULT.PAYMENT-TOKEN.CREATED',
  'VAULT.PAYMENT-TOKEN.DELETED',
  'VAULT.PAYMENT-TOKEN.DELETION-INITIATED',
] as const

export type WebhookEventName = (typeof WEBHOOK_EVENT_NAMES)[number]

/** Known order `status` values [V11]. */
export const ORDER_STATUSES = [
  'CREATED',
  'SAVED',
  'APPROVED',
  'VOIDED',
  'COMPLETED',
  'PAYER_ACTION_REQUIRED',
] as const

/** Known capture/authorization/refund `status` values [B12]. */
export const PAYMENT_STATUSES = [
  'CREATED',
  'SAVED',
  'PENDING',
  'APPROVED',
  'VOIDED',
  'COMPLETED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'FAILED',
  'DECLINED',
  'EXPIRED',
  'REVERSED',
  'DENIED',
] as const

/**
 * Capture status rank (spec §8.12) — `PENDING(1) < COMPLETED(2) < PARTIALLY_REFUNDED(3) <
 * REFUNDED(4)`, with `REVERSED`/`DECLINED` terminal.
 *
 * Exported here so the rank has one definition, but the ordering decision belongs to WP-12
 * (M12) which owns the reconciler; this is the constant, not the policy.
 */
export const CAPTURE_STATUS_RANK: Readonly<Record<string, number>> = {
  CREATED: 0,
  PENDING: 1,
  COMPLETED: 2,
  PARTIALLY_REFUNDED: 3,
  REFUNDED: 4,
  REVERSED: 5,
  DECLINED: 5,
  FAILED: 5,
  VOIDED: 5,
}
