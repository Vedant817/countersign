/**
 * `GateDeps` wiring — spec **§8.10**, **D-018** (the LLM ban), §12.5 **EC-TIME-4**, **AT-M10.2**.
 *
 * ## Two things live here, and neither is the Gate's logic
 *
 * 1. **A port-to-repository map.** `gateDepsFromRepos` turns `packages/db`'s repository functions and
 *    `ViClient` into a `GateDeps`. Every member of `GateDeps` names the repo it came from in its own doc
 *    comment, and this is where that promise is kept: adding a port without saying which repo satisfies
 *    it is a `tsc` error here.
 * 2. **An in-memory `BudgetStore` that models `FOR UPDATE`.** `createInMemoryBudgetStore` is what
 *    AT-M10.2's twenty-way race runs against, and modelling the lock rather than assuming it is the whole
 *    point of that test — see the function's doc comment.
 *
 * ## Why `GateDeps` is a closed list, restated as a type
 *
 * D-018 records the ban as a *direct-import* control and names its honest limit: "an LLM reached by
 * reflection, or through a package that wraps one, would not be caught." A closed dependency list is the
 * structural half of that answer. Every capability the Gate has is a member of `GateDeps`; adding one is a
 * line in `types.ts` reviewed against the ban. There is no `fetch`, no `http.get`, and no "call whatever
 * you like" member, so a Gate cannot reach a model even by accident.
 */

import {
  csError,
  err,
  fixedClock,
  ok,
  type AttemptId,
  type CheckoutId,
  type Clock,
  type CsError,
  type Currency,
  type GateDecisionId,
  type MandateId,
  type Money,
  type Result,
  type WalletId,
} from '@countersign/core'
import type {
  AgentRow,
  BudgetAccountRow,
  BudgetEntryRow,
  CheckoutAttemptRow,
  CheckoutSessionRow,
  DeviceRow,
  Exec,
  L1Row,
  MandateRow,
  ProductRow,
  WalletCapRow,
} from '@countersign/db'
import type {
  countRecentAttempts,
  createAttempt,
  findAttemptByL3Jti,
  findL1ForDeviceWallet,
  findProductsBySku,
  listAttemptsForMandate,
  requireCheckoutSession,
  requireMandate,
  setMandateStatus,
} from '@countersign/db'
import type { BudgetBalance, BudgetStore, WalletCapPeriod } from '@countersign/db'
import type { NewBudgetAccountRow, NewBudgetEntry } from '@countersign/db'
import type { VerifyRequest, VerifyResponse, ViClient } from '@countersign/vi-client'
import { normaliseSkipped, verifyRequestSchema } from '@countersign/vi-client'
import { merchantKeySetFromJwks } from './decision-record'
import type {
  AttemptState,
  GateDeps,
  GateTx,
  MerchantKeySet,
  NewAttemptForGate,
  RowOfAgents,
  RowOfDevices,
  RowOfL1,
} from './types'

/* ------------------------------------------------------------------------------------------ */
/* 1. Port → repository                                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * The `packages/db` handles `gateDepsFromRepos` needs.
 *
 * Function references rather than repository objects, because every repo in `@countersign/db` is a free
 * function taking an optional executor as its last argument — that is the shape WP-02 fixed, and this
 * file does not re-wrap them into a second abstraction.
 */
export interface GateRepoHandles {
  /** `repos/mandates.ts::requireMandate` — checks 1 and 8. */
  readonly requireMandate: typeof requireMandate
  /** `repos/agents.ts::findAgentById`. Not `assertAgentActive`: check 2 needs the row, not a verdict. */
  readonly findAgentById: (
    id: string,
    exec?: Exec,
  ) => Promise<Result<AgentRow | undefined, CsError>>
  /** `repos/devices.ts::findDeviceById`. Idem. */
  readonly findDeviceById: (
    id: string,
    exec?: Exec,
  ) => Promise<Result<DeviceRow | undefined, CsError>>
  /**
   * `repos/devices.ts::findL1ForDeviceWallet` — check 4's `l1`.
   *
   * Already exported by `@countersign/db` and already used by `repos/mandates.ts` to enforce
   * `mandate.exp <= L1.exp`, so this adds no query and no new concept: the Gate asks for the same row the
   * mandate-creation path asked for. §7.2's unique index on `(device_id, wallet_id)` is what makes the
   * two-key lookup a lookup rather than a search.
   */
  readonly findL1ForDeviceWallet: typeof findL1ForDeviceWallet
  /** `repos/checkout.ts::requireCheckoutSession` — checks 5, 6, 7 and 10. */
  readonly requireCheckoutSession: typeof requireCheckoutSession
  /** `repos/products.ts::findProductsBySku` — check 10. */
  readonly findProductsBySku: typeof findProductsBySku
  /** `repos/budget.ts::countCommitsSince` — check 11's time-bounded count. */
  readonly countCommitsSince: (
    mandateId: MandateId,
    since: Date,
    exec?: Exec,
  ) => Promise<Result<number, CsError>>
  /** `repos/attempts.ts::createAttempt` — check 7's unique insert. */
  readonly createAttempt: typeof createAttempt
  /** `repos/attempts.ts::findAttemptByL3Jti` — kept so a caller can enrich a `GATE_REPLAY` message. */
  readonly findAttemptByL3Jti: typeof findAttemptByL3Jti
  /** `repos/attempts.ts::countRecentAttempts` — check 12's first rule. */
  readonly countRecentAttempts: typeof countRecentAttempts
  /** `repos/attempts.ts::listAttemptsForMandate` — check 12's second rule. */
  readonly listAttemptsForMandate: typeof listAttemptsForMandate
  /** `repos/mandates.ts::setMandateStatus` — check 12's `SUSPENDED`. */
  readonly setMandateStatus: typeof setMandateStatus
  /** `repos/budget.ts::drizzleStore(exec)`, or any other `BudgetStore`. */
  readonly budgetStore: BudgetStore
  /** `ViClient` for check 4 and check 5's key set. */
  readonly vi: Pick<ViClient, 'verify' | 'jwks'>
  /** Signs the decision record: `recordSigner(key, kid)` from `decision-record.ts`. */
  readonly signRecord: GateDeps['signRecord']
  /** One `Clock`, read once per decision. */
  readonly clock: Clock
  /** The wallet cap period for a wallet: `wallet_caps.period`. */
  readonly walletCapPeriod: (
    walletId: WalletId,
    exec?: Exec,
  ) => Promise<Result<WalletCapPeriod | undefined, CsError>>
  /**
   * One transaction for checks 8 and 9. `client.withTx` in production.
   *
   * It must take the rollback signal seriously: `tx.rollback(reason)` abandons everything the callback
   * wrote, and the absence of a call commits. A Gate wired with an implementation that ignores
   * `rollback` would commit a reservation for a purchase check 9 refused — the exact leak AT-M10.4 rules
   * out — so this is a stated requirement rather than an assumption. It is also why `withTx` is required
   * rather than defaulted to the identity function: two independent commits would let two agents on one
   * wallet (EC-MA-1) both pass a cap only one of them can spend.
   */
  readonly withTx: <T>(fn: (exec: Exec, control: TxControl) => Promise<T>) => Promise<T>
  /**
   * `SELECT … FROM mandates … FOR UPDATE`, on a transaction handle.
   *
   * A separate member rather than `requireMandate`, because `requireMandate` takes an `Exec` and a
   * *locking* read needs the statement to say `FOR UPDATE` — a repository in `@countersign/db` does not
   * expose one, and adding it there would mean editing another work package's files (AGENTS.md rule 8).
   */
  readonly lockMandateForUpdate: (
    id: MandateId,
    exec: Exec,
  ) => Promise<Result<MandateRow | undefined, CsError>>
}

