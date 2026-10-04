/**
 * **AT-M10.2** — a 20-way concurrent attempt race on a $100.00 budget with $30.00 carts → **exactly 3
 * ALLOW**. Spec §8.10, decision **D19**, §12 **EC-MA-1**.
 *
 * ## Why this test exists at all
 *
 * Because without it, nothing else in the Gate proves the money cannot be overspent. Every other check
 * *reads* a row; check 8 *writes* one, and a read-modify-write is where a payments system loses money.
 *
 * ## Why the number is 3
 *
 * `floor(10000 / 3000) = 3`. Three reservations take the budget to $90.00; a fourth would take it to
 * $120.00 and is refused. The number is not a tuning parameter, and a test asserting "at most 3" or "some
 * ALLOWs" would be asserting something far weaker than §8.10 does.
 *
 * ## How `FOR UPDATE` is modelled
 *
 * `createInMemoryBudgetStore` (see `deps.ts`) holds a promise **chain** per mandate:
 *
 * ```ts
 * lockBudgetAccount(id) → serialise(`acct:${id}`, () => readRow())
 * ```
 *
 * Each waiter awaits the previous holder's entire critical section, which is what `SELECT … FOR UPDATE`
 * guarantees — the lock is held to the end of the transaction. The load-bearing consequence is that the
 * waiter **re-reads after** the holder's `updateBudgetAccount`, so it sees `reserved = 9000` rather than
 * the stale `0` it would have seen under `READ COMMITTED` without the lock. That single difference is the
 * whole test: without the lock all twenty read `0` and all twenty write `3000`, and a $100 budget authorises
 * $600.
 *
 * ### The rendezvous, and why it is not optional
 *
 * Without a barrier, JavaScript's microtask scheduling lets the first reserver run to completion before the
 * others are even scheduled — the test would then report "1 ALLOW" and pass for entirely the wrong reason,
 * and a Gate with **no lock at all** would also pass it. `lockLog()` records `queuedBehind: 1` for the
 * waiters, which is the observable proof that real contention happened.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { money } from '@countersign/core'
import type { AttemptId, MandateId } from '@countersign/core'
import type { BudgetAccountRow } from '@countersign/db'

import { createInMemoryBudgetStore } from '../src/deps'
import { evaluate } from '../src/evaluate'
import { CART_MINOR, MANDATE_ID, NOW_SEC, WALLET_ID, input, makeWorld, product } from './fixtures'

/** $100.00, in minor units. The spec's own numbers. */
const BUDGET_MINOR = 10_000n
const RACERS = 20

type World = Awaited<ReturnType<typeof makeWorld>>

/** Enough stock for every racer: this file is about the budget; EC-STOCK-3's race is in `checks.test.ts`. */
const PLENTY = product('NW-001', CART_MINOR, { stock: RACERS })

