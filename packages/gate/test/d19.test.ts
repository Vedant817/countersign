/**
 * **The D19 obligation**, asserted directly. Spec **D19**, §8.8 [B3], §8.10 checks 8 and 11,
 * docs/DECISIONS.md **D-019**.
 *
 * ## What is at stake
 *
 * The pinned Verifiable Intent library appends `mandate.payment.budget`, `.recurrence` and
 * `.agent_recurrence` to `checked` while evaluating **none** of them — its own source comment calls them
 * "network-enforced". `apps/vi` therefore moves them into `constraints.skipped`, and **checks 8, 9 and 11 of
 * this package are the entire reason a buyer's budget and recurrence limits are real.** Without them the
 * Gate would report "constraints satisfied" about caps nobody looked at, and a £1,300 budget would behave
 * like an unlimited one.
 *
 * ## The trap D-019 documents, and why it is a *type* error
 *
> `"skipped": ["mandate.payment.budget — Network-enforced constraints. Not evaluated by …"]`
>
> `skipped.includes('mandate.payment.budget')` is **`false`** — the array holds annotated strings. A Gate
> written that way concludes it owes nothing and allows the purchase, and it **fails open, in favour of
> spending**. `skippedConstraintSchema` ends in `.transform()`, so the parsed element type is
> `{type, reason}` and that mistaken `includes` does not compile.
 *
 * These tests exercise the *runtime* half of the same guarantee: `pendingNetworkEnforcement` on the raw
 * wire shapes `apps/vi` actually emits.
 */
import { describe, expect, it } from 'vitest'
import { money } from '@countersign/core'
import {
  NETWORK_ENFORCED_CONSTRAINTS,
  pendingNetworkEnforcement,
  skippedConstraintTypes,
} from '@countersign/vi-client'

import { evaluate, describeDecision, pendingObligations } from '../src/index'
import { CHECK_ORDER } from '../src/checks'
import { CART_MINOR, MANDATE_ID, NOW_SEC, input, makeWorld } from './fixtures'
import type { GateDecision } from '../src/types'

/** `verify.constraints.skipped` exactly as `apps/vi` emits it, annotated and all. */
function asViEmits(types: string[]): string[] {
  return types.map(
    (t) =>
      `${t} — Network-enforced constraints. Not evaluated by verifiable_intent; ` +
      "Countersign's Gate enforces it (spec D19). NOT satisfied by this response.",
  )
}

type World = Awaited<ReturnType<typeof makeWorld>>

/**
 * Run `evaluate` and hand back the decision.
 *
 * `evaluate` returns `err` only when the **signer** fails, so an `err` here is a broken fixture. Asserting
 * once keeps the failures readable.
 */
