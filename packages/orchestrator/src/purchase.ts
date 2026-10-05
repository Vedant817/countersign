/**
 * `createOrderFromIntent` and `runGateEvaluation` — spec **§10.2** row 5, **§8.8**, **§8.10**, **§8.11**,
 * core invariant **I-1** (§3.1), §12.2 (**EC-IDEM-1**, **EC-IDEM-2**), §12.4.
 *
 * ## The order, and why each arrow is load-bearing
 *
 * ```
 *   recover-or-decide ──▶ gate.evaluate ──▶ decision.decision === 'ALLOW' ? ──no──▶ return REFUSED
 *          │                    │                             │ yes
 *          │                    │                             ▼
 *          │                    │                  store.decide(decision)
 *          │                    ▼
 *          └─── replay?   createOrderFromDecision ──▶ ORDERED
 * ```
 *
 * Two of those arrows are the whole design, and both exist because of I-1 rather than for elegance:
 *
 * 1. **`gate.evaluate` is the only thing between the buyer's words and PayPal.** Not a check of the decision,
 *    not a re-read — *the call*. There is no path from this file to `deps.orders.paypal` that does not go
 *    through `evaluate` returning `ALLOW`, because {@link createOrderFromDecision} is called on exactly one
 *    line and that line is inside `if (decision.decision === 'ALLOW')`.
 *
 * 2. **The decision is persisted before the order is created** (`store.decide`). This is not bookkeeping.
 *    `createOrderFromDecision` re-reads `gate_decisions` by id and refuses with `CS_NOT_FOUND` if the row
 *    is absent — so a decision that is not written is a purchase that can never complete, and a decision
 *    that is written but not linked to its attempt is a decision that cannot be found on a retry. Neither
 *    write happens anywhere else in the repository; `git grep createGateDecision` finds a definition and
 *    no caller, which is precisely the gap this package was created to close.
 *
 * ## The idempotency rule, stated once
 *
 * `evaluate` is **not** idempotent, and treating it as if it were would be a correctness bug rather than an
 * optimisation. Check 7 is a replay detector: a second call for the same `l3_jti` hits
 * `checkout_attempts_l3_jti_key` and returns `GATE_REPLAY`. So "run the pipeline twice, get the same
 * answer" cannot mean "call `evaluate` twice".
 *
 * It means: **ask the database whether this attempt has already been decided, and if so return that
 * decision.** {@link OrchestratorStore.decisionForAttempt} is that read. The consequence is the property
 * EC-IDEM-1 and EC-IDEM-2 both need:
 *
 * - a duplicate submission performs **no** PayPal call and returns the same order;
 * - a crash between `store.decide` and the PayPal call resumes at `createOrderFromDecision` with the same
 *   `PayPal-Request-Id` (`cs:{attemptId}:create`), so PayPal itself collapses the retry onto the order it
 *   already made.
 *
 * ## The refusals are `ok`, not `err`
 *
 * A `BLOCK` is a successful run of the Gate that produced a recorded, signed, reviewable outcome. Returning
 * it as `err` would make the S-05 attempt list lose every block in the product, and would make an agent's
 * retry loop treat a policy decision as a fault — the opposite of what §3.1 I-1 is for. `err` is reserved
 * for the runs that genuinely did not produce a decision: an unreachable compiler, a Gate that could not be
 * evaluated, a PayPal call that failed after the money question was already settled.
 */
import {
  csError,
  err,
  ok,
  type CsError,
  type GateDecisionId,
  type Money,
  type Result,
} from '@countersign/core'
import type { CompiledMandate } from '@countersign/compiler'
import type { GateDecisionRow } from '@countersign/db'
import { evaluate, type GateDecision } from '@countersign/gate'
import { createOrderFromDecisionDetailed } from '@countersign/orders'

import type {
  GateEvaluation,
  OrchestratorDeps,
  OrderFromIntent,
  PurchaseIntent,
  PurchaseStage,
} from './types'

/* ------------------------------------------------------------------------------------------ */
/* The Gate call                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * Run the Gate for one attempt, or recover the decision a previous run already recorded.
 *
 * This is the standalone entry point Judge Mode (WP-20, S-21) uses to demonstrate a decision without
 * creating an order, and it is also the half of {@link createOrderFromIntent} that the order path calls.
 * Exported separately because "show me the decision" and "act on the decision" are two different
 * questions and a caller that wants the first should not have to opt out of the second.
 *
 * @returns `ok` for `BLOCK` and `REVIEW`. `err` only when the Gate could not be evaluated at all.
 */
