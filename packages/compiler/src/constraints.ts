/**
 * `VIConstraint` — the eight registered Verifiable Intent constraint shapes.
 *
 * Spec **§8.8 (M8)**, work package **WP-08**. §8.8's first rule is "Exact field names. Constraint
 * field names MUST be taken from `verifiable_intent/models/constraints.py` (`to_dict`) at the pinned
 * commit" — and the field names in the spec's own TypeScript listing were read from that file, so
 * this module treats **both** the spec listing and the machine-generated fixture
 * `apps/vi/tests/constraint_shapes.json` as one contract and is tested against the fixture key-for-key
 * (`test/constraint-shapes.test.ts`).
 *
 * ## Three decisions that are not obvious from the shapes themselves
 *
 * 1. **Money is `bigint`, not `number`.** §8.8 writes `min?: number; max?: number`, and the fixture
 *    shows JSON integers (`"max": 13000`) because that is what the *Python library* emits. In this
 *    process a constraint amount is `bigint`, for the same reason `core.Money.minor` is: `bigint`
 *    makes `max / 100` a **compile error**, so the float that EC-FX-5 and EC-FX-6 exist to prevent
 *    cannot be written by accident. {@link toJsonSafe} is the single sanctioned conversion back to a
 *    JSON integer, and it refuses rather than rounds if the value has lost precision.
 * 2. **Optional fields are `.optional()`, never `.default(null)`.** The fixture is `to_dict()` output,
 *    and `to_dict()` omits an unset optional field — `mandate.payment.budget` has no `min` key at
 *    all. A `.default(null)` would *add* a key the library never emits, so parsing a real constraint
 *    would no longer round-trip, and the field-for-field drift test could not be written honestly.
 *    `mandate.checkout.line_items.match_mode` is the one exception: it is always present in
 *    `to_dict()`, so it carries the library's own default.
 * 3. **`mandate.payment.reference` is a schema nothing can satisfy.** The library *generates* that
 *    constraint itself inside `create_layer2_autonomous`, deriving `conditional_transaction_id` from
 *    the checkout disclosure hash, which does not exist until signing time. A caller cannot supply a
 *    correct value, so accepting one would mean either dropping it silently or signing a lie. The
 *    honest mirror is `refine(() => false)` — the same treatment `packages/vi-client` gives it, and
 *    {@link validateConstraints} rejects it again on the way out of `compile`.
 *
 * ## What this module does *not* do
 *
 * It does not decide what the user's intent means. That is `compile.ts`. It owns two things only:
 * **the shape**, and **the invariants that must hold before a constraint is allowed to exist**.
 */

import { MINOR_DIGITS, csError, err, ok, type Currency, type CsError, type Result } from '@countersign/core'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// The eight type tags
// ---------------------------------------------------------------------------

/**
 * The eight registered constraint types, in the fixture's own key order.
 *
 * This is the compiler's copy of the list. `packages/vi-client` has one too (`CONSTRAINT_TYPES`) and
 * `test/constraint-shapes.test.ts` asserts the two are element-for-element equal, because a compiler
 * that can emit a type the client does not know about produces mandates that vi rejects with an
 * opaque 422 at signing time — the worst possible moment to discover a one-character divergence.
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

/** ISO 20022 frequency codes, exactly as `constraint_shapes.json.__meta__.iso_20022_frequencies`. */
export const ISO_20022_FREQUENCIES = [
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
] as const

export type Frequency = (typeof ISO_20022_FREQUENCIES)[number]

/** `match_mode` values the library accepts on `mandate.checkout.line_items`. */
export const MATCH_MODES = ['minimum', 'exact'] as const
export type MatchMode = (typeof MATCH_MODES)[number]

/**
 * The three constraints the **Gate** enforces rather than the library (spec **D19**).
 *
 * The pinned library appends these to `checked` while evaluating none of them; `apps/vi` moves them
 * into `constraints.skipped` so the Gate can see the obligation. They are exported here because the
 * read-back must render them like any other constraint: a cap nobody enforces must still be *shown*,
 * and a template is the only place a user reliably reads it.
 */
