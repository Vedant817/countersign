/**
 * The evidence bundle as a **document a third party can hash** — spec **§7.3**, **§7.2**, decision
 * **D18**, work package **WP-18**.
 *
 * ## Canonicalisation, stated once and precisely
 *
 * Both digests in this system are taken over the **RFC 8785 (JCS)** canonical form of a JSON value:
 *
 * - object keys sorted by UTF-16 code unit at **every** level,
 * - no insignificant whitespace (`,` and `:` separators only),
 * - `undefined` dropped rather than serialised as `null`,
 * - **no floats.** A float would make the digest depend on a formatting decision, and there are none in
 *   this system because money is integer minor units (EC-FX-6).
 *
 * The serialiser itself is `canonicalJson` from **`@countersign/db`**, not a local copy, and that is the
 * load-bearing decision in this file: `packages/orders` derives `custom_id` with it
 * (`orders/src/create.ts::customIdForBundle`), `packages/defender` derives `evidence_packets.bundle_hash`
 * with it (`defender/src/ingest.ts::bundleHashFor`), and `apps/vi` reimplements the same rules in Python
 * (`vi_service/verify.py::_jcs`). Two implementations of JCS would be two digests for one document, and
 * the entire purpose of the hash is that a reader with a shell and `sha256` gets the same answer we do.
 * `test/bundle.test.ts` pins the byte form against a hard-coded expectation **and** asserts key-reordering
 * stability, because a hash that depended on key order would not be verifiable by a third party — which
 * would defeat the only purpose of this page.
 *
 * ## Two digests, two preimages, and the trap in confusing them
 *
 * | Digest | Preimage | Encoding | Who writes it | Who checks it |
 * |---|---|---|---|---|
 * | `evidence_packets.bundle_hash` | the **whole** stored bundle | **hex** | `packages/defender` | this page |
 * | `custom_id`'s payload | the **nine-member core** (§7.3, minus `paypal` and `shipments`) | **base64url** | `packages/orders`, into PayPal's own order record | this page, and PayPal |
 *
 * They are different digests over different preimages, and that is not an accident:
 *
 * - `paypal` and `shipments` are added **after** the order exists, so they cannot be inside the `custom_id`
 *   preimage — §7.3 says so in as many words, and `EVIDENCE_BUNDLE_EXCLUDED_MEMBERS` is the machine
 *   -readable form of that sentence.
 * - The stored `bundle_hash` covers everything, because its job is "is this the document we published?",
 *   not "did this order exist at purchase time?".
 *
 * ### A divergence this file reports rather than hides
 *
 * `apps/vi` returns `bundle_hash` in **base64url** while `evidence_packets.bundle_hash` is **hex**. Same
 * 32 bytes, different encoding — `verify-view.ts` compares them by decoding, so the two services cannot
 * silently disagree about the digest. Reported in `README.md` under contract issues.
 *
 * ## What this file deliberately does **not** do
 *
 * It does not verify a signature. It reads bytes and recomputes digests. The signature checks live in
 * `verify-view.ts` (against `@countersign/gate`) and in the downloaded `verify.py` (against the pinned
 * library), and keeping them apart is what lets a test drive this file with no keys at all.
 */

import { createHash } from 'node:crypto'

import { canonicalJson } from '@countersign/db'

/** §7.3's version tag. Bumping it invalidates every verifier, so it is a constant (`@countersign/core`). */
export const BUNDLE_VERSION = 'cs1' as const

/**
 * The nine members `custom_id`'s preimage covers, in §7.3's order.
 *
 * Mirrors `packages/orders`' `EVIDENCE_BUNDLE_HASHED_MEMBERS` and is re-declared here rather than
 * imported because `packages/orders` is not a dependency of this package (adding one is a `package.json`
 * change this work package does not own, and `packages/defender` declined it for the same reason). The
 * duplication is *tested*, not trusted: `test/bundle.test.ts` recomputes `custom_id` from this list for a
 * captured chain and compares it with the shape §7.3 states, and asserts the list is exactly nine long.
 */
