/**
 * `evaluate` — the Gate. Spec **§8.10**, core invariant **I-1** (§3.1), **D19**, §12.5 **EC-TIME-4**.
 *
 * ## The five decisions this file makes, and why each one is here
 *
 * 1. **One clock read.** `deps.clock.nowSec()` exactly once, before check 1. Every expiry comparison in
 *    the decision uses that value. §12.5 EC-TIME-4 names the race: with a per-check `now`, a price lock
 *    could expire between check 6 and check 12 and produce a decision that was true at no single instant.
 *    A Gate decision goes into an evidence packet filed with PayPal; "we checked twice and got two
 *    different answers" is not a defensible record.
 * 2. **All twelve always run.** No early return, no short-circuit. A buyer whose mandate expired *and*
 *    whose cart outran the budget is told both at once. The spec says so explicitly, and the alternative
 *    makes an agent fix one problem and be stopped by the next, one turn at a time.
 * 3. **Check 12 runs last and regardless.** Its whole purpose is to notice a flood of BLOCKs, and a
 *    flood consists of attempts that failed *earlier* checks. Skipping it when check 1 already failed
 *    would mean the suspension EC-AGT-2 promises never fires.
 * 4. **Reservation compensation.** Check 8 reserves. If 9, 10, 11 or 12 then fails, the reservation is
 *    released. AT-M10.4 asserts the buyer's `available` is unchanged after a revoked mandate.
 * 5. **Sign last, over the finished twelve.** `checks_hash` covers the twelve results, so the signature
 *    attests to the *working*, not just the verdict.
 *
 * ## The order of the checks is the spec's, not a convenient one
 *
 * §8.10's table order is: identity (1–3), cryptography (4–5), the price (6), then the things that cost
 * money to be wrong about — replay (7), budget (8, 9), stock (10), recurrence (11), behaviour (12).
 * That is cheap-first and side-effect-last: checks 1–7 are all reads or one unique insert, and the only
 * check that takes a lock and writes (8) comes after everything that can rule the attempt out without
 * touching the database.
 */

import {
  attempt,
  csError,
  newId,
  toCsError,
  toPayPalValue,
  VI_LIB_COMMIT,
  type CsError,
  type Currency,
  type GateDecisionId,
  type Money,
  type Result,
} from '@countersign/core'
import { DEFAULT_CLOCK_SKEW_SECONDS } from '@countersign/core'

import {
  CHECK_ORDER,
  check1MandateActive,
  check10Stock,
  check11Recurrence,
  check2AgentActive,
  check3DeviceActive,
  check4ChainVerify,
  check5CheckoutBinding,
  check6PriceLock,
  check7Replay,
  codeFor,
  reasonCodes,
  type CheckContext,
  type CheckHooks,
  type CheckResult,
  type CheckState,
} from './checks'
import { check8Budget, check9WalletCap, compensateReservation } from './budget-guard'
import { checksHash } from './decision-record'
import { NO_DISCLOSED_CONSTRAINTS } from './signed-constraints'
import { assessVelocity, reviewReason, suspendForVelocity, velocityBlocked } from './velocity'
import type { GateDecision, GateDeps, GateInput, GateOutcome, GateReason } from './types'

/** Options `evaluate` accepts beyond `GateInput` and `GateDeps`. All of them are test seams. */
export interface EvaluateOptions {
  /** Injected clock skew for check 1's `exp > now − skew`. Defaults to core's 300 s. */
  readonly skewSeconds?: number
  /** Runs immediately before check `n`. **AT-M10.4** uses this to revoke a mandate mid-decision. */
  readonly hooks?: CheckHooks
  /** Pre-built signer, so `deps.signRecord` need not be. `deps.signRecord` wins when both are given. */
  readonly sign?: (payload: GateRecordPayloadArg) => Promise<Result<string, CsError>>
  /** Override the decision id, so a test can assert on it. */
  readonly decisionId?: GateDecisionId
}

/** Structural alias so the option above does not import the whole payload type twice. */
export type GateRecordPayloadArg = Parameters<GateDeps['signRecord']>[0]

/**
 * The default clock skew. `VI_CLOCK_SKEW_SECONDS`' default in `core/env.ts` is also 300
 * (`DEFAULT_CLOCK_SKEW_SECONDS` in `core/clock.ts`), so an unconfigured deployment behaves the same as a
 * configured one.
 */
const DEFAULT_SKEW = DEFAULT_CLOCK_SKEW_SECONDS

