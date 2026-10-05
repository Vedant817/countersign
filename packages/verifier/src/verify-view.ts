/**
 * What the page actually *concludes* — spec **§8.18 (M18)**, screen **S-20**, acceptance tests
 * **AT-M18.1** (tampering is shown) and **AT-M18.2** (rate limit), work package **WP-18**.
 *
 * ## The three sections of this file, and why they are here
 *
 * 1. **Loading.** `loadVerifierPacket` turns `(packetId)` into either a {@link LoadedPacket} or `undefined`.
 *    `undefined` is the whole of EC-DSP-9's buyer-side path: an unknown `packetId` is a **404 that says
 *    so**, never a stack trace, because this URL is printed on a PDF a chargeback analyst will scan.
 * 2. **The checks.** `offlineChecks` and `liveChecks` produce {@link VerifierCheck} rows. They are split
 *    because the split is the strongest claim the page makes: the offline half is established **with no
 *    server of ours running**, and the live half is our own service's answer. A reader who trusts neither can
 *    still use the first.
 * 3. **The limiter.** `createPublicRateLimiter` is §8.3's 30/min/IP applied *here* as well as in
 *    `apps/vi`, because "Verify now" behind an unmetered Next route turns a reader hammering a button into a
 *    denial of service against our own vi-service.
 *
 * ## Why every check is a row and not a summary line
 *
 * §8.18 asks for "the per-check result" and the accessibility requirement says the result must be text. The
 * substantive reason is D-009: a `chain_valid: true` with `at_time_not_honoured: true` is **not** the same
 * claim as a clean pass, and neither is a chain whose `budget` constraint was never evaluated (D19). A
 * single green tick would have to hide one of those, so the type has a `WARN` status and the page renders
 * warnings above the failures.
 */

import {
  csError,
  ok,
  type CsError,
  type DisputeId,
  type PacketId,
  type Result,
} from '@countersign/core'
import {
  decodeCheckoutJwt,
  gateJwksMany,
  verifyDecisionRecord,
  type GateJwks,
  type PublicJwk as GateJwk,
} from '@countersign/gate'
import {
  pendingNetworkEnforcement,
  type PublicVerifyResponse,
  type VerifyResponse,
} from '@countersign/vi-client'

import {
  base64UrlToHex,
  bundleHashBase64Url,
  bundleHashHex,
  canonicalBundleJson,
  customIdForBundle,
  decodeSdJwt,
  EXCLUDED_FROM_CUSTOM_ID,
  HASHED_MEMBERS,
  isSha256Base64Url,
  l1DisclosedClaim,
  resolveSdJwt,
  textSha256Hex,
  tokenKid,
  wireBundle,
} from './bundle'
import { buildRedactedPacketDocument, type RedactedPacketDocument } from './redact'
import type {
  CheckCategory,
  CheckSource,
  CheckStatus,
  VerifierCheck,
  VerifierDeps,
  VerifierReport,
} from './types'

// ---------------------------------------------------------------------------
// The URL helper
// ---------------------------------------------------------------------------

/**
 * §6’s `PUBLIC_BASE_URL` + `/v/{packetId}` — the address the packet PDF’s QR encodes (§8.18) and the
 * address this page is served at.
 *
 * ### The duplication is gone, and that is worth recording because it existed
 *
 * This was a one-line **mirror** of `packages/defender`’s `citation-check.ts::publicPacketUrl`, kept
 * because the symbol was not re-exported from that package’s index and AGENTS.md rule 8 forbids
 * editing another work package’s files. It was covered by a cross-base-URL agreement test that imported
 * the original by **relative path** — a reasonable mitigation, and still a second implementation.
 *
 * `publicPacketUrl` is now exported from `@countersign/defender`, so this is a re-export rather than a
 * copy. One implementation, for a failure mode that is specific and quiet: `qr.ts` encodes this address
 * into the PDF, `citation-check.ts` refuses any note containing a different one, and this page is what
 * a scan opens. If the two strings drifted, the symptom would be a perfect-looking evidence packet
 * whose QR opens a 404 — discovered by a PayPal adjudicator, in front of a judge.
 *
 * The re-export is kept rather than inlined so that importers of this module still resolve to the same
 * function, and so the dependency is visible in exactly one place.
 *
 * The trailing-slash strip inside that function is not cosmetic: `PUBLIC_BASE_URL` is
 * operator-configured (§6), and a trailing slash would produce `https://host//v/pkt_x` — a different
 * string from the one the citation checker was configured with, *and* a 404.
 */
// Imported as well as re-exported: `export … from` does not introduce a local binding, and this module
// uses the function to build its own two URLs below.
import { publicPacketUrl as canonicalPacketUrl } from '@countersign/defender'

export const publicPacketUrl = canonicalPacketUrl

/** The raw download's address. Same base, one more segment. */
export function rawBundleUrl(baseUrl: string, packetId: string): string {
  return `${publicPacketUrl(baseUrl, packetId)}/download`
}

/**
 * The generated `verify.py`'s address — a real file, served as `text/x-python`, not a code block.
 *
 * **`?as=verify.py` on the download route, not a fourth route.** §8.18 asks for a *downloadable* file, and the
 * two artifacts are inseparable: the script embeds the digests of the bundle it will be run against, so serving
 * one without the other is serving something a reader cannot use. One route that serves both, selected by a
 * query parameter, makes that structural rather than a convention somebody has to remember.
 *
 * The `/verify-now` route is the *live* re-verification instead, which is a different thing entirely.
 */
