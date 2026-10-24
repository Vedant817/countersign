import { describe, expect, it } from 'vitest'
import { generateText } from 'ai'

import { isModalDirectUrl, languageModel, missingLlmConfig, readLlmConfig } from './llm'

/**
 * The model adapter — and the first place in this repository that calls a model at all.
 *
 * Two kinds of case, deliberately separated:
 *
 *  - **Configuration**, which needs no network and must never be skipped. The refusals are the part
 *    that matters: a `.direct` host with no proxy token produces a `404 modal-http: invalid function
 *    call` that reads like a wrong URL, so the adapter has to catch it before a request is made.
 *  - **A live call**, gated on credentials. It proves the whole chain — env → adapter → AI SDK →
 *    provider — rather than the pieces, and it is the assertion that would have caught the four
 *    wrong Modal URLs and the shadowed interpreter before they cost an afternoon.
 */
describe('the model adapter refuses rather than half-configuring', () => {
  it('names every missing variable', () => {
    expect(missingLlmConfig({})).toEqual(['OPENAI_API_KEY', 'OPENAI_BASE_URL'])
  })

  it('demands the proxy pair for a Modal .direct host', () => {
    const env = {
      OPENAI_API_KEY: 'modal',
      OPENAI_BASE_URL: 'https://ws--ep-server.us-west.modal.direct/v1',
    }
    // Without these the request is a 404 that looks like a bad URL, which is the failure this exists
    // to make legible.
    expect(missingLlmConfig(env)).toEqual(['MODAL_PROXY_TOKEN_ID', 'MODAL_PROXY_TOKEN_SECRET'])
    expect(
      missingLlmConfig({ ...env, MODAL_PROXY_TOKEN_ID: 'wk-x', MODAL_PROXY_TOKEN_SECRET: 'ws-y' }),
    ).toEqual([])
  })

  it('does not demand proxy headers for an ordinary OpenAI-compatible provider', () => {
    const env = {
      OPENAI_API_KEY: 'gsk_x',
      OPENAI_BASE_URL: 'https://api.groq.com/openai/v1',
    }
    expect(missingLlmConfig(env)).toEqual([])
    const config = readLlmConfig(env)
    if (!config.ok) throw new Error('expected a config')
    expect(config.value.headers).toEqual({})
  })

  it('attaches the Modal headers rather than a Bearer when the host is .direct', () => {
    const result = readLlmConfig({
      OPENAI_API_KEY: 'unused',
      OPENAI_BASE_URL: 'https://ws--ep-server.us-west.modal.direct/v1/',
      MODAL_PROXY_TOKEN_ID: 'wk-abc',
      MODAL_PROXY_TOKEN_SECRET: 'ws-def',
    })
    if (!result.ok) throw new Error('expected a config')
    expect(result.value.headers).toEqual({ 'Modal-Key': 'wk-abc', 'Modal-Secret': 'ws-def' })
    // The trailing slash is stripped, because `${base}/chat/completions` with two slashes 404s.
    expect(result.value.baseUrl).toBe('https://ws--ep-server.us-west.modal.direct/v1')
  })

  it('recognises a Modal host, and a malformed URL is not one', () => {
    expect(isModalDirectUrl('https://x--y.us-west.modal.direct/v1')).toBe(true)
    expect(isModalDirectUrl('https://api.openai.com/v1')).toBe(false)
    expect(isModalDirectUrl('not a url')).toBe(false)
  })

  it('returns LLM_UNAVAILABLE, whose registry copy already names the manual fallback', () => {
    const result = languageModel({})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('LLM_UNAVAILABLE')
  })
})

/**
 * Live. Skipped without credentials so the suite stays green on a clean checkout — the same rule the
 * database tests follow.
 */
const env = readLlmConfig()
const live = env.ok

describe.skipIf(!live)('the configured endpoint actually answers', () => {
  it('completes a prompt and reports token usage', async () => {
    const model = languageModel()
    if (!model.ok) throw new Error(model.error.message)

    const result = await generateText({
      model: model.value,
      prompt: 'Reply with exactly the word: ok',
      temperature: 0,
    })

    expect(result.text.trim().toLowerCase()).toContain('ok')
    // Non-zero usage is the proof the call was served rather than answered from a cache or a stub.
    expect(result.usage?.totalTokens ?? 0).toBeGreaterThan(0)
  }, 120_000)
})