export async function runGateEvaluation(
  input: PurchaseIntent,
  deps: OrchestratorDeps,
): Promise<Result<GateEvaluation, CsError>> {
  const attemptId = input.gate.attemptId

  const prior = await deps.store.decisionForAttempt(attemptId)
  if (!prior.ok) return prior
  if (prior.value !== undefined) {
    const recovered = gateDecisionFromRow(prior.value)
    if (recovered !== null) {
      deps.logger?.info('orchestrator.gate: recovered a recorded decision', {
        attempt_id: attemptId,
        gate_decision_id: recovered.id,
        outcome: recovered.decision,
        idempotent: true,
      })
      return ok({ decision: recovered, attemptId, idempotent: true })
    }
    // A row we cannot read is a row we must not overwrite. `evaluate` would insert a second decision for
    // the same attempt and take a second reservation, and nothing would say so until a buyer's budget was
    // short by one cart. Refusing is the only safe answer.
    return err(
      csError(
        'CS_VALIDATION',
        `gate_decisions row ${prior.value.id} could not be read back as a decision, so the Gate was not ` +
          're-run. Overwriting it could take a second reservation for one attempt.',
        { table: 'gate_decisions', id: prior.value.id, attemptId },
      ),
    )
  }

  const decided = await evaluate(input.gate, deps.gate)
  if (!decided.ok) return decided

  const persisted = await deps.store.decide({
    decision: decided.value,
    attemptId,
    at: new Date(deps.clock.nowMs()),
  })
  if (!persisted.ok) return persisted
  if (persisted.value === undefined) {
    // See `OrchestratorStore.decide`: a `GATE_REPLAY` has no attempt row to link a decision to. The
    // decision is still the answer the caller needs, so it is returned rather than turned into a fault —
    // and an `ALLOW` in this state cannot create an order, because the row it would read does not exist.
    deps.logger?.warn('orchestrator.gate: no attempt row to store the decision against', {
      attempt_id: attemptId,
      gate_decision_id: decided.value.id,
      outcome: decided.value.decision,
      reasons: decided.value.reasons.map((r) => r.code),
    })
  }

  deps.logger?.info('orchestrator.gate: decision recorded', {
    attempt_id: attemptId,
    gate_decision_id: decided.value.id,
    outcome: decided.value.decision,
    stored: persisted.value !== undefined,
    reasons: decided.value.reasons.map((r) => r.code),
  })

  return ok({ decision: decided.value, attemptId, idempotent: false })
}

/* ------------------------------------------------------------------------------------------ */
/* The purchase pipeline                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Intent → compiled read-back → Gate decision → PayPal order.
 *
 * Every step's `Result` is propagated and the run stops at the first failure. Two of those failures are
 * *before* any money question exists and are reported as `ok` with a stage, because they are answers:
 *
 * | Stage | Reached | PayPal called? |
 * |---|---|---|
 * | `AMBIGUOUS` | §8.8 produced a blocking question | no — the Gate was never reached |
 * | `REFUSED` | the Gate answered, and the answer was not `ALLOW` | no |
 * | `ORDERED` | the Gate answered `ALLOW` and PayPal was called | yes, exactly once |
 *
 * ### The one assertion this file exists to make
 *
 * `deps.orders.paypal.createOrder` is reachable from exactly one line of this file, and that line is
 * guarded by `decision.decision === 'ALLOW'`. `packages/orders` refuses a non-`ALLOW` as well, so I-1 has
 * two independent guards rather than one — but the guard that matters is the one *here*, because
 * `createOrderFromDecision` is the only function in the repository that can move a buyer's money on the
 * purchase path and this is the only caller of it.
 */
