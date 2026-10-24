/**
 * The compiler's public data shapes — spec **§8.8 (M8)**, WP-08.
 *
 * Four things live here, and the separation between them is the design:
 *
 * - {@link CompileInput} — what the user typed, plus the account defaults that apply to it.
 * - {@link CompiledMandate} — the compiler's output. **A proposal** (§8.8), and the read-back the user
 *   signs is rendered from it by `readBack.ts`.
 * - {@link CatalogReader} — the only way the compiler learns what exists in the world. It is an
 *   interface with one method returning a projection, deliberately narrower than the catalog tables,
 *   so the prompt is a pure function of its inputs and the compiler can be tested with no database.
 * - {@link CompileDeps} — the language model and the catalog, as arguments.
 *
 * ## `preferences` is not a constraint, and that is load-bearing
 *
 * §8.8 is explicit: `preferences` is "**NOT a VI constraint**; used by router R-SNAD-AGENT". It carries
 * a size or a colour so the agent's product search has somewhere to start; it grants no authority, and
 * putting it in `constraints` would sign it. A user who says "a blue shirt, size M, under $50" has
 * written **one** spending limit — $50 — and two search hints. The read-back shows the limit and never
 * the hints, because the hints do not bound anything.
 */

import type { Currency, Result, UserId } from '@countersign/core'
import type { LanguageModel } from 'ai'

import type { VIConstraint } from './constraints'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * What to compile.
 *
 * `defaults` is the user's saved account configuration, not a model of their wishes: the currency
 * their wallet is funded in, and the stores they have connected. `compile` prefers anything the user
 * *typed* over both — an account default is a fallback, never an override (EC-FX-1).
 */
