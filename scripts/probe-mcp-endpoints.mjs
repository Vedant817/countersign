/**
 * Find the real PayPal MCP endpoint.
 *
 * `PAYPAL_MCP_URL` in `.env.local` is `https://mcp.sandbox.paypal.com/http`, and both a bare `GET` and a
 * JSON-RPC `POST` to it return **404 "Not Found"**. Rather than trust the configured value or guess from
 * memory, this probes the plausible paths and reports what each actually answers.
 *
 * The distinction that matters: a `404` means the path is wrong; a `401`/`403` means the path exists and
 * the credential is wrong; a `400` with an MCP-shaped error means the path exists and the *request* is
 * wrong. Only the first is fixed by changing the URL.
 *
 * ```sh
 * node scripts/probe-mcp-endpoints.mjs
 * ```
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
  /* environment-only is fine */
}

const basic = Buffer.from(
  `${env['PAYPAL_CLIENT_ID'] ?? ''}:${env['PAYPAL_CLIENT_SECRET'] ?? ''}`,
).toString('base64')
const tokenRes = await fetch(
  `${env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com'}/v1/oauth2/token`,
  {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  },
)
const token = (await tokenRes.json().catch(() => ({}))).access_token
if (!token) {
  console.log('no access token; cannot probe authenticated endpoints')
  process.exit(0)
}
console.log(`token acquired (${String(token).length} chars)\n`)

const HOSTS = ['https://mcp.sandbox.paypal.com', 'https://mcp.paypal.com']
const PATHS = ['/http', '/mcp', '/sse', '/', '/http/', '/v1/mcp', '/api/mcp']

const BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'countersign-probe', version: '0.1.0' },
  },
})

for (const host of HOSTS) {
  for (const path of PATHS) {
    const url = `${host}${path}`
    for (const [label, init] of [
      [
        'POST',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
          },
          body: BODY,
        },
      ],
      [
        'GET ',
        {
          method: 'GET',
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
          },
        },
      ],
    ]) {
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
        const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 110)
        const verdict =
          res.status === 404
            ? 'path wrong'
            : res.status === 401 || res.status === 403
              ? 'PATH EXISTS, auth wrong'
              : 'PATH EXISTS'
        console.log(
          `${String(res.status).padEnd(4)} ${label} ${url.padEnd(46)} ${verdict}  ${text}`,
        )
      } catch (error) {
        console.log(
          `ERR  ${label} ${url.padEnd(46)} ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}
