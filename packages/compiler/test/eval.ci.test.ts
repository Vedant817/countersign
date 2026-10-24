/**
 * `eval:ci` — the golden-set PR gate. No network, no API key.
 *
 * Replays the ten recorded model answers in `eval/cached.jsonl` through the real `compile` and scores the
 * result against `eval/golden.jsonl`. Ten cases is the number §8.8 names for the PR gate; the full sixty run
 * on a live model is `eval:live`.
 *
 * ### What this gate does and does not prove
 *
 * **Does:** a change to localisation, the AT-M8.5 literal ceiling, the currency resolution, the ambiguity
 * rule, the budget synthesis or the scorer fails the PR. Those are the parts that turn a model's answer into
 * a mandate, and they are where a refactor can quietly lose a limit.
 *
 * **Does not:** measure the model. The recorded answers are hand-authored placeholders (there is no
 * `OPENAI_API_KEY` yet — `docs/HUMAN_TODO.md` H-02), so a 100% score here says the pipeline is correct on
 * ten inputs and says nothing about `gpt-6.1-sol`. `AT-M8.1`'s ≥ 95% is a claim about `eval:live`.
 *
 * The assertion is a **floor**, not a pass/fail per case: 9/10 is tolerated so a single hand-authored
 * placeholder being corrected cannot block a PR, while any systematic regression still fails. The per-case
 * outcomes are printed either way, because a gate that fails without saying which case moved is a gate
 * people learn to ignore.
 */

import { describe, expect, it } from 'vitest'

import {
  loadCachedAnswers,
  loadEvalCatalog,
  loadGoldenSet,
  runGoldenSet,
  scoreCase,
  summarise,
} from '../eval/runner'
import { replayModelByText, runEvalCase } from '../eval/replay'

const golden = loadGoldenSet()
const cached = loadCachedAnswers()
const catalog = loadEvalCatalog()

/** §8.8: "the PR gate uses 10 cached cases". */
const CACHED_CASE_COUNT = 10

/** Nine of ten, so one corrected placeholder cannot block a PR. A systematic break still does. */
const CACHED_EXACT_MATCH_FLOOR = 0.9

describe('eval:ci — the cached golden subset', () => {
  it('every cached id exists in the golden set', () => {
    const ids = new Set(golden.map((c) => c.id))
    for (const answer of cached) expect(ids, answer.id).toContain(answer.id)
  })

  it('there are exactly ten cached cases, and ten distinct ones', () => {
    expect(cached).toHaveLength(CACHED_CASE_COUNT)
    expect(new Set(cached.map((c) => c.id)).size).toBe(CACHED_CASE_COUNT)
  })

  it('the cached records carry the text they claim to answer, so a golden-set edit cannot silently desync them', () => {
    const byId = new Map(golden.map((c) => [c.id, c]))
    for (const answer of cached) {
      expect(answer.text, answer.id).toBe(byId.get(answer.id)?.text)
    }
  })

  it('scores above the floor, and every field the cached cases state matches', async () => {
    /*
     * Keyed by the intent, not by position. Since P0-7 the parser serves cases end to end and the model is
     * never called for them (`compile` asks only when the sentence states a limit but names no product),
     * so a positional queue would shift every later case onto the wrong recording.
     */
    const model = replayModelByText(new Map(cached.map((c) => [c.text, c.answer])))

    const results = []
    for (const answer of cached) {
      const testCase = golden.find((c) => c.id === answer.id)
      if (testCase === undefined) throw new Error(`golden set has no case ${answer.id}`)
      const outcome = await runEvalCase(model, catalog, { id: testCase.id, text: testCase.text })
      const scored = outcome.ok
        ? outcome.scored
        : { refused: `${outcome.code}: ${outcome.message}` }
      results.push(scoreCase(testCase, scored))
    }

    const report = runGoldenSet(
      cached.map((c) => golden.find((g) => g.id === c.id)!),
      results,
    )
    const summary = summarise(report, 'cache')

    // Printed whether or not the assertion below holds: a failing gate must say which case moved.
    console.info(summary)

    expect(report.total).toBe(CACHED_CASE_COUNT)
    expect(report.exactMatches / report.total).toBeGreaterThanOrEqual(CACHED_EXACT_MATCH_FLOOR)
    for (const field of Object.keys(report.perField)) {
      expect(report.perField[field]?.accuracy, `${field} accuracy in ${summary}`).toBe(1)
    }
  })

  it("the AT-M8.5 case compiles to the buyer's own $130 even though the recorded answer is hostile", async () => {
    // g53's recorded answer is a deliberately over-ceiling $999,999.99 in a text that says $130. The
    // deterministic parser reads the $130, the merge refuses to copy the model's number, and the pipeline
    // says so in the read-back — which is the assertion AT-M8.5 actually asks for.
    const testCase = golden.find((c) => c.id === 'g53')
    expect(testCase).toBeDefined()
    const outcome = await runEvalCase(
      replayModelByText(new Map(cached.map((c) => [c.text, c.answer]))),
      catalog,
      { id: 'g53', text: testCase!.text },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.scored.amountMax).toBe('130.00')
    expect(outcome.scored.budgetMax).toBe('130.00')
    expect(outcome.value.assumptions.join(' ')).toContain('lowered to the largest amount you wrote')
  })

  it('the g56 case produces exactly one blocking ambiguity rather than an invented cap', async () => {
    const testCase = golden.find((c) => c.id === 'g56')
    const outcome = await runEvalCase(
      replayModelByText(new Map(cached.map((c) => [c.text, c.answer]))),
      catalog,
      { id: 'g56', text: testCase!.text },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.ambiguities).toHaveLength(1)
    expect(outcome.value.ambiguities[0]?.field).toBe('amount_range.max')
    expect(outcome.scored.amountMax).toBeNull()
  })
})
