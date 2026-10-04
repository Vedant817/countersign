/**
 * The live golden-set run — spec **§8.8 AT-M8.1**, gated on `OPENAI_API_KEY`.
 *
 * Same scoring code, same catalog, same sixty cases as `eval:live`; this file exists so the nightly CI job can
 * run it as a test (with JUnit output and a proper failure) rather than as a CLI it has to parse.
 *
 * ## Why the filename is `*.contract.ts` and not `*.test.ts`
 *
 * **That is the mechanism, and it is not cosmetic.** Three things have to stop a sixty-case run against a paid
 * model from happening in the default suite, and the root `vitest.workspace.ts` defeats one of them:
 *
 * 1. **The filename.** `vitest.config.base.ts` includes only `test/**` and `src/**`, so a file under `eval/`
 *    cannot match it. This is the same trick `packages/vi-client` uses for `contract/at-m4.contract.ts`.
 * 2. **`exclude` in `packages/compiler/vitest.config.ts`** lists the whole `eval` directory. This was tried
 *    first and **does not work at the root**: the workspace run does its own file discovery with its own
 *    defaults, which match any `*.test.ts`, rather than each project's `include`/`exclude`. A file named
 *    `golden.eval.live.test.ts` *was* collected by `pnpm test` at the root even with the exclude in place —
 *    measured, not assumed. So the exclude stays as a second guard, and the filename is the one that holds.
 * 3. **`describe.skipIf`.** Even with the file undiscoverable, the suite refuses to run without a key, so a
 *    future rename that re-exposes it still cannot spend money.
 *
 * The order matters when reading the failures: if this file ever appears in a default run, the bug is (1), and
 * (3) is what stopped it costing anything.
 *
 * Run it with `pnpm --filter @countersign/compiler test:eval:live` (see `vitest.eval.config.ts`), or use the
 * CLI with `eval:live`, which is what a human reading the output will want.
 */

import { describe, expect, it } from 'vitest'

import { parsePartialEnv } from '@countersign/core'
import { createOpenAI } from '@ai-sdk/openai'

import {
  TARGET_EXACT_MATCH,
  loadCachedAnswers,
  loadEvalCatalog,
  loadGoldenSet,
  runGoldenSet,
  scoreCase,
  summarise,
} from './runner'
import { recordingModel, runEvalCase } from './replay'

const { env } = parsePartialEnv()
const hasKey = env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY.length > 0
const MODEL = env.LLM_MAIN_MODEL ?? 'gpt-6.1-sol'

describe.skipIf(!hasKey)('AT-M8.1 the live golden set', () => {
  const golden = loadGoldenSet()
  const catalog = loadEvalCatalog()

  it(
    `scores at or above ${(TARGET_EXACT_MATCH * 100).toFixed(0)}% exact match on amount, merchant and SKU`,
    async () => {
      const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY })
      const results = []
      for (const testCase of golden) {
        const recorder = recordingModel(openai(MODEL))
        const outcome = await runEvalCase(recorder.model, catalog, {
          id: testCase.id,
          text: testCase.text,
          currency: testCase.expect.currency,
        })
        const scored = outcome.ok
          ? outcome.scored
          : { refused: `${outcome.code}: ${outcome.message}` }
        results.push(scoreCase(testCase, scored))
      }
      const report = runGoldenSet(golden, results)
      // Printed even on success: §14 records this number, and a number nobody can read is not recorded.
      console.info(summarise(report, `live ${MODEL}`))
      expect(report.exactMatches / report.total).toBeGreaterThanOrEqual(TARGET_EXACT_MATCH)
    },
    15 * 60_000,
  )
})

describe('the live suite without a key', () => {
  it('skips rather than fails, so `pnpm test` stays green on a machine with no OpenAI credentials', () => {
    // The suite above is `skipIf(!hasKey)`; this asserts the *condition* so a typo in the gate cannot silently
    // make the live suite either always-skip or always-run.
    expect(typeof hasKey).toBe('boolean')
    expect(hasKey).toBe(env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY.length > 0)
  })

  it('the cached subset is the one that runs without a key, and it has ten cases', () => {
    // The CI gate's whole job: ten recorded answers, no key. If this ever changes, `eval:ci`'s floor and
    // AT-M8.1's "the PR gate uses 10 cached cases" both need re-reading.
    expect(loadCachedAnswers()).toHaveLength(10)
    expect(loadEvalCatalog().skus.length).toBeGreaterThan(0)
  })
})
