/**
 * Hand-written zod schemas for every pydantic model in `apps/vi/src/vi_service/models.py`.
 *
 * Spec **§8.4 (M4)**, work package **WP-04**, acceptance test AT-M4.2. §8.4 says these are
 * "generated **by hand** to mirror the pydantic models", so every schema below was read off the
 * Python file rather than generated from it, and the mirroring is checked by `schema-drift.ts`
 * against the service's own `/openapi.json`.
 *
 * ## Four mirroring rules, because getting them wrong fails silently
 *
 *  1. **`extra` follows `ConfigDict`.** This is the rule most likely to be got wrong, and the
 *     asymmetry is deliberate:
 *     - `StrictModel` is `extra="forbid"` → `z.strictObject`. Used for every **request** model.
 *       A lenient request schema would be worse than useless: vi would reject the typo'd key anyway,
 *       so dropping it here just moves the error one hop later and makes it worse.
 *     - A pydantic model with **no** `model_config` has `extra="ignore"`, and every response model in
 *       `models.py` except `EvidenceBundle` is one → `z.object`, which strips unknown keys the same
 *       way. A strict response schema would break the Gate the moment vi adds a field, and vi is a
 *       separate deployable, so "the moment" is whenever someone touches it.
 *     - `extra="allow"` (`PublicJwk`, `MerchantRef`, `AcceptableItem`, `EvidenceBundle`) →
 *       `z.looseObject`.
 *  2. **Optional ≠ nullable.** pydantic `x: str | None = None` renders as `anyOf[..., null]` **and**
 *     omits `x` from `required`. Both halves are mirrored, because they are different facts: a
 *     nullable field may be present-and-null, an optional one may be absent.
 *  3. **Defaults are reproduced.** A field with a pydantic default is `.default(...)` here, so a
 *     caller who omits it and a caller who sends it explicitly produce the same request.
 *  4. **`strict=True` means strict.** vi's money and quantity integers use
 *     `Field(strict=True)`: `13000.0` and `"13000"` are *errors* there, not coercions
 *     (EC-FX-5, EC-FX-6). {@link minorUnitsSchema} refuses both before serialisation.
 *
 * ## `skipped` is a first-class field, not a leftover
 *
 * `VerifyResponse.constraints.{checked,skipped}` exists because the pinned Verifiable Intent library
 * appends `mandate.payment.budget`, `mandate.payment.recurrence` and
 * `mandate.payment.agent_recurrence` to `checked` while evaluating **none** of them — its own source
 * calls them "network-enforced". vi moves them into `skipped` (spec §8.8, [B3]) so that **Countersign's
 * Gate** can see what it still owes. Spec decision **D19** makes the Gate, not the library, the
 * enforcer of those three. Reading `constraints.satisfied` alone would tell the Gate that a budget
 * cap was honoured when nobody checked it, which is the exact failure D19 exists to prevent.
 * {@link NETWORK_ENFORCED_CONSTRAINTS} and `verifyResponseSchema.skipped` are the two halves of that
 * contract; `test/verify-response.test.ts` pins both.
 */

import { CURRENCIES } from '@countersign/core'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Primitives — mirrors of `models.py`'s primitive aliases
// ---------------------------------------------------------------------------

/**
 * `vi_service.models.Currency` — the seven ISO-4217 codes vi accepts.
 *
 * Re-declared here rather than imported from `core`, because the *service's* vocabulary is the
 * authority for this client (spec §8.0 rule 2 makes core append-only and WP-01-owned). `core`'s
 * `CURRENCIES` happens to be the same list today; `test/types.test.ts` asserts they are, so a future
 * currency added to only one side fails here rather than at 2 a.m. in the Gate.
 *
 * Note vi does **not** lower-case: `'usd'` is a `CS_VALIDATION` error, not a fixable typo.
 */
export const currencySchema = z.enum(CURRENCIES)

/**
 * `MinorAmount(label, description)` — integer minor units, `strict=True`, `ge=0`.
 *
 * What this refuses, each of which is a real defect rather than an inconvenience:
 *
 *  - **a non-integral number** (`13000.5`). A value that is not a whole number of minor units is not an
 *    amount in any currency we support.
 *  - **a numeric string** (`"13000"`, `"130.00"`). vi refuses it too, with a message telling the caller to
 *    send a JSON number. Accepting it here would let a formatted amount through the client and get it
 *    rejected by the service one hop later, with a worse error.
 *  - **an unsafe integer.** Above `Number.MAX_SAFE_INTEGER` the JSON number has already lost precision
 *    before zod ever sees it, so refusing is the only honest answer.
 *  - **a negative amount.**
 *
 * ### What it *cannot* refuse, and why that is fine
 *
 * `13000.0` is rejected by vi, whose `_minor_before` sees a Python `float`. This schema cannot reject it:
 * `JSON.parse("13000.0")` produces the double `13000`, which is bit-for-bit the same value as
 * `JSON.parse("13000")`, so by the time a request reaches TypeScript the evidence that a decimal point
 * was written is gone. Enforcing vi's strictness on that specific case is therefore impossible from this
 * side of the wire, and claiming otherwise would be a false assurance.
 *
 * The property that actually matters is preserved: **the value that reaches vi is an exact integer**, so
 * nothing is rounded and no amount is corrupted. EC-FX-6's "no float ever touches money" holds; what a
 * TS client cannot do is tell you which producer wrote `13000.0`.
 *
 * Output is `bigint`, not `number`, because that is what `core`'s `Money` uses and it makes a later
 * `amount / 100` a compile error. `jsonSafeBody` in `client.ts` is the single place that converts it
 * back to a JSON integer for the wire.
 */
/**
 * The number branch, declared as a JSON Schema `integer` without validating integrality itself.
 *
 * `.int()` would emit the same `"type": "integer"`, but it rejects a non-integral number *before* the
 * transform below runs, which replaces this schema's actionable message with zod's generic
 * `Invalid input` / `invalid_union`. `.meta()` only annotates the emitted JSON Schema, so the drift check
 * still sees `integer` (matching pydantic's `Field(strict=True)` on an `int`) while the runtime error
 * stays the one that tells a human what to send.
 */
const minorUnitsNumberSchema = z.number().meta({ type: 'integer' })

export const minorUnitsSchema = z
  .union([minorUnitsNumberSchema, z.bigint()])
  .transform((v, ctx) => {
    if (typeof v === 'bigint') {
      if (v < 0n) {
        ctx.addIssue({ code: 'custom', message: 'Money must be non-negative' })
        return z.NEVER
      }
      return v
    }
    if (!Number.isInteger(v)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Money must be integer minor units. Received a non-integer number — money is never a float ' +
          'in this system (spec §0, EC-FX-6). Send 13000 for $130.00.',
      })
      return z.NEVER
    }
    if (!Number.isSafeInteger(v)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Amount exceeds Number.MAX_SAFE_INTEGER, so the JSON number has already lost precision',
      })
      return z.NEVER
    }
    if (v < 0) {
      ctx.addIssue({ code: 'custom', message: 'Money must be non-negative' })
      return z.NEVER
    }
    return BigInt(v)
  })

