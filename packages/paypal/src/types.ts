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
 *     today; the helpers (`isAppealable`, `disputeCaptureId`, …) are where behaviour actually branches.
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
 * Each schema names the doc it was written from. **Every field name and enum below was re-checked
 * against PayPal's published OpenAPI and `developer.paypal.com` on 2026-10-04** — the audit is
 * `docs/verification/paypal-api-2026-10-04.md`, and its corrections are applied. Two things follow
 * from that audit and are worth reading before editing anything here:
 *
 *  - **An unverified assumption is written as an `ASSUMPTION:` comment, not as a `TODO`.** There are
 *    four: `payment_source` being required on a setup token, `accept_claim_type` as a request field,
 *    `payer_id` and `account_id` carrying the same value, and decimal-vs-binary "MB". Do not delete
 *    those markers — resolve them with the probe.
 *  - **Where PayPal documents a field we do not model, say so.** A silently-absent field is how this
 *    file ended up with four fabricated request bodies in the first place.
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
 * `links` is always present after parsing. An absent or empty body is **tolerated**, but it is not
 * what PayPal sends: every documented dispute action (`provide-evidence`, `accept-claim`,
 * `make-offer`, `send-message`, `appeal`, `acknowledge-return-item`, `provide-supporting-info`,
 * `escalate`) answers **`200 OK` with `{links: […]}`** — `SPEC-D` `components.schemas.escalate_response`
 * is `{links}`, and the "Use Disputes API" guide shows the same envelope for every seller action.
 * (`RESOLVED`, verification report §2/§4/§6/§8.) The tolerance exists only because `POST
 * /v2/payments/authorizations/{id}/void` and `DELETE /v3/vault/payment-tokens/{id}` genuinely answer
 * `204 No Content`, so defaulting to `[]` saves every caller a `?? []`.
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

/**
 * Vault v3 `payment_source.paypal.usage_type` — `SPEC-V` `paypal_wallet_request` (report §21).
 *
 * Spec §10.2's `MERCHANT` claim is **confirmed**: `MERCHANT` is a real value.
 */
export const VAULT_USAGE_TYPES = ['MERCHANT', 'PLATFORM'] as const
export type VaultUsageType = (typeof VAULT_USAGE_TYPES)[number]

/**
 * Vault v3 `payment_source.paypal.usage_pattern` — all 12 values (`SPEC-V`, report §21).
 *
 * For the one-shot merchant-initiated charge of spec D17, `IMMEDIATE` is what PayPal's own Orders v2
 * example uses for a non-recurring purchase (its example passes `RECURRING_PREPAID` because it stores
 * credentials for later).
 */
export const VAULT_USAGE_PATTERNS = [
  'IMMEDIATE',
  'DEFERRED',
  'RECURRING_PREPAID',
  'RECURRING_POSTPAID',
  'THRESHOLD_PREPAID',
  'THRESHOLD_POSTPAID',
  'UNSCHEDULED_POSTPAID',
  'UNSCHEDULED_PREPAID',
  'SUBSCRIPTION_PREPAID',
  'SUBSCRIPTION_POSTPAID',
  'INSTALLMENT_POSTPAID',
  'INSTALLMENT_PREPAID',
] as const
export type VaultUsagePattern = (typeof VAULT_USAGE_PATTERNS)[number]

/** Vault v3 `payment_source.paypal.customer_type` (`SPEC-V`, report §21). */
export const VAULT_CUSTOMER_TYPES = ['CONSUMER', 'BUSINESS'] as const
export type VaultCustomerType = (typeof VAULT_CUSTOMER_TYPES)[number]

/**
 * Vault v3 `payment_source.paypal` (`SPEC-V` `paypal_wallet_request` = `wallet_base` +
 * `{billing_plan, experience_context}`).
 *
 * **Placement matters more than it looks** (verification report §21, `SPEC-V`): `usage_type`,
 * `usage_pattern`, `customer_type`, `permit_multiple_payment_tokens`, `description`, `shipping` and
 * `experience_context` all live **under `payment_source.paypal`**, not at the top level of the
 * request. `setup_token_request` has exactly two top-level properties, `customer` and
 * `payment_source`. Declaring them here — rather than letting a generic `looseObject` pass them
 * through unvalidated — is what makes a misplaced field a local `CS_VALIDATION`.
 */
export const vaultPaymentSourcePaypalSchema: z.ZodType<VaultPaymentSourcePaypal> = z.looseObject({
  // `vault_id` is the merchant-initiated payment source for an order (spec §10.2 #5).
  vault_id: z.string().optional(),
  account_id: z.string().optional(),
  account_status: z.string().optional(),
  email_address: z.string().optional(),
  name: z
    .looseObject({ given_name: z.string().optional(), surname: z.string().optional() })
    .optional(),
  address: z.looseObject({}).optional(),
  /** `MERCHANT` | `PLATFORM` (`SPEC-V` `paypal_wallet_request.usage_type`). Spec §10.2's `MERCHANT`
   *  claim is confirmed by the report. */
  usage_type: z.string().optional(),
  /** 12 values, `IMMEDIATE` … `INSTALLMENT_PREPAID`. See {@link VAULT_USAGE_PATTERNS}. */
  usage_pattern: z.string().optional(),
  /** `CONSUMER` | `BUSINESS`. */
  customer_type: z.string().optional(),
  permit_multiple_payment_tokens: z.boolean().optional(),
  description: z.string().optional(),
  shipping: z.looseObject({}).optional(),
  billing_plan: z.looseObject({}).optional(),
  /** `SPEC-V` `experience_context`: `brand_name`, `locale`, `return_url`, `cancel_url`,
   *  `shipping_preference`, `vault_instruction`. **Not** `user_action` — that field belongs to the
   *  Orders v2 `paypal_wallet_experience_context`, a different schema. */
  experience_context: z.looseObject({}).optional(),
})

/**
 * One of the values PayPal has documented, **or** a string it publishes later.
 *
 * This is the compile-time half of the module's rule that enums are `string` at runtime: the wire
 * schema accepts any string (so a new PayPal value is never a validation outage), while the declared
 * type still suggests the documented literals in an editor.
 */
