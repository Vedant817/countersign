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
 * of the account-cap arithmetic in this repository, and no way to write one here: the only thing this
 * file can reach is the port, and the port's `lockBudgetAccount` is the locking statement. A future
 * refactor that wanted the optimistic path would have to write the `UPDATE … SET reserved = reserved + $1`
 * itself, in this file, in review — which is the point.
 *
 * The **signed** ceiling is not a second implementation of that arithmetic, and the distinction is
 * worth keeping crisp: this file never re-derives `reserved + spent + amount <= cap_minor`. It asks
 * whether the balance `reserveIn` *already computed under the lock* survives a ceiling the signature
 * states, and refuses when it does not. Reading that balance after the reserve is what makes the
 * answer race-free; see {@link check8Budget}.
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
  formatMoney,
  type AttemptId,
  type CsError,
  type MandateId,
  type Money,
  type WalletId,
} from '@countersign/core'
import { walletCapCheckIn, type WalletCapPeriod, type WalletCapVerdict } from '@countersign/db'
import { releaseReservation, reserveForAttempt, RESERVATION_TTL_SECONDS } from '@countersign/ledger'

import { RELEASE_REASONS } from '@countersign/ledger'
import {
  BUDGET_OBLIGATIONS,
  codeFor,
  obligationUnmet,
  type CheckContext,
  type CheckResult,
  type CheckStateReservation,
} from './checks'
import {
  capSourceLabel,
  checkCapCurrencies,
  effectiveBudgetCap,
  readSignedBudget,
  type BudgetCapCandidate,
  type EffectiveBudgetCap,
} from './signed-constraints'

/**
 * Check 8. Reserve against the mandate's cap — and against the ceiling the buyer **signed**.
 *
 * ## The ceilings, and why the smallest one is the answer
 *
 * Spec **D19**: the Verifiable Intent library discloses `mandate.payment.budget` and evaluates none of
 * it, so the Gate is the enforcer. Until this was fixed the Gate compared the cart against
 * `budget_accounts.cap_minor` **alone** — a column on our own table. A mandate whose signed L2 capped
 * total spend at **$20.00**, with a **$30.00** cart and a `cap_minor` of **$200.00**, returned
 * `ALLOW` (QA-gate-1). The decision record even carried
 * `pendingNetworkEnforcement: ["mandate.payment.budget"]` while allowing, because the obligation was
 * recorded as information rather than discharged as a precondition.
 *
 * So there are now up to **three** ceilings and the enforceable one is `min`:
 *
 * | Source | What it is | Standing |
 * |---|---|---|
 * | `signed_l2` | `mandate.payment.budget.max`, read from `VerifyResponse.disclosed.l2` — the payload vi decoded out of the `sd-jwt+kb` the buyer's device key signed, during the `verify_chain` call check 4 had already made | **the token, and authoritative** |
 * | `mandate_column` | `mandates.constraints` — our JSONB cache, written at signing time and never re-verified | a cache, and still a real limit |
 * | `account_cap` | `budget_accounts.cap_minor` — the row this check locks and writes | a cache, and still a real limit |
 *
 * `min`, not "prefer the signed one". The signed cap and each cached cap are all limits the buyer is
 * bound by, and a Gate that enforced the *looser* of two real limits is the only one a buyer could
 * call "you spent more than I agreed to". A tie is credited to the signature, so the detail names the
 * source with the most authority. **No network call is involved**: the signed value is a field on the
 * `/v1/verify` response check 4 has already read — see `signed-constraints.ts`.
 *
 * ## Why the signed comparison happens *after* the reservation, under the lock
 *
 * The signed ceiling is compared against `handle.balance`, which `reserveIn` computed **inside** its
 * own `SELECT … FOR UPDATE`. That is the only place the numbers are race-free: `reserved` and `spent`
 * change between any two reads taken outside the lock, and twenty concurrent $30.00 carts against a
 * $20.00 signed ceiling must produce zero reservations, not one.
 *
 * Reading `balance` *after* `reserveIn` succeeded also means there is no second implementation of the
 * cap arithmetic in this file — the account cap stays `reserveIn`'s to enforce, and this file only
 * asks whether the *signed* ceiling survived it. The cost is that the RESERVE row briefly exists
 * inside the transaction; `evaluate`'s `runBudgetTransaction` sees check 8's reason and calls
 * `tx.rollback(...)`, so nothing is committed — and `ctx.state.reservation` is deliberately **not**
 * set on any failure path, which is what stops the compensation path issuing a RELEASE against a row
 * that never existed.
 *
 * ## The order of the four things inside the transaction
 *
 *  1. **Read the signed budget, and discharge or refuse the D19 obligation** — before a single row is
 *     written. If vi reported `mandate.payment.budget` as network-enforced and the signed ceiling
 *     cannot be read, this **BLOCKs**: nobody enforced the buyer's limit, and the only other outcome is
 *     spending without it.
 *  2. **`lockMandate`** — `SELECT … FROM mandates … FOR UPDATE`. Re-reading the mandate here, not at
 *     check 1, is what makes AT-M10.4's scenario impossible rather than merely handled: check 1's
 *     answer is a snapshot, and a revocation that lands between check 1 and check 8 would otherwise
 *     leave a reservation on a mandate that is no longer spendable. This is §12 EC-MDT-2's mechanism
 *     ("re-reads mandate status in the same tx"), applied one step earlier than the spec asks for so
 *     there is nothing to release.
 *  3. **`lockBudgetAccount`** — `SELECT … FROM budget_accounts … FOR UPDATE`, inside `reserveIn`.
 *     Serialises every other reserver for this mandate, which is what makes AT-M10.2's "exactly 3"
 *     true.
 *  4. **`cap + committed + requested <= cap`**, then the RESERVE insert — then the signed ceiling
 *     against the balance that produced.
 *
 * `deps.lockMandate` is called *first* and before the reservation on purpose: a mandate that is no
 * longer `ACTIVE` must not have its budget touched at all, not even briefly inside a transaction that
 * later rolls back.
 */
