/**
 * The twelve checks — spec **§8.10**'s table, in its order, with its failure codes.
 *
 * ## The rule that shapes this file
 *
 * §8.10: *"all checks always run so every reason is reported; the decision is ALLOW only if all pass."*
 *
 * So there is no early return anywhere below. A buyer whose mandate expired **and** whose cart
 * outran the budget is told both, in one response, instead of fixing one problem and being stopped by
 * the next. Short-circuiting here would be faster and would lose exactly the information the buyer
 * needs to act.
 *
 * The consequence that is easy to get wrong: **check 12 must run even when check 1 failed.** The
 * velocity guard exists to catch an agent that is thrashing, and a thrashing agent produces BLOCKs
 * from *other* checks. A flood of BLOCKs that never trips the suspension is the failure mode §8.10
 * check 12 and §12 EC-AGT-2 both name.
 *
 * ## Where each check's data comes from
 *
 * | # | Check | Reads | Failure code |
 * |---|---|---|---|
 * | 1 | Mandate ACTIVE, not revoked, `exp > now − skew` | `mandates` via `deps.mandate` | `GATE_REVOKED` / `VI_EXPIRED` |
 * | 2 | Agent ACTIVE, agent key == L2-bound key | `agents` + the L3a `kid` header | `GATE_AGENT_SUSPENDED` |
 * | 3 | Device ACTIVE | `devices` | `GATE_REVOKED` |
 * | 4 | vi `/v1/verify` strict: `chain_valid` and `constraints.satisfied` | `deps.verify` | `VI_CHAIN_INVALID` / `VI_CONSTRAINT_VIOLATION` |
 * | 5 | Checkout JWT hash == L3b `checkout_hash`; signed by an accepted merchant kid | `checkout_sessions.checkout_jwt/checkout_hash` + `deps.merchantKeys` | `VI_CHAIN_INVALID` |
 * | 6 | `price_lock_exp > now`; totals == L3a amount; currency equal | `checkout_sessions` + verified `disclosed.l3a` | `GATE_PRICE_LOCK_EXPIRED` / `CS_CURRENCY_MISMATCH` |
 * | 7 | L3 `jti` unused | the `checkout_attempts` insert | `GATE_REPLAY` |
 * | 8 | Budget: `FOR UPDATE`, `reserved+spent+amount ≤ min(signed L2 budget, cap)`, insert RESERVE | `BudgetStore` + the verified chain's `disclosed.l2` | `GATE_BUDGET_EXCEEDED` (+ `VI_CONSTRAINT_VIOLATION` when the signed budget is owed and unreadable) |
 * | 9 | Wallet cap, period, across all mandates | `wallet_caps` + `budget_entries` | `GATE_WALLET_CAP` |
 * | 10 | Stock available for every line | `products` | `GATE_OUT_OF_STOCK` |
 * | 11 | Recurrence windows: COMMITs in period < limit | `budget_entries` + the verified chain's `disclosed.l2` + the `mandates.constraints` cache | `VI_CONSTRAINT_VIOLATION` |
 * | 12 | Velocity: >5 attempts / 10 min, or >3 BLOCKs in a row | `checkout_attempts` | `GATE_BLOCKED` (+ REVIEW, SUSPENDED) |
 *
 * ## The one `now`
 *
 * `ctx.nowSec` is captured once in `evaluate.ts` and every expiry comparison below reads it. Spec §12.5
 * **EC-TIME-4** calls out the price-lock boundary race by name: a lock that expires between check 6 and
 * check 12 would otherwise produce a decision that was true at no single instant.
 */

import {
  csError,
  err,
  formatMoney,
  ok,
  type CsError,
  type CsErrorCode,
  type Currency,
  type MandateId,
  type Money,
  type Result,
  type WalletId,
} from '@countersign/core'
import type { ConstraintType } from '@countersign/vi-client'
import { normaliseSkipped, pendingNetworkEnforcement } from '@countersign/vi-client'
import { assertAmountMatchesSession, assertPriceLockValid } from '@countersign/db'
import { evaluateRecurrence } from '@countersign/ledger'

import type {
  CheckoutSessionRow,
  GateCheck,
  GateDeps,
  GateInput,
  GateReason,
  MerchantKeySet,
  NewAttemptForGate,
  VelocityVerdict,
} from './types'
import {
  decodeCheckoutJwt,
  decodeL3,
  verifyWithMerchantKey,
  type CheckoutJwtClaims,
  type L3Claims,
} from './decision-record'
import {
  AGENT_RECURRENCE_CONSTRAINT_TYPE,
  BUDGET_CONSTRAINT_TYPE,
  CONSTRAINT_SOURCE,
  RECURRENCE_CONSTRAINT_TYPE,
  describeSources,
  disclosedConstraints,
  mergeRecurrenceConstraints,
  type DisclosedConstraints,
} from './signed-constraints'
import { PAYMENT_SOURCE, readSignedPayment } from './signed-payment'
import { CHECKOUT_SOURCE, readSignedCheckout } from './signed-checkout'
import { deriveL3ReplayId } from './replay-id'

/* ------------------------------------------------------------------------------------------ */
/* The table, as data                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** §8.10's twelve rows. One list, so the README, the tests and the runner cannot disagree. */
export const CHECK_ORDER = [
  { n: 1, code: 'MANDATE_ACTIVE', title: 'Mandate is ACTIVE, not revoked, not past exp − skew' },
  { n: 2, code: 'AGENT_ACTIVE', title: 'Agent is ACTIVE and the L3 is signed by the L2-bound key' },
  { n: 3, code: 'DEVICE_ACTIVE', title: 'Device is ACTIVE (not LOST or REVOKED)' },
  {
    n: 4,
    code: 'CHAIN_VERIFY',
    title: 'vi /v1/verify strict: chain_valid and constraints.satisfied',
  },
  {
    n: 5,
    code: 'CHECKOUT_BINDING',
    title: 'Checkout JWT matches the L3b hash, signed by an accepted merchant kid',
  },
  {
    n: 6,
    code: 'PRICE_LOCK',
    title: 'Price lock live, locked totals == L3a amount, currency equal',
  },
  { n: 7, code: 'REPLAY', title: 'L3 jti unused (unique insert)' },
  { n: 8, code: 'BUDGET', title: 'Budget reserve under FOR UPDATE' },
  { n: 9, code: 'WALLET_CAP', title: 'Wallet cap for the period across all mandates' },
  { n: 10, code: 'STOCK', title: 'Stock available for every line' },
  { n: 11, code: 'RECURRENCE', title: 'Recurrence / agent_recurrence windows' },
  { n: 12, code: 'VELOCITY', title: 'Velocity guard; REVIEW and SUSPEND on a flood' },
] as const satisfies readonly { n: number; code: string; title: string }[]

/**
 * The failure code each check reports, per §8.10's table. Check 1 and 6 and 11 have two.
 *
 * **Check 8 has a second one, which is a deviation from §8.10's table and is deliberate.** §8.10 lists
 * `GATE_BUDGET_EXCEEDED` alone; the Gate also reports `VI_CONSTRAINT_VIOLATION` when vi disclosed
 * `mandate.payment.budget` as network-enforced and the signed ceiling could not be read, so the limit
 * the buyer signed went unenforced. `GATE_BUDGET_EXCEEDED` would be a lie there — nothing was
 * exceeded, we simply could not evaluate what the buyer agreed to — and `VI_CONSTRAINT_VIOLATION` is
 * §8.8's own code for "a signed constraint we cannot vouch for". It fails **closed**, which is the
 * only acceptable direction for a missing budget. docs/DECISIONS.md D-019 owns this rule.
 */
export const CHECK_FAILURE_CODES: Readonly<Record<number, readonly CsErrorCode[]>> = Object.freeze({
  1: ['GATE_REVOKED', 'VI_EXPIRED'],
  2: ['GATE_AGENT_SUSPENDED'],
  3: ['GATE_REVOKED'],
  4: ['VI_CHAIN_INVALID', 'VI_CONSTRAINT_VIOLATION'],
  5: ['VI_CHAIN_INVALID'],
  6: ['GATE_PRICE_LOCK_EXPIRED', 'CS_CURRENCY_MISMATCH'],
  7: ['GATE_REPLAY'],
  8: ['GATE_BUDGET_EXCEEDED', 'VI_CONSTRAINT_VIOLATION'],
  9: ['GATE_WALLET_CAP'],
  10: ['GATE_OUT_OF_STOCK'],
  11: ['VI_CONSTRAINT_VIOLATION'],
  12: ['GATE_BLOCKED'],
})

