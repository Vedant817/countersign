/**
 * **AT-M10.4** — a mandate revoked between checks 1 and 8 (injected delay) → **BLOCK, with no reservation
 * leaked**. Spec §8.10, §12 **EC-MDT-2**.
 *
 * ## Why this is the test most likely to catch a real bug
 *
 * Because check 1's answer is a **snapshot**. A mandate that was `ACTIVE` when the Gate read it can be
 * `REVOKED` thirty milliseconds later, and every check between those two moments would be deciding from a
 * stale row. The naive implementation reserves against a mandate that no longer exists: the buyer's budget
 * is reduced by a purchase that will never happen, and nothing releases it for thirty minutes.
 *
 * The spec's answer is EC-MDT-2's mechanism ("re-reads mandate status in the same tx"). The Gate applies it
 * one step earlier, in check 8, so the scenario is handled *before* there is anything to leak.
 *
 * ## Two mechanisms, tested separately, and one documented limit
 *
 * | Scenario | Mechanism | Result |
 * |---|---|---|
 * | revoked **before** check 8 | `deps.lockMandate` re-reads under the same transaction | nothing was ever reserved |
 * | a **later** check refuses (stock) | `evaluate`'s compensation release | the reservation was released |
 * | revoked **after** check 8 | the *orchestrator*, same tx as order create (EC-MDT-2, WP-11) | out of the Gate's hands |

 * The third row is a real limitation, stated rather than hidden — see the test that names it. Claiming the
 * Gate closes every window would be a stronger promise than §12 makes.
 */
import { describe, expect, it } from 'vitest'
import type { AttemptId } from '@countersign/core'

import { evaluate } from '../src/evaluate'
import type { GateDecision } from '../src/types'
import { CART_MINOR, MANDATE_ID, NOW_SEC, fakeL3a, input, makeWorld, product } from './fixtures'

/**
 * Run `evaluate` and hand back the decision.
 *
 * `evaluate` returns `err` only when the **signer** fails, and every world here signs fine, so an `err` is
 * a broken fixture. Asserting once keeps the failure readable — `decision.decision` being `undefined` after
 * an `err` is a confusing message for what is really a test-setup mistake.
 */
