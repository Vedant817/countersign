/**
 * `packages/ledger` — the reservation lifetime. Spec §8.10 ("reservations expire after 30 min without an
 * order"), §12 **EC-MDT-2**, **EC-STOCK-3**, **EC-IDEM-1**, decision **D19**.
 *
 * ## What is being proved here, and what cannot be
 *
 * Three properties, in order of how much they matter:
 *
 * 1. **Deterministic entry identity.** Re-running a reserve for the same attempt must hit the
 *    `budget_entries` primary key, not claim the buyer's budget twice. AGENTS.md rule 6.
 * 2. **A release is idempotent and clamped.** A retry, a 30-minute sweep and an explicit void can all
 *    reach the same reservation; none of them may credit authority that was never reserved.
 * 3. **The 30-minute window is a partition, and it is pure.** `partitionExpired` decides which
 *    reservations have outlived the window with no database and no clock, so it can be property-tested.
 *
 * What *cannot* be proved here is the lock: `reserveIn` / `releaseIn` own `SELECT … FOR UPDATE` in
 * `packages/db`, and AT-M10.2's twenty-way race (in `packages/gate/test/budget.test.ts`) is where the lock
 * is exercised. This file injects the same `BudgetStore` port and asserts the semantics on top of it.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { money, type AttemptId, type MandateId } from '@countersign/core'
import type {
  BudgetAccountRow,
  BudgetEntryRow,
  NewBudgetEntry,
  WalletCapRow,
} from '@countersign/db'

import {
  RELEASE_REASONS,
  RESERVATION_TTL_SECONDS,
  describeReservation,
  expireStaleReservations,
  ledgerEntryId,
  openReservationHandle,
  partitionExpired,
  releaseEntryId,
  releaseReservation,
  reservationEntryId,
  reservationHasExpired,
  reservationStatus,
  reserveForAttempt,
  summariseBalance,
  type BudgetStore,
  type OpenReservation,
  type ReservationHandle,
} from '../src/index'

const MANDATE = 'mdt_0000000000000000000000000A' as MandateId
const ATTEMPT = 'att_0000000000000000000000000A' as AttemptId
const NOW_SEC = 1_760_000_000
const CAP = 13_000n

/* ------------------------------------------------------------------------------------------ */
/* A minimal in-memory BudgetStore                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * The narrowest `BudgetStore` that honours the contract `reserveIn` / `releaseIn` rely on.
 *
 * Local to this file on purpose: `packages/gate` has a richer double (with a modelled `FOR UPDATE`,
 * because AT-M10.2 needs the contention), and depending on it from here would make the ledger depend on
 * the package that depends on it. This one needs no lock — it is used from single-threaded test bodies, and
 * the lock is exercised where concurrency is actually under test.
 *
 * It still models the two things that matter for *this* file's claims: the **append-only** `budget_entries`
 * (the ledger never updates or deletes an entry) and the **`SELECT … FOR UPDATE`** read, which returns a
 * copy so a caller cannot mutate the row it was handed.
 */