export const HASHED_MEMBERS = Object.freeze([
  'v',
  'l1',
  'l2',
  'l3a',
  'l3b',
  'checkout_jwt',
  'gate_decision',
  'webauthn',
  'vi_lib_commit',
] as const)

/** The members of the full §7.3 bundle that are **excluded from `custom_id`**, and why. */
export const EXCLUDED_FROM_CUSTOM_ID = Object.freeze(['paypal', 'shipments'] as const)

/**
 * Members this package adds to a packet bundle that are **not** in §7.3.
 *
 * They exist because of specific requirements, and each one is listed so a reader can see exactly what is
 * extra:
 *
 * | Member | Required by | Why it may be present |
 * |---|---|---|
 * | `readback` | §12 **EC-MER-6** | The plain-English consent the user actually signed. A merchant who omits the read-back that hurts them would otherwise win by omission. |
 * | `readback_sha256` | §12 **EC-MER-6** | The digest of the read-back, so the omission is detectable rather than merely arguable. |
 * | `preferences` | §8.8, EC-MER-6 | The size/colour/model preferences. Unsigned by design (§8.8 says so) but present so a chargeback analyst can see what was on the record. |
 * | `preferences_sha256` | §12 **EC-MER-6** | Same anti-omission property for the preferences block. |
 * | `buyer` | §8.18, §12 **EC-PRIV-3** | What the redactor masks and the raw download discloses. Never hashed into `custom_id`: it is not in §7.3 and the PayPal order must not depend on it. |
 * | `notes` / `citations` / `citation_check` | §8.15 | The filed narrative and the fact-check report. Evidence, not chain material. |
 * | `dispute_id`, `version`, `filed_at` | §7.2 | Packet metadata, mirrored from the row. |
 *
 * None of these change `custom_id`: {@link canonicalBundleCore} picks the nine named members by name, so a
 * tenth member in the stored document cannot reach the hash a PayPal order was created with.
 */
export const PACKET_ONLY_MEMBERS = Object.freeze([
  'readback',
  'readback_sha256',
  'preferences',
  'preferences_sha256',
  'buyer',
  'notes',
  'citations',
  'citation_check',
  'dispute_id',
  'version',
  'filed_at',
] as const)

/**
 * The nine-member core, as an object in §7.3's order.
 *
 * Absent members are **omitted**, not set to `null`. `canonicalJson` drops `undefined`, so omitting and
 * `null` are genuinely different preimages — and they must be: `"an assertion at the epoch zero"` and
 * `"no assertion"` are different facts, and a bundle that hashed them the same would let one be presented
 * as the other.
 *
 * @throws `TypeError` when the input carries a value `canonicalJson` refuses (a float, a function). That
 * is a caller bug, not a runtime condition, and a loud throw beats a digest computed over a guess.
 */
export function canonicalBundleCore(
  bundle: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const core: Record<string, unknown> = {}
  for (const key of HASHED_MEMBERS) {
    const value = bundle[key]
    if (value === undefined) continue
    core[key] = value
  }
  return core
}

/** The canonical form, as a string. This is the exact byte sequence both digests are taken over. */
export function canonicalBundleJson(value: unknown): string {
  return canonicalJson(value)
}

/** `sha256` of a UTF-8 string, hex, lowercase. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `sha256` of a UTF-8 string, unpadded base64url. */
export function sha256Base64Url(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64url')
}

/**
 * `evidence_packets.bundle_hash` — `sha256(canonicalJson(bundle))` in **hex**.
 *
 * The preimage is the **whole** bundle as stored. This is the digest `packages/defender` writes and the
 * one a reader compares against, and it is what "is this the document you published?" means.
 */
export function bundleHashHex(bundle: Readonly<Record<string, unknown>>): string {
  return sha256Hex(canonicalJson(bundle))
}

