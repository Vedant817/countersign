/** D-034: identical to apps/vi/l3.py, not a claim or an HTTP request id. */
import { createHash } from 'node:crypto'
import { csError, err, ok, type CsError, type Result } from '@countersign/core'

/**
 * base64url(SHA-256(ASCII(L3a issuer JWT))). Hash the exact compact JWS before the first `~`;
 * never trim, decode/re-encode, include disclosures, or trust an injected `jti` claim.
 * Check 4 authenticates the bytes; this only derives their stable unique-insert key.
 */
export function deriveL3ReplayId(l3a: unknown): Result<string, CsError> {
  try {
    if (typeof l3a !== 'string') throw new Error('L3a is not a string')
    const issuerJwt = l3a.split('~', 1)[0] ?? ''
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(issuerJwt)) {
      throw new Error('L3a issuer JWT is not a non-empty ASCII compact JWS')
    }
    return ok(createHash('sha256').update(issuerJwt, 'ascii').digest('base64url'))
  } catch {
    return err(
      csError(
        'VI_CHAIN_INVALID',
        'L3a cannot be hashed for replay protection: invalid issuer JWT or hashing unavailable',
      ),
    )
  }
}