/* ------------------------------------------------------------------------------------------ */
/* Context and results                                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * State the checks fill in as they go. Each check *reads* what an earlier one resolved instead of
 * re-reading it, so twelve checks cost one mandate read, one session read and one verify — and so a
 * test that makes the second read fail gets a decision that is internally consistent rather than one
 * built from two different moments.
 */
export interface CheckState {
  mandate: CheckStateMandate | null
  agent: { id: string; kid: string; status: string } | null
  device: { id: string; status: string } | null
  checkout: CheckoutSessionRow | null
  l3a: L3Claims | null
  l3b: L3Claims | null
  l3aHeaderKid: string | null
  checkoutJwt: CheckoutJwtClaims | null
  merchantKeys: MerchantKeySet | null
  /** The amount the Gate will reserve: the merchant's locked total, never a token claim. */
  reserveAmount: Money | null
  reservation: CheckStateReservation | null
  reservationError: CsError | null
  velocity: VelocityVerdict | null
  chainValid: boolean
  /** Spec D19. Non-empty means the Gate owes these; empty means none were disclosed. */
  pending: ConstraintType[]
  /**
   * The constraints the **verified chain** disclosed — D19's evidence. Spec D19, §8.10 checks 8 and 11.
   *
   * Populated by check 4 from `VerifyResponse.disclosed.l2`, i.e. from the payload vi decoded out of
   * the `sd-jwt+kb` the buyer's device key signed while verifying the chain. Checks 8 and 11 read the
   * buyer's budget and recurrence limits **from here**, not from `budget_accounts.cap_minor` and not
   * from `mandates.constraints`: the first is a cache whose drift QA-gate-1 turned into an unlimited
   * spend, and the second is a JSONB copy written at signing time and never re-verified.
   *
   * There is no extra network call to fill this. It arrives on the `/v1/verify` response check 4 has
   * already made.
   */
  signedConstraints: DisclosedConstraints
  /** vi's resolved signed token, from VerifyResponse.disclosed.l3a in check 4 (D-038). */
  disclosedL3a: Record<string, unknown> | null
  /** vi's resolved L3b checkout mandate, from the same verification response as L3a. */
  disclosedL3b: Record<string, unknown> | null
  /** A refused unique insert must never reach a second budget reservation. */
  replayRejected: boolean
}

export interface CheckStateMandate {
  readonly id: MandateId
  readonly status: string
  readonly exp: bigint
  readonly revokedAt: Date | null
  readonly deviceId: string
  readonly agentId: string
  readonly walletId: WalletId
  readonly constraints: readonly unknown[]
  /**
   * `mandates.l2_serialized` — the signed `sd-jwt+kb`, byte-for-byte as the browser sent it.
   *
   * ### Why check 1 carries it
   *
   * Check 4 has to send the chain's L2 to `/v1/verify`, and §8.10's `GateInput` deliberately does not
   * carry one: `l1`/`l2` are the **buyer's device's** tokens, not the agent's to present, so they are
   * stored state rather than input. Reading them here — from the same single mandate read check 1 already
   * made — means twelve checks still cost one mandate query, and the value is a fact of the row check 1
   * verified rather than a second read that could disagree with it.
   *
   * Normalised to `''` when the column is absent or not a string, so "the Gate has no L2" is
   * representable in the type and check 4 can refuse it explicitly. It is **never** a default token: an
   * empty L2 is not a chain, and `verifyRequestSchema` (`boundedString` = `min(1)`) refuses one before a
   * single fetch — which is the refusal that turns this from a bad decision into a loud one.
   */
  readonly l2Serialized: string
}

export interface CheckStateReservation {
  readonly attemptId: string
  readonly mandateId: MandateId
  readonly amount: Money
  readonly entryId: string
  readonly budgetVersion: number
  readonly createdAtSec: number
  readonly expiresAtSec: number
}

/**
 * Test seam. `before(n)` runs immediately before check `n`.
 *
 * It exists for one reason and that reason is **AT-M10.4**: revoking a mandate *between* checks is not
 * reachable any other way, because the whole point of the scenario is that it races. The hook is in
 * the shipped source rather than in a test file because the Gate must be able to observe a delay
 * between its own checks in production too — a slow verify is the same shape.
 */
export interface CheckHooks {
  before?(n: number): Promise<void> | void
}

export interface CheckContext {
  readonly input: GateInput
  readonly deps: GateDeps
  /** The one instant. Every expiry comparison below uses this and nothing else. */
  readonly nowSec: number
  readonly now: Date
  readonly skewSec: number
  readonly state: CheckState
  readonly hooks: CheckHooks
}

export interface CheckResult {
  readonly check: GateCheck
  readonly reasons: GateReason[]
}
function pass(n: number, detail?: string): CheckResult {
  return {
    check:
      detail === undefined
        ? { n, code: codeFor(n), passed: true }
        : { n, code: codeFor(n), passed: true, detail },
    reasons: [],
  }
}

function fail(n: number, reason: CsError, detail?: string): CheckResult {
  return {
    check:
      detail === undefined
        ? { n, code: codeFor(n), passed: false, detail: reason.message }
        : { n, code: codeFor(n), passed: false, detail },
    reasons: [{ code: reason.code, message: reason.message, userMessage: reason.userMessage }],
  }
}

/**
 * A check that had **nothing to enforce**. `passed: false` + `notApplicable: true`, never `passed: true`.
 *
 * Reporting "not applicable" as a pass would be the D19 lie in a new costume: a constraint the user
 * signed, in the decision record, claimed as enforced when it was not. §8.10's `checks_hash` covers all
 * twelve entries, so the distinction is visible to anyone who re-reads the signed record.
 *
 * ## But there are two reasons a check can decline, and only one of them is legitimate
 *
 * | Reason | Correct | Example |
 * |---|---|---|
 * | The thing checked **does not exist in this request** — nothing to enforce | `notApplicable` | no budget constraint was signed; the wallet has no period cap row |
 * | The thing checked **should exist and does not** — cannot evaluate what matters | **`missing`, which blocks** | there is no checkout session to bind the cart to |
 *
 * The second was implemented as `notApplicable`, and that is QA3-GATE-1 (`critical`, confirmed by
 * execution): with no checkout session, checks 5 through 10 each declined, `resolveOutcome` treated
 * `notApplicable` as non-blocking, and the Gate signed an `ALLOW` carrying `amount: "0.00"`,
 * `payee: ""`, no price lock and no reservation. Six checks declined for one reason, and the record
 * asserted `chain_valid: true` over a cart that did not exist.
 *
 * No money moved, because `packages/orders::loadOrderDraft` re-reads the session independently and
 * refuses. That is a second line of defence catching the first line's failure, which is not a design
 * anyone would choose. And it is worse than "no money moved": **the signature is load-bearing.** That
 * `gate_decisions` row is the evidentiary spine of a dispute packet, so a signed record claiming a
 * valid chain over a nonexistent cart propagates into evidence an adjudicator is told is
 * cryptographically sound.
 *
 * So the rule is: **`notApplicable` means "nothing to enforce", never "could not enforce".** A missing
 * subject is a {@link missing}. Two names exist so that is a one-word decision at each call site
 * rather than a judgement call repeated twelve times.
 */
function notApplicable(n: number, detail: string): CheckResult {
  return {
    check: { n, code: codeFor(n), passed: false, notApplicable: true, detail },
    reasons: [],
  }
}

/**
 * The subject of this check does not exist, so the check could not evaluate what it exists to
 * evaluate. **Blocking**, unlike {@link notApplicable}.
 *
 * QA3-GATE-1 is what happens when that distinction is not made. `missing` is for a missing *subject*;
 * `notApplicable` is for an absent *constraint*.
 */
