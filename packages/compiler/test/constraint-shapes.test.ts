/**
 * Constraint shapes, checked against the library's own output — spec §8.8, AT-M8.4, WP-08.
 *
 * `apps/vi/tests/constraint_shapes.json` is a **pytest-generated** fixture: every entry is the real
 * `to_dict()` output of one of the pinned Verifiable Intent library's eight constraint classes, read off
 * the library at runtime at commit `356c2963…`. §8.8's first rule is that field names "MUST be taken from"
 * that file, and this is the test that makes the rule enforceable.
 *
 * ### What is checked, and what each check would have caught
 *
 * | Check | The failure it prevents |
 * |---|---|
 * | `__meta__` agrees with our exported lists (currencies, frequencies, vi_lib_commit, network-enforced set) | A compiler accepting a currency or a frequency the service rejects. |
 * | The fixture's eight keys are exactly `CONSTRAINT_TYPES`, in order | A ninth type invented here, or one missing. vi would reject the unknown one at `l2/prepare`. |
 * | Every entry parses through `viConstraintSchema` | A type whose shape we got wrong. |
 * | Parsed keys === fixture keys, exactly | A `.default(null)` adding a key `to_dict()` never emits, or a schema silently dropping one. Either way the round-trip stops being faithful. |
 * | Declared keys ⊇ fixture keys | A library field we do not model — the dangerous direction, because we would drop it and the constraint would mean something narrower than it appears. |
 * | Required declared keys ⊆ fixture keys | A field we made **required** that the library leaves optional. Every real constraint would then fail to parse. |
 * | Declared keys === **vi-client's** declared keys, all eight | The only total check. Two schemas written by different work packages from the same Python file either agree or one of them is wrong, and the disagreement is visible in a test rather than in production. |
 * | `mandate.payment.reference` is refused by both | The compiler emitting a constraint the service generates itself. |
 * | Every other entry round-trips through **vi-client's** `constraintSchema` | What the compiler emits must be what the client will send. |
 * | Money fields come out `bigint` | EC-FX-5 / EC-FX-6: a float anywhere near an amount. |
 *
 * The vi-client imports are by relative path, not a workspace dependency: this touches no file outside
 * `packages/compiler`, and if the import ever stops resolving the file fails loudly rather than skipping —
 * a silently skipped cross-package contract check is worse than no check.
 */

import { readFileSync } from 'node:fs'
import { VI_LIB_COMMIT } from '@countersign/core'
import { describe, expect, it } from 'vitest'

import {
  CONSTRAINT_TYPES,
  ISO_20022_FREQUENCIES,
  NETWORK_ENFORCED_CONSTRAINT_TYPES,
  acceptableItemSchema,
  agentRecurrenceConstraintSchema,
  allowedMerchantsConstraintSchema,
  allowedPayeesConstraintSchema,
  amountRangeConstraintSchema,
  budgetConstraintSchema,
  currencySchema,
  lineItemRequirementSchema,
  lineItemsConstraintSchema,
  matchModeSchema,
  merchantRefSchema,
  recurrenceConstraintSchema,
  viConstraintSchema,
  type VIConstraint,
} from '../src/index'

import {
  CONSTRAINT_TYPES as VI_CLIENT_CONSTRAINT_TYPES,
  agentRecurrenceConstraintSchema as viClientAgentRecurrence,
  allowedMerchantsConstraintSchema as viClientAllowedMerchants,
  allowedPayeesConstraintSchema as viClientAllowedPayees,
  amountRangeConstraintSchema as viClientAmountRange,
  budgetConstraintSchema as viClientBudget,
  constraintSchema as viClientConstraintSchema,
  currencySchema as viClientCurrencySchema,
  lineItemRequirementSchema as viClientLineItemRequirement,
  lineItemsConstraintSchema as viClientLineItems,
  merchantRefSchema as viClientMerchantRef,
  recurrenceConstraintSchema as viClientRecurrence,
  referenceConstraintSchema as viClientReference,
} from '../../vi-client/src/types'