export async function createOrderFromIntent(
  input: PurchaseIntent,
  deps: OrchestratorDeps,
): Promise<Result<OrderFromIntent, CsError>> {
  // --- 0. The compiler, if this submission brought words with it ---------------------------------------
  //
  // Skipped on a re-submission (EC-IDEM-1): the mandate is already signed, so re-deriving its constraints
  // with a model would change nothing an authority is bound by and cost a call. The Gate below is
  // unaffected — it reads the stored chain, not this value.
  const compiled = await compileIfAsked(input, deps)
  if (!compiled.ok) return compiled
  const { mandate, readback } = compiled.value

  if (mandate !== null && deps.compiler.hasBlockingAmbiguities(mandate)) {
    // §8.8: "an unresolvable intent MUST produce an ambiguity, not a guess". An invented cap is authority
    // the buyer never granted, so this stops before the Gate rather than reaching it with a hole.
    deps.logger?.info('orchestrator.purchase: stopping on a blocking ambiguity', {
      attempt_id: input.gate.attemptId,
      ambiguities: mandate.ambiguities.map((a) => a.field),
    })
    return ok(stopped('AMBIGUOUS', mandate, readback))
  }

  // --- 1. The Gate, or the decision it already recorded -----------------------------------------------
  const evaluated = await runGateEvaluation(input, deps)
  if (!evaluated.ok) return evaluated
  const decision = evaluated.value.decision

  // --- 2. I-1: only an ALLOW reaches PayPal ------------------------------------------------------------
  if (decision.decision !== 'ALLOW') {
    deps.logger?.info('orchestrator.purchase: Gate refused, no PayPal call', {
      attempt_id: input.gate.attemptId,
      gate_decision_id: decision.id,
      outcome: decision.decision,
      reasons: decision.reasons.map((r) => r.code),
    })
    return ok({
      stage: 'REFUSED',
      compiled: mandate,
      readback,
      decision,
      orderId: null,
      idempotent: evaluated.value.idempotent,
    })
  }

  // --- 3. The one money movement -------------------------------------------------------------------------
  //
  // `createOrderFromDecisionDetailed` rather than the bare function because the report says which PayPal
  // path ran (`INLINE` vs the §11 check-C2 fallback) and whether the order already existed. Both are what a
  // receipt has to state and what a retry has to distinguish.
  const created = await createOrderFromDecisionDetailed(decision, deps.orders)
  if (!created.ok) return created

  deps.logger?.info('orchestrator.purchase: order created', {
    attempt_id: input.gate.attemptId,
    gate_decision_id: decision.id,
    order_id: created.value.order.id,
    paypal_order_id: created.value.order.paypal_order_id,
    authorization_path: created.value.authorizationPath,
    capture_path: created.value.capturePath,
    idempotent: created.value.idempotent || evaluated.value.idempotent,
  })

  return ok({
    stage: 'ORDERED',
    compiled: mandate,
    readback,
    decision,
    orderId: created.value.order.id,
    idempotent: created.value.idempotent || evaluated.value.idempotent,
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Steps                                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Compile and read back, when the submission carried words.
 *
 * The read-back is produced **here** rather than asked of the caller, and that is the point: §18 question 46
 * asks "how do you know the user signed something they understood?", and the answer is that the sentence
 * they signed and the sentence reported back are the same call into the same pure template. Two callers
 * rendering it twice could render it differently the moment the template grew a locale.
 */
interface CompiledStep {
  readonly mandate: CompiledMandate | null
  readonly readback: string | null
}

async function compileIfAsked(
  input: PurchaseIntent,
  deps: OrchestratorDeps,
): Promise<Result<CompiledStep, CsError>> {
  if (input.text === undefined || input.text.trim() === '') {
    return ok({ mandate: null, readback: null })
  }
  const result = await deps.compiler.compile({
    userId: input.userId,
    text: input.text,
    locale: input.locale ?? 'en-IN',
    defaults: {
      currency: input.defaults?.currency ?? 'USD',
      merchantIds: input.defaults?.merchantIds ?? [],
    },
  })
  if (!result.ok) return result
  const readback = deps.compiler.readBack(result.value, {
    merchants: input.merchants,
    tz: 'Asia/Kolkata',
  })
  return ok({ mandate: result.value, readback })
}

/** A run that stopped before the Gate: the two answers the caller still needs to render. */
function stopped(
  stage: Extract<PurchaseStage, 'AMBIGUOUS'>,
  mandate: CompiledMandate,
  readback: string | null,
): OrderFromIntent {
  return {
    stage,
    compiled: mandate,
    readback,
    decision: null,
    orderId: null,
    idempotent: false,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Reading a stored decision back                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * Rebuild a {@link GateDecision} from its row.
 *
 * ### Why this is not a cast
 *
 * `createOrderFromDecision` needs only `id`, `decision` and `reasons` — it re-reads the draft from the
 * database by id, so the signed record and the reservation come from the row rather than from the object
 * we hand it. That makes a recovery path *possible* at all, which is what EC-IDEM-2 needs: after a crash
 * between the decision and the order, the in-memory decision is gone and only the row is left.
 *
 * ### The one field that cannot be recovered, and why it does not matter here
 *
 * `pendingNetworkEnforcement` (D-019) is not a column: it is derived at Gate time from what vi reported
 * skipping. There is no way to read it back, so it is reconstructed as `[]`, and that is stated rather
 * than hidden. It is safe **for this caller only**, because `createOrderFromDecision` never reads the
 * field — the D-019 obligation was discharged by the original `evaluate` call that produced the row, and
 * nothing downstream re-derives it. Any future caller that needs it must re-verify the chain, not trust
 * this reconstruction; that is recorded in the README so the shortcut cannot be inherited silently.
 *
 * @returns `null` when the row's jsonb members are not the arrays `gate_decisions` declares. A caller must
 *   treat `null` as "refuse", not as "cast it and hope".
 */
export function gateDecisionFromRow(row: GateDecisionRow): GateDecision | null {
  const reasons = asArray(row.reasons)
  const checks = asArray(row.checks)
  if (reasons === null || checks === null) return null
  return {
    id: row.id as GateDecisionId,
    decision: row.decision,
    reasons: reasons as GateDecision['reasons'],
    checks: checks as GateDecision['checks'],
    signedRecord: row.signed_record,
    nowSec: Math.floor(row.decided_at.getTime() / 1000),
    // Not recoverable — see the function's own comment. Never read by the only caller.
    pendingNetworkEnforcement: [],
  }
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

/** Re-exported so a caller naming an amount in a log has one import for the vocabulary. */
export type { Money }
export { err as orchestrationErr }
export type { Result as OrchestrationResult }
