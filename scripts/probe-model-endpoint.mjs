/**
 * What does the configured model endpoint actually answer?
 *
 * `/status` probes `GET {OPENAI_BASE_URL}/models` with a `Bearer` and reports the provider as `down`
 * when it is refused. This asks the endpoint directly, with the headers the app really uses, so the
 * probe can be written against observed behaviour instead of an assumption about what an
 * OpenAI-compatible endpoint serves.
 *
 * ```sh
 * node scripts/probe-model-endpoint.mjs
 * ```
 *
 * Reads `.env.local`. Prints status codes and short bodies — never a credential.
 */
import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  env[trimmed.slice(0, eq).trim()] = trimmed
    .slice(eq + 1)
    .trim()
    .replace(/^["']|["']$/g, '')
}

const base = (env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
const isModal = new URL(base).hostname.endsWith('.modal.direct')

/** The same resolution `apps/web/lib/llm.ts` performs, repeated here on purpose so a drift is visible. */
const headers = isModal
  ? {
      'Modal-Key': (env['MODAL_PROXY_TOKEN_ID'] ?? '').trim(),
      'Modal-Secret': (env['MODAL_PROXY_TOKEN_SECRET'] ?? '').trim(),
      'content-type': 'application/json',
    }
  : { authorization: `Bearer ${env['OPENAI_API_KEY'] ?? ''}`, 'content-type': 'application/json' }

console.log(`base:  ${base}`)
console.log(`modal: ${isModal}`)
console.log(`auth:  ${isModal ? 'Modal-Key/Modal-Secret' : 'Authorization: Bearer'}\n`)

/** One request, reported as status + the first line of the body. */
async function check(label, path, init = {}) {
  const started = Date.now()
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    console.log(`${label.padEnd(22)} ${res.status}  ${Date.now() - started}ms`)
    console.log(`  ${text.replace(/\s+/g, ' ').slice(0, 260) || '(empty)'}`)
    return res.status
  } catch (error) {
    console.log(`${label.padEnd(22)} THREW ${error.name}: ${error.message}`)
    return null
  }
}

await check('GET /models', '/models')
await check('POST /chat/completions', '/chat/completions', {
  method: 'POST',
  body: JSON.stringify({
    model: env['LLM_CHEAP_MODEL'] ?? 'test',
    messages: [{ role: 'user', content: 'reply with the single word ok' }],
    max_tokens: 5,
  }),
})

console.log(
  '\nIf /models is refused but /chat/completions succeeds, the probe is testing a route the provider\n' +
    'does not serve — and reporting a working app as down.',
)