async function decide(world: World): Promise<GateDecision> {
  const result = await evaluate(input(), world.deps)
  if (!result.ok)
    throw new Error(`evaluate() failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

describe('pendingNetworkEnforcement over the wire shapes apps/vi emits', () => {
  it('sees the obligation in the legacy annotated-string form, where `includes` sees nothing', () => {
    const skipped = asViEmits(['mandate.payment.budget'])

    // The trap, in one line. This is what a Gate would have written.
    expect(skipped.includes('mandate.payment.budget')).toBe(false)
    // And the sanctioned read.
    expect(pendingNetworkEnforcement(skipped)).toEqual(['mandate.payment.budget'])
  })

  it('sees all three network-enforced constraints, and nothing else', () => {
    // The three annotated entries are the obligation. The fourth is a **free-form note** about an
    // evaluation that could not run — `checkout_constraint_evaluation (needs the checkout_jwt cart)` — and it
    // is not a registered constraint type. The fifth is a registered type that vi *did* evaluate, so
    // listing it under `skipped` would be a vi-service bug; it is here to prove that a *registered* name in
    // `skipped` is still filtered out unless it is network-enforced.
    const skipped = [
      ...asViEmits([
        'mandate.payment.budget',
        'mandate.payment.recurrence',
        'mandate.payment.agent_recurrence',
      ]),
      'checkout constraint evaluation (needs the checkout_jwt cart)',
      'mandate.checkout.line_items — reported for information',
    ]

    expect(pendingNetworkEnforcement(skipped)).toEqual([
      'mandate.payment.budget',
      'mandate.payment.recurrence',
      'mandate.payment.agent_recurrence',
    ])
    // `skippedConstraintTypes` is broader: it reports every *registered* type present, and the Gate's
    // obligation is the intersection with `NETWORK_ENFORCED_CONSTRAINTS`.
    expect(skippedConstraintTypes(skipped)).toEqual([
      'mandate.payment.budget',
      'mandate.payment.recurrence',
      'mandate.payment.agent_recurrence',
      'mandate.checkout.line_items',
    ])
  })

  it('accepts the object form too, so a redeployed vi-service cannot disarm the Gate', () => {
    expect(
      pendingNetworkEnforcement([
        { type: 'mandate.payment.budget', reason: 'Network-enforced. Not evaluated.' },
      ]),
    ).toEqual(['mandate.payment.budget'])
  })

  it('an empty result means none were disclosed — not that none were owed', () => {
    // The two are different facts, and the empty case is the one that gets misread. A mandate with no
    // budget constraint has nothing for check 8 to enforce; that is not the same as a budget constraint
    // having been evaluated and passed.
    expect(pendingNetworkEnforcement([])).toEqual([])
    expect(pendingNetworkEnforcement(undefined)).toEqual([])
    expect(pendingNetworkEnforcement(asViEmits(['mandate.payment.amount_range']))).toEqual([])
  })

  it('the set is exactly the three D19 names — not "whatever vi skips"', () => {
    expect([...NETWORK_ENFORCED_CONSTRAINTS].sort()).toEqual([
      'mandate.payment.agent_recurrence',
      'mandate.payment.budget',
      'mandate.payment.recurrence',
    ])
  })

  it('a note that merely *mentions* a constraint is not that constraint having been skipped', () => {
    // "Reading an old entry correctly. It has no other role." — a substring match on the pre-D-019
    // separator would report `mandate.payment.budget` as skipped for a note that says it was evaluated.
    const skipped = ['we already checked mandate.payment.budget in the previous run']
    expect(pendingNetworkEnforcement(skipped)).toEqual([])
  })
})

describe('a non-empty obligation is work, not information', () => {
  it('check 4 records it even when the chain is perfectly valid', async () => {
    const world = await makeWorld({
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: ['mandate.payment.amount_range'],
          skipped: asViEmits(['mandate.payment.budget']),
        },
      },
    })

    const decision = await decide(world)

    expect(decision.decision).toBe('ALLOW')
    // `satisfied: true` did **not** let check 8 off the hook: the reservation still happened.
    expect(decision.pendingNetworkEnforcement).toEqual(['mandate.payment.budget'])
    expect(world.snapshot().reserved).toBe(CART_MINOR)
    // And check 4's own detail says the obligation is still open.
    expect(decision.checks.find((c) => c.n === 4)!.detail).toContain(
      '1 network-enforced constraint(s) pending',
    )
  })

  it('`constraints.satisfied: true` cannot make check 8 skip the budget', async () => {
    // The failure mode, stated as a test: a Gate that read `satisfied` as covering the budget would ALLOW
    // the $999.00 cart the injection asked for, because vi would have said everything it checked was fine.
    const world = await makeWorld({
      // $20.00 cap against a $30.00 cart, so check 8 has to refuse.
      capMinor: 2_000n,
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: ['mandate.payment.amount_range'],
          skipped: asViEmits(['mandate.payment.budget']),
        },
      },
    })

    const decision = await decide(world)

    // vi said "satisfied" — and check 8 still refused, because vi never looked at the budget.
    expect(decision.reasons.map((r) => r.code)).toContain('GATE_BUDGET_EXCEEDED')
    expect(decision.checks.find((c) => c.n === 8)!.passed).toBe(false)
  })

  it('an obligation survives into the signed record, so a dispute can see it', async () => {
    const world = await makeWorld({
      signWithRealKey: true,
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: asViEmits(['mandate.payment.recurrence']),
        },
      },
    })
    const decision = await decide(world)

    // The record carries `checks_hash` over all twelve results, and the decision carries the obligation
    // list. A `RECURRENCE` row reported *not applicable* (no such constraint disclosed) alongside a
    // `recurrence` obligation is the combination a reader needs to see.
    expect(decision.pendingNetworkEnforcement).toEqual(['mandate.payment.recurrence'])
    expect(decision.checks.find((c) => c.n === 11)!.notApplicable).toBe(true)
  })
})

describe('the two halves of D19, wired to the checks that discharge them', () => {
  it('budget → check 8, recurrence → check 11, and each is enforced whether or not vi mentioned it', async () => {
    // A mandate that discloses a `recurrence` of 2 per month and already has 2 commits: vi said nothing
    // about either constraint (`skipped: []`), and both checks still fire. The obligation is not a licence
    // for the Gate to skip; the obligation is the *reason* the Gate must not skip.
    const world = await makeWorld({
      mandate: {
        constraints: [
          { type: 'mandate.payment.budget', currency: 'USD', max: 5_000 },
          {
            type: 'mandate.payment.recurrence',
            frequency: 'MNTH',
            start_date: '2025-01-01',
            number: 2,
          },
        ],
      },
      // $20.00 cap against a $30.00 cart, so the budget half has something to refuse.
      capMinor: 2_000n,
      commits: [{ atMs: (NOW_SEC - 86_400) * 1000 }, { atMs: (NOW_SEC - 172_800) * 1000 }],
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: ['mandate.payment.amount_range'],
          skipped: [],
        },
      },
    })

    const decision = await decide(world)

    const failed = decision.checks.filter((c) => !c.passed && !c.notApplicable).map((c) => c.n)
    expect(failed).toContain(8)
    expect(failed).toContain(11)
    expect(decision.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['GATE_BUDGET_EXCEEDED', 'VI_CONSTRAINT_VIOLATION']),
    )
    // Nothing was reserved: check 9 saw check 8 refuse and rolled back.
    expect(world.snapshot().reserved).toBe(0n)
  })

  it('the decision summary names every failing check, not just the first', () => {
    // §8.10's contract is "every reason is reported". A one-line summary of the first failure would be the
    // short-circuit this package exists to avoid, just moved to the presentation layer.
    const decision: GateDecision = {
      id: 'gdc_1' as GateDecision['id'],
      decision: 'BLOCK',
      reasons: [
        { code: 'GATE_BUDGET_EXCEEDED', message: 'a', userMessage: 'a' },
        { code: 'GATE_OUT_OF_STOCK', message: 'b', userMessage: 'b' },
      ],
      checks: CHECK_ORDER.map((row, i) => ({
        n: row.n,
        code: row.code,
        passed: i !== 7 && i !== 9,
        detail: i === 7 || i === 9 ? `failed: ${row.code}` : undefined,
      })),
      signedRecord: 'x',
      nowSec: NOW_SEC,
      pendingNetworkEnforcement: [],
    }

    const summary = describeDecision(decision)
    expect(summary).toContain('#8 BUDGET')
    expect(summary).toContain('#10 STOCK')
    expect(summary).not.toContain('#1 ')
  })

  it('pendingObligations is the one place a decision lists what it still owes', () => {
    // Exported so a caller building a response can surface it without re-deriving it, and so there is
    // exactly one definition of "owed". It accepts both wire shapes, because both are shapes that have been
    // on the wire.
    expect(
      pendingObligations({ constraints: { skipped: asViEmits(['mandate.payment.budget']) } }),
    ).toEqual(['mandate.payment.budget'])
    expect(
      pendingObligations({
        constraints: {
          skipped: [{ type: 'mandate.payment.recurrence', reason: 'network-enforced' }],
        },
      }),
    ).toEqual(['mandate.payment.recurrence'])
    expect(pendingObligations({ constraints: {} })).toEqual([])
  })
})

describe('AT-M10.4’s mandate identity survives the D19 path', () => {
  it('the decision record names the mandate whose limits were enforced', async () => {
    const world = await makeWorld({
      signWithRealKey: true,
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: asViEmits(['mandate.payment.budget']),
        },
      },
    })
    const decision = await decide(world)

    const payload = JSON.parse(
      Buffer.from(decision.signedRecord.split('.')[1]!, 'base64url').toString('utf8'),
    ) as { mdt: string; amount: string }
    // The budget check 8 ran was *this* mandate's budget. That is the chain from signature to spend.
    expect(payload.mdt).toBe(MANDATE_ID)
    expect(payload.amount).toBe('30.00')
    expect(money(3_000n, 'USD').minor).toBe(3_000n)
  })
})