/**
 * Run the twelve checks and return a signed decision.
 *
 * Never throws: an unhandled fault becomes `err(CS_INTERNAL)` rather than a raw exception, because the
 * caller's next step is "tell the buyer nothing was charged", and that has to be reachable.
 */
export async function evaluate(
  i: GateInput,
  deps: GateDeps,
  options: EvaluateOptions = {},
): Promise<Result<GateDecision, CsError>> {
  return attempt(() => runDecision(i, deps, options))
}

async function runDecision(
  i: GateInput,
  deps: GateDeps,
  options: EvaluateOptions,
): Promise<GateDecision> {
  // (1) The one clock read. Nothing below reads `deps.clock` again.
  const nowSec = deps.clock.nowSec()
  const skew = options.skewSeconds ?? DEFAULT_SKEW
  const state = freshState()
  const ctx: CheckContext = {
    input: i,
    deps,
    nowSec,
    now: new Date(nowSec * 1000),
    skewSec: skew,
    state,
    hooks: options.hooks ?? {},
  }

  // (2)+(3) All twelve, in the spec's order, with no short-circuit. A check that throws is recorded as
  // a failed check rather than escaping: losing the whole decision because check 9 hit a bad row would
  // mean reporting *nothing* to the buyer, when §8.10's contract is to report everything.
  const results: CheckResult[] = []
  // Checks 8 and 9 are pulled out of the loop and run as a pair inside one transaction. Not a
  // convenience: check 9 must observe check 8's *uncommitted* reservation, or two agents on one wallet
  // (EC-MA-1) would both pass a cap only one of them can spend. And when check 9 refuses, the
  // transaction rolls back so check 8's RESERVE insert disappears with it — which is what makes
  // AT-M10.4's "no leaked reservation" structural rather than dependent on the compensation running.
  const BUDGET_ROWS = new Set([8, 9])

  for (const row of CHECK_ORDER) {
    await ctx.hooks.before?.(row.n)
    if (BUDGET_ROWS.has(row.n)) {
      if (row.n !== 8) continue // check 9 ran with check 8
      try {
        results.push(...(await runBudgetTransaction(ctx)))
      } catch (cause) {
        results.push(...[8, 9].map((n) => thrownResult(n, cause)))
      }
      continue
    }
    try {
      results.push(await runCheck(row.n, ctx))
    } catch (cause) {
      results.push(thrownResult(row.n, cause))
    }
  }

  // A check that throws must not escape as an exception. `attempt` above converts it into
  // `err(CS_INTERNAL)`, which means the whole decision is lost — so `runCheck` is called through a
  // guard that records the throw as a *failed check* instead. A Gate that cannot run check 9 still
  // reports checks 1–8 and 10–12, and still refuses to allow.
  const checks = results.map((r) => r.check)
  const reasons: GateReason[] = results.flatMap((r) => r.reasons)

  // (4) Compensation. Any failure after the reservation gives the money back.
  if (checks.some((c) => !c.passed && !c.notApplicable) && state.reservation) {
    // Not a *reason* for blocking — the block already has one — but the release belongs in the record,
    // and check 8's `detail` is the honest place for it.
    if (await releaseIfHeld(ctx)) annotateReservationReleased(checks)
  }

  const outcome = resolveOutcome(checks, reasons)
  const amount = decisionAmount(ctx)
  const currency = amount?.currency ?? state.checkout?.currency ?? ('USD' as Currency)
  const payee = state.checkout?.merchant_id ?? ''

  const id = options.decisionId ?? newId('gdc')
  const sign = options.sign ?? deps.signRecord
  const signed = await sign({
    gdc: id,
    att: i.attemptId,
    mdt: i.mandateId,
    amount: amount ? toPayPalValue(amount) : '0.00',
    currency,
    payee,
    checks_hash: checksHash(checks),
    chain_valid: state.chainValid,
    vi_commit: VI_LIB_COMMIT,
    iat: nowSec,
  })
  // A signer that fails is not a decision: the record is the artefact I-1 requires, so refusing here is
  // the only honest answer. `CS_INTERNAL` from `signDecisionRecord` already says "nothing was charged".
  if (!signed.ok) throw signed.error

  const decision: GateDecision = {
    id,
    decision: outcome,
    reasons,
    checks,
    ...(state.reservation
      ? {
          reservation: {
            amount: state.reservation.amount,
            budgetVersion: state.reservation.budgetVersion,
          },
        }
      : {}),
    signedRecord: signed.value,
    nowSec,
    pendingNetworkEnforcement: state.pending,
  }

  // (3, second half) A tripped velocity guard suspends the mandate — and it does so *after* the record
  // is signed, because the record says what was decided and the suspension is what followed from it.
  if (outcome === 'REVIEW' && state.velocity?.trips) {
    await suspendForVelocity(deps, i.mandateId, state.velocity)
  }

  return decision
}

