/**
 * The same-origin guard for a state-changing `POST` — S-17.
 *
 * ## Why this exists beside `sameSite: 'lax'`
 *
 * The session cookie is already `sameSite: 'lax'`, so a cross-site form post does not carry it. That is
 * the first line of defence, and it is not the whole of it: `lax` is a browser policy (older browsers,
 * and any future relaxation, weaken it) and it says nothing about a **same-site** attacker on a sibling
 * subdomain. A request that carries a session and a `POST` body that moves money should also prove that
 * the page it came from is served by this deployment.
 *
 * ## Why a missing `Origin` is allowed, and a wrong one is not
 *
 * Browsers send `Origin` on every cross-origin `POST`, and on a same-origin `POST` too, so the request
 * this guard exists to stop always carries one. A non-browser client (`curl`, an acceptance script, a
 * test) has no `Origin` at all, and refusing it would break the one surface that is easiest to verify by
 * hand. The asymmetry is safe: an attacker cannot make a browser omit the header, and cannot forge it to
 * a value this deployment would accept.
 */
import { csError, type CsError } from '@countersign/core'

/** The public origin this request is served from, derived the way the rest of the app derives it. */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url)
  const forwardedHost = request.headers.get('x-forwarded-host')
  const host = forwardedHost ?? request.headers.get('host') ?? url.host
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const proto = forwardedProto ?? (isLoopbackHost(host) ? 'http' : 'https')
  return `${proto}://${host}`
}

function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '[::1]'
}

/**
 * `null` when the request may proceed, or the `CsError` that refuses it.
 *
 * The comparison is exact, including the port: `https://example.test` is not the same deployment as
 * `https://example.test:8443`, and a guard that normalised the port away would let a sibling service on
 * another port act as this one.
 */
export function requireSameOrigin(request: Request): CsError | null {
  const origin = request.headers.get('origin')
  // No `Origin` at all: a non-browser client. See the file header for why this is allowed.
  if (origin === null) return null
  // `Origin: null` is what a sandboxed iframe or a `file://` page sends. It is never this deployment.
  if (origin === 'null') {
    return forbidden('The request came from an opaque origin, not this deployment.')
  }
  if (origin === requestOrigin(request)) return null
  return forbidden(
    `The request's origin (${origin}) is not this deployment (${requestOrigin(request)}).`,
  )
}

function forbidden(message: string): CsError {
  return csError('CS_FORBIDDEN', message, undefined, {
    userMessage: 'That request did not come from this site, so it was refused.',
    retryable: false,
  })
}