describe('AT-M10.2 — a 20-way concurrent race yields exactly 3 ALLOWs', () => {
  it('lets exactly 3 of 20 concurrent $30.00 carts through a $100.00 budget', async () => {
    const world = await makeWorld({ capMinor: BUDGET_MINOR, products: [PLENTY] })

    const decisions = await Promise.all(
      Array.from({ length: RACERS }, (_, i) => evaluate(inputFor(world, i), world.deps)),
    )
    for (const d of decisions) if (!d.ok) throw new Error(d.error.message)

    const allows = decisions.filter((d) => d.ok && d.value.decision === 'ALLOW')
    const blocks = decisions.filter((d) => d.ok && d.value.decision !== 'ALLOW')

    expect(allows).toHaveLength(3)
    expect(blocks).toHaveLength(RACERS - 3)

    // The decisive assertion, and it is two-part. Three reservations totalling exactly the cap's floor
    // proves both that the right number got through **and** that none was over-charged. `reserved <= cap`
    // alone would also hold if the Gate had allowed nothing at all.
    expect(world.snapshot().reserved).toBe(3n * CART_MINOR)
    expect(world.snapshot().reserved + world.snapshot().spent).toBeLessThanOrEqual(BUDGET_MINOR)

    // Every refusal is `GATE_BUDGET_EXCEEDED` with the numbers in the message — the copy a buyer reads.
    for (const b of blocks) {
      if (!b.ok) continue
      const reason = b.value.reasons.find((r) => r.code === 'GATE_BUDGET_EXCEEDED')
      expect(
        reason,
        `a BLOCK without GATE_BUDGET_EXCEEDED: ${JSON.stringify(b.value.reasons.map((r) => r.code))}`,
      ).toBeDefined()
      expect(reason!.message).toContain('10000')
    }

    // Exactly three RESERVE entries and no RELEASEs: nothing reserved was later refused.
    expect(world.store.entries().filter((e) => e.kind === 'RESERVE')).toHaveLength(3)
    expect(world.store.entries().filter((e) => e.kind === 'RELEASE')).toHaveLength(0)
    expect(world.releases).toHaveLength(0)
  })

  it('proves the lock was actually contended: nineteen of twenty waited on it', async () => {
    // If nothing queued, the twenty attempts ran one after another and the count of 3 would be measuring
    // sequentialism. `lockLog()` is the observable that distinguishes the two.
    const world = await makeWorld({ capMinor: BUDGET_MINOR, products: [PLENTY] })
    const store = world.store
    const barrier = createBarrier(RACERS)

    // Rebuild the store's deps with a rendezvous *inside* `lockBudgetAccount`, so all twenty are queued
    // before any of them reads.
    const contending: typeof store = {
      ...store,
      async lockBudgetAccount(id) {
        await barrier.arrive()
        return store.lockBudgetAccount(id)
      },
    }

    await Promise.all(
      Array.from({ length: RACERS }, (_, i) =>
        evaluate(inputFor(world, i), { ...world.deps, budget: contending }),
      ),
    )

    const log = store.lockLog()
    expect(log).toHaveLength(RACERS)
    expect(log.filter((l) => l.queuedBehind === 1).length).toBeGreaterThanOrEqual(RACERS - 1)
  })

  it('without the lock the same world would authorise all twenty — so the lock is what produces the 3', async () => {
    // The control that gives the number meaning. A store whose reads do **not** serialise lets every racer
    // read `reserved = 0` and every one write `3000`: a $100 budget authorising $600.
    //
    // This is the failure `packages/db/repos/budget.ts` opens with — "why every mutation takes FOR UPDATE" —
    // reproduced as an executable claim. A test that only asserts the good outcome cannot distinguish "the
    // lock works" from "the arithmetic was never exercised", and this is what tells the two apart.
    const unlocked = createInMemoryBudgetStore({
      accounts: [account(MANDATE_ID, BUDGET_MINOR)],
      serialiseLocks: false,
      // The barrier is what makes this a *lost update* rather than a lucky schedule: all twenty racers
      // arrive before any of them reads, so all twenty read `reserved = 0`. Without it, JavaScript's
      // microtask ordering happens to interleave enough to make the naive store look fine.
      onLockAcquired: createBarrier(RACERS).arrive,
    })
    const world = await makeWorld({ capMinor: BUDGET_MINOR, products: [PLENTY] })

    // Same Gate, same twenty inputs; only the store's locking differs.
    const decisions = await Promise.all(
      Array.from({ length: RACERS }, (_, i) =>
        evaluate(inputFor(world, i), {
          ...world.deps,
          budget: unlocked,
          transaction: noTransaction,
        }),
      ),
    )
    const allowed = decisions.filter((d) => d.ok && d.value.decision === 'ALLOW')

    // **All twenty.** Under `READ COMMITTED` with no lock, every racer reads `reserved = 0`, sees
    // `3000 + 0 + 0 <= 10000`, and writes `reserved = 3000`. A $100.00 budget authorised $600.00.
    expect(allowed).toHaveLength(RACERS)

    // And the stored balance does not even reveal it: each writer clobbered the others, so the row says
    // $30.00 while twenty attempts were approved. That is worse than a wrong total — the ledger *looks*
    // right, which is exactly why the lock rather than a CHECK constraint is the mechanism.
    const snapshot = unlocked.accounts().get(MANDATE_ID)!
    expect(snapshot.reserved_minor).toBe(CART_MINOR)
    expect(BigInt(allowed.length) * CART_MINOR).toBeGreaterThan(snapshot.cap_minor)
  })

  it('is a property: for any cap and cart size, reservations are exactly floor(cap / cart)', async () => {
    // The stronger, general claim: AT-M10.2's "exactly 3" is one instance of "never more than
    // `floor(cap / cart)`, ever", under any interleaving. `fast-check` picks the sizes; the store supplies
    // the interleaving; the invariant is checked after every run.
    await fc.assert(
      fc.asyncProperty(
        // Cap 1×…20× a fixed unit, so the range includes "nothing fits" (1×) and "everything fits".
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 8 }),
        async (capUnits, cartUnits) => {
          const cap = BigInt(capUnits) * 500n
          const cart = BigInt(cartUnits) * 100n
          const racers = 12

          const world = await makeWorld({
            capMinor: cap,
            products: [product('NW-001', cart, { stock: racers })],
            cartMinor: cart,
          })

          await Promise.all(
            Array.from({ length: racers }, (_, i) =>
              evaluate(inputFor(world, i, cart), world.deps),
            ),
          )

          const snapshot = world.snapshot()
          // Both halves matter. `reserved <= cap` alone also holds if nothing was allowed;
          // the exact-equality alone holds trivially at cap = 0.
          expect(snapshot.reserved % cart).toBe(0n)
          expect(snapshot.reserved).toBeLessThanOrEqual(cap)
          expect(Number(snapshot.reserved / cart)).toBe(
            Math.min(Math.floor(Number(cap / cart)), racers),
          )
        },
      ),
      { numRuns: 40 },
    )
  })

  it('EC-MA-1: the wallet cap binds across mandates, and counts each cart exactly once', async () => {
    // The wallet cap is a **different row** from either mandate's budget, so the two checks need different
    // locks and the same discipline. $2,000 per mandate, $150.00 on the wallet, $30.00 carts.
    //
    // The wallet is therefore the only binding constraint, and the answer is arithmetic:
    // `floor(15000 / 3000) = 5`. Eight would pass if check 9 were per-mandate; **four** would pass if
    // the current attempt were counted twice, which is the bug D-021 records. So this one number rules
    // out both wrong implementations, and it is five that is correct.
    //
    // (An earlier version of this test asserted four and reasoned that "six would pass if the wallet cap
    // double-counted nothing". Both numbers were wrong: six came from reading the per-mandate cap as
    // $100 when the fixture sets it to $2000. A test written from a mistaken derivation looks exactly
    // like a test written from a correct one, which is why the arithmetic is now shown here.)
    const secondMandate = 'mdt_0000000000000000000000000B' as MandateId
    const world = await makeWorld({
      capMinor: 200_000n,
      products: [PLENTY],
      walletCap: { period: 'DAY', cap: money(15_000n, 'USD') },
      extraMandates: [{ id: secondMandate, cap: money(200_000n, 'USD') }],
    })

    const decisions = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => evaluate(inputFor(world, i), world.deps)),
      ...Array.from({ length: 4 }, (_, i) =>
        evaluate({ ...inputFor(world, 100 + i), mandateId: secondMandate }, world.deps),
      ),
    ])

    const allowed = decisions.filter((d) => d.ok && d.value.decision === 'ALLOW')
    expect(allowed).toHaveLength(5)

    // Every refusal is the wallet's, not a mandate's own budget: neither mandate is near its own cap.
    for (const d of decisions) {
      if (!d.ok || d.value.decision === 'ALLOW') continue
      expect(d.value.reasons.map((r) => r.code)).toContain('GATE_WALLET_CAP')
    }
  })

  it('EC-MA-1 D-021 the wallet cap counts the current attempt exactly once', async () => {
    // Regression test for a double-count found here and fixed in `packages/db`.
    //
    // Spec §8.10 fixes check 9 *after* check 8, and check 8 inserts this attempt's RESERVE inside the
    // same transaction. `walletSpendInPeriod` sums `budget_entries`, so before the fix the current cart
    // appeared once in the ledger and once via `amount` — making the effective wallet cap
    // `cap − cart`. A $150.00 cap with $30.00 carts allowed 4 reservations instead of 5.
    //
    // The number below is the *intent*, not the observed behaviour: `floor(15000 / 3000) = 5`. It was
    // written as 4 with a note that a fix would turn it green, which is a good way to record a finding
    // you cannot yet fix — but a test that expects a bug is a test that will outlive the bug report.
    // This asserts the correct answer, so the bug cannot come back unnoticed.
    const secondMandate = 'mdt_0000000000000000000000000B' as MandateId
    const world = await makeWorld({
      // Roomy per-mandate caps on purpose. With a tight one, check 8 binds before check 9 and this
      // test would be measuring the mandate budget rather than the double-count this is about.
      capMinor: 200_000n,
      products: [PLENTY],
      walletCap: { period: 'DAY', cap: money(15_000n, 'USD') },
      extraMandates: [{ id: secondMandate, cap: money(200_000n, 'USD') }],
    })

    const decisions = await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => evaluate(inputFor(world, i), world.deps)),
      ...Array.from({ length: 8 }, (_, i) =>
        evaluate({ ...inputFor(world, 100 + i), mandateId: secondMandate }, world.deps),
      ),
    ])

    const allowed = decisions.filter((d) => d.ok && d.value.decision === 'ALLOW')
    // floor(15000 / 3000) = 5, not 4. The 6th cart is refused because 5 × 3000 = 15000 = the cap.
    expect(allowed).toHaveLength(5)

    // And the refusal must be the wallet cap, not a budget cap on either mandate: the per-mandate
    // caps here are far higher than the cart, so only the wallet limit can bind.
    const blocked = decisions.filter((d) => d.ok && d.value.decision === 'BLOCK')
    expect(blocked.length).toBeGreaterThan(0)
    for (const d of blocked) {
      if (!d.ok) continue
      expect(d.value.reasons.map((r) => r.code)).toContain('GATE_WALLET_CAP')
    }

    // The wallet must never be oversubscribed, which is the property the cap exists to protect.
    // `ledgerSpend` is read with no exclusion, so it is the true total across all mandates.
    const ledgerSpend = await world.deps.budget.walletSpendInPeriod(
      WALLET_ID,
      'USD',
      'DAY',
      new Date(NOW_SEC * 1000),
    )
    expect(ledgerSpend).toBe(5n * CART_MINOR)
    expect(ledgerSpend).toBeLessThanOrEqual(15_000n)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * A `GateInput` for racer `i`: distinct attempt id, distinct `jti`, distinct amount.
 *
 * All three are needed. A shared `jti` would have check 7 refuse every racer after the first with
 * `GATE_REPLAY` — a legitimate BLOCK, but one that measures replay protection rather than the budget. A
 * shared amount would have check 6 refuse any racer whose cart differs from the session's locked total.
 */
