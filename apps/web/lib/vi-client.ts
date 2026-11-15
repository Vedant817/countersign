/**
 * The vi-service client and its environment configuration.
 *
 * ## Why this is not in the signing lab
 *
 * These three things — `readServiceConfig`, `createViClient` and `AGENT_AUDIENCE` — used to live in
 * `app/lab/device-sign/vi.ts`, next to the lab's sample identities. That was tolerable while the lab was
 * the only caller, and stopped being tolerable the moment a **production** module needed them:
 * `lib/agent-session.ts` imported the vi client from a lab directory, so the buyer's real mandate path
 * depended on a demo harness for its transport (plan `docs/plans/agent-real-path.md`, risk 2).
 *
 * The split is now the honest one:
 *
 * - **This file** is the deployment's vi configuration: where the service is, how to authenticate to it,
 *   which clock it is called with, and the agent audience a mandate is minted for. Any caller may use it.
 * - **`app/lab/device-sign/vi.ts`** keeps what is only true of the sample harness: `usr_demo_user` and the
 *   other sample identities, and `signingLabAllowed`, which refuses to issue them from a deployed app.
 *
 * Nothing here reads a sample identity, and nothing here is gated by `SIGNING_LAB_ENABLED`.
 */
import { systemClock } from '@countersign/core'
import { ViClient } from '@countersign/vi-client'

/**
 * The `aud` a vi-minted agent key is sealed for. It is a DNS-shaped name for this product's agent, not a
 * URL anyone fetches; `agentIssuer()` below is the `iss`/`aud` pair used when a mandate is prepared.
 */
export const AGENT_AUDIENCE = 'https://agent.countersign.test'

/** What a missing `VI_SERVICE_URL`/`VI_SERVICE_TOKEN` is reported as. */
export const VI_CONFIG_MISSING = 'VI_SERVICE_URL and VI_SERVICE_TOKEN must be set.'

/** The vi-service connection details, read from the environment. */
export interface ServiceConfig {
  readonly baseUrl: string
  readonly token: string
}

/**
 * `null` when vi is not configured, rather than an error: every caller turns that into its own refusal,
 * because "this deployment has no vi-service" is a different fact for a route than it is for a test.
 */
export function readServiceConfig(): ServiceConfig | null {
  const baseUrl = process.env.VI_SERVICE_URL
  const token = process.env.VI_SERVICE_TOKEN
  if (baseUrl === undefined || baseUrl === '' || token === undefined || token === '') {
    return null
  }
  return { baseUrl, token }
}

/**
 * A vi client on the process clock. The clock is injected (spec §6) so a test can move time without
 * mocking `Date`, and the client is built per call because the config is read per call.
 */
export function createViClient(config: ServiceConfig): ViClient {
  return new ViClient({ baseUrl: config.baseUrl, token: config.token, clock: systemClock })
}

/**
 * The issuer a mandate is minted under. `VI_AGENT_ISS` overrides it for a deployment that wants its own
 * name in the `iss`/`aud` pair; the default is this product's own agent name.
 */
export function agentIssuer(): string {
  const configured = process.env.VI_AGENT_ISS
  return configured !== undefined && configured !== '' ? configured : AGENT_AUDIENCE
}