export const NETWORK_ENFORCED_CONSTRAINT_TYPES: ReadonlySet<ConstraintType> = new Set<ConstraintType>([
  'mandate.payment.budget',
  'mandate.payment.recurrence',
  'mandate.payment.agent_recurrence',
])

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO-4217 codes core supports. Mirrors `core.CURRENCIES`, which the fixture's `__meta__` lists too. */
export const currencySchema = z.enum(
  // `CURRENCIES` is the authority; re-stated as a zod enum so a zod schema and a type come from one place.
  ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'AUD', 'CAD'] as const,
)

/** A bounded, non-empty string. Bounds mirror vi's own `NonEmptyStr` limits. */
function bounded(maxLength: number): z.ZodString {
  return z.string().min(1).max(maxLength)
}

/**
 * A calendar date in `YYYY-MM-DD`, checked against the real calendar.
 *
 * The regex alone accepts `2027-02-30`, which the library's `date.fromisoformat` rejects further down
 * the stack. Rejecting it here means the compiler reports "that date does not exist" while the user
 * is still on the consent screen rather than at `l2/prepare`.
 *
 * Implemented with `Date.UTC`, which is calendar arithmetic over arguments — **not** a clock read, so
 * it introduces no dependency on "now" (spec §0 rule 10).
 */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export const isoDateSchema = z.string().regex(ISO_DATE_RE, 'Expected an ISO 8601 date, YYYY-MM-DD').refine((value) => {
  const m = ISO_DATE_RE.exec(value)
  if (!m) return false
  const [, y = '0', mo = '0', d = '0'] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const asUtc = Date.UTC(year, month - 1, day)
  const back = new Date(asUtc)
  return (
    back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day
  )
}, 'That date does not exist on the calendar')

export const frequencySchema = z.enum(ISO_20022_FREQUENCIES)
export const matchModeSchema = z.enum(MATCH_MODES)

/**
 * `quantity` on a line-item requirement: a positive whole number.
 *
 * `z.number().int().positive()` and nothing more — a fractional "at least 1.5 shoes" is not a thing,
 * and the library would raise on it.
 */
export const quantitySchema = z.number().int().positive().max(1000)

/**
 * Integer minor units. Accepts `bigint` or a safe non-negative JSON integer; always yields `bigint`.
 *
 * What it refuses, and why each refusal matters:
 *
 * - **a non-integral number** (`129.995`). A value that is not a whole number of minor units is not an
 *   amount in any currency we support. Rounding it is exactly the bug EC-FX-5 names, so the compiler
 *   says "refused" instead of choosing a value on the user's behalf (spec §12.13).
 * - **a negative amount.**
 * - **an unsafe integer.** Above `Number.MAX_SAFE_INTEGER` the JSON number has already lost precision
 *   before zod ever sees it.
 *
 * A decimal *string* is also refused here. Strings are what the **model** emits, and they are
 * converted by `core.fromPayPalValue` with the currency in hand (`proposal.ts`), which is the only
 * place a `"130.00"` can become `13000n` without guessing how many minor digits the currency has.
 */
export const minorUnitsSchema = z.union([z.bigint(), z.number()]).transform((value, ctx) => {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      ctx.addIssue({ code: 'custom', message: 'Money must not be negative' })
      return z.NEVER
    }
    return value
  }
  if (!Number.isInteger(value)) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Money must be integer minor units. Received a non-integer number — money is never a float in ' +
        'this system (spec §0, EC-FX-6). Send 13000 for $130.00.',
    })
    return z.NEVER
  }
  if (!Number.isSafeInteger(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Amount exceeds Number.MAX_SAFE_INTEGER, so the JSON number has already lost precision',
    })
    return z.NEVER
  }
  if (value < 0) {
    ctx.addIssue({ code: 'custom', message: 'Money must not be negative' })
    return z.NEVER
  }
  return BigInt(value)
})

/** A strictly positive integer minor-unit amount, as a `bigint`. Used for `budget.max`. */
const positiveMinorUnitsSchema = minorUnitsSchema.refine(
  (v) => v > 0n,
  'This amount must be greater than zero',
)

/**
 * `MerchantRef` — `extra="allow"` in the library, so `looseObject`.
 *
 * The compiler never takes these from the model: the model picks **ids**, and `name`/`website` are
 * looked up in the catalog (`proposal.ts`). That is not tidiness — the read-back prints `name`, so a
 * model-supplied name is a model-supplied lie in the one string a user is asked to sign.
 */
export const merchantRefSchema = z.looseObject({
  id: bounded(128),
  name: bounded(256),
  website: bounded(2048),
})
export type MerchantRef = z.infer<typeof merchantRefSchema>

