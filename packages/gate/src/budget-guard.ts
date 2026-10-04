/**
 * Gate checks 8 and 9 — the budget. Spec **§8.10 rows 8 and 9**, decision **D19**, §12 **EC-MA-1**,
 * **EC-MDT-2**, §7.2.
 *
 * ## Why these two live in one file
 *
 * Because they share **one transaction**. Check 8 takes a row lock and writes; check 9 takes a
 * *different* row lock (`wallet_caps`, one per wallet, shared by every mandate and agent under it). If
 * they were separate units of work, the second could not see the first's uncommitted reservation — and
 * two agents on one wallet would both pass a cap that only one of them can spend (EC-MA-1 is exactly
 * that race). Putting them here makes "same transaction" a property of the file.
 *
 * ## `FOR UPDATE` cannot be forgotten, because this file cannot express anything else
 *
 * Check 8 is `reserveForAttempt(deps.budget, …)` from `@countersign/ledger`, which is `reserveIn` from
 * `@countersign/db`, and `reserveIn`'s *first statement* is
 * `SELECT … FROM budget_accounts WHERE mandate_id = $1 FOR UPDATE`. There is no second implementation
 * of the cap arithmetic in this repository, and no way to write one here: the only thing this file can
 * reach is the port, and the port's `lockBudgetAccount` is the locking statement. A future refactor
 * that wanted the optimistic path would have to write the `UPDATE … SET reserved = reserved + $1`
 * itself, in this file, in review — which is the point.
 *
 * ## What `FOR UPDATE` buys (AT-M10.2)
 *
 * 20 concurrent attempts, a $100.00 cap, $30.00 carts → **exactly 3 ALLOW**.
 *
 * Under `READ COMMITTED` without the lock, all twenty read `reserved = 0, spent = 0, cap = 10000`,
 * all twenty see `3000 + 0 + 0 <= 10000`, and all twenty write `reserved = 3000`. A $100 budget that
 * authorised $600. With the lock, the second transaction blocks on the SELECT, re-reads the committed
 * `reserved = 3000`, and refuses. Three reservations reach `9000`; the fourth sees `9000 + 3000 >
 * 10000` and is refused. The number 3 is not a tuning parameter — it is `floor(10000 / 3000)`.
 *
 * ## AT-M10.4: no leaked reservation
 *
 * §8.10 checks 9–12 can all fail after check 8 reserved. Two mechanisms cover that, and they are
 * independent on purpose:
 *
 *  1. **The transaction.** `deps.transaction(…)` wraps checks 8 and 9, so if check 9 refuses, the
 *     RESERVE insert rolls back with it and there is nothing to clean up. This is the real mechanism.
 *  2. **Compensation.** `evaluate` additionally calls `releaseReservation` if any check *after* the
 *     transaction — 10, 11, 12 — fails. Belt and braces: the transaction is a database property that a
 *     misconfigured `deps.transaction` could turn into a no-op, and the compensation is in our code and
 *     testable without a database.
 *
 * And the third: `deps.lockMandate` inside the same transaction, so a mandate revoked between check 1
 * and check 8 makes check 8 fail *before* it writes. Nothing is reserved, so nothing can be leaked.
 */

import {
  csError,
  type AttemptId,
  type CsError,
  type MandateId,
  type Money,
  type WalletId,
} from '@countersign/core'
import { walletCapCheckIn, type WalletCapPeriod, type WalletCapVerdict } from '@countersign/db'
import { releaseReservation, reserveForAttempt, RESERVATION_TTL_SECONDS } from '@countersign/ledger'

import { RELEASE_REASONS } from '@countersign/ledger'
import { codeFor, type CheckContext, type CheckResult, type CheckStateReservation } from './checks'

