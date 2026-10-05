/**
 * **The signed constraints the Gate enforces because nobody else does** — spec **D19**, §8.8 [B3],
 * §8.10 checks 8 and 11, docs/DECISIONS.md **D-019**.
 *
 * ## Why this file exists
 *
 * The pinned Verifiable Intent library appends `mandate.payment.budget`, `.recurrence` and
 * `.agent_recurrence` to `checked` and evaluates **none** of them ([B3]). `apps/vi` therefore moves
 * them into `constraints.skipped` so the Gate can see what it still owes. That obligation is only
 * dischargeable if the Gate can read the *constraint itself* — and until now it could not: check 8
 * compared the cart against `budget_accounts.cap_minor` and check 11 read `mandates.constraints`,
 * both of which are **our own columns**. A signed $20.00 budget with a $200.00 row in
 * `budget_accounts` therefore allowed a $30.00 cart. That is QA-gate-1, and it was the only thing
 * standing between a buyer's signature and their money.
 *
 * ## Where the signed value is read from, exactly
 *
 * **`VerifyResponse.disclosed.l2`** — the payload vi resolved from the very chain it just verified in
 * check 4. The mandates live in `disclosed.l2.delegate_payload[*]`, and each carries a `constraints`
 * array. That is the *same* array `apps/vi`'s own `_constraints()` enumerates in order to decide
 * which constraint types were "network-enforced" and move them to `skipped` — so the obligation vi
 * reports and the numbers this file reads cannot come from different places.
 *
 * Two consequences worth stating plainly:
 *
 * 1. **No network call.** `disclosed.l2` arrives on the `/v1/verify` response check 4 has already
 *    made. Reading the buyer's signed cap costs a field access, not a round trip. If a change ever
 *    needed a call to learn the signed budget, it would be reading the wrong source.
 * 2. **It is the token, not our column.** `disclosed.l2` is produced by decoding and verifying the
 *    `sd-jwt+kb` the buyer's device key signed, inside the same `verify_chain` whose `chain_valid`
 *    check 4 already read. `mandates.constraints` is a JSONB copy written at signing time and never
 *    re-verified; it is kept here as a **cache**, never as the authority.
 *
 * ## The disagreement rule
 *
 * **Tighter wins, and the signed value is the tie-breaker.** Every cap this module and
 * `budget-guard.ts` consider is a real limit the buyer agreed to, so the enforceable cap is
 * `min(signed L2, mandates.constraints, budget_accounts.cap_minor)`. Returning the *looser* of a
 * signed cap and a cached cap would be the only reading a buyer could call "you spent more than I
 * agreed to", so it is not on the table. Where two sources state the same constraint with different
 * numbers, that is drift, and the smaller number is enforced while the detail names both.
 *
 * ## What "not readable" means, and why it is a BLOCK
 *
 * `found: false` is not an error to swallow. D19 makes the Gate the enforcer; if the Gate cannot
 * read what it was asked to enforce, the honest outcome is that nobody enforced it. `checks.ts`'s
 * obligation guard turns "owed but unreadable" into `BLOCK`, never `ALLOW` — D-019's whole point is
 * that this project fails **closed**.
 */

import { csError, schemas, type CsError, type Currency, type Money } from '@countersign/core'
import { budgetConstraintSchema } from '@countersign/vi-client'
import { readRecurrenceConstraints } from '@countersign/ledger'
import type { AgentRecurrenceConstraint, RecurrenceConstraint } from '@countersign/ledger'

/** §8.8's `budget` constraint tag. The one that carries money. */
export const BUDGET_CONSTRAINT_TYPE = 'mandate.payment.budget'
/** §8.8's `recurrence` constraint tag. */
export const RECURRENCE_CONSTRAINT_TYPE = 'mandate.payment.recurrence'
/** §8.8's `agent_recurrence` constraint tag. */
export const AGENT_RECURRENCE_CONSTRAINT_TYPE = 'mandate.payment.agent_recurrence'

/* ------------------------------------------------------------------------------------------ */
/* Reading the verified chain                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * Where a constraint was read from. Named in the check detail, because a detail string that claims
 * to have read the signed L2 while reading a JSONB column is how QA-gate-2 happened.
 */
export const CONSTRAINT_SOURCE = {
  /**
   * The verified chain: `POST /v1/verify`'s `disclosed.l2.delegate_payload[*].constraints`, as
   * produced by `verify_chain` in check 4. **Authoritative.**
   */
  SIGNED_L2: 'the signed L2 in the verified chain (verify.disclosed.l2)',
  /** `mandates.constraints`, our cache of what was signed at mandate-creation time. */
  MANDATE_COLUMN: 'mandates.constraints',
} as const
export type ConstraintSource = (typeof CONSTRAINT_SOURCE)[keyof typeof CONSTRAINT_SOURCE]

