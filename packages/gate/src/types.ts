/**
 * `@countersign/gate` types — spec **§8.10** (M10), **§8.9** (M9), **D19**, core invariant **I-1** (§3.1).
 *
 * ## The one invariant this package exists to uphold
 *
 * §3.1 I-1: *no PayPal money movement happens unless a Gate `ALLOW` decision record exists for exactly
 * that order, amount, currency and payee.* Every type below exists to make the four words "exactly that"
 * checkable rather than aspirational: `GateInput` names one attempt and one mandate, and
 * `GateDecision`'s signed record names one amount, one currency and one payee.
 *
 * ## Why there is a port for everything
 *
 * Two reasons, and the second is the important one.
 *
 * 1. **No database in the Gate's tests.** Twelve checks, a 20-way concurrency race and a thousand
 *    byte-flip mutations cannot be run against Postgres in a unit test, and the ones that matter most —
 *    the race and the fuzz — are *timing* and *concurrency* claims where a real database would make the
 *    assertion flaky rather than stronger. `GateDeps` is therefore a complete, explicit list of what the
 *    Gate reads.
 * 2. **A dependency list is an audit surface.** §8.10 says the Gate has **no LLM anywhere in it**, and
 *    `eslint.config.mjs` (`GATE_LLM_BAN`, D-018) enforces it on imports. A Gate that reached for a
 *    "smart" helper could hide an LLM one layer down. Every capability the Gate has is named in this one
 *    interface, so "the Gate cannot reach an LLM" is a statement about a closed list rather than about a
 *    convention.
 *
 * ## One clock, one instant
 *
 * Spec §12.5 **EC-TIME-4** (the price-lock boundary race): `evaluate` reads `deps.clock.nowSec()`
 * **once** and every expiry comparison in the decision uses that one value. So a price lock cannot
 * expire between check 6 and check 12 and produce a decision that was true at no single instant. That
 * is why almost nothing in this package takes a `Clock` directly — `GateDeps.clock` is read exactly
 * once, in `evaluate.ts`, and the value travels as a plain number.
 */

import type {
  AgentId,
  AttemptId,
  CheckoutId,
  Clock,
  CsError,
  CsErrorCode,
  Currency,
  GateDecisionId,
  MandateId,
  Money,
  Result,
  WalletId,
} from '@countersign/core'
import type {
  BudgetBalance,
  BudgetStore,
  CheckoutAttemptRow,
  CheckoutSessionRow,
  MandateRow,
  ProductRow,
  WalletCapPeriod,
} from '@countersign/db'
import type { ConstraintType, VerifyRequest, VerifyResponse } from '@countersign/vi-client'
import type { ReservationHandle } from '@countersign/ledger'

export type {
  BudgetBalance,
  BudgetStore,
  CheckoutAttemptRow,
  CheckoutSessionRow,
  MandateRow,
  ProductRow,
  WalletCapPeriod,
}

/** Re-exported so a consumer of the Gate's types does not need a second import. */
export type { ReservationHandle }

/* ------------------------------------------------------------------------------------------ */
/* §8.10's interface, verbatim                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Spec §8.10: `GateInput { attemptId, mandateId, checkoutId, l3a, l3b, agentId }`. */
export interface GateInput {
  readonly attemptId: AttemptId
  readonly mandateId: MandateId
  readonly checkoutId: CheckoutId
  /** Key-bound JWT over the payment. The agent's own signature. */
  readonly l3a: string
  /** The checkout JWT re-signed by the agent key, binding `checkout_hash`. */
  readonly l3b: string
  readonly agentId: AgentId
}

/**
 * One check's result. `n` is the spec's row number, 1–12, and it is **not optional**: the decision
 * record's `checks_hash` covers all twelve in order, and a check that could be silently omitted from the
 * array would be a check nobody could prove ran.
 */