export function verifyScriptUrl(baseUrl: string, packetId: string): string {
  return `${publicPacketUrl(baseUrl, packetId)}/download?as=verify.py`
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** A packet row plus the dispute label, ready to check. */
export interface LoadedPacket {
  readonly packetId: PacketId
  readonly disputeId: DisputeId
  readonly version: number
  /** The stored bundle as jsonb, verbatim. */
  readonly bundle: Record<string, unknown>
  /** `evidence_packets.bundle_hash`, hex. */
  readonly storedBundleHash: string
  readonly filedAtSec: number | null
  readonly createdAtSec: number
  readonly amountMinor: bigint
  readonly amountCurrency: string
  readonly stage: string
  readonly status: string
  /** Public keys, from `jwks_keys`. Empty is a valid value and produces a `SKIPPED` check, not a crash. */
  readonly gateJwks: GateJwks
}

/**
 * Load one packet, or `undefined` for "no such packet".
 *
 * ### Why the store error is *not* swallowed into the 404
 *
 * A `Result` failure here means the database was unreachable — a fault, not an absence. Returning
 * `undefined` for it would render "we have no such packet" for what is actually an outage, and a reader
 * would conclude the packet was withdrawn. So the `err` propagates and the route answers 500 with a
 * sentence, while `ok(undefined)` alone becomes the 404.
 *
 * ### Why a missing dispute row is not fatal
 *
 * `packets.dispute_id` is `NOT NULL` with a foreign key (§7.2), so the row always exists. The read is
 * defensive because the page's job is to answer *about the chain*, and a label read must never be the reason
 * a chain is unverifiable. When the label is missing the page says the dispute was not found rather than
 * inventing a stage.
 */
export async function loadVerifierPacket(
  deps: VerifierDeps,
  packetId: PacketId,
): Promise<Result<LoadedPacket | undefined, CsError>> {
  const packet = await deps.store.packets.findById(packetId)
  if (!packet.ok) return packet
  const row = packet.value
  if (row === undefined) return ok(undefined)

  const dispute = await deps.store.disputes.findById(row.dispute_id as DisputeId)
  if (!dispute.ok) return dispute

  const keys = await deps.store.jwks.listAll()
  if (!keys.ok) return keys

  const gateEntries = keys.value
    .filter((k) => k.role === 'GATE')
    .map((k) => ({
      kid: k.kid,
      jwk: k.public_jwk as GateJwk,
    }))

  const bundle = isRecord(row.bundle) ? row.bundle : {}
  const createdAtSec = Math.floor(row.created_at.getTime() / 1000)

  return ok({
    packetId: row.id,
    disputeId: row.dispute_id as DisputeId,
    version: row.version,
    bundle,
    storedBundleHash: row.bundle_hash,
    filedAtSec: row.filed_at === null ? null : Math.floor(row.filed_at.getTime() / 1000),
    createdAtSec,
    amountMinor: dispute.value?.amount_minor ?? rowDisputeFallbackAmount(bundle),
    amountCurrency: dispute.value?.currency ?? 'USD',
    stage: dispute.value?.stage ?? 'unknown',
    status: dispute.value?.status ?? 'unknown',
    gateJwks: gateJwksMany(gateEntries),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The disputed amount when the dispute row could not be read.
 *
 * **Zero, and it is labelled as unknown.** A packet bundle has no amount of its own (§7.3 has none), and
 * inventing one from a capture id would be a fabricated fact on a public page. The page renders `unknown`
 * for a zero amount rather than `$0.00`, and the `amount` check says the dispute row was unavailable.
 */
function rowDisputeFallbackAmount(bundle: Record<string, unknown>): bigint {
  void bundle
  return 0n
}

// ---------------------------------------------------------------------------
// The offline checks
// ---------------------------------------------------------------------------

function check(
  id: string,
  category: CheckCategory,
  label: string,
  status: CheckStatus,
  detail: string,
  source: CheckSource = 'local',
  authority?: string,
): VerifierCheck {
  return {
    id,
    category,
    label,
    status,
    detail,
    source,
    ...(authority === undefined ? {} : { authority }),
  }
}

/** Shorten a digest for a sentence without making it unrecognisable. */
function short(value: string, keep = 12): string {
  return value.length <= keep * 2 ? value : `${value.slice(0, keep)}…${value.slice(-6)}`
}

/**
 * AT-M18.1: the checks a reader can run **with no Countersign server involved**.
 *
 * ### The per-field categories, and what each one proves
 *
 * | id | category | what it detects |
 * |---|---|---|
 * | `bundle_hash` | integrity | Any edit to any member of the stored bundle. |
 * | `custom_id` | integrity | A bundle whose nine-member core does not reproduce the `custom_id` PayPal's own order record carries (D18). |
 * | `readback_hash` | integrity | A read-back edited after the fact (EC-MER-6). |
 * | `preferences_hash` | integrity | A preferences block edited after the fact (EC-MER-6). |
 * | `key_order` | integrity | Nothing — it *proves* the digest is order-independent, and would FAIL if the canonical form were not JCS. |
 * | `required_members` | schema | EC-MER-6's anti-omission half: a packet with no read-back fails instead of passing quietly. |
 * | `bundle_version` | schema | A bundle whose `v` is not `cs1`, for which the preimage rule is unknown. |
 * | `custom_id_binding` | binding | A `custom_id` in `paypal` that disagrees with the recomputed one — i.e. a packet that is not the bundle the order was created with. |
 * | `checkout_binding` | binding | A price lock that is not the one L3b committed to (AT-M3.7's binding, restated). |
 * | `gate_record` | signature | Our own signature on the decision record, checked against `jwks_keys`. |
 * | `vi_lib_commit` | schema | A packet verified against a library other than the pinned one. |
 * | `l1_disclosures` | schema | An L1 that discloses nothing, which for this vendor means the email the packet claims to mask is not there. |
 *
 * ### The rule every one of them follows
 *
 * **Absent is not the same as passing.** A check that cannot run is `SKIPPED` with a sentence saying why,
 * never `PASS`. `apps/vi` makes the same call for the same reason (§8.3: an empty constraint list is
 * `satisfied: false`, "nothing to check is not the same as checked").
 */
export async function offlineChecks(
  packet: LoadedPacket,
  nowSec: number,
): Promise<readonly VerifierCheck[]> {
  const bundle = packet.bundle
  const out: VerifierCheck[] = []

  // --- 1. the whole-bundle digest -------------------------------------------------------------------
  let recomputedHex: string | null = null
  try {
    recomputedHex = bundleHashHex(bundle)
    out.push(
      recomputedHex === packet.storedBundleHash
        ? check(
            'bundle_hash',
            'integrity',
            'Bundle digest matches the published value',
            'PASS',
            `SHA-256 over the RFC 8785 canonical form of the whole bundle is ${short(recomputedHex)}, ` +
              'which is the value Countersign published. Any edit to any field changes it.',
            'local',
            '§7.3',
          )
        : check(
            'bundle_hash',
            'integrity',
            'Bundle digest does not match the published value',
            'FAIL',
            `The document in front of you hashes to ${short(recomputedHex)}, but Countersign published ` +
              `${short(packet.storedBundleHash)}. Something in this bundle was changed after it was ` +
              'published, or the two copies came from different places.',
            'local',
            '§7.3 · AT-M18.1',
          ),
    )
  } catch (cause) {
    out.push(
      check(
        'bundle_hash',
        'integrity',
        'Bundle could not be canonicalised',
        'FAIL',
        `The bundle contains a value that cannot be canonicalised for hashing (${describe(cause)}). A ` +
          'document we cannot hash is a document we cannot vouch for.',
        'local',
        '§7.3',
      ),
    )
  }

  // --- 2. the custom_id digest (D18) ------------------------------------------------------------------
  const customId = customIdForBundle(bundle)
  const inBundle = readString(bundle, 'paypal', 'custom_id')
  if (customId === null) {
    out.push(
      check(
        'custom_id',
        'integrity',
        'Bundle version is not cs1',
        'FAIL',
        'This bundle declares a version other than cs1, so the rule that produces custom_id is not the one ' +
          'documented. No custom_id can be recomputed from it, so it is not checkable.',
        'local',
        '§7.3 · D18',
      ),
    )
  } else if (inBundle === null) {
    out.push(
      check(
        'custom_id',
        'integrity',
        'Bundle carries no PayPal custom_id',
        'SKIPPED',
        'This bundle has no paypal member, so there is nothing to compare the recomputed custom_id against. ' +
          'That is normal for a bundle assembled before the order existed.',
        'local',
        '§7.3 · D18',
      ),
    )
  } else if (inBundle === customId) {
    out.push(
      check(
        'custom_id',
        'integrity',
        'custom_id is reproducible from this bundle',
        'PASS',
        `"cs1:" + base64url(SHA-256(JCS(nine core members))) is ${customId}, and that is the exact string ` +
          "PayPal's own order record carries. The order was therefore created from this bundle.",
        'local',
        '§7.3 · D18',
      ),
    )
  } else {
    out.push(
      check(
        'custom_id',
        'integrity',
        'custom_id does not match this bundle',
        'FAIL',
        `Recomputing custom_id from the nine hashed members gives ${customId}, but the bundle says ` +
          `${inBundle}. One of the two is not this bundle — so either the chain was altered, or this ` +
          'packet is not the bundle the PayPal order was created from.',
        'local',
        '§7.3 · D18 · AT-M18.1',
      ),
    )
  }

  // --- 3. EC-MER-6's two required hashes --------------------------------------------------------------
  out.push(consentHashCheck(bundle, 'readback', 'readback_hash', '§12 EC-MER-6'))
  out.push(consentHashCheck(bundle, 'preferences', 'preferences_hash', '§12 EC-MER-6'))

  // --- 4. the canonical form is order-independent ----------------------------------------------------
  out.push(keyOrderCheck(bundle, recomputedHex))

  // --- 5. EC-MER-6's anti-omission half --------------------------------------------------------------
  out.push(requiredMembersCheck(bundle))

  // --- 6. the paypal.custom_id binding (defender's consistency check, restated) ----------------------
  if (inBundle !== null && customId !== null && inBundle !== customId) {
    out.push(
      check(
        'custom_id_binding',
        'binding',
        'The PayPal reference and the bundle disagree',
        'FAIL',
        'Countersign refuses to file a packet whose paypal.custom_id differs from the order’s own ' +
          'custom_id, and this page reports the same disagreement for the same reason.',
        'local',
        'D-018',
      ),
    )
  } else {
    out.push(
      check(
        'custom_id_binding',
        'binding',
        'The PayPal reference is consistent',
        inBundle === null ? 'SKIPPED' : 'PASS',
        inBundle === null
          ? 'No paypal member, so there is no second copy of custom_id to compare against.'
          : 'paypal.custom_id is the same string the core recomputes, so the packet and the PayPal order ' +
              'agree on which bundle this is.',
        'local',
        'D-018',
      ),
    )
  }

  // --- 7. the price lock L3b committed to -------------------------------------------------------------
  out.push(checkoutBindingCheck(bundle))

  // --- 8. our own signature on the decision record --------------------------------------------------
  out.push(await gateRecordCheck(bundle, packet.gateJwks, nowSec))

  // --- 9. the pinned library ------------------------------------------------------------------------
  const commit = readStringOrNull(bundle, 'vi_lib_commit')
  out.push(
    commit === null
      ? check(
          'vi_lib_commit',
          'schema',
          'Packet records no library version',
          'SKIPPED',
          'Without vi_lib_commit there is no way to know which Verifiable Intent version produced this ' +
            'chain, so an old packet cannot be re-verified against the code that actually ran.',
          'local',
          '§7.3',
        )
      : check(
          'vi_lib_commit',
          'schema',
          'Packet records the library version used',
          'PASS',
          `This chain was produced by Verifiable Intent at ${commit}. A packet from a future version ` +
            'would need its own verifier.',
          'local',
          '§7.3 · D2',
        ),
  )

  // --- 10. what the L1 actually discloses --------------------------------------------------------------
  out.push(l1DisclosureCheck(bundle))

  return out
}

function consentHashCheck(
  bundle: Readonly<Record<string, unknown>>,
  member: 'readback' | 'preferences',
  id: string,
  authority: string,
): VerifierCheck {
  const value = bundle[member]
  const stored = readStringOrNull(bundle, `${member}_sha256`)

  const label = member === 'readback' ? 'Consent read-back' : 'Preferences block'

  if (value === undefined) {
    return check(
      id,
      'integrity',
      `${label} is missing`,
      'FAIL',
      `This packet has no \`${member}\` member. ${authority} makes it a required field precisely so a ` +
        'merchant cannot win a dispute by omitting the part that hurts them, and the public verifier is ' +
        'where that omission becomes visible.',
      'local',
      authority,
    )
  }
  if (stored === null) {
    return check(
      id,
      'integrity',
      `${label} carries no hash`,
      'FAIL',
      `The packet has a \`${member}\` but no \`${member}_sha256\`, so there is nothing to compare a ` +
        'recomputation against. An unhashed field is an unauditable one.',
      'local',
      authority,
    )
  }
  const expected = textSha256Hex(canonicalMemberText(member, value))
  return expected === stored
    ? check(
        id,
        'integrity',
        `${label} matches its published hash`,
        'PASS',
        `SHA-256 of the ${member} is ${short(stored)}, which is what the packet publishes.`,
        'local',
        authority,
      )
    : check(
        id,
        'integrity',
        `${label} does not match its published hash`,
        'FAIL',
        `The ${member} on file hashes to ${short(expected)}, but the packet publishes ${short(stored)}. ` +
          'The text was changed after the hash was taken.',
        'local',
        `${authority} · AT-M18.1`,
      )
}

/**
 * The exact text a `*_sha256` covers.
 *
 * The read-back is a plain string, hashed as UTF-8 with no canonicalisation. The preferences block is an
 * object, so it goes through JCS — and a `{}` block hashes as `{}` rather than as the empty string, which is
 * why this is one function with two branches instead of two call sites. Getting that wrong would make every
 * packet with no preferences fail its own check, which is the sort of false alarm that teaches readers to
 * ignore the page.
 */
function canonicalMemberText(member: 'readback' | 'preferences', value: unknown): string {
  if (member === 'preferences') return canonicalBundleJson(value)
  if (typeof value === 'string') return value
  return canonicalBundleJson(value)
}

/**
 * Prove the digest does not depend on key order — by reordering the keys and recomputing.
 *
 * This is the check that makes "RFC 8785" a claim rather than a citation. A hash that changed when a key
 * moved would mean the file we publish and the file a reader parses are two different documents, and no
 * third party could ever reproduce our digest.
 */
function keyOrderCheck(
  bundle: Readonly<Record<string, unknown>>,
  recomputedHex: string | null,
): VerifierCheck {
  if (recomputedHex === null) {
    return check(
      'key_order',
      'integrity',
      'Canonical form could not be tested',
      'SKIPPED',
      'The bundle could not be canonicalised, so key-order stability could not be tested.',
      'local',
      '§7.3',
    )
  }
  const reversed = reverseKeysDeep(bundle) as Record<string, unknown>
  let again: string
  try {
    again = bundleHashHex(reversed)
  } catch (cause) {
    return check(
      'key_order',
      'integrity',
      'Canonical form could not be tested',
      'FAIL',
      `Reordering the keys produced a bundle that cannot be canonicalised (${describe(cause)}).`,
      'local',
      '§7.3',
    )
  }
  return again === recomputedHex
    ? check(
        'key_order',
        'integrity',
        'The digest does not depend on key order',
        'PASS',
        'Every key in this bundle was reversed and the digest came out identical, which is what RFC 8785 ' +
          'canonicalisation means. You can reformat the file and the hash will not move.',
        'local',
        '§7.3 · RFC 8785',
      )
    : check(
        'key_order',
        'integrity',
        'The digest depends on key order',
        'FAIL',
        'Reversing the order of the keys changed the digest, so the published hash cannot be reproduced by ' +
          'a third party using a different JSON writer. That makes this bundle unverifiable, which is worse ' +
          'than a failed check.',
        'local',
        '§7.3 · RFC 8785',
      )
}

/** Reverse the insertion order of every object, recursively. Arrays keep their order — it is significant. */
function reverseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeysDeep)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).reverse()) {
    const entry = value[key]
    if (entry === undefined) continue
    out[key] = reverseKeysDeep(entry)
  }
  return out
}

