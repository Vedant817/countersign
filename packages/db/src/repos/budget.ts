/**
 * `budget_accounts`, `budget_entries` and `wallet_caps` — spec **§7.2**, **§8.10 checks 8 and 9**,
 * **§8.11** (ledger hooks), decision **D19**. Other packages call these functions; the signatures
 * below are the contract.
 *
 * ## Why every mutation takes `FOR UPDATE`
 *
 * The budget is a read-modify-write on two integers: "does `reserved + spent + amount <= cap` still
 * hold?" then "write the new `reserved`". Under `READ COMMITTED` two concurrent agents both read
 * `reserved = 0, spent = 0, cap = 100`, both see `30 <= 100`, and both write `reserved = 30` — a
 * $100 budget that authorised $60. `SELECT … FOR UPDATE` takes a row-level exclusive lock that is
 * held to the end of the transaction, so the second transaction blocks on the SELECT, re-reads the
 * committed `reserved = 30`, and correctly refuses.
 *
 * This is D19 ("budget mutations happen under `SELECT … FOR UPDATE`, never optimistically"), and it is
 * the mechanism behind three spec requirements:
 *
 *  - **AT-M10.2**: a 20-way concurrent race on a $100 budget with $30 carts yields exactly 3 ALLOWs.
 *    That number falls out of the lock; it is not a coincidence.
 *  - **Gate check 8 → `GATE_BUDGET_EXCEEDED`**, and check 9 → `GATE_WALLET_CAP` (EC-MA-1: two agents
 *    on one wallet, serialised through the `wallet_caps` row rather than through any mandate row).
 *  - **AT-M10.4**: a mandate revoked between check 1 and check 8 leaves no leaked reservation,
 *    because the reservation and the attempt row commit or roll back together in one transaction.
 *
 * The schema's CHECK constraint (`budget_accounts_reserved_plus_spent_le_cap`) is the **backstop**,
 * not the mechanism: the lock makes the read-modify-write correct, the CHECK makes the invariant true
 * even if something bypasses this file.
 *
 * ## Testability
 *
 * Every function comes in two forms:
 *
 *  - `reserve(mandateId, attemptId, amount, tx?)` — the real one; `tx` is a Drizzle executor or
 *    `client.withTx`'s handle.
 *  - `reserveIn(store, …)` — the same logic against a {@link BudgetStore}, a narrow port that names
 *    exactly the statements the budget needs. `drizzleStore(exec)` builds one from Drizzle.
 *
 * That split is why `test/schema.test.ts` can prove "an over-cap reservation writes nothing" with a
 * plain object and no Postgres: the invariant is tested against the logic, and the SQL shape is
 * asserted separately from the schema. **No PayPal is involved anywhere** — that is our own database
 * (AGENTS.md rule 5 applies to PayPal, not to this).
 */
import { and, eq, ne, sql } from 'drizzle-orm'

import {
  money as makeMoney,
  newId,
  type AttemptId,
  type CsError,
  type Currency,
  type MandateId,
  type Money,
  type Result,
  type WalletId,
} from '@countersign/core'

import { db, type Exec } from '../client'
import {
  budgetAccounts,
  budgetEntries,
  mandates,
  walletCaps,
  type BudgetAccountRow,
  type BudgetEntryRow,
  type NewBudgetEntry,
  type WalletCapRow,
} from '../schema'
import { err, now, repo, toMoney } from './index'

/* ------------------------------------------------------------------------------------------ */
/* Types                                                                                           */
/* ------------------------------------------------------------------------------------------ */

export type WalletCapPeriod = 'DAY' | 'MONTH'
export type BudgetEntryKind = 'RESERVE' | 'RELEASE' | 'COMMIT' | 'REVERSE'

/** What `budget_accounts` holds after a successful mutation. `version` is the Gate's `budgetVersion`. */
export interface BudgetBalance {
  readonly mandateId: MandateId
  readonly currency: Currency
  readonly cap: Money
  readonly reserved: Money
  readonly spent: Money
  /** `reserved + spent + requested <= cap`? The whole point of check 8. */
  readonly available: Money
  /** Increments on every mutation, so a Gate decision pins the exact balance it approved. */
  readonly version: number
}

/** Gate check 9's answer. `ok: false` means block with `GATE_WALLET_CAP`. */
export type WalletCapVerdict =
  | { ok: true; cap: Money }
  | { ok: false; requested: Money; cap: Money }

/** Drift between `budget_accounts` and the append-only `budget_entries` (the nightly check). */
export interface ReconcileReport {
  readonly mandateId: MandateId
  readonly currency: Currency
  readonly stored: { reserved: Money; spent: Money }
  readonly computed: { reserved: Money; spent: Money }
  readonly drift: { reserved: Money; spent: Money }
  readonly ok: boolean
}