function memoryStore(accounts: BudgetAccountRow[]): BudgetStore & {
  accounts(): Map<MandateId, BudgetAccountRow>
  entries(): BudgetEntryRow[]
} {
  const rows = new Map(accounts.map((r) => [r.mandate_id, { ...r }]))
  const ledger: BudgetEntryRow[] = []
  const caps = new Map<string, WalletCapRow>()

  return {
    async lockBudgetAccount(id) {
      const row = rows.get(id)
      return row ? { ...row } : null
    },
    async readBudgetAccount(id) {
      const row = rows.get(id)
      return row ? { ...row } : null
    },
    async insertBudgetAccount(account) {
      const row = { ...account } as unknown as BudgetAccountRow
      rows.set(account.mandate_id as MandateId, row)
      return { ...row }
    },
    async updateBudgetAccount(id, next, at) {
      const existing = rows.get(id)
      if (!existing) throw new Error(`no budget_accounts row for ${id}`)
      const row: BudgetAccountRow = {
        ...existing,
        reserved_minor: next.reservedMinor,
        spent_minor: next.spentMinor,
        version: next.version,
        updated_at: at,
      }
      rows.set(id, row)
      return { ...row }
    },
    async insertBudgetEntry(entry: NewBudgetEntry) {
      // Append-only, and the primary key is enforced: a retried write with a derived id must collide
      // rather than duplicate. That is the property `ledgerEntryId` exists for, so this file can assert it.
      if (ledger.some((e) => e.id === entry.id)) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "budget_entries_pkey"'),
          {
            code: '23505',
            constraint: 'budget_entries_pkey',
          },
        )
      }
      const row = { ...entry } as unknown as BudgetEntryRow
      ledger.push(row)
      return { ...row }
    },
    async lockWalletCap(walletId) {
      const row = caps.get(walletId)
      return row ? { ...row } : null
    },
    async sumEntriesByKind(mandateId) {
      const totals = { RESERVE: 0n, RELEASE: 0n, COMMIT: 0n, REVERSE: 0n } as Record<string, bigint>
      for (const e of ledger) {
        if (e.mandate_id !== mandateId) continue
        totals[e.kind] = (totals[e.kind] ?? 0n) + e.amount_minor
      }
      return totals as { RESERVE: bigint; RELEASE: bigint; COMMIT: bigint; REVERSE: bigint }
    },
    async walletSpendInPeriod() {
      return 0n
    },
    accounts() {
      return new Map([...rows.entries()].map(([k, v]) => [k, { ...v }]))
    },
    entries() {
      return ledger.map((e) => ({ ...e }))
    },
  }
}

/** A store seeded with one mandate's budget, plus its counters. */
function world(cap = CAP) {
  const row: BudgetAccountRow = {
    mandate_id: MANDATE,
    currency: 'USD',
    cap_minor: cap,
    reserved_minor: 0n,
    spent_minor: 0n,
    version: 0,
    created_at: new Date(NOW_SEC * 1000),
    updated_at: new Date(NOW_SEC * 1000),
  }
  const store = memoryStore([row])
  const balance = () => {
    const live = store.accounts().get(MANDATE)!
    return {
      cap: live.cap_minor,
      reserved: live.reserved_minor,
      spent: live.spent_minor,
      version: live.version,
      available: live.cap_minor - live.reserved_minor - live.spent_minor,
    }
  }
  return { store, balance }
}

describe('deterministic entry identity', () => {
  it('the same attempt always yields the same RESERVE id', () => {
    expect(reservationEntryId(ATTEMPT, MANDATE)).toBe(reservationEntryId(ATTEMPT, MANDATE))
    expect(reservationEntryId(ATTEMPT, MANDATE)).toMatch(/^ben_[0-9a-f]{26}$/)
  })

  it('a different attempt, mandate or kind yields a different id', () => {
    const base = reservationEntryId(ATTEMPT, MANDATE)
    expect(reservationEntryId('att_0000000000000000000000000B' as AttemptId, MANDATE)).not.toBe(
      base,
    )
    expect(reservationEntryId(ATTEMPT, 'mdt_0000000000000000000000000B' as MandateId)).not.toBe(
      base,
    )
    // RESERVE and RELEASE for one attempt must not collide: a release must be able to coexist with the
    // reserve it is releasing.
    expect(releaseEntryId(ATTEMPT, MANDATE)).not.toBe(base)
  })

  it('the scope is canonical, so key order in the caller cannot change the id', () => {
    const a = ledgerEntryId({ kind: 'COMMIT', mandateId: MANDATE, captureId: 'cap_1' })
    const b = ledgerEntryId({ captureId: 'cap_1', mandateId: MANDATE, kind: 'COMMIT' })
    expect(a).toBe(b)
  })

  it('a COMMIT is keyed by its capture, not by an attempt', () => {
    // `commitIn` inserts with `attempt_id: null`, so the identity has to come from the capture. Two
    // commits against one capture must not be able to write two entries.
    expect(ledgerEntryId({ kind: 'COMMIT', mandateId: MANDATE, captureId: 'cap_1' })).toBe(
      ledgerEntryId({ kind: 'COMMIT', mandateId: MANDATE, captureId: 'cap_1' }),
    )
    expect(ledgerEntryId({ kind: 'COMMIT', mandateId: MANDATE, captureId: 'cap_1' })).not.toBe(
      ledgerEntryId({ kind: 'COMMIT', mandateId: MANDATE, captureId: 'cap_2' }),
    )
  })
})

