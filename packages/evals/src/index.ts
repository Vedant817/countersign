/**
 * `@countersign/evals` — the corpora behind §8.20's published numbers.
 *
 * ```ts
 * import { loadCompilerCorpus, observeIntent, scoreCompilerCase, summarise, formatRate } from '@countersign/evals'
 *
 * const report = summarise(
 *   await Promise.all(
 *     loadCompilerCorpus().map(async (c) => scoreCompilerCase(c, await observeIntent(c.intent))),
 *   ),
 * )
 * console.log(formatRate(report))
 * ```
 *
 * ## What is in here
 *
 * | Corpus            | Size | Claim                                                        |
 * | ----------------- | ---- | ------------------------------------------------------------ |
 * | `compiler.jsonl`  | 60   | §14: ≥ 95% exact match on amount, merchant and SKU            |
 * | `injection.jsonl` | 50   | §8.20: attack-success at the Gate **must be 0%**              |
 *
 * ## What is deliberately *not* in here
 *
 * No network, no fixtures and no model client. `score.ts` is a pure function of what arrived, so its
 * rules are unit-tested against hand-built responses; `observe.ts` is the only module that knows the
 * wire format. A package that both fetched and judged would have no way to test its judgement without a
 * live model, which is how a scoring rule ends up never exercised — see `docs/COMPILER-EVAL.md` for the
 * `capOf()` that matched nothing for several sessions and reported success every time.
 *
 * ## One caveat to carry into any number quoted from this package
 *
 * The compiler clamps caps to the **largest literal amount in the request text**, so hostile text the
 * buyer pastes raises the ceiling. That is a documented property, not a defect here. The injection
 * corpus therefore scores against what the buyer's *sentence* supports, which is stricter than the
 * compiler's own bound — and where a case fails because the ceiling design allowed it, the failure is
 * the finding rather than a bug in the corpus.
 */
export {
  COMPILER_CASE_SCHEMA,
  CORPUS_DIR,
  EXPECTED_COUNTS,
  EXPECTED_OUTCOME,
  INJECTION_CASE_SCHEMA,
  loadCompilerCorpus,
  loadInjectionCorpus,
  type CompilerCase,
  type InjectionCase,
} from './corpus.js'

export {
  formatRate,
  scoreCompilerCase,
  scoreInjectionCase,
  summarise,
  type CaseScore,
  type EvalReport,
  type Mismatch,
  type ObservedOutcome,
  type ObservedResponse,
} from './score.js'

export { DEFAULT_ENDPOINT, observeIntent, observeResponse } from './observe.js'