/**
 * The same digest in **base64url** — the encoding `POST /v1/public/verify` returns as `bundle_hash`.
 *
 * Kept as a separate export rather than a formatting flag so a call site has to say which of the two it
 * means. Conflating them is the mistake `verify-view.ts` exists to catch.
 */
export function bundleHashBase64Url(bundle: Readonly<Record<string, unknown>>): string {
  return sha256Base64Url(canonicalJson(bundle))
}

/** Base64url → hex, so a base64url digest and a hex digest can be compared as bytes. */
export function base64UrlToHex(value: string): string {
  return Buffer.from(value, 'base64url').toString('hex')
}

/** `true` when `value` is the 43-character unpadded base64url a 32-byte SHA-256 produces. */
export function isSha256Base64Url(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

/** `true` when `value` is a 64-character lowercase hex SHA-256. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * D18: `"cs1:" + base64url(sha256(canonicalJson(core)))`, 47 characters.
 *
 * Unpadded base64url of 32 bytes is exactly 43 characters, which is what
 * `core`'s `schemas.customIdSchema` asserts (`/^cs1:[A-Za-z0-9_-]{43}$/`) and what PayPal's
 * `custom_id` accepts (1–255 [V11]). A verifier needs nothing but `sha256` and `base64url`.
 *
 * ### Why this re-derives rather than re-uses `packages/orders`
 *
 * `packages/orders` owns the *writing* of `custom_id` and this package must not become a second writer.
 * But a **reader** has to recompute it, or it cannot check anything — and §7.3 publishes the preimage rule
 * precisely so a third party can. The preimage is built from {@link HASHED_MEMBERS}, which the test
 * asserts equals `packages/orders`' list member for member.
 *
 * @returns `null` rather than throwing when the bundle's `v` is not `cs1`. An unknown version is a
 * different preimage rule, so returning a `cs1:`-shaped string for one would be a lie that a reader would
 * check against PayPal and fail.
 */
export function customIdForBundle(bundle: Readonly<Record<string, unknown>>): string | null {
  if (bundle['v'] !== BUNDLE_VERSION) return null
  const digest = sha256Base64Url(canonicalJson(canonicalBundleCore(bundle)))
  return `${BUNDLE_VERSION}:${digest}`
}

/** `sha256` of a UTF-8 string, hex — used for `readback_sha256` and `preferences_sha256` (EC-MER-6). */
export function textSha256Hex(text: string): string {
  return sha256Hex(text)
}

// ---------------------------------------------------------------------------
// SD-JWT reading (decode only — never verification)
// ---------------------------------------------------------------------------

/** One selectively-disclosable claim, as it appears in an SD-JWT's `~`-separated disclosure section. */
export interface SdJwtDisclosure {
  readonly salt: string
  /** The claim name, when the disclosure is the SD-JWT `[salt, name, value]` form. */
  readonly name?: string
  readonly value: unknown
  /** The raw disclosure, so a caller can quote exactly what the token carries. */
  readonly raw: string
}

/** A decoded SD-JWT. `ok: false` carries a sentence rather than a throw (AGENTS.md rule 3). */
export type DecodedSdJwt =
  | {
      readonly ok: true
      readonly header: Record<string, unknown>
      /** The issuer-signed payload, **before** disclosures are resolved. */
      readonly payload: Record<string, unknown>
      readonly disclosures: readonly SdJwtDisclosure[]
    }
  | { readonly ok: false; readonly error: string }

/**
 * Decode an SD-JWT **without verifying anything**.
 *
 * Three things this function deliberately does not do, each of which would make the public verifier lie:
 *
 * 1. **No signature check.** Verification needs the issuer's public key, which lives in vi's keystore and
 *    is published at `GET /v1/jwks`. `verify-view.ts` and `verify.py` do that; this only reads bytes.
 * 2. **No disclosure *resolution*.** Resolving means substituting `..._<salt>` placeholders with values,
 *    which is what the library's `resolve_disclosures` does and what `verify_chain` re-checks. A public
 *    page that resolved them would be asserting an integrity property it has not checked.
 * 3. **No repair.** A disclosure that is not `[salt, name, value]` is reported with `name: undefined`
 *    rather than guessed at, because a hash-bearing SD-JWT disclosure (`[salt, digest]`) and a plain one
 *    (`[salt, name, value]`) are different things and picking the wrong shape would put a digest where a
 *    value belongs.
 */
export function decodeSdJwt(token: string): DecodedSdJwt {
  const trimmed = token.trim()
  const tilde = trimmed.indexOf('~')
  const base = tilde === -1 ? trimmed : trimmed.slice(0, tilde)
  const parts = base.split('.')
  if (parts.length < 2) {
    return {
      ok: false,
      error: `expected at least "header.payload" in an SD-JWT, got ${parts.length} part(s)`,
    }
  }
  const header = decodeSegment(parts[0] ?? '')
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    return { ok: false, error: 'the SD-JWT header is not a JSON object' }
  }
  const payload = decodeSegment(parts[1] ?? '')
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'the SD-JWT payload is not a JSON object' }
  }

  const disclosures: SdJwtDisclosure[] = []
  if (tilde !== -1) {
    const rest = trimmed.slice(tilde + 1)
    for (const raw of rest.split('~')) {
      if (raw.length === 0) continue
      const value = decodeSegment(raw)
      if (!Array.isArray(value) || typeof value[0] !== 'string') {
        disclosures.push({ salt: '', value, raw })
        continue
      }
      const [salt, second, third] = value
      disclosures.push(
        typeof second === 'string'
          ? { salt, name: second, value: third, raw }
          : { salt, value: second, raw },
      )
    }
  }

  return {
    ok: true,
    header: header as Record<string, unknown>,
    payload: payload as Record<string, unknown>,
    disclosures,
  }
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * The value of one **selectively disclosed** claim in the L1, by name.
 *
 * EC-PRIV-3's rule is that the raw-token download "includes selectively disclosed fields only", so this is
 * the *only* legitimate source for a buyer identifier on the public verifier. Reading it out of the L1
 * rather than out of a database column is what makes the redaction honest: a reader can decode the same
 * disclosure and confirm that the masked address on the page is a mask of something the token really
 * carries, and that nothing else was added from elsewhere.
 *
 * Returns `undefined` for an absent claim **and** for an unreadable token, because "we could not read it"
 * and "it is not there" must not be two different redactions.
 */