export interface GateCheck {
  readonly n: number
  /** Short stable slug, e.g. `MANDATE_ACTIVE`. Machine-readable, unlike the failure code. */
  readonly code: string
  readonly passed: boolean
  readonly detail?: string
  /**
   * `true` when the check had nothing to enforce (a mandate with no `recurrence` constraint, a
   * frequency with no measurable window, no `wallet_caps` row).
   *
   * Distinct from `passed` on purpose. A not-applicable check is reported as `passed: false` with
   * `notApplicable: true`, because reporting it as passed would claim an enforcement that did not happen
   * — which is exactly the D19 failure (`constraints.satisfied: true` while a budget cap sat unevaluated).
   * See `evaluateRecurrence` in `@countersign/ledger`.
   */
  readonly notApplicable?: boolean
}

/** Why the Gate decided what it decided. `code` is always a registry code from §8.1. */
export interface GateReason {
  readonly code: CsErrorCode
  readonly message: string
  readonly userMessage: string
}

export type GateOutcome = 'ALLOW' | 'BLOCK' | 'REVIEW'

/** Spec §8.10: `GateDecision`, with the signed record and the reservation it created. */
export interface GateDecision {
  readonly id: GateDecisionId
  readonly decision: GateOutcome
  readonly reasons: GateReason[]
  readonly checks: GateCheck[]
  readonly reservation?: { readonly amount: Money; readonly budgetVersion: number }
  /** Compact JWS by `GATE_KID`. Payload is exactly §8.10's nine fields. */
  readonly signedRecord: string
  /** Epoch seconds — the single instant every expiry comparison in this decision used. */
  readonly nowSec: number
  /** Spec D19: what vi did not evaluate and the Gate therefore had to. */
  readonly pendingNetworkEnforcement: readonly ConstraintType[]
}

/* ------------------------------------------------------------------------------------------ */
/* Check 5: the merchant key set                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** A JWK in the shape `jose` accepts. Structural on purpose — `jose`'s own type is not exported. */
export interface PublicJwk {
  readonly kty?: string
  readonly crv?: string
  readonly x?: string
  readonly y?: string
  readonly n?: string
  readonly e?: string
  readonly kid?: string
  readonly alg?: string
  readonly use?: string
}

/**
 * Check 5's answer to "which merchant keys may sign a checkout JWT?".
 *
 * ### Why retired-but-valid keys are accepted (spec §8.10 check 5, EC-KEY-2)
 *
 * The merchant rotates its signing key on a schedule and `POST /v1/keys/rotate` **retires** the old one
 * without deleting it, because evidence signed before the rotation must still verify. A price lock
 * created before a rotation is legitimately signed by the retired key; refusing it would turn a key
 * rotation into "every cart in flight fails", and a buyer would be shown `VI_CHAIN_INVALID` for a key
 * that was never compromised. A `COMPROMISED` key is a different thing entirely and belongs in a
 * revocation list, not in this set.
 */
export interface MerchantKeySet {
  /** The kid that signs new checkout JWTs. */
  readonly currentKid: string
  /** Every kid accepted for verification: `currentKid` plus retired-but-valid ones. */
  readonly acceptedKids: readonly string[]
  /** Public keys by `kid`, for verifying a checkout JWT locally. */
  readonly jwks: Readonly<Record<string, PublicJwk>>
}

/* ------------------------------------------------------------------------------------------ */
/* GateDeps                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Everything `evaluate` may read. Closed by construction: there is no "fetch anything" member, so
 * adding a capability to the Gate means adding it here, in review, with the LLM ban in force.
 *
 * Every member names the `packages/db` repository or `vi-client` method that satisfies it in production,
 * so wiring is a lookup rather than a design task — see `deps.ts`.
 */
export interface GateDeps {
  /** Read **once**, at the start of `evaluate`. Spec §12.5 EC-TIME-4. */
  readonly clock: Clock

  /** Checks 8, 9 — the port `packages/db/repos/budget.ts` defines. `drizzleStore(exec)` in production. */
  readonly budget: BudgetStore

  /** Check 1 — `repos/mandates.ts::requireMandate`. */
  mandate(id: MandateId): Promise<Result<MandateRow | undefined, CsError>>

