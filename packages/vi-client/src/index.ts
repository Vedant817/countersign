/**
 * `@countersign/vi-client` — spec §8.4 M4 (WP-04), the typed TypeScript client for `apps/vi`.
 *
 * The public surface is one client class, one method per route, and the zod schemas that describe the
 * service's wire contract. Everything else here is either a policy function worth being able to read
 * (`shouldRetry`) or an acceptance tool (`compareSchemas`).
 *
 * ## How to use it
 *
 * ```ts
 * const vi = new ViClient({ baseUrl: process.env.VI_SERVICE_URL!, token: process.env.VI_SERVICE_TOKEN!, clock: systemClock })
 *
 * // An invalid chain is a verdict, not a transport failure — so this is `ok`, and `chain_valid` is false.
 * const verdict = await vi.verify({ l1, l2, l3a, l3b, checkout_jwt })
 * if (!verdict.ok) return verdict                     // only the request or the transport failed
 * if (!verdict.value.chain_valid) return block(verdict.value.errors)
 *
 * // Spec D19: what vi did *not* evaluate, and therefore what the Gate still owes.
 * const owed = pendingNetworkEnforcement(verdict.value.constraints.skipped)
 * ```
 *
 * The base URL and token are constructor arguments rather than `process.env` reads because this client is
 * built in three places that get config differently — a Next route handler, the worker, and tests — and
 * spec §6 says the environment is validated once, at boot, by `packages/core/env.ts`.
 *
 * See `README.md` for the route table, the retry rule and how to run the contract and drift checks.
 */

// --- the client -------------------------------------------------------------------------------------
export { ViClient, mapViError, transportError, isTimeoutError, normaliseBaseUrl, jsonSafeBody } from './client'
export {
  shouldRetry,
  retryDelayMs,
  retryDelayCeilingMs,
  realSleep,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  ROUTE_RETRY_NOTES,
} from './client'
export type { AttemptFailure, RetryDecision, RetryVerdict, Sleep, ViClientOptions } from './client'

// --- schemas ----------------------------------------------------------------------------------------
export * from './types'

// --- the schema drift check (AT-M4.2) ----------------------------------------------------------------
export { compareSchemas, hasDrift, loadOpenApiDocument, formatDriftTable } from './schema-drift'
export type {
  DriftDifference,
  DriftDirection,
  DriftKind,
  DriftReport,
  LoadOpenApiOptions,
  UnverifiablePosition,
} from './schema-drift'