type Documented<T extends string> = T | (string & {})

export type VaultPaymentSourcePaypal = {
  usage_type?: Documented<VaultUsageType>
  usage_pattern?: Documented<VaultUsagePattern>
  customer_type?: Documented<VaultCustomerType>
  permit_multiple_payment_tokens?: boolean
  experience_context?: {
    brand_name?: string
    locale?: string
    /** "Required for contingency flows like PayPal wallet" (`SPEC-V`). */
    return_url?: string
    cancel_url?: string
    shipping_preference?: string
    vault_instruction?: { action?: string; [key: string]: unknown }
    [key: string]: unknown
  }
  vault_id?: string
  account_id?: string
  account_status?: string
  email_address?: string
  description?: string
  [key: string]: unknown
}

/** `payment_source` — exactly one of `paypal`, `card`, `bank`, or a token reference. */
export const paymentSourceSchema: z.ZodType<PaymentSource> = z.looseObject({
  paypal: vaultPaymentSourcePaypalSchema.optional(),
  card: z.looseObject({}).optional(),
  bank: z.looseObject({}).optional(),
})
export type PaymentSource = {
  paypal?: VaultPaymentSourcePaypal
  [key: string]: unknown
}

/** `POST /v3/vault/setup-tokens` (client_credentials or a request id), [V9]. */
export const setupTokenReqSchema = z.looseObject({
  payment_source: paymentSourceSchema.optional(),
  customer: z.looseObject({}).optional(),
})
export type SetupTokenReq = {
  /**
   * `usage_type`/`usage_pattern` sit here, not at the top level — `SPEC-V`
   * `setup_token_request` has only `payment_source` and `customer` (report §21).
   *
   * ASSUMPTION: PayPal marks `payment_source` **required** on this request. We keep it optional so a
   * caller cannot be broken by a change here; nothing in §8.7 sends a body without it.
   */
  payment_source?: PaymentSource
  customer?: { id?: string; [key: string]: unknown }
  [key: string]: unknown
}

