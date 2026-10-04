/**
 * `@countersign/paypal` — spec §8.6 M6 (WP-06), decision D6.
 *
 * The typed PayPal REST client. Everything a caller needs is re-exported here; the deep imports
 * (`./client`, `./sandbox`, `./types`) exist for the scripts under `scripts/`.
 *
 * Money crosses this boundary in exactly two forms: a `PPMoney` request object
 * (`{ currency_code, value }`, the string decimal PayPal wants) and a canonical `Money` from
 * `@countersign/core` (integer minor units). Nothing here ever holds a float amount — see
 * `types.ts` and the `check-money-discipline` gate.
 */
export {
  PayPalClient,
  ENDPOINT_POLICIES,
  DEFAULT_TIMEOUT_MS,
  TOKEN_EXPIRY_SKEW_SECONDS,
  policyFor,
  toQueryString,
} from './client'
export type {
  CallOpts,
  EndpointPolicy,
  HttpMethod,
  PayPalClientDeps,
  PayPalClientOpts,
  RetryPolicy,
  Transport,
  TransportCall,
} from './client'

export {
  PayPalSandboxApi,
  SANDBOX_APIS_AVAILABLE,
  parseUnsignedAuthAssertion,
  unsignedAuthAssertion,
} from './sandbox'
export type { PayPalSandboxDeps, UnsignedAuthAssertion } from './sandbox'

export {
  DISPUTE_ACTIONS,
  PAYPAL_DOCUMENTED_REQUEST_ID_MAX_CHARS,
  PAYPAL_OPENAPI_REQUEST_ID_MAX_CHARS,
  REQUEST_ID_MAX_CHARS,
  REQUEST_ID_PREFIX,
  captureRequestId,
  disputeActionRequestId,
  isOurPrefixedId,
  measureRequestId,
  observedRequestIdLengths,
  orderCreateRequestId,
  refundRequestId,
  validateRequestId,
} from './idempotency'
export type { DisputeActionToken, RequestIdLengthReport } from './idempotency'

export {
  DEFAULT_BACKOFF,
  MAX_RETRY_AFTER_MS,
  backoffCeilingMs,
  fullJitterDelayMs,
  nextDelayMs,
  parseRetryAfter,
  realSleep,
  retriesExhausted,
} from './backoff'
export type { BackoffConfig, Sleep } from './backoff'

export { BREAKER_OPEN_MS, BREAKER_THRESHOLD, CircuitBreaker, breakerKey } from './circuit'
export type { BreakerState, CircuitBreakerOpts } from './circuit'

export {
  NAME_TO_CODE,
  extractDebugId,
  firstIssue,
  headerValue,
  isAmbiguousStatus,
  issueTokens,
  mapPayPalError,
  networkError,
  paypalName,
} from './errors'
export type { HeaderBag, MapErrorInput, PayPalErrorBody, PayPalIssue } from './errors'

export {
  ALLOWED_EVIDENCE_CONTENT_TYPES,
  EVIDENCE_INPUT_FIELD,
  EVIDENCE_INPUT_FILENAME,
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_TOTAL_BYTES,
  buildEvidenceForm,
  evidenceFileSizes,
} from './multipart'
export type { AllowedEvidenceContentType, EvidenceFile } from './multipart'

export * from './types'