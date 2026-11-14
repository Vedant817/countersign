import 'server-only'

/**
 * The RFC 7638 thumbprint of a device public key.
 *
 * SHA-256 over the canonical `{crv,kty,x,y}` JSON, base64url — computed exactly the way
 * `browser-keystore.ts` computes it, because vi's L1 binds `cnf.jkt` and a one-byte difference would
 * surface as an unverifiable chain rather than as an error here.
 *
 * It lives in its own module so code that never mints a demo key can still thumbprint a device key
 * (`agent-session.ts` resolves the buyer's device row by the thumbprint the browser reports), while
 * `demo-device.ts` stays the single place that generates server-held keys. `demo-device.ts`
 * re-exports this function, so its existing importers are unaffected.
 */
import { bytesToBase64Url } from './base64url'

/** RFC 7638 thumbprint of a P-256 public JWK. */
export async function deviceThumbprint(publicJwk: JsonWebKey): Promise<string> {
  if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256') {
    throw new Error('Only P-256 EC public keys can be thumbprinted')
  }
  const { x, y } = publicJwk
  if (typeof x !== 'string' || typeof y !== 'string') {
    throw new Error('The public key is missing its coordinates')
  }
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x, y })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return bytesToBase64Url(new Uint8Array(digest))
}