/** `NonEmptyStr(description, max_length=N)`: a bounded, non-empty string. */
function boundedString(maxLength: number): z.ZodString {
  return z.string().min(1).max(maxLength)
}

/**
 * `B64Url(description)` — `^[A-Za-z0-9_-]+={0,2}$`, i.e. base64url with *tolerated* padding.
 *
 * This is the encoding `vi_service.keys.b64u_encode` produces (unpadded) and `b64u_decode` accepts.
 */
export const b64urlSchema = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Expected base64url')

/**
 * `dict[str, Any]` as pydantic renders it: an object with no declared properties.
 *
 * Used for the fields vi deliberately leaves untyped (`public_jwk`, `L2PrepareResponse.header` /
 * `.payload`, each JWKS entry). `z.record(z.string(), z.unknown())` is the honest mirror — widening
 * it to a typed object would be a guess about a shape this client does not own.
 */
export const jsonObjectSchema = z.record(z.string(), z.unknown())

/** Decode unpadded-or-padded base64url to a UTF-8 string, mirroring `keys.b64u_decode`. */
export function b64urlToUtf8(value: string): string {
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let body = value
  while (body.endsWith('=')) body = body.slice(0, -1)
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of body) {
    const v = B64URL.indexOf(ch)
    if (v < 0) throw new Error(`not base64url: ${JSON.stringify(ch)}`)
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  const out = new Uint8Array(bytes)
  return new TextDecoder('utf-8', { fatal: true }).decode(out)
}

/** Decoded byte length of a base64url string, for the P-256 coordinate check. Mirrors `b64u_decode`. */
export function b64urlByteLength(value: string): number {
  let body = value
  while (body.endsWith('=')) body = body.slice(0, -1)
  return Math.floor((body.length * 6) / 8)
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * `MoneyAmount` — integer minor units plus an ISO-4217 code, and **nothing else**.
 *
 * Defined in `models.py` but referenced by no route today: every amount that travels does so either
 * as a bare sibling integer (`shipping_minor` next to `currency`) or through a route-specific
 * `MinorAmount`. It is mirrored anyway so the client has one answer for "how is money shaped", and
 * `schema-drift.ts` reports it as unreachable-from-any-route rather than silently ignoring it.
 */
export const moneyAmountSchema = z.strictObject({
  minor: minorUnitsSchema,
  currency: currencySchema,
})
export type MoneyAmount = z.infer<typeof moneyAmountSchema>

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/**
 * `PublicJwk` — a P-256 public JWK. `extra="allow"`, so `looseObject`.
 *
 * Two pydantic validators are mirrored as zod refinements, both for the same reason: this is the
 * browser's **non-extractable** device key (spec §3.1), and a `d` member here would mean a private
 * key had been serialised into a request body, into a log line, and possibly into a heap dump.
 * Refusing it at the client is the last line of defence after the browser refused to export it.
 */
export const publicJwkSchema = z
  .looseObject({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: boundedString(64),
    y: boundedString(64),
  })
  .superRefine((jwk, ctx) => {
    if ('d' in jwk) {
      ctx.addIssue({
        code: 'custom',
        path: ['d'],
        message:
          "device_public_jwk must be a PUBLIC key; remove the private 'd' member. The browser's device " +
          'key is non-extractable (spec §3.1) and vi-service must never see the private half.',
      })
    }
    // `PublicJwk._coord_length`: a P-256 coordinate is exactly 32 bytes. A short or long string that
    // still matches the charset would otherwise be rejected later by the library, with a worse message.
    for (const member of ['x', 'y'] as const) {
      const raw = jwk[member]
      if (b64urlByteLength(raw) !== 32) {
        ctx.addIssue({
          code: 'custom',
          path: [member],
          message: `P-256 coordinates are 32 bytes, ${JSON.stringify(raw)} decodes to ${b64urlByteLength(raw)}`,
        })
      }
    }
  })
export type PublicJwk = z.infer<typeof publicJwkSchema>

// ---------------------------------------------------------------------------
// The eight constraint types (spec §8.8, [B3])
// ---------------------------------------------------------------------------

/** `MerchantRef` — `extra="allow"`, and the inner shapes come from the library's own example flow. */
export const merchantRefSchema = z.looseObject({
  id: boundedString(128),
  name: boundedString(256),
  website: boundedString(2048),
})
export type MerchantRef = z.infer<typeof merchantRefSchema>

/** `AcceptableItem` — `extra="allow"`. The library rejects an entry without a `title`. */
export const acceptableItemSchema = z.looseObject({
  id: boundedString(128),
  title: boundedString(512),
})
export type AcceptableItem = z.infer<typeof acceptableItemSchema>

/** `LineItemRequirement` — `extra="forbid"` (inherits `_ConstraintBase` → `StrictModel`). */
export const lineItemRequirementSchema = z.strictObject({
  id: boundedString(128),
  acceptable_items: z.array(acceptableItemSchema).min(1),
  quantity: z.number().int().positive(),
})

export const allowedMerchantsConstraintSchema = z.strictObject({
  type: z.literal('mandate.checkout.allowed_merchants'),
  allowed: z.array(merchantRefSchema).min(1),
})

export const lineItemsConstraintSchema = z.strictObject({
  type: z.literal('mandate.checkout.line_items'),
  items: z.array(lineItemRequirementSchema).min(1),
  match_mode: z.enum(['minimum', 'exact']).default('minimum'),
})

export const allowedPayeesConstraintSchema = z.strictObject({
  type: z.literal('mandate.payment.allowed_payees'),
  allowed: z.array(merchantRefSchema).min(1),
})

export const amountRangeConstraintSchema = z
  .strictObject({
    type: z.literal('mandate.payment.amount_range'),
    currency: currencySchema,
    min: minorUnitsSchema.nullable().default(null),
    max: minorUnitsSchema.nullable().default(null),
  })
  .refine((c) => c.min === null || c.max === null || c.min <= c.max, {
    path: ['min'],
    message: 'amount_range min must not exceed max',
  })

/**
 * `BudgetConstraint` — **not evaluated by the library**. The Gate enforces it (spec D19), and
 * {@link verifyResponseSchema}'s `constraints.skipped` is how the Gate learns the obligation exists.
 */
export const budgetConstraintSchema = z.strictObject({
  type: z.literal('mandate.payment.budget'),
  currency: currencySchema,
  max: z.number().int().positive(),
  min: z.number().int().positive().nullable().default(null),
})

/** `RecurrenceConstraint` — also Gate-enforced (spec D19). */
export const recurrenceConstraintSchema = z.strictObject({
  type: z.literal('mandate.payment.recurrence'),
  frequency: z.enum([
    'INDA',
    'DAIL',
    'WEEK',
    'TWOK',
    'TWMN',
    'MNTH',
    'TOMN',
    'QUTR',
    'FOMN',
    'SEMI',
    'YEAR',
    'TYEA',
  ]),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO 8601 date, YYYY-MM-DD'),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  number: z.number().int().positive().nullable().default(null),
})

/** `AgentRecurrenceConstraintModel` — `end_date` is REQUIRED by the library, so it is required here. */
export const agentRecurrenceConstraintSchema = z.strictObject({
  type: z.literal('mandate.payment.agent_recurrence'),
  frequency: z.enum([
    'INDA',
    'DAIL',
    'WEEK',
    'TWOK',
    'TWMN',
    'MNTH',
    'TOMN',
    'QUTR',
    'FOMN',
    'SEMI',
    'YEAR',
    'TYEA',
  ]),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  max_occurrences: z.number().int().positive().nullable().default(null),
})

/**
 * `ReferenceConstraintModel` — **always refused**.
 *
 * The library *injects* this constraint itself in `create_layer2_autonomous`, computing
 * `conditional_transaction_id` from the checkout disclosure hash, which only exists at signing time.
 * A caller cannot supply a correct one, so accepting it would mean either dropping it silently or
 * overwriting it with a lie. `models.py` raises `ValueError` in a model validator for every instance;
 * the faithful zod mirror is a schema no value can satisfy.
 */
export const referenceConstraintSchema = z
  .strictObject({
    type: z.literal('mandate.payment.reference'),
  })
  .refine(() => false, {
    message:
      'mandate.payment.reference is generated by the signing service from the checkout disclosure hash ' +
      'and must not be supplied by the caller',
  })

/**
 * `Constraint` — the tagged union of all eight registered types (spec §8.8: "exactly the 8
 * registered types"). `checkout_constraints` / `payment_constraints` on `L2PrepareRequest` are typed
 * with these so this client refuses a malformed constraint **before** the round trip rather than
 * letting vi reject it with a `VI_CONSTRAINT_VIOLATION` 422.
 *
 * vi's own OpenAPI declares these fields as bare `object`s, so the drift check reports them as
 * *opaque* (unverifiable) rather than claiming a match it cannot make.
 */
export const constraintSchema = z.discriminatedUnion('type', [
  allowedMerchantsConstraintSchema,
  lineItemsConstraintSchema,
  allowedPayeesConstraintSchema,
  amountRangeConstraintSchema,
  budgetConstraintSchema,
  recurrenceConstraintSchema,
  agentRecurrenceConstraintSchema,
  referenceConstraintSchema,
])
export type Constraint = z.infer<typeof constraintSchema>

/** `CheckoutConstraint = AllowedMerchantsConstraint | LineItemsConstraint`. */
export const checkoutConstraintSchema = z.discriminatedUnion('type', [
  allowedMerchantsConstraintSchema,
  lineItemsConstraintSchema,
])
export type CheckoutConstraint = z.infer<typeof checkoutConstraintSchema>

/** `PaymentConstraint` — the remaining six. */
export const paymentConstraintSchema = z.discriminatedUnion('type', [
  allowedPayeesConstraintSchema,
  amountRangeConstraintSchema,
  budgetConstraintSchema,
  recurrenceConstraintSchema,
  agentRecurrenceConstraintSchema,
  referenceConstraintSchema,
])
export type PaymentConstraint = z.infer<typeof paymentConstraintSchema>

/**
 * The eight registered constraint type tags, in `CONSTRAINT_TYPES` order. Mirrors the tuple so a
 * Gate reason can quote the same list vi quotes in its `VI_CONSTRAINT_VIOLATION` message.
 */
export const CONSTRAINT_TYPES = [
  'mandate.checkout.allowed_merchants',
  'mandate.checkout.line_items',
  'mandate.payment.allowed_payees',
  'mandate.payment.amount_range',
  'mandate.payment.budget',
  'mandate.payment.recurrence',
  'mandate.payment.agent_recurrence',
  'mandate.payment.reference',
] as const
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number]

