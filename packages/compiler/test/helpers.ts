/**
 * Test doubles for the compiler: a scripted `LanguageModel` and an in-memory `CatalogReader`.
 *
 * ### Why the language model is faked at the *model* level, not at the `compile` level
 *
 * `compile` takes a `LanguageModel`, not a "generator" port, so the tests drive the **real**
 * `generateText` + `Output.object` path: JSON is parsed and validated by the SDK, `NoObjectGeneratedError`
 * is raised and caught by our own code, and the retry turn is a genuine second call. Stubbing at a higher
 * seam would let EC-LLM-1 and EC-LLM-2 pass while the SDK contract was wrong.
 *
 * ### The scripted model is deliberately hostile by default
 *
 * `scriptedModel` answers from a queue, and every queue entry is what a *real* model might return:
 * malformed JSON, a float where a decimal string is required, an id from no catalogue, a number larger
 * than anything the buyer wrote. The compiler's refusals are what the tests assert, so a test double that
 * only ever behaves well would be asserting nothing.
 */

import { ok, err, csError, type Currency, type Result, type UserId } from '@countersign/core'
import type { LanguageModel } from 'ai'

import { loadEvalCatalog } from '../eval/runner'
import type { CatalogProjection, CatalogReader, CompileInput } from '../src/index'

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * One catalog for the whole package, loaded from `eval/catalog.json`.
 *
 * Not duplicated here on purpose. A second hand-maintained copy of the catalog is a second thing to forget
 * to update, and the failure is invisible: the unit tests would pass against items the eval has never seen,
 * so the score would be about different products than the tests. The committed file is the single source, and
 * `eval.golden.test.ts` asserts the identity rather than comparing two copies.
 */
export const STANDARD_CATALOG: CatalogProjection = loadEvalCatalog()

export const SKUS = STANDARD_CATALOG.skus

/** Northwind Outfitters, the store named throughout spec §8.8's examples. */
export function merchant(id: string): CatalogProjection['merchants'][number] {
  const found = STANDARD_CATALOG.merchants.find((m) => m.id === id)
  if (found === undefined) throw new Error(`no merchant ${id} in eval/catalog.json`)
  return found
}

export const NORTHWIND = merchant('mrc_northwind')

/** A second store, so "only at X" is a restriction rather than a no-op. */
export const CONTOSO = merchant('mrc_contoso')

/** A reader that always answers with `projection`. */
export function catalogOf(projection: CatalogProjection): CatalogReader {
  return { read: async (): Promise<Result<CatalogProjection>> => ok(projection) }
}

/** A reader that always fails, for the "catalog unavailable" path. */
export function failingCatalog(code: 'CS_NOT_FOUND' | 'CS_VALIDATION' = 'CS_NOT_FOUND'): CatalogReader {
  return {
    read: async (): Promise<Result<CatalogProjection>> =>
      err(csError(code, 'The store list did not load', {}, { retryable: true })),
  }
}

// ---------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------

/** What the scripted model should do on one turn. */
export type ModelTurn =
  /** Return this text as the model's message; the SDK will JSON-parse and schema-validate it. */
  | { readonly kind: 'text'; readonly text: string }
  /** Throw, the way an unreachable provider does. */
  | { readonly kind: 'throw'; readonly error: Error }

export interface ScriptedModel {
  readonly model: LanguageModel
  /** One entry per call made, in order. */
  readonly calls: Array<{ system: string; prompt: string }>
}

/**
 * The result type a `doGenerate` must return, derived from `LanguageModel` itself.
 *
 * `LanguageModel` from `ai` is a union (`'provider/model'` string, V4, V3, V2), so the property has to be
 * reached through the union's `doGenerate` signatures rather than indexed directly. Annotating the fake's
 * return with this makes every field contextually typed, so a provider SDK change (a new required field on
 * the result, a renamed finish reason) fails **here**, in one place, instead of surfacing as a confusing
 * mismatch inside `generateText`.
 */
type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type GenerateResult = Awaited<ReturnType<V4Model['doGenerate']>>

/**
 * A `LanguageModel` that answers from `turns` in order.
 *
 * The last turn repeats once the queue runs dry, so a test that expects exactly one repair retry does not
 * have to pad its script. `calls` records the full system and user prompt of every turn, which is how the
 * prompt tests assert on content rather than on a mock's invocation count.
 */
export function scriptedModel(turns: readonly ModelTurn[]): ScriptedModel {
  const calls: Array<{ system: string; prompt: string }> = []
  let index = 0
  const model: LanguageModel = {
    specificationVersion: 'v4',
    provider: 'scripted',
    modelId: 'scripted-model',
    supportedUrls: {},
    doGenerate: async (options): Promise<GenerateResult> => {
      calls.push({ system: systemTextOf(options), prompt: promptTextOf(options) })
      const turn = turns[Math.min(index, turns.length - 1)] ?? { kind: 'text' as const, text: '{}' }
      index += 1
      if (turn.kind === 'throw') throw turn.error
      return {
        content: [{ type: 'text', text: turn.text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }
    },
    doStream: () => {
      throw new Error('compile does not stream')
    },
  }
  return { model, calls }
}

/** A provider outage: what `generateText` sees when OpenAI is down. */
export function providerOutage(message = 'fetch failed: ECONNREFUSED'): Error {
  const error = Object.assign(new Error(message), { name: 'AI_APICallError', isRetryable: false })
  return error
}

/** A valid proposal for the common case: $130 total at Northwind. */
export function proposalJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    currency: 'USD',
    merchantIds: [NORTHWIND.id],
    amountMax: '130.00',
    preferences: {},
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Prompt extraction
// ---------------------------------------------------------------------------

function systemTextOf(options: { prompt: unknown }): string {
  return extractText(options.prompt)
}

function promptTextOf(options: { prompt: unknown }): string {
  return extractText(options.prompt)
}

/**
 * Flatten a `LanguageModelV4CallOptions.prompt` into text.
 *
 * The SDK's prompt is a typed array of messages, each with role and content parts, and a test that
 * greps it should not have to know that. Roles are labelled so an assertion can prove the buyer's words
 * arrived as a *user* message and the instructions as a *system* message.
 */
function extractText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return ''
  const out: string[] = []
  for (const message of prompt) {
    if (typeof message !== 'object' || message === null) continue
    const role = (message as { role?: unknown }).role
    const content = (message as { content?: unknown }).content
    const parts: string[] = []
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
          const value = (part as { text?: unknown }).text
          if (typeof value === 'string') parts.push(value)
        }
      }
    }
    if (parts.length > 0) out.push(`[${String(role)}] ${parts.join('\n')}`)
  }
  return out.join('\n\n')
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const TEST_USER: UserId = 'usr_01H0000000000000000000000'

/** A `CompileInput` with the usual defaults, overridable per test. */
export function compileInput(overrides: Partial<CompileInput> = {}): CompileInput {
  return {
    userId: TEST_USER,
    text: 'Under 130 dollars at Northwind',
    locale: 'en-US',
    defaults: { currency: 'USD' as Currency, merchantIds: [] },
    ...overrides,
  }
}