export function l1DisclosedClaim(bundle: Readonly<Record<string, unknown>>, name: string): unknown {
  const l1 = bundle['l1']
  if (typeof l1 !== 'string' || l1.length === 0) return undefined
  const decoded = decodeSdJwt(l1)
  if (!decoded.ok) return undefined
  for (const disclosure of decoded.disclosures) {
    if (disclosure.name === name) return disclosure.value
  }
  return undefined
}

/** The `kid` in a token's header, or `null`. Used to name **which** key a signature claims to come from. */
export function tokenKid(token: string): string | null {
  const decoded = decodeSdJwt(token)
  if (!decoded.ok) return null
  const kid = decoded.header['kid']
  return typeof kid === 'string' ? kid : null
}

/**
 * A disclosure's digest, as the SD-JWT spec defines it.
 *
 * **The ASCII base64url string is hashed, not the decoded bytes** — `hash_disclosure` in the pinned library
 * hashes `disclosure_b64.encode("ascii")`, and an implementation that hashed the JSON bytes instead would
 * produce digests that match nothing. That is the whole reason this function exists rather than a
 * `JSON.stringify` of the decoded value: matching the library exactly is what makes reference resolution work
 * at all.
 */
export function disclosureDigest(disclosureB64Url: string): string {
  return createHash('sha256').update(disclosureB64Url, 'ascii').digest('base64url')
}

