import 'server-only'

/**
 * A device key that lives on the **server**, for the agent demo only.
 *
 * ## This is a fixture, and the difference matters
 *
 * The real buyer's device key is generated in the browser, is **non-extractable**, and never leaves the
 * tab (spec §3.1, `apps/web/lib/browser-keystore.ts`). A mandate is signed by *that* key, which is what
 * makes "the user approved this" a fact rather than a claim.
 *
 * The agent demo (S-10) has no browser tab to hold such a key: it is driven from a server route, and a
 * headless run needs a key it can use twice — once to sign the L2, and never again. So this module
 * generates a P-256 key in Node, uses it, and forgets it. The mandate it produces is signed with a real
 * signature over the real bytes, so every downstream verifier behaves exactly as it would; what is lost is
 * the *custody* property, and that is a demo limitation, not a product one.
 *
 * Two consequences are enforced rather than documented:
 *
 *  - The key is generated **per session** and never persisted, so a demo session cannot sign a second
 *    mandate later. There is nothing to steal and nothing to reuse.
 *  - Nothing here is reachable in production: `provisionAgentSession` refuses unless
 *    `COUNTERSIGN_AGENT_DEMO=1` and `NODE_ENV !== 'production'`, the same gate the signing lab uses.
 *
 * The thumbprint is RFC 7638 — the SHA-256 of the canonical `{crv,kty,x,y}` JSON — computed exactly the
 * way `browser-keystore.ts` computes it, because vi's L1 binds `cnf.jkt` and a one-byte difference would
 * surface as an unverifiable chain rather than as an error here.
 */
import { bytesToBase64Url } from './base64url'

export interface DemoDeviceKey {
  /** The public half, in the shape vi's `device_public_jwk` expects. */
  readonly publicJwk: JsonWebKey
  /** RFC 7638 SHA-256 thumbprint, base64url. */
  readonly jkt: string
  /** `dev_<jkt>`, matching `browser-keystore.ts`'s `deviceKeyId`. */
  readonly kid: string
  /** ES256 over the ASCII signing input, raw P1363 r‖s, base64url — what `l2/finalize` verifies. */
  readonly sign: (signingInputAscii: string) => Promise<string>
}

const ECDSA_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } satisfies EcKeyGenParams
const ECDSA_SIGNATURE_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } satisfies EcdsaParams
const SIGNATURE_BYTES = 64
const KID_PREFIX = 'dev_'

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

/**
 * Generate a single-use P-256 device key.
 *
 * `extractable: false` on purpose even though this key never leaves the process: the flag is what stops a
 * future refactor from exporting it into a log line, and there is no reason to relax it.
 */
export async function createDemoDeviceKey(): Promise<DemoDeviceKey> {
  const keyPair = await crypto.subtle.generateKey(ECDSA_PARAMS, false, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const jkt = await deviceThumbprint(publicJwk)
  return {
    publicJwk,
    jkt,
    kid: `${KID_PREFIX}${jkt}`,
    sign: async (signingInputAscii: string): Promise<string> => {
      const signature = await crypto.subtle.sign(
        ECDSA_SIGNATURE_PARAMS,
        keyPair.privateKey,
        new TextEncoder().encode(signingInputAscii),
      )
      const bytes = new Uint8Array(signature)
      if (bytes.length !== SIGNATURE_BYTES) {
        throw new Error(
          `The ECDSA signature was ${bytes.length} bytes, not ${SIGNATURE_BYTES} (P1363)`,
        )
      }
      return bytesToBase64Url(bytes)
    },
  }
}
