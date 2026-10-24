/**
 * Drive the PayPal MCP server over its SSE transport, using the sandbox client credentials we already have.
 *
 * ## What was wrong before
 *
 * Two earlier probes concluded the server was unusable. Both were wrong, and both were wrong the same way —
 * testing a different request than the one the protocol uses:
 *
 * 1. `POST /http` → 404. The streamable-HTTP path is what the docs show first, and it is not what answers.
 * 2. `POST /sse`  → 401 `invalid_token`. **SSE is a `GET`.** A POST to an SSE endpoint is not an
 *    authenticated request, it is a malformed one, and the server answers 401 either way — so a rejected
 *    method and a rejected credential look identical from outside.
 *
 * `GET /sse` with `Authorization: Bearer <oauth_token>` returns **200** and opens a stream. That is the
 * whole difference, and it means the hosted MCP server *is* drivable headlessly with the client
 * credentials this repository already mints — no interactive login, contrary to what the quickstart's
 * "the MCP client sends you to the PayPal login page" suggests for the OAuth flow.
 *
 * ## Why it matters
 *
 * The judge panel recorded "dispute scopes are not granted (H-09)" as blocking the Defender work. The
 * server's catalogue includes `list_disputes` and `get_dispute`, so if those answer, reading a dispute is
 * available today and the blocked item shrinks to *filing* evidence.
 *
 * ```sh
 * node scripts/paypal-mcp.mjs                      # list tools
 * node scripts/paypal-mcp.mjs list_disputes        # call one
 * node scripts/paypal-mcp.mjs get_dispute '{"dispute_id":"PP-D-..."}'
 * ```
 *
 * Never prints a credential.
 */
import { readFileSync } from 'node:fs'

const env = { ...process.env }
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const k = t.slice(0, eq).trim()
    if (env[k] === undefined)
      env[k] = t
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
  }
} catch {
  /* env-only is fine */
}

const API_BASE = env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com'
const SSE_URL = env['PAYPAL_MCP_URL'] ?? 'https://mcp.sandbox.paypal.com/sse'

// ── token ────────────────────────────────────────────────────────────────────────────────────────
const basic = Buffer.from(
  `${env['PAYPAL_CLIENT_ID'] ?? ''}:${env['PAYPAL_CLIENT_SECRET'] ?? ''}`,
).toString('base64')
const tokenRes = await fetch(`${API_BASE}/v1/oauth2/token`, {
  method: 'POST',
  headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
})
const accessToken = (await tokenRes.json().catch(() => ({}))).access_token
if (!accessToken) {
  console.error('could not obtain an access token; see docs/HUMAN_TODO.md item 2')
  process.exit(1)
}

// ── open the SSE stream and wait for the endpoint event ──────────────────────────────────────────
const controller = new AbortController()
const streamRes = await fetch(SSE_URL, {
  method: 'GET',
  headers: { authorization: `Bearer ${accessToken}`, accept: 'text/event-stream' },
  signal: controller.signal,
})
if (!streamRes.ok) {
  console.error(`SSE GET ${SSE_URL} -> ${streamRes.status} ${streamRes.statusText}`)
  console.error(await streamRes.text().catch(() => ''))
  process.exit(1)
}

/** SSE frames, parsed as they arrive. `event:` names a frame, `data:` carries its payload. */
const pending = new Map()
let sessionEndpoint = null

async function pump() {
  const reader = streamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (line === '') {
        event = 'message'
        continue
      }
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
        continue
      }
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (event === 'endpoint') {
        // Relative to the SSE origin, per the HTTP+SSE transport.
        sessionEndpoint = new URL(payload, SSE_URL).toString()
        continue
      }
      try {
        const msg = JSON.parse(payload)
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        }
      } catch {
        /* a non-JSON frame is not a reply to anything we sent */
      }
    }
  }
}

const pumpDone = pump()

for (let i = 0; i < 100 && sessionEndpoint === null; i += 1) {
  await new Promise((r) => setTimeout(r, 100))
}
if (sessionEndpoint === null) {
  console.error('the stream opened but never sent an `endpoint` frame')
  controller.abort()
  process.exit(1)
}
console.log(`session endpoint: ${sessionEndpoint}\n`)

// ── JSON-RPC over the session endpoint ───────────────────────────────────────────────────────────
let nextId = 1
async function rpc(method, params) {
  const id = nextId++
  const reply = new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`))
    }, 60_000)
  })
  const res = await fetch(sessionEndpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  })
  if (!res.ok)
    throw new Error(`${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return reply
}

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'countersign', version: '0.1.0' },
})
await fetch(sessionEndpoint, {
  method: 'POST',
  headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
}).catch(() => {})

const [toolName, rawArgs] = process.argv.slice(2)

if (!toolName) {
  const list = await rpc('tools/list', {})
  const names = (list.result?.tools ?? []).map((t) => t.name).sort()
  console.log(`connected. ${names.length} tool(s):\n`)
  for (const n of names) console.log(`  ${n}`)
} else {
  /*
   * Arguments come from a file when given as `@path`.
   *
   * Not a convenience: PowerShell strips the double quotes out of a JSON argument passed to a native
   * command, so `'{"intent":"CAPTURE"}'` arrives as `{intent:CAPTURE}` and fails to parse. That is the
   * third time this session a shell has silently rewritten a payload, so the file path is the supported
   * form and the inline one is the shortcut.
   */
  const args = rawArgs?.startsWith('@')
    ? JSON.parse(readFileSync(rawArgs.slice(1), 'utf8'))
    : rawArgs
      ? JSON.parse(rawArgs)
      : {}
  console.log(`calling ${toolName} with ${JSON.stringify(args)}\n`)
  const out = await rpc('tools/call', { name: toolName, arguments: args })
  const text =
    out.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(out.result)
  console.log(out.result?.isError ? `REFUSED:\n${text}` : text.slice(0, 2500))
}

controller.abort()
await pumpDone.catch(() => {})
process.exit(0)