/**
 * The three constraints the Gate owns (spec **D19**).
 *
 * The library appends these three to `checked` and evaluates none of them. `apps/vi` therefore moves
 * them into `constraints.skipped`, and this set is the client's copy of that rule. It exists as data
 * rather than as a comment so a caller can *use* it: `skipped(nothingIn(NETWORK_ENFORCED_CONSTRAINTS))`
 * is exactly the assertion that a `satisfied: true` verdict did not quietly skip the budget cap.
 */
export const NETWORK_ENFORCED_CONSTRAINTS: ReadonlySet<ConstraintType> = new Set<ConstraintType>([
  'mandate.payment.budget',
  'mandate.payment.recurrence',
  'mandate.payment.agent_recurrence',
])

// ---------------------------------------------------------------------------
// Shared request fragments
// ---------------------------------------------------------------------------

/** `WalletRef` — the PayPal vault identity vi hashes into `card_id` and never echoes back. */
export const walletRefSchema = z.strictObject({
  payer_id: boundedString(128),
  payer_email: boundedString(320),
  payment_token_id: boundedString(256),
})
export type WalletRef = z.infer<typeof walletRefSchema>

/**
 * `PaymentInstrument` — `{type, id, description}`, required on both the open payment mandate and the
 * closed L3a one, and cross-checked between them.
 *
 * `id` must equal the L1's `card_id` (lowercase hex SHA-256 of the PayPal vault payment-token id).
 * `verify_chain` fails closed when they disagree, so a mismatch here is not a warning.
 */
export const paymentInstrumentSchema = z.strictObject({
  type: boundedString(128),
  id: boundedString(256),
  description: boundedString(256),
})
export type PaymentInstrument = z.infer<typeof paymentInstrumentSchema>

// ---------------------------------------------------------------------------
// POST /v1/keys/agent
// ---------------------------------------------------------------------------

export const mintAgentKeyRequestSchema = z.strictObject({ agent_id: boundedString(128) })
export type MintAgentKeyRequest = z.infer<typeof mintAgentKeyRequestSchema>

/** Responses are `z.object`: see the `extra` rule in the module header. */
export const mintAgentKeyResponseSchema = z.object({
  kid: z.string(),
  public_jwk: jsonObjectSchema,
  enc_private_key_b64: boundedString(2048),
})
export type MintAgentKeyResponse = z.infer<typeof mintAgentKeyResponseSchema>