interface FixtureMeta {
  readonly count: number
  readonly currencies: readonly string[]
  readonly iso_20022_frequencies: readonly string[]
  readonly network_enforced_not_checked_by_library: readonly string[]
  readonly reference_is_generated_by_the_service: readonly string[]
  readonly source: string
  readonly vi_lib_commit: string
}

const FIXTURE_URL = new URL('../../../apps/vi/tests/constraint_shapes.json', import.meta.url)
const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as Record<string, unknown>
const meta = fixture['__meta__'] as FixtureMeta

/** The fixture's constraint entries, `__meta__` removed, in `CONSTRAINT_TYPES` order. */
function entries(): Array<{ type: string; shape: Record<string, unknown> }> {
  return [...CONSTRAINT_TYPES]
    .filter((type) => fixture[type] !== undefined)
    .map((type) => ({ type, shape: fixture[type] as Record<string, unknown> }))
}

/**
 * The field names a zod schema declares, read from its `def.shape`.
 *
 * Introspection rather than a hand-written table: the point is to compare the schema to the library, and
 * a table written by the same person who wrote the schema would only prove the table agrees with itself.
 */
function declaredKeys(schema: unknown): string[] {
  const shape = (schema as { def?: { shape?: Record<string, unknown> } }).def?.shape
  if (shape === undefined) throw new Error('schema has no def.shape; it is not a plain object schema')
  return Object.keys(shape).sort()
}

/** Field names a schema *requires* (has no default and is not optional). */
function requiredKeys(schema: unknown): string[] {
  const shape = (schema as { def?: { shape?: Record<string, unknown> } }).def?.shape
  if (shape === undefined) throw new Error('schema has no def.shape')
  return Object.entries(shape)
    .filter(([, def]) => {
      const d = def as { type?: string; innerType?: { type?: string }; defaultValue?: unknown }
      if (d.type === 'optional' || d.type === 'default' || d.type === 'prefault') return false
      if (d.innerType?.type === 'optional' || d.innerType?.type === 'default') return false
      return d.defaultValue === undefined
    })
    .map(([key]) => key)
    .sort()
}

/** The union member for a type tag, taken from the discriminated union's own option list. */
function optionFor(type: string): unknown {
  const def = (viConstraintSchema as unknown as { def: { options: unknown[] } }).def
  for (const option of def.options) {
    const shape = (option as { def?: { shape?: Record<string, { value?: unknown }> } }).def?.shape
    if ((shape?.['type'] as { value?: unknown } | undefined)?.value === type) return option
  }
  throw new Error(`no union member for ${type}`)
}

