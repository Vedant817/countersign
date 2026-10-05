/**
 * `@countersign/orchestrator` types — spec **§10.2** (PayPal call order), **§8.8**, **§8.10**, **§8.11**,
 * **§8.12**, **§8.15**, core invariant **I-1** (§3.1), §12.3, §12.4.
 *
 * ## Why this package exists at all
 *
 * Every module below it was written and tested as if the one above it existed, and none of them calls each
 * other. `packages/gate` decides and returns a decision. `packages/orders` refuses anything that is not an
 * `ALLOW` and then creates the PayPal order. `packages/defender` files a dispute. Each of them is correct,
 * and before this package nothing ever asked any of them to run. This file's sibling, `src/index.ts`, is
 * the single place where the order of those calls is written down.
 *
 * ## What is *not* here
 *
 * **No policy, no arithmetic, no HTTP.** Every judgement — "is this purchase allowed", "what is the refund
 * arithmetic", "what should the dispute posture be" — already has an owner and an owner that is tested far
 * more thoroughly than anything in this package could be. What lives here is only the *sequence* and the
 * *stopping rule*: run these, in this order, and the first failure ends the run.
 *
 * ## Why every dependency is a closed list
 *
 * The same reasoning as `GateDeps` (§8.10, D-018) and `OrdersDeps` (§8.11). It matters more here, not less,
 * because this is the only package whose whole job is to hold several of them at once: a dependency list that
 * is not closed is a package that can grow a new capability without anyone reading the diff as a policy
 * change. In particular `OrchestratorDeps` is where you would add a model, and the fact that the compiler's
 * model port stops at {@link IntentCompiler.compile} — never at `GateDeps` — is what makes "the Gate is
 * LLM-free" a statement about a type rather than a promise in a README.
 */
import type {
  AttemptId,
  Clock,
  CsError,
  Currency,
  Logger,
  MandateId,
  Result,
  UserId,
} from '@countersign/core'
import * as compiler from '@countersign/compiler'
import type { fileDispute, ingestDisputeToDefender } from '@countersign/defender'
import type {
  CompileDeps,
  CompiledMandate,
  CompileInput,
  ReadBackContext,
} from '@countersign/compiler'
import type { BudgetEntryRow, CheckoutAttemptRow, GateDecisionRow } from '@countersign/db'
import type { GateDecision, GateDeps, GateInput } from '@countersign/gate'
import type { BudgetStore } from '@countersign/ledger'
import type { OrdersDeps } from '@countersign/orders'

/* ============================================================================================ */
/* 1. The compiler seam                                                                          */
/* ============================================================================================ */

/**
 * The three compiler calls this package makes, and nothing else.
 *
 * A `Pick`-shaped port rather than the whole `CompileDeps`, for one reason: **`CompileDeps` contains a
 * language model, and this package's most important structural claim is that a model cannot reach the
 * Gate.** Narrowing the port to `compile` / `readBack` / `hasBlockingAmbiguities` means the compiler's
 * `llm` member is unreachable from here — there is no property path from {@link OrchestratorDeps} to it.
 *
 * `packages/compiler` is the only member of the dependency list allowed to reach a model (D-018), and it
 * reaches one only to *propose* constraints that zod then validates and that deterministic code then
 * re-checks (spec §8.0 rule 4). Nothing it returns is authoritative.
 */
export interface IntentCompiler {
  /** `@countersign/compiler`'s `compile`. Words in, a zod-validated proposal out. */
  compile(input: CompileInput): Promise<Result<CompiledMandate, CsError>>
  /**
   * `@countersign/compiler`'s `readBack` — the deterministic string the buyer signs.
   *
   * Pure: no model, no clock, no I/O. It is called here rather than by the caller because "the thing the
   * user signed" and "the thing the Gate enforced" are the same artefact and must not be produced twice.
   */
  readBack(mandate: CompiledMandate, ctx: ReadBackContext): string
  /** `@countersign/compiler`'s `hasBlockingAmbiguities`. A blocking question stops the run **before** the Gate. */
  hasBlockingAmbiguities(mandate: CompiledMandate): boolean
}

/**
 * Build the production {@link IntentCompiler}: the real functions, bound together.
 *
 * A three-line rename-and-forward, which is the same shape `gateDepsFromRepos` and `orderStoreFromRepos`
 * take. It exists so that "which compiler functions does the orchestrator call" is a question about one
 * function rather than about a call site that could drift.
 */
export function compilerFrom(deps: CompileDeps): IntentCompiler {
  return {
    compile: (input) => compiler.compile(input, deps),
    readBack: (mandate, ctx) => compiler.readBack(mandate, ctx),
    hasBlockingAmbiguities: (mandate) => compiler.hasBlockingAmbiguities(mandate),
  }
}