// ---------------------------------------------------------------------------
// POST /v1/keys/rotate
// ---------------------------------------------------------------------------

/** `ROTABLE_ROLES` in `keys.py`: the only two roles a key may be rotated for. */
export const keyRoleSchema = z.enum(['ISSUER', 'MERCHANT'])
export type KeyRole = z.infer<typeof keyRoleSchema>

export const rotateKeyRequestSchema = z.strictObject({ role: keyRoleSchema })
export type RotateKeyRequest = z.infer<typeof rotateKeyRequestSchema>

/**
 * `RotateKeyResponse` — nothing is deleted. The retired public key stays resolvable by `kid` and stays
 * in `/v1/jwks`, so evidence signed before the rotation still verifies (spec EC-KEY-2, EC-KEY-3).
 */
export const rotateKeyResponseSchema = z.object({
  new_kid: z.string(),
  role: z.string(),
  retired_kid: z.string(),
})
export type RotateKeyResponse = z.infer<typeof rotateKeyResponseSchema>

// ---------------------------------------------------------------------------
// GET /v1/jwks
// ---------------------------------------------------------------------------

/**
 * `JwksResponse` — `{keys: list[dict[str, Any]]}`.
 *
 * Each entry carries `kid`, `role`, `status` and the public JWK. The model is deliberately opaque per
 * entry (`dict[str, Any]` in Python), so this client does not pretend to know the key envelope; it
 * hands the entries through and lets the consumer that cares about `status` read it. What this
 * schema *does* guarantee is that `keys` is an array — a JWKS that came back as an object would
 * otherwise reach the verifier.
 *
 * Retired keys are included, each with a `status`. A consumer that filters on `status === 'ACTIVE'`
 * would break evidence verification, so that filtering is the consumer's decision, not the client's.
 */
export const jwksResponseSchema = z.object({ keys: z.array(jsonObjectSchema) })
export type JwksResponse = z.infer<typeof jwksResponseSchema>

// ---------------------------------------------------------------------------
// POST /v1/l1/issue
// ---------------------------------------------------------------------------

export const l1IssueRequestSchema = z.strictObject({
  user_id: boundedString(128),
  wallet: walletRefSchema,
  device_public_jwk: publicJwkSchema,
  device_kid: boundedString(256).default('device-key-1'),
  ttl_days: z.number().int().min(1).max(365).default(365),
  pan_last_four: z
    .string()
    .regex(/^\d{4}$/)
    .default('0000'),
  scheme: boundedString(64).default('PayPal'),
})
export type L1IssueRequest = z.input<typeof l1IssueRequestSchema>

export const l1IssueResponseSchema = z.object({
  l1: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  issuer_kid: z.string(),
  card_id: z.string(),
  device_jkt: z.string(),
})
export type L1IssueResponse = z.infer<typeof l1IssueResponseSchema>

// ---------------------------------------------------------------------------
// POST /v1/l2/prepare  (spec D3, two-phase signing)
// ---------------------------------------------------------------------------

/**
 * `L2PrepareRequest`.
 *
 * `ttl_seconds` is capped at 2 592 000 (30 days) per spec §8.3 and floored at 60 s by the service.
 *
 * **`prompt_summary` is advisory and is not covered by the signature.** `UserMandate` has the field
 * but `create_layer2_autonomous` at the pinned commit never serialises it into the L2 payload, so the
 * UI must not present it as signed content. The schema does not mark it optional-and-empty because
 * vi's own model has a `min_length=1` with a `""` default — an inherited quirk reported in WP-04's
 * findings; callers should pass a non-empty string or omit the field entirely.
 */
export const l2PrepareRequestSchema = z.strictObject({
  l1: boundedString(32768),
  device_kid: boundedString(256),
  agent_public_jwk: publicJwkSchema,
  agent_kid: boundedString(256),
  checkout_constraints: z.array(checkoutConstraintSchema).default([]),
  payment_constraints: z.array(paymentConstraintSchema).default([]),
  merchants: z.array(merchantRefSchema),
  acceptable_items: z.array(acceptableItemSchema).default([]),
  payment_instrument: paymentInstrumentSchema,
  nonce: boundedString(256),
  aud: boundedString(2048),
  ttl_seconds: z.number().int().min(60).max(2_592_000).default(604_800),
  prompt_summary: boundedString(2000).optional(),
  iss: boundedString(2048).nullable().optional(),
  device_id: boundedString(128).nullable().optional(),
  ip_address: z.string().max(64).nullable().optional(),
})
export type L2PrepareRequest = z.input<typeof l2PrepareRequestSchema>

/**
 * `L2PrepareResponse` — the two-phase signing surface (spec D3).
 *
 * ### `signing_input` gets a refine, and it is the most load-bearing one in this file
 *
 * `signing_input` is `header.payload`: **exactly two dot-separated segments, no trailing dot**. It is
 * the ASCII string the browser signs with its non-extractable device key, and `l2/finalize` verifies
 * the signature over exactly these bytes against the L1's `cnf.jwk` key.
 *
 * The failure mode this guards against is specific and nasty: if a client re-serialised or re-encoded
 * this string instead of passing it through, the browser would sign *different bytes*, the signature
 * would verify against the wrong input, and the symptom would be `VI_SIGNATURE_MISMATCH` — which
 * looks exactly like a key mismatch. A human would go looking for the wrong device key for hours.
 * So this schema asserts the shape on the way in, and `client.prepareL2` returns `signing_input`
 * **verbatim**, never re-encoded. `apps/vi` itself takes the same care: `l2.py::_signing_input_of`
 * reads the two segments out of the library's own `issuer_jwt` rather than re-encoding the decoded
 * dicts, "because re-encoding here would risk a key-order or separator difference".
 *
 * The second refinement checks that the decoded segments really are the `header` and `payload` this
 * response also returns. That matters because spec §8.5 requires the UI to render the **service's**
 * `payload` as the consent read-back — if it were not the payload being signed, the user would be
 * consenting to text that is not covered by the signature. The comparison is done on *decoded* values
 * and never rebuilds the string.
 */