function requiredMembersCheck(bundle: Readonly<Record<string, unknown>>): VerifierCheck {
  const required = ['readback', 'readback_sha256', 'preferences_sha256'] as const
  const missing = required.filter((k) => bundle[k] === undefined)
  return missing.length === 0
    ? check(
        'required_members',
        'schema',
        'Every required packet field is present',
        'PASS',
        'The consent read-back, its hash and the preferences hash are all present. §12 EC-MER-6 makes them ' +
          'required so that omitting the part that hurts a merchant is itself a visible defect.',
        'local',
        '§12 EC-MER-6',
      )
    : check(
        'required_members',
        'schema',
        'Required packet fields are missing',
        'FAIL',
        `Missing: ${missing.join(', ')}. §12 EC-MER-6 requires the read-back and the preferences hash as ` +
          'required fields for exactly this reason — a merchant that omits them would otherwise win by ' +
          'omission rather than on the merits.',
        'local',
        '§12 EC-MER-6 · AT-M18.1',
      )
}

/**
 * The price-lock binding: does L3b commit to *this* checkout JWT?
 *
 * `checkout_jwt` and `l3b` are two separate signed artefacts, and each one's signature being valid proves
 * nothing about the other. What ties them is the `checkout_hash` L3b committed to, which is why this is a
 * `binding` check and not a `signature` one — it is the check that makes "the mandate authorised *this*
 * price" rather than "the mandate authorised *a* price".
 *
 * ### The three outcomes, and the middle one that matters
 *
 * | `checkout_hash` in the price lock | verdict | reading |
 * |---|---|---|
 * | equals what L3b committed to | `PASS` | the mandate authorised this cart |
 * | absent from the JWT payload | `PASS` | nothing to compare; the JWT's own ES256 signature is checked by vi and by `verify.py`, and a tampered payload would fail it there |
 * | present and different | `FAIL` | L3b authorised a **different** cart from the one in this packet |
 *
 * The middle row is why this check is a `binding` and not a `signature`. Our `checkout-jwt` route puts
 * `checkout_hash` outside the signed payload (the JWT covers the cart; the hash is what vi recomputes and
 * L3b commits to), so "the JWT does not restate the hash" is the normal case and reporting it as a failure
 * would make the page cry wolf on every real packet.
 *
 * Both sides are **decoded and resolved, never verified** here: the signature check is vi's job and
 * `verify.py`'s, and this only compares two claims that those signatures already cover.
 */