/* ============================================================================================ */
/* 2. Our own rows                                                                                */
/* ============================================================================================ */

/**
 * The `@countersign/db` reads and writes this package needs **itself**, as a port.
 *
 * Small on purpose, and each member names the repository that satisfies it. Two of the three exist because
 * nothing else in the repository performs them, and both are load-bearing rather than cosmetic:
 *
 * - {@link OrchestratorStore.decide} — `repos/gate.ts::createGateDecision` plus
 *   `repos/attempts.ts::linkGateDecision`. **`packages/gate` does not do this.** `evaluate()` returns a
 *   decision *in memory* and that is the end of it, but `createOrderFromDecision` re-reads the decision
 *   from `gate_decisions` by id. So without a writer, every `ALLOW` in the system would be followed by
 *   `CS_NOT_FOUND gate_decisions` and no order would ever exist. This is the seam that closes that.
 * - {@link OrchestratorStore.decisionForAttempt} — the idempotency read. See `purchase.ts`.
 */
export interface OrchestratorStore {
  /**
   * Record a Gate decision and link it to its attempt, atomically.
   *
   * Two writes, one transaction. A decision row whose attempt is not linked is a decision the orchestrator
   * cannot find on a retry, which is exactly the state that makes EC-IDEM-2 unrecoverable.
   *
   * @returns the stored row, or **`undefined` when the attempt row does not exist** — which is not an
   *   error. It is what a `GATE_REPLAY` looks like from here: check 7 refused the insert because the `l3_jti`
   *   was already used, so the new attempt id has no row and `gate_decisions.attempt_id`'s foreign key has
   *   nothing to point at. Nothing is written and the decision is returned to the caller anyway, because the
   *   caller's next job is to *explain the replay* (§8.10's `GATE_REPLAY` userMessage is exactly that), not
   *   to see a database constraint. An `ALLOW` in this state fails closed one step later, when
   *   `createOrderFromDecision` cannot find the decision row.
   */
  decide(input: {
    readonly decision: GateDecision
    readonly attemptId: AttemptId
    readonly at: Date
  }): Promise<Result<GateDecisionRow | undefined, CsError>>

  /**
   * The decision already recorded for this attempt, or `undefined`.
   *
   * `repos/gate.ts::listDecisionsForAttempt` / `findLatestDecisionForAttempt`. Read on every call, before
   * the Gate, because the Gate's check 7 is a **replay detector** (`GATE_REPLAY`) rather than an
   * idempotent replay: re-running it for an attempt it has already answered is the wrong way to be
   * idempotent. This read is how a duplicate submission gets the same answer without asking again.
   */
  decisionForAttempt(attemptId: AttemptId): Promise<Result<GateDecisionRow | undefined, CsError>>

  /**
   * Attempts created before `olderThan` that are still `CREATED` or `GATED_ALLOW`.
   *
   * `repos/attempts.ts::findStaleAttempts` — §8.10's "reservations expire after 30 min without an order".
   */
  staleAttempts(olderThan: Date): Promise<Result<CheckoutAttemptRow[], CsError>>

  /**
   * `budget_entries` for one mandate. `repos/budget.ts::listEntries`.
   *
   * Read by the sweep to skip a reservation that has already been released, which is what makes the
   * sweep idempotent rather than merely repeatable.
   */
  budgetEntries(mandateId: MandateId): Promise<Result<BudgetEntryRow[], CsError>>

  /**
   * `repos/attempts.ts::setAttemptState`. Used **only** to close an attempt whose 30 minutes ran out, so
   * `findStaleAttempts` stops returning it.
   *
   * Optional, and its absence is logged rather than fatal: the sweep is still correct without it (the
   * ledger entry id is the real idempotency key), it just re-reads the same rows every five minutes.
   */
  setAttemptState?(
    attemptId: AttemptId,
    state: 'AUTH_EXPIRED',
    at: Date,
  ): Promise<Result<CheckoutAttemptRow, CsError>>
}

/* ============================================================================================ */
/* 3. The Defender seam                                                                           */
/* ============================================================================================ */

/**
 * The two Defender calls `ingestAndDefend` makes.
 *
 * `FileDeps`, `FileOptions` and `FileOutcome` are **not** re-exported from `@countersign/defender`'s
 * index, so they are recovered here with `Parameters<typeof …>` / `ReturnType<typeof …>`. That is
 * preferable to restating them: the declaration cannot drift from the function's real signature, and if
 * WP-15e adds a re-export the only difference is that these aliases become redundant rather than wrong.
 */