export const l2PrepareResponseSchema = z
  .object({
    prepare_id: z.string(),
    signing_input: boundedString(2048),
    header: jsonObjectSchema,
    payload: jsonObjectSchema,
    expires_at: z.number().int(),
    prepare_ttl_seconds: z.number().int(),
  })
  .superRefine((res, ctx) => {
    const parts = res.signing_input.split('.')
    if (parts.length !== 2 || parts.some((p) => p.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['signing_input'],
        message:
          'signing_input must be exactly "header.payload": two non-empty base64url segments and no ' +
          'trailing dot. This string is the ASCII the browser signs; re-encoding it makes the ' +
          'signature verify against the wrong bytes and surfaces as VI_SIGNATURE_MISMATCH.',
      })
      return
    }
    const [encodedHeader = '', encodedPayload = ''] = parts
    let decodedHeader: unknown
    let decodedPayload: unknown
    try {
      decodedHeader = JSON.parse(b64urlToUtf8(encodedHeader)) as unknown
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['signing_input'],
        message: 'signing_input segment 0 is not base64url-encoded JSON',
      })
      return
    }
    try {
      decodedPayload = JSON.parse(b64urlToUtf8(encodedPayload)) as unknown
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['signing_input'],
        message: 'signing_input segment 1 is not base64url-encoded JSON',
      })
      return
    }
    if (JSON.stringify(sortedJson(decodedHeader)) !== JSON.stringify(sortedJson(res.header))) {
      ctx.addIssue({
        code: 'custom',
        path: ['header'],
        message:
          'header does not match signing_input segment 0. The UI renders `header`/`payload` as the ' +
          'consent read-back (spec §8.5), so they must be the bytes being signed.',
      })
    }
    if (JSON.stringify(sortedJson(decodedPayload)) !== JSON.stringify(sortedJson(res.payload))) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload'],
        message:
          'payload does not match signing_input segment 1. The UI renders `header`/`payload` as the ' +
          'consent read-back (spec §8.5), so they must be the bytes being signed.',
      })
    }
  })
export type L2PrepareResponse = z.infer<typeof l2PrepareResponseSchema>

/** Recursively key-sort a decoded JSON value so two objects compare structurally, not by insertion order. */
function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : 1,
    )
    return Object.fromEntries(entries.map(([k, v]) => [k, sortedJson(v)]))
  }
  return value
}

// ---------------------------------------------------------------------------
// POST /v1/l2/finalize
// ---------------------------------------------------------------------------

export const l2FinalizeRequestSchema = z.strictObject({
  prepare_id: boundedString(128),
  /** Raw 64-byte ES256 r‖s (P1363), base64url. **Not DER** — the library rejects DER. */
  signature_b64url: b64urlSchema,
})
export type L2FinalizeRequest = z.input<typeof l2FinalizeRequestSchema>

/**
 * `L2FinalizeResponse` — the finished L2, **with its disclosures appended**.
 *
 * A token without them carries no mandate; `verify_chain` reports "L2 delegate_payload resolved zero
 * mandate disclosures". `exp` is nullable and not required in vi's model, so it is optional here.
 */
export const l2FinalizeResponseSchema = z.object({
  l2: z.string().min(1).max(131_072),
  iat: z.number().int(),
  exp: z.number().int().nullable().optional(),
  agent_kid: z.string(),
})
export type L2FinalizeResponse = z.infer<typeof l2FinalizeResponseSchema>

// ---------------------------------------------------------------------------
// POST /v1/checkout-jwt
// ---------------------------------------------------------------------------

/** `CheckoutLine` — `qty` and `unit_minor` are `strict=True` integers; no floats (EC-FX-6). */
export const checkoutLineSchema = z.strictObject({
  sku: boundedString(128),
  title: boundedString(512),
  qty: z.number().int().min(1).max(1000),
  unit_minor: minorUnitsSchema,
})
export type CheckoutLine = z.input<typeof checkoutLineSchema>

export const checkoutJwtRequestSchema = z.strictObject({
  merchant: merchantRefSchema,
  lines: z.array(checkoutLineSchema).min(1),
  shipping_minor: minorUnitsSchema.default(0n),
  tax_minor: minorUnitsSchema.default(0n),
  currency: currencySchema,
  ttl_seconds: z.number().int().min(30).max(86_400).default(900),
  checkout_id: boundedString(128).nullable().optional(),
})
export type CheckoutJwtRequest = z.input<typeof checkoutJwtRequestSchema>

export const checkoutJwtResponseSchema = z.object({
  checkout_jwt: z.string(),
  checkout_hash: boundedString(2048),
  exp: z.number().int(),
  total_minor: minorUnitsSchema,
  currency: currencySchema,
  kid: z.string(),
})
export type CheckoutJwtResponse = z.infer<typeof checkoutJwtResponseSchema>

// ---------------------------------------------------------------------------
// POST /v1/l3/create
// ---------------------------------------------------------------------------

/**
 * `L3Payment` — `amount_minor` is integer minor units and is **refused out of range at `l3/create`**.
 *
 * The agent is the untrusted party (spec §3.1), so the service evaluates the L2's constraints
 * *before* signing and answers `VI_CONSTRAINT_VIOLATION`. A route that signed first and let the Gate
 * catch it later would let a prompt injection in a product listing spend money.
 */
export const l3PaymentSchema = z.strictObject({
  amount_minor: minorUnitsSchema,
  currency: currencySchema,
  payee_id: boundedString(128),
})
export type L3Payment = z.input<typeof l3PaymentSchema>

export const l3CreateRequestSchema = z.strictObject({
  agent_kid: boundedString(256),
  /** AES-256-GCM ciphertext from `POST /v1/keys/agent`, base64. Layout nonce(12)||ciphertext||tag(16). */
  enc_private_key_b64: boundedString(4096),
  l2: boundedString(65536),
  checkout_jwt: boundedString(32768),
  payment: l3PaymentSchema,
  aud: boundedString(2048),
  nonce: boundedString(256),
  iss: boundedString(2048).nullable().optional(),
  ttl_seconds: z.number().int().min(30).max(3600).default(300),
  agent_id: boundedString(128).nullable().optional(),
})
export type L3CreateRequest = z.input<typeof l3CreateRequestSchema>

/**
 * `L3CreateResponse`.
 *
 * `jti` is a **deterministic** replay id: base64url SHA-256 of the L3a issuer JWT, identical on every
 * retry of the same request. That is what makes `checkout_attempts.l3_jti`'s unique constraint a replay
 * guard rather than a retry breaker.
 *
 * `payment_presentation` / `checkout_presentation` are the two selective-disclosure slices: what the
 * payment network sees and what the merchant sees, respectively. Neither is the whole L2.
 */
export const l3CreateResponseSchema = z.object({
  l3a: z.string(),
  l3b: z.string(),
  jti: boundedString(2048),
  iat: z.number().int(),
  exp: z.number().int(),
  checkout_hash: z.string(),
  payment_presentation: z.string(),
  checkout_presentation: z.string(),
})
export type L3CreateResponse = z.infer<typeof l3CreateResponseSchema>

// ---------------------------------------------------------------------------
// POST /v1/verify
// ---------------------------------------------------------------------------