describe('constraint shapes vs apps/vi/tests/constraint_shapes.json (spec §8.8, [B3])', () => {
  it('pins the library commit the fixture was captured from', () => {
    expect(meta.vi_lib_commit).toBe(VI_LIB_COMMIT)
    expect(meta.source).toContain('constraints.py')
  })

  it('the fixture holds exactly eight constraints, in our order', () => {
    expect(meta.count).toBe(8)
    expect(entries().map((e) => e.type)).toEqual([...CONSTRAINT_TYPES])
  })

  it('__meta__ currencies match what vi accepts and what core supports', () => {
    expect([...meta.currencies].sort()).toEqual(['AUD', 'CAD', 'EUR', 'GBP', 'INR', 'JPY', 'USD'])
    expect([...currencySchema.options].sort()).toEqual([...meta.currencies].sort())
    expect([...viClientCurrencySchema.options].sort()).toEqual([...meta.currencies].sort())
  })

  it('__meta__ frequencies match ISO_20022_FREQUENCIES, element for element', () => {
    expect([...meta.iso_20022_frequencies]).toEqual([...ISO_20022_FREQUENCIES])
  })

  it('__meta__ names exactly the three constraints the library does not check (spec D19)', () => {
    const named = [...meta.network_enforced_not_checked_by_library].sort()
    expect([...NETWORK_ENFORCED_CONSTRAINT_TYPES].sort()).toEqual(named)
    expect(named).toEqual([
      'mandate.payment.agent_recurrence',
      'mandate.payment.budget',
      'mandate.payment.recurrence',
    ])
  })

  describe.each(entries().filter((e) => e.type !== 'mandate.payment.reference'))(
    '$type',
    ({ type, shape }) => {
      it('parses through viConstraintSchema', () => {
        const parsed = viConstraintSchema.safeParse(shape)
        if (!parsed.success) {
          throw new Error(
            `failed to parse: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          )
        }
        expect(parsed.success).toBe(true)
      })

      it('parsing preserves the field set exactly — nothing added, nothing dropped', () => {
        const parsed = viConstraintSchema.parse(shape) as Record<string, unknown>
        expect(Object.keys(parsed).sort()).toEqual(Object.keys(shape).sort())
      })

      it('declares every field to_dict() emitted (a library field we do not model is a silent drop)', () => {
        const declared = declaredKeys(optionFor(type))
        for (const key of Object.keys(shape)) expect(declared, `${type}.${key}`).toContain(key)
      })

      it('requires nothing to_dict() omitted (an over-required field would fail every real constraint)', () => {
        const present = Object.keys(shape)
        for (const key of requiredKeys(optionFor(type))) {
          expect(present, `${type}.${key} is required by our schema and present in to_dict()`).toContain(key)
        }
      })

      it('nested entry keys match the library too', () => {
        const allowed = shape['allowed']
        if (Array.isArray(allowed)) {
          for (const entry of allowed) {
            expect(Object.keys(entry as object).sort()).toEqual(declaredKeys(merchantRefSchema).sort())
            expect(Object.keys(entry as object).sort()).toEqual(declaredKeys(viClientMerchantRef).sort())
          }
        }
        const items = shape['items']
        if (Array.isArray(items)) {
          for (const item of items) {
            expect(Object.keys(item as object).sort()).toEqual(declaredKeys(lineItemRequirementSchema).sort())
            expect(Object.keys(item as object).sort()).toEqual(declaredKeys(viClientLineItemRequirement).sort())
            const acceptable = (item as { acceptable_items?: unknown }).acceptable_items
            if (Array.isArray(acceptable)) {
              for (const entry of acceptable) {
                expect(Object.keys(entry as object).sort()).toEqual(declaredKeys(acceptableItemSchema).sort())
              }
            }
          }
        }
      })

      it('the amount constraints carry integer minor units, never a float (EC-FX-5, EC-FX-6)', () => {
        if (type !== 'mandate.payment.amount_range' && type !== 'mandate.payment.budget') return
        const parsed = viConstraintSchema.parse(shape) as Extract<
          VIConstraint,
          { type: 'mandate.payment.amount_range' | 'mandate.payment.budget' }
        >
        for (const value of [parsed.min, parsed.max]) {
          if (value === undefined) continue
          expect(typeof value).toBe('bigint')
        }
      })

      it('is accepted by packages/vi-client, which is what actually sends it', () => {
        const json = JSON.parse(JSON.stringify(shape)) as unknown
        const viaClient = viClientConstraintSchema.safeParse(json)
        if (!viaClient.success) throw new Error(`vi-client rejected it: ${JSON.stringify(viaClient.error.issues)}`)
        expect(viaClient.success).toBe(true)
      })
    },
  )

  describe('mandate.payment.reference', () => {
    const shape = fixture['mandate.payment.reference'] as Record<string, unknown>

    it('the fixture shows the field the library generates', () => {
      expect(Object.keys(shape).sort()).toEqual(['conditional_transaction_id', 'type'])
    })

    it('our schema still declares the generated field, so the drift test can see it', () => {
      // vi-client declares only `{type}` here, because it refuses every instance and has no reason to
      // model the payload. The compiler is checked against the *fixture* instead: a compiler that dropped
      // `conditional_transaction_id` from its schema would have lost sight of a field the library emits.
      expect(declaredKeys(optionFor('mandate.payment.reference'))).toEqual([
        'conditional_transaction_id',
        'type',
      ])
      expect(declaredKeys(viClientReference)).toEqual(['type'])
    })

    it('our schema refuses it, because the service must generate it', () => {
      const parsed = viConstraintSchema.safeParse(shape)
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(parsed.error.issues.map((i) => i.message).join(' ')).toContain('must never be supplied')
      }
    })

    it('vi-client refuses it too, so the two agree on why', () => {
      expect(viClientConstraintSchema.safeParse(shape).success).toBe(false)
    })
  })

  it('our eight type tags are the same eight vi-client knows, in the same order', () => {
    expect([...CONSTRAINT_TYPES]).toEqual([...VI_CLIENT_CONSTRAINT_TYPES])
  })

  it('both packages declare exactly the same fields for the seven types that carry constraints', () => {
    // `reference` is excluded and checked separately: vi-client declares `{type}` only, because it
    // refuses every instance, and demanding agreement there would be demanding agreement about a
    // deliberate difference rather than about the library.
    const pairs: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ['mandate.checkout.allowed_merchants', allowedMerchantsConstraintSchema, viClientAllowedMerchants],
      ['mandate.checkout.line_items', lineItemsConstraintSchema, viClientLineItems],
      ['mandate.payment.allowed_payees', allowedPayeesConstraintSchema, viClientAllowedPayees],
      ['mandate.payment.amount_range', amountRangeConstraintSchema, viClientAmountRange],
      ['mandate.payment.budget', budgetConstraintSchema, viClientBudget],
      ['mandate.payment.recurrence', recurrenceConstraintSchema, viClientRecurrence],
      ['mandate.payment.agent_recurrence', agentRecurrenceConstraintSchema, viClientAgentRecurrence],
    ]
    for (const [type, ours, theirs] of pairs) {
      expect(declaredKeys(ours), type).toEqual(declaredKeys(theirs))
      expect(requiredKeys(ours), type).toEqual(requiredKeys(theirs))
    }
  })

  it('both packages accept the same match_mode values, and reject the same wrong ones', () => {
    expect([...matchModeSchema.options]).toEqual(['minimum', 'exact'])
    const base = {
      type: 'mandate.checkout.line_items',
      items: [{ id: 'line-item-1', acceptable_items: [{ id: 'SKU-TRAIL-42', title: 'Trail Runner' }], quantity: 1 }],
    }
    for (const mode of ['minimum', 'exact']) {
      expect(lineItemsConstraintSchema.safeParse({ ...base, match_mode: mode }).success, mode).toBe(true)
      expect(viClientLineItems.safeParse({ ...base, match_mode: mode }).success, mode).toBe(true)
    }
    for (const mode of ['sideways', 'MINIMUM', 'Minimum']) {
      expect(lineItemsConstraintSchema.safeParse({ ...base, match_mode: mode }).success, mode).toBe(false)
      expect(viClientLineItems.safeParse({ ...base, match_mode: mode }).success, mode).toBe(false)
    }
  })

  it('the union has exactly one member per type tag', () => {
    const def = (viConstraintSchema as unknown as { def: { options: unknown[] } }).def
    expect(def.options).toHaveLength(CONSTRAINT_TYPES.length)
    const tags = def.options.map((o) => {
      const shape = (o as { def?: { shape?: Record<string, { value?: unknown }> } }).def?.shape
      return String((shape?.['type'] as { value?: unknown } | undefined)?.value)
    })
    expect(new Set(tags).size).toBe(CONSTRAINT_TYPES.length)
  })
})
