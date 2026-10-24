/**
 * The configuration `/v/{packetId}` needs, as a value — so "this deployment is not set up" is a
 * state the page can *report* rather than one it discovers by throwing.
 *
 * The distinction matters more here than anywhere else in the app. This URL is printed on an
 * evidence PDF that a stranger scans; if the deployment is missing a variable the reader must be
 * told that, in a sentence, on a page. Before this module existed, `requiredEnv` threw from inside
 * `verifierDeps()`, and Next rendered its generic "a server error occurred" — which reads like the
 * evidence is gone. The same throw also fired before the packet-id shape check, so `/v/not-a-packet`
 * was a 500 rather than the 404 the spec asks for (EC-DSP-9).
 *
 * Kept as a pure function of an environment object rather than a module-level constant: the page may
 * be requested long after import, and a value captured at import time would be the build's
 * environment on some hosts.
 */

/** §6's required configuration for the verifier page. */
export const REQUIRED_VERIFIER_ENV = [
  'DATABASE_URL',
  'VI_SERVICE_URL',
  'VI_SERVICE_TOKEN',
  'PUBLIC_BASE_URL',
] as const

export type VerifierEnvName = (typeof REQUIRED_VERIFIER_ENV)[number]

/**
 * Which of the required variables are absent or blank, in declaration order.
 *
 * Blank counts as missing. `FOO=` in a `.env` file is the commonest way to think a variable is set,
 * and treating it as present would move the failure to the first request instead of the first render.
 */
export function missingVerifierEnv(
  env: Readonly<Record<string, string | undefined>>,
): readonly VerifierEnvName[] {
  return REQUIRED_VERIFIER_ENV.filter((name) => {
    const value = env[name]
    return value === undefined || value.trim() === ''
  })
}

/** The one-line operator hint. Names variables only — never values (spec §6). */
export function verifierUnavailableDetail(missing: readonly VerifierEnvName[]): string {
  return missing.length === 0
    ? ''
    : `The verifier is not configured on this deployment: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset.`
}