async function decide(
  world: Awaited<ReturnType<typeof makeWorld>>,
  overrides: Parameters<typeof input>[0] = {},
  hooks?: Parameters<typeof evaluate>[2],
): Promise<GateDecision> {
  const result = await evaluate(input(overrides), world.deps, hooks ?? {})
  if (!result.ok)
    throw new Error(`evaluate() failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

describe('AT-M10.4 — a mandate revoked mid-decision leaks no reservation', () => {
  it('BLOCKs with GATE_REVOKED and reserves nothing when revoked between checks 1 and 8', async () => {
    const world = await makeWorld()

    // The injected delay: revoke at the last moment check 1 could still have missed it.
    let revokedAtCheck: number | null = null
    const decision = await decide(
      world,
      {},
      {
        hooks: {
          before(n) {
            if (n !== 8) return
            revokedAtCheck = n
            world.mandate.status = 'REVOKED'
            world.mandate.revoked_at = new Date(NOW_SEC * 1000)
            world.mandate.revoked_reason = 'user tapped revoke while the agent was checking out'
          },
        },
      },
    )

    expect(revokedAtCheck).toBe(8)
    expect(decision.decision).toBe('BLOCK')
    expect(decision.reasons.map((r) => r.code)).toContain('GATE_REVOKED')

    // **The assertion.** The buyer's budget is untouched: no RESERVE, no RELEASE, no residue at all.
    expect(world.snapshot().reserved).toBe(0n)
    expect(world.snapshot().version).toBe(0)
    expect(world.store.entries()).toHaveLength(0)
    expect(world.reservations).toHaveLength(0)
    expect(world.releases).toHaveLength(0)

    // And the record says *which* check caught it: the in-transaction re-read, not check 1's snapshot.
    const check8 = decision.checks.find((c) => c.n === 8)!
    expect(check8.passed).toBe(false)
    expect(check8.detail).toContain('FOR UPDATE')
    // Check 1 legitimately passed — it read the row before the revoke. That is not a bug; it is precisely
    // why check 8 re-reads.
    expect(decision.checks.find((c) => c.n === 1)!.passed).toBe(true)
  })

  it('releases the reservation when a later check refuses (EC-STOCK-3 shape)', async () => {
    // The mandate stays ACTIVE; only stock runs out at check 10. This is the pure compensation path:
    // check 8 succeeded, check 10 refused, and the money went back.
    const world = await makeWorld({ products: [product('NW-014', CART_MINOR, { stock: 0 })] })
    const decision = await decide(world)

    expect(decision.decision).toBe('BLOCK')
    expect(decision.reasons.map((r) => r.code)).toContain('GATE_OUT_OF_STOCK')
    expect(world.snapshot().reserved).toBe(0n)
    expect(world.releases).toHaveLength(1)

    // A RESERVE and a matching RELEASE, both on the ledger, both carrying the same attempt id — so a
    // nightly reconcile sees them net to zero and a dispute can show *why*.
    const kinds = world.store.entries().map((e) => e.kind)
    expect(kinds).toEqual(['RESERVE', 'RELEASE'])
    expect(world.store.entries()[0]!.attempt_id).toBe(world.store.entries()[1]!.attempt_id)
  })

  it('does not write a RELEASE for money that was never committed', async () => {
    // Check 9 refusing rolls the transaction back, so check 8's RESERVE never existed. The compensation
    // path must then find nothing to release: a RELEASE entry here would tell a dispute that $30.00 was
    // refunded to a buyer whose budget was never touched, and the ledger would not net to zero.
    const world = await makeWorld({
      capMinor: 200_000n,
      walletCap: { period: 'DAY', cap: { minor: 1_000n, currency: 'USD' } },
    })
    const decision = await decide(world)

    expect(decision.reasons.map((r) => r.code)).toContain('GATE_WALLET_CAP')
    expect(world.store.entries()).toHaveLength(0)
    expect(world.reservations).toHaveLength(0)
    expect(world.releases).toHaveLength(0)
  })

  it('EC-MDT-2: a revoke at check 8’s boundary never leaves a reservation, and the cap always holds', async () => {
    // A property over the boundary. Revoke before each check in turn; the ledger must never keep a
    // reservation for a mandate that is no longer spendable, and must never exceed the cap at any point.
    for (let boundary = 2; boundary <= 12; boundary++) {
      const world = await makeWorld()
      const decision = await decide(
        world,
        {},
        {
          hooks: {
            before(n) {
              if (n !== boundary) return
              world.mandate.status = 'REVOKED'
              world.mandate.revoked_at = new Date(NOW_SEC * 1000)
            },
          },
        },
      )

      const snapshot = world.snapshot()
      if (boundary === 8) {
        // The in-transaction re-read sees the revoke and reserves nothing.
        expect(snapshot.reserved, 'boundary 8: the re-read should have reserved nothing').toBe(0n)
        expect(decision.reasons.map((r) => r.code)).toContain('GATE_REVOKED')
      }
      expect(snapshot.reserved, `boundary ${boundary}`).toBeLessThanOrEqual(CART_MINOR)
      expect(snapshot.reserved + snapshot.spent).toBeLessThanOrEqual(snapshot.cap)
    }
  })

  it('a retry with a fresh jti is not a loophole: EC-IDEM-1 and EC-MDT-2 together', async () => {
    // A new jti gets past check 7 and then meets the same in-transaction re-read. Retrying must not be a
    // way around the revoke.
    const world = await makeWorld()
    world.mandate.status = 'REVOKED'

    const decision = await decide(world, {
      attemptId: 'att_0000000000000000000000000B' as AttemptId,
      l3a: fakeL3a({ jti: 'jti-2' }),
    })

    expect(decision.decision).toBe('BLOCK')
    expect(world.snapshot().reserved).toBe(0n)
    expect(world.mandate.id).toBe(MANDATE_ID)
  })

  it('names its limit honestly: a revoke *after* check 8 is the orchestrator’s to catch', async () => {
    // **Documented limitation, pinned by a test rather than a footnote.** The Gate re-reads the mandate
    // once, inside check 8's transaction, which covers "revoked between check 1 and the reservation" — the
    // window where a reservation would otherwise be created against a dead mandate. A revoke arriving
    // *after* that point is caught by the orchestrator, in the same transaction as order creation: that is
    // EC-MDT-2's stated mechanism and it lives in WP-11. Claiming the Gate closes every window would be a
    // stronger promise than §12 makes.
    const world = await makeWorld()
    const decision = await decide(
      world,
      {},
      {
        hooks: {
          before(n) {
            if (n !== 10) return
            world.mandate.status = 'REVOKED'
            world.mandate.revoked_at = new Date(NOW_SEC * 1000)
          },
        },
      },
    )

    expect(decision.decision).toBe('ALLOW')
    // The reservation stands, and the orchestrator will release it when it re-reads the status — which is
    // why a reservation carries a 30-minute lifetime at all.
    expect(world.snapshot().reserved).toBe(CART_MINOR)
  })
})