export interface DefenderSeam {
  /** `@countersign/defender`'s `ingestDisputeToDefender` — §8.12's re-fetch, then store, join and rank. */
  ingest: typeof ingestDisputeToDefender
  /** `@countersign/defender`'s `fileDispute` — route, log the rule, guard the clock, then act. */
  file: typeof fileDispute
}

/** What `fileDispute` needs, recovered rather than restated. See {@link DefenderSeam}. */
export type FileDeps = Parameters<DefenderSeam['file']>[1]
/**
 * What `fileDispute` returns on success, recovered rather than restated. See {@link DefenderSeam}.
 *
 * `Extract<…, { ok: true }>` rather than `NonNullable<…>`: the declared return is
 * `Promise<Result<FileOutcome, CsError>>`, so unwrapping the envelope means *narrowing to the success
 * branch* — taking `[…]['value']` of it — not merely removing `null`. A `NonNullable` here would silently
 * yield the `Result` itself, and the mistake would show up as a `.value` that does not exist.
 */
export type FileOutcome = Extract<Awaited<ReturnType<DefenderSeam['file']>>, { ok: true }>['value']
/** `fileDispute`'s options bag. See {@link DefenderSeam}. */
export type FileOptions = NonNullable<Parameters<DefenderSeam['file']>[2]>

/* ============================================================================================ */
/* 4. OrchestratorDeps                                                                            */
/* ============================================================================================ */

/**
 * Everything this package may reach.
 *
 * Closed, for the reason at the top of this file, and the audit surface is the interesting part:
 *
 * | Member | Reaches a model? | Moves money? | Used by |
 * |---|---|---|---|
 * | {@link clock} | no | no | every path |
 * | {@link compiler} | **yes**, one step earlier | no | `createOrderFromIntent` |
 * | {@link gate} | **no** — `GateDeps` has no such member (D-018) | **no** — it reserves, it does not charge | every path |
 * | {@link orders} | no | **yes** — the only member that can | `createOrderFromIntent` |
 * | {@link budget} | no | yes, inside the ledger's own locking primitives | `releaseExpiredReservations` |
 * | {@link store} | no | no | every path |
 * | {@link defender} | no — `FileDeps.llm` is optional and only drafts *notes* | yes, on a `REFUND` posture | `ingestAndDefend` |
 *
 * The row that matters is `orders`. §3.1 I-1 is enforced structurally by the fact that
 * `createOrderFromDecision` refuses any decision that is not `ALLOW`, and by the fact that only this
 * package's `purchase.ts` calls it.
 */
export interface OrchestratorDeps {
  /** The only time source (AGENTS.md rule 10). One `Clock`, passed down to everything that needs one. */
  readonly clock: Clock
  /** §8.8. The one member of this list that reaches a language model. */
  readonly compiler: IntentCompiler
  /** §8.10. `evaluate(i, deps.gate)` — the sole decider (§3.1 I-1). */
  readonly gate: GateDeps
  /** §8.11. `createOrderFromDecision(decision, deps.orders)` — the only money movement on the purchase path. */
  readonly orders: OrdersDeps
  /** §8.10 / §7.2. The ledger primitives the 30-minute sweep releases through. */
  readonly budget: BudgetStore
  /** §7.2. Our own rows. See {@link OrchestratorStore} for why two of these exist only here. */
  readonly store: OrchestratorStore
  /** §8.15 / §10.2 rows 13–16. Reached only by `ingestAndDefend`. */
  readonly defender?: DefenderSeam
  /** Optional. Never for content — the Defender's composed copy still comes from the router. */
  readonly logger?: Logger
}

/* ============================================================================================ */
/* 5. Inputs and outputs                                                                          */
/* ============================================================================================ */

/**
 * What a buyer asked for, plus the signed chain that will be checked against it.
 *
 * ### Why the signed chain is an *input* and not something this package obtains
 *
 * L2 is signed by a **human holding a non-extractable WebCrypto key behind a passkey** (§8.5), and L3 is
 * signed by an agent key held by vi-service (§8.3). Neither exists until that happens, and inventing one
 * here would be the single worst thing this package could do. So the chain arrives as an argument and the
 * Gate's job is to decide whether it is any good.
 *
 * ### Why `text` is optional
 *
 * Because the normal path is a **re-submission**: a buyer who has already compiled, reviewed and signed a
 * mandate submits the same signed chain again (EC-IDEM-1) and there is no point asking a model to
 * re-derive the same constraints. With `text` omitted the compiled step is skipped and
 * {@link OrderFromIntent.compiled} is `null`; the run is otherwise identical, and the Gate still runs (or
 * is recovered, see `purchase.ts`).
 */