/**
 * The constraints vi disclosed for this chain, and where they came from.
 *
 * `vcts` is the `vct` of every delegate disclosure the constraints were read out of, so a decision
 * record can name the exact object in the token rather than saying "somewhere in the L2".
 */
export interface DisclosedConstraints {
  readonly source: ConstraintSource
  readonly vcts: readonly string[]
  /** Every constraint object found, unvalidated. Validation is each check's business. */
  readonly constraints: readonly unknown[]
}

/**
 * What `CheckState.signedConstraints` holds before check 4 has run.
 *
 * Not an empty `DisclosedConstraints`, because "check 4 has not answered yet" and "check 4 answered
 * and the chain discloses no constraints" are different facts and the detail strings must not
 * conflate them. This one says the first, in words.
 */
export const NO_DISCLOSED_CONSTRAINTS: DisclosedConstraints = Object.freeze({
  source: CONSTRAINT_SOURCE.SIGNED_L2,
  vcts: Object.freeze([]) as readonly string[],
  constraints: Object.freeze([]) as readonly unknown[],
  // The `source` above is deliberately the chain: this object is *about* the chain, and the vcts and
  // constraints being empty is the finding. `budget-guard.ts` and `checks.ts` distinguish the cases
  // with `pending`, which is only ever non-empty once check 4 has answered.
})

/** The `vct` of a delegate disclosure, when it has one. */
function vctOf(entry: Record<string, unknown>): string | null {
  const vct = entry['vct']
  return typeof vct === 'string' && vct.length > 0 ? vct : null
}

/**
 * Pull the disclosed constraints out of `VerifyResponse.disclosed.l2`.
 *
 * Structural on purpose: `disclosed.l2` is typed `Record<string, unknown>` by the wire schema, and
 * this module's job is to survive anything in it. An entry that is not an object, or whose
 * `constraints` is not an array, contributes nothing rather than throwing — the *absence* is then
 * handled by the obligation guard, which fails closed when the constraint was owed.
 *
 * Every delegate disclosure with a `constraints` array is read, not just the payment one. A budget
 * or recurrence constraint is only ever signed into a payment mandate (§8.8's discriminator union),
 * so reading the checkout mandate too cannot invent one — and refusing to read it would mean a vi
 * that renames a `vct` silently disarms the Gate instead of visibly failing the obligation guard.
 *
 * @param disclosedL2 the `disclosed.l2` object from a `/v1/verify` response.
 */
export function disclosedConstraints(disclosedL2: unknown): DisclosedConstraints {
  const payload =
    typeof disclosedL2 === 'object' && disclosedL2 !== null
      ? (disclosedL2 as Record<string, unknown>)
      : undefined
  const delegates = payload?.['delegate_payload']
  if (!Array.isArray(delegates)) {
    return { source: CONSTRAINT_SOURCE.SIGNED_L2, vcts: [], constraints: [] }
  }

  const vcts: string[] = []
  const constraints: unknown[] = []
  for (const raw of delegates) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const list = entry['constraints']
    if (!Array.isArray(list)) continue
    const vct = vctOf(entry)
    if (vct !== null) vcts.push(vct)
    for (const c of list) constraints.push(c)
  }
  return { source: CONSTRAINT_SOURCE.SIGNED_L2, vcts, constraints }
}

/* ------------------------------------------------------------------------------------------ */
/* The signed budget                                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * A `mandate.payment.budget` constraint as the Gate reads it.
 *
 * `max` is the signed ceiling on **total** spend for the mandate, in integer minor units.
 */
export interface SignedBudget {
  readonly max: Money
  /**
   * The signed `min`, reported and never enforced.
   *
   * A `budget` constraint states a floor the mandate is *expected* to reach. Refusing a purchase for
   * not having spent enough yet would punish the buyer for the agent being slow, so this is carried
   * for the detail string and for a future minimum-spend feature and nothing else. It is the one
   * number in this file that is deliberately not compared.
   */
  readonly min: Money | null
}

/**
 * The outcome of looking for a signed budget. `found: false` carries the *reason*, because "no
 * budget constraint" and "a budget constraint that would not parse" are different facts and the
 * BLOCK copy a buyer reads has to be true.
 */
export type BudgetReading =
  | { readonly found: true; readonly budget: SignedBudget }
  | { readonly found: false; readonly why: string }

