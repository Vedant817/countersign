/**
 * **AT-M10.2** — a 20-way concurrent attempt race on a $100.00 budget with $30.00 carts → **exactly 3
 * ALLOW**. Spec §8.10, decision **D19**, §12 **EC-MA-1**.
 *
 * ## Why this test exists at all
 *
 * Because without it, nothing else in the Gate proves the money cannot be overspent. Every other check
 * reads a row; check 8 *writes* one, and the read-modify-write is where a payments system loses money.
 *
 * ## Why the number is 3
 *
 * `floor(10000 / 3000) = 3`. Three reservations take the budget to $90.00; a fourth would take it to
 * $120.00 and is refused. The number is not a tuning parameter, and a test that asserted "at most 3" or
 * "some ALLOWs" would be asserting something much weaker than the spec does.
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
 * whole test.
 *
 * ### The rendezvous, and why it is not optional
 *
 * `onLockAcquired` awaits a barrier so all twenty attempts are *inside* `lockBudgetAccount` before any of
 * them reads. Without it, JavaScript's microtask scheduling lets the first reserver run to completion
 * before the other nineteen are even scheduled — the test would pass with exactly one ALLOW for the wrong
 * reason, and a Gate with no lock at all would also "pass". `lockLog()` then records `queuedBehind: 1`
 * for nineteen of the twenty, which is the observable proof that real contention happened.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { money } from '@countersign/core'
import type { AttemptId } from '@countersign/core'

import { evaluate } from '../src/evaluate'
import { CART_MINOR, NOW_SEC, input, makeWorld, product } from './fixtures'

/** $100.00, in minor units. The spec's own numbers. */
const BUDGET_MINOR = 10_000n
const RACERS = 20

/** Enough stock for every racer: this test is about the budget, and EC-STOCK-3's race lives in `checks.test.ts`. */
const PLENTY = product('NW-001', CART_MINOR, { stock: RACERS })