function inputFor(world: World, i: number, amountMinor: bigint = CART_MINOR) {
  const base = input()
  return {
    ...base,
    attemptId: `att_${String(i).padStart(26, '0')}` as AttemptId,
    l3a: l3a({ jti: `race-${i}`, amount_minor: Number(amountMinor) }),
  }
}

function l3a(claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', kid: 'agent-key-1', typ: 'JWT' }),
    'utf8',
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      amount_minor: Number(CART_MINOR),
      currency: 'USD',
      payee_id: 'MERCHANT_NORTHWIND',
      aud: 'https://merchant.example',
      iat: NOW_SEC - 5,
      exp: NOW_SEC + 295,
      ...claims,
    }),
    'utf8',
  ).toString('base64url')
  return `${header}.${payload}.${Buffer.from('unsigned', 'utf8').toString('base64url')}`
}

function account(mandateId: MandateId, capMinor: bigint): BudgetAccountRow {
  return {
    mandate_id: mandateId,
    currency: 'USD',
    cap_minor: capMinor,
    reserved_minor: 0n,
    spent_minor: 0n,
    version: 0,
    created_at: new Date(NOW_SEC * 1000),
    updated_at: new Date(NOW_SEC * 1000),
  }
}

/**
 * A transaction that commits unconditionally.
 *
 * Only the no-lock control needs one: with two racers able to read the same `reserved = 0`, there is
 * nothing meaningful to roll back, and a rollback would hide the very overspend being demonstrated.
 */
const noTransaction = async <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
  fn({ rolledBack: false, rollback: () => {} } as unknown as never)

/**
 * A one-shot barrier: `count` arrivals release everyone at once.
 *
 * Without it the first reserver can finish before the others are scheduled, and a Gate with no lock at all
 * would pass this file. The barrier is what turns "twenty promises in a loop" into twenty genuinely
 * concurrent attempts.
 */
function createBarrier(count: number): { arrive(): Promise<void> } {
  let arrived = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    async arrive() {
      arrived += 1
      if (arrived >= count) release()
      await gate
    },
  }
}
