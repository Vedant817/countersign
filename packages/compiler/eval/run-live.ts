/**
 * `eval:live` — the full sixty-case golden set against a real model. Spec **§8.8 AT-M8.1**.
 *
 * Gated on `OPENAI_API_KEY` (`docs/HUMAN_TODO.md` H-02). This is the only thing that measures the number
 * AT-M8.1 actually asks for — "≥ 95% exact match on amount, merchant and SKU fields with `gpt-6.1-sol`" —
 * and it is a nightly job, not a PR gate, for the reason §8.8 gives: "Run nightly; the PR gate uses 10
 * cached cases."
 *
 * ```
 * pnpm --filter @countersign/compiler eval:live
 * pnpm --filter @countersign/compiler eval:live -- --record   # rewrite eval/cached.jsonl
 * ```
 *
 * ### Why `--record` exists, and why it is not the default
 *
 * Recording replaces `eval/cached.jsonl` with what the model actually returned for the ten cached cases. That
 * makes the PR gate measure the pipeline against real output instead of hand-authored placeholders — the
 * single most valuable thing that can happen to this eval, and therefore something a person should do on
 * purpose rather than have a nightly job do silently. So it is opt-in.
 *
 * ### What it prints
 *
 * Per-field accuracy and the exact-match rate, plus every failing case with its text, its per-field verdicts
 * and what came back. A gate that reports one number tells you nothing about *which* limit moved, and the fix
 * for a wrong cap is never in the scorer.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parsePartialEnv } from '@countersign/core'
import { createOpenAI } from '@ai-sdk/openai'

import {
  TARGET_EXACT_MATCH,
  loadEvalCatalog,
  loadGoldenSet,
  runGoldenSet,
  scoreCase,
  summarise,
  type CachedAnswer,
  type CaseResult,
} from './runner'
import { readerOf, recordingModel, runEvalCase } from './replay'

/** The cases §8.8 names for the PR gate, and therefore the ones `--record` writes. */
const RECORDED_IDS: readonly string[] = ['g01', 'g02', 'g03', 'g06', 'g10', 'g16', 'g19', 'g51', 'g53', 'g56']

/** Parse and validate the environment in one call so a missing key reports every missing key at once. */
function requireOpenAi(): string {
  const { env, issues } = parsePartialEnv()
  if (issues.length > 0) {
    console.error('eval:live — the environment is not usable:')
    for (const issue of issues) console.error(`  ${issue.path}: ${issue.message}`)
    console.error(
      '\nThe cached CI subset (`pnpm --filter @countersign/compiler test`) needs no key and no network. ' +
        'See docs/HUMAN_TODO.md H-02.',
    )
    process.exit(1)
  }
  if (env.OPENAI_API_KEY === undefined) {
    console.error('eval:live — OPENAI_API_KEY is not set. See docs/HUMAN_TODO.md H-02.')
    process.exit(1)
  }
  return env.LLM_MAIN_MODEL ?? 'gpt-6.1-sol'
}

/** True when the operator asked to rewrite the cache. */
function wantsRecord(): boolean {
  return process.argv.includes('--record')
}

async function main(): Promise<void> {
  const modelId = requireOpenAi()
  const record = wantsRecord()

  const golden = loadGoldenSet()
  const catalog = loadEvalCatalog()
  const openai = createOpenAI({ apiKey: process.env['OPENAI_API_KEY'] })

  console.info(`eval:live — ${golden.length} cases against ${modelId}`)
  const results: CaseResult[] = []
  const recorded: CachedAnswer[] = []
  const refusals: string[] = []

  for (const testCase of golden) {
    // A fresh recorder per case: with one case's repair turns landing in another's recording, `--record`
    // would write answers attributed to the wrong case.
    const recorder = recordingModel(openai(modelId))
    const outcome = await runEvalCase(recorder.model, catalog, {
      id: testCase.id,
      text: testCase.text,
      currency: testCase.expect.currency,
    })
    const scored = outcome.ok ? outcome.scored : { refused: `${outcome.code}: ${outcome.message}` }
    results.push(scoreCase(testCase, scored))
    if (RECORDED_IDS.includes(testCase.id)) {
      const last = recorder.texts[recorder.texts.length - 1]
      if (last === undefined || !outcome.ok) {
        refusals.push(`${testCase.id}: ${outcome.ok ? 'no model output captured' : `${outcome.code}`}`)
      } else {
        recorded.push({ id: testCase.id, text: testCase.text, answer: last })
      }
    }
    process.stdout.write(outcome.ok ? '.' : 'x')
  }

  process.stdout.write('\n')
  const report = runGoldenSet(golden, results)
  console.info(summarise(report, `live ${modelId}`))

  if (record) {
    if (refusals.length > 0) {
      console.error('eval:live — --record needs every recorded case to have compiled:')
      for (const reason of refusals) console.error(`  ${reason}`)
      console.error(
        '\nRecording a refusal would make the cached gate assert a refusal, which is not what it is for. ' +
          'Fix the cases above first, then record.',
      )
      process.exit(1)
    }
    writeFileSync(fileURLToPath(new URL('cached.jsonl', import.meta.url)), renderCache(recorded), 'utf8')
    console.info(`eval:live — wrote ${recorded.length} recorded answers to eval/cached.jsonl`)
  }

  const rate = report.total === 0 ? 0 : report.exactMatches / report.total
  if (rate < TARGET_EXACT_MATCH) {
    console.error(
      `eval:live — ${(rate * 100).toFixed(1)}% is below the ${(TARGET_EXACT_MATCH * 100).toFixed(1)}% target ` +
        'in §8.8 AT-M8.1. The fix is in the prompt or in the golden set, never in the scorer.',
    )
    process.exit(1)
  }
  console.info(`eval:live — ${(rate * 100).toFixed(1)}% exact match, at or above the §8.8 AT-M8.1 target.`)
}

/**
 * Render `cached.jsonl` with a provenance header.
 *
 * The header is written by this function rather than preserved by hand, so `--record` cannot leave behind a
 * file that still claims to be hand-authored, or one that says nothing at all about where the numbers came
 * from. Provenance of an eval number is part of the number.
 */
function renderCache(entries: readonly CachedAnswer[]): string {
  const header = [
    '// RECORDED from a live `eval:live` run against LLM_MAIN_MODEL. These are real model outputs, replayed',
    '// through the real compile pipeline by `eval:ci` with no network. `eval/golden.jsonl` is the authority',
    '// on what each case tests; this file records only what the model answered.',
    '//',
    '// After recording, the cached gate measures the pipeline on real output. It still does not measure the',
    '// model: only `eval:live` over all 60 cases does that.',
  ].join('\n')
  return `${header}\n${entries.map((e) => JSON.stringify(e)).join('\n')}\n`
}

void main().catch((cause: unknown) => {
  console.error('eval:live failed:', cause instanceof Error ? cause.message : String(cause))
  process.exit(1)
})

// `readerOf` is exported from `replay.ts` for callers that already hold a projection; re-exported here so a
// future CLI subcommand does not reach into `src/` for it.
export { readerOf }