/** A check that threw, as a failed row. Never escapes `evaluate` — see the loop above. */
function thrownResult(n: number, cause: unknown): CheckResult {
  const error = toCsError(cause)
  return {
    check: { n, code: codeFor(n), passed: false, detail: `check threw: ${error.message}` },
    reasons: [
      {
        code: 'CS_INTERNAL',
        message: error.message,
        userMessage:
          'We could not check this purchase, so nothing was charged. We have the details and will fix it.',
      },
    ],
  }
}

/**
 * Checks 8 and 9 in one transaction.
 *
 * The rollback is the point. If check 9 refuses — the wallet cap would be passed — then check 8's RESERVE
 * insert must not survive, because a reservation on a purchase that is going to be blocked is exactly the
 * "leaked reservation" §8.10 and AT-M10.4 exist to rule out. Rolling back rather than releasing afterwards
 * means the buyer's `available` never even briefly drops.
 *
 * When check 8 itself refuses, the transaction rolls back too (nothing was written, but the row lock must
 * still be released), and `ctx.state.reservation` is left `null` so the compensation path in `evaluate` has
 * nothing to do — one mechanism, not two, for the same outcome.
 */
async function runBudgetTransaction(ctx: CheckContext): Promise<CheckResult[]> {
  const out = await ctx.deps.transaction(async (tx) => {
    const budget = await check8Budget(ctx)
    const walletCap = await check9WalletCap(ctx)
    const refused = [...budget.reasons, ...walletCap.reasons].map((r) => r.code)
    if (refused.length > 0) tx.rollback(`check 8/9 refused: ${refused.join(', ')}`)
    return [budget, walletCap]
  })

  if (out[1]!.reasons.length > 0) {
    // Check 9 refused, so the transaction rolled back and check 8's reservation is **gone**. Clearing
    // `ctx.state.reservation` is what stops `evaluate`'s compensation path from then issuing a RELEASE
    // against money that was never committed — a release would be clamped to zero by `releaseIn`, but it
    // would still write a `RELEASE` entry saying a buyer was refunded $30.00 that was never held. The
    // ledger would be wrong in a way that only shows up in a dispute.
    ctx.state.reservation = null
  }
  return out
}

/** One entry per §8.10 row, in order. Anything else is a programming error and throws loudly. */
async function runCheck(n: number, ctx: CheckContext): Promise<CheckResult> {
  switch (n) {
    case 1:
      return check1MandateActive(ctx)
    case 2:
      return check2AgentActive(ctx)
    case 3:
      return check3DeviceActive(ctx)
    case 4:
      return check4ChainVerify(ctx)
    case 5:
      return check5CheckoutBinding(ctx)
    case 6:
      return check6PriceLock(ctx)
    case 7:
      return check7Replay(ctx)
    case 10:
      return check10Stock(ctx)
    case 11:
      return check11Recurrence(ctx)
    case 12:
      return checkVelocityCheck(ctx)
    default:
      throw new Error(`no check numbered ${n}`)
  }
}

/**
 * Check 12's body, in `checks.ts`'s vocabulary.
 *
 * Written here rather than in `velocity.ts` because `velocity.ts` owns the *arithmetic* (which is pure
 * and heavily tested) while this is the part that turns a verdict into a `GateCheck` and a reason.
 */
