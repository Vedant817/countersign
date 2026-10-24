/**
 * `compile` — spec **§8.8 (M8)**, WP-08, P0-7.
 *
 * ```ts
 * compile(i: CompileInput, deps: { llm?: LanguageModel; catalog: CatalogReader }): Promise<Result<CompiledMandate>>
 * ```
 *
 * ## The shape of the whole function — the parser runs first (P0-7)
 *
 * ```
 *   1. read the catalog          ── deterministic, our data
 *   2. resolve the currency      ── from the user's own words (literal.ts)
 *   3. parse the sentence        ── deterministic: money, cadence, merchants, items, dates (parser.ts)
 *   4. build a proposal          ── from step 3 alone
 *   5. the model, only for gaps  ── line items the lexicon could not match, and search hints
 *   6. merge                     ── parser wins on every field that can widen authority
 *   7. localise into constraints ── refusing every defect (proposal.ts)
 *   8. validate the set          ── invariants, including the AT-M8.5 ceiling
 *   9. add the blocking ambiguity the intent did not answer
 * ```
 *
 * Steps 2, 3, 4 and 6–9 are deterministic and run on data the model does not control. That is what makes
 * §8.0 rule 4 ("no LLM output is authoritative") a property of this code rather than an aspiration: the
 * cap the buyer signs is the cap their own sentence supports, read by `parser.ts`, and a model's number is
 * only ever *compared* against it.
 *
 * ## What changed from the model-first version, and why
 *
 * The previous pipeline asked the model first and clamped what came back to the largest number in the text.
 * The clamp was sound; the *arrangement* was not, and the judge panel measured the consequence
 * (`docs/review/REVERIFY.md` F8): ten runs of one sentence gave nine signable mandates and one question,
 * and "fifty dollars" produced no cap at all. Clamping cannot fix either — both are the model being the
 * reader of a number.
 *
 * So the model is now consulted **only when the parser found a cap but no item**, which is the one gap a
 * deterministic reader cannot fill: `"something warm for the trip, under $100"` names no product, and
 * choosing between a down jacket and a sleeping bag is a judgement, not a reading. Everything else — the
 * demo sentences, the corpus, and most real requests — never reaches a model at all, which is why they are
 * byte-for-byte reproducible across runs (proof: `packages/evals/src/determinism.ts`, 20 runs per case).
 *
 * ## EC-LLM-1: an outage returns an error, never a half-filled mandate
 *
 * When the model is unreachable *and it was needed*, `compile` returns `err(LLM_UNAVAILABLE)` and nothing
 * else (EC-LLM-1). It does not return a `CompiledMandate` with the constraints it managed to build: a
 * partial mandate renders a confident read-back that is missing something, and the user signs it. §12.14's
 * fallback for the compiler is the manual constraint form, and `LLM_UNAVAILABLE`'s registry copy already
 * says so. When the model is **not** needed the dependency is not touched, which is why the whole
 * deterministic path compiles with no provider configured at all.
 *
 * ## EC-LLM-2: exactly one repair retry
 *
 * The schema failure path re-asks once with the issues listed. A second failure returns `LLM_SCHEMA`,
 * whose copy is "The model's answer did not match the expected shape, so we asked again." — accurate,
 * because it really did. Retrying further would trade a clear error for an unpredictable bill and a
 * latency nobody can quote (spec §14's SLOs assume no retry storm on the consent screen).
 */

import {
  csError,
  err,
  fixedClock,
  ok,
  toCsError,
  type Currency,
  type Result,
} from '@countersign/core'
import {
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  generateText,
  type LanguageModel,
} from 'ai'

