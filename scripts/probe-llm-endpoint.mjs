/**
 * Probe the token-billed Modal endpoint with the proxy credentials from `.env.local`.
 *
 * Run: node scripts/probe-llm-endpoint.mjs
 *
 * Kept as a file rather than an inline `node -e`: PowerShell consumed the `$` in a regex on one
 * attempt and truncated the script on another, and both times Node reported a syntax error rather
 * than the thing being tested. A file cannot be mangled by the shell.
 *
 * Prints nothing secret — lengths and a three-character prefix only.
 */
import { readFileSync } from 'node:fs'

const env = readFileSync('.env.local', 'utf8')
const get = (key) => (env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '').trim()

const baseUrl = get('OPENAI_BASE_URL')
const model = get('LLM_MAIN_MODEL')
const key = get('MODAL_PROXY_TOKEN_ID')
const secret = get('MODAL_PROXY_TOKEN_SECRET')

console.log('base url  ', baseUrl || '(unset)')
console.log('model     ', model || '(unset)')
console.log('proxy key ', key ? `SET (${key.length} chars, ${key.slice(0, 3)}…)` : 'EMPTY')
console.log('proxy sec ', secret ? `SET (${secret.length} chars)` : 'EMPTY')
console.log('')

if (!key || !secret) {
  console.log('Cannot probe: MODAL_PROXY_TOKEN_ID / MODAL_PROXY_TOKEN_SECRET are not set.')
  console.log(
    'Create one at https://modal.com/settings/proxy-auth-tokens — see docs/LLM-ENDPOINT.md.',
  )
  process.exit(0)
}

const started = Date.now()
try {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Modal-Key': key, 'Modal-Secret': secret },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'user', content: 'Reply with exactly this JSON and nothing else: {"ok":true}' },
      ],
      max_tokens: 32,
    }),
    signal: AbortSignal.timeout(120_000),
  })

  const text = await response.text()
  console.log(`HTTP ${response.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`)

  if (!response.ok) {
    console.log(text.slice(0, 400))
    process.exit(1)
  }

  const body = JSON.parse(text)
  console.log('reply:', body.choices?.[0]?.message?.content?.trim())
  console.log('usage:', JSON.stringify(body.usage))
  console.log('')
  console.log(
    'The endpoint is reachable with proxy auth. Nothing else is blocking the LLM call site.',
  )
} catch (cause) {
  console.log(`FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s:`, String(cause))
  process.exit(1)
}