/**
 * `VerifyRequest`.
 *
 * The `errors` on the **response** are the interesting half of this route: an invalid chain is a
 * `200` with `chain_valid: false` and reasons, never a 4xx. `client.verify` therefore returns this as
 * `ok(...)`, and it is the Gate's job to read `chain_valid` and `errors` — see `client.ts`.
 */
export const verifyRequestSchema = z.strictObject({
  l1: boundedString(65536),
  l2: boundedString(131072),
  l3a: z.string().max(65536).nullable().optional(),
  l3b: z.string().max(65536).nullable().optional(),
  checkout_jwt: z.string().max(32768).nullable().optional(),
  expected_aud: z.string().max(2048).nullable().optional(),
  expected_nonce: z.string().max(256).nullable().optional(),
  /**
   * EC-TIME-3: verify "as of capture time".
   *
   * The pinned library's `verify_chain` has **no clock override** — it calls `time.time()`
   * internally — so vi cannot produce a genuine as-of verdict and reports
   * `at_time_not_honoured: true` with a reason instead of fabricating one. A fabricated as-of
   * verdict would be worse than none: it would end up in an evidence packet filed with PayPal.
   */
  at_time: z.number().int().nullable().optional(),
  strict: z.boolean().default(true),
})
export type VerifyRequest = z.input<typeof verifyRequestSchema>

/** `AtTimeCheck` — the advisory window report described in the module header. */
export const atTimeCheckSchema = z.object({
  requested: z.number().int(),
  /** Always `false` while the library exposes no `now` parameter. */
  honoured: z.boolean(),
  reason: z.string(),
  within_validity_at: z.boolean(),
  within_validity_now: z.boolean(),
  l1_exp: z.number().int().nullable().optional(),
  l2_exp: z.number().int().nullable().optional(),
})
export type AtTimeCheck = z.infer<typeof atTimeCheckSchema>

/**
 * `ConstraintReport` — `satisfied`, `violations`, `checked`, `skipped`.
 *
 * ### `skipped` is the field that carries spec D19 across the wire
 *
 * The library appends `mandate.payment.budget`, `mandate.payment.recurrence` and
 * `mandate.payment.agent_recurrence` to `checked` while evaluating **none** of them; `apps/vi` moves
 * them to `skipped` so the Gate can see what it still owes (spec §8.8 [B3], D19). Reading
 * `constraints.satisfied` alone would tell the Gate that a budget cap was honoured when nobody checked it,
 * which is the exact failure D19 exists to prevent.
 *
 * ### The entries are annotated strings, not bare type names
 *
 * This is measured against a running service, not inferred, and it is the sharpest edge on this route.
 * `apps/vi`'s `classify_constraint_report` appends a reason to each one, and the same list also carries
 * free-form notes:
 *
 * ```jsonc
 * "checked": ["mandate.payment.amount_range", "mandate.payment.allowed_payees"],
 * "skipped": [
 *   "mandate.payment.budget — Network-enforced constraints. Not evaluated by verifiable_intent; Countersign's Gate enforces it (spec D19). NOT satisfied by this response.",
 *   "checkout constraint evaluation (needs the checkout_jwt cart)"
 * ]
 * ```
 *
 * So `skipped.includes('mandate.payment.budget')` is **`false`**, always — and a Gate written that way
 * would conclude it owes nothing while a budget cap sits unchecked. `checked`, by contrast, *is* bare type
 * names, so the two lists on the same object have different element formats.
 *
 * That is why the wire type stays a faithful `string[]` and the interpretation lives in named helpers:
 * {@link skippedConstraintTypes} and {@link pendingNetworkEnforcement}. Use those, never `includes`.
 * (Reported as a WP-04 finding: making `skipped` a list of bare types, or a `{type, reason}[]`, would
 * remove the trap at the source.)
 *
 * An **empty** constraint list is reported as `satisfied: false` ("no constraints were disclosed"),
 * never as a pass. Nothing to check is not the same as checked.
 */

/**
 * The separator `apps/vi` used before D-019, when `skipped` entries were annotated strings.
 * Kept for one reason: reading an old entry correctly. It has no other role.
 */
const SKIP_REASON_SEPARATOR = ' — '

/**
 * Split a pre-D-019 annotated entry into `{type, reason}`.
 *
 * Parsing on that exact separator rather than by "contains the type" means a note that merely
 * *mentions* a type is not mistaken for that type having been skipped.
 */
function splitLegacySkip(entry: string): NormalisedSkip {
  const [type = '', ...rest] = entry.split(SKIP_REASON_SEPARATOR)
  return { type: type.trim(), reason: rest.join(SKIP_REASON_SEPARATOR).trim() }
}

/**
 * One entry of `constraints.skipped`, **as parsed**.
 *
 * ## Why this is an object and not a string (docs/DECISIONS.md D-019)
 *
 * `skipped` used to be `list[str]` where an entry was either a bare constraint type or
 * `"<type> — Network-enforced constraints. Not evaluated by…"`, mixed together. That is a trap with a
 * quiet, expensive failure: a Gate writing `skipped.includes('mandate.payment.budget')` gets
 * **`false` while a signed budget cap sits unevaluated**, so it concludes it owes nothing. Spec D19
 * exists precisely to stop the budget being unenforced, and that one array shape would have undone it.
 *
 * The schema below accepts **either** wire shape but **transforms to the object**, and that split is
 * the whole point:
 *
 *  - Runtime tolerance: parsing an older vi-service that still emits annotated strings does not throw.
 *    A throw here would fail the Gate's verify step, which is a worse outcome than a missing field.
 *  - Compile-time prevention: the *output* element type is `{type, reason}`, so
 *    `skipped.includes('mandate.payment.budget')` is a **type error**. That guarantee does **not**
 *    survive a plain `z.union` — `(string | Obj)[]` still accepts `.includes(string)`, which is why the
 *    union alone was not enough. `.transform()` is what makes the guarantee real, and
 *    `test/types.test.ts` pins it with `@ts-expect-error`.
 *
 * Use {@link pendingNetworkEnforcement} to learn what the Gate still owes; never `.includes`.
 */
export const skippedConstraintSchema = z
  .union([z.object({ type: z.string().min(1), reason: z.string().default('') }), z.string().min(1)])
  .transform((v) =>
    typeof v === 'string' ? splitLegacySkip(v) : { type: v.type, reason: v.reason },
  )
export type SkippedConstraint = z.infer<typeof skippedConstraintSchema>

export const constraintReportSchema = z.object({
  satisfied: z.boolean(),
  violations: z.array(z.string()),
  checked: z.array(z.string()),
  skipped: z.array(skippedConstraintSchema),
})
export type ConstraintReport = z.infer<typeof constraintReportSchema>

/** The structured form of a skipped entry, after normalisation. */
export interface NormalisedSkip {
  /** A registered constraint type, or a synthetic category name for an evaluation that could not run. */
  type: string
  reason: string
}

