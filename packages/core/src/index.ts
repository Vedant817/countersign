/**
 * `@countersign/core` — spec §8.1 M1.
 *
 * Public types live here and this file is **append-only**: only WP-01 may change an export
 * (AGENTS.md engineering rule 2). Other packages import from here so that "what is a MandateId"
 * has exactly one answer in the repository.
 *
 * Money is integer minor units plus a currency. Time is epoch seconds. Errors are `CsError` with a
 * code from the registry. Nothing in this package imports an LLM, the database or the network.
 */
export * from './ids'
export * from './money'
export * from './errors'
export * from './clock'
export * from './env'
export * from './logger'
export * as schemas from './schemas/index'

/** Version of the evidence-bundle format, mirrored in `custom_id` and the public verifier. */
export const EVIDENCE_VERSION = 'cs1' as const

/**
 * The pinned Verifiable Intent library commit (spec D2, [B1]).
 *
 * This string appears in the evidence bundle and in every Gate decision record, so a packet filed
 * months ago verifies against the library version that was actually used.
 * https://github.com/agent-intent/verifiable-intent/tree/356c29635f1c44df7de02edb58699ca9f29bece6
 */
export const VI_LIB_COMMIT = '356c29635f1c44df7de02edb58699ca9f29bece6' as const

/** Spec §14 SLOs, referenced by `/status`, Judge Mode and the eval reports. */
export const SLO = {
  /** Gate decision latency, p95, including the vi-service verify call. */
  GATE_P95_MS: 400,
  /** Webhook acknowledgement, p95. */
  WEBHOOK_ACK_P95_MS: 300,
  /** Reconciler lag between a PayPal state change and our view of it. */
  RECONCILER_LAG_SECONDS: 300,
  /** Judge Mode scenario budget. */
  JUDGE_SCENARIO_SECONDS: 90,
  /** Sustained webhook ingest for the load test (spec AT-M12.6). */
  WEBHOOK_SUSTAINED_PER_MINUTE: 200,
} as const