export async function check8Budget(ctx: CheckContext): Promise<CheckResult> {
  const mandate = ctx.state.mandate
  const amount = ctx.state.reserveAmount
  if (ctx.state.replayRejected) {
    return unsatisfiableBudget(8, 'check 7 rejected this L3a as GATE_REPLAY; no second reservation')
  }
  if (!mandate) return notApplicableBudget(ctx, 8, 'no mandate row: check 1 could not resolve one')
  // **Blocking.** No amount is not "nothing to enforce" - it is the absence of the thing this check
  // exists to enforce. See `unsatisfiableBudget` and QA3-GATE-1.
  if (!amount) {
    return unsatisfiableBudget(8, 'no amount resolved by check 6, so there is nothing to reserve')
  }

  // (1) The signed ceiling, from the verified chain — and the D19 obligation, discharged or refused,
  // both before anything is written. `pending` is the typed list check 4 built with
  // `pendingNetworkEnforcement`; this is never `.includes()` on the wire array (D-019).
  const signed = readSignedBudget(ctx.state.signedConstraints)
  if (!signed.found) {
    const owed = obligationUnmet(ctx, BUDGET_OBLIGATIONS, [])
    if (owed) {
      return {
        check: { n: 8, code: codeFor(8), passed: false, detail: `${owed.message} | ${signed.why}` },
        reasons: [reason(owed)],
      }
    }
  }
  const signedCap: Money | null = signed.found ? signed.budget.max : null

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
    // (4a) `reserveIn` refused, so the **account** cap bound. Its internal balance is not returned on
    // the error path, and the row is still locked by this transaction, so one read is enough to name
    // which of the real limits was the tighter one. No reservation was taken, so there is nothing to
    // compensate.
    const detail = await describeRefusal(
      ctx,
      mandate.id,
      mandate.constraints,
      signedCap,
      outcome.error,
    )
    return {
      check: { n: 8, code: codeFor(8), passed: false, detail },
      reasons: [reason(outcome.error)],
    }
  }

  const handle = outcome.value

  // (4b) The signed ceiling, against the numbers `reserveIn` computed **under** the row lock. This is
  // the whole reason check 8 exists (D19).
  const candidates = budgetCapCandidates(mandate.constraints, signedCap, handle.balance.cap)
  const mismatch = checkCapCurrencies(candidates)
  if (mismatch) {
    return {
      check: {
        n: 8,
        code: codeFor(8),
        passed: false,
        detail: `${mismatch.message} | ${candidateList(candidates)}`,
      },
      reasons: [reason(mismatch)],
    }
  }
  const effective = effectiveBudgetCap(candidates)
  const committed = handle.balance.reserved.minor + handle.balance.spent.minor
  if (committed > effective.cap.minor) {
    const error = signedCapExceeded({
      mandateId: mandate.id,
      requested: amount,
      committed,
      effective,
      candidates,
    })
    return {
      check: {
        n: 8,
        code: codeFor(8),
        passed: false,
        detail: `${error.message} | ${candidateList(candidates)}`,
      },
      reasons: [reason(error)],
    }
  }

  // Only now is there a reservation to hold. Set after every other check has passed, so `evaluate`'s
  // compensation can never RELEASE a row that this check's own failure rolled back.
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
        `reserved ${handle.balance.reserved.minor}/${effective.cap.minor} ${handle.amount.currency} ` +
        `at budget v${handle.budgetVersion}; effective cap bound by ` +
        `${capSourceLabel(effective.boundBy)} of ${candidateList(candidates)}; reservation expires at ` +
        `${handle.expiresAtSec}`,
    },
    reasons: [],
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Check 8's cap arithmetic                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * Every ceiling that binds this mandate.
 *
 * `account_cap` is always present and the other two are optional, because a mandate with no signed
 * budget constraint and an empty `constraints` column still has exactly one real limit. Order is
 * signed, column, account — least authoritative first — so {@link effectiveBudgetCap} can never be
 * handed an empty list and cannot silently ignore a tighter candidate.
 */
