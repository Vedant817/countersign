/**
 * `@countersign/orchestrator` — the **production** {@link OrchestratorStore}. Spec **§8.10**, **§7.2**,
 * **§8.12**, §12.3, §12.4; the `gate_decisions` writer this package's `README.md` names as the reason it
 * exists.
 *
 * ## Why this file exists
 *
 * {@link OrchestratorStore} is the only port in this package with no other package's `deps.ts` to
 * satisfy it. `gateDepsFromRepos` (`@countersign/gate`) and `orderStoreFromRepos` (`@countersign/orders`)
 * both exist for their own ports; nothing anywhere satisfied this one, so `gate_decisions` had a table, a
 * schema, four repositories and **no writer**. `createOrderFromDecision` re-reads the decision by id and
 * refuses with `CS_NOT_FOUND` when the row is absent, so without this file every `ALLOW` in the system was
 * followed by a failure and no order could ever exist.
 *
 * It is placed here rather than in an app because **both** apps need it: `apps/web` decides a purchase at
 * request time and `apps/worker` releases expired reservations on a cron. A factory owned by one app and
 * imported by the other would be the wrong dependency direction, and this package already depends on
 * `@countersign/db`.
 *
 * ## Every member is a delegate, except `decide`
 *
 * `decisionForAttempt`, `staleAttempts`, `budgetEntries` and `setAttemptState` are one-line forwards onto a
 * repository whose predicate is already the tested one. Restating those predicates here would create a
 * second place for the 30-minute window to be decided — and `README.md` item 5 records that the window is
 * *already* decided by the candidate query rather than by the ledger, so a second copy could only drift.
 *
 * ## `decide`, and the three things it has to get right
 *
 * 1. **Two writes, one transaction.** `createGateDecision` then `linkGateDecision`. A decision row whose
 *    attempt is not linked is a decision the orchestrator cannot find on a retry, which is exactly the
 *    state that makes EC-IDEM-2 unrecoverable — so a failure after the insert must **roll back**, not
 *    merely return an error. `@countersign/db`'s `withTx` commits unless the callback throws, so this
 *    file uses {@link aborting} rather than `withTx` directly. This is the same reasoning, and the same
 *    shape, as `withTxOrAbort` in `@countersign/orders`, written here because that one takes an
 *    `OrderStore` port this package does not have.
 * 2. **A missing attempt row is `undefined`, not an error, and writes nothing.** That is what a
 *    `GATE_REPLAY` looks like from here: check 7 refused the attempt insert because the `l3_jti` was
 *    already used, so there is no row and `gate_decisions.attempt_id`'s foreign key has nothing to point
 *    at. The attempt is therefore **read before the insert**. Checking afterwards would be worse than
 *    useless: the insert would fail on the foreign key and, since `repo()` converts a throw into a
 *    returned `err`, a naive caller would commit the partial write it was trying to avoid.
 * 3. **`chain_valid` is read out of the signed record, never derived.** §8.10's decision record carries
 *    `chain_valid` in its signed payload, and the test harness's double hardcodes `true` — correct there,
 *    because it only ever runs over an `ALLOW` path. Guessing it here from `reasons` would mean writing a
 *    boolean that nothing signed, into the column a dispute packet later reads. So it is decoded from the
 *    record, and a record that cannot be read **refuses to persist** rather than asserting a value.
 */
import { csError, err, ok, VI_LIB_COMMIT, type CsError, type Result } from '@countersign/core'
import {
  createGateDecision,
  findAttemptById,
  findLatestDecisionForAttempt,
  findStaleAttempts,
  linkGateDecision,
  listEntries,
  setAttemptState,
  withTx,
  type GateDecisionRow,
  type NewGateDecision,
  type Tx,
} from '@countersign/db'

import type { OrchestratorStore } from './types'

/**
 * Build the production {@link OrchestratorStore} over `@countersign/db`'s repositories.
 *
 * Takes no arguments on purpose. Every repository resolves its own connection lazily and accepts an
 * optional transaction handle, so there is nothing to configure and nothing to get wrong at a call site —
 * `orchestratorStoreFromRepos()` is the whole composition.
 *
 * @example
 * ```ts
 * const store = orchestratorStoreFromRepos()
 * await store.decide({ decision, attemptId, at: new Date(clock.nowMs()) })
 * ```
 */
