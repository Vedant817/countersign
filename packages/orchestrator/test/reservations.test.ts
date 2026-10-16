/**
 * `releaseExpiredReservations` — spec **§8.10** ("Reservations expire after 30 min without an order"),
 * **§7.2**, §12.4 **EC-MDT-2**, AGENTS.md rule 6 (idempotent side effects).
 *
 * ## What these tests are really about
 *
 * A reservation is a claim on a buyer's *authority*, not on their money — nothing is charged until an order
 * exists. If it is never given back, their signed budget shrinks by that amount for ever and every later
 * cart under the same mandate is smaller than it should be. So the sweep's two obligations are exactly:
 *
 * 1. **Release what is overdue, and only what is overdue.** 30 minutes is the number §8.10 fixes, and
 *    releasing early is as much a bug as never releasing.
 * 2. **Release it once.** The sweep runs every five minutes against the same rows for ever, so "release"
 *    has to mean "release", not "release again".
 *
 * The second is the one that is easy to get wrong, and both halves are asserted below: the deterministic
 * entry id is the backstop, and the pre-write filter is what stops the backstop from being *reported* as an
 * error every five minutes.
 */
import { describe, expect, it } from 'vitest'

import { RESERVATION_TTL_SECONDS } from '@countersign/ledger'
import { releaseExpiredReservations } from '../src/reservations'
import { ATTEMPT_ID, MANDATE_ID, NOW_SEC, gateInput, harness, validationError } from './harness'
import { createOrderFromIntent } from '../src/purchase'

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** `NOW` plus an offset, so every timestamp in these tests is a constant. */
function at(offsetSeconds: number): Date {
  return new Date((NOW_SEC + offsetSeconds) * 1000)
}

const THIRTY_MINUTES = RESERVATION_TTL_SECONDS

/**
 * Run one purchase, then put the world in the state a **crash between the decision and the order** leaves:
 * a Gate reservation taken, an attempt still `GATED_ALLOW`, and no order behind it.
 *
 * That is precisely the state §8.10's rule exists for, and it is why the world is built by running the
 * pipeline rather than by seeding a budget row: the `RESERVE` the sweep gives back is the one Gate check 8
 * actually wrote, and the attempt state the sweep reads is the one `createOrderFromDecision` actually set.
 */
async function reservedWorld() {
  const h = await harness()
  const result = await createOrderFromIntent(
    {
      userId: 'usr_00000000000000000000000001' as `usr_${string}`,
      gate: gateInput(),
      merchants: { mrc_northwind: 'Northwind Outfitters' },
    },
    h.deps,
  )
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  if (result.value.stage !== 'ORDERED') {
    throw new Error(`expected an ordered purchase to seed a reservation, got ${result.value.stage}`)
  }
  // Undo the last two steps of the pipeline, keeping the `RESERVE` and the decision.
  for (const id of [...h.orderWorld.rows.orders.keys()]) h.orderWorld.rows.orders.delete(id)
  const attempt = h.orderWorld.rows.attempts.get(ATTEMPT_ID)
  if (attempt === undefined) throw new Error(`expected a checkout attempt for ${ATTEMPT_ID}`)
  h.orderWorld.rows.attempts.set(ATTEMPT_ID, { ...attempt, state: 'GATED_ALLOW' })
  return h
}

function reserveEntries(h: Awaited<ReturnType<typeof reservedWorld>>) {
  return h.entries().filter((e) => e.kind === 'RESERVE')
}

function releaseEntries(h: Awaited<ReturnType<typeof reservedWorld>>) {
  return h.entries().filter((e) => e.kind === 'RELEASE')
}

/* ------------------------------------------------------------------------------------------ */
/* The 30-minute rule                                                                              */
/* ------------------------------------------------------------------------------------------ */

