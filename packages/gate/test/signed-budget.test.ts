/**
 * **QA-gate-1 and QA-gate-2**, the two D19 findings that mattered, asserted as tests.
 *
 * ## What was wrong
 *
 * | | Before | The decision |
 * |---|---|---|
 * | **QA-gate-1** | A signed L2 capped total spend at **$20.00**. `budget_accounts.cap_minor` said **$200.00**. The cart was **$30.00**. | **`ALLOW`**, with check 8 reporting `reserved 3000/20000 USD` |
 * | **QA-gate-2** | A signed `recurrence MNTH number:1`. `mandates.constraints` was empty. Two commits in the window. | **`ALLOW`**, with check 11 reporting `passed: false, notApplicable: true` and the detail *"the signed L2 discloses no recurrence constraint"* — false |
 *
 * Both failures have the same root: the Gate was reading **our own columns** where it should have read
 * **the buyer's signature**. Spec D19 makes the Gate the enforcer of `budget`, `recurrence` and
 * `agent_recurrence` precisely because nobody else is, so "the Gate looked at a cache" and "the Gate
 * enforced the buyer's limit" are the same sentence in this system. They were not the same sentence.
 *
 * ## The rule this file pins
 *
 * **The signed constraint is authoritative; our column is at best a cache; where they disagree the
 * smaller limit binds.** `signed-constraints.ts` explains why `min` and not "prefer the token": both are
 * limits the buyer agreed to, and a Gate that enforced the looser of two real limits is the only one a
 * buyer could call "you spent more than I agreed to".
 *
 * ## The numbers are the spec's and the repro's
 *
 * The QA engineer's cart was 3000 minor units, the signed ceiling 2000, the account cap 20000. Every test
 * below names those numbers in its title and repeats them in its failure message, because a regression
 * here is silent, irreversible, and reads as a green test suite right up until it does not.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { evaluate } from '../src/evaluate'
import type { GateDecision } from '../src/types'
import {
  CART_MINOR,
  CAP_MINOR,
  DATE_AFTER,
  DATE_BEFORE,
  NOW_SEC,
  disclosed,
  fakeL3a,
  input,
  makeWorld,
  product,
  recurrenceConstraint,
  viSkipsBudget,
  viSkipsBudgetButDisclosesNoCeiling,
} from './fixtures'

/** $20.00 — the signed ceiling in QA-gate-1. */
const SIGNED_CEILING_MINOR = 2_000n
/** $200.00 — the `budget_accounts.cap_minor` in QA-gate-1, ten times the signature. */
const ACCOUNT_CAP_MINOR = 20_000n

type World = Awaited<ReturnType<typeof makeWorld>>