export interface CompileInput {
  readonly userId: UserId
  readonly text: string
  readonly locale: 'en-IN' | 'en-US'
  readonly defaults: {
    readonly currency: Currency
    readonly merchantIds: string[]
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * A question the user must answer before this mandate can be signed.
 *
 * §8.8: "Clarify before signing. An unresolvable intent (no amount cap) MUST produce an ambiguity, not
 * a guess." An ambiguity is the *only* sanctioned way for the compiler to be incomplete: the alternative
 * is inventing a cap, and an invented cap is authority the user never granted.
 */
export interface Ambiguity {
  /** Dotted path of the thing being asked about, e.g. `amount_range.max`. The UI keys its form on it. */
  readonly field: string
  /** The question itself, in the second person. Shown verbatim, so it must stand alone. */
  readonly question: string
  /**
   * Concrete choices, rendered as buttons.
   *
   * Deterministic: the compiler builds money options from catalog prices and its own rules, never from
   * model output, so the numbers a user can pick are numbers the compiler would have accepted anyway.
   */
  readonly options: string[]
}

/**
 * Search hints for the agent's router (`R-SNAD-AGENT`). **Not** a constraint, not signed, not shown in
 * the read-back. See the module header.
 */
export interface CompiledPreferences {
  readonly size?: string
  readonly color?: string
  readonly model?: string
  readonly notes?: string
}

/**
 * The compiler's output.
 *
 * ### Every field here is a proposal, and one field is *not* a proposal at all
 *
 * §8.8 requires re-validation, which `compile` does before returning. But the fields below are still
 * user-reviewable drafts: {@link CompiledPreferences} is deliberately excluded from the signed
 * constraints, and {@link ambiguities} means "this is not ready to sign yet".
 */
export interface CompiledMandate {
  /** Exactly the eight VI dict shapes; nothing else may appear here. */
  readonly constraints: VIConstraint[]
  /**
   * The currency this mandate is denominated in.
   *
   * Not in §8.8's listing, and needed anyway. EC-FX-1 is *entirely* about this value — a limit in ₹ never
   * becomes a limit in $ — so it cannot be left implicit in a constraint the caller has to go looking for.
   * A mandate with no money constraint at all still has one: it is the currency the buyer was asked about,
   * and it is what the UI shows next to any free-text amount they type in response.
   *
   * It is always the **resolved** currency, never the account default: what the buyer wrote wins
   * (`literal.resolveCurrency`).
   */
  readonly currency: Currency
  /** Mandate lifetime in seconds. Default 7 days, ceiling 30 days (§8.8, and vi's own `ttl_seconds`). */
  readonly ttlSeconds: number
  /**
   * Absolute expiry, **UTC epoch seconds** (spec §0 rule 10).
   *
   * Not in §8.8's listing, and needed anyway: §8.8's own read-back example is "Expires **Fri 9 Oct,
   * 11:59 PM IST**", and a date cannot be rendered from a duration without reading a clock. Putting
   * the instant on the compiled value is what lets `readBack` stay pure — it is a function of its
   * arguments and nothing else, which is the property §8.8 asks for and the property the snapshot
   * tests pin.
   */
  readonly expiresAtEpochSec: number
  /** Router hints. Not a VI constraint; not signed; not in the read-back. */
  readonly preferences: CompiledPreferences
  /**
   * What the compiler decided on the user's behalf, each a complete sentence.
   *
   * These are shown in the read-back. A guess that is not written down is a guess the user signed.
   */
  readonly assumptions: string[]
  /** Questions that block signing until answered. Empty means the mandate may be presented for signing. */
  readonly ambiguities: Ambiguity[]
}

// ---------------------------------------------------------------------------
// The catalog port
// ---------------------------------------------------------------------------

/** A store the user can spend at. */
export interface CatalogMerchant {
  readonly id: string
  readonly name: string
  readonly website: string
}

/** Search hints copied out of the catalog. Free-form on purpose — the catalog owns the vocabulary. */
export interface CatalogAttributes {
  readonly size?: string
  readonly colour?: string
  readonly model?: string
}

/** One sellable item. */
export interface CatalogSku {
  readonly id: string
  readonly title: string
  readonly merchantId: string
  /** Integer minor units, plus the currency this item is actually priced in. */
  readonly priceMinor: bigint
  readonly currency: Currency
  readonly attributes?: CatalogAttributes
  /** `false` for a sold-out or discontinued item; such a SKU never enters a constraint. */
  readonly inStock: boolean
}

/**
 * The projection the compiler is allowed to see.
 *
 * Merchants, SKUs, prices, size/colour/model attributes and stock — that is the entire list, and it is
 * the entire list on purpose. It is what the system prompt contains (§8.8: "The system prompt contains
 * the catalog's merchant and SKU lists"), so anything added here is something sent to the model.
 */
export interface CatalogProjection {
  readonly merchants: readonly CatalogMerchant[]
  readonly skus: readonly CatalogSku[]
}

/**
 * The compiler's only view of the world.
 *
 * One method, one projection, and it returns a `Result` because a catalog read that fails must reach
 * the UI as `CS_VALIDATION`/"the store list did not load" rather than as a throw from three frames
 * down (spec §8.0 rule 3).
 */
export interface CatalogReader {
  read(): Promise<Result<CatalogProjection>>
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * What `compile` needs from the outside world.
 *
 * `clock` is a `Clock` rather than a call to `Date.now()` so a test can pin a mandate's expiry and the
 * snapshot of "Expires Fri 9 Oct, 11:59 PM IST" can be an assertion rather than a race.
 *
 * `llm` is **optional** (P0-7). The deterministic parser reads money, currency, cadence, merchants and
 * dates from the buyer's own sentence, so a model is only consulted for the one gap a reader cannot
 * fill: naming a product the buyer described rather than named. A caller with no provider — the offline
 * corpus runner, the determinism check, a judge without an API key — compiles every sentence that states
 * a limit, and gets a question for the ones that do not. Adding the field to the type is the honest way
 * to say that; requiring it would make "no key" look like "broken".
 */
export interface CompileDeps {
  readonly llm?: LanguageModel
  readonly catalog: CatalogReader
  readonly clock: { nowSec(): number }
}