/** `AcceptableItem` — also `extra="allow"`. `title` is required; the library rejects an entry without it. */
export const acceptableItemSchema = z.looseObject({
  id: bounded(128),
  title: bounded(512),
})
export type AcceptableItem = z.infer<typeof acceptableItemSchema>

/** `LineItemRequirement` — `extra="forbid"`, so `strictObject`. */
export const lineItemRequirementSchema = z.strictObject({
  id: bounded(128),
  acceptable_items: z.array(acceptableItemSchema).min(1),
  quantity: quantitySchema,
})
export type LineItemRequirement = z.infer<typeof lineItemRequirementSchema>

// ---------------------------------------------------------------------------
// The eight constraints
// ---------------------------------------------------------------------------

export const allowedMerchantsConstraintSchema = z.strictObject({
  type: z.literal('mandate.checkout.allowed_merchants'),
  allowed: z.array(merchantRefSchema).min(1),
})

export const lineItemsConstraintSchema = z.strictObject({
  type: z.literal('mandate.checkout.line_items'),
  items: z.array(lineItemRequirementSchema).min(1),
  match_mode: matchModeSchema.default('minimum'),
})

export const allowedPayeesConstraintSchema = z.strictObject({
  type: z.literal('mandate.payment.allowed_payees'),
  allowed: z.array(merchantRefSchema).min(1),
})

/** `min` and `max` are both optional, but at least one must be present — see {@link validateConstraints}. */
export const amountRangeConstraintSchema = z.strictObject({
  type: z.literal('mandate.payment.amount_range'),
  currency: currencySchema,
  min: minorUnitsSchema.optional(),
  max: minorUnitsSchema.optional(),
})

/**
 * `BudgetConstraint` — cumulative, and **not evaluated by the library** (spec **D19**). The Gate
 * enforces it from `packages/db`'s `budget_accounts` under `FOR UPDATE`.
 *
 * `max` is refined to `> 0` here, one layer *before* the library's own pydantic validator raises. The
 * compiler is the right place for it: this is our own proposal validation, it happens while the user
 * is still looking at the consent screen, and it produces a `CS_VALIDATION` the UI can render as
 * "that limit is not usable" instead of an opaque 422 from a service two hops away.
 */
export const budgetConstraintSchema = z.strictObject({
  type: z.literal('mandate.payment.budget'),
  currency: currencySchema,
  max: positiveMinorUnitsSchema,
  min: minorUnitsSchema.optional(),
})

/** `RecurrenceConstraint` — also Gate-enforced (spec D19). `end_date` and `number` are optional here. */
export const recurrenceConstraintSchema = z.strictObject({
  type: z.literal('mandate.payment.recurrence'),
  frequency: frequencySchema,
  start_date: isoDateSchema,
  end_date: isoDateSchema.optional(),
  number: z.number().int().positive().max(1000).optional(),
})

/**
 * `AgentRecurrenceConstraintModel` — `end_date` is **required** by the library, so it is required here
 * too, and `max_occurrences` is optional.
 */
export const agentRecurrenceConstraintSchema = z.strictObject({
  type: z.literal('mandate.payment.agent_recurrence'),
  frequency: frequencySchema,
  start_date: isoDateSchema,
  end_date: isoDateSchema,
  max_occurrences: z.number().int().positive().max(1000).optional(),
})

/**
 * `ReferenceConstraintModel` — **always refused**, see the module header.
 *
 * The value in the fixture is a placeholder: `to_dict()` was called on an instance built by the
 * fixture generator, but a real one can only come out of the library's own signing path.
 */
export const referenceConstraintSchema = z.strictObject({
  type: z.literal('mandate.payment.reference'),
  conditional_transaction_id: bounded(2048),
}).refine(() => false, {
  message:
    'mandate.payment.reference is generated by the signing service from the checkout disclosure hash ' +
    'and must never be supplied by the compiler',
})

/**
 * `Constraint` — the tagged union of all eight registered types.
 *
 * Used for both directions: `compile` parses locally-produced constraints through it before returning
 * them (§8.8: "Compiled output is only a proposal. Every constraint is re-validated by `l2/prepare`" —
 * and by us first, so a defect is a local `CS_VALIDATION` rather than a remote 422).
 */