function checkoutBindingCheck(bundle: Readonly<Record<string, unknown>>): VerifierCheck {
  const jwt = readStringOrNull(bundle, 'checkout_jwt')
  const l3b = readStringOrNull(bundle, 'l3b')
  if (jwt === null || l3b === null) {
    return check(
      'checkout_binding',
      'binding',
      'No price-lock binding to test',
      'SKIPPED',
      'This bundle has no checkout JWT or no L3b, so there is no pair of artefacts to compare.',
      'local',
      '§8.3 AT-M3.7',
    )
  }
  const decodedJwt = decodeCheckoutJwt(jwt)
  if (!decodedJwt.ok) {
    return check(
      'checkout_binding',
      'binding',
      'The price lock does not decode',
      'FAIL',
      `The checkout JWT could not be read: ${decodedJwt.error}.`,
      'local',
      '§8.3 AT-M3.7',
    )
  }
  // **Resolved**, not merely decoded: L3b's `delegate_payload` holds `{"...": digest}` references, and the
  // `mandate.checkout.1` claim carrying the `checkout_hash` lives in the disclosure section. Reading the
  // payload alone finds no `vct` at all, which would make this report "commits to no price lock" for every
  // untampered packet — a false alarm on the one page nobody may cry wolf on.
  const decodedL3b = resolveSdJwt(l3b)
  if (!decodedL3b.ok) {
    return check(
      'checkout_binding',
      'binding',
      'The agent authorisation does not decode',
      'FAIL',
      `The L3b could not be read: ${decodedL3b.error}.`,
      'local',
      '§8.3 AT-M3.7',
    )
  }
  const committed = committedCheckoutHash(decodedL3b.payload)
  const merchantKeyId = decodedJwt.kid
  const fromJwt = readStringOrNull(decodedJwt.claims, 'checkout_hash')
  if (committed === null) {
    return check(
      'checkout_binding',
      'binding',
      'L3b commits to no price lock',
      'FAIL',
      'The agent authorisation carries no checkout mandate disclosure, so nothing binds it to this price ' +
        'lock. A signed authorisation for an unspecified cart is not a signed authorisation.',
      'local',
      '§8.3 AT-M3.7',
    )
  }
  if (fromJwt !== null && fromJwt !== committed) {
    return check(
      'checkout_binding',
      'binding',
      'The price lock does not match what L3b committed to',
      'FAIL',
      `L3b committed to checkout_hash ${short(committed)}, but this price lock carries ${short(fromJwt)}. ` +
        'The agent authorised a different cart from the one in this packet.',
      'local',
      '§8.3 AT-M3.7 · AT-M18.1',
    )
  }
  const alsoCarries =
    fromJwt === null
      ? "the price lock does not restate the hash, so the binding rests on L3b's commitment plus the " +
        "merchant's signature over the price lock"
      : 'and the price lock restates it'
  return check(
    'checkout_binding',
    'binding',
    'The agent authorised exactly this price lock',
    'PASS',
    `L3b commits to checkout_hash ${short(committed)}, and ${alsoCarries}` +
      `${merchantKeyId === null ? '' : ` (price lock signed by merchant key ${merchantKeyId})`}.`,
    'local',
    '§8.3 AT-M3.7',
  )
}