/**
 * Resolve a token's `{"...": digest}` references against its disclosure section.
 *
 * ### Why this is here and not left to `vi`
 *
 * `apps/vi` resolves these with `vi_service/l2.py::resolve_disclosure_refs`, and the reason it exists there
 * is worth repeating because it applies here too: `check_constraints` cannot match a payee against a
 * reference, and a constraint that silently degrades to "skipped" is a **pass on an unchecked constraint**.
 *
 * Here the reference we must resolve is different and simpler: L3b's `delegate_payload` carries
 * `{"...": "73-FHEa…"}` and the actual `mandate.checkout.1` claim — with its `checkout_hash` — sits in the
 * disclosure section. Reading `delegate_payload` without resolving it finds no `vct` at all, which is exactly
 * the bug `decodeL3` alone would cause: a page that reports "L3b commits to no price lock" for every
 * untampered packet.
 *
 * ### What resolution does **not** do
 *
 * It does not verify anything. The digests are matched and the values substituted; whether those values are
 * covered by the issuer's signature is `verify_chain`'s job, and this page's claim about it comes from
 * vi-service and from the downloaded `verify.py`. A reader who distrusts the substitution can redo it in ten
 * lines, which is the point.
 *
 * Unresolvable references are left **as they are** rather than dropped, so a caller can see that something
 * was claimed and not found — the same "absent is not passing" rule the rest of the page follows.
 */
export function resolveSdJwt(token: string): DecodedSdJwt {
  const decoded = decodeSdJwt(token)
  if (!decoded.ok) return decoded
  const byDigest = new Map<string, SdJwtDisclosure>()
  for (const disclosure of decoded.disclosures) {
    if (disclosure.raw.length > 0) byDigest.set(disclosureDigest(disclosure.raw), disclosure)
  }
  const substituted = substituteRefs(decoded.payload, byDigest)
  return {
    ok: true,
    header: decoded.header,
    // `decodeSdJwt` already established the payload is a plain object, and `substituteRefs` preserves that
    // shape for an object input. The assertion makes the invariant explicit rather than casting blindly.
    payload: substituted as Record<string, unknown>,
    disclosures: decoded.disclosures,
  }
}

/**
 * Replace every `{"...": digest}` with the matching disclosure's value, recursively.
 *
 * Depth-limited so a pathological document — a disclosure whose value contains a reference to itself — cannot
 * spin. The limit is far above anything SD-JWT produces (real chains nest two levels: mandate → constraint →
 * acceptable item).
 */
function substituteRefs(
  value: unknown,
  byDigest: ReadonlyMap<string, SdJwtDisclosure>,
  depth = 0,
): unknown {
  if (depth > 8) return value
  if (Array.isArray(value)) return value.map((entry) => substituteRefs(entry, byDigest, depth + 1))
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const marker = record['...']
  if (typeof marker === 'string' && Object.keys(record).length === 1) {
    const found = byDigest.get(marker)
    // Left unresolved on purpose: see the function's note. A dropped reference would look like an absent
    // claim, and "absent" reads as "nothing to worry about".
    return found === undefined ? record : substituteRefs(found.value, byDigest, depth + 1)
  }
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (entry === undefined) continue
    out[key] = substituteRefs(entry, byDigest, depth + 1)
  }
  return out
}

// ---------------------------------------------------------------------------
// The raw download document
// ---------------------------------------------------------------------------

