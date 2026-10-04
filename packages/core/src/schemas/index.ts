/**
 * Shared zod schemas — spec §8.1 M1 ("ids, money, errors, clock, schemas").
 *
 * This is the one place where **untrusted shapes become typed values**. Everything that arrives from
 * a browser, from the PayPal API, from the MCP server or from an LLM passes through a schema here
 * before it can reach business logic (spec §8.0 rule 4: "No LLM output is authoritative").
 *
 * Money schemas use `z.bigint()` so a JSON `number` can never silently become a money value:
 * JSON has no bigint, so a boundary that expects `minor` must be handed a string, and
 * {@link bigintFromJson} is the only sanctioned conversion.
 */
import { z } from 'zod'

import { CURRENCIES, MINOR_DIGITS } from '../money'
import { csError, ok, err, type Result } from '../errors'

/** ISO-4217 code. */
export const currencySchema = z.enum(CURRENCIES)
export type CurrencySchema = z.infer<typeof currencySchema>

/**
 * Integer minor units. Accepts a bigint, a decimal-safe integer string, or a JS integer — but the
 * refinements below still refuse anything non-integral, so `129.99` never becomes `129n`.
 */
export const minorSchema = z
  .union([z.bigint(), z.string(), z.number()])
  .transform((v, ctx) => {
    if (typeof v === 'bigint') return v
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Money must be integer minor units. A float reached the boundary, which means precision ' +
            'was already lost — pass a decimal string such as "12999".',
        })
        return z.NEVER
      }
      if (!Number.isSafeInteger(v)) {
        ctx.addIssue({ code: 'custom', message: 'Amount exceeds Number.MAX_SAFE_INTEGER' })
        return z.NEVER
      }
      return BigInt(v)
    }
    const t = v.trim()
    if (!/^-?\d+$/.test(t)) {
      ctx.addIssue({
        code: 'custom',
        message: `Not an integer minor-unit string: ${JSON.stringify(v)}`,
      })
      return z.NEVER
    }
    return BigInt(t)
  })
  .refine((v) => v >= 0n, { message: 'Money must be non-negative' })

/** A money shape as it appears in JSON: `{ currency: "USD", minor: "13000" }`. */
export const moneySchema = z
  .object({ currency: currencySchema, minor: minorSchema })
  .transform((v) => ({
    minor: v.minor,
    currency: v.currency,
  }))

export type MoneyJson = { currency: CurrencySchema; minor: string | number | bigint }

/** Epoch seconds. A JWT `exp` is an integer second count, not milliseconds. */
export const epochSecondsSchema = z.number().int().nonnegative()

/** RFC 3339 timestamp, as PayPal sends it (e.g. `2026-10-09T18:29:00Z`). */
export const rfc3339Schema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Not an RFC 3339 timestamp' })
  .transform((s) => new Date(s).toISOString())

/** base64url without padding — JWT segments, PayPal-Auth-Assertion, our signed records. */
export const base64urlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/, 'Expected unpadded base64url')

/** A compact JWS/JWT we receive from somewhere and must parse. Three segments, non-empty. */
export const compactJwsSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/,
    'Expected a compact JWS (header.payload.signature)',
  )

/** `cs1:<43 chars>` — the evidence hash stamped into `purchase_units[].custom_id` (spec §7.3, D18). */
export const customIdSchema = z
  .string()
  .regex(/^cs1:[A-Za-z0-9_-]{43}$/, 'Expected "cs1:" + 43 base64url characters (spec §7.3)')
  .refine((v) => v.length === 47, { message: 'custom_id must be exactly 47 characters' })

/** The `cs1` evidence bundle version tag. Bumping it invalidates every verifier, so it is a constant. */
export const EVIDENCE_BUNDLE_VERSION = 'cs1' as const
export const evidenceBundleVersionSchema = z.literal(EVIDENCE_BUNDLE_VERSION)

/**
 * A PayPal amount object: `{ currency_code, value }` with a **decimal string** value (spec §8.6).
 *
 * Two rules PayPal does not enforce for us and that therefore must be enforced here:
 *  - `value` is a string. A JSON number in this position means a float was created upstream, and by
 *    then the precision is already gone, so the request is refused rather than silently rounded.
 *  - the number of decimal places must match the currency's minor digits *for that currency*.
 *    `"500.00"` is valid USD and invalid JPY, so the check has to read `currency_code` from the
 *    object under validation — not from a constant.
 */
export const ppAmountSchema = z
  .object({
    currency_code: currencySchema,
    value: z.string(),
  })
  .strict()
  .superRefine((amount, ctx) => {
    const digits = MINOR_DIGITS[amount.currency_code]
    if (!/^\d+(\.\d+)?$/.test(amount.value)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message:
          'PayPal amount values are plain non-negative decimal strings (e.g. "48.00"), ' +
          'never numbers and never exponent forms',
      })
      return
    }
    const decimals = amount.value.includes('.') ? (amount.value.split('.')[1] ?? '').length : 0
    if (decimals > digits) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `${amount.currency_code} has ${digits} minor digits; "${amount.value}" has ${decimals}`,
      })
    }
  })

/** Our canonical `{ currency, minor }` pair as used in tokens and in the evidence bundle. */
export const jsonMoneySchema = z
  .object({ currency: currencySchema, minor: z.union([z.string(), z.number(), z.bigint()]) })
  .transform((v) => ({ currency: v.currency, minor: bigintFromJson(v.minor) }))

/**
 * The one sanctioned `JSON -> bigint` conversion.
 *
 * JSON.parse can never produce a bigint, so every money field crossing a JSON boundary arrives as a
 * string or a number. Route them here so the conversion happens once and is auditable.
 */
export function bigintFromJson(v: string | number | bigint): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) {
      throw csError(
        'CS_VALIDATION',
        'Money value exceeds the safe integer range; pass it as a string',
        {
          value: String(v),
        },
      )
    }
    return BigInt(v)
  }
  const t = v.trim()
  if (!/^-?\d+$/.test(t)) {
    throw csError('CS_VALIDATION', `Not an integer minor-unit string: ${JSON.stringify(v)}`)
  }
  return BigInt(t)
}

/** A SKU from the merchant catalog. Uppercase alphanumerics and dashes, 2–32 chars. */
export const skuSchema = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, 'SKU must be uppercase alphanumerics and dashes')

/**
 * Merchant-asserted listing text. Typed so that an untrusted string cannot be passed where a
 * structured value is expected (spec §8.13 injection defence 1: wrap listings as untrusted).
 */
export const untrustedTextSchema = z.object({
  untrusted_text: z.string(),
})

/** A paged list response envelope shared by our APIs. */
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() })

/** Payload shape returned by every route handler for a failure. Mirrors `CsErrorBody`. */
export const csErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    userMessage: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

/**
 * `parse` that returns a `Result` instead of throwing, so route handlers can map an unknown zod
 * issue straight onto `CS_VALIDATION` without a try/catch at every call site.
 */
export function parseOr<S extends z.ZodType>(schema: S, value: unknown): Result<z.output<S>> {
  const r = schema.safeParse(value)
  if (r.success) return ok(r.data)
  return err(
    csError('CS_VALIDATION', `Schema validation failed: ${formatIssues(r.error)}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }),
  )
}

function formatIssues(e: z.ZodError): string {
  return e.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}

export { z }