export const viConstraintSchema = z.discriminatedUnion('type', [
  allowedMerchantsConstraintSchema,
  lineItemsConstraintSchema,
  allowedPayeesConstraintSchema,
  amountRangeConstraintSchema,
  budgetConstraintSchema,
  recurrenceConstraintSchema,
  agentRecurrenceConstraintSchema,
  referenceConstraintSchema,
])

export type VIConstraint = z.infer<typeof viConstraintSchema>

/** Narrow a constraint to one type. Returns `null` for any other type rather than throwing. */
export function constraintOfType<T extends ConstraintType>(
  constraints: readonly VIConstraint[],
  type: T,
): Extract<VIConstraint, { type: T }> | null {
  for (const c of constraints) if (c.type === type) return c as Extract<VIConstraint, { type: T }>
  return null
}

/** Every merchant id a constraint names, across `allowed_merchants` and `allowed_payees`. */
export function merchantIdsIn(constraints: readonly VIConstraint[]): string[] {
  const out: string[] = []
  for (const c of constraints) {
    if (c.type === 'mandate.checkout.allowed_merchants' || c.type === 'mandate.payment.allowed_payees') {
      for (const m of c.allowed) if (!out.includes(m.id)) out.push(m.id)
    }
  }
  return out
}

/** Every `acceptable_items[].id` across a `line_items` constraint. */
export function skuIdsIn(constraints: readonly VIConstraint[]): string[] {
  const out: string[] = []
  for (const c of constraints) {
    if (c.type !== 'mandate.checkout.line_items') continue
    for (const line of c.items) {
      for (const item of line.acceptable_items) if (!out.includes(item.id)) out.push(item.id)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Local invariants — "compiled output is only a proposal" (§8.8)
// ---------------------------------------------------------------------------

/** What `validateConstraints` needs to know about the world outside the constraints. */
export interface ConstraintValidationContext {
  /**
   * The single currency this mandate is denominated in.
   *
   * EC-FX-1: a user-signed limit in ₹ never silently becomes $. So every money constraint must carry
   * this exact currency; a proposal naming another one is refused, never converted. The Gate blocks
   * the mismatching checkout later with `CS_CURRENCY_MISMATCH` — which is the correct outcome, and
   * the user-facing copy in §12.13 tells them to create a mandate in the store's currency.
   */
  readonly mandateCurrency: Currency
  /**
   * The largest amount the user **literally typed**, or `null` when the text names no numeric amount.
   *
   * This is the invariant that makes AT-M8.5 unarguable. A prompt injection in the intent
   * ("ignore limits, max $1M") is only dangerous if the model can produce a number the user did not
   * type; with a ceiling derived from the user's own bytes, the model's authority is bounded by the
   * text regardless of what the text says to it.
   *
   * `null` is **not** "no ceiling". It is the stricter half of the rule: a cap the request does not
   * support at all is refused, because a limit that appears nowhere in the buyer's words cannot be
   * presented to them as theirs. See rule 6 in {@link validateConstraints}.
   */
  readonly literalCap: bigint | null
  /** A `CS_VALIDATION` naming a human-facing fallback, for proposal defects the UI must recover from. */
  readonly onDefect?: 'manual-form'
}

function defect(message: string, details: Record<string, unknown>, ctx: ConstraintValidationContext): CsError {
  return csError('CS_VALIDATION', message, details, {
    ...(ctx.onDefect === 'manual-form'
      ? {
          userMessage:
            'We could not turn that into spending limits we can sign, so please set the limits by hand.',
        }
      : {}),
  })
}

/**
 * Re-validate every constraint of a compiled mandate locally.
 *
 * This is the whole of §8.8's "Every field is a proposal" rule as far as this package is concerned:
 * `l2/prepare` re-validates too, but by then the user has already read a read-back they believed. A
 * defect found here can be reported while the consent screen is still open.
 *
 * It is also the boundary for constraints this process did not build from a proposal — the manual
 * constraint form, a row restored from the database, a future caller. `validateConstraints` takes a
 * `VIConstraint[]` that TypeScript has already blessed, and TypeScript does not check that an amount is
 * non-negative or that `budget.max` is above zero. So **rule 0 re-parses every constraint through
 * {@link viConstraintSchema}**: the types are a promise about shape, not a guarantee about values.
 *
 * The rules, and why each one is a refusal rather than a correction:
 *
 * 0. **The shape and value domains hold** — re-parsed through the schema. This is what catches a negative
 *    amount or a zero budget from a caller that did not go through `localiseProposal`.
 * 1. **Currency must match the mandate** — correcting it would be a silent FX conversion (EC-FX-1).
 * 2. **`amount_range` needs at least one bound** — a range with neither constrains nothing while
 *    *looking* like a limit, which is the worst of both.
 * 3. **`min` ≤ `max`** on both money constraints.
 * 4. **`budget.max` ≥ `amount_range.max`** when both exist. A cumulative cap below a single-payment cap
 *    is self-contradictory: no permitted payment could ever be made. Raising the budget would grant
 *    authority the user never asked for, so it is refused.
 * 5. **`budget.max` > 0** — the library raises on this; see {@link budgetConstraintSchema}.
 * 6. **No cap above the literal cap, and no cap at all without one** (AT-M8.5). The second half is the
 *    one that closes the worst hole: if the request contains no amount at all and the model still
 *    proposes one, the number has no basis in anything the buyer typed. Accepting it would put a
 *    limit in the read-back that the buyer never wrote, which is §18 question 46 happening. Refusing
 *    sends them to the manual form, where the number is theirs.
 * 7. **`recurrence` and `agent_recurrence` need `end_date` ≥ `start_date`.**
 * 8. **`mandate.payment.reference` is never allowed** (module header).
 *
 * @returns `ok` with the same array when every rule holds; `err` with the **first** violation, whose
 *   `details.path` points at the offending constraint.
 */
export function validateConstraints(
  constraints: readonly VIConstraint[],
  ctx: ConstraintValidationContext,
): Result<VIConstraint[]> {
  const range = constraintOfType(constraints, 'mandate.payment.amount_range')

  // Rule 0. The types are not a guarantee about values: an amount can be negative and a budget can be
  // zero, and neither is a TypeScript error.
  for (const c of constraints) {
    const reparsed = viConstraintSchema.safeParse(c)
    if (reparsed.success) continue
    // The first issue's path names the offending field, so `details.path` points at
    // `constraints.mandate.payment.budget.max` rather than at the whole constraint. A caller that wants to
    // highlight one row of a constraint table can.
    const first = reparsed.error.issues[0]
    const field = first?.path.length === 0 ? c.type : `${c.type}.${first?.path.join('.') ?? ''}`
    return err(
      defect(
        `The constraint ${c.type} is not valid: ${reparsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        { path: `constraints.${field}`, issues: reparsed.error.issues },
        ctx,
      ),
    )
  }

  for (const c of constraints) {
    if (c.type === 'mandate.payment.reference') {
      return err(
        defect('mandate.payment.reference must not be supplied by the compiler', {
          path: 'constraints',
          ec: 'SPEC-8.8',
          reason: 'the signing service generates it from the checkout disclosure hash',
        }, ctx),
      )
    }

    if (c.type === 'mandate.payment.amount_range' || c.type === 'mandate.payment.budget') {
      if (c.currency !== ctx.mandateCurrency) {
        return err(
          defect(
            `A ${c.type} in ${c.currency} cannot be part of a ${ctx.mandateCurrency} mandate. ` +
              'Countersign never converts between currencies: FX rates are not covered by your signature (EC-FX-1).',
            {
              path: `constraints.${c.type}.currency`,
              declared: c.currency,
              mandate: ctx.mandateCurrency,
              ec: 'EC-FX-1',
            },
            ctx,
          ),
        )
      }
    }

    if (c.type === 'mandate.payment.amount_range') {
      if (c.min === undefined && c.max === undefined) {
        return err(
          defect(
            'mandate.payment.amount_range needs a minimum, a maximum, or both. With neither it ' +
              'restricts nothing while still reading like a limit.',
            { path: 'constraints.mandate.payment.amount_range' },
            ctx,
          ),
        )
      }
      if (c.min !== undefined && c.max !== undefined && c.min > c.max) {
        return err(
          defect('amount_range minimum must not exceed its maximum', {
            path: 'constraints.mandate.payment.amount_range.min',
            min: c.min.toString(),
            max: c.max.toString(),
          }, ctx),
        )
      }
    }

    if (c.type === 'mandate.payment.budget') {
      if (c.max <= 0n) {
        return err(
          defect(
            'mandate.payment.budget.max must be greater than zero. A zero or negative total cap ' +
              'would block every payment the moment it was signed.',
            { path: 'constraints.mandate.payment.budget.max', max: c.max.toString() },
            ctx,
          ),
        )
      }
      if (c.min !== undefined && c.min > c.max) {
        return err(
          defect('budget minimum must not exceed its maximum', {
            path: 'constraints.mandate.payment.budget.min',
            min: c.min.toString(),
            max: c.max.toString(),
          }, ctx),
        )
      }
      if (range?.max !== undefined && c.max < range.max) {
        return err(
          defect(
            `The total budget (${c.max.toString()} minor units) is below the per-payment cap ` +
              `(${range.max.toString()}), so no permitted payment could ever be made.`,
            {
              path: 'constraints.mandate.payment.budget.max',
              budgetMax: c.max.toString(),
              amountMax: range.max.toString(),
            },
            ctx,
          ),
        )
      }
    }

    if (
      (c.type === 'mandate.payment.recurrence' || c.type === 'mandate.payment.agent_recurrence')
    ) {
      // `end_date` is optional on `recurrence` and required on `agent_recurrence`; on this union it
      // reads as `string | undefined`, which is exactly the check both shapes want.
      const end = c.end_date
      if (end !== undefined && end < c.start_date) {
        return err(
          defect('A recurrence window must not end before it starts', {
            path: `constraints.${c.type}.end_date`,
            start_date: c.start_date,
            end_date: end,
          }, ctx),
        )
      }
    }
  }

  for (const c of constraints) {
    if (c.type !== 'mandate.payment.amount_range' && c.type !== 'mandate.payment.budget') continue
    // Only an upper bound is authority. A `min` restricts the agent further, so an unsupported one is
    // harmless in the same way a slightly-too-strict setting is.
    const cap = c.type === 'mandate.payment.amount_range' ? c.max : c.max
    if (cap === undefined) continue
    if (ctx.literalCap === null) {
      return err(
        defect(
          `A spending limit of ${cap.toString()} minor units was proposed, but the request does not contain ` +
            'an amount to support it. A limit that is not in your words cannot be presented to you as yours, ' +
            'so please enter the amount by hand.',
          { path: `constraints.${c.type}.max`, proposed: cap.toString(), ec: 'AT-M8.5' },
          ctx,
        ),
      )
    }
    if (cap > ctx.literalCap) {
      return err(
        defect(
          `That limit (${cap.toString()} minor units) is larger than the largest amount you wrote ` +
            `(${ctx.literalCap.toString()}). A limit is only ever taken from the words you typed, so ` +
            'this answer cannot be signed.',
          {
            path: `constraints.${c.type}.max`,
            proposed: cap.toString(),
            literalCap: ctx.literalCap.toString(),
            ec: 'AT-M8.5',
          },
          ctx,
        ),
      )
    }
  }

  return ok([...constraints])
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Convert every `bigint` in a constraint to a JSON integer, refusing to round.
 *
 * `JSON.stringify` throws on a `bigint`, and an integer past `Number.MAX_SAFE_INTEGER` has already lost
 * precision by the time it becomes a JSON number — so an out-of-range amount is an error here, not a
 * number that happens to be wrong. This is the only place a `bigint` becomes a `number`, and it lives
 * beside the schemas so nobody writes a second one.
 */
export function toJsonSafe(value: unknown, path = 'constraint'): unknown {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw csError('CS_VALIDATION', `Amount at ${path} exceeds the safe integer range and cannot be sent as JSON`, {
        path,
      })
    }
    return jsonInteger(value)
  }
  if (Array.isArray(value)) return value.map((v, i) => toJsonSafe(v, `${path}[${i}]`))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v, `${path}.${k}`)
    return out
  }
  return value
}

function jsonInteger(v: bigint): number {
  return Number(v)
}

/** The `to_dict()`-shaped JSON for one constraint, with `bigint` amounts as JSON integers. */
export function constraintToJson(c: VIConstraint): Record<string, unknown> {
  return toJsonSafe(c, c.type) as Record<string, unknown>
}

/**
 * Minor-digit count for a currency, re-exported so `readback.ts` and `proposal.ts` do not each reach
 * into core for it. `0` for JPY, `2` for everything else we support.
 */
export function minorDigitsOf(c: Currency): 0 | 2 {
  return MINOR_DIGITS[c]
}