async function decide(world: World, over: Parameters<typeof input>[0] = {}): Promise<GateDecision> {
  const result = await evaluate(input(over), world.deps)
  if (!result.ok)
    throw new Error(`evaluate() failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/**
 * Decide a world whose cart is not the fixture default.
 *
 * `input()`'s default L3a carries `amount_minor: 3000`, and check 6 cross-checks that claim against the
 * session's locked total. Any world built with a different `cartMinor` therefore needs an L3a carrying the
 * same number, or check 6 refuses first and every assertion about check 8 is measuring the wrong check.
 */
async function decideCart(world: World, cart: bigint): Promise<GateDecision> {
  return decide(world, { l3a: fakeL3a({ amount_minor: Number(cart) }) })
}

function row(d: GateDecision, n: number) {
  const found = d.checks.find((c) => c.n === n)
  if (!found) throw new Error(`no check ${n} in the decision`)
  return found
}

function codes(d: GateDecision): string[] {
  return d.reasons.map((r) => r.code)
}

/* ------------------------------------------------------------------------------------------ */
/* 1 — The QA repro                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * **QA-gate-1, verbatim.** A $20.00 signed budget, a $30.00 cart, a $200.00 `budget_accounts` cap → BLOCK.
 *
 * This is the single most important test in the package. Before the fix it returned `ALLOW` with
 * `check 8 = {passed: true, detail: "reserved 3000/20000 USD …"}` while the very same decision record
 * carried `pendingNetworkEnforcement: ["mandate.payment.budget"]` — the obligation recorded, and treated
 * as information rather than as a precondition.
 *
 * The three numbers are deliberately different from each other. `signed = 2000 < cart = 3000` is what the
 * buyer refused; `account = 20000 > cart = 3000` is the cached cap that said yes. A test where the two
 * agree could not tell the two readings apart.
 */
describe('QA-gate-1 — the signed budget binds, not the budget_accounts column', () => {
  it('EC-AGT-1: signed $20.00 budget + $30.00 cart + $200.00 account cap → BLOCK, never ALLOW', async () => {
    const world = await makeWorld({
      // The $200.00 cached cap that used to be the only cap the Gate consulted.
      capMinor: ACCOUNT_CAP_MINOR,
      // The $20.00 ceiling, in the token, with vi reporting it as network-enforced (D19).
      verify: viSkipsBudget(SIGNED_CEILING_MINOR),
    })

    const decision = await decide(world)

    expect(
      decision.decision,
      `QA-gate-1: a signed ceiling of ${SIGNED_CEILING_MINOR} against a ${CART_MINOR} cart must BLOCK; ` +
        `the Gate returned ${decision.decision} (check 8: ${row(decision, 8).detail})`,
    ).toBe('BLOCK')

    // The refusal is about the buyer's money, in the buyer's currency, with the reason code §8.10 assigns.
    expect(codes(decision)).toContain('GATE_BUDGET_EXCEEDED')
    expect(row(decision, 8).passed).toBe(false)

    // And nothing was reserved or captured. `ctx.state.reservation` is deliberately not set on this path,
    // so `evaluate`'s compensation has nothing to release and the transaction's ROLLBACK undoes the write.
    expect(world.snapshot().reserved).toBe(0n)
    expect(world.store.entries()).toHaveLength(0)
    expect(world.reservations).toEqual([])
    expect(world.releases).toEqual([])
  })

  it('the refusal names the SIGNED ceiling, so a dispute can tell the signature from the cache', async () => {
    const world = await makeWorld({
      capMinor: ACCOUNT_CAP_MINOR,
      verify: viSkipsBudget(SIGNED_CEILING_MINOR),
    })

    const detail = row(await decide(world), 8).detail!

    // The binding source is named, and both numbers appear, so a reader of the signed record is told
    // *which* limit stopped the purchase rather than just that some limit did.
    expect(detail).toContain('signed L2')
    expect(detail).toContain('budget_accounts.cap_minor')
    expect(detail).toContain(String(SIGNED_CEILING_MINOR))
    expect(detail).toContain(String(ACCOUNT_CAP_MINOR))
  })

  it('the buyer-facing copy names the limit they signed, not the one in our table', async () => {
    const world = await makeWorld({
      capMinor: ACCOUNT_CAP_MINOR,
      verify: viSkipsBudget(SIGNED_CEILING_MINOR),
    })

    const reason = (await decide(world)).reasons.find((r) => r.code === 'GATE_BUDGET_EXCEEDED')!

    expect(reason.userMessage).toContain('$20.00')
    expect(reason.userMessage).toContain('nothing was charged')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 2 — The tighter cap                                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * The other direction: the **account** cap is the tighter one, and it must still bind.
 *
 * Signed $200.00, `budget_accounts` $20.00, cart $30.00 → BLOCK. A fix that simply "prefers the token"
 * would ALLOW this, which is the mirror-image failure: the buyer asked for a $20.00 cap somewhere and we
 * spent $30.00 because the signature was looser. `min` is the only reading that survives both directions.
 */
describe('QA-gate-1b — the tighter of the two limits binds, whichever it is', () => {
  it('EC-MA-1: signed $200.00 + account cap $20.00 + $30.00 cart → BLOCK on the account cap', async () => {
    const world = await makeWorld({
      capMinor: SIGNED_CEILING_MINOR, // $20.00 in `budget_accounts`
      verify: viSkipsBudget(ACCOUNT_CAP_MINOR), // $200.00 in the token
    })

    const decision = await decide(world)
    const detail = row(decision, 8).detail!

    expect(decision.decision).toBe('BLOCK')
    expect(codes(decision)).toContain('GATE_BUDGET_EXCEEDED')
    // The detail says **which** cap bound. `bound by` is the phrase both directions share, so an
    // assertion on it catches a swap between "the token stopped it" and "the column stopped it".
    expect(detail).toContain('bound by')
    expect(detail).toContain('budget_accounts.cap_minor')
    expect(detail).not.toContain('effective cap bound by the signed L2')
    expect(world.snapshot().reserved).toBe(0n)
  })

  it('a cart under *both* ceilings ALLOWs, and names the token as the binding limit', async () => {
    // The control for the two BLOCK cases above. Without it, "always BLOCK" would satisfy them. The cart
    // is $10.00: under the signed $20.00 **and** under the cached $50.00, so neither limit has anything to
    // say about this purchase and the decision has to be ALLOW.
    const cart = 1_000n
    const world = await makeWorld({
      cartMinor: cart,
      capMinor: 5_000n, // $50.00 cached
      products: [product('NW-001', cart, { stock: 5 })],
      verify: viSkipsBudget(SIGNED_CEILING_MINOR), // $20.00 signed
    })

    const decision = await decideCart(world, cart)

    expect(decision.decision).toBe('ALLOW')
    expect(row(decision, 8).passed).toBe(true)
    // The $20.00 is the tighter one here, and it is the one the reserve was measured against — so the
    // allowance the buyer actually signed is what a reader of the record sees next to the reserved figure.
    const detail = row(decision, 8).detail!
    expect(detail).toContain(`reserved ${cart}/${SIGNED_CEILING_MINOR}`)
    expect(detail).toContain('effective cap bound by the signed L2')
    expect(world.snapshot().reserved).toBe(cart)
  })

  it('EC-FX-1: a signed ceiling in another currency is refused, never converted', async () => {
    // EC-FX-1: "a user-signed ₹ limit silently becoming a $ spend is exactly what the signature was
    // supposed to prevent". `checkCapCurrencies` runs before any comparison, so this is a refusal rather
    // than a conversion and rather than a comparison of two numbers that mean different things.
    const world = await makeWorld({
      capMinor: CAP_MINOR,
      verify: viSkipsBudget(SIGNED_CEILING_MINOR, 'EUR'),
    })

    const decision = await decide(world)

    expect(decision.decision).toBe('BLOCK')
    expect(codes(decision)).toContain('CS_CURRENCY_MISMATCH')
    expect(world.snapshot().reserved).toBe(0n)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 3 — Recurrence from the signature                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * **QA-gate-2.** A signed `recurrence MNTH number:1`, two commits in the window, our column empty.
 *
 * The old check read only `mandates.constraints`, found nothing, and reported `notApplicable: true` with
 * the detail *"the signed L2 discloses no recurrence constraint"* — a false statement about the token,
 * on a row that `evaluate.ts::resolveOutcome` treats as **non-blocking**. So the Gate failed open on a
 * limit the buyer had signed, and the record said it had nothing to enforce.
 *
 * The second half of each pair is the control: the same state with the column *mirroring* the signature.
 * Both must BLOCK. If only the first did, the passing control would prove the column was doing the work
 * and the signature was decoration — which is the bug in a form that looks fixed.
 */
describe('QA-gate-2 — recurrence is read from the signature, and the detail says so', () => {
  /** Two COMMITs inside the monthly window, one day and two days ago. */
  const twoCommits = [{ atMs: (NOW_SEC - 86_400) * 1000 }, { atMs: (NOW_SEC - 172_800) * 1000 }]
  const signedWindow = recurrenceConstraint({ number: 1 })

  it('EC-MA-1: signed recurrence MNTH number:1, column empty, 2 commits → BLOCK from the token', async () => {
    const world = await makeWorld({
      // Our cache says nothing. The signature says "once a month".
      mandate: { constraints: [] },
      commits: twoCommits,
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: [{ type: 'mandate.payment.recurrence', reason: 'network-enforced' }],
        },
        disclosed: disclosed([signedWindow]),
      },
    })

    const decision = await decide(world)
    const detail = row(decision, 11).detail!

    expect(decision.decision).toBe('BLOCK')
    expect(codes(decision)).toContain('VI_CONSTRAINT_VIOLATION')
    // The row must NOT be `notApplicable`: that flag is non-blocking, and it was the mechanism by which
    // this check failed open.
    expect(row(decision, 11).notApplicable).toBeUndefined()
    // The detail says the window came out of the chain, and says so *only* about the chain.
    expect(detail).toContain('verified chain')
    expect(detail).toContain('2 in window of 1')
  })

  it('the control: same state with the column mirroring the signature → still BLOCK', async () => {
    const world = await makeWorld({
      // The cache now agrees with the token. The answer must not change, because the token is what was
      // already doing the work.
      mandate: { constraints: [signedWindow] },
      commits: twoCommits,
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: [{ type: 'mandate.payment.recurrence', reason: 'network-enforced' }],
        },
        disclosed: disclosed([signedWindow]),
      },
    })

    const decision = await decide(world)

    expect(decision.decision).toBe('BLOCK')
    expect(codes(decision)).toContain('VI_CONSTRAINT_VIOLATION')
    expect(row(decision, 11).detail).toContain('2 in window of 1')
    // Both sources are named, because they were both read.
    expect(row(decision, 11).detail).toContain('mandates.constraints')
    expect(row(decision, 11).detail).toContain('verified chain')
  })

  it('the detail never claims the signed L2 is silent while the signed L2 is the source', async () => {
    // The specific string QA-gate-2 flagged. Asserted directly so the fix cannot be undone by an
    // unrelated edit to the not-applicable branch.
    const world = await makeWorld({
      mandate: { constraints: [] },
      commits: twoCommits,
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: [{ type: 'mandate.payment.recurrence', reason: 'network-enforced' }],
        },
        disclosed: disclosed([signedWindow]),
      },
    })

    const detail = row(await decide(world), 11).detail!
    expect(detail).not.toContain('discloses no recurrence constraint')
  })

  it('the tighter window binds when our cache claims more occurrences than the signature', async () => {
    // Drift, and the direction that costs the buyer money: the signature allows one a month, our cache
    // says five. `mergeRecurrenceConstraints` keeps the smaller count.
    const world = await makeWorld({
      mandate: { constraints: [recurrenceConstraint({ number: 5 })] },
      commits: twoCommits,
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: [{ type: 'mandate.payment.recurrence', reason: 'network-enforced' }],
        },
        disclosed: disclosed([recurrenceConstraint({ number: 1 })]),
      },
    })

    const decision = await decide(world)

    expect(decision.decision).toBe('BLOCK')
    expect(row(decision, 11).detail).toContain('2 in window of 1')
  })

  it('EC-MA-1: a signed agent_recurrence is enforced from the token too, with no cache entry', async () => {
    const world = await makeWorld({
      mandate: { constraints: [] },
      commits: [{ atMs: (NOW_SEC - 3_600) * 1000 }],
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: [{ type: 'mandate.payment.agent_recurrence', reason: 'network-enforced' }],
        },
        disclosed: disclosed([
          {
            type: 'mandate.payment.agent_recurrence',
            frequency: 'DAIL',
            start_date: DATE_BEFORE,
            end_date: DATE_AFTER,
            max_occurrences: 1,
          },
        ]),
      },
    })

    const decision = await decide(world)

    expect(decision.decision).toBe('BLOCK')
    expect(codes(decision)).toContain('VI_CONSTRAINT_VIOLATION')
    expect(row(decision, 11).detail).toContain('agent_recurrence')
  })

  it('a mandate that genuinely signs no recurrence constraint is still not applicable', async () => {
    // The honest `notApplicable`, with both sources named. §8.10 says "if present" and there was nothing
    // to enforce, so this row is non-blocking by design — which is exactly why the QA-gate-2 case above
    // had to be a BLOCK rather than this.
    const world = await makeWorld({ mandate: { constraints: [] } })

    const decision = await decide(world)

    expect(decision.decision).toBe('ALLOW')
    expect(row(decision, 11).notApplicable).toBe(true)
    const detail = row(decision, 11).detail!
    expect(detail).toContain('no recurrence constraint')
    expect(detail).toContain('verified chain')
    expect(detail).toContain('mandates.constraints')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 4 — Fail closed on an unevaluable obligation                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * An obligation in `constraints.skipped` that the Gate cannot evaluate → **never** `ALLOW`.
 *
 * The three D19 constraint types are network-enforced, so `skipped` is not a warning list — it is a list
 * of promises the buyer holds that **this process** keeps. A non-empty entry the Gate did not discharge
 * means nobody enforced it, and the only two remaining outcomes are refusing or spending without it.
 * `REVIEW` was considered and rejected: §8.10's table gives no `REVIEW` for an unenforceable signed
 * budget, and a check that can be waved through is a check that eventually will be.
 */
describe('D19 — an obligation that cannot be evaluated fails closed', () => {
  it('EC-AGT-1: budget owed but unreadable → the outcome is BLOCK or REVIEW, explicitly never ALLOW', async () => {
    // `viSkipsBudgetButDisclosesNoCeiling`: vi reported the obligation and the chain discloses no
    // ceiling. The cart is a comfortable $30.00 against a $200.00 account cap, so nothing else can block
    // it — check 8's obligation guard is the only thing standing between this and an ALLOW.
    const world = await makeWorld({
      capMinor: ACCOUNT_CAP_MINOR,
      verify: viSkipsBudgetButDisclosesNoCeiling(),
    })

    const decision = await decide(world)

    // Stated as the pair the brief demands, rather than one value: the assertion that matters is that
    // `ALLOW` is not among the possibilities.
    expect(
      ['BLOCK', 'REVIEW'],
      `an unreadable network-enforced budget must not ALLOW; got ${decision.decision} ` +
        `(check 8: ${row(decision, 8).detail})`,
    ).toContain(decision.decision)
    expect(decision.decision).toBe('BLOCK')
    expect(codes(decision)).toContain('VI_CONSTRAINT_VIOLATION')

    // The reason says *why*, names the constraint, and tells the buyer nothing was charged.
    const reason = decision.reasons.find((r) => r.code === 'VI_CONSTRAINT_VIOLATION')!
    expect(reason.message).toContain('mandate.payment.budget')
    expect(reason.userMessage).toContain('Nothing was charged')

    // And the obligation is still on the record, so a dispute can see what was not enforced.
    expect(decision.pendingNetworkEnforcement).toEqual(['mandate.payment.budget'])
    // Nothing was reserved: the guard fires before a single row is written.
    expect(world.store.entries()).toHaveLength(0)
  })

  it('a budget constraint in the chain that does not parse is unreadable, not absent', async () => {
    // The failure mode a validator exists for. `max` as a string would be a `CS_VALIDATION` error at
    // vi's boundary, but a redeployed vi, a hand-rolled test double, or a truncated payload can all
    // produce it, and "we could not read it" must never mean "there was nothing to enforce".
    const world = await makeWorld({
      capMinor: ACCOUNT_CAP_MINOR,
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: [
            {
              type: 'mandate.payment.budget',
              reason: 'Network-enforced constraint. Not evaluated by verifiable_intent.',
            },
          ],
        },
        disclosed: disclosed([
          { type: 'mandate.payment.budget', currency: 'USD', max: '2000', min: null },
        ]),
      },
    })

    const decision = await decide(world)

    expect(decision.decision).toBe('BLOCK')
    expect(decision.reasons.map((r) => r.code)).toContain('VI_CONSTRAINT_VIOLATION')
    expect(world.snapshot().reserved).toBe(0n)
  })

  it('two budget constraints in different currencies are refused rather than one of them chosen', async () => {
    // Picking one would pick the looser half the time. Refusing is the only answer that cannot be
    // accused of spending more than the user agreed to.
    const world = await makeWorld({
      capMinor: ACCOUNT_CAP_MINOR,
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: [
            {
              type: 'mandate.payment.budget',
              reason: 'Network-enforced constraint. Not evaluated by verifiable_intent.',
            },
          ],
        },
        disclosed: disclosed([
          { type: 'mandate.payment.budget', currency: 'USD', max: 20_000, min: null },
          { type: 'mandate.payment.budget', currency: 'EUR', max: 2_000, min: null },
        ]),
      },
    })

    const decision = await decide(world)

    expect(decision.decision).toBe('BLOCK')
    expect(decision.reasons.map((r) => r.code)).toContain('VI_CONSTRAINT_VIOLATION')
  })

  it('an obligation is not inherited by the check that does not own it', async () => {
    // Scoping. If check 11 also reported an unmet *budget* obligation, the signed record would carry two
    // rows for one fact — and a reader counting rows would be counting obligations twice.
    const world = await makeWorld({
      capMinor: ACCOUNT_CAP_MINOR,
      // Only the recurrence obligation, and it is satisfied.
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: [{ type: 'mandate.payment.recurrence', reason: 'network-enforced' }],
        },
        disclosed: disclosed([recurrenceConstraint({ number: 5 })]),
      },
    })

    const decision = await decide(world)

    // Check 11 passes, check 8 passes, and the single obligation is reported by the single check that
    // owns it.
    expect(decision.decision).toBe('ALLOW')
    expect(row(decision, 11).passed).toBe(true)
    expect(row(decision, 11).detail).toContain('D19 obligation discharged')
    expect(row(decision, 8).detail).not.toContain('D19 obligation')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 5 — The happy path                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * A regression suite that only proves the bug would be useless. Every case here ALLOWs, and each would
 * fail if the fix had over-corrected into refusing everything.
 */
describe('the happy path still passes', () => {
  it('EC-AGT-1: an in-budget cart under the signed ceiling ALLOWs and reserves exactly once', async () => {
    // $10.00 cart, $20.00 signed, $50.00 cached. The signed ceiling is the tighter one and the purchase
    // fits under it.
    const cart = 1_000n
    const world = await makeWorld({
      cartMinor: cart,
      capMinor: 5_000n,
      products: [product('NW-001', cart, { stock: 5 })],
      verify: viSkipsBudget(SIGNED_CEILING_MINOR),
    })

    const decision = await decideCart(world, cart)

    expect(decision.decision).toBe('ALLOW')
    expect(row(decision, 8).detail).toContain(`reserved ${cart}/${SIGNED_CEILING_MINOR}`)
    expect(world.snapshot().reserved).toBe(cart)
    expect(world.store.entries().filter((e) => e.kind === 'RESERVE')).toHaveLength(1)
    expect(world.store.entries().filter((e) => e.kind === 'RELEASE')).toHaveLength(0)
  })

  it('EC-MA-1: a mandate with no network-enforced obligation at all is untouched by the fix', async () => {
    // No `skipped`, no disclosed constraints — the shape every world had before this change. Check 8 must
    // still work off `budget_accounts.cap_minor` alone, because that is the only limit this mandate has.
    const world = await makeWorld()

    const decision = await decide(world)

    expect(decision.decision).toBe('ALLOW')
    expect(decision.pendingNetworkEnforcement).toEqual([])
    expect(row(decision, 11).notApplicable).toBe(true)
    expect(world.snapshot().reserved).toBe(CART_MINOR)
  })

  it('a signed recurrence inside its window ALLOWs', async () => {
    const world = await makeWorld({
      commits: [{ atMs: (NOW_SEC - 86_400) * 1000 }],
      verify: {
        constraints: {
          satisfied: true,
          violations: [],
          checked: [],
          skipped: [{ type: 'mandate.payment.recurrence', reason: 'network-enforced' }],
        },
        disclosed: disclosed([recurrenceConstraint({ number: 5 })]),
      },
    })

    const decision = await decide(world)

    expect(decision.decision).toBe('ALLOW')
    expect(row(decision, 11).detail).toContain('1 in window of 5')
  })

  it('exactly the boundary ALLOWs: a cart equal to the signed ceiling', async () => {
    // `>` not `>=`. A buyer who signed "up to $20.00" must be able to spend exactly $20.00, or the
    // fix has cost them the last cent they agreed to — and a test that only tried $19.99 would not know.
    const cart = SIGNED_CEILING_MINOR
    const world = await makeWorld({
      cartMinor: cart,
      capMinor: ACCOUNT_CAP_MINOR,
      products: [product('NW-001', cart, { stock: 5 })],
      verify: viSkipsBudget(SIGNED_CEILING_MINOR),
    })

    const decision = await decideCart(world, cart)

    expect(decision.decision).toBe('ALLOW')
    expect(world.snapshot().reserved).toBe(cart)
  })

  it('one minor unit over the signed ceiling BLOCKs', async () => {
    // The other side of the same boundary. Together these two are what make `>` and `>=` distinguishable.
    const cart = SIGNED_CEILING_MINOR + 1n
    const world = await makeWorld({
      cartMinor: cart,
      capMinor: ACCOUNT_CAP_MINOR,
      products: [product('NW-001', cart, { stock: 5 })],
      verify: viSkipsBudget(SIGNED_CEILING_MINOR),
    })

    const decision = await decideCart(world, cart)

    expect(decision.decision).toBe('BLOCK')
    expect(codes(decision)).toContain('GATE_BUDGET_EXCEEDED')
    expect(world.snapshot().reserved).toBe(0n)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 6 — The property                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * **The invariant, stated once:** for any signed ceiling and any cart, the Gate never allows a purchase
 * larger than the ceiling the buyer signed.
 *
 * `numRuns: 1_000`. A money bug that shows up once in a thousand attempts is still a money bug, and the
 * whole reason this is a property test rather than an example is that the example cases were chosen by
 * the person who already knew the shape of the failure. 1,000 runs puts the detection probability for a
 * 1-in-1,000 counterexample at roughly 63%, and a 1-in-10,000 one at about 10% — enough that a real
 * regression is very likely to be caught here rather than in production.
 *
 * The account cap is generated to be **always looser** than the signed ceiling, which is the whole point:
 * it removes the cached cap as a possible source of the refusal, so a BLOCK can only be attributed to the
 * signature. The cart is drawn against the signed ceiling in both directions so the property is exercised
 * on both sides of the boundary, and `stock` is raised so check 10 can never be the reason a case blocks.
 */
describe('the signed ceiling is a hard ceiling, for every ceiling and every cart', () => {
  it('EC-MA-1: never ALLOWs when the cart exceeds the signed ceiling — 1,000 random pairs', async () => {
    let refusalsByCeiling = 0

    await fc.assert(
      fc.asyncProperty(
        // The signed ceiling: $0.01 … $500.00, in whole cents.
        fc.integer({ min: 1, max: 50_000 }),
        // The cart: 1 minor unit … $1,000.00.
        fc.integer({ min: 1, max: 100_000 }),
        async (signedMinor, cartMinor) => {
          const signed = BigInt(signedMinor)
          const cart = BigInt(cartMinor)

          const world = await makeWorld({
            cartMinor: cart,
            // Always at least 10× looser than the signature, and never the reason for a refusal.
            capMinor: signed * 10n + cart * 2n,
            products: [product('NW-001', cart, { stock: 5 })],
            verify: viSkipsBudget(signed),
          })

          const decision = await decideCart(world, cart)

          if (cart > signed) {
            refusalsByCeiling++
            expect(
              decision.decision,
              `signed ceiling ${signed} < cart ${cart}: the Gate must refuse, got ${decision.decision} ` +
                `(check 8: ${row(decision, 8).detail})`,
            ).not.toBe('ALLOW')
            // And it must be refused by *check 8*, not incidentally by another check. Otherwise this
            // property would pass on a Gate that has no budget check at all.
            expect(codes(decision)).toContain('GATE_BUDGET_EXCEEDED')
            // The reservation must not have survived the refusal.
            expect(world.snapshot().reserved).toBe(0n)
          } else {
            expect(
              decision.decision,
              `signed ceiling ${signed} >= cart ${cart}: the purchase fits the signature, got ` +
                `${decision.decision} (check 8: ${row(decision, 8).detail})`,
            ).toBe('ALLOW')
            expect(world.snapshot().reserved).toBe(cart)
          }
        },
      ),
      { numRuns: 1_000 },
    )

    // If the generator never produced an over-ceiling pair the property would be vacuous — every run
    // would have been an ALLOW assertion, and "no ALLOW" would have been trivially true. Pin that the
    // over-ceiling branch was actually exercised.
    expect(refusalsByCeiling).toBeGreaterThan(100)
  })

  it('EC-MA-1: 12 concurrent carts against a signed ceiling allow exactly floor(signed / cart)', async () => {
    // The claim that makes the post-reservation comparison legitimate, and the reason it is not simply a
    // pre-check.
    //
    // A ceiling read **before** taking the lock is a ceiling read from a snapshot: every racer sees
    // `reserved = 0`, every racer sees `0 + 3000 ≤ 5000`, and all twelve reserve — $360 against a $50
    // ceiling. The comparison in `check8Budget` runs against the balance `reserveIn` computed *inside* its
    // `SELECT … FOR UPDATE`, so the fourth racer re-reads `reserved = 3000`, sees `6000 > 5000`, and is
    // refused. Exactly `floor(5000 / 3000) = 1` ALLOW.
    const signedCeiling = 5_000n
    const racers = 12
    const world = await makeWorld({
      capMinor: 10_000_000n, // ten thousand dollars: never the binding limit
      products: [product('NW-001', CART_MINOR, { stock: racers })],
      verify: viSkipsBudget(signedCeiling),
    })

    const decisions = await Promise.all(
      Array.from({ length: racers }, (_, i) =>
        evaluate(input({ attemptId: `att_racer_${i}` as never }), world.deps),
      ),
    )
    for (const d of decisions) if (!d.ok) throw new Error(d.error.message)

    const allows = decisions.filter((d) => d.ok && d.value.decision === 'ALLOW')

    expect(
      allows.length,
      `a signed ceiling of ${signedCeiling} must admit exactly ` +
        `${Number(signedCeiling / CART_MINOR)} of ${racers} concurrent ${CART_MINOR} carts; ` +
        `got ${allows.length}. A higher number means the ceiling was read outside the row lock.`,
    ).toBe(Number(signedCeiling / CART_MINOR))

    // The decisive half: nothing over-charged. `reserved <= signed` alone would also hold if the Gate had
    // allowed nothing at all.
    expect(world.snapshot().reserved).toBe(CART_MINOR)
    expect(world.snapshot().reserved).toBeLessThanOrEqual(signedCeiling)
    expect(world.store.entries().filter((e) => e.kind === 'RESERVE')).toHaveLength(allows.length)
  })

  it('EC-MA-1: the effective ceiling is the min of every source, for any three ceilings', async () => {
    // Pure, no Gate: the rule itself, checked directly. A property test on the rule *and* one on the
    // Gate is the difference between "the rule is right" and "the rule is right and it is wired in".
    const { effectiveBudgetCap } = await import('../src/signed-constraints')

    await fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        (signed, column, account) => {
          const effective = effectiveBudgetCap([
            { source: 'signed_l2', cap: { minor: signed, currency: 'USD' } },
            { source: 'mandate_column', cap: { minor: column, currency: 'USD' } },
            { source: 'account_cap', cap: { minor: account, currency: 'USD' } },
          ])
          const smallest = [signed, column, account].reduce((a, b) => (a < b ? a : b))

          expect(effective.cap.minor).toBe(smallest)
          // Whichever source attained the minimum must be the one named as binding, so the detail string
          // never credits a limit that was not the one that stopped the purchase.
          const sources = [
            { source: 'signed_l2', cap: signed },
            { source: 'mandate_column', cap: column },
            { source: 'account_cap', cap: account },
          ]
          const winners = sources.filter((s) => s.cap === smallest).map((s) => s.source)
          expect(winners).toContain(effective.boundBy)
        },
      ),
      { numRuns: 500 },
    )
  })
})