async function checkVelocityCheck(ctx: CheckContext): Promise<CheckResult> {
  const mandate = ctx.state.mandate
  if (!mandate) {
    return {
      check: {
        n: 12,
        code: 'VELOCITY',
        passed: false,
        notApplicable: true,
        detail: 'no mandate row: check 1 could not resolve one',
      },
      reasons: [],
    }
  }
  const verdict = await assessVelocity({
    deps: ctx.deps,
    mandateId: mandate.id,
    nowSec: ctx.nowSec,
  })
  if (!verdict.ok) {
    return {
      check: { n: 12, code: 'VELOCITY', passed: false, detail: verdict.error.message },
      reasons: [
        {
          code: verdict.error.code,
          message: verdict.error.message,
          userMessage: verdict.error.userMessage,
        },
      ],
    }
  }
  ctx.state.velocity = verdict.value
  if (!verdict.value.trips) {
    return {
      check: { n: 12, code: 'VELOCITY', passed: true, detail: verdict.value.detail },
      reasons: [],
    }
  }
  const error = velocityBlocked(mandate.id, verdict.value)
  const extra = reviewReason(verdict.value)
  return {
    check: { n: 12, code: 'VELOCITY', passed: false, detail: verdict.value.detail },
    reasons: [
      { code: error.code, message: error.message, userMessage: error.userMessage },
      // Same code, different copy: the first says the purchase is blocked, the second says a human is
      // needed. Two entries rather than one merged string, so the merchant log can filter on code and
      // the buyer still reads something honest.
      { code: 'GATE_BLOCKED', message: extra.message, userMessage: extra.userMessage },
    ],
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Outcome                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * ALLOW only if every check passed. Otherwise REVIEW if the velocity guard tripped, else BLOCK.
 *
 * A `notApplicable` check does not block: there was nothing to enforce, and the record shows that
 * explicitly. It is **not** treated as a pass either — see `notApplicable` in `checks.ts`.
 *
 * REVIEW outranks BLOCK deliberately. REVIEW means "a human must look, and the mandate is paused", and
 * it is strictly *safer* than BLOCK because the orchestrator must not spend on anything but ALLOW. When
 * an attempt is both budget-exceeded and part of a flood, the flood is the more urgent fact.
 */
export function resolveOutcome(
  checks: readonly { passed: boolean; notApplicable?: boolean }[],
  reasons: readonly GateReason[],
): GateOutcome {
  const blocking = checks.some((c) => !c.passed && !c.notApplicable)
  if (!blocking) return 'ALLOW'
  const escalated =
    reasons.filter((r) => r.message.startsWith('Decision escalated to REVIEW')).length > 0
  return escalated ? 'REVIEW' : 'BLOCK'
}

/* ------------------------------------------------------------------------------------------ */
/* Compensation plumbing                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** Release the reservation check 8 took, using the ledger's own idempotent release. */
async function releaseIfHeld(ctx: CheckContext): Promise<boolean> {
  const outcome = await compensateReservation(ctx, 'GATE_BLOCKED')
  if (!outcome.released) {
    // A failed compensation is an operator problem, and the *most* important thing to record. It does
    // not change the decision — the purchase is still blocked — but it must not vanish either.
    ctx.state.reservationError =
      outcome.error ?? csError('CS_INTERNAL', 'Reservation compensation failed')
    return false
  }
  return true
}

function annotateReservationReleased(
  checks: { n: number; code: string; passed: boolean; detail?: string }[],
): void {
  const check = checks.find((c) => c.n === 8)
  if (check) check.detail = `${check.detail ?? ''} (released: a later check failed)`
}

function decisionAmount(ctx: CheckContext): Money | null {
  if (ctx.state.reservation) return ctx.state.reservation.amount
  return ctx.state.reserveAmount
}

function freshState(): CheckState {
  return {
    mandate: null,
    agent: null,
    device: null,
    checkout: null,
    l3a: null,
    l3b: null,
    l3aHeaderKid: null,
    checkoutJwt: null,
    merchantKeys: null,
    reserveAmount: null,
    reservation: null,
    reservationError: null,
    velocity: null,
    chainValid: false,
    pending: [],
    signedConstraints: NO_DISCLOSED_CONSTRAINTS,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* What a caller of `evaluate` usually wants next                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * A human-readable summary of a decision, for the merchant's decision log and for the demo narration.
 *
 * Lists **every** failing check with its row number, because §8.10's contract is that the buyer is told
 * everything that was wrong. A one-line summary of only the first failure would be the short-circuit
 * this package is built to avoid, just moved to the presentation layer.
 */
export function describeDecision(d: GateDecision): string {
  const failures = d.checks.filter((c) => !c.passed && !c.notApplicable)
  const head = `${d.decision} (${reasonCodes(d.reasons).join(', ') || 'no reasons'})`
  if (failures.length === 0) return `${head} — all ${d.checks.length} checks passed`
  const rows = failures.map((c) => `  #${c.n} ${c.code}: ${c.detail ?? 'failed'}`)
  return [head, ...rows].join('\n')
}

/** The twelve checks a decision should always have. A short array means a bug in the runner. */
export function hasEveryCheck(checks: readonly { n: number }[]): boolean {
  return (
    checks.length === CHECK_ORDER.length &&
    CHECK_ORDER.every((row) => checks.some((c) => c.n === row.n))
  )
}
