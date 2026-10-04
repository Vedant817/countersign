/**
 * `@countersign/compiler` — spec **§8.8 (M8)**, WP-08.
 *
 * Two things live in this package, and they have very different risk profiles.
 *
 * ## 1. `compile` — turns a buyer's words into a **proposal**
 *
 * ```ts
 * const result = await compile({ userId, text: 'Under 130 dollars at Northwind', locale: 'en-US', defaults }, deps)
 * if (!result.ok) return result            // LLM_UNAVAILABLE / LLM_SCHEMA / CS_VALIDATION
 * if (hasBlockingAmbiguities(result.value)) showQuestions(result.value.ambiguities)
 * const mandate = result.value
 * ```
 *
 * The model's output is never authoritative. It is parsed by zod, re-checked against the catalog, and
 * re-validated against the constraints' own invariants before it is returned (spec §8.0 rule 4). When the
 * model is unreachable the answer is `LLM_UNAVAILABLE` and nothing else — never a partly-filled mandate,
 * because a partly-filled mandate renders a confident read-back that is missing the limit (EC-LLM-1).
 *
 * ## 2. `readBack` — the string the user signs
 *
 * ```ts
 * readBack(mandate, { merchants: { mrc_northwind: 'Northwind Outfitters' }, tz: 'Asia/Kolkata' })
 * // '**What you are authorising**\nSpend at most **$130.00** in total\n…'
 * ```
 *
 * **Pure.** No model, no clock, no I/O, no locale lookup — every branch reads its arguments and nothing
 * else. That is the answer to spec **§18 question 46** ("the user signs something they didn't
 * understand"): the sentence is produced by a template, so it is exactly as good as the template and not
 * as good as the model's mood. All eight constraint types render, including the three the library does
 * not check (spec D19), because a cap nobody enforces is precisely the cap a user must still see.
 *
 * ## The invariants worth knowing before you call this
 *
 * - **Money is `bigint` minor units end to end.** The model writes a decimal *string*; `core.fromPayPalValue`
 *   converts it and refuses rather than rounds (EC-FX-5). `toJsonSafe` is the only `bigint → number`.
 * - **Currency is never converted** (EC-FX-1). A limit in ₹ stays in ₹ and the Gate blocks the checkout
 *   that disagrees, with copy telling the buyer to create a mandate in the store's currency.
 * - **No cap may exceed the largest amount the buyer literally typed** (AT-M8.5). This is the control
 *   that makes prompt injection irrelevant to the number in the mandate; the prompt asks politely, this
 *   code decides.
 * - **No amount cap means an ambiguity, never a guess** (§8.8). `hasBlockingAmbiguities` is the predicate
 *   the UI blocks on.
 * - **`preferences` is not a constraint** and is not signed (§8.8).
 *
 * See `README.md` for the template table, the eval commands, and the AT-M8 acceptance mapping.
 */

// --- constraints -------------------------------------------------------------
export {
  CONSTRAINT_TYPES,
  ISO_20022_FREQUENCIES,
  MATCH_MODES,
  NETWORK_ENFORCED_CONSTRAINT_TYPES,
  acceptableItemSchema,
  agentRecurrenceConstraintSchema,
  allowedMerchantsConstraintSchema,
  allowedPayeesConstraintSchema,
  amountRangeConstraintSchema,
  budgetConstraintSchema,
  constraintOfType,
  constraintToJson,
  currencySchema,
  frequencySchema,
  isoDateSchema,
  lineItemRequirementSchema,
  lineItemsConstraintSchema,
  matchModeSchema,
  merchantIdsIn,
  merchantRefSchema,
  minorUnitsSchema,
  quantitySchema,
  recurrenceConstraintSchema,
  referenceConstraintSchema,
  skuIdsIn,
  toJsonSafe,
  validateConstraints,
  viConstraintSchema,
} from './constraints'
export type {
  AcceptableItem,
  ConstraintType,
  ConstraintValidationContext,
  Frequency,
  LineItemRequirement,
  MatchMode,
  MerchantRef,
  VIConstraint,
} from './constraints'

// --- types -------------------------------------------------------------------
export type {
  Ambiguity,
  CatalogAttributes,
  CatalogMerchant,
  CatalogProjection,
  CatalogReader,
  CatalogSku,
  CompileDeps,
  CompileInput,
  CompiledMandate,
  CompiledPreferences,
} from './types'

// --- the compiler -----------------------------------------------------------
export {
  DEFAULT_TTL_SECONDS,
  MAX_HORIZON_MONTHS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  PROPOSAL_AMOUNT_SCHEMA,
  PROPOSAL_DATE_SCHEMA,
  PROPOSAL_FREQUENCIES,
  PROPOSAL_MATCH_MODE_SCHEMA,
  compile,
} from './compile'

export {
  decimalAmountSchema,
  llmProposalSchema,
  localiseProposal,
  scoredFieldsOfMandate,
} from './proposal'
export type { Localised, LocaliseContext, LlmProposal, ScoredFields } from './proposal'

// --- reading the buyer's own words -------------------------------------------
export { currenciesNamedIn, literalCapIn, mentionsRecurrence, resolveCurrency } from './literal'
export type { CurrencyResolution } from './literal'

// --- the read-back ----------------------------------------------------------
export {
  NOT_SPECIFIED,
  NO_DATE,
  READBACK_HEADER,
  READBACK_INTERPRETATION_HEADER,
  READBACK_NOT_COVERED_HEADER,
  READBACK_ORDER,
  READBACK_TEMPLATES,
  expiryCoverageLine,
  formatIstCalendarDate,
  joinWithOr,
  preferenceLines,
  readBack,
  readBackPreconditions,
} from './readback'
export type { ReadBackContext, ReadBackTemplate, ReadBackTz } from './readback'

// --- ambiguities ------------------------------------------------------------
export {
  AMOUNT_CAP_FIELD,
  CURRENCY_FIELD,
  amountCapAmbiguity,
  capCandidatesFor,
  capOptions,
  currencyAmbiguity,
  hasBlockingAmbiguities,
  mergeAmbiguities,
} from './ambiguity'

// --- prompts (exported so they can be asserted on, and reviewed without a model) ---
export {
  MAX_PROMPT_SKUS,
  PROMPT_TRUNCATION_MARKER,
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from './prompt'