/**
 * What `withTx` hands its callback alongside the executor. Structurally {@link GateTx}.
 *
 * Declared separately from `GateTx` because this file cannot import from `./types` without a cycle —
 * `types.ts` is imported *by* `deps.ts`, not the other way round. The shapes are identical and the
 * `GateDeps['transaction']` assignment in {@link gateDepsFromRepos} is what keeps them so.
 */
export interface TxControl {
  /** Abandon everything this transaction wrote. Idempotent; the last reason wins. */
  rollback(reason: string): void
  readonly rolledBack: boolean
}

/**
 * Build a `GateDeps` from `packages/db`'s repositories.
 *
 * Two of the seventeen members cannot come straight from a repository and are composed here:
 * `lockMandate` (an in-transaction locking read — see {@link GateRepoHandles}) and `transaction`
 * (`withTx`). Both are *narrowing*, not new capability: the Gate reads a mandate row and it runs one
 * transaction, nothing else.
 *
 * `insertAttempt` returns the created row. A `23505` on `checkout_attempts_l3_jti_key` arrives as
 * `GATE_REPLAY` already — `repos/index.ts::CONSTRAINT_CODES` maps it — so this adds no error mapping of
 * its own and cannot remap a replay to something softer.
 */
export function gateDepsFromRepos(handles: GateRepoHandles): GateDeps {
  return defineGateDeps({
    clock: handles.clock,

    budget: handles.budgetStore,

    mandate: (id) => handles.requireMandate(id),

    // `withTx` passes the transaction handle in, so the locking read happens inside the same
    // transaction as the reservation. That is AT-M10.4.
    lockMandate: (id) => handles.withTx((exec) => handles.lockMandateForUpdate(id, exec)),

    transaction: (fn) =>
      handles.withTx((exec, control) => {
        // The Gate's `GateTx` and `withTx`'s `TxControl` are deliberately separate objects: the Gate's
        // handle is what `fn` sees, and `control` is what `withTx`'s implementation reads *after* `fn`
        // returns to decide COMMIT vs ROLLBACK. Bridging them here is the only place the two meet.
        let rolledBack = false
        let reason = ''
        const gateTx: GateTx = {
          rollback(why: string) {
            rolledBack = true
            reason = why
          },
          get rolledBack() {
            return rolledBack
          },
        }
        return fn(gateTx).then((value) => {
          if (rolledBack) control.rollback(reason === '' ? 'the Gate rolled back' : reason)
          return value
        })
      }),

    agent: async (id) => {
      const found = await handles.findAgentById(id)
      if (!found.ok) return found
      const row = found.value
      if (!row) return ok(undefined)
      const narrow: RowOfAgents = { id: row.id, kid: row.kid, status: row.status }
      return ok(narrow)
    },

    device: async (id) => {
      const found = await handles.findDeviceById(id)
      if (!found.ok) return found
      const row = found.value
      if (!row) return ok(undefined)
      const narrow: RowOfDevices = { id: row.id, status: row.status }
      return ok(narrow)
    },

    // Check 4's L1. Narrowed to `sd_jwt` for the same reason `device` is narrowed to `{id, status}`:
    // the Gate holds the serialized token and nothing else from this table. An absent row stays
    // `undefined` so `chainTokens` can refuse by name instead of sending a token it does not have.
    findL1ForDeviceWallet: async (deviceId, walletId) => {
      const found = await handles.findL1ForDeviceWallet(deviceId, walletId)
      if (!found.ok) return found
      const row: L1Row | undefined = found.value
      if (!row) return ok(undefined)
      const narrow: RowOfL1 = { sd_jwt: row.sd_jwt }
      return ok(narrow)
    },

    verify: (request: VerifyRequest) => handles.vi.verify(request),

    checkout: (id) => handles.requireCheckoutSession(id),

    merchantKeys: async () => {
      const jwks = await handles.vi.jwks()
      if (!jwks.ok) return jwks
      return ok(merchantKeySetFromJwks(jwks.value.keys as Record<string, unknown>[]))
    },

    walletCapPeriod: (walletId: WalletId) => handles.walletCapPeriod(walletId),

    insertAttempt: async (input: NewAttemptForGate) => {
      const created = await handles.createAttempt({ ...input, state: 'CREATED' })
      if (!created.ok) return created
      return ok(created.value as CheckoutAttemptRow)
    },

    products: (skus) => handles.findProductsBySku(skus),

    countCommitsSince: (mandateId, since) => handles.countCommitsSince(mandateId, since),

    countRecentAttempts: (mandateId, since) => handles.countRecentAttempts(mandateId, since),

    recentAttemptStates: async (mandateId, limit) => {
      const listed = await handles.listAttemptsForMandate(mandateId, limit)
      if (!listed.ok) return listed
      return ok(listed.value.map((row) => row.state as AttemptState))
    },

    suspendMandate: async (id, reason) => {
      // `setMandateStatus`'s fourth parameter is the transaction handle, not a reason string. The
      // revocation *reason* is recorded on the mandate row by `revokeMandate`; a velocity suspension is a
      // pause, not a revocation, so it carries no reason of its own — the `GATE_BLOCKED` reason on the
      // decision record is where the "why" lives, and it is immutable.
      //
      // Stamped from the **injected** clock, not `new Date()`. The ledger entries this write is later
      // compared against are stamped at the Gate's captured `nowSec`, and
      // `walletSpendInPeriod`'s DAY window compares the two. A wall-clock stamp sitting next to a
      // fixed-clock stamp is a year apart in the fixtures, which is the shape of a test that passes
      // today and fails after New Year.
      const suspended = await handles.setMandateStatus(
        id,
        'SUSPENDED',
        new Date(handles.clock.nowMs()),
      )
      if (!suspended.ok) return suspended
      void reason
      return ok(true as const)
    },

    signRecord: handles.signRecord,
  })
}