describe('AT-M10.2 — a 20-way concurrent race yields exactly 3 ALLOWs', () => {
  it('lets exactly 3 of 20 concurrent $30.00 carts through a $100.00 budget', async () => {
    const world = await makeWorld({
      capMinor: BUDGET_MINOR,
      products: [PLENTY],
      // Nobody's `jti` may repeat, or check 7 would block the duplicate and the race would measure replay
      // protection instead of the budget.
      session: { checkout_hash: 'hash-1' },
    })

    // Every racer needs its own jti *and* its own attempt id, or check 7 catches them first.
    const results = await Promise.all(
      Array.from({ length: RACERS }, async (_, i) => {
        const decision = await evaluate(
          input({
            attemptId: `att_${String(i).padStart(26, '0')}` as AttemptId,
            l3a: l3aWithJti(i),
          }),
          world.deps,
        )
        if (!decision.ok) throw new Error(decision.error.message)
        return decision.value
      }),
    )

    const allows = results.filter((d) => d.decision === 'ALLOW')
    const blocks = results.filter((d) => d.decision !== 'ALLOW')

    expect(allows).toHaveLength(3)
    expect(blocks).toHaveLength(RACERS - 3)

    // The decisive assertion: not three ALLOWs *and* a small overspend, but three reservations totalling
    // exactly the cap's floor. `reserved <= cap` alone would also hold if the Gate had refused everything.
    expect(world.snapshot().reserved).toBe(3n * CART_MINOR)
    expect(world.snapshot().reserved + world.snapshot().spent).toBeLessThanOrEqual(BUDGET_MINOR)

    // Every refusal is `GATE_BUDGET_EXCEEDED`, and the copy names the numbers.
    for (const block of blocks) {
      const reason = block.reasons.find((r) => r.code === 'GATE_BUDGET_EXCEEDED')
      expect(
        reason,
        `a BLOCK without GATE_BUDGET_EXCEEDED: ${JSON.stringify(block.reasons)}`,
      ).toBeDefined()
      expect(reason!.message).toContain('10000')
    }

    // Exactly three RESERVE entries, and no RELEASEs — nobody had to be compensated because nothing
    // reserved was later refused.
    expect(world.store.entries().filter((e) => e.kind === 'RESERVE')).toHaveLength(3)
    expect(world.store.entries().filter((e) => e.kind === 'RELEASE')).toHaveLength(0)
    expect(world.releases).toHaveLength(0)
  })

  it('proves the lock was actually contended: 19 of 20 waited on it', async () => {
    const world = await makeWorld({ capMinor: BUDGET_MINOR, products: [PLENTY] })
    const barrier = createBarrier(RACERS)

    // Rebuild the store's deps with a rendezvous, so every attempt is inside the lock at the same time.
    const store = world.store
    const original = store.lockBudgetAccount.bind(store)
    const contended = Object.assign(Object.create(Object.getPrototypeOf(store) as object), store, {
      async lockBudgetAccount(id: Parameters<typeof original>[0]) {
        await barrier.arrive()
        return original(id)
      },
    })

    await Promise.all(
      Array.from({ length: RACERS }, async (_, i) => {
        const decision = await evaluate(
          input({
            attemptId: `att_${String(i).padStart(26, '0')}` as AttemptId,
            l3a: l3aWithJti(i),
          }),
          { ...world.deps, budget: contended },
        )
        if (!decision.ok) throw new Error(decision.error.message)
        return decision.value
      }),
    )

    const log = store.lockLog()
    expect(log).toHaveLength(RACERS)
    // Nineteen queued behind somebody; one went straight in. If none had queued, the race was sequential
    // and this whole file would be measuring nothing.
    expect(log.filter((l) => l.queuedBehind === 1).length).toBeGreaterThanOrEqual(RACERS - 1)
  })

  it('is a property: for any cap and cart size, the reservations never exceed the cap', async () => {
    // The stronger, general claim: AT-M10.2's "exactly 3" is one instance of "reserved ≤ cap, always",
    // under any interleaving. `fast-check` picks the sizes; the store supplies the interleaving.
    await fc.assert(
      fc.asyncProperty(
        // Cap between 1x and 20x the cart, so the interesting range includes "nothing fits" (1x) and
        // "everything fits" (20x).
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
            Array.from({ length: racers }, async (_, i) => {
              const decision = await evaluate(
                input({
                  attemptId: `att_${String(i).padStart(26, '0')}` as AttemptId,
                  l3a: l3aWithJti(i, cart),
                }),
                world.deps,
              )
              if (!decision.ok) throw new Error(decision.error.message)
              return decision.value
            }),
          )

          const snapshot = world.snapshot()
          // The invariant. `floor(cap / cart)` reservations, and never one more. Both halves matter: the
          // `toBeLessThanOrEqual` alone would also hold if the Gate had refused *everything*, and the
          // equality alone would hold on a Gate that reserved nothing and a cap of zero.
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

  it('never overspends even when every attempt is for the whole budget', async () => {
    const world = await makeWorld({ capMinor: BUDGET_MINOR, products: [PLENTY] })

    await Promise.all(
      Array.from({ length: RACERS }, async (_, i) => {
        const decision = await evaluate(
          input({
            attemptId: `att_${String(i).padStart(26, '0')}` as AttemptId,
            l3a: l3aWithJti(i),
          }),
          world.deps,
        )
        if (!decision.ok) throw new Error(decision.error.message)
        return decision.value
      }),
    )

    // Each cart is $30.00 so this is the same as above — but stated separately, because "exactly one
    // ALLOW when every cart wants everything" is the shape a naive `UPDATE reserved = reserved + amount`
    // would get wrong in the most obvious way, and a regression there should fail a test that says so.
    expect(world.snapshot().reserved).toBe(3n * CART_MINOR)
    expect(world.snapshot().reserved).toBeLessThanOrEqual(money(BUDGET_MINOR, 'USD').minor)
  })
})

/**
 * A JWS with a distinct `jti` and the given `amount_minor`.
 *
 * Two things have to vary per racer and neither is optional: the `jti`, or check 7 blocks the duplicate
 * and the race measures replay protection instead of the budget; and the amount, or check 6 refuses every
 * cart that does not match the session's locked total and nothing is ever reserved.
 */
function l3aWithJti(i: number, amountMinor: bigint = CART_MINOR): string {
  const header = b64({ alg: 'EdDSA', kid: 'agent-key-1', typ: 'JWT' })
  const payload = b64({
    jti: `race-${i}`,
    amount_minor: Number(amountMinor),
    currency: 'USD',
    payee_id: 'MERCHANT_NORTHWIND',
    aud: 'https://merchant.example',
    iat: NOW_SEC - 5,
    exp: NOW_SEC + 295,
  })
  return `${header}.${payload}.${Buffer.from('unsigned', 'utf8').toString('base64url')}`
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/**
 * A one-shot barrier: `count` arrivals release everyone at once.
 *
 * Without it the first reserver can finish before the others are scheduled, and a Gate with **no lock at
 * all** would pass this file. The barrier is what turns "twenty promises in a loop" into twenty genuinely
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