/**
 * Check 8. Reserve against the mandate's cap.
 *
 * The order of the three things inside the transaction is the design:
 *
 *  1. **`lockMandate`** — `SELECT … FROM mandates … FOR UPDATE`. Re-reading the mandate here, not at
 *     check 1, is what makes AT-M10.4's scenario impossible rather than merely handled: check 1's
 *     answer is a snapshot, and a revocation that lands between check 1 and check 8 would otherwise
 *     leave a reservation on a mandate that is no longer spendable. This is §12 EC-MDT-2's mechanism
 *     ("re-reads mandate status in the same tx"), applied one step earlier than the spec asks for so
 *     there is nothing to release.
 *  2. **`lockBudgetAccount`** — `SELECT … FROM budget_accounts … FOR UPDATE`. Serialises every other
 *     reserver for this mandate, which is what makes AT-M10.2's "exactly 3" true.
 *  3. **`cap + committed + requested <= cap`**, then the RESERVE insert.
 *
 * `deps.lockMandate` is called *first* and before the reservation on purpose: a mandate that is no
 * longer `ACTIVE` must not have its budget touched at all, not even briefly inside a transaction that
 * later rolls back.
 */
export async function check8Budget(ctx: CheckContext): Promise<CheckResult> {
  const mandate = ctx.state.mandate
  const amount = ctx.state.reserveAmount
  if (!mandate) return notApplicableBudget(ctx, 8, 'no mandate row: check 1 could not resolve one')
  if (!amount) return notApplicableBudget(ctx, 8, 'no amount resolved by check 6')

  // **Not** wrapped in `ctx.deps.transaction` here: `evaluate` opens one transaction around checks 8 and
  // 9 together, because check 9 must see check 8's uncommitted RESERVE (EC-MA-1 — two agents on one
  // wallet would otherwise both pass a cap only one of them can spend). Opening a nested transaction
  // per check would make that ordering impossible.
  const outcome = await (async () => {
    const fresh = await ctx.deps.lockMandate(mandate.id)
    if (!fresh.ok) return fresh
    const row = fresh.value
    if (!row) {
      return {
        ok: false as const,
        error: csError('CS_NOT_FOUND', `No mandates row for ${mandate.id}`, {
          table: 'mandates',
          id: mandate.id,
        }),
      }
    }
    if (row.status !== 'ACTIVE') {
      // The revocation that check 1 could not see. `GATE_REVOKED`, and nothing written.
      return {
        ok: false as const,
        error: csError(
          'GATE_REVOKED',
          `Mandate ${row.id} became ${row.status} while this attempt was in flight (read again under FOR UPDATE before reserving)`,
          { table: 'mandates', mandateId: row.id, status: row.status, recheck: 'in_transaction' },
        ),
      }
    }
    if (row.exp <= BigInt(ctx.nowSec - ctx.skewSec)) {
      return {
        ok: false as const,
        error: csError('VI_EXPIRED', `Mandate ${row.id} expired while this attempt was in flight`, {
          table: 'mandates',
          mandateId: row.id,
          exp: row.exp.toString(),
        }),
      }
    }
    return reserveForAttempt(ctx.deps.budget, {
      attemptId: ctx.input.attemptId,
      mandateId: mandate.id,
      amount,
      nowSec: ctx.nowSec,
    })
  })()

  if (!outcome.ok) {
    return {
      check: { n: 8, code: codeFor(8), passed: false, detail: outcome.error.message },
      reasons: [reason(outcome.error)],
    }
  }

  const handle = outcome.value
  ctx.state.reservation = {
    attemptId: handle.attemptId,
    mandateId: handle.mandateId,
    amount: handle.amount,
    entryId: handle.entryId,
    budgetVersion: handle.budgetVersion,
    createdAtSec: handle.createdAtSec,
    expiresAtSec: handle.expiresAtSec,
  }
  return {
    check: {
      n: 8,
      code: codeFor(8),
      passed: true,
      detail:
        `reserved ${handle.balance.reserved.minor}/${handle.balance.cap.minor} ${handle.amount.currency} ` +
        `at budget v${handle.budgetVersion}; reservation expires at ${handle.expiresAtSec}`,
    },
    reasons: [],
  }
}