/**
 * The narrow transaction port this repo needs — six statements, named.
 *
 * Deliberately not "the whole Drizzle surface": a port this narrow can be faked in a unit test, which
 * is what lets `test/schema.test.ts` assert that an over-cap reservation leaves **no** row behind
 * without a running Postgres. Every method is documented with the SQL it must perform, so the adapter
 * and the fake cannot drift apart silently.
 */
export interface BudgetStore {
  /** `SELECT … FROM budget_accounts WHERE mandate_id = $1 FOR UPDATE`. Returns the locked row or null. */
  lockBudgetAccount(mandateId: MandateId): Promise<BudgetAccountRow | null>
  /** `INSERT INTO budget_accounts (mandate_id, …) VALUES (…)`. One per mandate. */
  insertBudgetAccount(account: NewBudgetAccountRow): Promise<BudgetAccountRow>
  /** `UPDATE budget_accounts SET reserved_minor, spent_minor, version, updated_at WHERE mandate_id = $1`. */
  updateBudgetAccount(
    mandateId: MandateId,
    next: { reservedMinor: bigint; spentMinor: bigint; version: number },
    at: Date,
  ): Promise<BudgetAccountRow>
  /** `INSERT INTO budget_entries (…) VALUES (…)`. Append-only: no update, no delete. */
  insertBudgetEntry(entry: NewBudgetEntry): Promise<BudgetEntryRow>
  /** `SELECT … FROM wallet_caps WHERE wallet_id = $1 FOR UPDATE`. Gate check 9 / EC-MA-1. */
  lockWalletCap(walletId: WalletId): Promise<WalletCapRow | null>
  /** `SELECT kind, SUM(amount_minor) FROM budget_entries WHERE mandate_id = $1 GROUP BY kind`. */
  sumEntriesByKind(mandateId: MandateId): Promise<Record<BudgetEntryKind, bigint>>
  /**
   * The wallet's claimed capacity in the period:
   * `Σ RESERVE − Σ RELEASE − Σ COMMIT + Σ COMMIT` = `Σ RESERVE − Σ RELEASE`.
   *
   * A reservation claims wallet capacity, a release frees it, and a commit merely converts a claim
   * into a spend — so including COMMIT would count a settled purchase twice. Reservations are included
   * because money not yet captured under one mandate can be captured under it moments later.
   *
   * `excludeAttemptId` omits one attempt's entries. It exists because **Gate check 9 runs after check
   * 8 has already inserted this attempt's RESERVE** (spec §8.10 fixes that order), and without the
   * exclusion the current cart is counted once by the ledger and once by `amount`, so the effective
   * wallet cap silently becomes `cap − cart`. A $150 cap with $30 carts would allow 4 reservations
   * instead of 5. Found by WP-10's Gate tests; see docs/DECISIONS.md D-021.
   */
  walletSpendInPeriod(
    walletId: WalletId,
    currency: Currency,
    period: WalletCapPeriod,
    at: Date,
    excludeAttemptId?: AttemptId,
  ): Promise<bigint>
  /** `SELECT … FROM budget_accounts WHERE mandate_id = $1` — no lock, for reads and `balance()`. */
  readBudgetAccount(mandateId: MandateId): Promise<BudgetAccountRow | null>
}

/** The insert shape for a budget account, without drizzle's table wrapper. */
export type NewBudgetAccountRow = typeof budgetAccounts.$inferInsert

/* ------------------------------------------------------------------------------------------ */
/* Drizzle adapter                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * Build a {@link BudgetStore} from a Drizzle executor (pool handle or transaction).
 *
 * `FOR UPDATE` is part of each statement, not an option: a caller cannot accidentally take a
 * read-modify-write path without the lock, because the lock is baked into the only method that can
 * produce the row it is about to modify.
 */