function missing(n: number, detail: string): CheckResult {
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

export function codeFor(n: number): string {
  return CHECK_ORDER.find((c) => c.n === n)?.code ?? `CHECK_${n}`
}

/** Every failure a check produced, plus the check itself. */
export function reasonCodes(reasons: readonly GateReason[]): CsErrorCode[] {
  return [...new Set(reasons.map((r) => r.code))]
}

/**
 * What `/v1/verify` disclosed but **did not evaluate**, as a Gate obligation. Spec **D19**.
 *
 * Thin wrapper over `pendingNetworkEnforcement` from `@countersign/vi-client`, exported so there is exactly
 * one definition of "what this chain left for us to enforce" in the repository. Callers building a
 * response can surface it without re-deriving it, and a second hand-written filter is a second chance to
 * get `.includes` on the wrong array.
 *
 * A non-empty result is an **obligation**, never information: those constraints were signed by the user and
 * checked by nobody, so the Gate's own checks are the only thing standing between the buyer's cap and an
 * unlimited spend.
 *
 * The parameter is deliberately loose about `skipped`'s element type — `string | {type, reason}` — because
 * that is the shape on the wire and `normaliseSkipped` is what resolves it.
 */
export function pendingObligations(report: {
  constraints: { skipped?: readonly (string | { type: string; reason?: string })[] }
}): ConstraintType[] {
  // `NormalisedSkip.reason` is a required `string`, and a wire object may omit it, so the narrowing is
  // explicit here rather than by loosening `NormalisedSkip` — one narrower type in one place beats a looser
  // type everywhere.
  return pendingNetworkEnforcement(
    normaliseSkipped(report.constraints.skipped as Parameters<typeof normaliseSkipped>[0]),
  )
}

/* ------------------------------------------------------------------------------------------ */
/* 1 — Mandate                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * Check 1: `mandates.status = 'ACTIVE'`, not revoked, and `exp > now − skew`.
 *
 * The skew is the asymmetric one from `core/clock.ts`: a mandate that expired up to `skew` seconds ago
 * is still honoured, because two hosts a few seconds apart must not fail a payment in flight
 * (§12.5 EC-TIME-2). Note the direction: `exp > now − skew` is *lenient* at the boundary, so a mandate
 * one second inside its window passes.
 *
 * Two codes, not one. `REVOKED`/`SUSPENDED`/`EXHAUSTED` are **the buyer's decision** (`GATE_REVOKED` —
 * nothing will ever be charged under it again); `DRAFT`/`PENDING_SIGNATURE` means the mandate was never
 * signed, and an expiry is a clock (`VI_EXPIRED`, whose copy tells the buyer to renew). Collapsing them
 * into one code would tell a buyer to renew a mandate they deliberately revoked.
 */
export async function check1MandateActive(ctx: CheckContext): Promise<CheckResult> {
  const found = await ctx.deps.mandate(ctx.input.mandateId)
  if (!found.ok) return fail(1, found.error)
  const row = found.value
  if (!row) return fail(1, notFound('mandates', ctx.input.mandateId, 'mandate'))

  ctx.state.mandate = {
    id: row.id,
    status: row.status,
    exp: row.exp,
    revokedAt: row.revoked_at,
    deviceId: row.device_id,
    agentId: row.agent_id,
    walletId: row.wallet_id as WalletId,
    constraints: Array.isArray(row.constraints) ? row.constraints : [],
    // The L2 check 4 will hand to `/v1/verify`. `l2_serialized` is `NOT NULL` in §7.2, so a non-string
    // here means a row this process did not write, and `''` is the only safe reading of that: check 4
    // turns it into a BLOCK that names the missing column rather than sending `''` to vi.
    l2Serialized: typeof row.l2_serialized === 'string' ? row.l2_serialized : '',
  }

  const failures: CsError[] = []
  if (row.status === 'REVOKED' || row.status === 'SUSPENDED' || row.status === 'EXHAUSTED') {
    failures.push(
      csError(
        'GATE_REVOKED',
        `Mandate ${row.id} is ${row.status}${row.revoked_at ? ` (revoked at ${row.revoked_at.toISOString()})` : ''}`,
        { table: 'mandates', mandateId: row.id, status: row.status },
      ),
    )
  } else if (row.status !== 'ACTIVE') {
    failures.push(
      csError(
        'GATE_REVOKED',
        `Mandate ${row.id} is ${row.status}, not ACTIVE — it was never signed into force`,
        { table: 'mandates', mandateId: row.id, status: row.status },
        {
          userMessage:
            'That spending permission was never fully approved, so nothing can be charged under it. Approve it and try again.',
        },
      ),
    )
  }

  // `exp > now − skew`, in bigint seconds. Comparing bigints keeps a 2038-scale `exp` exact.
  if (row.exp <= BigInt(ctx.nowSec - ctx.skewSec)) {
    failures.push(
      csError(
        'VI_EXPIRED',
        `Mandate ${row.id} expired at ${row.exp.toString()} (now ${ctx.nowSec}, skew ${ctx.skewSec})`,
        { table: 'mandates', mandateId: row.id, exp: row.exp.toString(), nowSec: ctx.nowSec },
      ),
    )
  }

  if (failures.length > 0) {
    return fail(
      1,
      failures[0]!,
      `${failures.length} failure(s): ${failures.map((f) => f.code).join(', ')}`,
    )
  }
  return pass(1, `ACTIVE until ${row.exp.toString()}`)
}

/* ------------------------------------------------------------------------------------------ */
/* 2 — Agent                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Check 2: the agent is `ACTIVE`, and the key that signed the L3 is the key the L2 bound.
 *
 * **EC-MA-2** (agent A tries to use agent B's mandate): the L2's `cnf` pins the agent public key, so
 * `agents.kid` for *this mandate's* agent is the only kid that can produce a valid L3. Comparing it to
 * the L3a's `kid` header is a second, independent witness of the same fact — and it is a witness, not
 * the defence: check 4's `verify_chain` is what actually proves the signature. Both are checked because
 * "the database says the right kid" and "the token carries the right kid" disagreeing is a bug worth
 * finding even when one of them is enough to block.
 */
export async function check2AgentActive(ctx: CheckContext): Promise<CheckResult> {
  const mandate = ctx.state.mandate
  if (!mandate) {
    // Check 1 failed and never resolved a mandate. Still run — and report *this* check as
    // unevaluated rather than passed, because an unevaluated check is not a passing check.
    return notApplicable(2, 'no mandate row: check 1 could not resolve one')
  }

  // The mandate names its agent. `input.agentId` is the caller's claim and must agree with it.
  if (ctx.input.agentId !== mandate.agentId) {
    return fail(
      2,
      csError(
        'GATE_AGENT_SUSPENDED',
        `Attempt presents agent ${ctx.input.agentId} but mandate ${mandate.id} is bound to agent ${mandate.agentId}`,
        {
          mandateId: mandate.id,
          presentedAgentId: ctx.input.agentId,
          boundAgentId: mandate.agentId,
        },
        {
          userMessage:
            'This purchase was attempted with a different agent than the one you approved, so it was blocked.',
        },
      ),
    )
  }

  const found = await ctx.deps.agent(mandate.agentId as CheckContext['input']['agentId'])
  if (!found.ok) return fail(2, found.error)
  const row = found.value
  if (!row) return fail(2, notFound('agents', mandate.agentId, 'agent'))

  ctx.state.agent = { id: row.id, kid: row.kid, status: row.status }
  const decoded = ctx.state.l3aHeaderKid ?? decodeHeaderKid(ctx.input.l3a)
  ctx.state.l3aHeaderKid = decoded

  if (row.status !== 'ACTIVE') {
    return fail(
      2,
      csError('GATE_AGENT_SUSPENDED', `Agent ${row.id} is ${row.status}`, {
        table: 'agents',
        agentId: row.id,
        status: row.status,
      }),
    )
  }
  if (decoded !== null && decoded !== row.kid) {
    return fail(
      2,
      csError(
        'GATE_AGENT_SUSPENDED',
        `L3a is signed by kid ${decoded}; mandate ${mandate.id} binds agent key ${row.kid} (EC-MA-2)`,
        { mandateId: mandate.id, agentId: row.id, l3aKid: decoded, boundKid: row.kid },
        {
          userMessage:
            'This purchase was signed by a key you did not approve for this limit, so it was blocked.',
        },
      ),
    )
  }
  return pass(2, `agent ${row.id} ACTIVE, kid ${row.kid}`)
}

/* ------------------------------------------------------------------------------------------ */
/* 3 — Device                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * Check 3: the device behind the mandate is `ACTIVE`.
 *
 * `LOST` blocks even though EC-KEY-1 says a lost device's *mandates* keep working until they expire.
 * That is not a contradiction: a lost device is evidence of a compromised machine, and the rule that
 * keeps the mandate alive is that the **agent key**, not the device key, signs purchases. Blocking on
 * `LOST` costs a buyer nothing they had a right to, and stops a thief's machine from being a stepping
 * stone. `devices.status` is the only field read.
 */
export async function check3DeviceActive(ctx: CheckContext): Promise<CheckResult> {
  const mandate = ctx.state.mandate
  if (!mandate) return notApplicable(3, 'no mandate row: check 1 could not resolve one')

  const found = await ctx.deps.device(mandate.deviceId as `dev_${string}`)
  if (!found.ok) return fail(3, found.error)
  const row = found.value
  if (!row) return fail(3, notFound('devices', mandate.deviceId, 'device'))

  ctx.state.device = { id: row.id, status: row.status }
  if (row.status !== 'ACTIVE') {
    return fail(
      3,
      csError(
        'GATE_REVOKED',
        `Device ${row.id} is ${row.status}`,
        {
          table: 'devices',
          deviceId: row.id,
          status: row.status,
        },
        {
          userMessage:
            'The device that approved this limit was reported lost or revoked, so nothing further can be charged on it.',
        },
      ),
    )
  }
  return pass(3, `device ${row.id} ACTIVE`)
}

/* ------------------------------------------------------------------------------------------ */
/* 4 — Chain verify                                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Check 4: `POST /v1/verify` with `strict: true`. `chain_valid` **and** `constraints.satisfied`.
 *
 * ### The D19 obligation, in code
 *
 * Three lines do the work, and they are the whole reason this package exists:
 *
 * ```ts
 * ctx.state.pending = pendingNetworkEnforcement(verify.constraints.skipped)
 * ```
 *
 * `pendingNetworkEnforcement` is the only sanctioned way to read `constraints.skipped`. The array holds
 * **annotated** strings — `"mandate.payment.budget — Network-enforced constraints. Not evaluated by…"`
 * — so `skipped.includes('mandate.payment.budget')` is `false` *while a signed budget cap sits
 * unevaluated*, and a Gate written that way concludes it owes nothing and allows the purchase
 * (docs/DECISIONS.md **D-019**). The schema ends in `.transform()` precisely so that expression is a
 * **type error**.
 *
 * `constraints.satisfied: true` is therefore read only as "the constraints vi *did* evaluate were
 * satisfied", and never as covering a network-enforced one. Checks 8, 9 and 11 are what make that true.
 * A non-empty `pending` is an **obligation**, not information.
 *
 * ### The obligation is dischargeable only because this response also carries the constraints
 *
 * The second thing check 4 stores is `state.signedConstraints`, read from `report.disclosed.l2` — the
 * payload vi resolved out of the L2 while verifying the very chain whose `chain_valid` is read just
 * above. That is where the buyer's `mandate.payment.budget` ceiling and their `recurrence` window
 * live, so checks 8 and 11 can enforce them **without another round trip**. If a future change needed
 * a network call to learn the signed budget, it would be reading the wrong source, and the obligation
 * guard in {@link obligationUnmet} is what turns that mistake into a BLOCK rather than an ALLOW.
 *
 * ### The L1 and the L2 come from stored mandate state, and there is no third answer
 *
 * §8.10's `GateInput` carries `l3a` and `l3b` and nothing else, on purpose: those two are the agent's
 * to present, and the other two are the **buyer's device's**, minted when the mandate was signed and
 * stored. So this check asks for them — `l2` off the mandate row check 1 read, `l1` off
 * `deps.findL1ForDeviceWallet` — and there are exactly three outcomes:
 *
 * 1. both present: verify the chain, which is the whole point;
 * 2. one absent: **BLOCK**, naming which one and where it should have been;
 * 3. neither: BLOCK, same.
 *
 * There is deliberately **no fourth**. Sending `l1: ''` and `l2: ''` is what this function used to do,
 * and it is the single worst line in the package: `verifyRequestSchema` declares both
 * `boundedString(…)` — `min(1)` — so `ViClient.verify` refused the request **client-side, before any
 * fetch**, returning `CS_VALIDATION`. Every decision was therefore BLOCK, `disclosed.l2` was never
 * read, `signedConstraints` was always empty, `pendingNetworkEnforcement` was always empty, and D19's
 * obligation gate never fired: the signed budget was enforced in code and unreachable at runtime, which
 * is exactly the QA-gate-1 overspend, still live. Not one PayPal order could be created.
 *
 * The empty string is not a chain, so `''` is not a value that can be *sent*; it is a value that can
 * only be *reported*. {@link chainTokens} turns each absence into a `VI_CHAIN_INVALID` whose message says
 * which column or lookup came back empty, so an operator sees "the L2 is missing from `mandates`" rather
 * than a validation error about a field that is never populated.
 *
 * ### The checkout JWT is part of the chain, so the session is loaded here
 *
 * `checkout_jwt` is the price lock the L3b commits to, and `/v1/verify` needs it: `apps/vi`'s
 * `_constraints` evaluates the **checkout-side** constraints against the cart in that JWT, and with
 * `checkout_jwt: null` it answers `satisfied: false` with the violation *"Checkout constraints could not
 * be enforced: no checkout_jwt was supplied"*. So `chain_valid` comes back `false` on every real request
 * and this check fails every time — a second, independent blocker on the same path, found only by
 * driving a live service.
 *
 * It was null because this check read `ctx.state.checkout`, which nothing populates until check 5. Calling
 * {@link loadSession} costs **no extra query**: it memoises, and checks 5, 6, 7 and 10 all read the same
 * row through it. Twelve checks still cost one session read.
 *
 * An absent session is not fatal here. `null` is the honest value for "we have no price lock to present",
 * check 5 is the check that reports it, and this check's own verdict about the chain is unaffected — vi
 * answers `chain_valid: false` with the reason, which is the truthful answer for a chain that omits its
 * price lock.
 */
export async function check4ChainVerify(ctx: CheckContext): Promise<CheckResult> {
  const mandate = ctx.state.mandate
  if (!mandate) {
    // Check 1 failed and never resolved a mandate, so there is no stored L2 to read and no device to
    // resolve an L1 for. Report it as unevaluated rather than passed — and non-blocking, because check 1
    // has already blocked the decision and a second reason for the same fact would be noise. `chainValid`
    // stays at its `freshState()` default of `false`, so the signed record still says the chain was not
    // verified.
    return notApplicable(4, 'no mandate row: check 1 could not resolve one')
  }

  const tokens = await chainTokens(ctx)
  if (!tokens.ok) return fail(4, tokens.error, `cannot verify the chain: ${tokens.error.message}`)

  // The price lock is part of the chain. Read through the memoising `loadSession`, so checks 5, 6, 7 and
  // 10 still share one query rather than this adding a fifth.
  const session = await loadSession(ctx)

  const request = {
    l1: tokens.value.l1,
    l2: tokens.value.l2,
    l3a: ctx.input.l3a,
    l3b: ctx.input.l3b,
    // `null` when there is no session, which is the honest value: `verifyRequestSchema` allows it, and vi
    // answers `chain_valid: false` naming the missing price lock. Check 5 is the check that reports an
    // absent cart, and it does so from the same memoised row.
    checkout_jwt: session?.checkout_jwt ?? null,
    strict: true,
  }
  const verified = await ctx.deps.verify(request)
  if (!verified.ok) return fail(4, verified.error, `verify call failed: ${verified.error.code}`)
  const report = verified.value

  // Read the obligation **first**, and unconditionally — even if the chain is invalid, the report still
  // tells us what nobody checked, and the decision record should say so.
  ctx.state.pending = pendingNetworkEnforcement(report.constraints.skipped)
  ctx.state.chainValid = report.chain_valid

  // The constraints themselves, from the chain that was just verified. Stored unconditionally for the
  // same reason `pending` is: the detail a reader of the signed record needs is "vi disclosed a
  // budget we now enforce", and that has to survive a chain-invalid verdict too.
  ctx.state.signedConstraints = disclosedConstraints(report.disclosed?.l2)
  ctx.state.disclosedL3a = report.disclosed?.l3a ?? null
  ctx.state.disclosedL3b = report.disclosed?.l3b ?? null

  if (!report.chain_valid) {
    return fail(
      4,
      csError(
        'VI_CHAIN_INVALID',
        `verify_chain rejected the chain: ${report.errors.join('; ') || 'no reason given'}`,
        {
          errors: report.errors,
          checksSkipped: report.checks_skipped,
          pendingNetworkEnforcement: ctx.state.pending,
        },
      ),
    )
  }
  if (!report.constraints.satisfied) {
    return fail(
      4,
      csError(
        'VI_CONSTRAINT_VIOLATION',
        `check_constraints(STRICT) reported: ${report.constraints.violations.join('; ')}`,
        {
          violations: report.constraints.violations,
          checked: report.constraints.checked,
          pendingNetworkEnforcement: ctx.state.pending,
        },
      ),
    )
  }
  const payment = readSignedPayment(ctx.state.disclosedL3a)
  if (!payment.found) return missing(4, payment.why)
  return pass(
    4,
    `chain valid (L1 ${tokens.value.l1Source}, L2 mandates.l2_serialized); ${ctx.state.pending.length} network-enforced constraint(s) pending: ${ctx.state.pending.join(', ') || 'none'}`,
  )
}

/**
 * The two tokens `/v1/verify` needs that `GateInput` does not carry, resolved from stored state.
 *
 * Exported so the regression test can assert on the *pair* without going through twelve checks, and so
 * the "empty token is not a value" rule has one definition in the package rather than one per caller.
 *
 * ### Each absence is named, not lumped
 *
 * The two failures are different facts with different fixes — one is a missing row in `l1_credentials`
 * for this device×wallet, the other is a mandate row with no `l2_serialized` — and an operator reading a
 * BLOCK needs to be told which. So each message names the table and the lookup, and the details object
 * carries the ids. Neither is reported as a generic "verify failed", because that is what made the `''`
 * version expensive: `CS_VALIDATION` on `l1`/`l2` reads like a malformed token, when in fact no token
 * had been sent.
 *
 * ### Why `undefined` from the L1 lookup is a refusal and not a retry
 *
 * `l1_credentials` is unique on `(device_id, wallet_id)`, so a mandate whose lookup returns nothing has
 * a state that cannot be repaired by asking again — the row either exists or it does not, and it does
 * not change under a retry. A 200 with `chain_valid: false` would be the wrong answer too: we are not
 * being told the chain is invalid, we are being told we cannot ask. `chainValid` therefore stays `false`,
 * which is the safe direction.
 */
export async function chainTokens(
  ctx: CheckContext,
): Promise<
  Result<{ readonly l1: string; readonly l2: string; readonly l1Source: string }, CsError>
> {
  const mandate = ctx.state.mandate
  if (!mandate) {
    return err(
      csError(
        'VI_CHAIN_INVALID',
        'check 4 needs the mandate row before it can read the chain: check 1 could not resolve one',
        { missing: 'mandate' },
        {
          userMessage:
            'We could not read the approval behind this purchase, so nothing was charged.',
        },
      ),
    )
  }

  // Trim before testing emptiness, not before sending: a stored token with stray whitespace is still the
  // buyer's token as far as the bytes go, but a token that is *only* whitespace is not a token and must
  // never be handed to `/v1/verify`.
  const l2 = mandate.l2Serialized.trim()
  if (l2 === '') {
    return err(
      csError(
        'VI_CHAIN_INVALID',
        `mandates.l2_serialized for mandate ${mandate.id} is empty, so there is no signed L2 to verify ` +
          'the chain against. The mandate was never stored with the token the buyer signed.',
        { table: 'mandates', mandateId: mandate.id, missing: 'l2_serialized' },
        {
          userMessage:
            'We could not find the approval you signed for this purchase, so nothing was charged. ' +
            'Please approve it again.',
        },
      ),
    )
  }

  const found = await ctx.deps.findL1ForDeviceWallet(mandate.deviceId, mandate.walletId)
  if (!found.ok) {
    return err(
      csError(
        found.error.code,
        `could not read the L1 credential for device ${mandate.deviceId} and wallet ${mandate.walletId}: ${found.error.message}`,
        { ...found.error.details, missing: 'l1_credentials', mandateId: mandate.id },
      ),
    )
  }
  const row = found.value
  if (!row) {
    return err(
      csError(
        'VI_CHAIN_INVALID',
        `no l1_credentials row for device ${mandate.deviceId} and wallet ${mandate.walletId}, so there is ` +
          'no L1 to verify the chain against. §7.2 issues exactly one L1 per device×wallet, so a mandate ' +
          'whose device has none cannot produce a chain at all.',
        {
          table: 'l1_credentials',
          deviceId: mandate.deviceId,
          walletId: mandate.walletId,
          missing: 'l1_credentials',
        },
        {
          userMessage:
            'This device has no payment credential for this wallet, so nothing was charged. ' +
            'Reconnect it and try again.',
        },
      ),
    )
  }
  const l1 = (row.sd_jwt ?? '').trim()
  if (l1 === '') {
    return err(
      csError(
        'VI_CHAIN_INVALID',
        `l1_credentials.sd_jwt for device ${mandate.deviceId} and wallet ${mandate.walletId} is empty, ` +
          'so there is no L1 to verify the chain against.',
        {
          table: 'l1_credentials',
          deviceId: mandate.deviceId,
          walletId: mandate.walletId,
          missing: 'sd_jwt',
        },
        {
          userMessage:
            'This device has no payment credential for this wallet, so nothing was charged. ' +
            'Reconnect it and try again.',
        },
      ),
    )
  }

  return ok({ l1, l2, l1Source: `l1_credentials.sd_jwt (device ${mandate.deviceId})` })
}

/* ------------------------------------------------------------------------------------------ */
/* The D19 obligation guard                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Which of the three network-enforced constraints did this check **fail to discharge**? Spec **D19**,
 * **D-019**.
 *
 * This is the guard that turns "recorded an obligation" into "acted on it". `pending` is a list of
 * constraint types vi disclosed and evaluated **none** of, so each one is a promise the buyer holds
 * that *this process* keeps. Two states must never both be true:
 *
 * - the obligation is in `pending` (vi said "somebody must enforce this"), and
 * - the check that owns it read no such constraint from the verified chain, so it enforced nothing.
 *
 * When both are true, nobody enforced it — and the alternative to `BLOCK` is `ALLOW`, which spends the
 * buyer's money in favour of the failure. That is the D-019 failure mode exactly, one level up: not
 * the `.includes()` that never matched, but the `pending` array that was written to the decision
 * record and read as information.
 *
 * `REVIEW` is deliberately **not** an alternative here. Spec §8.10's table gives no `REVIEW` for an
 * unenforceable network-enforced constraint, and a check that can be waved through is a check that
 * will be.
 *
 * @param owned the constraint types this check is responsible for (check 8: budget; check 11: the two
 * recurrence types). Scoped so one check never reports another's obligation — a budget obligation
 * unmet is check 8's reason, and reporting it from check 11 as well would put two rows in the signed
 * record for one fact.
 * @param enforced what this check actually read and applied.
 * @returns `null` when nothing was owed, or when everything owed was enforced. Otherwise the BLOCK.
 */
export function obligationUnmet(
  ctx: CheckContext,
  owned: readonly ConstraintType[],
  enforced: readonly ConstraintType[],
): CsError | null {
  const unmet = owned.filter((type) => ctx.state.pending.includes(type) && !enforced.includes(type))
  if (unmet.length === 0) return null
  return csError(
    'VI_CONSTRAINT_VIOLATION',
    `vi reported ${unmet.join(', ')} as network-enforced — nobody evaluated it — and this Gate could ` +
      `not read ${unmet.length === 1 ? 'that constraint' : 'those constraints'} from the verified ` +
      `chain, so no one enforced ${unmet.length === 1 ? 'it' : 'them'}. Refusing rather than spending ` +
      `against a limit nobody applied (spec D19).`,
    {
      unmetNetworkEnforcement: unmet,
      source: CONSTRAINT_SOURCE.SIGNED_L2,
      disclosedVcts: ctx.state.signedConstraints.vcts,
      disclosedConstraintCount: ctx.state.signedConstraints.constraints.length,
    },
    {
      userMessage:
        'We could not read a spending limit you signed, so we did not let this purchase through. ' +
        'Nothing was charged.',
    },
  )
}

/** The network-enforced constraint types check 11 owns. */
export const RECURRENCE_OBLIGATIONS: readonly ConstraintType[] = [
  RECURRENCE_CONSTRAINT_TYPE,
  AGENT_RECURRENCE_CONSTRAINT_TYPE,
]
/** The network-enforced constraint type check 8 owns. */
export const BUDGET_OBLIGATIONS: readonly ConstraintType[] = [BUDGET_CONSTRAINT_TYPE]

/** Of {@link RECURRENCE_OBLIGATIONS}, the ones this decision owed and has now enforced. */
export function recurrenceObligationsMet(
  ctx: CheckContext,
  enforced: readonly ConstraintType[],
): ConstraintType[] {
  return RECURRENCE_OBLIGATIONS.filter((t) => ctx.state.pending.includes(t) && enforced.includes(t))
}

/* ------------------------------------------------------------------------------------------ */
/* 5 — Checkout binding                                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * Check 5: the checkout JWT's hash equals the L3b's `checkout_hash`, and it was signed by the current
 * **or a retired-but-valid** merchant kid.
 *
 * Three separate facts, all from merchant-side state, none of them taken on trust from a token:
 *
 *  1. **Signature.** Verified locally with a merchant public key from `deps.merchantKeys()`, so this
 *     check does not depend on vi being up. Two hosts disagreeing about a verdict is a bug worth
 *     finding, and a Gate that cannot answer without a network call is a Gate with a 5-second tail on
 *     every decision.
 *  2. **Hash.** `l3b.checkout_hash == checkout_sessions.checkout_hash`. Both values were produced by
 *     vi and both are stored; comparing them needs no knowledge of vi's digest algorithm, which is the
 *     point — an assumption about it would be a place to get it wrong in the direction that allows.
 *  3. **Kid.** In `acceptedKids`, which per `MerchantKeySet` includes retired-but-valid keys. Refusing a
 *     retired key would turn an ordinary key rotation into "every cart in flight fails" for every buyer
 *     at once (EC-KEY-2). A `COMPROMISED` key belongs on a revocation list, not in this set.
 */
export async function check5CheckoutBinding(ctx: CheckContext): Promise<CheckResult> {
  const session = await loadSession(ctx)
  // **Blocking**, not `notApplicable` - see the table on `notApplicable` and QA3-GATE-1. Checks 5-10
  // all hang off this one, so a non-blocking decline here is six checks declining at once and an
  // `ALLOW` signed over a cart that does not exist.
  if (!session) {
    return missing(5, 'no checkout session to bind against, so there is no cart to check')
  }

  const decoded = decodeCheckoutJwt(session.checkout_jwt)
  if (!decoded.ok) {
    return fail(
      5,
      chainInvalid(`checkout JWT for ${session.id} is not a compact JWS: ${decoded.error}`),
    )
  }
  ctx.state.checkoutJwt = decoded.claims

  const keys = await ctx.deps.merchantKeys()
  if (!keys.ok) return fail(5, keys.error, `merchant key set unavailable: ${keys.error.code}`)
  ctx.state.merchantKeys = keys.value

  if (!accepted(keys.value.acceptedKids, decoded.kid ?? '')) {
    return fail(
      5,
      chainInvalid(
        `checkout JWT for ${session.id} is signed by kid ${decoded.kid}, which is neither the current ` +
          `(${keys.value.currentKid}) nor a retired-but-valid merchant key`,
      ),
    )
  }

  const verified = await verifyWithMerchantKey(session.checkout_jwt, decoded.kid, keys.value)
  if (!verified.ok)
    return fail(5, chainInvalid(`checkout JWT signature: ${verified.error.message}`))

  const l3b = decodeL3(ctx.input.l3b)
  ctx.state.l3b = l3b.ok ? l3b.claims : null
  if (!l3b.ok) return fail(5, chainInvalid(`L3b is not a compact JWS: ${l3b.error}`))

  const binding = readSignedCheckout(ctx.state.disclosedL3b)
  if (!binding.found) {
    return missing(
      5,
      `${binding.why}; session ${session.id} locked ${session.checkout_hash ?? '(absent)'}`,
    )
  }
  if (!session.checkout_hash || binding.checkoutHash !== session.checkout_hash) {
    return fail(
      5,
      chainInvalid(
        `L3b binds checkout_hash ${binding.checkoutHash} but session ${session.id} locked ${session.checkout_hash || '(absent)'}`,
      ),
    )
  }
  const payment = readSignedPayment(ctx.state.disclosedL3a)
  if (!payment.found) return fail(5, chainInvalid(payment.why))
  if (payment.payeeId !== session.merchant_id) {
    return fail(
      5,
      chainInvalid(
        `${PAYMENT_SOURCE} payee ${payment.payeeId} is not this session's merchant ${session.merchant_id}`,
      ),
    )
  }
  return pass(
    5,
    `bound to session ${session.id} via ${CHECKOUT_SOURCE}, merchant kid ${decoded.kid}, signed payee ${payment.payeeId}`,
  )
}

/* ------------------------------------------------------------------------------------------ */
/* 6 — Price lock                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * Check 6: `price_lock_exp > now`, the locked totals equal the L3a amount, and the currencies are
 * equal.
 *
 * **`EC-TIME-4` lives in the `now` this is compared against.** `evaluate` captured one `nowSec` before
 * check 1, and it is the same number here and in check 12. With a per-check `now` the lock could expire
 * between two checks and produce a decision that was true at no single instant — which is the specific
 * race §12.5 names.
 *
 * **`EC-FX-1`:** a currency mismatch is `CS_CURRENCY_MISMATCH` and a **conversion never happens**. A
 * user-signed ₹ limit silently becoming a $ spend is exactly what the signature was supposed to prevent;
 * the buyer is told to create a mandate in the store currency.
 *
 * The payee is compared too, although §8.10 does not list it: the disclosed L3a's `payee.id` must be this session's
 * merchant. `mandate.payment.allowed_payees` is checked by vi in check 4, but the Gate holding its own
 * copy of "this cart is for *this* payee" costs three lines and closes I-1's last word — the decision
 * record's `payee` comes from the session, so the record must be derived from the same row.
 */
export async function check6PriceLock(ctx: CheckContext): Promise<CheckResult> {
  const session = ctx.state.checkout ?? (await loadSession(ctx))
  // Blocking, for the reason on `notApplicable` and in check 5. Reachable only if check 5 already
  // declined, but a check must not rely on an earlier check having stopped the run.
  if (!session)
    return missing(6, 'no checkout session to price against, so no amount could be locked')

  const decoded = decodeL3(ctx.input.l3a)
  ctx.state.l3a = decoded.ok ? decoded.claims : null
  if (!decoded.ok) return fail(6, chainInvalid(`L3a is not a compact JWS: ${decoded.error}`))

  const failures: CsError[] = []

  const lock = assertPriceLockValid(session, ctx.now)
  if (!lock.ok) failures.push(lock.error)

  const payment = readSignedPayment(ctx.state.disclosedL3a)
  if (!payment.found) failures.push(csError(payment.code, payment.why))
  else {
    const matches = assertAmountMatchesSession(session, payment.amount)
    if (!matches.ok) failures.push(matches.error)

    // The amount the Gate will reserve is the **merchant's locked total**, not the token's claim.
    // Check 6 has just proved they are equal, so on an ALLOW they are the same number — and on a
    // BLOCK the session total is the one that came from server-side state.
    ctx.state.reserveAmount = { minor: session.total_minor, currency: session.currency }

    const payee = payment.payeeId
    if (payee !== session.merchant_id) {
      failures.push(
        csError(
          'VI_CHAIN_INVALID',
          `${PAYMENT_SOURCE} payee ${payee} is not this session's merchant ${session.merchant_id}`,
          {
            checkoutId: session.id,
            l3aPayee: payee,
            sessionPayee: session.merchant_id,
          },
        ),
      )
    }
  }

  if (failures.length > 0) {
    // The detail names the *first* failure in full and the rest by code. A buyer reading a BLOCK needs
    // the specific numbers ("your locked total is $30.00, the agent asked for $10.00"), and a merchant
    // reading a log needs to see at a glance that more than one thing was wrong.
    const first = failures[0]!
    const rest = failures.slice(1).map((f) => f.code)
    return fail(
      6,
      first,
      rest.length > 0 ? `${first.message} (+${rest.join(', ')})` : first.message,
    )
  }
  return pass(
    6,
    `locked ${formatMoney({ minor: session.total_minor, currency: session.currency })} until ${session.price_lock_exp.toISOString()}; matches ${PAYMENT_SOURCE}.mandate.payment.1.payment_amount and payee.id`,
  )
}

/* ------------------------------------------------------------------------------------------ */
/* 7 — Replay                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * Check 7: this L3 `jti` has not been used before.
 *
 * **EC-IDEM-1.** The check *is* the insert. `checkout_attempts_l3_jti_key` is UNIQUE and
 * `repos/index.ts` maps the `23505` to `GATE_REPLAY`, so a retried LLM turn that re-submits the same
 * signed L3 lands here as a blocked attempt rather than a second charge.
 *
 * A read-then-write pre-check would be the wrong shape: there is a window between the SELECT and the
 * INSERT in which two identical submissions both see "not present", and that window is what an automated
 * retrier is built to find. The insert is atomic; the read is not.
 */
export async function check7Replay(ctx: CheckContext): Promise<CheckResult> {
  const session = ctx.state.checkout ?? (await loadSession(ctx))
  if (!session) return missing(7, 'no checkout session, so there is no cart to bind the attempt to')
  const amount = ctx.state.reserveAmount
  if (!amount) return notApplicable(7, 'no amount resolved by check 6')

  let l3a = ctx.state.l3a
  if (!l3a) {
    const decoded = decodeL3(ctx.input.l3a)
    if (!decoded.ok) {
      return fail(7, chainInvalid(`L3a is not a compact JWS: ${decoded.error}`))
    }
    l3a = decoded.claims
    ctx.state.l3a = l3a
  }
  const replayId = deriveL3ReplayId(ctx.input.l3a)
  if (!replayId.ok) return fail(7, replayId.error)
  const jti = replayId.value

  const row: NewAttemptForGate = {
    id: ctx.input.attemptId,
    mandate_id: ctx.input.mandateId,
    agent_id: ctx.input.agentId,
    checkout_session_id: session.id,
    l3a: ctx.input.l3a,
    l3b: ctx.input.l3b,
    l3_jti: jti,
    idempotency_key: `${ctx.input.attemptId}:${jti}`,
    amount_minor: amount.minor,
    currency: amount.currency,
    payee: session.merchant_id,
  }

  const inserted = await ctx.deps.insertAttempt(row)
  if (!inserted.ok) {
    if (inserted.error.code === 'GATE_REPLAY' || inserted.error.code === 'CS_CONFLICT') {
      ctx.state.replayRejected = true
      return fail(
        7,
        csError('GATE_REPLAY', `L3 jti ${jti} has already been used for a checkout attempt`, {
          table: 'checkout_attempts',
          l3Jti: jti,
        }),
      )
    }
    return fail(7, inserted.error)
  }
  return pass(7, `jti ${jti} is new`)
}

/* ------------------------------------------------------------------------------------------ */
/* 10 — Stock                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/* Checks 8 and 9 live in `budget-guard.ts`: they share one transaction and one reservation, so
 * splitting them across two files would mean the transaction boundary is the *file* boundary. */

/**
 * Check 10: every line has stock.
 *
 * A **read**, deliberately. The decrement happens at `ORDER_CREATED` under a row lock
 * (`repos/products.ts::lockStock` + `decrementStock`, called by the orchestrator in WP-11), because
 * reserving stock at the Gate would hold shelves hostage for an order that may never be created —
 * the same reason the budget reservation has a 30-minute lifetime. §12 EC-STOCK-3's last-unit race is
 * therefore *resolved* at `ORDER_CREATED`, not here; what the Gate owes is to stop telling the buyer
 * something is available when it is not, and to release the budget reservation when it is not
 * (done by `evaluate`'s compensation path).
 */
export async function check10Stock(ctx: CheckContext): Promise<CheckResult> {
  const session = ctx.state.checkout
  // Blocking, for the same reason as check 6.
  if (!session) return missing(10, 'no checkout session, so the line items cannot be checked')

  const lines = cartLines(session)
  if (lines.length === 0) return notApplicable(10, 'the locked cart has no lines')

  const found = await ctx.deps.products(lines.map((l) => l.sku))
  if (!found.ok) return fail(10, found.error)
  const bySku = new Map(found.value.map((p) => [p.sku, p]))

  const short: string[] = []
  for (const line of lines) {
    const product = bySku.get(line.sku)
    if (!product) {
      short.push(`${line.sku} (not in catalog)`)
      continue
    }
    if (product.stock < line.qty)
      short.push(`${line.sku} (${product.stock} left, ${line.qty} wanted)`)
  }
  if (short.length > 0) {
    return fail(
      10,
      csError('GATE_OUT_OF_STOCK', `Not enough stock for: ${short.join(', ')}`, {
        table: 'products',
        lines: short,
      }),
    )
  }
  return pass(10, `${lines.length} line(s) in stock`)
}

/* ------------------------------------------------------------------------------------------ */
/* 11 — Recurrence                                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Check 11: recurrence and `agent_recurrence` windows, read from the **signed** L2.
 *
 * §8.10 says "if present", and §12.5's catalogue does not have a row for an absent constraint — so a
 * mandate with no recurrence constraint reports this check **not applicable**. Not passed. See
 * {@link notApplicable} for why that distinction is load-bearing.
 *
 * `recurrence` and `agent_recurrence` are two of the three constraints the Verifiable Intent library
 * marks network-enforced and does not evaluate (**D19**), so this check and check 8 are the entire
 * reason a buyer's recurring limit is real. `evaluateRecurrence` in `@countersign/ledger` does the
 * arithmetic; this function finds the constraints and asks it the question.
 *
 * ### Two sources, and which one the detail names
 *
 * The constraints come from **both** the verified chain (`state.signedConstraints`, i.e.
 * `verify.disclosed.l2` — the token) and `mandates.constraints` (our JSONB cache), merged by
 * `mergeRecurrenceConstraints`: one window, the tighter occurrence count, and **every** source named
 * in the detail.
 *
 * The old version read only the column and reported `"the signed L2 discloses no recurrence
 * constraint"` when it came up empty. That string was false whenever the signed L2 *did* disclose one
 * and the column had drifted — QA-gate-2 — and because a `notApplicable` row is non-blocking by
 * design, the Gate failed **open** on a signed `recurrence MNTH number:1` with two commits in the
 * window. Reading the token first is the fix; naming the source in the detail is what stops it from
 * regressing.
 *
 * ### Absent is not the same as unreadable
 *
 * A mandate that genuinely discloses no recurrence constraint is *not applicable*, and
 * `notApplicable` is non-blocking — which is correct, because there was nothing to enforce. A
 * recurrence constraint that vi reported as network-enforced and this check could not read is a
 * different fact, and it is a **BLOCK** (`obligationUnmet`).
 */
export async function check11Recurrence(ctx: CheckContext): Promise<CheckResult> {
  const mandate = ctx.state.mandate
  if (!mandate) return notApplicable(11, 'no mandate row: check 1 could not resolve one')

  const signed = ctx.state.signedConstraints
  const merged = mergeRecurrenceConstraints([
    { source: CONSTRAINT_SOURCE.SIGNED_L2, constraints: signed.constraints },
    { source: CONSTRAINT_SOURCE.MANDATE_COLUMN, constraints: mandate.constraints },
  ])

  if (merged.length === 0) {
    // Nothing to enforce **and** nothing owed: honestly not applicable, and the detail says which two
    // places were looked in, so "no recurrence constraint" is a statement about the token and not just
    // about our cache.
    const unmet = obligationUnmet(ctx, RECURRENCE_OBLIGATIONS, [])
    const lookedIn = `no recurrence constraint in ${CONSTRAINT_SOURCE.SIGNED_L2} (vcts: ${signed.vcts.join(', ') || 'none'}) or in ${CONSTRAINT_SOURCE.MANDATE_COLUMN}`
    if (unmet) return fail(11, unmet, `${unmet.message} | ${lookedIn}`)
    return notApplicable(11, lookedIn)
  }

  const enforced = merged.map((r) => r.constraint.type)
  const unmet = obligationUnmet(ctx, RECURRENCE_OBLIGATIONS, enforced)
  const enforcedMet = recurrenceObligationsMet(ctx, enforced)

  const failures: CsError[] = []
  const summaries: string[] = []

  for (const reading of merged) {
    const { constraint } = reading
    const from = ` [read from ${describeSources(reading.sources)}]`
    // Two passes: the window's length decides *which* commits to count, so it has to be resolved before
    // the count is asked for. `evaluateRecurrence` computes the window start from the constraint and
    // the clock; we reuse that rather than recomputing it here.
    const probe = evaluateRecurrence({ constraint, nowSec: ctx.nowSec, commitsInWindow: 0 })
    if (probe.windowSeconds === null) {
      summaries.push(
        `${constraint.type} ${probe.frequency}: no measurable window (not applicable)${from}`,
      )
      continue
    }
    const counted = await ctx.deps.countCommitsSince(
      mandate.id,
      new Date(probe.windowStartSec * 1000),
    )
    if (!counted.ok) return fail(11, counted.error)
    const verdict = evaluateRecurrence({
      constraint,
      nowSec: ctx.nowSec,
      commitsInWindow: counted.value,
    })
    summaries.push(
      `${constraint.type} ${verdict.frequency}: ${verdict.used} in window${verdict.limit === null ? '' : ` of ${verdict.limit}`}${verdict.outsideDateWindow === null ? '' : ` (${verdict.outsideDateWindow})`}${from}`,
    )
    if (!verdict.allowed) {
      failures.push(
        csError(
          'VI_CONSTRAINT_VIOLATION',
          `${constraint.type} ${verdict.frequency} exceeded: ${verdict.used} occurrence(s)${verdict.limit === null ? '' : ` of a signed limit of ${verdict.limit}`}${verdict.outsideDateWindow === null ? '' : `; today is ${verdict.outsideDateWindow}`} — read from ${describeSources(reading.sources)}`,
          {
            constraintType: verdict.constraintType,
            frequency: verdict.frequency,
            used: verdict.used,
            limit: verdict.limit,
            outsideDateWindow: verdict.outsideDateWindow,
            readFrom: reading.sources,
          },
        ),
      )
    }
  }

  if (unmet) failures.unshift(unmet)
  if (failures.length > 0) {
    // Same shape as check 6: the first violation in full, the rest summarised. The summary lists every
    // constraint evaluated, including the ones that passed, because "which of my two recurrence limits
    // was it?" is the question a buyer actually has.
    const first = failures[0]!
    const rest = failures.slice(1).map((f) => f.code)
    const summary = summaries.join(' | ')
    return fail(11, first, rest.length > 0 ? `${first.message} | ${summary}` : summary)
  }
  // Every obligation vi reported was found and evaluated. Say so in the detail, so a `RECURRENCE` row
  // reading `passed: true` next to `pendingNetworkEnforcement: ['mandate.payment.recurrence']` is
  // self-evidently consistent rather than requiring the reader to take it on trust.
  const obligationNote =
    enforcedMet.length > 0
      ? ` | D19 obligation discharged for ${enforcedMet.join(', ')}`
      : ' | no network-enforced recurrence obligation was reported'
  return pass(11, `${summaries.join(' | ')}${obligationNote}`)
}

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                       */
/* ------------------------------------------------------------------------------------------ */

function notFound(table: string, id: string, noun: string): CsError {
  return csError(
    'CS_NOT_FOUND',
    `No ${table} row for ${id}`,
    { table, id },
    {
      userMessage: `We could not find that ${noun}.`,
    },
  )
}

function chainInvalid(message: string): CsError {
  return csError('VI_CHAIN_INVALID', message)
}

/** Accepted kids: the current one plus every retired-but-valid one. */
export function accepted(kids: readonly string[], kid: string): boolean {
  return kids.includes(kid)
}

/**
 * Read a JWS header `kid` without verifying anything. Returns `null` for a token that is not a compact
 * JWS — the *failure* is reported by the check that also verifies the signature.
 */
export function decodeHeaderKid(jws: string): string | null {
  const parts = jws.split('.')
  if (parts.length !== 3) return null
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'))
    const kid = (header as { kid?: unknown }).kid
    return typeof kid === 'string' ? kid : null
  } catch {
    return null
  }
}

