/**
 * Throwaway debug: run one turn and print every event in full.
 *
 * `pnpm tsx scripts/agent-debug.mts <mode> <sku> <capMinor> <message...>`
 */
import { readFileSync } from 'node:fs'

function envLocal(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    env[t.slice(0, eq).trim()] = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return { ...process.env, ...env } as Record<string, string>
}

const env = envLocal()
const BASE = env['COUNTERSIGN_ACCEPTANCE_BASE'] ?? 'http://127.0.0.1:3210'
const [mode = 'scripted', sku = 'NW-001', cap = '15000', ...rest] = process.argv.slice(2)
const message = rest.join(' ') || 'Buy the cheapest trail shoes you can find, under $150'

const sessionResponse = await fetch(`${BASE}/api/agent/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ intent: message, cap_minor: cap }),
})
const session = (await sessionResponse.json()) as Record<string, string>
console.log('session', session['mandate_id'], sessionResponse.status)

const response = await fetch(`${BASE}/api/agent/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    user_id: session['user_id'],
    mandate_id: session['mandate_id'],
    agent_id: session['agent_id'],
    message,
    mode,
    sku,
  }),
})
const text = await response.text()
for (const frame of text.split('\n\n')) {
  const line = frame.split('\n').find((entry) => entry.startsWith('data:'))
  if (line === undefined) continue
  const payload = line.slice(5).trim()
  if (payload === '' || payload === '{}') continue
  console.log(JSON.stringify(JSON.parse(payload), null, 1))
}