export function drizzleStore(exec: Exec = db()): BudgetStore {
  return {
    async lockBudgetAccount(mandateId) {
      const rows = await exec
        .select()
        .from(budgetAccounts)
        .where(eq(budgetAccounts.mandate_id, mandateId))
        .for('update')
      return (rows[0] as BudgetAccountRow | undefined) ?? null
    },
    async readBudgetAccount(mandateId) {
      const rows = await exec
        .select()
        .from(budgetAccounts)
        .where(eq(budgetAccounts.mandate_id, mandateId))
        .limit(1)
      return (rows[0] as BudgetAccountRow | undefined) ?? null
    },
    async insertBudgetAccount(account) {
      const rows = await exec.insert(budgetAccounts).values(account).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no budget_accounts row')
      return row as BudgetAccountRow
    },
    async updateBudgetAccount(mandateId, next, at) {
      const rows = await exec
        .update(budgetAccounts)
        .set({
          reserved_minor: next.reservedMinor,
          spent_minor: next.spentMinor,
          version: next.version,
          updated_at: at,
        })
        .where(eq(budgetAccounts.mandate_id, mandateId))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No budget_accounts row for ${mandateId}`)
      return row as BudgetAccountRow
    },
    async insertBudgetEntry(entry) {
      const rows = await exec.insert(budgetEntries).values(entry).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no budget_entries row')
      return row as BudgetEntryRow
    },
    async lockWalletCap(walletId) {
      const rows = await exec
        .select()
        .from(walletCaps)
        .where(eq(walletCaps.wallet_id, walletId))
        .for('update')
      return (rows[0] as WalletCapRow | undefined) ?? null
    },
    async sumEntriesByKind(mandateId) {
      const rows = await exec
        .select({
          kind: budgetEntries.kind,
          total: sql<bigint>`coalesce(sum(${budgetEntries.amount_minor}), 0)`,
        })
        .from(budgetEntries)
        .where(eq(budgetEntries.mandate_id, mandateId))
        .groupBy(budgetEntries.kind)
      const totals: Record<BudgetEntryKind, bigint> = {
        RESERVE: 0n,
        RELEASE: 0n,
        COMMIT: 0n,
        REVERSE: 0n,
      }
      for (const r of rows) totals[r.kind] = r.total
      return totals
    },
    async walletSpendInPeriod(walletId, currency, period, at, excludeAttemptId) {
      const since = new Date(
        at.getTime() - (period === 'DAY' ? 24 * 60 * 60_000 : 30 * 24 * 60 * 60_000),
      )
      const rows = await exec
        .select({
          reserved: sql<bigint>`coalesce(sum(${budgetEntries.amount_minor}) filter (where ${budgetEntries.kind} = 'RESERVE'), 0)`,
          released: sql<bigint>`coalesce(sum(${budgetEntries.amount_minor}) filter (where ${budgetEntries.kind} = 'RELEASE'), 0)`,
        })
        .from(budgetEntries)
        .innerJoin(mandates, eq(budgetEntries.mandate_id, mandates.id))
        .where(
          and(
            eq(mandates.wallet_id, walletId),
            eq(budgetEntries.currency, currency),
            sql`${budgetEntries.at} >= ${since}`,
            // Gate check 9 runs after check 8 has reserved this attempt's cart, so excluding it is what
            // stops the current cart being counted twice. See the BudgetStore docstring (D-021).
            excludeAttemptId ? ne(budgetEntries.attempt_id, excludeAttemptId) : undefined,
          ),
        )
      const row = rows[0]
      return row ? row.reserved - row.released : 0n
    },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Money-free arithmetic helpers                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * The ledger identity of an amount, derived from the entries.
 *
 * `reserved = Σ RESERVE − Σ RELEASE − Σ COMMIT` and `spent = Σ COMMIT`.
 *
 * COMMIT appears in both legs on purpose: it moves money *out of* reserved and *into* spent in one
 * step, so it has to decrement the reservation as well as increment the spend. Leaving it out of the
 * reserved leg would make every settled purchase look like a leaked reservation and would make the
 * nightly reconcile report drift on a perfectly healthy ledger.
 *
 * `REVERSE` is **audit-only** (spec §8.11: "chargeback reversal → REVERSE entry for the audit only"), so
 * it deliberately does not move either balance — a refund and a chargeback both leave the money that
 * was authorised spent, because the authority was granted, and pretending otherwise would let a dispute
 * reset a buyer's limit.
 */
export function computeFromEntries(totals: Record<BudgetEntryKind, bigint>): {
  reserved: bigint
  spent: bigint
} {
  const reserved = totals.RESERVE - totals.RELEASE - totals.COMMIT
  const spent = totals.COMMIT
  return { reserved: reserved < 0n ? 0n : reserved, spent: spent < 0n ? 0n : spent }
}

/** An over-cap reservation: the exact error the Gate turns into `GATE_BUDGET_EXCEEDED`. */
export function budgetExceeded(
  mandateId: MandateId,
  requested: Money,
  available: Money,
  cap: Money,
): CsError {
  return {
    code: 'GATE_BUDGET_EXCEEDED',
    message:
      `Mandate ${mandateId}: ${requested.minor} requested, ${available.minor} available of a ` +
      `${cap.minor} ${cap.currency} cap`,
    userMessage: `This purchase would take you past the limit you signed.`,
    retryable: false,
    details: {
      table: 'budget_accounts',
      mandateId,
      requestedMinor: requested.minor.toString(),
      availableMinor: available.minor.toString(),
      capMinor: cap.minor.toString(),
      currency: cap.currency,
    },
  }
}

/** A wallet cap refusal: `GATE_WALLET_CAP`, EC-MA-1. */
export function walletCapExceeded(walletId: WalletId, requested: Money, cap: Money): CsError {
  return {
    code: 'GATE_WALLET_CAP',
    message: `Wallet ${walletId}: ${requested.minor} requested exceeds the remaining ${cap.minor} ${cap.currency}`,
    userMessage: 'This purchase would pass your wallet-level cap.',
    retryable: false,
    details: {
      table: 'wallet_caps',
      walletId,
      requestedMinor: requested.minor.toString(),
      capMinor: cap.minor.toString(),
      currency: cap.currency,
    },
  }
}

/** Currency mismatch between a mandate budget and a requested amount: EC-FX-1, never converted. */
function currencyMismatch(where: string, have: Currency, want: Currency): CsError {
  return {
    code: 'CS_CURRENCY_MISMATCH',
    message: `${where} is ${have}; requested amount is ${want}. We never convert inside the budget.`,
    userMessage: `Your limit and this purchase are in different currencies, so we did not convert them. Create a mandate in the store currency.`,
    retryable: false,
    details: { budgetCurrency: have, requestCurrency: want },
  }
}

function toBalance(row: BudgetAccountRow): BudgetBalance {
  const cap = toMoney(row.cap_minor, row.currency)
  const reserved = toMoney(row.reserved_minor, row.currency)
  const spent = toMoney(row.spent_minor, row.currency)
  const remaining = row.cap_minor - row.reserved_minor - row.spent_minor
  return {
    mandateId: row.mandate_id,
    currency: row.currency,
    cap,
    reserved,
    spent,
    available: makeMoney(remaining < 0n ? 0n : remaining, row.currency),
    version: row.version,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Account creation and reads                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Insert shape: a cap, in a currency. The balances start at zero. */
export interface OpenBudgetInput {
  readonly mandateId: MandateId
  readonly cap: Money
  readonly exec?: Exec
  readonly at?: Date
}

/**
 * Open a budget for a mandate. Idempotent by `mandate_id` (the primary key): re-opening an existing
 * budget returns the existing row rather than resetting it, because a second cap insert would
 * silently re-arm a spent budget.
 */
export function openBudget(input: OpenBudgetInput): Promise<Result<BudgetAccountRow, CsError>> {
  const exec = input.exec
  return repo(
    async () => {
      const store = drizzleStore(exec ?? db())
      const existing = await store.readBudgetAccount(input.mandateId)
      if (existing) return existing
      return store.insertBudgetAccount({
        mandate_id: input.mandateId,
        currency: input.cap.currency,
        cap_minor: input.cap.minor,
        reserved_minor: 0n,
        spent_minor: 0n,
        version: 0,
        created_at: input.at,
        updated_at: input.at,
      })
    },
    { table: 'budget_accounts', mandateId: input.mandateId },
  )
}

/** Read-only balance. No lock: this is what the UI reads and it must never block a writer. */
export function balance(
  mandateId: MandateId,
  exec?: Exec,
): Promise<Result<BudgetBalance, CsError>> {
  return repo(
    async () => {
      const store = drizzleStore(exec ?? db())
      const row = await store.readBudgetAccount(mandateId)
      if (!row) {
        return err({
          code: 'CS_NOT_FOUND',
          message: `No budget_accounts row for ${mandateId}`,
          userMessage: 'We could not find that limit.',
          retryable: false,
          details: { table: 'budget_accounts', mandateId },
        })
      }
      return toBalance(row)
    },
    { table: 'budget_accounts', mandateId },
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Gate check 8 — RESERVE                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface ReserveInput {
  readonly attemptId: AttemptId
  readonly amount: Money
  /**
   * `ben_`-prefixed id from `newId('ben')`. **Required**, not defaulted: the ledger is append-only,
   * so an entry's identity has to be decided before it is written, and a retry of the same operation
   * should be able to reuse the same id and hit the primary key instead of writing a second entry.
   */
  readonly entryId: string
  readonly at?: Date
}

/** Gate check 8. Returns the new `budgetVersion` alongside the balance it reserved against. */
export interface ReserveResult {
  readonly balance: BudgetBalance
  readonly entry: BudgetEntryRow
}

/**
 * Reserve `amount` against a mandate's cap. **Gate check 8.**
 *
 * Inside one transaction (call it with `client.withTx`'s `tx`, together with the `checkout_attempts`
 * insert):
 *
 *  1. `SELECT … FROM budget_accounts WHERE mandate_id = $1 FOR UPDATE` — serialises every other
 *     reserver for this mandate.
 *  2. Check `reserved + spent + amount <= cap`. Refusing here, after the lock, is what makes
 *     AT-M10.2's "exactly 3 ALLOWs of 20" true.
 *  3. `INSERT` a `RESERVE` entry — append-only, so the reservation has a reason on the ledger even if
 *     the account row is later rebuilt by {@link reconcile}.
 *  4. Bump `reserved_minor` and `version`.
 *
 * @returns `err(GATE_BUDGET_EXCEEDED)` when the cap would be passed. Nothing is written in that case,
 * so the transaction leaves no partial row.
 */
export function reserveIn(
  store: BudgetStore,
  mandateId: MandateId,
  input: ReserveInput,
): Promise<Result<ReserveResult, CsError>> {
  return repo(
    async () => {
      const at = input.at ?? now()
      const row = await store.lockBudgetAccount(mandateId)
      if (!row) {
        return err({
          code: 'CS_NOT_FOUND',
          message: `No budget_accounts row for ${mandateId}`,
          userMessage: 'We could not find that limit.',
          retryable: false,
          details: { table: 'budget_accounts', mandateId },
        })
      }
      if (row.currency !== input.amount.currency) {
        return err(currencyMismatch(`Budget for ${mandateId}`, row.currency, input.amount.currency))
      }

      const reservedMinor = row.reserved_minor
      const spentMinor = row.spent_minor
      const nextReserved = reservedMinor + input.amount.minor
      if (nextReserved + spentMinor > row.cap_minor) {
        const availableMinor = row.cap_minor - reservedMinor - spentMinor
        const available = makeMoney(availableMinor < 0n ? 0n : availableMinor, row.currency)
        const cap = toMoney(row.cap_minor, row.currency)
        // No write happens after this point, so "leaves no partial row" is structural.
        return err(budgetExceeded(mandateId, input.amount, available, cap))
      }

      const version = row.version + 1
      const entry = await store.insertBudgetEntry({
        id: input.entryId,
        mandate_id: mandateId,
        attempt_id: input.attemptId,
        kind: 'RESERVE',
        amount_minor: input.amount.minor,
        at,
        reason: 'gate check 8 reserve',
        capture_id: null,
        currency: row.currency,
      })
      const updated = await store.updateBudgetAccount(
        mandateId,
        { reservedMinor: nextReserved, spentMinor, version },
        at,
      )
      return { balance: toBalance(updated), entry }
    },
    { table: 'budget_accounts', mandateId, op: 'reserve' },
  )
}

/** `reserveIn` against a Drizzle executor. Signature used by the Gate and the orchestrator. */
export function reserve(
  mandateId: MandateId,
  attemptId: AttemptId,
  amount: Money,
  exec?: Exec,
): Promise<Result<ReserveResult, CsError>> {
  return reserveIn(drizzleStore(exec ?? db()), mandateId, {
    attemptId,
    amount,
    entryId: newId('ben'),
  })
}

/* ------------------------------------------------------------------------------------------ */
/* RELEASE                                                                                         */
/* ------------------------------------------------------------------------------------------ */

export interface ReleaseInput {
  readonly attemptId: AttemptId
  readonly amount: Money
  /** `OUT_OF_STOCK` | `REVOKED` | `CANCELLED` | `EXPIRED` | `NO_ORDER` | `MANUAL`. */
  readonly reason: string
  readonly at?: Date
  readonly entryId: string
}

/**
 * Release a reservation. Spec §8.11: "void/decline/expiry → RELEASE", and §8.10: "Reservations expire
 * after 30 min without an order (a worker job releases them)".
 *
 * Clamped at the current `reserved` rather than allowed to go negative: two releases for one attempt
 * (a timeout sweep plus an explicit void) must not credit the buyer with authority that was never
 * reserved. The clamp is logged in the entry's `reason` so the discrepancy is visible rather than
 * hidden.
 */
export function releaseIn(
  store: BudgetStore,
  mandateId: MandateId,
  input: ReleaseInput,
): Promise<Result<BudgetBalance, CsError>> {
  return repo(
    async () => {
      const at = input.at ?? now()
      const row = await store.lockBudgetAccount(mandateId)
      if (!row) {
        return err({
          code: 'CS_NOT_FOUND',
          message: `No budget_accounts row for ${mandateId}`,
          userMessage: 'We could not find that limit.',
          retryable: false,
          details: { table: 'budget_accounts', mandateId },
        })
      }
      if (row.currency !== input.amount.currency) {
        return err(currencyMismatch(`Budget for ${mandateId}`, row.currency, input.amount.currency))
      }

      const released =
        input.amount.minor > row.reserved_minor ? row.reserved_minor : input.amount.minor
      const clamped = released !== input.amount.minor
      const nextReserved = row.reserved_minor - released
      const version = row.version + 1
      await store.insertBudgetEntry({
        id: input.entryId,
        mandate_id: mandateId,
        attempt_id: input.attemptId,
        kind: 'RELEASE',
        amount_minor: released,
        at,
        reason: clamped ? `${input.reason} (clamped to reserved)` : input.reason,
        capture_id: null,
        currency: row.currency,
      })
      const updated = await store.updateBudgetAccount(
        mandateId,
        { reservedMinor: nextReserved, spentMinor: row.spent_minor, version },
        at,
      )
      return toBalance(updated)
    },
    { table: 'budget_accounts', mandateId, op: 'release' },
  )
}

export function release(
  mandateId: MandateId,
  attemptId: AttemptId,
  amount: Money,
  reason: string,
  exec?: Exec,
): Promise<Result<BudgetBalance, CsError>> {
  return releaseIn(drizzleStore(exec ?? db()), mandateId, {
    attemptId,
    amount,
    reason,
    entryId: newId('ben'),
  })
}

/* ------------------------------------------------------------------------------------------ */
/* COMMIT                                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface CommitInput {
  readonly captureId: string
  readonly amount: Money
  readonly at?: Date
  readonly entryId: string
}

/**
 * Move `reserved → spent` for a completed capture. Spec §8.11: "capture COMPLETED → COMMIT".
 *
 * Both legs move by the same amount: the reservation is consumed *and* the spend is recorded, so
 * `reserved + spent` is unchanged by a commit. That is why the CHECK constraint stays satisfied and
 * why `balance.available` does not grow after a purchase.
 *
 * @returns `err(GATE_BUDGET_EXCEEDED)` if there was not enough reserved — which means a capture
 * happened without a matching reservation, i.e. an orchestrator bug or a manual PayPal capture.
 * Failing loudly is correct: silently creating the spend would let money leave with no signed basis.
 */
export function commitIn(
  store: BudgetStore,
  mandateId: MandateId,
  input: CommitInput,
): Promise<Result<BudgetBalance, CsError>> {
  return repo(
    async () => {
      const at = input.at ?? now()
      const row = await store.lockBudgetAccount(mandateId)
      if (!row) {
        return err({
          code: 'CS_NOT_FOUND',
          message: `No budget_accounts row for ${mandateId}`,
          userMessage: 'We could not find that limit.',
          retryable: false,
          details: { table: 'budget_accounts', mandateId },
        })
      }
      if (row.currency !== input.amount.currency) {
        return err(currencyMismatch(`Budget for ${mandateId}`, row.currency, input.amount.currency))
      }
      if (input.amount.minor > row.reserved_minor) {
        const available = makeMoney(row.reserved_minor, row.currency)
        return err(
          budgetExceeded(mandateId, input.amount, available, toMoney(row.cap_minor, row.currency)),
        )
      }

      const nextReserved = row.reserved_minor - input.amount.minor
      const nextSpent = row.spent_minor + input.amount.minor
      const version = row.version + 1
      await store.insertBudgetEntry({
        id: input.entryId,
        mandate_id: mandateId,
        attempt_id: null,
        kind: 'COMMIT',
        amount_minor: input.amount.minor,
        at,
        reason: `capture ${input.captureId} completed`,
        capture_id: input.captureId,
        currency: row.currency,
      })
      const updated = await store.updateBudgetAccount(
        mandateId,
        { reservedMinor: nextReserved, spentMinor: nextSpent, version },
        at,
      )
      return toBalance(updated)
    },
    { table: 'budget_accounts', mandateId, op: 'commit' },
  )
}

export function commit(
  mandateId: MandateId,
  amount: Money,
  captureId: string,
  exec?: Exec,
): Promise<Result<BudgetBalance, CsError>> {
  return commitIn(drizzleStore(exec ?? db()), mandateId, {
    captureId,
    amount,
    entryId: newId('ben'),
  })
}

/* ------------------------------------------------------------------------------------------ */
/* REVERSE                                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Record a chargeback reversal. **Audit only** — spec §8.11: "chargeback reversal → REVERSE entry for
 * the audit only", and "refund → **no** budget restore (a refund does not return authority)".
 *
 * So `spent` does not go down and `reserved` does not change: the money was authorised and spent, and
 * the chargeback is a dispute outcome, not a release of permission. Making a reversal restore the
 * budget would let a merchant repeatedly charge-and-chargeback past a buyer's signed limit, which is
 * the abuse §12.10 exists to prevent. The entry exists so the evidence packet and the nightly
 * reconciliation can both show the reversal.
 */
export function reverseIn(
  store: BudgetStore,
  mandateId: MandateId,
  input: CommitInput,
): Promise<Result<BudgetBalance, CsError>> {
  return repo(
    async () => {
      const at = input.at ?? now()
      const row = await store.lockBudgetAccount(mandateId)
      if (!row) {
        return err({
          code: 'CS_NOT_FOUND',
          message: `No budget_accounts row for ${mandateId}`,
          userMessage: 'We could not find that limit.',
          retryable: false,
          details: { table: 'budget_accounts', mandateId },
        })
      }
      if (row.currency !== input.amount.currency) {
        return err(currencyMismatch(`Budget for ${mandateId}`, row.currency, input.amount.currency))
      }
      const version = row.version + 1
      await store.insertBudgetEntry({
        id: input.entryId,
        mandate_id: mandateId,
        attempt_id: null,
        kind: 'REVERSE',
        amount_minor: input.amount.minor,
        at,
        reason: `chargeback on capture ${input.captureId} (audit only, no budget restore)`,
        capture_id: input.captureId,
        currency: row.currency,
      })
      // Only `version` moves: the entry is the record, the balance is unchanged on purpose.
      const updated = await store.updateBudgetAccount(
        mandateId,
        { reservedMinor: row.reserved_minor, spentMinor: row.spent_minor, version },
        at,
      )
      return toBalance(updated)
    },
    { table: 'budget_accounts', mandateId, op: 'reverse' },
  )
}

export function reverse(
  mandateId: MandateId,
  amount: Money,
  captureId: string,
  exec?: Exec,
): Promise<Result<BudgetBalance, CsError>> {
  return reverseIn(drizzleStore(exec ?? db()), mandateId, {
    captureId,
    amount,
    entryId: newId('ben'),
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Gate check 9 — wallet cap (EC-MA-1)                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * `wallet_caps` CRUD. `wallet_id` is the primary key: one cap per wallet, shared by every mandate
 * and agent under it, which is what makes EC-MA-1 a wallet-level question rather than N mandate-level
 * ones.
 */
export function setWalletCap(
  walletId: WalletId,
  period: WalletCapPeriod,
  cap: Money,
  exec?: Exec,
): Promise<Result<WalletCapRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .insert(walletCaps)
        .values({ wallet_id: walletId, period, cap_minor: cap.minor, currency: cap.currency })
        .onConflictDoUpdate({
          target: walletCaps.wallet_id,
          set: { period, cap_minor: cap.minor, currency: cap.currency, updated_at: new Date() },
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('UPSERT ... RETURNING produced no wallet_caps row')
      return row as WalletCapRow
    },
    { table: 'wallet_caps', walletId },
  )
}

/**
 * Gate check 9. `SELECT … FROM wallet_caps WHERE wallet_id = $1 FOR UPDATE`.
 *
 * EC-MA-1: two agents on one wallet spending in the same window. The lock is on the **wallet** row,
 * not on a mandate row, so it serialises across mandates; then the committed spend under this wallet
 * is summed from `budget_entries` — reservations included, because money not yet captured under one
 * mandate can be captured under it moments later.
 *
 * @returns `{ok:false}` → the Gate blocks with `GATE_WALLET_CAP`. A wallet with **no** cap row is
 * unconstrained and returns `ok: true`: no cap configured means no wallet cap to exceed, not a
 * failure. Inventing a default here would silently limit a buyer who never asked to be limited.
 */
export function walletCapCheckIn(
  store: BudgetStore,
  walletId: WalletId,
  period: WalletCapPeriod,
  amount: Money,
  at: Date = now(),
  /**
   * The attempt whose RESERVE check 8 has already written. Excluded from the sum so the current cart is
   * counted once, by `amount`, rather than twice. Omit it only when calling this outside a Gate
   * sequence — passing it is always correct.
   */
  currentAttemptId?: AttemptId,
): Promise<Result<WalletCapVerdict, CsError>> {
  return repo(
    async () => {
      const row = await store.lockWalletCap(walletId)
      if (!row) return { ok: true, cap: makeMoney(0n, amount.currency) }
      if (row.currency !== amount.currency) {
        return err(currencyMismatch(`Wallet cap for ${walletId}`, row.currency, amount.currency))
      }
      const claimed = await sumWalletSpend(
        store,
        walletId,
        row.currency,
        period,
        at,
        currentAttemptId,
      )
      const cap = toMoney(row.cap_minor, row.currency)
      if (claimed + amount.minor > row.cap_minor) {
        return { ok: false, requested: amount, cap }
      }
      return { ok: true, cap }
    },
    { table: 'wallet_caps', walletId, period, op: 'wallet_cap_check' },
  )
}

export function walletCapCheck(
  walletId: WalletId,
  period: WalletCapPeriod,
  amount: Money,
  exec?: Exec,
  at?: Date,
  currentAttemptId?: AttemptId,
): Promise<Result<WalletCapRow, CsError>> {
  return repo(
    async () => {
      const store = drizzleStore(exec ?? db())
      const verdict = await walletCapCheckIn(store, walletId, period, amount, at, currentAttemptId)
      if (!verdict.ok) return verdict
      if (!verdict.value.ok) {
        // The Gate wants a `Result`, not a boolean: `GATE_WALLET_CAP` is a registry code with
        // registry copy, and the buyer has to be told which limit stopped the purchase.
        return err(walletCapExceeded(walletId, verdict.value.requested, verdict.value.cap))
      }
      const row = await store.lockWalletCap(walletId)
      if (!row) {
        return err({
          code: 'CS_NOT_FOUND',
          message: `No wallet_caps row for ${walletId}`,
          userMessage: 'We could not find that limit.',
          retryable: false,
          details: { table: 'wallet_caps', walletId },
        })
      }
      return row
    },
    { table: 'wallet_caps', walletId, period, op: 'wallet_cap_check' },
  )
}

/**
 * How much has this wallet spent under `period`? Summed from the append-only ledger rather than from
 * a counter column, so there is no second number that can drift.
 *
 * `DAY` means the last 24 h; `MONTH` means the last 30 days. Both are rolling windows: a demo has no
 * calendar, and a calendar boundary in a payments demo is a bug someone has to debug at midnight.
 *
 * `excludeAttemptId` is the fix for a double-count the Gate caused rather than found: check 9 follows
 * check 8's RESERVE, so without excluding this attempt the current cart appears both in `claimed` and
 * in `amount` and the effective cap becomes `cap − cart` (D-021).
 */
export function sumWalletSpend(
  store: BudgetStore,
  walletId: WalletId,
  currency: Currency,
  period: WalletCapPeriod,
  at: Date = now(),
  excludeAttemptId?: AttemptId,
): Promise<bigint> {
  return store.walletSpendInPeriod(walletId, currency, period, at, excludeAttemptId)
}

/* ------------------------------------------------------------------------------------------ */
/* The nightly reconciliation (spec §7.2)                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * Recompute the balances from `budget_entries` and report any drift.
 *
 * Spec §7.2: `budget_accounts` is a cache; "balances must equal the sum of entries (nightly check)".
 * This is that check. The worker calls it nightly; it **reports** drift rather than silently repairing
 * it, because a balance that disagrees with its ledger is either a bug in this package or a manual
 * database edit, and both need a human to look.
 *
 * @returns `ok: false` with the exact difference when the cache and the ledger disagree.
 */
export function reconcileIn(
  store: BudgetStore,
  mandateId: MandateId,
): Promise<Result<ReconcileReport, CsError>> {
  return repo(
    async () => {
      const row = await store.readBudgetAccount(mandateId)
      if (!row) {
        return err({
          code: 'CS_NOT_FOUND',
          message: `No budget_accounts row for ${mandateId}`,
          userMessage: 'We could not find that limit.',
          retryable: false,
          details: { table: 'budget_accounts', mandateId },
        })
      }
      const computed = computeFromEntries(await store.sumEntriesByKind(mandateId))
      const stored = { reserved: row.reserved_minor, spent: row.spent_minor }
      const drift = {
        reserved: stored.reserved - computed.reserved,
        spent: stored.spent - computed.spent,
      }
      return {
        mandateId,
        currency: row.currency,
        stored: {
          reserved: toMoney(stored.reserved, row.currency),
          spent: toMoney(stored.spent, row.currency),
        },
        computed: {
          reserved: toMoney(computed.reserved, row.currency),
          spent: toMoney(computed.spent, row.currency),
        },
        drift: {
          reserved: toMoney(drift.reserved < 0n ? -drift.reserved : drift.reserved, row.currency),
          spent: toMoney(drift.spent < 0n ? -drift.spent : drift.spent, row.currency),
        },
        ok: drift.reserved === 0n && drift.spent === 0n,
      }
    },
    { table: 'budget_accounts', mandateId, op: 'reconcile' },
  )
}

export function reconcile(
  mandateId: MandateId,
  exec?: Exec,
): Promise<Result<ReconcileReport, CsError>> {
  return reconcileIn(drizzleStore(exec ?? db()), mandateId)
}

/** The append-only ledger, newest first — the receipt timeline and the evidence packet. */
export function listEntries(
  mandateId: MandateId,
  exec?: Exec,
): Promise<Result<BudgetEntryRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(budgetEntries)
        .where(eq(budgetEntries.mandate_id, mandateId))
        .orderBy(sql`${budgetEntries.at} desc`)
      return rows as BudgetEntryRow[]
    },
    { table: 'budget_entries', mandateId },
  )
}

/** Gate check 11: "count of COMMITs within the period < limit" (recurrence constraint). */
export function countCommitsSince(
  mandateId: MandateId,
  since: Date,
  exec?: Exec,
): Promise<Result<number, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select({ id: budgetEntries.id })
        .from(budgetEntries)
        .where(
          and(
            eq(budgetEntries.mandate_id, mandateId),
            eq(budgetEntries.kind, 'COMMIT'),
            sql`${budgetEntries.at} >= ${since}`,
          ),
        )
      return rows.length
    },
    { table: 'budget_entries', mandateId },
  )
}

/** Wallet caps in force for a wallet, for the wallet page's cap bar. */
export function readWalletCap(
  walletId: WalletId,
  exec?: Exec,
): Promise<Result<WalletCapRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(walletCaps)
        .where(eq(walletCaps.wallet_id, walletId))
        .limit(1)
      return rows[0] as WalletCapRow | undefined
    },
    { table: 'wallet_caps', walletId },
  )
}