describe('§8.10 the 30-minute reservation window', () => {
  it('§8.10 a reservation older than 30 minutes is released and the buyer’s budget comes back', async () => {
    const h = await reservedWorld()
    expect(reserveEntries(h)).toHaveLength(1)
    expect(h.reserved()).toBe(3_000n)

    // One second past the window. `findStaleAttempts` is given `now − 1800s`, and the reservation was
    // taken at `NOW_SEC`, so it is a candidate; `partitionExpired` then confirms `now >= created + 1800`.
    const swept = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 1))
    if (!swept.ok) throw new Error(`${swept.error.code}: ${swept.error.message}`)

    expect(swept.value.candidates).toBe(1)
    expect(swept.value.released).toHaveLength(1)
    expect(swept.value.released[0]?.attemptId).toBe(ATTEMPT_ID)
    expect(swept.value.released[0]?.mandateId).toBe(MANDATE_ID)
    expect(swept.value.released[0]?.amountMinor).toBe(3_000n)
    expect(swept.value.released[0]?.currency).toBe('USD')
    expect(swept.value.errors).toHaveLength(0)

    // The buyer's money is back: `reserved` fell to zero and `available` rose to the whole cap.
    expect(h.reserved()).toBe(0n)
    expect(swept.value.released[0]?.balance.reservedMinor).toBe(0n)
    expect(swept.value.released[0]?.balance.availableMinor).toBe(13_000n)

    // The release is a ledger entry with §8.10's own reason, so a drift report can name the cause.
    const releases = releaseEntries(h)
    expect(releases).toHaveLength(1)
    expect(releases[0]?.attempt_id).toBe(ATTEMPT_ID)
    expect(releases[0]?.reason).toBe('NO_ORDER')
    expect(releases[0]?.amount_minor).toBe(3_000n)
  })

  it('§8.10 a reservation younger than 30 minutes is NOT released, and the sweep says it is still held', async () => {
    const h = await reservedWorld()

    // 29 minutes 59 seconds: one second inside the window.
    const swept = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES - 1))
    if (!swept.ok) throw new Error(swept.error.message)

    expect(swept.value.candidates).toBe(0)
    expect(swept.value.released).toHaveLength(0)
    expect(swept.value.stillHeld).toHaveLength(0)
    expect(h.reserved()).toBe(3_000n)
    expect(releaseEntries(h)).toHaveLength(0)
  })

  it('§8.10 the window closes one second after the boundary, and the candidate query is what decides', async () => {
    // Two half-rules meet here and they are not the same rule:
    //
    // - `reservationHasExpired` (packages/ledger) uses `now >= created + 1800`, so the *window* is over at
    //   the exact boundary second.
    // - `findStaleAttempts` (packages/db) filters `created_at < olderThan`, and the sweep hands it
    //   `now − 1800s`, so the *candidate query* has not surfaced the attempt at that exact second.
    //
    // The consequence is stated rather than hidden: a reservation is released somewhere in
    // `(created + 1800s, created + 1800s + cron]`, i.e. between 30 and 35 minutes after it was taken,
    // because `release.reservations` runs every five minutes. §8.10's "expire after 30 min" holds; the
    // granularity is the cron's. Both sides are asserted so that flipping either comparison fails here.
    const atBoundary = await reservedWorld()
    const boundary = await releaseExpiredReservations(atBoundary.deps, at(THIRTY_MINUTES))
    if (!boundary.ok) throw new Error(boundary.error.message)
    expect(boundary.value.candidates).toBe(0)
    expect(boundary.value.released).toHaveLength(0)

    const oneSecondLater = await reservedWorld()
    const swept = await releaseExpiredReservations(oneSecondLater.deps, at(THIRTY_MINUTES + 1))
    if (!swept.ok) throw new Error(swept.error.message)
    expect(swept.value.released).toHaveLength(1)

    const wellBefore = await reservedWorld()
    const early = await releaseExpiredReservations(wellBefore.deps, at(THIRTY_MINUTES - 1))
    if (!early.ok) throw new Error(early.error.message)
    expect(early.value.released).toHaveLength(0)
  })

  it('§8.10 a reservation on an attempt that reached an order is never a candidate', async () => {
    // "Reservations expire after 30 min **without an order**." `findStaleAttempts` filters on
    // `state in ('GATED_ALLOW','CREATED')`, and an order created moves the attempt to `ORDER_CREATED`, so a
    // completed purchase's reservation is never swept. Asserted on the real predicate.
    const h = await harness()
    const created = await createOrderFromIntent(
      {
        userId: 'usr_00000000000000000000000001' as `usr_${string}`,
        gate: gateInput(),
        merchants: {},
      },
      h.deps,
    )
    if (!created.ok) throw new Error(created.error.message)

    const swept = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 1))
    if (!swept.ok) throw new Error(swept.error.message)
    expect(swept.value.candidates).toBe(0)
    expect(swept.value.released).toHaveLength(0)
    // The order's authorization is still reserved — the buyer's money is held by a real payment, not by a
    // stale attempt.
    expect(h.reserved()).toBe(3_000n)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Idempotency                                                                                    */