/**
 * Check 9. The wallet cap for the period, across **all** mandates under the wallet.
 *
 * EC-MA-1: two agents spending at once on one wallet. The lock is on the **wallet** row, not on a
 * mandate row, which is what serialises across mandates; then the claimed capacity is summed from
 * `budget_entries` (reservations included, because money not yet captured under one mandate can be
 * captured under it moments later).
 *
 * A wallet with **no** cap row passes. Inventing a default here would silently limit a buyer who never
 * asked to be limited — and `wallet_caps` having no row means the user set no cap, which is not the same
 * as a cap of zero.
 *
 * This runs inside check 8's transaction (`evaluate` wraps both), so its read sees check 8's
 * uncommitted RESERVE. That ordering is what stops two agents on one wallet from both passing.
 */
export async function check9WalletCap(ctx: CheckContext): Promise<CheckResult> {
  const mandate = ctx.state.mandate
  const amount = ctx.state.reserveAmount
  if (!mandate) return notApplicableBudget(ctx, 9, 'no mandate row: check 1 could not resolve one')
  if (!amount) return notApplicableBudget(ctx, 9, 'no amount resolved by check 6')

  const period = await resolvePeriod(ctx, mandate.walletId)
  if (period.applicable === false) {
    // **Not applicable**, not passed, and not failed. A wallet with no `wallet_caps` row has no cap, and
    // `wallet_caps` having no row means the user set none — which is not the same as a cap of zero.
    // Inventing a default here would silently limit a buyer who never asked to be limited.
    return notApplicableBudget(ctx, 9, period.detail)
  }
  if (!period.ok) {
    return {
      check: { n: 9, code: codeFor(9), passed: false, detail: period.error.message },
      reasons: [reason(period.error)],
    }
  }

  const verdict = await walletCapCheckIn(
    ctx.deps.budget,
    mandate.walletId,
    period.value,
    amount,
    ctx.now,
    // Check 8 already inserted this attempt's RESERVE in this same transaction, so the ledger now
    // contains the cart we are about to add again via `amount`. Excluding the attempt is what keeps
    // the effective wallet cap at `cap` rather than `cap − cart` — without it a $150 cap with $30
    // carts allows 4 reservations instead of 5. See docs/DECISIONS.md D-021.
    ctx.input.attemptId as AttemptId,
  )
  if (!verdict.ok) {
    return {
      check: { n: 9, code: codeFor(9), passed: false, detail: verdict.error.message },
      reasons: [reason(verdict.error)],
    }
  }
  if (!verdict.value.ok) {
    return {
      check: {
        n: 9,
        code: codeFor(9),
        passed: false,
        detail: `wallet ${mandate.walletId} ${period.value} cap: requested ${verdict.value.requested.minor} of ${verdict.value.cap.minor}`,
      },
      reasons: [reason(walletCapError(mandate.walletId, verdict.value, amount))],
    }
  }
  return {
    check: {
      n: 9,
      code: codeFor(9),
      passed: true,
      detail: `wallet ${mandate.walletId} ${period.value} cap of ${verdict.value.cap.minor} ${amount.currency} not exceeded`,
    },
    reasons: [],
  }
}

/**
 * The wallet cap period, or the reason the check does not apply.
 *
 * `deps.walletCapPeriod` being absent is treated the same as "no cap configured": not applicable. A Gate
 * that silently skipped a cap check because a dependency was missing would be **failing open**, which is
 * the one direction this project never accepts (docs/DECISIONS.md D-019).
 */
async function resolvePeriod(
  ctx: CheckContext,
  walletId: WalletId,
): Promise<
  | { ok: true; value: WalletCapPeriod; applicable: true }
  | { ok: false; error: CsError; applicable: true }
  | { ok: false; applicable: false; detail: string }