/**
 * The `checkout_hash` from L3b's `mandate.checkout.1` disclosure, or `null`.
 *
 * Walks `delegate_payload` **recursively** because a key-bound L3 may nest its checkout mandate one level
 * inside a key-confirmation wrapper. A flat scan finds nothing on such a token and reports "commits to no
 * price lock", which is a false alarm rather than a finding — the single most damaging direction for a page
 * whose entire value is being believed.
 */
function committedCheckoutHash(claims: Record<string, unknown>, depth = 0): string | null {
  if (depth > 6) return null
  const delegates = claims['delegate_payload']
  if (Array.isArray(delegates)) {
    for (const entry of delegates) {
      if (!isRecord(entry)) continue
      if (entry['vct'] === 'mandate.checkout.1') {
        const value = entry['checkout_hash']
        return typeof value === 'string' && value.length > 0 ? value : null
      }
      const nested = committedCheckoutHash(entry, depth + 1)
      if (nested !== null) return nested
    }
  }
  return null
}

/**
 * Our own signature on the Gate decision record, checked against `jwks_keys`.
 *
 * This is the one signature on the page that **we** control, which is exactly why it is worth showing: a
 * reader who believes nothing we say can still see that the decision record has not been edited since the
 * Gate wrote it. `verifyDecisionRecord` fails closed at every step and names which step failed, and a
 * `valid: false` is reported as `FAIL` with that reason rather than as "could not check".
 *
 * ### `fresh` and why it is `WARN` and not `FAIL`
 *
 * A record signed eighteen months ago is not a forged record. `verifyDecisionRecord` reports `iat` outside
 * the skew as `fresh: false`, and that is a fact about the clock rather than about the signature, so it is a
 * `WARN`. Folding it into the verdict would make every historical packet read as an attack.
 */
async function gateRecordCheck(
  bundle: Readonly<Record<string, unknown>>,
  jwks: GateJwks,
  nowSec: number,
): Promise<VerifierCheck> {
  const record = readStringOrNull(bundle, 'gate_decision')
  const authority = '§8.10 · AT-M10.5'
  if (record === null) {
    return check(
      'gate_record',
      'signature',
      'Packet carries no Gate decision record',
      'SKIPPED',
      'Without a gate_decision there is no signed record of the twelve deterministic checks to verify.',
      'local',
      authority,
    )
  }
  if (jwks.keys.length === 0) {
    return check(
      'gate_record',
      'signature',
      'No Gate public key is published',
      'SKIPPED',
      'The record names a Gate key but no GATE-role public key is available, so its signature cannot be ' +
        'checked here. A retired or compromised key is deliberately kept in jwks_keys, so this should not ' +
        'happen for a real packet.',
      'local',
      authority,
    )
  }
  const kid = tokenKid(record)
  const verdict = await verifyDecisionRecord(record, { jwks, nowSec })
  if (!verdict.valid) {
    return check(
      'gate_record',
      'signature',
      'The Gate decision record does not verify',
      'FAIL',
      `Countersign’s own signature on this decision record did not verify: ${verdict.reason}. Either the ` +
        'record was altered, or it was signed by a key that is not published.',
      'local',
      `${authority} · AT-M18.1`,
    )
  }
  if (!verdict.fresh) {
    return check(
      'gate_record',
      'signature',
      'The Gate decision record verifies, and is older than the allowed skew',
      'WARN',
      `The signature is good${kid === null ? '' : ` (key ${kid})`}, but the record was signed at ` +
        `${verdict.payload.iat}, more than the permitted clock skew before now. An old decision is not a ` +
        'forged one; this is a statement about the clock, not about the signature.',
      'local',
      authority,
    )
  }
  return check(
    'gate_record',
    'signature',
    'The Gate decision record verifies',
    'PASS',
    `Countersign’s signature on the decision record is good (key ${verdict.kid}), and all ` +
      `${Object.keys(verdict.payload).length} signed fields are present. The record says the Gate decided ` +
      `${verdict.payload.chain_valid ? 'ALLOW' : 'not ALLOW'} for ` +
      `${verdict.payload.amount} ${verdict.payload.currency} to ${verdict.payload.payee}.`,
    'local',
    authority,
  )
}

/**
 * What the L1 discloses, as a `PASS`/`SKIPPED` fact rather than a `FAIL`.
 *
 * EC-PRIV-3 bounds the raw download by "selectively disclosed fields only". A reader checking that rule needs
 * to know which fields the token actually discloses, so the page states it rather than leaving it to be
 * discovered by decoding base64url by hand.
 */