export const setupTokenSchema: z.ZodType<SetupToken> = z.looseObject({
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
  /**
   * The documented `201` includes a `rel: "confirm"` link to `/v3/vault/payment-token` — the
   * alternative to calling `POST /v3/vault/payment-tokens` directly with the setup-token id
   * (`SPEC-V`, report §21). Kept as a comment because nothing here follows it: §8.7 step 4
   * exchanges the token server-side.
   */
  links?: PaypalLink[]
  [key: string]: unknown
}

/**
 * `POST /v3/vault/payment-tokens` with `payment_source.token {id, type: 'SETUP_TOKEN'}` [V9].
 *
 * **There is no top-level `payer`** (report §16, `SPEC-V` `payment_token_response` =
 * `{id, customer, payment_source, links}`). The payer identity — email and id — arrives under
 * `payment_source.paypal`, which on a *response* is `paypal_wallet_response` = `wallet_base` +
 * `payer_base` (`{email_address, payer_id}`) + `{name, phone, address, account_id, phone_number}`.
 * The phantom top-level `payer` was never populated by PayPal; use {@link paymentTokenPayer}.
 */
export const paymentTokenSchema: z.ZodType<PaymentToken> = z.looseObject({
  id: z.string().min(1),
  status: z.string().optional(),
  customer: z.looseObject({ id: z.string().optional() }).optional(),
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
  payment_source?: PaymentSource
  create_time?: string
  update_time?: string
  links?: PaypalLink[]
  [key: string]: unknown
}

/** The payer fields of `payment_source.paypal` on a payment-token **response**. */
export type PaymentTokenPayer = {
  email_address?: string
  payer_id?: string
  account_id?: string
  [key: string]: unknown
}

/**
 * The payer identity carried by a payment token — `payment_source.paypal`, **not** a top-level
 * `payer` (report §16).
 *
 * `payer_id` is schema-declared but **absent from every example PayPal publishes**; the published
 * response (`customer_vault_payment_tokens_response`) shows only `account_id`. So the read is
 * `payer_id ?? account_id`.
 *
 * ASSUMPTION (report §22, labelled there as an inference): the two carry the *same* value. The
 * Orders v2 create response corroborates it on a different endpoint — `payer.payer_id` and
 * `payment_source.paypal.account_id` are both `XQHSN372NGSP2` there. A sandbox probe settles it.
 *
 * @returns the payer id, or `undefined` when PayPal sent neither.
 */
export function paymentTokenPayer(token: PaymentToken): PaymentTokenPayer | undefined {
  const paypal = token.payment_source?.paypal
  if (paypal === undefined) return undefined
  return paypal as PaymentTokenPayer
}

/**
 * The payer id for a payment token: `payment_source.paypal.payer_id`, falling back to
 * `payment_source.paypal.account_id`.
 *
 * The join key for "which wallet paid for this order" (§8.7 step 5). Reads both names on purpose:
 * PayPal publishes the response with `account_id` only, so a `payer_id`-only read would return
 * nothing in production.
 */
export function paymentTokenPayerId(token: PaymentToken): string | undefined {
  const payer = paymentTokenPayer(token)
  if (payer === undefined) return undefined
  if (typeof payer.payer_id === 'string' && payer.payer_id !== '') return payer.payer_id
  if (typeof payer.account_id === 'string' && payer.account_id !== '') return payer.account_id
  return undefined
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
  items?: {
    name?: string
    quantity?: string
    unit_amount?: PPMoneyResponse
    [key: string]: unknown
  }[]
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
  seller_receivable_breakdown?: {
    gross_amount?: PPMoneyResponse
    net_amount?: PPMoneyResponse
    [key: string]: unknown
  }
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

/**
 * `dispute_state` — the exact enum (`SPEC-D` `components.schemas.dispute_state`, report §11).
 *
 * Six values, and only six. The previous list in this file mixed `status` values in
 * (`WAITING_FOR_BUYER_RESPONSE`, `WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`, …) and invented
 * three more, so **five of its ten values could never match a real `dispute_state`** — a list that
 * looks like documentation and silently never fires. `APPEALABLE` is real (spec §8.16's assumption
 * holds), but see {@link isAppealable}: PayPal says the **`appeal` HATEOAS link** is what determines
 * eligibility, not this state.
 */
export const DISPUTE_STATES = [
  'OPEN_INQUIRIES',
  'REQUIRED_ACTION',
  'REQUIRED_OTHER_PARTY_ACTION',
  'UNDER_PAYPAL_REVIEW',
  'APPEALABLE',
  'RESOLVED',
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

/**
 * `dispute_reason` — the exact 10-value enum (`SPEC-D` `components.schemas.dispute_reason`,
 * report §11). These are the values the Defender router switches on.
 *
 * The five values this file used to list that PayPal does not have — `…_NOT_RECEIVED_2`,
 * `REFUND_NOT_AS_DESCRIBED`, `PAYOUT_DECLINED`, `ACCOUNT_COMPROMISED`, `UNPAID_AMOUNT` — are gone;
 * `PAYMENT_BY_OTHER_MEANS` and `PROBLEM_WITH_REMITTANCE`, which are real, are in.
 */
export const DISPUTE_REASONS = [
  'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
  'UNAUTHORISED',
  'CREDIT_NOT_PROCESSED',
  'DUPLICATE_TRANSACTION',
  'INCORRECT_AMOUNT',
  'PAYMENT_BY_OTHER_MEANS',
  'CANCELED_RECURRING_BILLING',
  'PROBLEM_WITH_REMITTANCE',
  'OTHER',
] as const

/**
 * `evidence_type` — the values the Defender's evidence plan references (spec §8.15 evidence table).
 *
 * `SPEC-D` declares **76** values (report §2). All seven the spec §8.15 relies on are confirmed real:
 * `PROOF_OF_FULFILLMENT`, `PROOF_OF_REFUND`, `DETAILS_OF_PURCHASE`, `ONLINE_TRACKING_INFORMATION`,
 * `ORDER_DETAILS`, `ITEM_DESCRIPTION`, `PROOF_OF_RECEIPT_COPY`. The nine other values this file used
 * to list — seven of which (`CHECKOUT_PAGE`, `CANCELLED_RECURING_BILLING_AGREEMENT`,
 * `CUSTOMER_COMMUNICATION`, `FULFILLMENT_DOCUMENTATION`, `REFUND_POLICY`, `TERMS_OF_SERVICE`,
 * `UNCONTROLLED_WEB_CONTENT`) do **not** exist in PayPal's enum — are removed. `PROOF_OF_RETURN` and
 * `OTHER` survive because they are real.
 */
export const EVIDENCE_TYPES = [
  'PROOF_OF_FULFILLMENT',
  'PROOF_OF_REFUND',
  'DETAILS_OF_PURCHASE',
  'ONLINE_TRACKING_INFORMATION',
  'ORDER_DETAILS',
  'ITEM_DESCRIPTION',
  'PROOF_OF_RECEIPT_COPY',
  'PROOF_OF_RETURN',
  'OTHER',
] as const

/**
 * `make-offer`'s `offer_type` — the exact enum (`SPEC-D` `components.schemas.make_offer`, report §4).
 *
 * **`REFUND_NO_RETURN` does not exist.** The previous comment in this file guessed
 * `REFUND_WITH_RETURN | REFUND_NO_RETURN`, which would have failed live. The non-return variant is
 * `REFUND` (refund, keep the item) or `REPLACEMENT_WITHOUT_REFUND` (replace, no refund).
 *
 * `x-enumDescriptions` and the "Use Disputes API" guide both state that `REFUND_WITH_RETURN`
 * requires `return_shipping_address` and `offer_amount`.
 */
export const OFFER_TYPES = [
  'REFUND',
  'REFUND_WITH_RETURN',
  'REFUND_WITH_REPLACEMENT',
  'REPLACEMENT_WITHOUT_REFUND',
] as const
export type OfferType = (typeof OFFER_TYPES)[number]

/**
 * `acknowledge-return-item`'s `acknowledgement_type` (`SPEC-D`
 * `components.schemas.acknowledgement_type`, report §6).
 *
 * Which values are permitted for a given dispute comes from the dispute's
 * `allowed_response_options.acknowledge_return_item.acknowledgement_types`, so this constant
 * documents the vocabulary rather than the eligibility.
 */
export const ACKNOWLEDGEMENT_TYPES = [
  'ITEM_RECEIVED',
  'ITEM_NOT_RECEIVED',
  'DAMAGED',
  'EMPTY_PACKAGE_OR_DIFFERENT',
  'MISSING_ITEMS',
] as const
export type AcknowledgementType = (typeof ACKNOWLEDGEMENT_TYPES)[number]

/**
 * `accept-claim`'s `accept_claim_type` (`SPEC-D` `components.schemas.accept_claim_type`, report §3).
 *
 * A **different** enum from {@link OFFER_TYPES} — `accept-claim` has `PARTIAL_REFUND` and
 * `REFUND_WITH_RETURN_SHIPMENT_LABEL`, which `make-offer` does not.
 */
export const ACCEPT_CLAIM_TYPES = [
  'REFUND',
  'REFUND_WITH_RETURN',
  'PARTIAL_REFUND',
  'REFUND_WITH_RETURN_SHIPMENT_LABEL',
] as const
export type AcceptClaimType = (typeof ACCEPT_CLAIM_TYPES)[number]

export type DisputeLifeCycleStage = string
export type DisputeState = string
export type DisputeStatus = string
export type DisputeReason = string
export type EvidenceType = string

/**
 * One entry of a dispute's `evidences` array (`SPEC-D` `components.schemas.evidence`, report §4).
 *
 * **`notes` is a `string`, not `string[]`** — `SPEC-D` types it `string, minLength 1,
 * maxLength 2000, pattern ^(.|\r?\n)*$`. The old `notes: z.array(z.string())` would have parsed a
 * real response into the wrong shape (or failed outright).
 *
 * This is the evidence already on file, and `notes` is what the router must not contradict
 * (spec EC-DSP-5).
 */
export const disputeEvidenceSchema = z.looseObject({
  evidence_type: z.string().optional(),
  date: z.string().optional(),
  notes: z.string().optional(),
  evidence_info: z
    .looseObject({
      tracking_info: z
        .array(
          z.looseObject({
            carrier_name: z.string().optional(),
            tracking_number: z.string().optional(),
          }),
        )
        .optional(),
      refund_ids: z.array(z.string()).optional(),
    })
    .optional(),
  documents: z
    .array(
      z.looseObject({
        name: z.string().optional(),
        size: z.number().optional(),
        type: z.string().optional(),
      }),
    )
    .optional(),
  source: z.string().optional(),
  dispute_life_cycle_stage: z.string().optional(),
  item_id: z.string().optional(),
  item_type: z.string().optional(),
  action_info: z.looseObject({}).optional(),
})
export type DisputeEvidence = {
  evidence_type?: string
  date?: string
  /** A single string (≤ 2000 chars), not an array. */
  notes?: string
  [key: string]: unknown
}

/**
 * One `disputed_transactions[]` entry (`SPEC-D` `transaction_info_list`, report §5).
 *
 * **This is where the join key lives.** `seller_transaction_id` and `buyer_transaction_id` are
 * *not* top-level properties of a Dispute; reading them from the top level (as this file did) can
 * never succeed against a real response, so the Defender's "which capture is this dispute about?"
 * join was silently always `undefined`. Use {@link disputeCaptureId}.
 */
export const disputeTransactionInfoSchema = z.looseObject({
  buyer_transaction_id: z.string().optional(),
  seller_transaction_id: z.string().optional(),
})
export type DisputeTransactionInfo = {
  buyer_transaction_id?: string
  seller_transaction_id?: string
  [key: string]: unknown
}

/** `allowed_response_options` — the discovery endpoint for `accept-claim`/`make-offer`/`acknowledge`. */
export const allowedResponseOptionsSchema = z.looseObject({
  acknowledge_return_item: z
    .looseObject({ acknowledgement_types: z.array(z.string()).optional() })
    .optional(),
  accept_claim: z.looseObject({ accept_claim_types: z.array(z.string()).optional() }).optional(),
  make_offer: z.looseObject({ offer_types: z.array(z.string()).optional() }).optional(),
})

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
  /** The field is **`reason`**, not `dispute_reason` (`SPEC-D` `dispute.properties.reason`). */
  reason: z.string().optional(),
  dispute_life_cycle_stage: z.string().optional(),
  dispute_channel: z.string().optional(),
  status: z.string().optional(),
  /**
   * The capture the dispute is against — the join key to our order. Nested, not top level
   * (`SPEC-D` `$ref transaction_info_list`); see {@link disputeCaptureId}.
   */
  disputed_transactions: z.array(disputeTransactionInfoSchema).optional(),
  /** The field is `dispute_amount` (`money`). There is no `disputed_amount`. */
  dispute_amount: ppAmountResponseSchema.optional(),
  dispute_currency: z.string().optional(),
  dispute_summary: z.string().optional(),
  dispute_summary_evidence: z.string().optional(),
  accept_claim_type: z.string().optional(),
  adjudication_outcome: z.string().optional(),
  escalation_deadline: z.string().optional(),
  return_eligibility_deadline: z.string().optional(),
  require_evidence: z
    .looseObject({ action: z.string().optional(), due_date: z.string().optional() })
    .optional(),
  items: z.array(z.looseObject({})).optional(),
  offers: z.array(disputeOfferSchema).optional(),
  /**
   * PayPal sends the offer as **`offer`** (singular object, `SPEC-D` `$ref offer`); `offers` is the
   * array shape §8.15/§8.16 and `IDEMPOTENCY.md` describe. Not changed here: M15/M16 read
   * `offers`, and renaming a field other work packages depend on is not this package's call.
   */
  messages: z
    .array(z.looseObject({ content: z.string().optional(), posted_by: z.string().optional() }))
    .optional(),
  /** The field is **`evidences`** (plural, an array) — see {@link disputeEvidenceSchema}. */
  evidences: z.array(disputeEvidenceSchema).optional(),
  eligibility_claims: z.array(z.looseObject({})).optional(),
  allowed_response_options: allowedResponseOptionsSchema.optional(),
  supporting_info: z.array(z.looseObject({})).optional(),
  adjudications: z.array(z.looseObject({})).optional(),
  dispute_outcome: z.looseObject({}).optional(),
  fee_policy: z.looseObject({}).optional(),
  external_reason_code: z.string().optional(),
  refund_details: z.looseObject({}).optional(),
  communication_details: z.looseObject({}).optional(),
  links: z.array(paypalLinkSchema).optional(),
})
export type Dispute = {
  dispute_id: string
  dispute_state?: DisputeState
  /** `reason` on the wire; `DisputeReason` is the value set (report §11). */
  reason?: DisputeReason
  dispute_life_cycle_stage?: DisputeLifeCycleStage
  status?: DisputeStatus
  /** The join key back to our capture — read with {@link disputeCaptureId}. */
  disputed_transactions?: DisputeTransactionInfo[]
  dispute_amount?: PPMoneyResponse
  /** EC-DSP-7: our deadline alert reads this. */
  seller_response_due_date?: string
  adjudication_outcome?: string
  require_evidence?: { action?: string; due_date?: string; [key: string]: unknown }
  /** Evidence already on file, as an array. */
  evidences?: DisputeEvidence[]
  /** §8.16: the strategist proposes accepting or denying an offer from here. */
  offers?: {
    offer_type?: string
    terms?: string
    offer_amount?: PPMoneyResponse
    [key: string]: unknown
  }[]
  /** `posted_by` ∈ `BUYER | SELLER | ARBITER` — there is no `sender` field. */
  messages?: { content?: string; posted_by?: string; [key: string]: unknown }[]
  allowed_response_options?: {
    acknowledge_return_item?: { acknowledgement_types?: string[]; [key: string]: unknown }
    accept_claim?: { accept_claim_types?: string[]; [key: string]: unknown }
    make_offer?: { offer_types?: string[]; [key: string]: unknown }
    [key: string]: unknown
  }
  links?: PaypalLink[]
  [key: string]: unknown
}

/**
 * The capture a dispute is against: `disputed_transactions[].seller_transaction_id`.
 *
 * This is the mapping the Defender depends on (spec §8.15/§8.16) and the reason it is a function
 * rather than a field: PayPal puts the ids in an **array** (`transaction_info_list`), and a dispute
 * can carry more than one entry when it spans several transactions. The first `seller_transaction_id`
 * wins; a dispute against a multi-transaction order needs the whole array, which is why
 * {@link Dispute.disputed_transactions} stays on the type.
 *
 * @returns PayPal's capture id, or `undefined` when the response carried none.
 */
export function disputeCaptureId(dispute: Dispute): string | undefined {
  for (const t of dispute.disputed_transactions ?? []) {
    if (typeof t.seller_transaction_id === 'string' && t.seller_transaction_id !== '') {
      return t.seller_transaction_id
    }
  }
  return undefined
}

/**
 * Whether a dispute may be appealed.
 *
 * **The `appeal` HATEOAS link is the gate, not `dispute_state === 'APPEALABLE'`** (report §9/#17).
 * All three sources say so, in PayPal's own words:
 *
 *  - `SPEC-D`, the `appeal` operation description: *"If this link does not appear, you cannot appeal
 *    the dispute."*
 *  - "Use Disputes API", "Appeal dispute": *"check whether the HATEOAS link for appeal is present."*
 *  - "Test go live": *"Check if the appeal action is available in the HATEOAS links."*
 *
 * `APPEALABLE` is a real `dispute_state` value and is presumably the coarse state the link
 * corresponds to, but **no source says the link is derived from it** — so gating on the state is a
 * guess, and a state-only gate would both offer an appeal PayPal refuses and miss one it allows.
 */
export function isAppealable(dispute: Pick<Dispute, 'links' | 'dispute_state'>): boolean {
  return (dispute.links ?? []).some((l) => l.rel === 'appeal')
}

/**
 * `GET /v1/customer/disputes` response envelope.
 *
 * `items` is defaulted to `[]` on the way out: the reconciler iterates it every two minutes
 * (spec §8.12) and an absent key should mean "none", not a crash in a cron.
 *
 * The response is `dispute_search` = `{items, links}` (`SPEC-D`, report §10). **There are no
 * `total_pages` and no `total_items`** — those were never PayPal fields and would always be absent;
 * they are removed so nobody builds a pager on them. Forward paging is by the `next` HATEOAS link
 * (see {@link ListDisputesQuery.next_page_token}).
 */
export type DisputeList = {
  items: Dispute[]
  links?: PaypalLink[]
  [key: string]: unknown
}

export const disputeListSchema = z
  .looseObject({
    items: z.array(disputeSchema).optional(),
    links: z.array(paypalLinkSchema).optional(),
  })
  .transform((v): DisputeList => ({ ...v, items: v.items ?? [] }))

/**
 * `GET /v1/customer/disputes` query — the seven parameters PayPal actually declares (`SPEC-D`
 * `paths./v1/customer/disputes.get.parameters`, report §10).
 *
 *  - **`page` is gone.** It is not a PayPal parameter; sending it was ignored.
 *  - `page_size` is capped at **50**, not 500. `SPEC-D` says `min 1, max 50`, so anything from 51 to
 *    500 is a likely 400.
 *  - `start_time` and `next_page_token` are **`deprecated: true`**. They are still accepted (spec
 *    §8.12's reconciler passes `start_time`, and we would rather send a deprecated parameter than
 *    silently change a query a cron depends on), but the documented forward-paging mechanism is the
 *    `next` HATEOAS link on the response, which carries the token.
 *  - `start_time` is mutually exclusive with `disputed_transaction_id`.
 */
export const listDisputesQuerySchema = z.looseObject({
  /** @deprecated `deprecated: true` in `SPEC-D`. RFC 3339, within the last 180 days. */
  start_time: z.string().optional(),
  /** Current. 1–255, `^[0-9A-Z_]+$`. Mutually exclusive with `start_time`. */
  disputed_transaction_id: z.string().min(1).max(255).optional(),
  dispute_state: z.string().optional(),
  /** Current. Integer, min 1, **max 50** (PayPal's limit), default 10. */
  page_size: z.number().int().positive().max(50).optional(),
  /** @deprecated `deprecated: true` in `SPEC-D`. The token also arrives on the response's links. */
  next_page_token: z.string().optional(),
  /** Current. RFC 3339, within 180 days, default now. */
  update_time_before: z.string().optional(),
  /** Current. RFC 3339, within 180 days, default `now − 180d`. */
  update_time_after: z.string().optional(),
})
export type ListDisputesQuery = {
  /** @deprecated See {@link listDisputesQuerySchema}. */
  start_time?: string
  disputed_transaction_id?: string
  dispute_state?: string
  page_size?: number
  /** @deprecated See {@link listDisputesQuerySchema}. */
  next_page_token?: string
  update_time_before?: string
  update_time_after?: string
  [key: string]: unknown
}

/**
 * At most 100 evidence items per `provide-evidence` / `appeal` call (`SPEC-D` `evidence_list`
 * `maxItems: 100`, report §2/#4). Enforced locally so an oversized batch is `CS_VALIDATION` before
 * the bytes move.
 */
export const MAX_EVIDENCE_ITEMS = 100

/**
 * The `input` part of a `provide-evidence` / `appeal` multipart upload [V3],
 * https://developer.paypal.com/api/customer-disputes/v1/disputes-provide-evidence.
 *
 * **The payload is `{evidences: [ … ]}` — an array wrapped in `evidences`** (`SPEC-D`
 * `components.requestBodies.evidences`, corroborated by the guide's cURL, report §2/#3). The bare
 * `{evidence_type, date, notes[]}` object this schema used to model would have been rejected.
 *
 * Per-evidence fields: `evidence_type`, `evidence_info` (`{tracking_info[{carrier_name,
 * tracking_number}], refund_ids}`), `notes`, `documents`.
 *
 * **`notes` is a `string` of 1–2000 characters, not `string[]`** (`SPEC-D`
 * `evidence.properties.notes = {type: string, minLength: 1, maxLength: 2000}`).
 *
 * At most **100** items: `SPEC-D` `evidence_list` caps the array at 100, so an oversized batch is
 * refused locally rather than after a 50 MB upload.
 */
export const provideEvidenceInputSchema = z.looseObject({
  evidences: z
    .array(
      z.looseObject({
        evidence_type: z.string().min(1),
        evidence_info: z
          .looseObject({
            tracking_info: z
              .array(
                z.looseObject({
                  carrier_name: z.string().optional(),
                  tracking_number: z.string().optional(),
                }),
              )
              .optional(),
            refund_ids: z.array(z.string()).optional(),
          })
          .optional(),
        notes: z.string().min(1).max(2000).optional(),
        documents: z
          .array(
            z.looseObject({
              name: z.string().optional(),
              size: z.number().optional(),
              type: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1)
    .max(MAX_EVIDENCE_ITEMS),
})
export type ProvideEvidenceInput = {
  evidences: {
    evidence_type: string
    evidence_info?: {
      tracking_info?: { carrier_name?: string; tracking_number?: string }[]
      refund_ids?: string[]
      [key: string]: unknown
    }
    /** A single string of at most 2000 characters — PayPal's `notes` is not an array. */
    notes?: string
    documents?: { name?: string; size?: number; type?: string }[]
    [key: string]: unknown
  }[]
  [key: string]: unknown
}

/**
 * `POST …/accept-claim` body. Multipart per [B16]; the known values are
 * {@link ACCEPT_CLAIM_TYPES}.
 *
 * ASSUMPTION (report §3/#29): `accept_claim_type` is **described in prose but absent from the
 * OpenAPI request body** — `SPEC-D` declares only a multipart part, `accept-claim-document`, while the
 * operation description says the allowed types are "available in dispute details allowed response
 * options object" and the guide's cURL sends `{"note": …}` as JSON. This is the one field in
 * disputes where the machine-readable spec is visibly incomplete. We keep sending it: the operation
 * description and the guide both imply it is accepted, and which refund types are *permitted* for a
 * given dispute comes from `allowed_response_options.accept_claim.accept_claim_types`. **Only a
 * sandbox probe can settle it.**
 */
export const acceptClaimReqSchema = z.looseObject({
  accept_claim_type: z.string().min(1),
  note: z.string().min(1).max(2000).optional(),
})
export type AcceptClaimReq = {
  accept_claim_type: string
  note?: string
  [key: string]: unknown
}

/**
 * `POST …/make-offer` body [V3]. `REFUND_WITH_RETURN` is what spec EC-BUY-1 recommends.
 *
 * Per `SPEC-D` `components.schemas.make_offer` (report §4/#10):
 *
 *  - `note` is **required**, 1–2000 characters.
 *  - `offer_type` is required and is one of {@link OFFER_TYPES}.
 *  - `offer_amount` is **optional** — omit it for `REPLACEMENT_WITHOUT_REFUND`.
 *  - `return_shipping_address` (`address_portable`) is optional but *required by PayPal* when
 *    `offer_type` is `REFUND_WITH_RETURN`; `invoice_id` (1–127) is optional.
 *
 * JSON is fine: `SPEC-D` declares `application/json`, `multipart/form-data`, `multipart/related` and
 * `multipart/mixed` against the same schema.
 */
export const makeOfferReqSchema = z.looseObject({
  note: z.string().min(1).max(2000),
  offer_type: z.string().min(1),
  offer_amount: ppAmountSchema.optional(),
  return_shipping_address: z.looseObject({}).optional(),
  invoice_id: z.string().min(1).max(127).optional(),
  terms: z.string().optional(),
  expiration_time: z.string().optional(),
  buyer_response_due_date: z.string().optional(),
})
export type MakeOfferReq = {
  /** Required by PayPal: the note the buyer reads with the offer (1–2000 chars). */
  note: string
  /** One of {@link OFFER_TYPES}: `REFUND`, `REFUND_WITH_RETURN`, `REFUND_WITH_REPLACEMENT`,
   *  `REPLACEMENT_WITHOUT_REFUND`. `REFUND_NO_RETURN` is not a PayPal value. */
  offer_type: string
  /** Omitted for `REPLACEMENT_WITHOUT_REFUND`; required by PayPal for `REFUND_WITH_RETURN`. */
  offer_amount?: PPMoney
  /** Required by PayPal when `offer_type` is `REFUND_WITH_RETURN`. */
  return_shipping_address?: Record<string, unknown>
  invoice_id?: string
  terms?: string
  expiration_time?: string
  [key: string]: unknown
}

/**
 * `POST …/acknowledge-return-item` body [V3] (report §6/#11).
 *
 * **`{note, acknowledgement_type}`** — there is no `return_shipping_address` on this endpoint; that
 * field belongs to `make-offer`. `acknowledgement_type` is one of {@link ACKNOWLEDGEMENT_TYPES}.
 */
export const ackReturnReqSchema = z.looseObject({
  note: z.string().min(1).max(2000).optional(),
  acknowledgement_type: z.string().min(1),
})
export type AckReturnReq = {
  note?: string
  /** `ITEM_RECEIVED`, `ITEM_NOT_RECEIVED`, `DAMAGED`, `EMPTY_PACKAGE_OR_DIFFERENT`, `MISSING_ITEMS`. */
  acknowledgement_type: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Sandbox-only simulators (§10.2 #18, §10.3, [S29] [V3])
// https://developer.paypal.com/disputes/test-go-live
// ---------------------------------------------------------------------------

/**
 * `POST /v1/customer/disputes` (buyer-side simulator) — the `input` part, [S29].
 *
 * **Not in `SPEC-D` at all**: `SPEC-D` declares only `GET` on `/v1/customer/disputes`, and its
 * `info.description` says the create/cancel/compute-metrics/change-reason/validate-eligibility methods
 * are "available as a limited-release solution… reach out to your PayPal account manager". The only
 * source is the "Test go live" page, which flags it sandbox-only (report §1/#1).
 *
 * Four things the previous shape got wrong, each of which would have failed live in a judge's demo:
 *
 *  1. **Encoding: `multipart/form-data`, not JSON**, with one JSON part named `input`.
 *  2. **The transaction field is `buyer_transaction_id`, nested in `disputed_transactions[]`.**
 *     There is no `transaction_id`.
 *  3. **The reason field is `reason`, not `dispute_reason`.** Its *values* are the
 *     {@link DISPUTE_REASONS} enum.
 *  4. `dispute_amount` and `extensions` are documented request fields.
 *
 * Returns `201 Created` with a HATEOAS link for the new dispute, which is why `createBuyerDispute`
 * returns `Links`.
 */
export const simDisputeReqSchema = z.looseObject({
  disputed_transactions: z
    .array(
      z.looseObject({
        /** The buyer-side transaction id — PayPal's `BUYER-TRANSACTION-ID` for the capture. */
        buyer_transaction_id: z.string().min(1),
      }),
    )
    .min(1),
  /** One of {@link DISPUTE_REASONS}. */
  reason: z.string().min(1),
  dispute_amount: ppAmountSchema.optional(),
  extensions: z
    .looseObject({
      merchant_contacted: z.boolean().optional(),
      merchant_contacted_outcome: z.string().optional(),
      merchandise_dispute_properties: z
        .looseObject({ issue_type: z.string().optional() })
        .optional(),
    })
    .optional(),
})
export type SimDisputeReq = {
  /** The capture the buyer is disputing, as PayPal identifies it from the buyer's side. */
  disputed_transactions: { buyer_transaction_id: string; [key: string]: unknown }[]
  /** One of {@link DISPUTE_REASONS}. */
  reason: string
  dispute_amount?: PPMoney
  extensions?: {
    merchant_contacted?: boolean
    merchant_contacted_outcome?: string
    merchandise_dispute_properties?: { issue_type?: string; [key: string]: unknown }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * `POST /v2/customer-support/process-chargeback` request body, [S29].
 *
 * The previous `{transaction_id, reason}` shared **no field name** with PayPal's real contract
 * (report §27/#2). The documented body for a PayPal-funded transaction is:
 *
 * ```json
 * {
 *   "adjacency": "PAYPAL",
 *   "file_layout": "ATCK_CB",
 *   "merchant_id": "99038409233245",
 *   "financial_institution": { "processor": "FDMS" },
 *   "transaction": { "id_enc": "SELLER-TRANSACTION-ID", "amount": { "currency_code": "USD", "value": "20" } },
 *   "instrument": { "instrument_type": "CARD", "card_brand": "VISA", "credit_card_transaction_id": "…", "external": false },
 *   "dispute": { "stage": "CHARGEBACK", "status": "2", "amount": {…}, "receive_date": "…", "event_code": "CHARGEBACK_INITIATED", … }
 * }
 * ```
 *
 * `adjacency`, `file_layout`, `financial_institution.processor` and `instrument.instrument_type` are
 * `literal`s because PayPal documents exactly those values for this flow; `instrument_type`'s full
 * vocabulary is `CARD | BANK | CREDIT` and this endpoint is **card-funded only** (§10.1 step 5 —
 * "for a transaction to be eligible for chargeback, ensure you use a credit card to send money").
 *
 * The `dispute` sub-fields are the documented `receive_date` / `money_movement_date` /
 * `response_date` plus the ones the page's sample carries. **No `Clock` is injected here**, so the
 * caller owns every timestamp: nothing in this package invents a time (spec §8.0 rule 10).
 */
export const processChargebackReqSchema = z.looseObject({
  adjacency: z.literal('PAYPAL'),
  file_layout: z.literal('ATCK_CB'),
  merchant_id: z.string().min(1),
  financial_institution: z.looseObject({ processor: z.literal('FDMS') }),
  transaction: z.looseObject({
    /** PayPal's SELLER-TRANSACTION-ID — the capture id as the business account sees it. */
    id_enc: z.string().min(1),
    amount: ppAmountSchema,
  }),
  instrument: z.looseObject({
    instrument_type: z.enum(['CARD', 'BANK', 'CREDIT']),
    card_brand: z.string().optional(),
    credit_card_transaction_id: z.string().optional(),
    external: z.boolean().optional(),
  }),
  dispute: z.looseObject({
    id: z.string().nullable().optional(),
    stage: z.string().optional(),
    status: z.string().optional(),
    amount: ppAmountResponseSchema.optional(),
    receive_date: z.string().optional(),
    money_movement_date: z.string().optional(),
    response_date: z.string().optional(),
    event_code: z.string().optional(),
    event_type: z.string().optional(),
    chargeback_type: z.string().optional(),
    processor_info: z
      .looseObject({
        reference_number: z.string().optional(),
        reason_code: z.string().optional(),
        notes: z.string().optional(),
      })
      .optional(),
  }),
})
export type ProcessChargebackReq = {
  merchant_id: string
  transaction: { id_enc: string; amount: PPMoney; [key: string]: unknown }
  instrument: { instrument_type: 'CARD' | 'BANK' | 'CREDIT'; [key: string]: unknown }
  dispute: { [key: string]: unknown }
  [key: string]: unknown
}

/**
 * `POST /v2/customer-support/process-chargeback` response — `201 Created` **with a body**
 * (report §27/#2); the old `schema: null` (expect an empty body) would have thrown the body away.
 *
 * ASSUMPTION: the page says only "201 Created with a dispute ID" and publishes no response schema
 * (there is no OpenAPI at all for this endpoint — report §33 note, `TGL` is the sole source). Both id
 * spellings are accepted so a sandbox probe tells us which one is real; the client logs a
 * `paypal-debug-id` either way.
 */
export const processChargebackResSchema = z.looseObject({
  dispute_id: z.string().optional(),
  id: z.string().optional(),
  status: z.string().optional(),
  links: z.array(paypalLinkSchema).optional(),
})
export type ProcessChargebackRes = {
  /** PayPal's id for the chargeback it just created. */
  dispute_id?: string
  id?: string
  status?: string
  links?: PaypalLink[]
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

/**
 * `POST /v1/customer/disputes/{id}/change-reason` body [S29] (report §30/#13/#28).
 *
 * The documented encoding is **`multipart/related` with a single `input` JSON part** containing
 * `reason`, `note` and `item_info[]`. `reason` was right; `note` and `item_info` were missing.
 *
 * ASSUMPTION: this endpoint is **not in `SPEC-D`** — "Test go live" is the only source, and it is
 * sandbox-only. The field names rest on that page alone.
 */
export const changeReasonReqSchema = z.looseObject({
  reason: z.string().min(1),
  note: z.string().min(1).max(2000).optional(),
  item_info: z
    .array(
      z.looseObject({
        item_name: z.string().optional(),
        item_quantity: z.string().optional(),
        reason: z.string().optional(),
        item_type: z.string().optional(),
        product_details: z
          .looseObject({ sub_reason: z.string().optional(), category: z.string().optional() })
          .optional(),
        expected_refund: ppAmountSchema.optional(),
      }),
    )
    .optional(),
})
export type ChangeReasonReq = {
  /** One of {@link DISPUTE_REASONS}. */
  reason: string
  note?: string
  item_info?: {
    item_name?: string
    item_quantity?: string
    reason?: string
    item_type?: string
    product_details?: { sub_reason?: string; category?: string; [key: string]: unknown }
    expected_refund?: PPMoney
    [key: string]: unknown
  }[]
  [key: string]: unknown
}

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
 *
 * Verified against https://developer.paypal.com/api/rest/webhooks/event-names (91 names, report
 * §26). Two corrections:
 *
 *  - **`PAYMENT.REFUND.COMPLETED` is REMOVED — no such event exists.** The full capture/refund set is
 *    `PAYMENT.CAPTURE.{COMPLETED, PENDING, DECLINED, DENIED, REFUNDED, REVERSED}` and
 *    `PAYMENT.REFUND.{PENDING, FAILED}`. Refund completion is signalled by **`PAYMENT.CAPTURE.REFUNDED`**.
 *    A subscription asking for `PAYMENT.REFUND.COMPLETED` gets a refund notification that never
 *    fires.
 *  - **`PAYMENT.CAPTURE.DENIED` is ADDED.** It is a real, distinct event from
 *    `PAYMENT.CAPTURE.DECLINED`, and PayPal *recommends* subscribing to it for the checkout flow
 *    (https://developer.paypal.com/payment-methods/webhooks lists it among the five to listen for,
 *    with "Listen for this webhook and then cancel fulfilling the order").
 *
 * **There is no `PAYMENT.AUTHORIZATION.EXPIRED` event at all** (report §26). So authorization-expiry
 * alerting **cannot be webhook-driven**: spec EC-TIME-5's 29-day expiry clock has to be computed by
 * polling `GET /v2/payments/authorizations/{id}` and comparing `expiration_time`. See
 * `client.getAuthorization`. Also documented but not subscribed here: `RISK.DISPUTE.CREATED` (a
 * pre-dispute signal the Defender could use for lead time), `CHECKOUT.ORDER.COMPLETED`,
 * `CHECKOUT.ORDER.PROCESSED`.
 */
export const WEBHOOK_EVENT_NAMES = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.REFUND.PENDING',
  'PAYMENT.REFUND.FAILED',
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

/**
 * Known `status` values across the three payment resources — **the union, deliberately** (report
 * §16/#26).
 *
 * The previous comment here framed this list as "capture/authorization/refund statuses" while it was
 * neither: it was missing `PARTIALLY_CAPTURED` and `DENIED`, which are real `authorization_status`
 * values, and it contained capture-only values such as `PARTIALLY_REFUNDED`. The per-resource sets
 * below are the accurate lists; this union exists because callers branch on a `status` string that
 * arrived from whichever resource they called, and pretending they share one enum is the bug.
 */
export const PAYMENT_STATUSES = [
  // authorization_status
  'CREATED',
  'CAPTURED',
  'DENIED',
  'PARTIALLY_CAPTURED',
  'VOIDED',
  'PENDING',
  // capture/refund
  'COMPLETED',
  'DECLINED',
  'FAILED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'REVERSED',
  'SAVED',
  'APPROVED',
  // Kept although the report only names `PARTIALLY_CAPTURED` and `DENIED` as missing: it is a
  // status PayPal has used, and dropping a value nobody asked to drop is its own kind of drift.
  'EXPIRED',
] as const

/** `SPEC-P` `authorization_status` — `CREATED`, `CAPTURED`, `DENIED`, `PARTIALLY_CAPTURED`,
 *  `VOIDED`, `PENDING` (report §16). */
export const AUTHORIZATION_STATUSES = [
  'CREATED',
  'CAPTURED',
  'DENIED',
  'PARTIALLY_CAPTURED',
  'VOIDED',
  'PENDING',
] as const

/** Capture statuses we act on. `COMPLETED` / `PARTIALLY_REFUNDED` / `REFUNDED` are the money-moving
 *  ones; `REVERSED` / `DECLINED` / `FAILED` are terminal. */
export const CAPTURE_STATUSES = [
  'COMPLETED',
  'PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'REVERSED',
  'DECLINED',
  'DENIED',
  'FAILED',
] as const

/** Refund statuses. Completion is `COMPLETED`; there is **no** `PAYMENT.REFUND.COMPLETED` webhook. */
export const REFUND_STATUSES = ['COMPLETED', 'PENDING', 'FAILED'] as const

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
