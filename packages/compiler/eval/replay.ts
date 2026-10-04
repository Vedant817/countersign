/**
 * The replay harness — one `LanguageModel` that answers from a script, and one function that runs cases
 * through the **real** `compile`.
 *
 * ### Why the replay goes through `generateText` and not around it
 *
 * The obvious shortcut is to call `localiseProposal` with a parsed proposal and skip the SDK. That would
 * make the CI eval prove nothing about the part most likely to break. Going through `compile` means the
 * cached run exercises the real `generateText`, the real `Output.object`, the real zod validation, the real
 * one-repair-retry path, and the real AT-M8.5 ceiling — the whole pipeline, minus the network.
 *
 * The alternative — stubbing `compile`'s model seam — is not available and should not be: `compile` takes a
 * `LanguageModel` precisely so that the SDK contract is exercised rather than assumed.
 */

import { fixedClock, type Result, type UserId } from '@countersign/core'
import type { LanguageModel } from 'ai'

import {
  compile,
  scoredFieldsOfMandate,
  type CatalogProjection,
  type CatalogReader,
  type CompiledMandate,
  type ScoredFields,
} from '../src/index'

/**
 * A fixed instant for every eval run.
 *
 * Two reasons it is pinned rather than taken from the wall clock: a golden set that depended on today's date
 * would start failing when a recurrence window slid past it, and the score would change with no code change.
 * 2026-09-22T13:33:20Z — comfortably after the golden set's own dates start.
 */
export const EVAL_NOW_SEC = 1_790_000_000

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type GenerateResult = Awaited<ReturnType<V4Model['doGenerate']>>

/**
 * A `LanguageModel` that answers from `answers`, in order, by case id.
 *
 * An id with no answer is an **error**, not a skip: a missing recording would otherwise show up as an
 * unexplained drop in the denominator and the score would quietly improve.
 */
export function replayModel(
  answers: ReadonlyMap<string, string>,
  order: readonly string[],
): LanguageModel {
  const remaining = new Map(answers)
  let cursor = 0
  return {
    specificationVersion: 'v4',
    provider: 'replay',
    modelId: 'recorded-answers',
    supportedUrls: {},
    doGenerate: async (): Promise<GenerateResult> => {
      const id = order[cursor]
      cursor += 1
      const text = id === undefined ? undefined : remaining.get(id)
      if (text === undefined) throw new Error(`no recorded answer for case ${id ?? '(none)'}`)
      return replyOf(text)
    },
    doStream: () => {
      throw new Error('the compiler never streams')
    },
  }
}

/**
 * Wrap a real model so every text it produced is kept.
 *
 * `eval:live --record` needs the **raw** output, not the parsed proposal: the whole point of recording is
 * that the cached run replays the exact bytes through the SDK's own parse and validate steps. A wrapper that
 * captured the parsed object would record something the model never said, and the first replay would pass
 * for the wrong reason.
 *
 * Note the last turn wins per case, and that is intentional: `compile` may make two calls for one case (the
 * EC-LLM-2 repair), and the recording must hold the answer the *scoring* used.
 */
export function recordingModel(inner: LanguageModel): { model: LanguageModel; texts: string[] } {
  // `LanguageModel` from `ai` is a union that also admits a `'provider/model'` string, so the wrapper has to
  // go through the V4 member. `createOpenAI(...)(id)` returns that member, and a string would fail here
  // rather than silently recording nothing.
  const source = inner as V4Model
  const texts: string[] = []
  const wrapped: LanguageModel = {
    specificationVersion: 'v4',
    provider: source.provider,
    modelId: source.modelId,
    supportedUrls: source.supportedUrls,
    doGenerate: async (options): Promise<GenerateResult> => {
      const result = await source.doGenerate(options)
      for (const part of result.content) {
        if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      }
      return result
    },
    doStream: source.doStream.bind(source),
  }
  return { model: wrapped, texts }
}

/** A well-formed `LanguageModelV4GenerateResult` carrying one text part. */
function replyOf(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }
}

/** A reader over one projection. The eval catalog is a committed file, not a database. */
export function readerOf(projection: CatalogProjection): CatalogReader {
  return { read: async (): Promise<Result<CatalogProjection>> => ({ ok: true, value: projection }) }
}

/** The buyer id the eval compiles on behalf of. Never leaves this process. */
export const EVAL_USER: UserId = 'usr_01HEVAL00000000000000000'

export interface RunCaseArgs {
  readonly id: string
  readonly text: string
  /** The account defaults the case is compiled under. */
  readonly currency?: 'USD' | 'INR' | 'GBP' | 'EUR'
  readonly merchantIds?: string[]
}

/** Compile one eval case and project it onto the scored fields. */
export async function runEvalCase(
  model: LanguageModel,
  catalog: CatalogProjection,
  args: RunCaseArgs,
): Promise<
  | { ok: true; value: CompiledMandate; scored: ScoredFields }
  | { ok: false; code: string; message: string }
> {
  const result = await compile(
    {
      userId: EVAL_USER,
      text: args.text,
      locale: 'en-US',
      defaults: { currency: args.currency ?? 'USD', merchantIds: args.merchantIds ?? [] },
    },
    { llm: model, catalog: readerOf(catalog), clock: fixedClock(EVAL_NOW_SEC) },
  )
  if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message }
  return { ok: true, value: result.value, scored: scoredFieldsOfMandate(result.value) }
}