  /**
   * Check 8's **in-transaction** re-read of the mandate. `SELECT … FROM mandates WHERE id = $1 FOR
   * UPDATE` in production.
   *
   * Separate from {@link mandate} on purpose, and this is the mechanism behind **AT-M10.4**. Check 1's
   * answer is a snapshot: a mandate revoked *after* check 1 read it still looked ACTIVE. Re-reading inside
   * the same transaction that reserves the budget means the reservation and the status check commit or
   * roll back together, so the Gate never holds a reservation for a mandate that is no longer spendable.
   * §12 EC-MDT-2 asks for exactly this in the orchestrator's order-create; doing it here too means there
   * is nothing to leak in the first place.
   */
  lockMandate(id: MandateId): Promise<Result<MandateRow | undefined, CsError>>

  /**
   * Runs `fn` as one unit, committing unless `fn` rolls back. Postgres `withTx` in production; a
   * snapshot-and-restore stand-in in a pure test.
   *
   * ### Why it takes a handle rather than just a function
   *
   * Because the Gate has to be able to say "**do not commit** this". Checks 8 and 9 share one
   * transaction, and when check 9 refuses, check 8's RESERVE insert must vanish with it. Without an
   * explicit rollback signal the only alternatives are both worse:
   *
   * - commit unconditionally, and rely on the compensation path to release afterwards — which leaves a
   *   window where the buyer's budget is held by a purchase that will be blocked, and makes "no leaked
   *   reservation" (AT-M10.4) depend on the compensation running rather than on the database;
   * - throw to force a rollback — which turns an ordinary business outcome into an exception, and
   *   §8.0 rule 3 says nothing raw crosses a module boundary.
   *
   * So the transaction is explicit about its own outcome. Production wiring is `withTx` from
   * `packages/db/client.ts`, where `rollback()` is `ROLLBACK` and the absence of a call is `COMMIT`.
   */
  transaction<T>(fn: (tx: GateTx) => Promise<T>): Promise<T>

  /** Check 2 — `repos/agents.ts::findAgentById`. `status` and `kid` are both read. */
  agent(id: AgentId): Promise<Result<RowOfAgents | undefined, CsError>>

  /** Check 3 — `repos/devices.ts::findDeviceById`. `status` only. */
  device(id: DeviceIdLike): Promise<Result<RowOfDevices | undefined, CsError>>

  /** Check 4 — `ViClient.verify` with `strict: true`. */
  verify(request: VerifyRequest): Promise<Result<VerifyResponse, CsError>>

  /**
   * Check 4 — **the chain's L1**. `repos/devices.ts::findL1ForDeviceWallet`.
   *
   * ### Why this port exists, and why check 4 could not work without it
   *
   * `/v1/verify` takes the **whole chain**: `l1`, `l2`, `l3a`, `l3b`. §8.10's `GateInput` carries only
   * `l3a` and `l3b`, and that is not an omission: `l1` and `l2` are not the agent's to present. They were
   * issued to the **buyer's device** when the mandate was created, stored, and are the same bytes on every
   * subsequent purchase. So they come from stored mandate state, and check 4 has to ask for them.
   *
   * ### Why the shape is `(deviceId, walletId)` and not an id
   *
   * `l1_credentials` is unique on `(device_id, wallet_id)` — §7.2's "one per device×wallet" — and a
   * mandate names both of those columns. So the mandate identifies its own L1 with no extra bookkeeping,
   * and there is no second row to choose between. `repos/mandates.ts` already resolves the same row when
   * it enforces `mandate.exp <= L1.exp`, which is why this is a lookup rather than a new concept.
   *
   * ### `undefined` means a real absence, and it is a BLOCK
   *
   * Not an error and not an invitation to substitute a default. A mandate with no L1 for its device has a
   * chain vi cannot be shown, so check 4 cannot obtain a verdict, so nothing downstream of "the chain
   * verified" — including D19's obligation discharge — may be claimed. Returning `undefined` rather than a
   * token that is not there is what makes "we hold the L1" a fact this process can be asked about.
   */
  findL1ForDeviceWallet(
    deviceId: string,
    walletId: string,
  ): Promise<Result<RowOfL1 | undefined, CsError>>