/**
 * Type-check a partial `GateDeps` and refuse to build one with a hole in it.
 *
 * A missing member is a `tsc` error, which is the point: `GateDeps` being a closed interface is what
 * makes "the Gate has exactly these capabilities" checkable. `defineGateDeps` exists to keep the error
 * message readable at the call site, not to add runtime safety.
 */
export function defineGateDeps(deps: GateDeps): GateDeps {
  return deps
}

/** Which members are required and which are optional. Documentation that a test can assert on. */
export const DEFAULT_GATE_DEPS: Readonly<Record<keyof GateDeps, 'required' | 'optional'>> =
  Object.freeze({
    clock: 'required',
    budget: 'required',
    mandate: 'required',
    lockMandate: 'required',
    transaction: 'required',
    agent: 'required',
    device: 'required',
    findL1ForDeviceWallet: 'required',
    verify: 'required',
    checkout: 'required',
    merchantKeys: 'required',
    insertAttempt: 'required',
    products: 'required',
    countCommitsSince: 'required',
    countRecentAttempts: 'required',
    recentAttemptStates: 'required',
    suspendMandate: 'required',
    signRecord: 'required',
    walletCapPeriod: 'optional',
  })

/* ------------------------------------------------------------------------------------------ */
/* 2. The in-memory BudgetStore, modelling FOR UPDATE                                             */
/* ------------------------------------------------------------------------------------------ */

/** A note attached to the store so a failure message can explain what was being modelled. */
export const FOR_UPDATE_HELD_NOTE =
  'createInMemoryBudgetStore models SELECT … FOR UPDATE by holding a per-mandate lock from ' +
  'lockBudgetAccount until updateBudgetAccount, and re-reading the row after the holder commits'

export interface InMemoryBudgetStore extends BudgetStore {
  /** Drop every queued lock. The transaction boundary in an in-memory world. */
  release(): void
  /** How many locks are currently held. A leaked lock shows up here. */
  heldLocks(): number
  /** A snapshot of every `budget_accounts` row, for assertions. */
  accounts(): Map<MandateId, BudgetAccountRow>
  /** The append-only ledger, for assertions. */
  entries(): BudgetEntryRow[]
  /** The wallet caps, for assertions. */
  caps(): Map<WalletId, WalletCapRow>
  /** Every lock acquisition, in order. Proves the serialisation actually happened. */
  lockLog(): Array<{ mandateId: MandateId; ticket: number; queuedBehind: number }>
  /** A copy of the whole store, for a transaction stand-in's rollback. */
  checkpoint(): BudgetStoreCheckpoint
  /** Undo everything written since `saved`. */
  restoreTo(saved: BudgetStoreCheckpoint): void
}

/** What {@link InMemoryBudgetStore.checkpoint} returns. Plain data, so a test can diff two of them. */
export interface BudgetStoreCheckpoint {
  readonly accounts: ReadonlyMap<MandateId, BudgetAccountRow>
  readonly entries: readonly BudgetEntryRow[]
  readonly caps: ReadonlyMap<WalletId, WalletCapRow>
}

export interface MemoryBudgetStoreOptions {
  readonly accounts?: readonly BudgetAccountRow[]
  readonly caps?: readonly WalletCapRow[]
  /**
   * Awaited inside `lockBudgetAccount` **after** the lock is acquired.
   *
   * This is how AT-M10.2 makes twenty concurrent attempts actually concurrent: without a rendezvous, the
   * first reserver could finish before the others were scheduled, the test would pass for the wrong
   * reason, and the number 3 would prove nothing.
   */
  readonly onLockAcquired?: (mandateId: MandateId) => Promise<void>
  /**
   * Model `SELECT … FOR UPDATE`, or do not. **Default `true`, and locking is mandatory in production.**
   *
   * `false` exists for exactly one test: the *control* in `test/budget.test.ts` that races twenty attempts
   * against a store with no lock, to demonstrate that it authorises $600 on a $100.00 budget. Without that
   * control, "exactly 3 ALLOW" cannot distinguish "the lock works" from "the arithmetic was never
   * exercised" — a test that only asserts the good outcome proves much less than it appears to.
   *
   * It is an option on the *test double* and deliberately not a flag on `GateDeps`, so no production code
   * path can reach it.
   */
  readonly serialiseLocks?: boolean
}