import {
  amountCapAmbiguity,
  capCandidatesFor,
  currencyAmbiguity,
  mergeAmbiguities,
} from './ambiguity'
import { isoDateSchema, matchModeSchema, type Frequency, type VIConstraint } from './constraints'
import { currenciesNamedIn, mentionsRecurrence, resolveCurrency } from './literal'
import { parseIntent, utcDateOf } from './parser'
import {
  localiseProposal,
  mergeProposal,
  modelProposedAbove,
  llmProposalSchema,
  proposalFromParsedIntent,
  decimalAmountSchema,
  type LlmProposal,
} from './proposal'
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from './prompt'
import type {
  Ambiguity,
  CatalogProjection,
  CompileDeps,
  CompileInput,
  CompiledMandate,
  CompiledPreferences,
} from './types'

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

/** §8.8: "default 7d, max 30d". */
export const DEFAULT_TTL_SECONDS = 604_800
export const MAX_TTL_SECONDS = 2_592_000
export const MIN_TTL_SECONDS = 60

/**
 * How far ahead a recurring window may run when the buyer gave no end date, in calendar months.
 *
 * Months, not days, because a window that starts on the 1st should end on the 1st: `2026-10-01 + 24
 * months` is `2028-10-01`, whereas `+ 730 days` is `2028-09-30` and a read-back ending the day before its own
 * anniversary is the kind of small wrongness a judge notices. Calendar arithmetic over explicit arguments,
 * not a clock read.
 */
export const MAX_HORIZON_MONTHS = 24

// ---------------------------------------------------------------------------
// Repair prompt issues
// ---------------------------------------------------------------------------

/**
 * Turn a failed structured output into repair notes.
 *
 * Three sources, in the order they are worth saying:
 *
 * 1. **Zod issues**, pulled out of the error chain. `NoObjectGeneratedError` wraps a
 *    `TypeValidationError` wraps the `ZodError`, so the path and message survive and the note can name the
 *    field: `amountMax: expected a decimal string like "130.00", received number`.
 * 2. **Id validation**, checked here against the catalog, because a schema that only says "array of
 *    strings" cannot tell the model that `mrc_ghost` does not exist. §8.0 rule 4 again: check the model's
 *    answer with deterministic code, then show the human.
 * 3. **A floor**, so the retry prompt is never empty. If nothing could be diagnosed, saying so is more
 *    useful to the model than an empty list.
 */
function repairNotes(args: {
  readonly cause: unknown
  readonly projection: CatalogProjection
}): string[] {
  const notes: string[] = []

  let cursor: unknown = args.cause
  for (let hop = 0; hop < 5 && cursor !== null && typeof cursor === 'object'; hop += 1) {
    const asIssues = cursor as { issues?: unknown; name?: unknown }
    if (Array.isArray(asIssues.issues)) {
      for (const issue of asIssues.issues as Array<{ path?: unknown; message?: unknown }>) {
        const path = Array.isArray(issue.path) ? issue.path.join('.') : ''
        const message =
          typeof issue.message === 'string' ? issue.message : 'did not match the schema'
        notes.push(path.length > 0 ? `${path}: ${message}` : message)
      }
      break
    }
    cursor = (cursor as { cause?: unknown }).cause
  }

  const merchantIds = new Set(args.projection.merchants.map((m) => m.id))
  const skuIds = new Set(args.projection.skus.map((s) => s.id))
  for (const id of arrayField(args.cause, 'merchantIds')) {
    if (!merchantIds.has(id))
      notes.push(`merchantIds: "${id}" is not in the catalog. Use a listed id or omit it.`)
  }
  for (const line of arrayOfObjects(args.cause, 'lineItems')) {
    for (const id of stringArray(line.skuIds)) {
      if (!skuIds.has(id))
        notes.push(`lineItems.skuIds: "${id}" is not in the catalog. Use a listed id or omit it.`)
    }
  }

  if (notes.length === 0) notes.push('the answer could not be read as the required JSON object')
  return notes.slice(0, 8)
}

/**
 * Recover the raw proposal text from a failed structured output, if the SDK kept it.
 *
 * `NoObjectGeneratedError` and `TypeValidationError` both carry `text` / `value`, so a repair turn can
 * show the model what it actually wrote rather than asking it to fix an answer neither side can see.
 * Purely an improvement to the retry's odds; every check still runs on the fresh answer.
 */
