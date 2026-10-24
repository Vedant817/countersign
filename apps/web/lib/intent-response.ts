/**
 * The wire shape of `POST /api/intent/compile`, and the one place a mandate becomes JSON.
 *
 * ## The bug this exists to make impossible
 *
 * The route returned `mandate.constraints` straight to `NextResponse.json`. Mandate amounts are
 * `bigint` — deliberately, because money is integer minor units and never a float (§8.0 rule 9) — and
 * `JSON.stringify` **throws** on a `bigint` with `TypeError: Do not know how to serialize a BigInt`.
 *
 * Next turns an unhandled throw in a route into a `500` with an **empty body**. So the compiler was
 * working perfectly and the caller got nothing at all:
 *
 * ```
 * POST /api/intent/compile {"intent":"Spend at most $50 on shoes"}
 *   → 500, 0 bytes          (a digit amount produces a cap, and a cap is a bigint)
 * POST /api/intent/compile {"intent":"Buy me some trail shoes"}
 *   → 200                   (no amount, no cap, no bigint, no throw)
 * ```
 *
 * That asymmetry is why it survived: every no-amount and spelled-out-amount case returned `200`, and
 * those are the cases the manual form exercises. Only the *success* path — a mandate the buyer could
 * actually sign — was broken.
 *
 * It also explains a harness reading that had been blamed on the transport. The eval script called
 * `response.json()` before checking `response.ok`, so an empty-bodied `500` surfaced as
 * `SyntaxError: Unexpected end of JSON input` and was filed as a truncation for several sessions.
 * 6/13 was really "4 of the 7 working cases were being reported as transport failures".
 *
 * ## Why `toJsonSafe` and not a local replacer
 *
 * `@countersign/compiler` exports `toJsonSafe` and documents it as the only `bigint` → `number`
 * conversion. It refuses an integer past `Number.MAX_SAFE_INTEGER` rather than rounding, which is the
 * behaviour that matters: an amount that cannot survive the trip must fail loudly instead of arriving
 * subtly wrong. A `JSON.stringify` replacer would silently produce a wrong number for a large amount,
 * and a second implementation beside a documented one is how the two drift apart.
 *
 * ## What is deliberately *not* here
 *
 * No `readBack` call, no merchant lookup, no clock. Those need configuration, and this function has to
 * be callable from a test with a hand-built mandate and nothing else — which is the point. The route
 * owns composition; this owns the wire.
 */
import { toJsonSafe, type CompiledMandate } from '@countersign/compiler'

/** The exact JSON body a successful compile returns. Every field is the buyer-visible artefact. */
export interface IntentResponseBody {
  /** ISO-4217. Travels with the amounts, because an integer of minor units is meaningless without it. */
  readonly currency: string
  readonly ttl_seconds: number
  /** Machine-readable limits. Amounts are JSON integers of minor units. */
  readonly constraints: readonly Record<string, unknown>[]
  /** The sentence the buyer approves. Deterministic, so a UI can diff two runs and see nothing (D-008). */
  readonly read_back: string
  /** Everything the compiler decided on the buyer's behalf, in their words. */
  readonly assumptions: readonly string[]
  /** Non-empty means "not ready to sign yet". §8.8: a question, never a guess. */
  readonly ambiguities: readonly Record<string, unknown>[]
}

/**
 * Build the response body, converting every `bigint` exactly once.
 *
 * Throws `CsError('CS_VALIDATION')` for an amount outside the safe integer range — the caller maps it
 * like any other `CsError`, so an unrepresentable amount is a described failure rather than a `500`
 * with an empty body.
 */
export function intentResponseBody(
  mandate: CompiledMandate,
  readBackText: string,
): IntentResponseBody {
  return {
    currency: mandate.currency,
    ttl_seconds: mandate.ttlSeconds,
    // `toJsonSafe` walks arrays and nested objects, so a future constraint shape is covered by
    // construction rather than by remembering to update a list of amount-bearing fields.
    constraints: toJsonSafe(mandate.constraints) as readonly Record<string, unknown>[],
    read_back: readBackText,
    assumptions: mandate.assumptions,
    ambiguities: toJsonSafe(mandate.ambiguities) as readonly Record<string, unknown>[],
  }
}