  /** Checks 5 and 6 — `repos/checkout.ts::requireCheckoutSession`. */
  checkout(id: CheckoutId): Promise<Result<CheckoutSessionRow | undefined, CsError>>

  /** Check 5 — `vi.jwks()` filtered to role `MERCHANT`, minus any `COMPROMISED` kid. */
  merchantKeys(): Promise<Result<MerchantKeySet, CsError>>

  /** Check 9's period — the `wallet_caps.period` for this wallet, if one is configured. */
  walletCapPeriod?(id: WalletId): Promise<Result<WalletCapPeriod | undefined, CsError>>

  /**
   * Check 7. The unique `checkout_attempts_l3_jti_key` index **is** the check: this is the insert, and a
   * `23505` becomes `GATE_REPLAY` (`repos/index.ts::CONSTRAINT_CODES`).
   *
   * A read-then-write pre-check would be the wrong shape here — it has a window between the SELECT and
   * the INSERT that an automated retrier is built to find — so this is an insert and only an insert.
   */
  insertAttempt(input: NewAttemptForGate): Promise<Result<CheckoutAttemptRow | undefined, CsError>>

  /** Check 10 — `repos/products.ts::findProductsBySku`. A *read*; the decrement happens at ORDER_CREATED. */
  products(skus: readonly string[]): Promise<Result<ProductRow[], CsError>>

  /** Check 11 — `repos/budget.ts::countCommitsSince`; time-bounded, so it is not on `BudgetStore`. */
  countCommitsSince(mandateId: MandateId, since: Date): Promise<Result<number, CsError>>

  /** Check 12, first rule — `repos/attempts.ts::countRecentAttempts`. */
  countRecentAttempts(mandateId: MandateId, since: Date): Promise<Result<number, CsError>>

  /**
   * Check 12, second rule — `repos/attempts.ts::listAttemptsForMandate`, newest first.
   *
   * States rather than rows, because the question is only "were the last three BLOCKs?" and reading whole
   * rows would put every previous attempt's L3a and L3b in memory for no reason.
   */
  recentAttemptStates(mandateId: MandateId, limit: number): Promise<Result<AttemptState[], CsError>>

  /** Check 12's consequence — `repos/mandates.ts::setMandateStatus(id, 'SUSPENDED', …)`. */
  suspendMandate(id: MandateId, reason: string): Promise<Result<true, CsError>>

  /** Signs the decision record with `GATE_SIGNING_KEY`. See `decision-record.ts`. */
  signRecord(payload: GateRecordPayload): Promise<Result<string, CsError>>
}

/**
 * The transaction handle `GateDeps.transaction` passes to its callback.
 *
 * Minimal on purpose: a rollback signal and nothing else. The Gate must not be able to run arbitrary
 * statements inside its own transaction — the only write it performs is check 8's RESERVE, through
 * `reserveIn`, and widening this interface is how a Gate would acquire the ability to write anywhere.
 */
export interface GateTx {
  /**
   * Abandon everything this transaction wrote. Called with a reason so the log says why.
   *
   * Idempotent: a second call replaces the reason rather than failing, because "check 9 said no" and then
   * "check 10 said no" is the normal path and neither is more important than the other.
   */
  rollback(reason: string): void
  /** True once {@link rollback} has been called. */
  readonly rolledBack: boolean
}

/* ------------------------------------------------------------------------------------------ */
/* The row shapes the Gate reads, named so the deps interface is self-contained                   */
/* ------------------------------------------------------------------------------------------ */

/** `agents` row. Only `id`, `kid` and `status` are read (check 2). */
export interface RowOfAgents {
  readonly id: string
  readonly kid: string
  readonly status: string
}

/** `devices` row. Only `id` and `status` are read (check 3). */
export interface RowOfDevices {
  readonly id: string
  readonly status: string
}

/**
 * `l1_credentials` row, as check 4 reads it: `sd_jwt` and nothing else.
 *
 * Narrowed rather than re-exported whole, for the same reason `RowOfDevices` is: the Gate's read surface
 * is an audit surface, and `sd_jwt` is the only column in this table the Gate has any business holding.
 */