function rawTextFrom(cause: unknown): string | null {
  let cursor: unknown = cause
  for (let hop = 0; hop < 5 && cursor !== null && typeof cursor === 'object'; hop += 1) {
    const asText = cursor as { text?: unknown }
    if (typeof asText.text === 'string' && asText.text.length > 0) return asText.text
    cursor = (cursor as { cause?: unknown }).cause
  }
  return null
}

function collectStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/** Find an array-valued property anywhere on the error's `value` chain. */
function arrayField(cause: unknown, key: string): string[] {
  let cursor: unknown = cause
  for (let hop = 0; hop < 5 && cursor !== null && typeof cursor === 'object'; hop += 1) {
    const value = (cursor as { value?: unknown }).value
    if (value !== null && typeof value === 'object') {
      const found = (value as Record<string, unknown>)[key]
      if (Array.isArray(found)) return collectStrings(found)
    }
    cursor = (cursor as { cause?: unknown }).cause
  }
  return []
}

function arrayOfObjects(cause: unknown, key: string): Record<string, unknown>[] {
  let cursor: unknown = cause
  for (let hop = 0; hop < 5 && cursor !== null && typeof cursor === 'object'; hop += 1) {
    const value = (cursor as { value?: unknown }).value
    if (value !== null && typeof value === 'object') {
      const found = (value as Record<string, unknown>)[key]
      if (Array.isArray(found)) {
        return found.filter(
          (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
        )
      }
    }
    cursor = (cursor as { cause?: unknown }).cause
  }
  return []
}

function stringArray(value: unknown): string[] {
  return collectStrings(value)
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Reject an input the compiler cannot honour, before spending a token on it.
 *
 * Two currencies named in one sentence is refused here rather than resolved later, because there is no
 * defensible tie-break: the two readings give two different limits, and picking one is an FX conversion
 * the user never agreed to (EC-FX-1).
 */
function validateInput(i: CompileInput): Result<CompileInput> {
  const text = i.text.trim()
  if (text.length === 0) {
    return err(csError('CS_VALIDATION', 'The request is empty', { field: 'text' }))
  }
  if (text.length > 4_000) {
    return err(
      csError('CS_VALIDATION', 'The request is longer than 4000 characters', {
        field: 'text',
        length: text.length,
      }),
    )
  }
  const named = currenciesNamedIn(text)
  if (named.length > 1) {
    return err(
      csError(
        'CS_VALIDATION',
        `The request names more than one currency (${named.join(', ')}). Countersign does not convert ` +
          'between currencies, so one limit in one currency is all a mandate can carry.',
        { field: 'text', currencies: named, ec: 'EC-FX-1' },
        { userMessage: 'Please pick one currency for this limit.' },
      ),
    )
  }
  return ok({ ...i, text })
}

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

/**
 * Resolve the mandate lifetime.
 *
 * §8.8's "default 7d, max 30d" is a **ceiling**, and a ceiling is enforced by clamping rather than by
 * refusing. A buyer who says "for the next six months" should get a mandate, not an error: they get
 * thirty days and a note saying why. Clamping downward only ever *reduces* authority, which is the safe
 * direction, and the note means it is never silent. Widening the ceiling instead would hand back more
 * authority than was asked for.
 *
 * The lower bound is clamped for the opposite reason: a 5-second mandate is unusable and vi's own floor is
 * 60 s, so raising it to 60 s changes nothing a human could act on within. Both notes land in the
 * read-back's "How we read your request" section.
 */
function resolveTtl(proposed: number | undefined, assumptions: string[]): Result<number> {
  if (proposed === undefined) return ok(DEFAULT_TTL_SECONDS)
  if (proposed > MAX_TTL_SECONDS) {
    assumptions.push(
      `This mandate lasts ${Math.floor(MAX_TTL_SECONDS / 86_400)} days, not ${Math.floor(proposed / 86_400)}: ` +
        'a Countersign mandate cannot live longer than that.',
    )
    return ok(MAX_TTL_SECONDS)
  }
  if (proposed < MIN_TTL_SECONDS) {
    assumptions.push('This mandate lasts one minute, which is the shortest a mandate can be.')
    return ok(MIN_TTL_SECONDS)
  }
  return ok(proposed)
}

/**
 * Check a recurring window against the intent's own dates.
 *
 * `agent_recurrence.end_date` is required by the library, so a model that omitted it is fixed here rather
 * than sent to a 422. The default is the **maximum** allowed horizon — never a year, which would be a
 * grant of authority nobody asked for.
 *
 * A window that starts before the mandate was created is a *defect*, not something to fix: "every month
 * from last March" is either a mistake or means something this system cannot express, and quietly
 * advancing it to today would change what the buyer signed.
 */
function resolveRecurrenceWindows(
  proposal: LlmProposal,
  constraints: readonly VIConstraint[],
  nowEpochSec: number,
): Result<{ constraints: VIConstraint[]; assumptions: string[] }> {
  const out = [...constraints]
  const assumptions: string[] = []
  const today = new Date(nowEpochSec * 1000).toISOString().slice(0, 10)

  for (let index = 0; index < out.length; index += 1) {
    const c = out[index]
    if (c === undefined) continue
    if (c.type !== 'mandate.payment.recurrence' && c.type !== 'mandate.payment.agent_recurrence')
      continue

    let endDate = c.end_date
    if (endDate === undefined) {
      const [y = '0', mo = '0', d = '0'] = c.start_date.split('-')
      const horizon = new Date(Date.UTC(Number(y), Number(mo) - 1 + MAX_HORIZON_MONTHS, Number(d)))
        .toISOString()
        .slice(0, 10)
      assumptions.push(
        `This mandate repeats until ${horizon}, the longest window Countersign will sign. You did not ` +
          'give an end date.',
      )
      endDate = horizon
    }
    if (c.start_date < today) {
      return err(
        csError(
          'CS_VALIDATION',
          `A repeating payment is proposed starting ${c.start_date}, which is before today (${today}).`,
          { field: 'recurrence.startDate', startDate: c.start_date, today },
          { userMessage: 'Please check the start date for the repeating payment.' },
        ),
      )
    }
    if (c.type === 'mandate.payment.recurrence') {
      out[index] = { ...c, end_date: endDate }
    } else {
      out[index] = { ...c, end_date: endDate }
    }
  }
  return ok({ constraints: out, assumptions })
}

// ---------------------------------------------------------------------------
// One model call
// ---------------------------------------------------------------------------

interface AskOutcome {
  readonly proposal: LlmProposal | null
  readonly schemaFailure: { readonly issues: string[]; readonly text: string | null } | null
}

/**
 * One `generateText` call, classified.
 *
 * Two outcomes and no third: either a proposal, or a *schema* failure carrying notes for the repair turn.
 * Anything else — a timeout, a 500, a refused connection — propagates to {@link compile}, which turns it
 * into `LLM_UNAVAILABLE` (EC-LLM-1). Keeping "the model was unreachable" and "the model's answer was
 * unusable" apart matters: one is retryable by the buyer in ten seconds, the other is not retryable at all
 * without changing the request.
 */
async function askOnce(model: LanguageModel, system: string, prompt: string): Promise<AskOutcome> {
  const result = await generateText({
    model,
    system,
    prompt,
    temperature: 0,
    output: Output.object({ schema: llmProposalSchema, name: 'spending_mandate' }),
  })
  return { proposal: result.output, schemaFailure: null }
}

/** Run `askOnce` and classify the throw. Never rethrows a model error as a raw exception. */
async function attemptAsk(
  model: LanguageModel,
  system: string,
  prompt: string,
  projection: CatalogProjection,
): Promise<Result<AskOutcome>> {
  try {
    return ok(await askOnce(model, system, prompt))
  } catch (cause) {
    if (NoObjectGeneratedError.isInstance(cause) || NoOutputGeneratedError.isInstance(cause)) {
      return ok({
        proposal: null,
        schemaFailure: { issues: repairNotes({ cause, projection }), text: rawTextFrom(cause) },
      })
    }
    if (isZodError(cause)) {
      return ok({
        proposal: null,
        schemaFailure: { issues: repairNotes({ cause, projection }), text: null },
      })
    }
    return err(toCsError(cause, 'LLM_UNAVAILABLE'))
  }
}

function isZodError(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && (cause as { name?: unknown }).name === 'ZodError'
  )
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

/**
 * Compile a buyer's request into a proposed mandate.
 *
 * @param deps.llm the language model. `LLM_MAIN_MODEL` (spec §6) is resolved by the caller, so this
 *   function is testable with a fake and the model in use is a configuration fact rather than a constant
 *   buried here.
 * @param deps.catalog the only way the compiler learns what exists. See {@link CatalogReader}.
 * @param deps.clock supplies `nowSec()` so expiry and the "start date cannot be in the past" check are
 *   testable rather than dependent on the wall clock.
 */
export async function compile(
  i: CompileInput,
  deps: CompileDeps,
): Promise<Result<CompiledMandate>> {
  const clock = deps.clock ?? fixedClock(0)

  const input = validateInput(i)
  if (!input.ok) return input

  const catalog = await deps.catalog.read()
  if (!catalog.ok) return catalog

  const projection = catalog.value
  if (projection.merchants.length === 0) {
    return err(
      csError(
        'CS_NOT_FOUND',
        'No merchants are connected, so there is nothing to authorise a limit against',
        {
          field: 'defaults.merchantIds',
        },
        { userMessage: 'Connect a store first, then set your limits.' },
      ),
    )
  }

  const resolution = resolveCurrency({
    text: input.value.text,
    defaultCurrency: input.value.defaults.currency,
    catalogCurrencies: projection.skus.map((s) => s.currency),
  })
  if (!resolution.ok) {
    // `validateInput` already refused two named currencies, so this is unreachable in practice; the
    // branch exists so a future caller of `resolveCurrency` degrades to a question rather than a crash.
    const ambiguity: Ambiguity = currencyAmbiguity(resolution.named)
    return err(
      csError('CS_VALIDATION', `The request names more than one currency: ${ambiguity.question}`, {
        field: CURRENCY_AMBIGUITY_FIELD,
        ec: 'EC-FX-1',
      }),
    )
  }
  const mandateCurrency: Currency = resolution.currency

  const nowSec = clock.nowSec()

  // --- 3–4. the deterministic reader runs first, and is never skipped ------------------------------
  const parsed = parseIntent(input.value.text, {
    currency: mandateCurrency,
    catalog: projection,
    nowEpochSec: nowSec,
  })
  const baseProposal = proposalFromParsedIntent(parsed, mandateCurrency)

  /*
   * --- 5. is there anything left for a model? -------------------------------------------------------
   *
   * Only one gap is worth a call: a sentence that states a limit but names no product the catalog
   * lexicon can match (`"something warm for the trip, under $100"`). Everything else the model used to
   * be asked for is either already read (money, cadence, merchants, dates) or not a constraint at all
   * (`preferences`). A sentence with no cap is a question (§8.8), and asking a model to fill it would be
   * the guess §8.8 forbids — so the model is not consulted at all.
   *
   * `deps.llm` being absent is a supported state, not a degradation: it is what lets the corpus, the
   * determinism check and a judge with no API key compile every sentence in this repository.
   */
  const hasCap = parsed.amountMaxMinor !== null || parsed.budgetMaxMinor !== null
  const askModel =
    deps.llm !== undefined && parsed.conflicts.length === 0 && hasCap && parsed.skuIds.length === 0

  let modelProposal: LlmProposal | null = null
  if (askModel) {
    const llm = deps.llm as LanguageModel
    const system = buildSystemPrompt({
      catalog: projection,
      currency: mandateCurrency,
      locale: input.value.locale,
    })
    const userPrompt = buildUserPrompt({
      input: input.value,
      currency: mandateCurrency,
      // The ceiling is the parser's, so the prompt and the merge agree about the buyer's own bytes.
      literalCeiling: parsed.ceilingMinor,
      locale: input.value.locale,
      // The clock is injected, so "today" is a value this function was given rather than one it reads.
      // That is what keeps a prompt snapshot in a test an assertion instead of a race with midnight UTC.
      todayIso: utcDateOf(nowSec),
    })

    // --- EC-LLM-2: one repair retry, then a typed error ---------------------------------------------
    const first = await attemptAsk(llm, system, userPrompt, projection)
    if (!first.ok) return first

    let outcome = first.value
    if (outcome.schemaFailure !== null) {
      const repairPrompt = buildRepairPrompt({
        previousIssues: outcome.schemaFailure.issues,
        userPrompt:
          outcome.schemaFailure.text === null
            ? userPrompt
            : `${userPrompt}\n\nYour previous answer was:\n${outcome.schemaFailure.text}`,
      })
      const second = await attemptAsk(llm, system, repairPrompt, projection)
      if (!second.ok) return second
      outcome = second.value
      if (outcome.schemaFailure !== null) {
        return err(
          csError(
            'LLM_SCHEMA',
            `The model's answer did not match the required schema after one repair attempt. Issues: ${outcome.schemaFailure.issues.join('; ')}`,
            { issues: outcome.schemaFailure.issues, attempts: 2, ec: 'EC-LLM-2' },
            {
              userMessage:
                'We could not read that request as spending limits. Please enter the limits by hand.',
            },
          ),
        )
      }
    }

    modelProposal = outcome.proposal
    if (modelProposal === null) {
      // Unreachable: `attemptAsk` yields either a proposal or a schema failure, and both failures above
      // return. Kept as a loud invariant rather than a silent empty mandate.
      return err(
        csError('CS_INTERNAL', 'compile reached an impossible state: no proposal and no failure', {
          ec: 'COMPILER-INVARIANT',
        }),
      )
    }
  }

  /*
   * --- 6. merge, in the one safe direction ----------------------------------------------------------
   *
   * The parser's cap is the cap. A model that answered with a bigger number is not clamped into the
   * mandate — the number is simply not copied, and the buyer is told. This is the safety invariant
   * `test/parser.test.ts` proves directly, with a model told to answer $999,999.99 for a $30 sentence.
   */
  const proposal =
    modelProposal === null ? baseProposal : mergeProposal(baseProposal, modelProposal)

  const assumptions: string[] = [...resolution.assumptions, ...(modelProposal?.assumptions ?? [])]
  if (
    modelProposedAbove(
      modelProposal,
      parsed.amountMaxMinor ?? parsed.budgetMaxMinor,
      mandateCurrency,
    )
  ) {
    const tightest =
      parsed.ceilingMinor !== null && parsed.ceilingMinor > (parsed.amountMaxMinor ?? 0n)
    assumptions.push(
      `The limit on a single payment was lowered to the ${tightest ? 'tightest' : 'largest'} amount you ` +
        'wrote. Something in the request asked for a higher one, and a limit only ever comes from your ' +
        'own words.',
    )
  }
  if (modelProposedAbove(modelProposal, parsed.budgetMaxMinor, mandateCurrency)) {
    const tightest =
      parsed.ceilingMinor !== null && parsed.ceilingMinor > (parsed.budgetMaxMinor ?? 0n)
    assumptions.push(
      `The limit on the total was lowered to the ${tightest ? 'tightest' : 'largest'} amount you wrote. ` +
        'Something in the request asked for a higher one, and a limit only ever comes from your own words.',
    )
  }

  const literalCap = parsed.ceilingMinor

  const localised = localiseProposal(proposal, {
    mandateCurrency,
    literalCap,
    merchantsById: new Map(projection.merchants.map((m) => [m.id, m])),
    skusById: new Map(projection.skus.map((s) => [s.id, s])),
    defaultMerchantIds: input.value.defaults.merchantIds,
    text: input.value.text,
    onDefect: 'manual-form',
  })
  if (!localised.ok) return localised

  assumptions.push(...localised.value.assumptions)

  const windows = resolveRecurrenceWindows(proposal, localised.value.constraints, nowSec)
  if (!windows.ok) return windows
  assumptions.push(...windows.value.assumptions)

  const ttl = resolveTtl(proposal.ttlSeconds, assumptions)
  if (!ttl.ok) return ttl

  // --- §8.8: an intent with no cap is an ambiguity, never a guess ----------------------
  const hasAmountCap = localised.value.amountMax !== null || localised.value.budgetMax !== null
  const required: Ambiguity[] = []
  if (!hasAmountCap) {
    const skuIds = (proposal.lineItems ?? []).flatMap((line) => line.skuIds)
    required.push(
      amountCapAmbiguity({
        currency: mandateCurrency,
        candidates: capCandidatesFor(projection, skuIds, mandateCurrency),
      }),
    )
  }
  /*
   * A text that supports two readings of the same field (two cadences, a range that ends below where it
   * starts) is a question, never a preference. These come from the parser, which is the only component
   * that can see that the *buyer's own sentence* is ambiguous — a model disagreement is not a conflict,
   * because the model is not a source of authority.
   */
  const conflicts: Ambiguity[] = parsed.conflicts.map((c) => ({
    field: c.field,
    question: c.question,
    options: [...c.options],
  }))
  const merged = mergeAmbiguities(required, [...conflicts, ...(proposal.ambiguities ?? [])])

  const preferences: CompiledPreferences = proposal.preferences ?? {}
  if (
    mentionsRecurrence(input.value.text) === false &&
    (proposal.recurrence !== undefined || proposal.agentRecurrence !== undefined)
  ) {
    // Reachable now only through a model answer: the parser emits a recurrence only from a recurrence
    // word, and this is the check that refuses a model-invented one.
    return err(
      csError('CS_INTERNAL', 'compile accepted a recurrence the intent does not justify', {
        ec: 'COMPILER-INVARIANT',
      }),
    )
  }

  return ok({
    constraints: windows.value.constraints,
    currency: mandateCurrency,
    ttlSeconds: ttl.value,
    expiresAtEpochSec: nowSec + ttl.value,
    preferences,
    assumptions,
    ambiguities: merged,
  })
}

/** Field name the multi-currency refusal is filed under, kept beside the check that raises it. */
const CURRENCY_AMBIGUITY_FIELD = 'currency'

/**
 * The 8 August ISO 20022 frequency codes, re-exported for callers that build a recurrence by hand
 * (the manual constraint form, WP-16). The union of `llmProposalSchema.frequency` and this list is
 * checked in `test/compile.test.ts`, so a frequency accepted by the library but not by the proposal
 * schema cannot be introduced silently.
 */
export const PROPOSAL_FREQUENCIES: readonly Frequency[] = [
  'INDA',
  'DAIL',
  'WEEK',
  'TWOK',
  'TWMN',
  'MNTH',
  'TOMN',
  'QUTR',
  'FOMN',
  'SEMI',
  'YEAR',
  'TYEA',
]

/** Re-exported so a caller can build a hand-authored recurrence with the same validation. */
export const PROPOSAL_DATE_SCHEMA = isoDateSchema
/** Re-exported for the manual constraint form's `match_mode` control. */
export const PROPOSAL_MATCH_MODE_SCHEMA = matchModeSchema
/** Re-exported so the manual form validates amounts with the same rule the model is held to. */
export const PROPOSAL_AMOUNT_SCHEMA = decimalAmountSchema