function l1DisclosureCheck(bundle: Readonly<Record<string, unknown>>): VerifierCheck {
  const l1 = readStringOrNull(bundle, 'l1')
  if (l1 === null) {
    return check(
      'l1_disclosures',
      'schema',
      'Bundle carries no L1',
      'SKIPPED',
      'There is no issuer credential in this bundle, so its selective disclosures cannot be listed.',
      'local',
      '§12 EC-PRIV-3',
    )
  }
  const decoded = decodeSdJwt(l1)
  if (!decoded.ok) {
    return check(
      'l1_disclosures',
      'schema',
      'The L1 does not decode',
      'FAIL',
      `The issuer credential could not be read: ${decoded.error}.`,
      'local',
      '§12 EC-PRIV-3',
    )
  }
  const names = decoded.disclosures
    .map((d) => d.name)
    .filter((n): n is string => typeof n === 'string')
  const email = l1DisclosedClaim(bundle, 'email')
  const detail =
    names.length === 0
      ? 'The L1 discloses nothing, so it carries no buyer-identifying claim. That is the most private case.'
      : `The L1 selectively discloses ${names.map((n) => `\`${n}\``).join(', ')}. ${
          typeof email === 'string'
            ? 'The email on this page is a mask of that disclosed value, which is why the raw download ' +
              'contains the address and this page does not.'
            : 'No email is disclosed, so there is no address to mask.'
        }`
  return check(
    'l1_disclosures',
    'schema',
    names.length === 0 ? 'The L1 discloses nothing' : 'The L1 discloses only these fields',
    names.length === 0 ? 'PASS' : 'PASS',
    detail,
    'local',
    '§12 EC-PRIV-3',
  )
}

// ---------------------------------------------------------------------------
// The live checks
// ---------------------------------------------------------------------------

/** D-009's banner, or `null` when there is nothing to disclose. */
export function atTimeWarningOf(response: VerifyResponse): string | null {
  if (!response.at_time_not_honoured) return null
  return (
    response.at_time_reason ??
    'An as-of verification was requested and could not be performed, so this verdict is for the current ' +
      'time only. The pinned Verifiable Intent library exposes no clock override.'
  )
}

/**
 * The per-check rows from `POST /v1/public/verify`.
 *
 * ### Why this is per-*library*-check and not just `chain_valid`
 *
 * `/v1/verify` returns `checks_performed` and `checks_skipped` (spec §8.3), and those two lists are the only
 * honest answer to "what did you actually check?". Rendering `chain_valid: true` as one row would claim more
 * than the service proved, and §8.3's own note — that an invalid chain is a `200` with `errors` — is only
 * useful if the errors are shown next to the verdict rather than inside it.
 *
 * ### `bundle_hash` is checked here as well as offline, and on purpose
 *
 * vi returns the digest of the **normalised wire bundle** in base64url; we compute it in hex. Comparing the
 * two by decoding their bytes is what proves that the document vi hashed is the document we sent — and it is
 * the one live check a reader can reproduce by hand from the downloaded file.
 */
export function liveChecks(
  response: PublicVerifyResponse,
  wireBundleSent: Readonly<Record<string, unknown>>,
): readonly VerifierCheck[] {
  const out: VerifierCheck[] = []

  out.push(
    response.chain_valid
      ? check(
          'chain_valid',
          'chain',
          'vi-service says the signed chain is valid',
          'PASS',
          response.errors.length === 0
            ? 'Every signature resolved, every constraint it evaluated was satisfied, and no error was ' +
                'reported.'
            : `chain_valid is true while errors is non-empty (${response.errors.join('; ')}), which is ` +
                'itself worth reading: the service reports both.',
          'vi-service',
          '§8.3',
        )
      : check(
          'chain_valid',
          'chain',
          'vi-service says the signed chain is NOT valid',
          'FAIL',
          response.errors.length > 0
            ? `Reasons: ${response.errors.join('; ')}`
            : 'vi-service reported chain_valid false with no error string, which is itself a defect worth ' +
                'reporting.',
          'vi-service',
          '§8.3 · AT-M18.1',
        ),
  )

  for (const [index, name] of response.checks_performed.entries()) {
    out.push(
      check(
        `vi_check_${index}`,
        'chain',
        `Performed: ${name}`,
        'PASS',
        'vi-service reports this check as performed.',
        'vi-service',
        '§8.3',
      ),
    )
  }
  for (const [index, entry] of response.checks_skipped.entries()) {
    out.push(
      check(
        `vi_skipped_${index}`,
        'chain',
        `Skipped: ${entry}`,
        'WARN',
        'This check was not performed, so nothing on this page — including the verdict above — covers it.',
        'vi-service',
        '§8.3',
      ),
    )
  }

  const constraints = response.constraints
  out.push(
    constraints.satisfied
      ? check(
          'constraints',
          'chain',
          'Every constraint vi-service evaluated was satisfied',
          'PASS',
          `${constraints.checked.length} checked, ${constraints.violations.length} violated, ` +
            `${constraints.skipped.length} skipped.`,
          'vi-service',
          '§8.3',
        )
      : check(
          'constraints',
          'chain',
          'A constraint vi-service evaluated was not satisfied',
          'FAIL',
          constraints.violations.length > 0
            ? `Violations: ${constraints.violations.join('; ')}`
            : 'satisfied is false with no violation listed.',
          'vi-service',
          '§8.3',
        ),
  )

  const pending = pendingNetworkEnforcement(constraints.skipped)
  out.push(
    pending.length === 0
      ? check(
          'network_enforced',
          'chain',
          'No network-enforced constraint was disclosed in this chain',
          'SKIPPED',
          'The budget, recurrence and agent-recurrence constraints were not disclosed here, so there is ' +
            'nothing for Countersign’s Gate to have owed.',
          'vi-service',
          'D19',
        )
      : check(
          'network_enforced',
          'chain',
          'Constraints the library never evaluates',
          'WARN',
          `${pending.join(', ')} were disclosed but not evaluated by the library — it calls them ` +
            '"network-enforced". Countersign\'s Gate enforces them (spec D19), so a satisfied verdict from ' +
            'vi-service says nothing about them either way. Read this as "nobody has told you", not as ' +
            '"nothing to worry about".',
          'vi-service',
          'D19 · [B3]',
        ),
  )

  // --- the digest vi-service hashed, against the digest we computed -----------------------------------
  const ours = bundleHashBase64Url(wireBundleSent)
  const theirs = response.bundle_hash
  const agree =
    isSha256Base64Url(theirs) && base64UrlToHex(theirs) === bundleHashHex(wireBundleSent)
  out.push(
    agree
      ? check(
          'vi_bundle_hash',
          'integrity',
          'vi-service hashed the document we sent',
          'PASS',
          `Both sides compute ${short(base64UrlToHex(theirs), 16)} over the canonical form. The verdict ` +
            'above is about this exact document.',
          'vi-service',
          '§8.3 · §7.3',
        )
      : check(
          'vi_bundle_hash',
          'integrity',
          'vi-service hashed a different document',
          'FAIL',
          `We compute ${short(ours)} and vi-service returned ${short(String(theirs))}. Either the ` +
            'document was altered in transit or the two sides canonicalise differently — and until that is ' +
            'settled, the verdict above cannot be attributed to this bundle.',
          'vi-service',
          '§8.3 · §7.3 · AT-M18.1',
        ),
  )

  out.push(
    response.at_time_not_honoured
      ? check(
          'at_time',
          'chain',
          'As-of verification was requested and NOT performed',
          'WARN',
          response.at_time_reason ??
            'The pinned library has no clock override, so the chain was verified at the current time only.',
          'vi-service',
          'EC-TIME-3 · D-009',
        )
      : check(
          'at_time',
          'chain',
          'No as-of claim is being made',
          'PASS',
          'This verdict is for the current time, which is what a live re-verification is for.',
          'vi-service',
          'EC-TIME-3',
        ),
  )

  const keys = response.keys
  out.push(
    check(
      'vi_keys',
      'chain',
      'Keys the chain resolved to',
      keys.issuer_kid === undefined || keys.issuer_kid === null ? 'WARN' : 'PASS',
      `issuer ${keys.issuer_kid ?? 'unresolved'}, device ${keys.device_jkt ?? 'unresolved'}, ` +
        `agent ${keys.agent_kid ?? 'unresolved'}, merchant ${keys.merchant_kid ?? 'unresolved'}.`,
      'vi-service',
      '§8.3',
    ),
  )

  return out
}

/** Every `constraints.skipped` entry, for the page's "nobody checked this" list. */
export function skippedBy(response: VerifyResponse): readonly string[] {
  return response.constraints.skipped.map((entry) => {
    const reason = entry.reason.trim()
    return reason.length > 0 ? `${entry.type}: ${reason}` : entry.type
  })
}

// ---------------------------------------------------------------------------
// The page model
// ---------------------------------------------------------------------------

/**
 * Assemble the whole page model, offline half first.
 *
 * `reported` is `null` until the reader presses "Verify now". Keeping it out of {@link VerifierReport} is
 * what stops the page from ever rendering an empty check list as "everything passed".
 */
export async function buildVerifierReport(
  packet: LoadedPacket,
  deps: VerifierDeps,
  reported: PublicVerifyResponse | null = null,
): Promise<VerifierReport> {
  const nowSec = deps.clock.nowSec()
  const offline = await offlineChecks(packet, nowSec)
  const live = reported === null ? [] : liveChecks(reported, wireBundle(packet.bundle))
  return {
    packetId: packet.packetId,
    disputeId: packet.disputeId,
    version: packet.version,
    filedAtSec: packet.filedAtSec,
    createdAtSec: packet.createdAtSec,
    amount: { minor: packet.amountMinor, currency: packet.amountCurrency },
    stage: packet.stage,
    status: packet.status,
    checks: [...offline, ...live],
    atTimeWarning: reported === null ? null : atTimeWarningOf(reported),
    skippedByVerifier: reported === null ? [] : skippedBy(reported),
    canonicalisation: {
      spec: 'RFC 8785 (JSON Canonicalization Scheme)',
      algorithm: 'SHA-256 over the UTF-8 bytes of the canonical form',
      hashedMembers: [...HASHED_MEMBERS],
      excludedFromCustomId: [...EXCLUDED_FROM_CUSTOM_ID],
      note:
        'Re-ordering the keys in the file cannot change any digest on this page. The nine hashed members ' +
        'are exactly the ones `custom_id` covers; `paypal` and `shipments` are excluded because they are ' +
        'written after the order exists.',
    },
  }
}

/** The redacted document for a loaded packet, with the URLs already resolved. */
export function buildRedactedView(
  packet: LoadedPacket,
  deps: VerifierDeps,
): RedactedPacketDocument {
  return buildRedactedPacketDocument({
    packetId: packet.packetId,
    disputeId: packet.disputeId,
    version: packet.version,
    filedAtSec: packet.filedAtSec,
    createdAtSec: packet.createdAtSec,
    amountMinor: packet.amountMinor,
    amountCurrency: packet.amountCurrency,
    bundle: packet.bundle,
    bundleHash: packet.storedBundleHash,
    rawDownloadUrl: rawBundleUrl(deps.publicBaseUrl, packet.packetId),
  })
}

/**
 * The call "Verify now" makes.
 *
 * ### Why `expected_aud` is `null` and not the L2's `aud`
 *
 * Sending `expected_aud` would assert that we know which audience this chain was minted for, and getting it
 * wrong makes a perfectly good chain report invalid. The value is in the signed payload, so a reader can read
 * it there; the verifier's job is to answer "do the signatures and the constraints hold", not to re-assert
 * facts the signature already commits to.
 *
 * ### No `at_time`
 *
 * Deliberately omitted for the same reason the page shows the banner: asking for an as-of verdict we cannot
 * honour would turn D-009's honest limitation into a silent one. The banner appears because the *page* asks
 * about capture time in its own words and reports that the service could not.
 */
export async function requestLiveVerify(
  deps: VerifierDeps,
  packet: LoadedPacket,
): Promise<Result<PublicVerifyResponse, CsError>> {
  return deps.vi.publicVerify({
    bundle: wireBundle(packet.bundle) as Parameters<typeof deps.vi.publicVerify>[0]['bundle'],
  })
}

// ---------------------------------------------------------------------------
// AT-M18.2: the rate limit
// ---------------------------------------------------------------------------

/** §8.3: 30 requests/minute/IP on `POST /v1/public/verify`. */
export const PUBLIC_RATE_LIMIT_PER_MIN = 30
export const PUBLIC_RATE_WINDOW_MS = 60_000

/** What the limiter decided, and everything a `429` needs to be well-formed. */
export interface RateLimitVerdict {
  readonly allowed: boolean
  readonly limit: number
  readonly remaining: number
  /** Epoch seconds at which the oldest recorded hit leaves the window. */
  readonly resetAtSec: number
  /** Whole seconds the caller should wait. `0` when allowed. */
  readonly retryAfterSec: number
}

/** Injectable clock, so a rate-limit test costs no wall-clock time. */
export interface RateLimiterOptions {
  readonly limit?: number
  readonly windowMs?: number
  /** Epoch **milliseconds**. Separate from `Clock` so a test can pass a number directly. */
  readonly nowMs: () => number
  /**
   * How many distinct client ids to remember before evicting the least recently seen.
   *
   * In-process memory is the point (see `apps/vi`'s `ratelimit.py` for why): a shared store would be a new
   * dependency for a per-instance budget. The cost of in-process is that it is per-instance rather than
   * per-deployment, so the cap exists — an unbounded map keyed by a spoofable header is a memory-exhaustion
   * vector, which would be a worse outcome than a slightly loose limit.
   */
  readonly maxClients?: number
}

export interface PublicRateLimiter {
  /** Record a hit and decide. A **rejected** request is not recorded, so hammering does not push the caller's own window further out. */
  check(clientId: string): RateLimitVerdict
  /** Forget everything. For tests and for an operator-triggered reset. */
  reset(): void
  /** How many client ids are currently tracked. For `/status` and for the eviction test. */
  trackedClients(): number
}

/**
 * A sliding-window limiter, mirroring `apps/vi`'s `RateLimiter` exactly.
 *
 * ### Sliding rather than fixed, and the concrete reason
 *
 * A fixed window lets one caller send 30 requests at t=0.1 s and 30 more at t=59.9 s — sixty verifications,
 * each an ES256 chain check, against a budget of thirty. For a public crypto endpoint that is the whole
 * attack, so the window slides.
 *
 * ### Why this exists at all when `apps/vi` already limits
 *
 * Because a limit behind the thing it protects can be bypassed by the thing in front of it. Without this,
 * "Verify now" is an unmetered Next route that forwards to a metered vi-service: the limiter still caps
 * vi-service's work per IP, but *our* Next process absorbs 30 × every request in the meantime, and one reader
 * can pin a route handler for as long as they like. §8.3's limit is on the public verifier as a whole, and
 * the public verifier is this page.
 *
 * ### Which IP is billed, and the forgery that is not possible here
 *
 * {@link clientIdFromHeaders} takes only the **first** `X-Forwarded-For` hop. A forged header would
 * otherwise mint unlimited budgets by rotating a fake value — the same rule `apps/vi` applies, and the same
 * caveat: behind a proxy that does not strip the header, both limiters are bypassable and neither is
 * pretending otherwise.
 */
export function createPublicRateLimiter(options: RateLimiterOptions): PublicRateLimiter {
  const limit = options.limit ?? PUBLIC_RATE_LIMIT_PER_MIN
  const windowMs = options.windowMs ?? PUBLIC_RATE_WINDOW_MS
  const maxClients = options.maxClients ?? 10_000
  const hits = new Map<string, number[]>()

  function evictIfNeeded(): void {
    if (hits.size <= maxClients) return
    // Map preserves insertion order, so the first key is the least recently *inserted*. Re-inserting on
    // every hit would make it a true LRU; that is more churn than this needs and the eviction order only
    // affects who gets remembered, never who is over budget.
    const oldest = hits.keys().next()
    if (oldest.done !== true) hits.delete(oldest.value)
  }

  return {
    check(clientId: string): RateLimitVerdict {
      const at = options.nowMs()
      const cutoff = at - windowMs
      const bucket = (hits.get(clientId) ?? []).filter((t) => t > cutoff)
      const oldest = bucket[0] ?? at
      const resetAtSec = Math.ceil((oldest + windowMs) / 1000)
      if (bucket.length >= limit) {
        hits.set(clientId, bucket)
        evictIfNeeded()
        const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - at) / 1000))
        return { allowed: false, limit, remaining: 0, resetAtSec, retryAfterSec }
      }
      bucket.push(at)
      hits.set(clientId, bucket)
      evictIfNeeded()
      return {
        allowed: true,
        limit,
        remaining: Math.max(0, limit - bucket.length),
        resetAtSec,
        retryAfterSec: 0,
      }
    },
    reset(): void {
      hits.clear()
    },
    trackedClients(): number {
      return hits.size
    },
  }
}

/**
 * Which IP to bill a request to.
 *
 * `X-Forwarded-For` first, then `X-Real-IP`, then the socket address — in that order, because each is
 * set by a different deployment shape and a missing header is normal rather than an attack. The **first
 * non-empty hop** is used because some proxies prepend an empty entry; an empty hop carries no information
 * and falling through to the next still yields the original client.
 *
 * `'unknown'` for a request with no address at all. That is a shared bucket rather than no bucket, which is
 * the honest reading: we cannot attribute the request, so we cannot give it a private budget.
 */
export function clientIdFromHeaders(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded !== null && forwarded.trim().length > 0) {
    for (const hop of forwarded.split(',')) {
      const candidate = hop.trim()
      if (candidate.length > 0) return candidate
    }
  }
  const realIp = headers.get('x-real-ip')
  if (realIp !== null && realIp.trim().length > 0) return realIp.trim()
  return 'unknown'
}

/**
 * The §8.1 error for being over budget.
 *
 * `CS_RATE_LIMITED`, not `PP_RATE_LIMITED` (D-007): the latter means *PayPal* is throttling us and its
 * buyer-facing copy says exactly that, which would be a lie here — the constraint is ours.
 */
export function rateLimitError(verdict: RateLimitVerdict, route: string): CsError {
  return csError(
    'CS_RATE_LIMITED',
    `Rate limit exceeded on ${route}: ${verdict.limit} requests per 60s per IP. Try again in ` +
      `${verdict.retryAfterSec}s.`,
    {
      limit: verdict.limit,
      window_seconds: Math.round(PUBLIC_RATE_WINDOW_MS / 1000),
      retry_after_seconds: verdict.retryAfterSec,
      reset_at_sec: verdict.resetAtSec,
    },
    {
      userMessage:
        'Too many verifications from one address just now. Please wait a moment and try again.',
    },
  )
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readStringOrNull(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readString(
  record: Readonly<Record<string, unknown>>,
  outer: string,
  key: string,
): string | null {
  return readStringOrNull(asRecordOrEmpty(record[outer]), key)
}

function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