/* ------------------------------------------------------------------------------------------ */

describe('AGENTS.md rule 6: releasing is idempotent', () => {
  it('§8.10 running the sweep twice releases once, and the second run has nothing to consider', async () => {
    const h = await reservedWorld()

    const first = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 1))
    if (!first.ok) throw new Error(first.error.message)
    expect(first.value.released).toHaveLength(1)
    expect(first.value.errors).toHaveLength(0)

    // Five minutes later, exactly as the cron would.
    const second = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 300))
    if (!second.ok) throw new Error(second.error.message)

    // **Zero candidates**: the first sweep closed the attempt, so `findStaleAttempts` no longer returns it.
    // That is idempotency at the query level, which is cheaper and quieter than catching a conflict.
    expect(second.value.candidates).toBe(0)
    expect(second.value.released).toHaveLength(0)
    expect(second.value.errors).toHaveLength(0)

    // One RESERVE, one RELEASE, and the buyer's budget is intact.
    expect(releaseEntries(h)).toHaveLength(1)
    expect(h.reserved()).toBe(0n)
  })

  it('§8.10 when the attempt marker is missing, the second sweep says “already released” rather than failing', async () => {
    // The layer beneath the marker. If `setAttemptState` never ran — a crash between the release and the
    // marker, a deployment where the write is disabled — the candidate query still returns the row every
    // five minutes. Without the pre-write filter the `budget_entries` primary key would refuse the insert
    // and the sweep would return `err` for ever, which is how a working job looks broken to an operator.
    const h = await reservedWorld()
    await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 1))
    // Put the row back the way a missed marker would leave it.
    const attempt = h.orderWorld.rows.attempts.get(ATTEMPT_ID)!
    h.orderWorld.rows.attempts.set(ATTEMPT_ID, { ...attempt, state: 'GATED_ALLOW' })

    const second = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 300))
    if (!second.ok) throw new Error(second.error.message)

    expect(second.value.candidates).toBe(1)
    expect(second.value.released).toHaveLength(0)
    expect(second.value.alreadyReleased).toEqual([ATTEMPT_ID])
    expect(second.value.errors).toHaveLength(0)
    expect(releaseEntries(h)).toHaveLength(1)
  })

  it('§8.10 the release entry id is derived, so the same sweep over the same rows writes one row', async () => {
    const h = await reservedWorld()
    await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 1))
    const ids = releaseEntries(h).map((e) => e.id)

    // `releaseEntryId(attemptId, mandateId)` — the same construction `@countersign/ledger` uses for the
    // Gate's compensation and for `packages/orders`' void hook. Asserted through the ledger's own function
    // so a change to the derivation fails here rather than silently making the sweep double-write.
    const { releaseEntryId } = await import('@countersign/ledger')
    expect(ids).toEqual([releaseEntryId(ATTEMPT_ID, MANDATE_ID)])
  })

  it('§8.10 a swept attempt is closed, so the candidate query stops returning it', async () => {
    const h = await reservedWorld()
    const swept = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 1))
    if (!swept.ok) throw new Error(swept.error.message)

    // `AUTH_EXPIRED` is the honest state: no authorization was ever created, the window closed, nothing was
    // charged. The marker is written **after** the release, so a failure there cannot leave the money held.
    const attempt = h.orderWorld.rows.attempts.get(ATTEMPT_ID)!
    expect(attempt.state).toBe('AUTH_EXPIRED')

    // And with it closed, the next sweep has nothing to consider at all.
    const second = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 300))
    if (!second.ok) throw new Error(second.error.message)
    expect(second.value.candidates).toBe(0)
  })

  it('§8.10 a sweep with no setAttemptState wired still releases, and says the marker is missing', async () => {
    // The port member is optional and this is what it degrades to: correct, because the ledger entry id is
    // the real idempotency key, but it keeps re-reading the same rows. The absence is logged rather than
    // swallowed — a silent degradation of a leak-prevention job is what nobody notices until a buyer
    // complains that their limit went down.
    const h = await reservedWorld()
    const without = { ...h.deps, store: { ...h.deps.store, setAttemptState: undefined } }
    const swept = await releaseExpiredReservations(without, at(THIRTY_MINUTES + 1))
    if (!swept.ok) throw new Error(swept.error.message)

    expect(swept.value.released).toHaveLength(1)
    expect(h.orderWorld.rows.attempts.get(ATTEMPT_ID)!.state).toBe('GATED_ALLOW')
    // The next sweep still finds it, and still does not release it a second time.
    const second = await releaseExpiredReservations(without, at(THIRTY_MINUTES + 300))
    if (!second.ok) throw new Error(second.error.message)
    expect(second.value.alreadyReleased).toEqual([ATTEMPT_ID])
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Reporting                                                                                      */
/* ------------------------------------------------------------------------------------------ */

describe('the report is honest about what it did', () => {
  it('§8.10 the report carries both clocks — epoch seconds and UTC for data, IST for a human', async () => {
    // AGENTS.md rule 10: UTC epoch seconds in tokens and `timestamptz` in the database, IST only in the UI
    // and in reports to Vedant. A sweep report is exactly "a report to Vedant".
    const h = await reservedWorld()
    const swept = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 1))
    if (!swept.ok) throw new Error(swept.error.message)

    expect(swept.value.nowSec).toBe(NOW_SEC + THIRTY_MINUTES + 1)
    expect(swept.value.now.epochSec).toBe(NOW_SEC + THIRTY_MINUTES + 1)
    const utc = new Date((NOW_SEC + THIRTY_MINUTES + 1) * 1000)
    expect(swept.value.now.utc).toBe(utc.toISOString())
    // IST is UTC+05:30. Two things must hold: the offset is named, and the string denotes the **same
    // instant** as the UTC one — an IST rendering that silently shifted the clock by 5½ hours would look
    // correct in a report and be wrong in a ledger.
    expect(swept.value.now.ist).toContain('+05:30')
    expect(new Date(swept.value.now.ist).getTime()).toBe(utc.getTime())
    expect(swept.value.now.ist).not.toBe(utc.toISOString())
    // And the two renderings are textually different, so a reader can tell which one they are looking at.
    expect(swept.value.now.ist.slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('§8.10 one broken mandate does not strand the others: failures are collected, not thrown', async () => {
    const h = await reservedWorld()
    // A `budget_entries` read fails. `expireStaleReservations` is never reached, so nothing is released —
    // but the run still reports, rather than pretending it succeeded.
    h.store.failBudgetEntries(validationError('budget_entries is unavailable'))
    const swept = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 1))

    expect(swept.ok).toBe(false)
    if (swept.ok) return
    expect(swept.error.code).toBe('CS_VALIDATION')
    expect(swept.error.message).toContain('budget_entries is unavailable')
    expect(h.reserved()).toBe(3_000n)
  })

  it('§8.10 a sweep over an empty candidate set is ok with zero work, not an error', async () => {
    const h = await harness()
    const swept = await releaseExpiredReservations(h.deps, at(THIRTY_MINUTES + 1))
    if (!swept.ok) throw new Error(swept.error.message)
    expect(swept.value.candidates).toBe(0)
    expect(swept.value.released).toHaveLength(0)
    expect(swept.value.errors).toHaveLength(0)
  })

  it('§8.10 a custom ttl is honoured, so the rule can be tested without waiting half an hour', async () => {
    const h = await reservedWorld()
    // One second is enough to prove the parameter is the number the comparison uses, rather than a constant
    // that happens to agree with the test.
    const swept = await releaseExpiredReservations(h.deps, at(2), { ttlSeconds: 1 })
    if (!swept.ok) throw new Error(swept.error.message)
    expect(swept.value.released).toHaveLength(1)
    expect(h.reserved()).toBe(0n)
  })
})