export interface RowOfL1 {
  /** The issuer's SD-JWT for this device×wallet — the serialized `l1` sent to `/v1/verify`. */
  readonly sd_jwt: string
}

export type DeviceIdLike = `dev_${string}`
export type IdempotencyKeyLike = string

/** `checkout_attempts` insert shape — the fields check 7 needs, no more. */
export interface NewAttemptForGate {
  readonly id: AttemptId
  readonly mandate_id: MandateId
  readonly agent_id: AgentId
  readonly checkout_session_id: CheckoutId
  readonly l3a: string
  readonly l3b: string
  readonly l3_jti: string
  readonly idempotency_key: IdempotencyKeyLike
  readonly amount_minor: bigint
  readonly currency: Currency
  readonly payee: string
}

/** The subset of §3.3's state machine the velocity guard reads. */
export type AttemptState =
  | 'CREATED'
  | 'GATED_ALLOW'
  | 'GATED_BLOCK'
  | 'ORDER_CREATED'
  | 'AUTHORIZED'
  | 'PARTIALLY_CAPTURED'
  | 'CAPTURED'
  | 'VOIDED'
  | 'AUTH_EXPIRED'
  | 'DECLINED'
  | 'PENDING_REVIEW'

/* ------------------------------------------------------------------------------------------ */
/* The decision record payload — §8.10, exactly these fields                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * `{gdc, att, mdt, amount, currency, payee, checks_hash, chain_valid, vi_commit, iat}`.
 *
 * Not extensible, on purpose. This payload is the artefact a dispute is fought over: it says *this*
 * attempt, *this* amount, *this* currency, *this* payee, and a hash of the twelve check results. Adding a
 * field would change what a signed record means for every record already filed.
 *
 * `amount` is PayPal's decimal string (`"30.00"`, and `"500"` for JPY), not minor units, because the same
 * payload goes into `custom_id` and into an evidence packet a PayPal agent reads. `checks_hash` is
 * `sha256(canonicalJson(checks))` hex — canonical JSON via `packages/db`'s `canonicalJson`, so a verifier
 * recomputing it needs no special client.
 */
export interface GateRecordPayload {
  readonly gdc: GateDecisionId
  readonly att: AttemptId
  readonly mdt: MandateId
  readonly amount: string
  readonly currency: Currency
  readonly payee: string
  readonly checks_hash: string
  readonly chain_valid: boolean
  /** The pinned Verifiable Intent commit — `VI_LIB_COMMIT`. A packet filed months ago must verify. */
  readonly vi_commit: string
  readonly iat: number
}

/** The JWKS document the public verifier reads at `/.well-known/jwks.json`. */
export interface GateJwks {
  readonly keys: readonly PublicJwk[]
}

/* ------------------------------------------------------------------------------------------ */
/* Check 12                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Spec §8.10 check 12, as numbers rather than prose so the test and the code cannot disagree. */
export const VELOCITY = {
  /** More than this many attempts for one mandate inside the window trips the guard. */
  MAX_ATTEMPTS_PER_WINDOW: 5,
  WINDOW_SECONDS: 10 * 60,
  /** More than this many consecutive BLOCKs trips the guard. */
  MAX_CONSECUTIVE_BLOCKS: 3,
} as const

/** What check 12 measured. `trips` is what turns a BLOCK into a REVIEW. */
export interface VelocityVerdict {
  readonly attemptsInWindow: number
  readonly consecutiveBlocks: number
  readonly tooManyAttempts: boolean
  readonly tooManyBlocks: boolean
  /** Either of the two rules fired: the mandate goes `SUSPENDED` and the decision is `REVIEW`. */
  readonly trips: boolean
  readonly detail: string
}

/* ------------------------------------------------------------------------------------------ */
/* Release reasons                                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Why a reservation was given back. Recorded verbatim in `budget_entries.reason`.
 *
 * Re-exported from `@countersign/ledger`, which owns the constant, so there is one list of reasons in
 * the repository rather than one per caller.
 */
export { RELEASE_REASONS } from '@countersign/ledger'
export type { ReleaseReason } from '@countersign/ledger'
