/**
 * Ambiguities — spec §8.8: "**Clarify before signing.** An unresolvable intent (no amount cap) MUST
 * produce an ambiguity, not a guess."
 *
 * ## An ambiguity is the only sanctioned way to be incomplete
 *
 * A compiled mandate is a proposal, and a proposal can be incomplete in exactly one direction: it can
 * be **missing something the user did not say**. Everything else — an unknown sku, a currency the user
 * never mentioned, a cap bigger than their words support — is a defect, and defects are errors
 * (`proposal.ts`, `constraints.ts`). Missing authority is what needs a question, because the alternative
 * is inventing authority, and invented authority is the failure the whole product exists to prevent.
 *
 * ## `options` are deterministic, and that is the point
 *
 * Every option is built from the catalog's own prices or from the compiler's own arithmetic — never from
 * model output. The numbers a user can tap are therefore numbers the compiler would have accepted
 * anyway, so answering a question can never widen the mandate beyond what the compiler is willing to
 * sign. A model-suggested option list would let a prompt injection in a product description put a
 * "$5,000" button under the user's thumb.
 */

import { MINOR_DIGITS, formatMoney, type Currency, type Money } from '@countersign/core'

import type { Ambiguity, CatalogProjection, CompiledMandate } from './types'
import { joinWithAnd } from './readback'

/** The field name for the single ambiguity §8.8 names explicitly. */
export const AMOUNT_CAP_FIELD = 'amount_range.max'

/** The field name used when the intent names two different currencies at once. */
export const CURRENCY_FIELD = 'currency'

/**
 * The blocking ambiguity for "buy shoes" — no amount, no way to tell.
 *
 * The wording matters more than it looks. It is shown verbatim on the consent screen and it must not
 * read like a confirmation step: the user has to notice that they never said how much, which is the whole
 * reason the question exists.
 */
export function amountCapAmbiguity(args: {
  readonly currency: Currency
  /** Catalog prices for the items that matched, used to offer real choices. May be empty. */
  readonly candidates: readonly Money[]
}): Ambiguity {
  const { currency } = args
  const options = capOptions(args.candidates)
  return {
    field: AMOUNT_CAP_FIELD,
    question:
      `You did not say how much this may spend. What is the most the agent is allowed to spend, in ` +
      `${currency}, in total?`,
    options,
  }
}

/**
 * Cap choices, derived from real prices and rounded **up** to a boundary a person would pick.
 *
 * Two numbers per candidate price: the whole-unit ceiling, and the next round ten above it. Rounding
 * **up** is the decision that matters — every offered option is at least the item's price, so choosing one
 * cannot silently make the item unboughtable. `12999` (a Trail Runner at $129.99) therefore offers
 * `$130.00` and not `$129.00`, and `8999` offers `$90.00`: round numbers a person recognises as a cap,
 * deduplicated and sorted, so the list is a pure function of the catalog.
 *
 * There is deliberately **no** "no limit" option. An unlimited choice in a list of buttons is a foot-gun
 * with a label on it, and the point of the question is to obtain a number.
 */
export function capOptions(candidates: readonly Money[]): string[] {
  const first = candidates[0]
  if (first === undefined) return []
  const currency = first.currency
  const scale = 10n ** BigInt(MINOR_DIGITS[currency])
  const rounded = new Set<bigint>()
  for (const m of candidates) {
    if (m.currency !== currency) continue
    const wholeUnits = (m.minor + scale - 1n) / scale
    rounded.add(wholeUnits * scale)
    rounded.add(((wholeUnits + 9n) / 10n) * 10n * scale)
  }
  const sorted = [...rounded].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted.slice(0, MAX_CAP_OPTIONS).map((minor) => formatMoney({ minor, currency }))
}

/** How many choices to offer. Enough to cover a catalog, few enough to stay a row of buttons. */
export const MAX_CAP_OPTIONS = 6

/**
 * The ambiguity raised when the request names two different currencies.
 *
 * Raised only when it is unresolvable *and* consequential. §8.8's own example assumption is "Assumed USD
 * because store prices are USD", so a currency the catalog makes obvious is an **assumption**, shown in
 * the read-back. Two currencies in one sentence is a different thing: there is no obvious right answer,
 * and picking one would be picking a currency *and* a number the user never wrote (EC-FX-1).
 */
export function currencyAmbiguity(named: readonly Currency[]): Ambiguity {
  // `joinWithAnd`, not `join(' and ')`: three currencies would otherwise render as
  // "USD and INR and GBP", in the one sentence that blocks a user from signing.
  return {
    field: CURRENCY_FIELD,
    question: `You mentioned more than one currency (${joinWithAnd(named)}). Which one is the limit in?`,
    options: [...new Set(named)],
  }
}

/**
 * Whether the UI must block signing.
 *
 * The single predicate §8.8 hands the UI: "UI MUST resolve all before signing". One line, no judgement
 * of its own, so the gate cannot drift from the rule it is meant to enforce — a second, cleverer check
 * somewhere else is how a mandate ends up signed with an open question.
 *
 * Deliberately **not** an error: a compiled mandate with an open question is a perfectly good object. It
 * is a good object the UI must not sign yet.
 */
export function hasBlockingAmbiguities(compiled: Pick<CompiledMandate, 'ambiguities'>): boolean {
  return compiled.ambiguities.length > 0
}

/**
 * Merge the compiler's required questions with the model's, keyed by `field`.
 *
 * **Order** is first-seen across `[...modelQuestions, ...requiredQuestions]`, so a model's extra questions
 * come first and the compiler's blocking ones appear last — the order a UI reads best in, and stable for a
 * given input.
 *
 * **Precedence** on a duplicate field is the compiler's own entry, and the two are tracked separately
 * because those two rules are not the same thing. An earlier version concatenated the lists and kept the
 * first occurrence, which silently let a model-written question *displace* the required one — and its
 * options with it. That is the whole attack: a question about `amount_range.max` carrying a "$1,000,000"
 * option, overriding the catalog-derived one. {@link capOptions} is only a defence against model-suggested
 * numbers if the model's own question cannot replace it.
 */
export function mergeAmbiguities(
  required: readonly Ambiguity[],
  fromModel: readonly Ambiguity[],
): Ambiguity[] {
  const requiredByField = new Map(required.map((a) => [a.field, a]))
  const order: string[] = []
  const seen = new Set<string>()
  for (const a of [...fromModel, ...required]) {
    if (seen.has(a.field)) continue
    seen.add(a.field)
    order.push(a.field)
  }
  const modelByField = new Map(fromModel.map((a) => [a.field, a]))
  return order.map((field) => requiredByField.get(field) ?? modelByField.get(field)).filter(
    (a): a is Ambiguity => a !== undefined,
  )
}

/**
 * Prices of the SKUs a proposal narrowed to, for {@link amountCapAmbiguity}'s options.
 *
 * Empty when the intent named no products, in which case the ambiguity offers no numbers at all and the
 * UI shows a free-text field. That is the correct outcome: there is no honest number to suggest, and a
 * made-up round number would be the compiler guessing at the user's behalf.
 */
export function capCandidatesFor(
  catalog: CatalogProjection,
  skuIds: readonly string[],
  currency: Currency,
): Money[] {
  const wanted = new Set(skuIds)
  return catalog.skus
    .filter((s) => s.inStock && wanted.has(s.id) && s.currency === currency)
    .map((s) => ({ minor: s.priceMinor, currency: s.currency }))
}