/**
 * Read `mandate.payment.budget` out of a disclosed constraint list.
 *
 * The shape is validated with `budgetConstraintSchema` from `@countersign/vi-client` rather than by
 * hand, so "what a budget constraint looks like" has exactly one definition in the repository and a
 * service that widens the schema widens this reader with it. `max` crosses the JSON boundary as a
 * *number*, so it goes through core's single sanctioned `bigintFromJson` — never `Number()` and
 * never a float (EC-FX-5, EC-FX-6).
 *
 * The **tightest** `max` wins if several are disclosed, and every candidate's currency is checked
 * against the first: a budget constraint in two currencies is not a budget the Gate can evaluate, and
 * picking one of them would be picking the looser one half the time.
 */
export function readSignedBudget(
  from: { readonly constraints: readonly unknown[] } | readonly unknown[] | undefined,
): BudgetReading {
  const constraints = Array.isArray(from)
    ? (from as readonly unknown[])
    : ((from as { constraints: readonly unknown[] } | undefined)?.constraints ?? [])
  let best: SignedBudget | null = null
  let sawCurrency: Currency | null = null

  for (const raw of constraints) {
    if (typeof raw !== 'object' || raw === null) continue
    const candidate = raw as Record<string, unknown>
    if (candidate['type'] !== BUDGET_CONSTRAINT_TYPE) continue

    const parsed = budgetConstraintSchema.safeParse(candidate)
    if (!parsed.success) {
      // A disclosed budget we cannot parse is a budget we cannot enforce. Say so and let the
      // obligation guard decide; never treat it as absent.
      return {
        found: false,
        why:
          `${CONSTRAINT_SOURCE.SIGNED_L2} discloses a ${BUDGET_CONSTRAINT_TYPE} constraint that is not ` +
          `well formed, so the signed ceiling could not be read: ${parsed.error.issues[0]?.message ?? 'no detail'}`,
      }
    }

    const currency = parsed.data.currency
    if (sawCurrency === null) sawCurrency = currency
    if (sawCurrency !== currency) {
      return {
        found: false,
        why:
          `the signed ${BUDGET_CONSTRAINT_TYPE} constraints name two currencies (${sawCurrency} and ` +
          `${currency}), so no single ceiling could be enforced`,
      }
    }

    const max: Money = { minor: schemas.bigintFromJson(parsed.data.max), currency }
    const min =
      parsed.data.min === null ? null : { minor: schemas.bigintFromJson(parsed.data.min), currency }
    if (best === null || max.minor < best.max.minor) {
      best = { max, min }
    }
  }

  if (best === null) {
    return {
      found: false,
      why: `${CONSTRAINT_SOURCE.SIGNED_L2} discloses no ${BUDGET_CONSTRAINT_TYPE} constraint`,
    }
  }
  return { found: true, budget: best }
}

/* ------------------------------------------------------------------------------------------ */
/* Which cap binds                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** The three places a mandate budget can be stated. Ordered by authority, tightest-first on a tie. */
export type BudgetCapSource = 'signed_l2' | 'mandate_column' | 'account_cap'

/** One candidate ceiling. */
export interface BudgetCapCandidate {
  readonly source: BudgetCapSource
  readonly cap: Money
}

/**
 * The enforceable ceiling, and which source it came from.
 *
 * Every candidate is a limit the buyer is bound by, so the answer is the **smallest** of them. On a
 * tie the most authoritative source wins, so the detail string names the signature rather than a
 * cache that happens to agree with it.
 */
export interface EffectiveBudgetCap {
  readonly cap: Money
  readonly boundBy: BudgetCapSource
  readonly candidates: readonly BudgetCapCandidate[]
}

/** Higher wins a tie. Deliberately the reverse of the array order a reader expects. */
const CAP_AUTHORITY: Readonly<Record<BudgetCapSource, number>> = Object.freeze({
  signed_l2: 3,
  mandate_column: 2,
  account_cap: 1,
})

/** Short, quotable name for a source. Used in the check-8 detail. */
export function capSourceLabel(source: BudgetCapSource): string {
  switch (source) {
    case 'signed_l2':
      return `the signed L2 ${BUDGET_CONSTRAINT_TYPE} constraint`
    case 'mandate_column':
      return `${CONSTRAINT_SOURCE.MANDATE_COLUMN}`
    case 'account_cap':
      return 'budget_accounts.cap_minor'
  }
}

/**
 * `min` over every candidate ceiling, with the binding source named.
 *
 * Pure and total: it cannot refuse, because the currency check that would need to happen first is
 * {@link checkCapCurrencies} and is a *decision*, not arithmetic. Comparing `Money` values across
 * currencies would be meaningless, and quietly converting would be worse.
 */