/** What {@link buildRawBundleDocument} needs. */
export interface RawBundleInput {
  readonly packetId: string
  readonly disputeId: string
  readonly version: number
  /** `evidence_packets.bundle_hash`, hex. */
  readonly bundleHash: string
  readonly bundle: Readonly<Record<string, unknown>>
  /** `filed_at` in epoch seconds, or `null`. */
  readonly filedAtSec: number | null
  /** The pinned Verifiable Intent commit, for the reader's own record. */
  readonly viLibCommit: string
  /**
   * Public keys the reader needs to verify the signatures offline.
   *
   * **Public halves only** — §7.2's `jwks_keys.public_jwk`. There is no private key anywhere in this system
   * outside a browser's non-extractable keystore or vi's in-memory registry, and the offline script needs the
   * issuer and merchant keys because `verify_chain` takes them as arguments.
   */
  readonly publicKeys: readonly {
    readonly kid: string
    readonly role: string
    readonly public_jwk: Record<string, unknown>
  }[]
  /** `gate_decision`'s `kid`, so the reader knows which Gate key to check the record against. */
  readonly gateKid: string | null
}

/** The document served by `/v/{packetId}/download`. */
export interface RawBundleDocument {
  readonly doc: 'countersign-evidence-bundle'
  readonly docVersion: 1
  readonly generated_by: string
  readonly packet: {
    readonly id: string
    readonly dispute_id: string
    readonly version: number
    readonly filed_at: number | null
  }
  /** §7.3's bundle, byte for byte as stored. This is the preimage of `bundle_hash`. */
  readonly bundle: Record<string, unknown>
  /** Hex — the form `evidence_packets.bundle_hash` stores. */
  readonly bundle_hash: string
  /** base64url — the form `POST /v1/public/verify` returns, over the same digest. */
  readonly bundle_hash_base64url: string
  /** D18, recomputed by us. A reader recomputes it too and compares. */
  readonly custom_id: string | null
  /** EC-MER-6's two required hashes, echoed so the offline script has something to check against. */
  readonly readback_sha256: string | null
  readonly preferences_sha256: string | null
  /** The pinned library commit, so an old packet verifies against the code that actually ran. */
  readonly vi_lib_commit: string
  /** Public keys. No private key exists to publish. */
  readonly public_keys: readonly {
    kid: string
    role: string
    public_jwk: Record<string, unknown>
  }[]
  readonly gate_kid: string | null
  /** Everything a third party needs in order to reproduce a digest. */
  readonly canonicalisation: {
    readonly spec: string
    readonly algorithm: string
    readonly hashed_members: readonly string[]
    readonly excluded_from_custom_id: readonly string[]
    readonly bundle_hash_preimage: string
    readonly custom_id_preimage: string
    readonly note: string
  }
  /** What to do with this file. */
  readonly instructions: {
    readonly verify_py: string
    readonly live_verify: string
    readonly note: string
  }
}

/**
 * Build the raw download document — §8.18's "raw tokens downloadable".
 *
 * ### The two-document property, made concrete
 *
 * This is the *other half* of EC-PRIV-3's design. The redacted page
 * (`redact.ts::buildRedactedPacketDocument`) and this function share no code, no object and no field: the
 * page's document has `artefacts[].sha256` where this one carries the token strings themselves.
 * `test/redact.test.ts` asserts the separation in both directions — nothing raw in the page, nothing
 * redacted-and-lossy in the download.
 *
 * ### What this document deliberately does **not** add
 *
 * - **No re-serialisation of the tokens.** `bundle` is the stored object, not a re-encoding. A round trip
 *   through a re-encoder would change bytes a signature covers, and the reader would then be checking a
 *   document we manufactured rather than the one we filed.
 * - **No `notes`.** `evidence_packets.notes` is the merchant's narrative *to PayPal*. It is not part of the
 *   signed chain and nothing hashes it, so putting it in a file whose purpose is "check this independently"
 *   would mix a claim in with the evidence for it. A chargeback analyst reads the notes in the filed packet,
 *   which is where PayPal reads them too.
 * - **No amounts.** Nothing in this document needs one, and §0 plus EC-PRIV-3 both say keep money out of a
 *   public document unless it is the thing being proved.
 */