/** The cart's lines, from the JSONB `checkout_sessions.cart` column. */
export function cartLines(session: CheckoutSessionRow): Array<{ sku: string; qty: number }> {
  const cart = session.cart as { lines?: unknown } | null
  const raw = Array.isArray(cart?.lines) ? cart.lines : []
  const out: Array<{ sku: string; qty: number }> = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const sku = (entry as { sku?: unknown }).sku
    const qty = (entry as { qty?: unknown }).qty
    if (typeof sku !== 'string') continue
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) continue
    out.push({ sku, qty })
  }
  return out
}

/** Read money from vi's resolved signed L3a, never from the issuer JWS's top-level claims. */
export function l3aAmount(disclosedL3a: unknown): Result<Money, CsError> {
  const payment = readSignedPayment(disclosedL3a)
  return payment.found ? ok(payment.amount) : err(csError(payment.code, payment.why))
}

/** Sign a `checks_hash` input: the twelve rows, nothing else. */
export function checkSetHashInput(checks: readonly GateCheck[]): unknown {
  return checks.map((c) => ({
    n: c.n,
    code: c.code,
    passed: c.passed,
    detail: c.detail ?? null,
    notApplicable: c.notApplicable ?? false,
  }))
}

/** The currency a decision records, from the session, falling back to the reserved amount. */
export function decisionCurrency(ctx: CheckContext): Currency | null {
  return ctx.state.checkout?.currency ?? ctx.state.reserveAmount?.currency ?? null
}

/**
 * Load the checkout session once and remember it.
 *
 * Checks 5, 6, 7 and 10 all need it. Loading it once is not only cheaper — it is what makes a decision
 * internally consistent, so "the cart the price was locked for" is one row rather than four reads that
 * might see four different states.
 *
 * @returns `null` when there is no session, which the callers report as *not applicable* rather than
 * as passed: an absent cart is not a satisfied cart.
 */
export async function loadSession(ctx: CheckContext): Promise<CheckoutSessionRow | null> {
  if (ctx.state.checkout) return ctx.state.checkout
  const found = await ctx.deps.checkout(ctx.input.checkoutId)
  if (!found.ok) return null
  ctx.state.checkout = found.value ?? null
  return ctx.state.checkout
}

/* ------------------------------------------------------------------------------------------ */
/* Money discipline note                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * `amount_minor` off an L3 is read through `bigintFromJson` and nowhere else.
 *
 * There is no `Number(...)`, no `parseFloat` and no `Math.round` on any amount in this package, and
 * `scripts/check-money-discipline.mjs` scans `packages/gate/src` to keep it that way. EC-FX-6's
 * "the VI example helper uses float dollars" is the failure this repository refuses to reproduce.
 */
