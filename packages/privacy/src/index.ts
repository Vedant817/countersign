/**
 * `@countersign/privacy` — M19, spec §8.19 and §12.13 (WP-19).
 *
 * The package owns four questions:
 *
 *  1. **How long may we keep this?** — `RETENTION_POLICY`, `retentionDeadline`, `withinRetention`
 *     (§12.13's table as data).
 *  2. **May this be erased today?** — `planErasure` (AT-M19.1: held by a dispute, released on
 *     resolution, held again by the evidence window).
 *  3. **What does "erased" mean for a row?** — `pseudonymiseUser`, `piiDigest` (§12.13:
 *     "pseudonymise PII and keep crypto hashes").
 *  4. **What must a subject be told?** — `renderPreErasureNotice` (EC-PRIV-5) and `buildExport`
 *     (EC-PRIV-2).
 *
 * What it deliberately does **not** do: open a database connection, call PayPal, or read the
 * environment beyond the pseudonym salt. Everything here is a pure function or a port, so the
 * acceptance tests run without credentials and the composition root stays in `apps/web`, where the
 * environment is validated.
 *
 * Logging (§8.19's "pino JSON with `request_id`, `paypal_debug_id`, `attempt_id`; PII redaction
 * list") lives in `@countersign/core`'s `createLogger`, because every package writes log lines and a
 * second logger would be a second redaction list. AT-M19.2's regex test is therefore in
 * `packages/core/test/env.test.ts`, and this package's tests assert the erasure/export side of the
 * same rule.
 */
export {
  EVIDENCE_WINDOW_DAYS,
  LLM_RETENTION_DAYS,
  LOG_RETENTION_DAYS,
  PRE_ERASURE_NOTICE_HOURS,
  RETENTION_POLICY,
  SECONDS_PER_DAY,
  WEBHOOK_RETENTION_DAYS,
  retentionDeadline,
  retentionRule,
  withinRetention,
  type RetentionClassId,
  type RetentionRule,
} from './policy'

export {
  evidenceWindowEndsAtSec,
  isoDate,
  legalHoldError,
  planErasure,
  type ErasureAction,
  type ErasureDecision,
  type ErasureInput,
  type OpenDisputeRef,
} from './hold'

export {
  isAlreadyErased,
  piiDigest,
  pseudonymiseUser,
  pseudonymFor,
  pseudonymSaltConfigured,
  redactFreeText,
  type PiiKind,
  type PseudonymisedUser,
  type UserPiiRow,
} from './pseudonymise'

export { renderPreErasureNotice, type PreErasureNoticeInput, type RenderedNotice } from './notice'

export {
  EXPORT_REDACTION_NOTE,
  EXPORT_RETENTION_NOTE,
  buildExport,
  exportFilename,
  type ExportBundle,
  type ExportFile,
  type PrivacyExportStore,
} from './export'

export {
  RECONCILER_LAG_SLO_SEC,
  RECONCILER_STALLED_SEC,
  humaniseSeconds,
  overallStatus,
  webhookHealth,
  type DependencyStatus,
  type OverallStatus,
  type WebhookHealth,
  type WebhookHealthInput,
  type WebhookHealthState,
} from './status'