export function buildRawBundleDocument(input: RawBundleInput): RawBundleDocument {
  const bundle: Record<string, unknown> = { ...input.bundle }
  return {
    doc: 'countersign-evidence-bundle',
    docVersion: 1,
    generated_by: 'Countersign public verifier · spec §8.18 · EC-PRIV-3',
    packet: {
      id: input.packetId,
      dispute_id: input.disputeId,
      version: input.version,
      filed_at: input.filedAtSec,
    },
    bundle,
    bundle_hash: input.bundleHash,
    bundle_hash_base64url: bundleHashBase64Url(bundle),
    custom_id: customIdForBundle(bundle),
    readback_sha256: readString(bundle, 'readback_sha256'),
    preferences_sha256: readString(bundle, 'preferences_sha256'),
    vi_lib_commit: input.viLibCommit,
    public_keys: input.publicKeys,
    gate_kid: input.gateKid,
    canonicalisation: {
      spec: 'RFC 8785 (JSON Canonicalization Scheme)',
      algorithm: 'SHA-256 over the UTF-8 bytes of the canonical form',
      hashed_members: [...HASHED_MEMBERS],
      excluded_from_custom_id: [...EXCLUDED_FROM_CUSTOM_ID],
      bundle_hash_preimage:
        'The whole `bundle` member above, canonicalised. Recompute it and compare with `bundle_hash`.',
      custom_id_preimage:
        'A new object containing only `hashed_members`, canonicalised. That digest, in unpadded base64url, ' +
        'is what follows "cs1:" in `custom_id`.',
      note:
        'Keys are sorted at every level and there is no insignificant whitespace, so the digest does not ' +
        'depend on the order the keys happen to appear in. Re-ordering them must not change the hash; a ' +
        'test asserts exactly that, because a hash that depended on key order could not be recomputed by a ' +
        'third party — which would defeat this page’s only purpose.',
    },
    instructions: {
      verify_py: 'Save verify.py next to this file and run: uv run python verify.py bundle.json',
      live_verify:
        'Or POST the `bundle` member to our POST /v1/public/verify for the same verdict.',
      note:
        'Everything this file claims can be checked with sha256, base64url and the pinned Verifiable ' +
        'Intent library. No Countersign server is involved in any of it.',
    },
  }
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

// ---------------------------------------------------------------------------
// The wire form sent to vi-service
// ---------------------------------------------------------------------------

/**
 * The seven members `apps/vi`'s `EvidenceBundle` declares, always present, `null` for the optional ones.
 *
 * ### Why this normalisation exists at all
 *
 * `apps/vi`'s pydantic model is `extra="allow"` with every optional member defaulted to `None`, so
 * `req.bundle.model_dump()` emits `l3b: null` even when the caller never sent one. `model_dump()` is what
 * `public_verify` hashes, so if we sent a bundle that *omitted* `l3b`, vi would hash a document with
 * `"l3b":null` in it and return a `bundle_hash` that could not be reproduced from what we sent.
 *
 * Sending the normalised form makes `vi`'s `model_dump()` byte-identical to our request body, which is what
 * lets `verify-view.ts` treat "vi's `bundle_hash` equals our recomputed digest" as a real check rather than
 * a coincidence. Pydantic keeps extras in `model_dump()`, so `paypal`, `shipments`, `buyer` and the
 * EC-MER-6 members travel through and are hashed too.
 */
export function wireBundle(bundle: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of [
    'v',
    'l1',
    'l2',
    'l3a',
    'l3b',
    'checkout_jwt',
    'gate_decision',
    'vi_lib_commit',
  ] as const) {
    const value = bundle[key]
    out[key] = value === undefined ? null : value
  }
  for (const [key, value] of Object.entries(bundle)) {
    if (key in out) continue
    // Extras keep `canonicalJson`'s own rule: an `undefined` is dropped, not turned into `null`. Only the
    // members vi *declares* are normalised, because only those have a pydantic default that will appear.
    if (value === undefined) continue
    out[key] = value
  }
  return out
}