function budgetCapCandidates(
  columnConstraints: readonly unknown[],
  signedCap: Money | null,
  accountCap: Money,
): BudgetCapCandidate[] {
  const candidates: BudgetCapCandidate[] = []
  if (signedCap !== null) candidates.push({ source: 'signed_l2', cap: signedCap })
  const column = readSignedBudget(columnConstraints)
  if (column.found) candidates.push({ source: 'mandate_column', cap: column.budget.max })
  candidates.push({ source: 'account_cap', cap: accountCap })
  return candidates
}

/** `"the signed L2 … 2000 USD, … 5000 USD, … 20000 USD — the smallest binds"`, quotable in a detail. */
function candidateList(candidates: readonly BudgetCapCandidate[]): string {
  return `${candidates
    .map((c) => `${capSourceLabel(c.source)} ${c.cap.minor} ${c.cap.currency}`)
    .join(', ')} — the smallest binds`
}

/**
 * The signed ceiling was passed. The one error this file builds about the buyer's own signature.
 *
 * `GATE_BUDGET_EXCEEDED`, because that is check 8's registered code and it is exactly true: a limit the
 * buyer signed would be passed. `boundBy` goes into the message and the details bag so a reader of a
 * dispute is told whether it was the signature or a cache that stopped the purchase — "the Gate said no
 * and here is the number" is the question a dispute actually asks.
 */
function signedCapExceeded(input: {
  mandateId: MandateId
  requested: Money
  committed: bigint
  effective: EffectiveBudgetCap
  candidates: readonly BudgetCapCandidate[]
}): CsError {
  const { cap, boundBy } = input.effective
  return csError(
    'GATE_BUDGET_EXCEEDED',
    `Mandate ${input.mandateId}: this purchase would take committed spend to ${input.committed}, past ` +
      `the ${cap.minor} ${cap.currency} ceiling in ${capSourceLabel(boundBy)} (requested ` +
      `${input.requested.minor} ${input.requested.currency})`,
    {
      table: 'budget_accounts',
      mandateId: input.mandateId,
      boundBy,
      effectiveCapMinor: cap.minor.toString(),
      committedMinor: input.committed.toString(),
      requestedMinor: input.requested.minor.toString(),
      currency: cap.currency,
      candidates: input.candidates.map((c) => ({
        source: c.source,
        minor: c.cap.minor.toString(),
        currency: c.cap.currency,
      })),
    },
    {
      userMessage:
        `This purchase would take you past the ${formatMoney(cap, { grouping: false })} limit you ` +
        `signed, so nothing was charged.`,
    },
  )
}

/**
 * `reserveIn` refused. Name the tighter of the real limits, so the detail says which one bound.
 *
 * `reserveIn` returns an **error** on refusal and discards its balance, so the account cap has to be
 * read to say anything useful about it. The read is safe: this is still inside the transaction that
 * holds the row lock, so it cannot observe a torn state. If it somehow finds no row, the original
 * error's copy is returned unchanged rather than a guess.
 */
async function describeRefusal(
  ctx: CheckContext,
  mandateId: MandateId,
  columnConstraints: readonly unknown[],
  signedCap: Money | null,
  original: CsError,
): Promise<string> {
  const row = await ctx.deps.budget.readBudgetAccount(mandateId)
  if (!row) return original.message
  const candidates = budgetCapCandidates(columnConstraints, signedCap, {
    minor: row.cap_minor,
    currency: row.currency,
  })
  if (checkCapCurrencies(candidates) !== null) return original.message
  const effective = effectiveBudgetCap(candidates)
  return (
    `${original.message} | effective cap ${effective.cap.minor} ${effective.cap.currency}, bound by ` +
    `${capSourceLabel(effective.boundBy)} of ${candidateList(candidates)}`
  )
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
  // Blocking, for the same reason as check 8.
  if (!amount)
    return unsatisfiableBudget(9, 'no amount resolved by check 6, so there is no spend to cap')

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

/**
 * A missing **subject**, so the check could not evaluate what it exists to evaluate. **Blocking.**
 *
 * The local twin of `missing()` in `checks.ts`. Duplicated rather than imported because
 * `checks.ts` imports this file for checks 8 and 9, and an import back would be a cycle. The two must
 * produce the identical record, so `blocksWhenSubjectMissingIsBlocking` in
 * `test/missing-subject.test.ts` asserts the codes match rather than trusting the comment.
 */
function unsatisfiableBudget(n: number, detail: string): CheckResult {
  return {
    check: { n, code: codeFor(n), passed: false, detail },
    reasons: [
      {
        code: 'GATE_CHECK_UNSATISFIABLE',
        message: detail,
        userMessage:
          'We could not check this purchase properly, so we are not allowing it. Nothing has been charged.',
      },
    ],
  }
}

function notApplicableBudget(ctx: CheckContext, n: number, detail: string): CheckResult {
  void ctx
  return { check: { n, code: codeFor(n), passed: false, notApplicable: true, detail }, reasons: [] }
}