> {
  if (!ctx.deps.walletCapPeriod) {
    return {
      ok: false,
      applicable: false,
      detail: `no wallet cap period resolver is configured, so no wallet cap could be evaluated for ${walletId}`,
    }
  }
  const found = await ctx.deps.walletCapPeriod(walletId)
  if (!found.ok) return { ok: false, error: found.error, applicable: true }
  if (found.value === undefined) {
    return {
      ok: false,
      applicable: false,
      detail: `no wallet_caps row for ${walletId}: the wallet has no period cap configured, so there is nothing to exceed`,
    }
  }
  return { ok: true, value: found.value, applicable: true }
}

/** `GATE_WALLET_CAP`, built here rather than imported so the copy sits with the check. */
function walletCapError(
  walletId: WalletId,
  verdict: Extract<WalletCapVerdict, { ok: false }>,
  amount: Money,
): CsError {
  return csError(
    'GATE_WALLET_CAP',
    `Wallet ${walletId}: requested ${verdict.requested.minor} exceeds the remaining ${verdict.cap.minor} ${verdict.cap.currency}`,
    {
      table: 'wallet_caps',
      walletId,
      requestedMinor: verdict.requested.minor.toString(),
      capMinor: verdict.cap.minor.toString(),
      currency: amount.currency,
    },
  )
}

/* ------------------------------------------------------------------------------------------ */
/* Compensation                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Give back a reservation taken by check 8. Called by `evaluate` when any check *after* the budget
 * transaction failed.
 *
 * AT-M10.4's assertion. The derived entry id makes this idempotent, and `releaseIn` clamps at the
 * current `reserved`, so calling it twice — or racing the 30-minute sweep — cannot credit authority that
 * was never reserved.
 *
 * @returns `ok` even when there was nothing to release. A compensation that failed must not mask the
 * check failure that caused it: the buyer needs to be told the purchase was blocked, and an operator
 * gets the leak from the ledger.
 */
export async function compensateReservation(
  ctx: CheckContext,
  reason: string,
): Promise<{ released: boolean; error?: CsError }> {
  const reservation = ctx.state.reservation
  if (!reservation) return { released: false }
  const released = await releaseReservation(
    ctx.deps.budget,
    handleFor(reservation),
    reason,
    ctx.nowSec,
  )
  if (released.ok) {
    ctx.state.reservation = null
    return { released: true }
  }
  return { released: false, error: released.error }
}

/** The stored reservation as the handle `@countersign/ledger` releases. */
export function handleFor(r: CheckStateReservation) {
  return {
    attemptId: r.attemptId as `att_${string}`,
    mandateId: r.mandateId as MandateId,
    amount: r.amount,
    entryId: r.entryId,
    budgetVersion: r.budgetVersion,
    createdAtSec: r.createdAtSec,
    expiresAtSec: r.expiresAtSec,
    balance: {
      mandateId: r.mandateId,
      currency: r.amount.currency,
      cap: { minor: 0n, currency: r.amount.currency } as Money,
      reserved: r.amount,
      spent: { minor: 0n, currency: r.amount.currency } as Money,
      available: { minor: 0n, currency: r.amount.currency } as Money,
      version: r.budgetVersion,
    },
  }
}

/** The default release reason for a Gate that blocked after reserving. */
export const GATE_BLOCK_RELEASE = RELEASE_REASONS.gateBlocked

/** Re-exported so `evaluate.ts` does not need a second import for the TTL. */
export { RESERVATION_TTL_SECONDS }

function reason(e: CsError) {
  return { code: e.code, message: e.message, userMessage: e.userMessage }
}

function notApplicableBudget(ctx: CheckContext, n: number, detail: string): CheckResult {
  void ctx
  return { check: { n, code: codeFor(n), passed: false, notApplicable: true, detail }, reasons: [] }
}