export function orchestratorStoreFromRepos(): OrchestratorStore {
  return {
    /**
     * Record the decision **and** link it to its attempt, atomically.
     *
     * Returns `ok(undefined)` — having written nothing — when the attempt row does not exist. The caller
     * still receives its decision; its next job is to explain the replay (§8.10's `GATE_REPLAY`
     * userMessage is exactly that), and an `ALLOW` in this state fails closed one step later, when
     * `createOrderFromDecision` cannot find the row.
     */
    async decide({
      decision,
      attemptId,
      at,
    }): Promise<Result<GateDecisionRow | undefined, CsError>> {
      const chainValid = chainValidFromRecord(decision.signedRecord)
      if (!chainValid.ok) return chainValid

      return aborting<GateDecisionRow | undefined>(async (tx) => {
        const attempt = await findAttemptById(attemptId, tx)
        if (!attempt.ok) return attempt
        if (attempt.value === undefined) return ok(undefined)

        const inserted = await createGateDecision(
          {
            id: decision.id,
            attempt_id: attemptId,
            decision: decision.decision,
            // `gate_decisions.reasons` / `.checks` are jsonb typed `JsonValue`; the Gate's own interfaces
            // are the thing being stored. The cast is the schema boundary, not a coercion — the values
            // round-trip through `gateDecisionFromRow`, which re-validates that they are arrays.
            reasons: decision.reasons as unknown as NewGateDecision['reasons'],
            checks: decision.checks as unknown as NewGateDecision['checks'],
            chain_valid: chainValid.value,
            // Pinned so evidence filed months later verifies against the library that ran (schema.ts).
            vi_lib_commit: VI_LIB_COMMIT,
            signed_record: decision.signedRecord,
            decided_at: at,
            // Check 8's approved version, so a decision pins the exact balance it reserved against.
            budget_version: decision.reservation?.budgetVersion ?? null,
          },
          tx,
        )
        if (!inserted.ok) return inserted

        const linked = await linkGateDecision(attemptId, decision.id, at, tx)
        if (!linked.ok) return linked

        return ok(inserted.value)
      })
    },

    /** The idempotency read on every call, before the Gate. See {@link OrchestratorStore}. */
    async decisionForAttempt(attemptId) {
      return findLatestDecisionForAttempt(attemptId)
    },

    /** §8.10's candidates for the 30-minute sweep. The predicate is `findStaleAttempts`' own. */
    async staleAttempts(olderThan) {
      return findStaleAttempts(olderThan)
    },

    /** `budget_entries` for one mandate, so the sweep can skip a reservation it already released. */
    async budgetEntries(mandateId) {
      return listEntries(mandateId)
    },

    /** Closes an expired attempt so `staleAttempts` stops returning it. */
    async setAttemptState(attemptId, state, at) {
      return setAttemptState(attemptId, state, at)
    },
  }
}

/* ============================================================================================ */
/* Internals                                                                                       */
/* ============================================================================================ */

/**
 * Run `fn` in a transaction and **abort it on a returned `err`**.
 *
 * `@countersign/db`'s `withTx` commits unless `fn` throws, which is right for a repository and wrong for
 * `decide`: a returned `err` after a successful `createGateDecision` would commit an unlinked decision
 * row — the exact state {@link OrchestratorStore.decide} says must not persist. So the business failure
 * is re-thrown as the `CsError` it already is; `withTx` catches it and `toCsError` passes a
 * `CsError`-shaped cause through with its `code`, `message` and `details` intact, so the code survives the
 * round trip and the rollback is explicit rather than a coincidence.
 */
async function aborting<T>(
  fn: (tx: Tx) => Promise<Result<T, CsError>>,
): Promise<Result<T, CsError>> {
  const outer = await withTx<Result<T, CsError>>(async (tx) => {
    const inner = await fn(tx)
    // Thrown, not returned: a `ROLLBACK` is what a business refusal needs here.
    if (!inner.ok) throw inner.error
    return inner
  })
  if (!outer.ok) return outer
  // `outer.value` is the callback's own `Result<T, CsError>` — the inner envelope.
  return outer.value
}

/**
 * §8.10's `chain_valid`, read out of the record that carries it.
 *
 * Exported for its own tests: it is the only part of this file with interesting edge cases, and it needs
 * no database, which is what makes it verifiable without one.
 *
 * ### Why this does not verify the signature
 *
 * Because it does not need to, and verifying would be the wrong shape of defence. The record was produced
 * by `evaluate` in this same process moments earlier; the value being stored is the one the Gate signed,
 * so decoding our own output is not a trust decision. Verification is `verifyDecisionRecord`'s job, at
 * read time, in `@countersign/gate` — and a value this function invented could never be caught by it,
 * because the signature would be over the invented value too.
 *
 * ### Why a failure refuses instead of defaulting
 *
 * There is no safe default in either direction. `true` asserts a verification that did not happen; `false`
 * reports a chain as broken on a record that may be perfectly fine. Both would be a claim nobody signed,
 * written into the column a dispute packet reads. So an unreadable record is an error and nothing is
 * persisted — the caller's next action is to look, and `CS_INTERNAL` is the registry's code for "an
 * unhandled fault", which is what a record we just minted and cannot read is.
 */
export function chainValidFromRecord(signedRecord: string): Result<boolean, CsError> {
  const parts = signedRecord.split('.')
  const payload = parts.length === 3 ? parts[1] : undefined
  if (payload === undefined) {
    return err(
      csError(
        'CS_INTERNAL',
        'The Gate decision record is not a compact JWS, so chain_valid cannot be read from it.',
        { segments: parts.length },
      ),
    )
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch (cause) {
    return err(
      csError('CS_INTERNAL', 'The Gate decision record payload is not JSON.', undefined, { cause }),
    )
  }

  if (typeof decoded !== 'object' || decoded === null) {
    return err(csError('CS_INTERNAL', 'The Gate decision record payload is not a JSON object.'))
  }

  const value = (decoded as Record<string, unknown>)['chain_valid']
  if (typeof value !== 'boolean') {
    return err(
      csError(
        'CS_INTERNAL',
        'The Gate decision record carries no boolean chain_valid, so it is not recorded rather than guessed.',
      ),
    )
  }
  return ok(value)
}