/**
 * Normalise `skipped` to `{type, reason}[]`.
 *
 * Also accepts the raw wire shape, so a caller holding an unparsed `unknown` body is not forced to
 * parse twice.
 */
export function normaliseSkipped(
  skipped: readonly (NormalisedSkip | string)[] | undefined,
): NormalisedSkip[] {
  return (skipped ?? []).map((entry) =>
    typeof entry === 'string' ? splitLegacySkip(entry) : { type: entry.type, reason: entry.reason },
  )
}

/**
 * The registered constraint types present in a `skipped` list.
 *
 * Free-form categories — a note such as `"checkout_constraint_evaluation"` for an evaluation that
 * could not run at all — are not returned, because they name a category rather than a constraint
 * type. `pendingNetworkEnforcement` deliberately ignores them too: a skipped *evaluation* is not the
 * same as a skipped network-enforced *constraint*, and conflating them would hide the latter.
 *
 * @param skipped the `constraints.skipped` array from a verify response.
 */
export function skippedConstraintTypes(
  skipped: readonly (NormalisedSkip | string)[] | undefined,
): ConstraintType[] {
  const out: ConstraintType[] = []
  for (const { type } of normaliseSkipped(skipped)) {
    if (
      (CONSTRAINT_TYPES as readonly string[]).includes(type) &&
      !out.includes(type as ConstraintType)
    ) {
      out.push(type as ConstraintType)
    }
  }
  return out
}

/**
 * The subset of `skipped` that **Countersign's Gate** is responsible for (spec D19).
 *
 * This is the function a Gate decision should consult. It exists because `skipped.includes(type)` is the
 * natural thing to write and is silently always `false` — see the note on {@link constraintReportSchema}.
 *
 * A non-empty result means those constraints were disclosed but **not evaluated by anyone yet**, so a
 * `constraints.satisfied: true` verdict says nothing about them. An empty result does **not** mean the Gate
 * has nothing to do: it means none of those three types were disclosed in this chain, which is a different
 * and equally important fact.
 *
 * @param skipped the `constraints.skipped` array from a verify response.
 * @returns the disclosed network-enforced types, in the order they appeared.
 */
export function pendingNetworkEnforcement(
  skipped: readonly (NormalisedSkip | string)[] | undefined,
): ConstraintType[] {
  return skippedConstraintTypes(skipped).filter((t) => NETWORK_ENFORCED_CONSTRAINTS.has(t))
}

/** `DisclosedReport` — the decoded payloads vi resolved, per layer. */
export const disclosedReportSchema = z.object({
  l1: jsonObjectSchema.default({}),
  l2: jsonObjectSchema.default({}),
  l3a: jsonObjectSchema.default({}),
  l3b: jsonObjectSchema.default({}),
})
export type DisclosedReport = z.infer<typeof disclosedReportSchema>

/** `KeyReport` — which keys the chain resolved to, by role. */
export const keyReportSchema = z.object({
  issuer_kid: z.string().nullable().optional(),
  device_jkt: z.string().nullable().optional(),
  agent_kid: z.string().nullable().optional(),
  device_kid: z.string().nullable().optional(),
  merchant_kid: z.string().nullable().optional(),
})
export type KeyReport = z.infer<typeof keyReportSchema>

/**
 * `VerifyResponse` — spec §8.3. Every field the Gate reads to decide, in one object.
 *
 * The two fields a caller must not skip are `constraints.skipped` (spec D19) and
 * `at_time_not_honoured` (EC-TIME-3): together they are the difference between "verified" and
 * "verified within the parts that could be verified".
 */
export const verifyResponseSchema = z.object({
  chain_valid: z.boolean(),
  errors: z.array(z.string()),
  constraints: constraintReportSchema,
  disclosed: disclosedReportSchema,
  keys: keyReportSchema,
  checks_performed: z.array(z.string()).default([]),
  checks_skipped: z.array(z.string()).default([]),
  /** Epoch seconds, UTC (spec §0: time is UTC epoch seconds). */
  verified_at: z.number().int(),
  clock_skew_seconds: z.number().int(),
  at_time_not_honoured: z.boolean().default(false),
  at_time_reason: z.string().nullable().optional(),
  at_time_check: atTimeCheckSchema.nullable().optional(),
})
export type VerifyResponse = z.infer<typeof verifyResponseSchema>

// ---------------------------------------------------------------------------
// POST /v1/public/verify
// ---------------------------------------------------------------------------

/**
 * `EvidenceBundle` (spec §7.3) — `extra="allow"`, so `looseObject`.
 *
 * Only the chain fields are verified here. `v` is the evidence version (`cs1`); vi does not check it,
 * so neither does this schema.
 */
export const evidenceBundleSchema = z.looseObject({
  v: z.string().nullable().optional(),
  l1: boundedString(65536),
  l2: boundedString(131072),
  l3a: z.string().max(65536).nullable().optional(),
  l3b: z.string().max(65536).nullable().optional(),
  checkout_jwt: z.string().max(32768).nullable().optional(),
  gate_decision: z.string().max(32768).nullable().optional(),
  vi_lib_commit: z.string().nullable().optional(),
})
export type EvidenceBundle = z.input<typeof evidenceBundleSchema>

export const publicVerifyRequestSchema = z.strictObject({
  bundle: evidenceBundleSchema,
  expected_aud: z.string().max(2048).nullable().optional(),
  expected_nonce: z.string().max(256).nullable().optional(),
  at_time: z.number().int().nullable().optional(),
})
export type PublicVerifyRequest = z.input<typeof publicVerifyRequestSchema>

/**
 * `PublicVerifyResponse(VerifyResponse)` — everything `/v1/verify` returns, plus `bundle_hash`.
 *
 * vi models this as a pydantic **subclass** of `VerifyResponse`, so the faithful mirror is "verify's
 * shape plus exactly one field". `verifyResponseSchema` is refined (for the `signing_input`
 * invariant, which `PublicVerifyResponse` does not carry), so the shape is spread into a fresh object
 * rather than using `.extend()` on the refined schema — otherwise this response would inherit a
 * refinement about a field it does not have.
 *
 * Public and rate-limited to 30/min/IP. This is the route behind `/v/{packetId}` (spec §7.3, WP-18).
 */
export const publicVerifyResponseSchema = z.object({
  ...verifyResponseSchema.shape,
  /** base64url SHA-256 over the RFC 8785 (JCS) canonical form of the bundle — the same value stamped into `custom_id` as `"cs1:" + bundle_hash`. */
  bundle_hash: boundedString(2048),
})
export type PublicVerifyResponse = z.infer<typeof publicVerifyResponseSchema>

