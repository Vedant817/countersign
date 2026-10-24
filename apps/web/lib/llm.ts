import 'server-only'

import { createOpenAI } from '@ai-sdk/openai'
import { csError, type CsError, type Result } from '@countersign/core'
import type { LanguageModel } from 'ai'

/**
 * The model provider — the adapter `packages/compiler` has always needed and never had.
 *
 * `compile(i, { llm, catalog, clock })` takes a `LanguageModel` and resolves nothing itself, with the
 * stated reason that "the model in use is a configuration fact rather than a constant buried here".
 * That was the right call, and it left exactly one gap: somewhere had to turn configuration into a
 * `LanguageModel`. This is that place.
 *
 * ## Why the shape is provider-agnostic
 *
 * `OPENAI_BASE_URL` (added for this) means the same code drives OpenAI, Groq, OpenRouter, Google AI
 * Studio, Together, Cerebras, a local Ollama, or a Modal Endpoint. Nothing here is OpenAI-specific
 * except the protocol.
 *
 * ## Modal Endpoints need headers, not a Bearer
 *
 * A Modal `.direct` endpoint reports `requires_proxy_auth: true` and wants `Modal-Key` /
 * `Modal-Secret`. The OpenAI client sends `Authorization: Bearer`, which that endpoint answers with
 * `404 modal-http: invalid function call` — an error that reads like a wrong URL and is actually a
 * missing header. When the base URL is a `.direct` host the proxy credentials are attached, and their
 * absence is a refusal here rather than a confusing 404 at inference time.
 *
 * ## What it refuses
 *
 * No API key, or a `.direct` URL with no proxy token, returns a `CsError` rather than a model that
 * fails on first use. Every caller in this project already treats a missing model as a supported
 * state — EC-LLM-1 says the fallback is the manual constraint form, and `§8.0` rule 4 says the
 * deterministic paths are the product — so the failure mode must be a sentence, not a crash.
 */
export interface LlmConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly mainModel: string
  readonly cheapModel: string
  /** Sent as-is on every request. Empty for a normal OpenAI-compatible provider. */
  readonly headers: Readonly<Record<string, string>>
}

export const REQUIRED_LLM_ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const

/** `true` for a Modal private endpoint, which authenticates with headers rather than a Bearer. */
export function isModalDirectUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith('.modal.direct')
  } catch {
    return false
  }
}

export function missingLlmConfig(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const missing: string[] = REQUIRED_LLM_ENV.filter((name) => (env[name] ?? '').trim() === '')
  // A `.direct` host needs its proxy pair; without them every call is a 404 that reads like a bad URL.
  const base = (env['OPENAI_BASE_URL'] ?? '').trim()
  if (base !== '' && isModalDirectUrl(base)) {
    for (const name of ['MODAL_PROXY_TOKEN_ID', 'MODAL_PROXY_TOKEN_SECRET'] as const) {
      if ((env[name] ?? '').trim() === '') missing.push(name)
    }
  }
  return missing
}

export function readLlmConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<LlmConfig, CsError> {
  const missing = missingLlmConfig(env)
  if (missing.length > 0) {
    return {
      ok: false,
      error: csError(
        'LLM_UNAVAILABLE',
        `The model provider is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset`,
        { missing: [...missing] },
        {
          // Registry copy for LLM_UNAVAILABLE is already the right sentence for a buyer, and EC-LLM-1
          // names the manual form as the fallback. Overriding it here would invent a second answer.
          retryable: false,
        },
      ),
    }
  }

  const baseUrl = (env['OPENAI_BASE_URL'] ?? '').trim().replace(/\/+$/, '')
  const headers: Record<string, string> = {}
  if (isModalDirectUrl(baseUrl)) {
    headers['Modal-Key'] = (env['MODAL_PROXY_TOKEN_ID'] ?? '').trim()
    headers['Modal-Secret'] = (env['MODAL_PROXY_TOKEN_SECRET'] ?? '').trim()
  }

  return {
    ok: true,
    value: {
      baseUrl,
      apiKey: (env['OPENAI_API_KEY'] ?? '').trim(),
      mainModel: (env['LLM_MAIN_MODEL'] ?? '').trim() || 'gpt-4o-mini',
      cheapModel: (env['LLM_CHEAP_MODEL'] ?? '').trim() || 'gpt-4o-mini',
      headers,
    },
  }
}

/** The main model, or an error naming what is missing. */
export function languageModel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<LanguageModel, CsError> {
  const config = readLlmConfig(env)
  if (!config.ok) return config

  const provider = createOpenAI({
    baseURL: config.value.baseUrl,
    apiKey: config.value.apiKey,
    headers: config.value.headers,
  })

  return { ok: true, value: provider(config.value.mainModel) }
}

/** The cheap model, for classifiers and bulk evals. Same provider, different weights. */
export function cheapLanguageModel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<LanguageModel, CsError> {
  const config = readLlmConfig(env)
  if (!config.ok) return config

  const provider = createOpenAI({
    baseURL: config.value.baseUrl,
    apiKey: config.value.apiKey,
    headers: config.value.headers,
  })

  return { ok: true, value: provider(config.value.cheapModel) }
}