describe('reserve / release', () => {
  it('reserves and returns a handle pinning the budget version', async () => {
    const { store, balance } = world()
    const result = await reserveForAttempt(store, {
      attemptId: ATTEMPT,
      mandateId: MANDATE,
      amount: money(3_000n, 'USD'),
      nowSec: NOW_SEC,
    })

    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.budgetVersion).toBe(1)
    expect(result.value.createdAtSec).toBe(NOW_SEC)
    expect(result.value.expiresAtSec).toBe(NOW_SEC + RESERVATION_TTL_SECONDS)
    expect(balance().reserved).toBe(3_000n)
    expect(balance().available).toBe(10_000n)
  })

  it('refuses over the cap and writes nothing', async () => {
    const { store, balance } = world(2_000n)
    const result = await reserveForAttempt(store, {
      attemptId: ATTEMPT,
      mandateId: MANDATE,
      amount: money(3_000n, 'USD'),
      nowSec: NOW_SEC,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('GATE_BUDGET_EXCEEDED')
    expect(balance().reserved).toBe(0n)
    expect(store.entries()).toHaveLength(0)
  })

  it('a repeated reserve for the same attempt does not claim the budget twice', async () => {
    const { store, balance } = world()
    const first = await reserveForAttempt(store, {
      attemptId: ATTEMPT,
      mandateId: MANDATE,
      amount: money(3_000n, 'USD'),
      nowSec: NOW_SEC,
    })
    expect(first.ok).toBe(true)

    // The second attempt is the retry. `reserveIn` re-uses the derived id, so the insert hits the primary
    // key. Either outcome must leave `reserved` at 3000 — never 6000 — and the second must not be silent.
    const second = await reserveForAttempt(store, {
      attemptId: ATTEMPT,
      mandateId: MANDATE,
      amount: money(3_000n, 'USD'),
      nowSec: NOW_SEC,
    })
    expect(balance().reserved).toBe(3_000n)
    if (second.ok) expect(second.value.budgetVersion).toBe(1)
    else expect(second.error.code).toBe('CS_CONFLICT')
  })

  it('releases, and a second release can neither credit un-reserved authority nor fail silently', async () => {
    const { store, balance } = world()
    const reserved = await reserveForAttempt(store, {
      attemptId: ATTEMPT,
      mandateId: MANDATE,
      amount: money(3_000n, 'USD'),
      nowSec: NOW_SEC,
    })
    if (!reserved.ok) throw new Error(reserved.error.message)

    const first = await releaseReservation(
      store,
      reserved.value,
      RELEASE_REASONS.manual,
      NOW_SEC + 60,
    )
    if (!first.ok) throw new Error(first.error.message)
    expect(balance().reserved).toBe(0n)

    // The second release is a sweep racing a void. Two acceptable outcomes, and both are correct:
    //
    // - the derived entry id collides with the first RELEASE, so the write is refused (`CS_CONFLICT`) —
    //   the release is idempotent by construction;
    // - or it is clamped at the current `reserved = 0`, writing a zero-amount entry whose `reason` says
    //   `clamped to reserved`.
    //
    // What must **not** happen either way: `reserved` going negative, or the buyer being credited
    // authority that was never reserved. A `-3000` balance would let the next purchase skip the cap.
    const second = await releaseReservation(
      store,
      reserved.value,
      RELEASE_REASONS.manual,
      NOW_SEC + 120,
    )
    if (second.ok) {
      expect(balance().reserved).toBe(0n)
      const clamped = store.entries().find((e) => e.kind === 'RELEASE' && e.amount_minor === 0n)
      expect(clamped?.reason).toContain('clamped to reserved')
    } else {
      expect(second.error.code).toBe('CS_CONFLICT')
    }
    expect(balance().reserved).toBe(0n)
    expect(balance().available).toBe(CAP)
  })

  it('the release records *why*, in `budget_entries.reason`', async () => {
    const { store } = world()
    const reserved = await reserveForAttempt(store, {
      attemptId: ATTEMPT,
      mandateId: MANDATE,
      amount: money(1_000n, 'USD'),
      nowSec: NOW_SEC,
    })
    if (!reserved.ok) throw new Error(reserved.error.message)
    await releaseReservation(store, reserved.value, RELEASE_REASONS.outOfStock, NOW_SEC + 10)

    expect(store.entries().find((e) => e.kind === 'RELEASE')?.reason).toBe('OUT_OF_STOCK')
  })

  it('describeReservation is a readable one-liner with the version and the expiry', async () => {
    const { store } = world()
    const reserved = await reserveForAttempt(store, {
      attemptId: ATTEMPT,
      mandateId: MANDATE,
      amount: money(3_000n, 'USD'),
      nowSec: NOW_SEC,
    })
    if (!reserved.ok) throw new Error(reserved.error.message)

    const line = describeReservation(reserved.value)
    expect(line).toContain('$30.00')
    expect(line).toContain('v1')
    expect(line).toContain(String(NOW_SEC + RESERVATION_TTL_SECONDS))
  })
})

describe('the 30-minute window', () => {
  it('is exactly 30 minutes, and `>=` at the boundary', () => {
    expect(RESERVATION_TTL_SECONDS).toBe(1_800)
    expect(reservationHasExpired(NOW_SEC, NOW_SEC + 1_799)).toBe(false)
    // `>=`, not `>`: at exactly 1800 the window is over. A reservation that survived to the exact second
    // would depend on how the cron happened to be scheduled.
    expect(reservationHasExpired(NOW_SEC, NOW_SEC + 1_800)).toBe(true)
  })

  it('partitionExpired is pure and splits on the window', () => {
    const candidates: OpenReservation[] = [
      open(NOW_SEC - 3_600),
      open(NOW_SEC - 1_800),
      open(NOW_SEC - 1_799),
      open(NOW_SEC),
    ]
    const { expired, stillHeld } = partitionExpired(candidates, NOW_SEC)

    expect(expired.map((c) => c.reservedAtSec)).toEqual([NOW_SEC - 3_600, NOW_SEC - 1_800])
    expect(stillHeld.map((c) => c.reservedAtSec)).toEqual([NOW_SEC - 1_799, NOW_SEC])
  })

  it('is a property: the partition is total, disjoint, and threshold-exact', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -7_200, max: 0 }), { minLength: 1, maxLength: 25 }),
        fc.integer({ min: -7_200, max: 0 }),
        (offsets, nowOffset) => {
          const now = NOW_SEC + nowOffset
          const candidates = offsets.map((o, i) => open(NOW_SEC + o, `att_${i}`))
          const { expired, stillHeld } = partitionExpired(candidates, now)

          // Total and disjoint: every candidate is in exactly one bucket.
          expect(expired.length + stillHeld.length).toBe(candidates.length)
          expect(expired.some((c) => stillHeld.includes(c))).toBe(false)

          // Threshold-exact, per element — including the `>=` boundary.
          for (const c of candidates) {
            const shouldExpire = now >= c.reservedAtSec + RESERVATION_TTL_SECONDS
            expect(expired.includes(c)).toBe(shouldExpire)
            expect(stillHeld.includes(c)).toBe(!shouldExpire)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('reservationStatus puts COMMITTED above EXPIRED, so a late sweep never releases a settled capture', () => {
    // Precedence is the whole point of it being a function: a reservation that reached a capture inside the
    // window is settled money, and reporting it expirable would release authority for money already spent.
    expect(
      reservationStatus({
        committed: true,
        released: false,
        expiresAtSec: NOW_SEC,
        nowSec: NOW_SEC + 9_999,
      }),
    ).toBe('COMMITTED')
    expect(
      reservationStatus({
        committed: false,
        released: true,
        expiresAtSec: NOW_SEC,
        nowSec: NOW_SEC,
      }),
    ).toBe('RELEASED')
    expect(
      reservationStatus({
        committed: false,
        released: false,
        expiresAtSec: NOW_SEC,
        nowSec: NOW_SEC,
      }),
    ).toBe('EXPIRED')
    expect(
      reservationStatus({
        committed: false,
        released: false,
        expiresAtSec: NOW_SEC + 1,
        nowSec: NOW_SEC,
      }),
    ).toBe('HELD')
  })

  it('openReservationHandle carries a zero balance the sweeper never reads', () => {
    // The sweeper's job is the release; `releaseIn` returns the authoritative balance. Documenting the
    // placeholder is what stops a caller treating it as real.
    const handle = openReservationHandle(open(NOW_SEC - 3_600))
    expect(handle.expiresAtSec).toBe(NOW_SEC - 3_600 + RESERVATION_TTL_SECONDS)
    expect(handle.balance.version).toBe(0)
    expect(handle.budgetVersion).toBe(0)
  })
})

describe('the sweep', () => {
  it('releases every expired reservation and leaves the rest alone', async () => {
    const { store, balance } = world()
    const held = await reserveForAttempt(store, {
      attemptId: ATTEMPT,
      mandateId: MANDATE,
      amount: money(3_000n, 'USD'),
      nowSec: NOW_SEC - 3_600,
    })
    if (!held.ok) throw new Error(held.error.message)
    await reserveForAttempt(store, {
      attemptId: 'att_0000000000000000000000000B' as AttemptId,
      mandateId: MANDATE,
      amount: money(3_000n, 'USD'),
      nowSec: NOW_SEC - 100,
    })

    const report = await expireStaleReservations(store, {
      candidates: [
        open(NOW_SEC - 3_600, ATTEMPT),
        open(NOW_SEC - 100, 'att_0000000000000000000000000B' as AttemptId),
      ],
      nowSec: NOW_SEC,
    })

    if (!report.ok) throw new Error(report.error.message)
    expect(report.value.expired).toHaveLength(1)
    expect(report.value.stillHeld).toHaveLength(1)
    expect(report.value.errors).toHaveLength(0)
    // The stale one is gone; the fresh one is still claimed.
    expect(balance().reserved).toBe(3_000n)
    expect(held.value.expiresAtSec).toBeLessThanOrEqual(NOW_SEC)
  })
  it('reports per-reservation, because "the buyer still has $60 held" is a bug somebody has to chase', async () => {
    const { store } = world()
    const report = await expireStaleReservations(store, {
      candidates: [
        open(NOW_SEC - 3_600, ATTEMPT),
        open(NOW_SEC - 7_200, 'att_0000000000000000000000000B' as AttemptId),
      ],
      nowSec: NOW_SEC,
    })

    if (!report.ok) throw new Error(report.error.message)
    expect(report.value.expired.map((e) => e.handle.attemptId)).toEqual([
      ATTEMPT,
      'att_0000000000000000000000000B',
    ])
    // And each line carries the balance the release produced, so a caller can log the exact number.
    for (const line of report.value.expired) expect(line.released.currency).toBe('USD')
  })

  it('a sweep that could not do everything says so, rather than reporting a partial success', async () => {
    const { store } = world()
    const missing = 'mdt_0000000000000000000000000F' as MandateId
    const report = await expireStaleReservations(store, {
      candidates: [
        open(NOW_SEC - 3_600, ATTEMPT),
        { ...open(NOW_SEC - 3_600), mandateId: missing },
      ],
      nowSec: NOW_SEC,
    })

    expect(report.ok).toBe(false)
    if (report.ok) return
    // One mandate released, one had no `budget_accounts` row. The sweep keeps going rather than aborting —
    // a single broken mandate must not strand every other reservation — but it does not claim success.
    expect(report.error.message).toContain('Released 1 of 2')
    expect(report.error.code).toBe('CS_INTERNAL')
  })

  it('uses NO_ORDER as the default reason, which is what the spec says expired for', async () => {
    const { store } = world()
    const reserved = await reserveForAttempt(store, {
      attemptId: ATTEMPT,
      mandateId: MANDATE,
      amount: money(3_000n, 'USD'),
      nowSec: NOW_SEC - 3_600,
    })
    if (!reserved.ok) throw new Error(reserved.error.message)
    await expireStaleReservations(store, { candidates: [open(NOW_SEC - 3_600)], nowSec: NOW_SEC })

    // Exactly `NO_ORDER`, with no clamp note: the reservation was for 3000 and 3000 was held.
    expect(store.entries().find((e) => e.kind === 'RELEASE')?.reason).toBe(RELEASE_REASONS.noOrder)
    expect(RELEASE_REASONS.noOrder).toBe('NO_ORDER')
  })

  it('summariseBalance reads as one line for the mandate UI', () => {
    const line = summariseBalance({
      mandateId: MANDATE,
      currency: 'USD',
      cap: money(13_000n, 'USD'),
      reserved: money(3_000n, 'USD'),
      spent: money(1_000n, 'USD'),
      available: money(9_000n, 'USD'),
      version: 4,
    })

    expect(line).toContain('$10.00 spent')
    expect(line).toContain('$30.00 held')
    expect(line).toContain('$90.00 available')
    expect(line).toContain('$130.00')
  })
})

describe('AT-M10.4’s shape, at the ledger layer', () => {
  it('release then re-reserve returns the budget to exactly where it started', async () => {
    // The invariant AT-M10.4 rests on: a reservation that is taken and given back leaves no trace on the
    // balances, whatever the reason. `version` does advance — that is the point of a version.
    const { store, balance } = world()
    const before = balance()

    const reserved = await reserveForAttempt(store, {
      attemptId: ATTEMPT,
      mandateId: MANDATE,
      amount: money(3_000n, 'USD'),
      nowSec: NOW_SEC,
    })
    if (!reserved.ok) throw new Error(reserved.error.message)
    expect(balance().reserved).toBe(3_000n)

    const released = await releaseReservation(
      store,
      reserved.value,
      RELEASE_REASONS.revoked,
      NOW_SEC + 1,
    )
    if (!released.ok) throw new Error(released.error.message)

    expect(balance().reserved).toBe(before.reserved)
    expect(balance().spent).toBe(before.spent)
    expect(balance().available).toBe(before.available)
    expect(balance().version).toBeGreaterThan(before.version)
  })

  it('the handle a release needs is exactly what a reserve returned — no second source of truth', () => {
    const handle: ReservationHandle = openReservationHandle(open(NOW_SEC))
    expect(handle.entryId).toBe(reservationEntryId(ATTEMPT, MANDATE))
    expect(handle.mandateId).toBe(MANDATE)
    expect(handle.amount).toEqual({ minor: 3_000n, currency: 'USD' })
  })
})

/** An `OpenReservation` with a fixed amount, so assertions can name it. */
function open(reservedAtSec: number, attemptId: AttemptId = ATTEMPT): OpenReservation {
  return {
    attemptId,
    mandateId: MANDATE,
    amount: money(3_000n, 'USD'),
    reservedAtSec,
    entryId: reservationEntryId(attemptId, MANDATE),
  }
}
