/**
 * The **offline** compiler runner — no network, no model, no database.
 *
 * ## Why this exists
 *
 * `run.ts` scores the corpora by calling `POST /api/intent/compile` on a running app with a configured
 * model. That is the right shape for a live eval and the wrong shape for a gate: the judge panel's finding
 * (F8) was that the same sentence produced different answers across runs, and a test that needs a provider
 * cannot prove otherwise. Since P0-7 the compiler reads money, currency, cadence, merchants and dates with
 * deterministic code, so the corpus can be scored **in-process with no `llm` at all** — and then the same
 * run repeated twenty times is a real determinism check rather than a claim about temperature.
 *
 * ## The one thing it shares with the route
 *
 * The mapping from a `CompiledMandate` to the JSON body is the same shape the route returns
 * (`apps/web/lib/intent-response.ts`): `constraints` with `bigint`s converted by `toJsonSafe`, the
 * read-back, the assumptions and the ambiguities. The body is then handed to the **same**
 * `observeResponse` + `scoreCompilerCase` the live runner uses, so the two runners cannot disagree about
 * what a response means.
 *
 * An error is mapped the same way the route maps it (`HTTP_STATUS_BY_ERROR_CODE`, plus the two LLM codes),
 * so "refuse" in the offline run means the same class of thing it means live.
 */
import {
  csError,
  fixedClock,
  HTTP_STATUS_BY_ERROR_CODE,
  ok,
  type CsError,
  type Currency,
  type Result,
  type UserId,
} from '@countersign/core'
import {
  compile,
  readBack,
  toJsonSafe,
  type CatalogProjection,
  type CatalogReader,
  type CompiledMandate,
} from '@countersign/compiler'
import type { LanguageModel } from 'ai'

import { MERCHANT_NAMES, northwindCatalog } from './northwind.js'
import { observeResponse } from './observe.js'
import type { ObservedResponse } from './score.js'

/** The instant every offline run pins. 2026-09-21T22:13:20Z, matching the compiler's own tests. */
export const OFFLINE_NOW_SEC = 1_790_000_000

/** A buyer id for eval runs. Never leaves this process. */
export const OFFLINE_USER: UserId = 'usr_01HEVAL00000000000000000'

/** A reader over one projection. The eval catalog is a value, not a database. */
export function catalogReaderOf(projection: CatalogProjection): CatalogReader {
  return { read: async (): Promise<Result<CatalogProjection>> => ok(projection) }
}

export interface OfflineOptions {
  readonly nowEpochSec?: number
  readonly catalog?: CatalogProjection
  /** The default currency an unstated intent is compiled in. The corpus is mostly USD. */
  readonly currency?: Currency
  /**
   * A model, when a caller wants to exercise the gap-filling path deterministically (a recording). Omitted
   * for the corpus: the whole point of the offline run is that the deterministic reader is the compiler.
   */
  readonly llm?: LanguageModel
}

/** The status a `CsError` code deserves — the route's table, kept in step with it by a test. */
export function statusFor(code: string): number {
  const mapped = HTTP_STATUS_BY_ERROR_CODE[code as keyof typeof HTTP_STATUS_BY_ERROR_CODE]
  if (mapped !== undefined) return mapped
  if (code === 'LLM_UNAVAILABLE') return 503
  if (code === 'LLM_SCHEMA') return 502
  return 500
}

/** The wire body for a successful compile — the same fields `intentResponseBody` returns. */
export function bodyOfMandate(mandate: CompiledMandate): Record<string, unknown> {
  return {
    currency: mandate.currency,
    ttl_seconds: mandate.ttlSeconds,
    constraints: toJsonSafe(mandate.constraints) as readonly Record<string, unknown>[],
    read_back: readBack(mandate, { merchants: MERCHANT_NAMES, tz: 'Asia/Kolkata' }),
    assumptions: mandate.assumptions,
    ambiguities: toJsonSafe(mandate.ambiguities) as readonly Record<string, unknown>[],
  }
}

/** The wire body for a refusal — `{ error: CsErrorBody }`, as the route writes it. */
export function bodyOfError(error: CsError): Record<string, unknown> {
  return {
    error: {
      code: error.code,
      message: error.message,
      userMessage: error.userMessage,
      retryable: error.retryable,
    },
  }
}

/**
 * Compile one intent offline and read it the way the scorer reads a live response.
 *
 * Deterministic in `(intent, catalog, nowEpochSec)` and nothing else: no clock read, no network, no
 * provider. Running it twenty times is therefore a check on the *code*, not on a model's mood.
 */
export async function compileOffline(
  intent: string,
  options: OfflineOptions = {},
): Promise<ObservedResponse> {
  const catalog = options.catalog ?? northwindCatalog()
  const result = await compile(
    {
      userId: OFFLINE_USER,
      text: intent,
      locale: 'en-US',
      // No default store: every merchant a case asserts has to come from the sentence itself, so a corpus
      // case cannot pass because the harness quietly supplied one.
      defaults: { currency: options.currency ?? 'USD', merchantIds: [] },
    },
    {
      ...(options.llm === undefined ? {} : { llm: options.llm }),
      catalog: catalogReaderOf(catalog),
      clock: fixedClock(options.nowEpochSec ?? OFFLINE_NOW_SEC),
    },
  )

  if (!result.ok)
    return observeResponse(statusFor(result.error.code), JSON.stringify(bodyOfError(result.error)))
  return observeResponse(200, JSON.stringify(bodyOfMandate(result.value)))
}

/** `err` re-exported so a caller building a hand-made failure does not import core just for it. */
export const evalError = csError