// ---------------------------------------------------------------------------
// GET /v1/status
// ---------------------------------------------------------------------------

/**
 * `StatusResponse` — liveness plus the kids in force and the skew `VI_CLOCK_SKEW_SECONDS` is using.
 *
 * EC-TIME-2 asks for a clock comparison between web and vi. This reports what **vi** believes; the
 * caller compares it with its own clock. The bounded skew is what makes a few seconds of drift
 * harmless (spec §12.5).
 */
export const statusResponseSchema = z.object({
  ok: z.boolean(),
  app_env: z.string(),
  issuer_kid: z.string(),
  merchant_kid: z.string(),
  clock_skew_seconds: z.number().int(),
})
export type StatusResponse = z.infer<typeof statusResponseSchema>

// ---------------------------------------------------------------------------
// GET /v1/checkout-jwt/verify
// ---------------------------------------------------------------------------

/**
 * The `GET /v1/checkout-jwt/verify` answer: `{valid, reason, checked_at}`.
 *
 * Always answers — a price lock that does not even parse is `valid: false` here, not a 4xx, because
 * the whole point of the route is to be asked "is this thing good?" and get told. `reason` is
 * therefore non-optional and non-nullable here even though the route declares no pydantic model for
 * it; `main.py` always sets all three keys.
 *
 * vi's OpenAPI declares this response as a bare `object`, so `schema-drift.ts` reports it as
 * **opaque / unverifiable**. That is a finding about the service, not a claim of agreement.
 */
export const checkoutJwtVerifyResponseSchema = z.object({
  valid: z.boolean(),
  reason: z.string(),
  checked_at: z.number().int(),
})
export type CheckoutJwtVerifyResponse = z.infer<typeof checkoutJwtVerifyResponseSchema>

// ---------------------------------------------------------------------------
// The route manifest — the table `client.ts` and `schema-drift.ts` both walk
// ---------------------------------------------------------------------------

/** Which side of a contract a schema describes. */
export type ContractSide = 'request' | 'response'

export interface RouteContract {
  readonly method: 'GET' | 'POST'
  readonly path: string
  /**
   * Whether the route needs `Authorization: Bearer $VI_SERVICE_TOKEN`.
   *
   * Mirrors spec §8.3 exactly: every route is bearer-authenticated except `GET /v1/jwks` and
   * `POST /v1/public/verify`. `client.ts` reads this rather than hard-coding a list, so a route added
   * to the service without a bearer token cannot be reached by accident.
   */
  readonly auth: 'bearer' | 'public'
  readonly request?: z.ZodType
  readonly response: z.ZodType
  /** One-line purpose, used as a comment column in the drift table. */
  readonly note: string
}

/**
 * Every route in `apps/vi/src/vi_service/main.py`, in the order the service declares them.
 *
 * This single table is the source of truth for three things — which routes exist, what they accept,
 * and which need the bearer token — so the client, the tests and the drift check cannot disagree
 * about any of them.
 */
export const ROUTE_CONTRACTS: readonly RouteContract[] = [
  {
    method: 'POST',
    path: '/v1/keys/agent',
    auth: 'bearer',
    request: mintAgentKeyRequestSchema,
    response: mintAgentKeyResponseSchema,
    note: 'Mint one agent key; returns the public JWK and the KEK-encrypted private half.',
  },
  {
    method: 'POST',
    path: '/v1/keys/rotate',
    auth: 'bearer',
    request: rotateKeyRequestSchema,
    response: rotateKeyResponseSchema,
    note: 'Retire the current ISSUER/MERCHANT key and mint a replacement.',
  },
  {
    method: 'GET',
    path: '/v1/jwks',
    auth: 'public',
    response: jwksResponseSchema,
    note: 'All public keys, retired ones included with a status.',
  },
  {
    method: 'POST',
    path: '/v1/l1/issue',
    auth: 'bearer',
    request: l1IssueRequestSchema,
    response: l1IssueResponseSchema,
    note: 'Issuer signs L1, binding sub, the device public key and card_id.',
  },
  {
    method: 'POST',
    path: '/v1/l2/prepare',
    auth: 'bearer',
    request: l2PrepareRequestSchema,
    response: l2PrepareResponseSchema,
    note: 'Phase 1 of two-phase signing: build the L2 body and hand the browser the bytes.',
  },
  {
    method: 'POST',
    path: '/v1/l2/finalize',
    auth: 'bearer',
    request: l2FinalizeRequestSchema,
    response: l2FinalizeResponseSchema,
    note: 'Phase 2: verify the browser signature against the L1 device key, then return the L2.',
  },
  {
    method: 'POST',
    path: '/v1/checkout-jwt',
    auth: 'bearer',
    request: checkoutJwtRequestSchema,
    response: checkoutJwtResponseSchema,
    note: 'Merchant signs the price lock. Integer minor units throughout.',
  },
  {
    method: 'POST',
    path: '/v1/l3/create',
    auth: 'bearer',
    request: l3CreateRequestSchema,
    response: l3CreateResponseSchema,
    note: 'Pre-check against the L2 constraints, then sign L3a + L3b.',
  },
  {
    method: 'POST',
    path: '/v1/verify',
    auth: 'bearer',
    request: verifyRequestSchema,
    response: verifyResponseSchema,
    note: 'verify_chain + check_constraints(STRICT). An invalid chain is 200 with reasons.',
  },
  {
    method: 'POST',
    path: '/v1/public/verify',
    auth: 'public',
    request: publicVerifyRequestSchema,
    response: publicVerifyResponseSchema,
    note: 'Public, rate-limited, for /v/{packetId}. Same verdict plus bundle_hash.',
  },
  {
    method: 'GET',
    path: '/v1/status',
    auth: 'public',
    response: statusResponseSchema,
    note: 'Liveness, kids in force, and the clock skew vi is using.',
  },
  {
    method: 'GET',
    path: '/v1/checkout-jwt/verify',
    auth: 'bearer',
    response: checkoutJwtVerifyResponseSchema,
    note: 'Diagnostic: does this price lock verify against a merchant key we know?',
  },
] as const

/** Look a route up by `"<METHOD> <path>"`, the key {@link shouldRetry} and the tests both use. */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

/**
 * Find a route contract, or `undefined`. Used by tests and by the drift check's own coverage report.
 *
 * A query string is stripped before the lookup, so `GET /v1/checkout-jwt/verify?checkout_jwt=…` resolves
 * to the one contract for that route. Stripping lives here rather than at the call site so there is a
 * single answer to "which contract is this URL".
 */
export function findRouteContract(method: string, path: string): RouteContract | undefined {
  const key = routeKey(method, path.split('?')[0] ?? path)
  return ROUTE_CONTRACTS.find((r) => routeKey(r.method, r.path) === key)
}
