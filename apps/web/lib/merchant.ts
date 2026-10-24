import 'server-only'

import { csError, type CsError, type Result } from '@countersign/core'

/**
 * Who this deployment sells as — the merchant identity that ends up **inside signed artefacts**.
 *
 * ## Why this is its own module
 *
 * It used to live in `app/lab/device-sign/vi.ts`, next to the signing lab's sample wallet, and the
 * production checkout route imported it from there (`import { MERCHANT } from
 * '../../lab/device-sign/vi'`). That is the wrong direction of dependency in a way that hides a real
 * problem: a **demo harness** was the source of truth for the merchant named in a merchant-signed
 * checkout JWT. Deleting or gating the lab would have silently changed what the shop signs as.
 *
 * It is also the same class of bug D-040 already fixed once — `create_checkout` used to sign the
 * literal "Northwind Outfitters" regardless of who the merchant was, and a second hardcoded copy is
 * how that comes back.
 *
 * ## No defaults, deliberately
 *
 * Every other variable in this project may have a sensible fallback. This one may not: a defaulted
 * merchant name is a **fabricated value inside a signature**, and the verifier on the other side has
 * no way to tell it apart from a real one. `docs/DECISIONS.md` D-042 made `VI_ISSUER_URL` and
 * `VI_AGENT_ISS` required for exactly this reason, and the argument is the same.
 *
 * The failure is a `Result` rather than a throw so a route can answer with a sentence naming the
 * variable, which is what `docs/DECISIONS.md` D-053 established for `/v/<packetId>`.
 */
export interface MerchantIdentity {
  readonly id: string
  readonly name: string
  readonly website: string
  /**
   * `vi-client` types a merchant as an open object (`{[x: string]: unknown; id; name; website}`)
   * because the Verifiable Intent library permits extra fields and the signature covers whatever is
   * present. Declaring it here means this type is assignable to that one without a cast — and a cast
   * is how a field the signer sees but the caller did not intend gets into a signed artefact.
   */
  readonly [key: string]: unknown
}

export const REQUIRED_MERCHANT_ENV = ['MERCHANT_ID', 'MERCHANT_NAME', 'MERCHANT_WEBSITE'] as const

export type MerchantEnvName = (typeof REQUIRED_MERCHANT_ENV)[number]

/** Which of the three are absent or blank, in declaration order. */
export function missingMerchantEnv(
  env: Readonly<Record<string, string | undefined>>,
): readonly MerchantEnvName[] {
  return REQUIRED_MERCHANT_ENV.filter((name) => {
    const value = env[name]
    return value === undefined || value.trim() === ''
  })
}

/**
 * The merchant this deployment signs as, or an error naming what is missing.
 *
 * Read per call rather than captured at import: Next resolves this module during the build, and a
 * module-level read would bake the build machine's environment into a signed artefact.
 */
export function merchantIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<MerchantIdentity, CsError> {
  const missing = missingMerchantEnv(env)
  if (missing.length > 0) {
    return {
      ok: false,
      error: csError(
        'CS_INTERNAL',
        `The merchant identity is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset`,
        { missing: [...missing] },
        {
          userMessage:
            'The store is not configured on this deployment, so it cannot quote a price. Nothing was charged.',
          retryable: false,
        },
      ),
    }
  }

  const id = (env['MERCHANT_ID'] ?? '').trim()
  const name = (env['MERCHANT_NAME'] ?? '').trim()
  const website = (env['MERCHANT_WEBSITE'] ?? '').trim()

  // A non-URL website would be signed into the checkout and printed on a receipt. Checking here keeps
  // the failure at configuration time instead of inside `vi`'s signing call.
  try {
    new URL(website)
  } catch {
    return {
      ok: false,
      error: csError(
        'CS_VALIDATION',
        `MERCHANT_WEBSITE is not a URL: ${website}`,
        { env: 'MERCHANT_WEBSITE' },
        { userMessage: 'The store is misconfigured on this deployment.', retryable: false },
      ),
    }
  }

  return { ok: true, value: { id, name, website } }
}
