import 'server-only'

import { csError, err, ok, type CsError, type Result } from '@countersign/core'
import type { CompiledMandate } from '@countersign/compiler'

/**
 * The one gate between "the compiler produced a mandate" and "the buyer's device signs it".
 *
 * ## Why this exists
 *
 * §8.8: "Clarify before signing. An unresolvable intent (no amount cap) MUST produce an ambiguity, not
 * a guess." `compileIntent` already honours that — a sentence with no stated limit ("something warm for
 * the trip") comes back with `ambiguities` non-empty. The defect this module closes is that the agent
 * session used to read only `compiled.constraints` and sign anyway, at the cap the client sent, so the
 * device signed a limit the buyer never said.
 *
 * ## The rule, in one sentence
 *
 * A `CompiledMandate` with any ambiguity is **not** ready to sign, and the refusal names the compiler's
 * own question verbatim — the buyer answers it in the chat ("…under $80"), the client re-compiles, and
 * only then is there something to sign.
 *
 * ## Deliberately pure
 *
 * This function takes the compiled value and returns a `Result`; it imports nothing from `@countersign/db`
 * or the vi client and performs no I/O. That is what makes the caller's ordering guarantee testable: the
 * session calls this *before* it mirrors keys, resolves a wallet, mints an agent key, issues an L1 or
 * calls `l2/prepare`, so a refusal here means no vi call and no row was ever written.
 */
export function assertNoAmbiguities(compiled: CompiledMandate): Result<CompiledMandate, CsError> {
  const first = compiled.ambiguities[0]
  if (first === undefined) return ok(compiled)

  return err(
    csError(
      'CS_VALIDATION',
      `The intent is not ready to sign: the compiler still needs an answer about "${first.field}" — ${first.question}`,
      { field: first.field, question: first.question },
      // The buyer-facing sentence is the compiler's own question, shown verbatim (spec §8.8): a paraphrase
      // would be a promise the buyer did not make. `question` is the `Ambiguity` field in
      // `packages/compiler/src/types.ts`.
      { userMessage: first.question },
    ),
  )
}