export function effectiveBudgetCap(candidates: readonly BudgetCapCandidate[]): EffectiveBudgetCap {
  if (candidates.length === 0) {
    throw new Error('effectiveBudgetCap needs at least one candidate')
  }
  let winner = candidates[0]!
  for (const candidate of candidates.slice(1)) {
    if (
      candidate.cap.minor < winner.cap.minor ||
      (candidate.cap.minor === winner.cap.minor &&
        CAP_AUTHORITY[candidate.source] > CAP_AUTHORITY[winner.source])
    ) {
      winner = candidate
    }
  }
  return { cap: winner.cap, boundBy: winner.source, candidates }
}

/**
 * Every candidate must be in the account's currency, or the Gate refuses.
 *
 * EC-FX-1: a user-signed ₹ limit must never silently become a $ spend, so a mismatch is a BLOCK and
 * never a conversion. The message names both currencies and which source carried the odd one out.
 */
export function checkCapCurrencies(candidates: readonly BudgetCapCandidate[]): CsError | null {
  const reference = candidates[0]
  if (!reference) return null
  for (const candidate of candidates.slice(1)) {
    if (candidate.cap.currency === reference.cap.currency) continue
    return csError(
      'CS_CURRENCY_MISMATCH',
      `The ${capSourceLabel(candidate.source)} limit is ${candidate.cap.currency} but the ` +
        `${capSourceLabel(reference.source)} limit and this cart are ${reference.cap.currency}; ` +
        `no conversion is ever applied (EC-FX-1)`,
      {
        a: candidate.cap.currency,
        b: reference.cap.currency,
        aSource: candidate.source,
        bSource: reference.source,
      },
      {
        userMessage:
          'That limit and this purchase are in different currencies, so we did not convert them. ' +
          'Create a mandate in the store currency.',
      },
    )
  }
  return null
}

/* ------------------------------------------------------------------------------------------ */
/* The signed recurrence                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** One recurrence constraint, plus every source that stated it. */
export interface RecurrenceReading {
  readonly constraint: RecurrenceConstraint | AgentRecurrenceConstraint
  readonly sources: readonly ConstraintSource[]
}

/** `type|frequency|start|end` — the identity of a *window*, ignoring the occurrence count. */
function recurrenceWindowKey(c: RecurrenceConstraint | AgentRecurrenceConstraint): string {
  return [c.type, c.frequency, c.start_date, c.end_date ?? ''].join('|')
}

/** The occurrence limit of a recurrence constraint, or `null` when only the date window bounds it. */
function recurrenceLimit(c: RecurrenceConstraint | AgentRecurrenceConstraint): number | null {
  return c.type === RECURRENCE_CONSTRAINT_TYPE ? (c.number ?? null) : (c.max_occurrences ?? null)
}

/**
 * Read the recurrence constraints from every source and merge them.
 *
 * Sources are read in the order given and a *window* is evaluated once. When two sources state the
 * same window with different occurrence counts that is drift between the signature and our cache,
 * and the **smaller** count is kept — the same rule as {@link effectiveBudgetCap}, for the same
 * reason: the buyer cannot be accused of spending more often than they agreed to.
 *
 * Both sources are consulted rather than only the signed one, because `mandates.constraints` is how
 * a constraint reaches this process in every deployment that has not yet re-verified its L2, and
 * dropping it would loosen enforcement for reasons that have nothing to do with the buyer's intent.
 */
export function mergeRecurrenceConstraints(
  sources: ReadonlyArray<{
    readonly source: ConstraintSource
    readonly constraints: readonly unknown[]
  }>,
): RecurrenceReading[] {
  const byWindow = new Map<string, RecurrenceReading>()
  for (const { source, constraints } of sources) {
    for (const constraint of readRecurrenceConstraints(constraints)) {
      const key = recurrenceWindowKey(constraint)
      const seen = byWindow.get(key)
      if (!seen) {
        byWindow.set(key, { constraint, sources: [source] })
        continue
      }
      const existing = seen.constraint
      const existingLimit = recurrenceLimit(existing)
      const incomingLimit = recurrenceLimit(constraint)
      // A `null` limit means "the date window is the whole limit", which is *looser* than any
      // numeric count — so a numeric limit always replaces it.
      const tighter =
        existingLimit === null
          ? constraint
          : incomingLimit === null
            ? existing
            : incomingLimit < existingLimit
              ? constraint
              : existing
      byWindow.set(key, {
        constraint: tighter,
        sources: seen.sources.includes(source) ? seen.sources : [...seen.sources, source],
      })
    }
  }
  return [...byWindow.values()]
}

/** "the signed L2 in the verified chain and mandates.constraints" — the quotable source list. */
export function describeSources(sources: readonly ConstraintSource[]): string {
  if (sources.length === 0) return 'no source'
  if (sources.length === 1) return sources[0]!
  return `${sources.slice(0, -1).join(', ')} and ${sources[sources.length - 1]}`
}
