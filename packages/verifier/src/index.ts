/**
 * `@countersign/verifier` — spec **§8.18 (M18)**, screen **S-20**, work package **WP-18**.
 *
 * The public verifier at `/v/[packetId]`. Every evidence packet's PDF carries a QR code pointing here
 * (§8.18), so a PayPal adjudicator or a chargeback analyst re-verifies the chain from this page rather than
 * taking our word for it.
 *
 * ```ts
 * const packet = await loadVerifierPacket(deps, packetId)
 * if (!packet.ok) return route500(packet.error)
 * if (packet.value === undefined) return notFound()          // EC-DSP-9
 *
 * const report = await buildVerifierReport(packet.value, deps)          // offline: no network at all
 * const redacted = buildRedactedView(packet.value, deps)                // EC-PRIV-3
 * assertRedactionHolds(redacted, packet.value.bundle)                   // …and prove it before serving
 *
 * // "Verify now" — AT-M18.2's limiter first, then one call to /v1/public/verify
 * const verdict = clientIdFromHeaders(headers)
 * const budget = limiter.check(verdict)
 * if (!budget.allowed) return tooManyRequests(rateLimitError(budget, route))
 * ```
 *
 * ## The five source files, and the order they matter in
 *
 * | File | Owns | The trap it exists to avoid |
 * |---|---|---|
 * | `bundle.ts` | canonicalisation, both digests, SD-JWT decoding, the **raw download** document | Two implementations of JCS would be two digests for one document. |
 * | `binding.ts` | what the **signed** artefacts assert: the price lock's total and merchant, L3a's payee, the chain's `iat` window, the L2's spending ceiling | A digest is a function of the document, so it cannot bind it. Only a signature the forger cannot produce can. |
 * | `redact.ts` | the **redacted page** document and `assertRedactionHolds` | "Redacted" that is only hidden by CSS leaves the raw L1 in the page's JSON. |
 * | `verify-view.ts` | the per-check rows, the report model, the URL helper, **AT-M18.2's** limiter | A single green tick would have to hide D-009 and D19. |
 * | `verify-py.ts` | the generated offline script | A code block is not evidence, and a script with no embedded digest proves nothing. |
 * | `types.ts` | the closed ports and the report types | — |
 *
 * ## What this package will not do
 *
 * - **No green tick on a field no signature covers.** `readback` and `preferences` are §7.3
 *   `PACKET_ONLY_MEMBER`s, outside the `custom_id` preimage and absent from the signed L2. `readback_binding`
 *   and `preferences_binding` report that as a `WARN` on every packet, and §8.10's `att`/`mdt` likewise — see
 *   `README.md`, "What cannot be bound to anything". A page that cannot establish a field says so; a page that
 *   ticks it is worse than one that admits the gap, because the tick is what an adversary needs.
 * - **No LLM, anywhere.** There is no model member on {@link VerifierDeps}, and adding one would mean the
 *   page's conclusions were generated rather than computed.
 * - **No money arithmetic.** Amounts cross as integer minor units and are only ever rendered (§0, EC-FX-6).
 * - **No `process.env`.** §6 validates the environment once, at boot, and this package is called from a
 *   route handler that already has its configuration.
 * - **No raw token in anything the page renders.** Enforced in code by `assertRedactionHolds`, not by
 *   convention.
 *
 * See `README.md` for the canonicalisation rule, the contract issues found in other packages, and the exact
 * list of acceptance tests.
 */

// --- types and wiring ---------------------------------------------------------------------------
export {
  defineVerifierDeps,
  type CheckCategory,
  type CheckSource,
  type CheckStatus,
  type VerifierCheck,
  type VerifierDeps,
  type VerifierReport,
  type VerifierReportResult,
  type VerifierStore,
  type VerifierVi,
} from './types'

// --- §7.3 the bundle: canonicalisation, digests, decoding -----------------------------------------
export {
  BUNDLE_VERSION,
  base64UrlToHex,
  buildRawBundleDocument,
  bundleHashBase64Url,
  bundleHashHex,
  canonicalBundleCore,
  canonicalBundleJson,
  customIdForBundle,
  decodeSdJwt,
  EXCLUDED_FROM_CUSTOM_ID,
  HASHED_MEMBERS,
  isSha256Base64Url,
  isSha256Hex,
  l1DisclosedClaim,
  PACKET_ONLY_MEMBERS,
  sha256Base64Url,
  sha256Hex,
  textSha256Hex,
  tokenKid,
  wireBundle,
  type DecodedSdJwt,
  type RawBundleDocument,
  type RawBundleInput,
  type SdJwtDisclosure,
} from './bundle'

// --- the anchors: what the signed artefacts in a bundle actually assert ---------------------------------
export {
  isCompilerReadback,
  READBACK_HEADER,
  readChainAnchors,
  readMonetaryCeiling,
  readStatedCaps,
  type ChainAnchors,
  type L3aAnchor,
  type MoneyClaim,
  type MonetaryCeiling,
  type PriceLockAnchor,
} from './binding'

// --- EC-PRIV-3 the redaction ----------------------------------------------------------------------
export {
  ADDRESS_STREET_KEYS,
  addressToCityCountry,
  assertRedactionHolds,
  buildRedactedPacketDocument,
  buyerFactsOf,
  findLeakedSubstrings,
  maskEmail,
  maskOpaqueId,
  rawSecretsOf,
  WITHHELD_FROM_VIEW,
  type BuyerFacts,
  type CityCountry,
  type RedactedArtefact,
  type RedactedPacketDocument,
  type RedactedPacketInput,
} from './redact'

// --- S-20 the page: checks, model, rate limit ------------------------------------------------------
export {
  atTimeWarningOf,
  buildRedactedView,
  buildVerifierReport,
  clientIdFromHeaders,
  createPublicRateLimiter,
  liveChecks,
  loadVerifierPacket,
  offlineChecks,
  publicPacketUrl,
  PUBLIC_RATE_LIMIT_PER_MIN,
  PUBLIC_RATE_WINDOW_MS,
  rawBundleUrl,
  rateLimitError,
  requestLiveVerify,
  skippedBy,
  verifyScriptUrl,
  type LoadedPacket,
  type PublicRateLimiter,
  type RateLimiterOptions,
  type RateLimitVerdict,
} from './verify-view'

// --- the offline script --------------------------------------------------------------------------
export { renderVerifyPy, type VerifyPyInput, type VerifyPyKey } from './verify-py'