export interface PurchaseIntent {
  /** The buyer's own words, §8.8. Omitted on a re-submission of an already-signed mandate. */
  readonly text?: string
  /** Who is buying. §8.8's `CompileInput.userId`. */
  readonly userId: UserId
  readonly locale?: 'en-IN' | 'en-US'
  readonly defaults?: { readonly currency: Currency; readonly merchantIds: string[] }
  /** §8.10's `GateInput`, verbatim. The attempt id is the orchestrator's idempotency key. */
  readonly gate: GateInput
  /** Merchant id → display name, for `readBack`. §8.8's template context. */
  readonly merchants: Readonly<Record<string, string>>
}

/** Which stage of the purchase a {@link OrderFromIntent} got to. */
export type PurchaseStage =
  /** §8.8's ambiguity list is non-empty. The Gate was **not** reached. */
  | 'AMBIGUOUS'
  /** The Gate answered, and the answer was not `ALLOW`. No PayPal call was made. */
  | 'REFUSED'
  /** The Gate answered `ALLOW` and PayPal was called. */
  | 'ORDERED'

/**
 * Everything a caller needs to explain the outcome to a buyer and to an agent.
 *
 * Note the shape of the refusals: they are **`ok`**, not `err`. A `BLOCK` is a successful run of the Gate
 * that produced a recorded outcome, exactly as a refused filing is a successful run of the Defender's
 * filer (`packages/defender`'s `FileOutcome`). Collapsing the two would make the S-05 attempt list lose
 * every block in the product.
 */
export interface OrderFromIntent {
  readonly stage: PurchaseStage
  /** §8.8's compiled proposal, or `null` on a re-submission. Never authoritative (AGENTS.md rule 4). */
  readonly compiled: CompiledMandate | null
  /** §8.8's deterministic read-back, or `null` on a re-submission. */
  readonly readback: string | null
  /** §8.10's signed decision. `null` only when the run stopped before the Gate. */
  readonly decision: GateDecision | null
  /** §8.11's order row. `null` unless `stage === 'ORDERED'`. */
  readonly orderId: string | null
  /** `true` when this call returned an already-recorded outcome and made **no** new decision. */
  readonly idempotent: boolean
}

/**
 * The outcome of one standalone Gate evaluation.
 *
 * Returned as `ok` for a `BLOCK` and a `REVIEW` for the same reason {@link OrderFromIntent} does: the
 * decision *is* the answer, and the caller's next job is to explain it.
 */
export interface GateEvaluation {
  readonly decision: GateDecision
  readonly attemptId: AttemptId
  /** `true` when the decision was recovered from a previous run rather than freshly computed. */
  readonly idempotent: boolean
}

/** What `ingestAndDefend` did, in the order §10.2 rows 13–16 put it. */
export interface DefendOutcome {
  /** §8.12 step 2: the re-fetched dispute. A payload is a hint about what to fetch; this is the fetch. */
  readonly paypalDisputeId: string
  /** The `dsp_…` row, linked to its order when §8.15's join succeeded. */
  readonly disputeId: string
  readonly linked: boolean
  /** `fileDispute`'s outcome, including a refusal. A refusal is `ok`. */
  readonly file: FileOutcome
  /** The route's verdict, named so the caller need not reach into `file.decision`. */
  readonly posture: FileOutcome['decision']['posture']
}

/** One reservation the sweep released, and what it gave back. */
export interface ReleasedReservation {
  readonly attemptId: AttemptId
  readonly mandateId: MandateId
  /**
   * The reservation's own amount — **what was asked back**.
   *
   * `releaseIn` clamps at the current `reserved`, so on a partial release this is larger than what was
   * actually returned. The ledger entry's `amount_minor` is the authoritative figure; this one is here so a
   * report can say which reservation it was talking about without a second query.
   */
  readonly amountMinor: bigint
  readonly currency: string
  /** The buyer's budget **after** the release. */
  readonly balance: { readonly reservedMinor: bigint; readonly availableMinor: bigint }
}

/** §8.10's 30-minute sweep, reported honestly — including what it did **not** do. */
export interface ReservationReleaseReport {
  /** Candidates `findStaleAttempts` returned, before any filtering. */
  readonly candidates: number
  /** Released because the 30 minutes had run out. */
  readonly released: ReleasedReservation[]
  /** Already released by an earlier sweep or an explicit void. The deterministic entry id, working. */
  readonly alreadyReleased: AttemptId[]
  /** Still inside the window. `now < created + 1800s`. */
  readonly stillHeld: AttemptId[]
  /** One broken mandate must not strand the others, so failures are collected rather than thrown. */
  readonly errors: CsError[]
  readonly nowSec: number
  /** The instant the window is measured from, in both representations (AGENTS.md rule 10). */
  readonly now: { readonly epochSec: number; readonly utc: string; readonly ist: string }
}

export type { GateDecision, GateInput, CompiledMandate, Result }