/**
 * An in-memory `BudgetStore` that models `SELECT … FOR UPDATE`.
 *
 * ### Why this exists rather than a real Postgres fixture
 *
 * AT-M10.2 is a claim about **concurrency**, and a real database makes that claim untestable in the way
 * it needs to be tested: with a connection pool, twenty concurrent Gate calls might serialise perfectly
 * or might not interleave at all, and either way "exactly 3 ALLOW" would be measuring the pool as much as
 * the lock. The in-memory store makes the interleaving *deterministic*, which is what a property test
 * needs.
 *
 * ### How the lock is modelled, precisely
 *
 * A promise **chain** per key, not a mutex:
 *
 * ```ts
 * const previous = queue.get(key) ?? Promise.resolve()
 * const mine = previous.then(() => readRow())   // read AFTER the holder wrote
 * queue.set(key, mine.catch(() => undefined))
 * ```
 *
 * Each waiter awaits the previous waiter's whole critical section — which is exactly what Postgres
 * guarantees. The `FOR UPDATE` lock is **held to the end of the transaction**, so the second transaction
 * blocks on its SELECT and only then re-reads. The re-read is the load-bearing part: the waiter sees
 * `reserved = 3000`, not the stale `0` it would have seen under `READ COMMITTED` without the lock. That
 * single difference is what turns twenty concurrent $30 reservations into three rather than twenty.
 *
 * `release()` clears the queue, standing in for COMMIT or ROLLBACK, and `heldLocks()` makes a leak
 * observable: a test that ends holding a lock has proved the reservation never settled.
 *
 * `walletSpendInPeriod` is summed from the same in-memory entries rather than a second counter, so the
 * wallet cap and the mandate cap cannot disagree — the discipline `packages/db` follows by summing
 * `budget_entries` for both.
 */
