/**
 * Find the auth form the PayPal MCP server actually accepts.
 *
 * ## What the docs say, and what is ambiguous about it
 *
 * The quickstart shows `--header "Authorization: Bearer <auth_header>"` and says it works "using your
 * PayPal client credentials … your client ID and secret". `<auth_header>` is never defined, and the two
 * plausible readings are very different:
 *
 *  1. `Bearer <base64(client_id:secret)>` — PayPal's REST Basic credentials, wearing a Bearer label
 *  2. `Bearer <oauth_access_token>`       — what `POST /v1/oauth2/token` returns
 *
 * Reading 2 is what this repository already does, and it produced `401 invalid_token` against `POST /sse`.
 * Reading 1 is untested. Rather than guess, this tries every form against `/sse` and reports the status
 * and the `www-authenticate` challenge for each, so the answer is measured.
 *
 * A `406` or a hanging connection is success in disguise: SSE wants `Accept: text/event-stream` and an
 * open stream, so a 401 becoming anything else means the credential was accepted.
 *
 * ```sh
 * node scripts/probe-mcp-auth.mjs
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
  /* env-only is fine */
}

const ID = env['PAYPAL_CLIENT_ID'] ?? ''
const SECRET = env['PAYPAL_CLIENT_SECRET'] ?? ''
const API_BASE = env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com'
const URL = env['PAYPAL_MCP_URL'] ?? 'https://mcp.sandbox.paypal.com/sse'

/** The OAuth access token, which is what the repository already mints. */
const basic = Buffer.from(`${ID}:${SECRET}`).toString('base64')
const tokenRes = await fetch(`${API_BASE}/v1/oauth2/token`, {
  method: 'POST',
  headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
})
const oauthToken = (await tokenRes.json().catch(() => ({}))).access_token ?? ''

console.log(`url          : ${URL}`)
console.log(`oauth token  : ${oauthToken ? `${oauthToken.length} chars` : 'NOT ACQUIRED'}`)
console.log(`basic header : ${basic.length} chars\n`)

const FORMS = [
  ['no auth', {}],
  ['Bearer oauth token', { authorization: `Bearer ${oauthToken}` }],
  ['Bearer base64(id:secret)', { authorization: `Bearer ${basic}` }],
  ['Basic base64(id:secret)', { authorization: `Basic ${basic}` }],
  ['Api-Key = client id', { 'api-key': ID }],
  ['Authorization = client id', { authorization: ID }],
]

for (const [label, headers] of FORMS) {
  for (const accept of ['application/json', 'text/event-stream']) {
    try {
      const res = await fetch(URL, {
        method: 'GET',
        headers: { ...headers, accept },
        signal: AbortSignal.timeout(12_000),
      })
      const challenge = res.headers.get('www-authenticate') ?? ''
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 90)
      const verdict =
        res.status === 401 || res.status === 403
          ? 'rejected'
          : res.status === 406
            ? 'ACCEPTED (needs SSE accept)'
            : res.status === 200
              ? 'ACCEPTED'
              : `other (${res.status})`
      const extra =
        (challenge ? `\n       ${challenge.slice(0, 170)}` : '') +
        (res.status === 401 && text ? `\n       ${text}` : '')
      console.log(
        `${String(res.status).padEnd(4)} ${label.padEnd(28)} accept=${accept.padEnd(18)} ${verdict}${extra}`,
      )
    } catch (error) {
      // A timeout on an SSE endpoint usually means the stream opened and stayed open.
      const name = error instanceof Error ? error.name : String(error)
      console.log(
        `${'TO'.padEnd(4)} ${label.padEnd(28)} accept=${accept.padEnd(18)} ${name === 'TimeoutError' ? 'STREAM OPENED (no 401)' : name}`,
      )
    }
  }
}