export function createInMemoryBudgetStore(
  options: MemoryBudgetStoreOptions = {},
): InMemoryBudgetStore {
  const accounts = new Map<MandateId, BudgetAccountRow>(
    (options.accounts ?? []).map((row) => [row.mandate_id, { ...row }]),
  )
  const caps = new Map<WalletId, WalletCapRow>(
    (options.caps ?? []).map((row) => [row.wallet_id, { ...row }]),
  )
  const entries: BudgetEntryRow[] = []
  const queue = new Map<string, Promise<unknown>>()
  const lockLog: Array<{ mandateId: MandateId; ticket: number; queuedBehind: number }> = []
  let ticket = 0

  /** One queue key per `budget_accounts` row — the row a `SELECT … FOR UPDATE` would lock. */
  const accountKey = (mandateId: MandateId) => `acct:${mandateId}`

  /** Append `fn` to `key`'s chain. The previous holder's promise is what makes it wait. */
  function serialise<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // `serialiseLocks: false` runs `fn` immediately — the no-lock control, and *only* the control.
    if (options.serialiseLocks === false) return fn()
    const previous = queue.get(key) ?? Promise.resolve()
    const mine = previous.then(fn, fn)
    queue.set(
      key,
      mine.then(
        () => undefined,
        () => undefined,
      ),
    )
    return mine
  }

  return {
    lockBudgetAccount(mandateId) {
      const key = accountKey(mandateId)
      // The same key `serialise` uses. Getting these two out of step would make `queuedBehind` always 0
      // and the contention test in `race.test.ts` would report no contention on a run that had plenty —
      // a test that cannot fail.
      const queuedBehind = queue.has(key) ? 1 : 0
      const myTicket = ticket++
      lockLog.push({ mandateId, ticket: myTicket, queuedBehind })
      // The read happens *inside* the chain, so it observes every write the previous holder made.
      return serialise(key, async () => {
        await options.onLockAcquired?.(mandateId)
        const row = accounts.get(mandateId)
        return row ? { ...row } : null
      })
    },

    async readBudgetAccount(id: MandateId) {
      const row = accounts.get(id)
      return row ? { ...row } : null
    },

    async insertBudgetAccount(account: NewBudgetAccountRow) {
      const row = { ...account } as unknown as BudgetAccountRow
      accounts.set(account.mandate_id as MandateId, row)
      return { ...row }
    },

    async updateBudgetAccount(mandateId, next, at) {
      const existing = accounts.get(mandateId)
      if (!existing) throw new Error(`No budget_accounts row for ${mandateId}`)
      const row: BudgetAccountRow = {
        ...existing,
        reserved_minor: next.reservedMinor,
        spent_minor: next.spentMinor,
        version: next.version,
        updated_at: at,
      }
      accounts.set(mandateId, row)
      return { ...row }
    },

    async insertBudgetEntry(entry: NewBudgetEntry) {
      const row = { ...entry } as unknown as BudgetEntryRow
      entries.push(row)
      return { ...row }
    },

    lockWalletCap(walletId) {
      // One wallet, one lock — the same `wallet_caps` row serialises every mandate under it (EC-MA-1).
      return serialise(`wallet:${walletId}`, async () => {
        const row = caps.get(walletId)
        return row ? { ...row } : null
      })
    },

    async sumEntriesByKind(mandateId) {
      const totals: Record<'RESERVE' | 'RELEASE' | 'COMMIT' | 'REVERSE', bigint> = {
        RESERVE: 0n,
        RELEASE: 0n,
        COMMIT: 0n,
        REVERSE: 0n,
      }
      for (const e of entries) {
        if (e.mandate_id !== mandateId) continue
        totals[e.kind] += e.amount_minor
      }
      return totals
    },

    async walletSpendInPeriod(walletId, currency, period, at, excludeAttemptId) {
      const windowMs = period === 'DAY' ? 86_400_000 : 30 * 86_400_000
      const sinceMs = at.getTime() - windowMs
      let reserved = 0n
      let released = 0n
      for (const e of entries) {
        // The mandate's wallet: `budget_accounts` is keyed by mandate, and `mandates.wallet_id` is what
        // groups them. The in-memory store is seeded with one mandate per wallet in every test that
        // exercises EC-MA-1, so the account row's presence *is* the wallet membership.
        if (!accounts.has(e.mandate_id as MandateId)) continue
        if (e.currency !== currency) continue
        if (e.at.getTime() < sinceMs) continue
        // Mirrors the drizzle store's exclusion (D-021): check 9 runs after check 8 has written this
        // attempt's RESERVE, so without omitting it the current cart is counted twice and the effective
        // wallet cap becomes `cap − cart`. Keeping this double faithful to `packages/db` is the whole
        // point of it existing — a double that drifts from the real query hides exactly this class of bug.
        if (excludeAttemptId !== undefined && e.attempt_id === excludeAttemptId) continue
        if (e.kind === 'RESERVE') reserved += e.amount_minor
        if (e.kind === 'RELEASE') released += e.amount_minor
      }
      return reserved - released
    },

    release() {
      for (const key of [...queue.keys()]) queue.delete(key)
    },

    /**
     * A copy of everything this store holds, for a transaction stand-in's rollback.
     *
     * Exists because a `ROLLBACK` undoes **writes** as well as locks. A test double that only released
     * locks would leave check 8's RESERVE behind when check 9 refused, and then AT-M10.4's "no leaked
     * reservation" would be measuring the double's fidelity rather than the Gate's behaviour — the test
     * would pass while the real Gate leaked. Restoring the *whole* store is what makes the double
     * faithful.
     */
    checkpoint() {
      return {
        accounts: new Map([...accounts.entries()].map(([k, v]) => [k, { ...v }])),
        entries: entries.map((e) => ({ ...e })),
        caps: new Map([...caps.entries()].map(([k, v]) => [k, { ...v }])),
      }
    },

    /** Undo everything since `saved`. Keys added since are removed; keys changed are put back. */
    restoreTo(saved: BudgetStoreCheckpoint) {
      accounts.clear()
      for (const [k, v] of saved.accounts) accounts.set(k, { ...v })
      entries.length = 0
      for (const e of saved.entries) entries.push({ ...e })
      caps.clear()
      for (const [k, v] of saved.caps) caps.set(k, { ...v })
    },

    heldLocks() {
      return queue.size
    },

    accounts() {
      return new Map([...accounts.entries()].map(([k, v]) => [k, { ...v }]))
    },

    entries() {
      return entries.map((e) => ({ ...e }))
    },

    caps() {
      return new Map([...caps.entries()].map(([k, v]) => [k, { ...v }]))
    },

    lockLog() {
      return [...lockLog]
    },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* 3. A complete in-memory GateDeps, for tests and Judge Mode                                     */
/* ------------------------------------------------------------------------------------------ */

export interface InMemoryGateWorldSeed {
  readonly nowSec?: number
  readonly mandate?: Partial<MandateRow>
  readonly agent?: Partial<RowOfAgents>
  readonly device?: Partial<RowOfDevices>
  /**
   * The `l1_credentials` row check 4 reads, as `sd_jwt`. `null` models a device×wallet with **no** L1 —
   * the real absence, not a malformed token — and is what check 4 must refuse by name.
   *
   * It exists because the in-memory world's `verify` is a stub, and a stub happily accepts whatever it is
   * handed. That is how `l1: ''` / `l2: ''` shipped: every gate test passed, and the production binding —
   * the one that runs `ViClient.verify`'s request validation — was never executed. So this row and
   * `mandate.l2_serialized` are now the only things standing between a gate test and the same
   * client-side refusal production got, and a test that wants the refusal can ask for it here.
   */
  readonly l1?: RowOfL1 | null
  readonly session?: Partial<CheckoutSessionRow>
  readonly products?: readonly ProductRow[]
  readonly budget?: { readonly cap: Money }
  /**
   * Extra mandates under the **same wallet**, each with its own budget.
   *
   * EC-MA-1 needs them: the wallet cap is a question about every mandate on a wallet, not about one of
   * them, so a world with a single mandate cannot express "two agents, one wallet" at all. Each entry gets
   * its own `budget_accounts` row — which is exactly why the wallet cap has to be a separate lock.
   */
  readonly extraMandates?: readonly { readonly id: MandateId; readonly cap: Money }[]
  readonly walletCap?: { readonly period: WalletCapPeriod; readonly cap: Money }
  readonly attempts?: readonly CheckoutAttemptRow[]
  readonly commits?: readonly { atMs: number }[]
  /**
   * The verify verdict check 4 reads, merged over a clean chain. **Claims only.**
   *
   * The signature itself is verified for real, by `verifySignatures` plus the world's own `verify` port —
   * see there for why that matters. Setting `chain_valid: false` here is how a test makes an *otherwise
   * valid* chain fail; it cannot be how a test makes a forged chain pass.
   *
   * `skipped` is typed loosely on purpose: it accepts the **annotated-string** wire shape `apps/vi` emitted
   * before D-019 as well as the `{type, reason}` objects, because `pendingNetworkEnforcement` parses both
   * and a test that could only express one of them would not be exercising what the service actually sends.
   */
  readonly verify?: Omit<Partial<VerifyResponse>, 'constraints'> & {
    readonly constraints?: Omit<VerifyResponse['constraints'], 'skipped'> & {
      readonly skipped?: readonly (string | { readonly type: string; readonly reason?: string })[]
    }
  }
  /** The merchant keys check 5 accepts. */
  readonly merchantKeys?: MerchantKeySet
  /** Replaces the default signer, e.g. to assert on the payload or to sign with a real key. */
  readonly signRecord?: GateDeps['signRecord']
  /**
   * How `/v1/verify` answers about the **signatures**: a function that receives the presented `l3a`/`l3b`
   * and returns whether the chain verifies.
   *
   * It exists because a stub that always answers `chain_valid: true` would make AT-M10.6's fuzz
   * meaningless. Byte-flipping a JWS **header** changes no claim the Gate reads — the `kid` it might have
   * changed is a single field among several — so against an always-valid verifier a header flip would
   * ALLOW, and the fuzz would report a critical finding that is an artefact of the double rather than of the
   * Gate. Real verification (against a real agent key, in the test fixtures) is what makes "0 ALLOWs"
   * mean something.
   *
   * It defaults to *accepting*, because the in-memory world has no key material of its own; every test
   * whose claim depends on signature verification passes one.
   */
  readonly verifySignatures?: (tokens: {
    l3a: string
    l3b: string
  }) => Promise<{ valid: boolean; errors: string[] }>
}

/**
 * What {@link createInMemoryGateWorld} returns.
 *
 * The counters exist for one reason: several of this package's acceptance tests are about **how many
 * times** something happened — check 7's insert happened exactly once, the sign happened exactly once, the
 * compensation released exactly once — and a counter is the only honest way to assert that.
 */
export interface InMemoryGateWorld {
  readonly deps: GateDeps
  readonly store: InMemoryBudgetStore
  readonly clock: ReturnType<typeof fixedClock>
  /** The mandate row. Mutate `status` to revoke mid-decision — that is AT-M10.4. */
  readonly mandate: MandateRow
  /** Every attempt row inserted, in order. */
  readonly insertedAttempts: CheckoutAttemptRow[]
  /** Every `suspendMandate` call. */
  readonly suspensions: Array<{ mandateId: MandateId; reason: string }>
  /** Every RESERVE entry written. */
  readonly reservations: Money[]
  /** Every RELEASE entry written. */
  readonly releases: Money[]
  /** The `jti`s the unique insert refused as replays. */
  readonly replays: string[]
  readonly setProducts: (rows: readonly ProductRow[]) => void
  readonly setAttemptStates: (states: AttemptState[]) => void
  /** Remove or replace the L1 mid-decision. `null` models the row ceasing to exist. */
  readonly setL1: (row: RowOfL1 | null) => void
  readonly balance: () => Promise<Result<BudgetBalance, CsError>>
  /** The reserved / spent / cap / version the Gate left behind. */
  readonly snapshot: () => {
    reserved: bigint
    spent: bigint
    cap: bigint
    version: number
    currency: Currency
  }
}

/**
 * A complete `GateDeps` over in-memory state.
 *
 * Exists so the Gate can be driven end-to-end — twelve checks, a decision record, a real signature — with
 * no Postgres, no vi-service and no PayPal. That is what makes AT-M10.2's twenty-way race and AT-M10.6's
 * thousand-mutation fuzz affordable on every commit, and it is the same world Judge Mode can use to
 * demonstrate a decision without provisioning a database.
 *
 * The two things it models **carefully** rather than trivially:
 *
 * - **`FOR UPDATE`**, via {@link createInMemoryBudgetStore} — otherwise AT-M10.2 would be a test of
 *   nothing, since a world without the lock would let twenty reservations through and the test would
 *   report the *absence* of a bug.
 * - **`transaction`**, which releases the store's queue in a `finally`. That is what makes "check 9 rolls
 *   back check 8's reservation" real rather than assumed, and it is the difference between AT-M10.4
 *   passing and AT-M10.4 passing for the wrong reason.
 */
export function createInMemoryGateWorld(seed: InMemoryGateWorldSeed = {}): InMemoryGateWorld {
  const nowSec = seed.nowSec ?? 1_760_000_000
  const clock = fixedClock(nowSec)

  const mandateId = (seed.mandate?.id ?? 'mdt_00000000000000000000000001') as MandateId
  const agentId = (seed.agent?.id ?? 'agt_00000000000000000000000001') as `agt_${string}`
  const deviceId = (seed.device?.id ?? 'dev_00000000000000000000000001') as `dev_${string}`
  const checkoutId = (seed.session?.id ?? 'chk_00000000000000000000000001') as CheckoutId
  const walletId = ((seed.mandate?.wallet_id as WalletId | undefined) ??
    'wal_00000000000000000000000001') as WalletId

  const mandateRow: MandateRow = {
    id: mandateId,
    user_id: 'usr_00000000000000000000000001',
    device_id: deviceId,
    agent_id: agentId,
    wallet_id: walletId,
    l2_serialized: 'l2_serialized',
    l2_payload: {},
    nl_intent: 'Buy running shoes up to $130.00 at Northwind',
    readback: 'Spend at most $130.00 at Northwind Outfitters',
    constraints: [],
    nonce: 'nonce-1',
    aud: 'https://merchant.example',
    iat: BigInt(nowSec - 3_600),
    exp: BigInt(nowSec + 86_400),
    status: 'ACTIVE',
    revoked_at: null,
    revoked_reason: null,
    webauthn_assertion: null,
    compiler_model: 'gpt-6.1-sol',
    compiler_trace_id: null,
    created_at: new Date(nowSec * 1000),
    updated_at: new Date(nowSec * 1000),
    ...(seed.mandate ?? {}),
  } as MandateRow

  const budgetCurrency = (seed.budget?.cap.currency ?? 'USD') as Currency

  // Every mandate in the world, keyed by id. One row per mandate is what makes EC-MA-1 expressible: two
  // agents on one wallet each have their own `budget_accounts` row, and the wallet cap is the only thing
  // that constrains them jointly.
  const mandateRows = new Map<MandateId, MandateRow>([[mandateId, mandateRow]])
  for (const extra of seed.extraMandates ?? []) {
    mandateRows.set(extra.id, { ...mandateRow, id: extra.id })
  }

  const account: BudgetAccountRow = {
    mandate_id: mandateId,
    currency: budgetCurrency,
    cap_minor: seed.budget?.cap.minor ?? 13_000n,
    reserved_minor: 0n,
    spent_minor: 0n,
    version: 0,
    created_at: new Date(nowSec * 1000),
    updated_at: new Date(nowSec * 1000),
  }

  const capRow: WalletCapRow | undefined = seed.walletCap
    ? {
        wallet_id: walletId,
        period: seed.walletCap.period,
        cap_minor: seed.walletCap.cap.minor,
        currency: seed.walletCap.cap.currency,
        created_at: new Date(nowSec * 1000),
        updated_at: new Date(nowSec * 1000),
      }
    : undefined

  const store = createInMemoryBudgetStore({
    accounts: [
      account,
      ...(seed.extraMandates ?? []).map((m) => ({
        mandate_id: m.id,
        currency: m.cap.currency,
        cap_minor: m.cap.minor,
        reserved_minor: 0n,
        spent_minor: 0n,
        version: 0,
        created_at: new Date(nowSec * 1000),
        updated_at: new Date(nowSec * 1000),
      })),
    ],
    ...(capRow ? { caps: [capRow] } : {}),
  })

  let products: ProductRow[] = [...(seed.products ?? [])]
  let attemptStates: AttemptState[] = (seed.attempts ?? []).map((a) => a.state as AttemptState)
  const seenJtis = new Set<string>((seed.attempts ?? []).map((a) => a.l3_jti))
  // `null` — not `undefined` — is the modelled *absence*, so `seed.l1: null` and "no seed given" are the
  // same thing here and neither can be confused with a row whose `sd_jwt` is empty. The default is a
  // non-empty stand-in rather than `''` for the reason above: a world that shipped `''` would have made
  // this defect invisible for another release.
  let l1: RowOfL1 | null = seed.l1 === undefined ? { sd_jwt: 'l1-sd-jwt' } : seed.l1

  const insertedAttempts: CheckoutAttemptRow[] = []
  const suspensions: Array<{ mandateId: MandateId; reason: string }> = []
  const reservations: Money[] = []
  const releases: Money[] = []
  const replays: string[] = []

  // Wrap the store so the world's counters see ledger writes without the store knowing about tests.
  const countingBudget: BudgetStore = {
    ...store,
    async insertBudgetEntry(entry) {
      if (entry.kind === 'RESERVE')
        reservations.push({ minor: entry.amount_minor, currency: entry.currency })
      if (entry.kind === 'RELEASE')
        releases.push({ minor: entry.amount_minor, currency: entry.currency })
      return store.insertBudgetEntry(entry)
    },
  }

  const verifySignature =
    seed.verifySignatures ?? (async () => ({ valid: true, errors: [] as string[] }))

  const baseVerifyResponse: VerifyResponse = {
    chain_valid: true,
    errors: [],
    constraints: {
      satisfied: true,
      violations: [],
      checked: ['mandate.payment.amount_range'],
      skipped: [],
    },
    disclosed: { l1: {}, l2: {}, l3a: {}, l3b: {} },
    keys: {},
    checks_performed: ['verify_chain', 'check_constraints'],
    checks_skipped: [],
    verified_at: nowSec,
    clock_skew_seconds: 300,
    at_time_not_honoured: false,
  }

  /**
   * The `/v1/verify` stand-in: real signature verification first, then the caller's claimed verdict.
   *
   * The order matters and is the point. `seed.verify.chain_valid` is applied **after** verification, so a
   * test can make a cryptographically valid chain fail (`chain_valid: false`) but **cannot** make a forged
   * one pass — a forged token's verdict is `chain_valid: false` whatever the seed says. That is what makes
   * AT-M10.6's "0 ALLOWs" a statement about the Gate's chain handling rather than about the double.
   */
  async function verifyWithSignatureCheck(tokens: {
    l3a: string
    l3b: string
  }): Promise<VerifyResponse> {
    const override = seed.verify ?? {}
    // `constraints` is merged field-by-field rather than spread wholesale, so a test overriding only
    // `skipped` keeps the default `checked`/`violations` instead of losing them.
    //
    // `skipped` goes through `normaliseSkipped`, which is the same parser `pendingNetworkEnforcement` uses:
    // the seed accepts the pre-D-019 annotated strings and they arrive as `{type, reason}` objects, exactly
    // as a real `/v1/verify` response would after `skippedConstraintSchema`'s transform.
    const constraintsOverride = override.constraints
    const claimed: VerifyResponse = {
      ...baseVerifyResponse,
      ...override,
      constraints: {
        ...baseVerifyResponse.constraints,
        ...(constraintsOverride ?? {}),
        skipped: normaliseSkipped(
          constraintsOverride?.skipped as Parameters<typeof normaliseSkipped>[0] | undefined,
        ),
      },
    }
    const signature = await verifySignature(tokens)
    if (!signature.valid) {
      return { ...claimed, chain_valid: false, errors: signature.errors }
    }
    return claimed
  }

  const session = sessionRow(seed, checkoutId, nowSec, products)

  const deps: GateDeps = defineGateDeps({
    clock,

    budget: countingBudget,

    // Returns the *live* row, so a test that flips `mandate.status` sees it here. That is how AT-M10.4
    // revokes a mandate between checks.
    mandate: async (id) => ok(mandateRows.get(id)),
    lockMandate: async (id) => ok(mandateRows.get(id)),

    transaction: async (fn) => {
      // **Snapshot-and-restore**, not just lock release. A Postgres `ROLLBACK` undoes the writes as well
      // as releasing the locks. A stand-in that only released locks would leave check 8's RESERVE behind
      // when check 9 refused, and then AT-M10.4's "no leaked reservation" would be measuring the
      // stand-in's fidelity rather than the Gate's behaviour — the test would go green while the real
      // Gate leaked. Restoring the whole store is what makes the double faithful.
      const saved = store.checkpoint()
      let rolledBack = false
      const tx: GateTx = {
        rollback() {
          rolledBack = true
          store.restoreTo(saved)
          reservations.length = 0
          releases.length = 0
          // The counters are the world's own bookkeeping, so a rollback has to un-count them too.
          for (const e of saved.entries) {
            if (e.kind === 'RESERVE')
              reservations.push({ minor: e.amount_minor, currency: e.currency })
            if (e.kind === 'RELEASE') releases.push({ minor: e.amount_minor, currency: e.currency })
          }
        },
        get rolledBack() {
          return rolledBack
        },
      }
      try {
        return await fn(tx)
      } finally {
        // COMMIT or ROLLBACK: either way the row locks go away.
        store.release()
      }
    },

    agent: async (id) =>
      ok(
        id === agentId
          ? {
              id: agentId,
              kid: seed.agent?.kid ?? 'agent-key-1',
              status: seed.agent?.status ?? 'ACTIVE',
            }
          : undefined,
      ),

    device: async (id) =>
      ok(id === deviceId ? { id: deviceId, status: seed.device?.status ?? 'ACTIVE' } : undefined),

    findL1ForDeviceWallet: async (requestedDevice, requestedWallet) =>
      // The device×wallet pair must match, exactly as §7.2's unique index requires. A lookup that ignored
      // either half would let one device's credential stand in for another's.
      ok(
        requestedDevice === deviceId && requestedWallet === walletId && l1 !== null
          ? l1
          : undefined,
      ),

    verify: async (request) => {
      // ### The real client's own pre-flight, run here on purpose
      //
      // `ViClient.verify` validates its request through `verifyRequestSchema` **before the first fetch**
      // (`vi-client/src/client.ts::call`), and that schema declares `l1` and `l2` as `boundedString(…)`,
      // i.e. `min(1)`. This double used to skip straight to its answer, which is precisely how
      // `checks.ts` shipped `l1: ''` / `l2: ''`: every gate test called a stub that accepts an empty
      // chain, so the production binding was never exercised and a defect that BLOCKed every decision in
      // the product was invisible in the suite.
      //
      // Validating here makes every gate test a guard against that class of bug. It is a *faithful*
      // addition, not a stricter one: the failure is the same `CS_VALIDATION` `err` the real client
      // returns, with no fetch attempted, so a test that trips it is learning exactly what production
      // would have learned.
      const checked = verifyRequestSchema.safeParse(request)
      if (!checked.success) {
        return err(
          csError(
            'CS_VALIDATION',
            `POST /v1/verify request failed validation: ${checked.error.issues
              .slice(0, 8)
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; ')}`,
            {
              issues: checked.error.issues
                .slice(0, 8)
                .map((i) => ({ path: i.path.join('.'), message: i.message })),
            },
          ),
        )
      }
      return ok(await verifyWithSignatureCheck({ l3a: request.l3a ?? '', l3b: request.l3b ?? '' }))
    },

    checkout: async (id) => (id === checkoutId ? ok(session) : ok(undefined)),

    merchantKeys: async () =>
      ok(seed.merchantKeys ?? { currentKid: 'merchant-1', acceptedKids: ['merchant-1'], jwks: {} }),

    insertAttempt: async (input: NewAttemptForGate) => {
      // The unique `l3_jti` index *is* check 7. A `23505` becomes `GATE_REPLAY`, which is what
      // `repos/index.ts::CONSTRAINT_CODES` does in production.
      if (seenJtis.has(input.l3_jti)) {
        replays.push(input.l3_jti)
        return err(
          csError(
            'GATE_REPLAY',
            `Duplicate rejected by unique constraint checkout_attempts_l3_jti_key: ${input.l3_jti}`,
            {
              table: 'checkout_attempts',
              l3Jti: input.l3_jti,
              constraint: 'checkout_attempts_l3_jti_key',
            },
          ),
        )
      }
      seenJtis.add(input.l3_jti)
      const row = {
        id: input.id,
        mandate_id: input.mandate_id,
        agent_id: input.agent_id,
        checkout_session_id: input.checkout_session_id,
        l3a: input.l3a,
        l3b: input.l3b,
        l3_jti: input.l3_jti,
        idempotency_key: input.idempotency_key,
        amount_minor: input.amount_minor,
        currency: input.currency,
        payee: input.payee,
        state: 'CREATED',
        gate_decision_id: null,
        created_at: new Date(nowSec * 1000),
        updated_at: new Date(nowSec * 1000),
      } as unknown as CheckoutAttemptRow
      insertedAttempts.push(row)
      return ok(row)
    },

    products: async (skus) => ok(products.filter((p) => skus.includes(p.sku))),

    countCommitsSince: async (_id, since) =>
      ok((seed.commits ?? []).filter((c) => c.atMs >= since.getTime()).length),

    countRecentAttempts: async (_id, _since) => ok(attemptStates.length),

    recentAttemptStates: async (_id, limit) => ok(attemptStates.slice(0, limit)),

    suspendMandate: async (id, reason) => {
      suspensions.push({ mandateId: id, reason })
      mandateRow.status = 'SUSPENDED'
      return ok(true as const)
    },

    walletCapPeriod: async (id) =>
      id === walletId ? ok(seed.walletCap?.period ?? undefined) : ok(undefined),

    signRecord: seed.signRecord ?? (async (payload) => ok(`unsigned:${payload.gdc}`)),
  })

  return {
    deps,
    store,
    clock,
    mandate: mandateRow,
    insertedAttempts,
    suspensions,
    reservations,
    releases,
    replays,
    setProducts: (rows) => {
      products = [...rows]
    },
    setL1: (row) => {
      l1 = row
    },
    setAttemptStates: (states) => {
      attemptStates = [...states]
    },
    balance: async () => {
      // Reads the store's *live* map, not the seeded object: `updateBudgetAccount` replaces the row, so
      // closing over the seed would report the balances from before any reservation and every
      // "the buyer's money went back" assertion would pass for the wrong reason.
      const snap = liveSnapshot()
      return ok({
        mandateId,
        currency: snap.currency,
        cap: { minor: snap.cap, currency: snap.currency },
        reserved: { minor: snap.reserved, currency: snap.currency },
        spent: { minor: snap.spent, currency: snap.currency },
        available: { minor: snap.cap - snap.reserved - snap.spent, currency: snap.currency },
        version: snap.version,
      })
    },
    snapshot: liveSnapshot,
  }

  function liveSnapshot(): {
    reserved: bigint
    spent: bigint
    cap: bigint
    version: number
    currency: Currency
  } {
    const row = store.accounts().get(mandateId)
    if (!row) {
      return { reserved: 0n, spent: 0n, cap: 0n, version: 0, currency: budgetCurrency }
    }
    return {
      reserved: row.reserved_minor,
      spent: row.spent_minor,
      cap: row.cap_minor,
      version: row.version,
      currency: row.currency,
    }
  }
}

/** A `checkout_sessions` row with the shape the Gate reads, derived from the seeded products. */
function sessionRow(
  seed: InMemoryGateWorldSeed,
  id: CheckoutId,
  nowSec: number,
  products: readonly ProductRow[],
): CheckoutSessionRow {
  const lines = products.map((p) => ({ sku: p.sku, qty: 1, unit_minor: p.price_minor }))
  const subtotal = lines.reduce((acc, l) => acc + l.unit_minor, 0n)
  const currency = (products[0]?.currency ?? 'USD') as Currency
  return {
    id,
    merchant_id: 'MERCHANT_NORTHWIND',
    cart: { lines },
    subtotal_minor: subtotal,
    tax_minor: 0n,
    shipping_minor: 0n,
    total_minor: subtotal,
    currency,
    checkout_jwt: 'eyJhbGciOiJFZERTQSJ9.eyJzdW0iOjEwfQ.c2ln',
    checkout_hash: 'hash-1',
    price_lock_exp: new Date((nowSec + 900) * 1000),
    status: 'CREATED',
    created_at: new Date(nowSec * 1000),
    updated_at: new Date(nowSec * 1000),
    ...(seed.session ?? {}),
  } as unknown as CheckoutSessionRow
}

/** Re-exported so a test can name an attempt or mandate id without a second import. */
export type { AttemptId, GateDecisionId }
