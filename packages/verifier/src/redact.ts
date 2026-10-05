/**
 * EC-PRIV-3: what the public verifier serves, and what it refuses to.
 *
 * Spec **§8.18**: "Shows a redacted bundle: email masked, address city/country only, raw tokens
 * downloadable." §12 **EC-PRIV-3** spells out the redaction rule and adds the constraint that decides this
 * file's whole design: *the raw-token download includes **selectively disclosed** fields only (SD-JWT)*.
 *
 * ## The trap, and why the design is two documents
 *
 * The natural implementation — load the bundle, render a masked view, hide the rest with CSS — fails
 * silently and catastrophically. The raw `l1` is a **string in the same JSON** the page renders, so
 * `view-source` prints it, and the buyer's email comes straight out of the L1's disclosure
 * (`IssuerCredential(email=…)` is issued as a selectively disclosable claim by
 * `apps/vi/src/vi_service/l1.py`). No amount of styling hides a JSON string.
 *
 * So this module builds a **different document**, member by member, and never spreads the bundle:
 *
 * | | `buildRedactedPacketDocument` (here) | `buildRawBundleDocument` (`bundle.ts`) |
 * |---|---|---|
 * | contains the raw L1/L2/L3 | **no** | yes, byte for byte |
 * | contains the buyer's email | only as `a***@domain` | only if the L1 discloses it (EC-PRIV-3) |
 * | contains a street address | **never** | as disclosed |
 * | served by | `apps/web/app/v/[packetId]/page.tsx` | `apps/web/app/v/[packetId]/download/route.ts` |
 *
 * And the last row is the part that is a *test* rather than a convention: `test/redact.test.ts` calls both
 * builders on the same packet and asserts that the redacted document's serialised bytes contain **none** of
 * the raw material — not the token strings, not the email, not the `payer_id`, not the street line.
 *
 * ## The belt-and-braces guard
 *
 * {@link assertRedactionHolds} is exported and called by the page route on every render. It re-scans the
 * finished redacted document for the raw strings and returns a `Result`. So if a later change adds a member
 * to the redacted builder that leaks, the route **fails loudly** rather than publishing the buyer's address.
 * A redaction policy enforced only by the discipline of whoever writes the next field is not a policy.
 *
 * ## What the raw download legitimately contains
 *
 * EC-PRIV-3 accepts the raw tokens *because* SD-JWT selectively discloses: an L1 discloses the email (the
 * vendor asked for it) and an L2 discloses only the mandate claims the merchant and the network each need.
 * The download is therefore bounded by the **token format**, not by a filter we wrote — a stronger guarantee
 * than a hand-maintained deny-list, because `verify_chain` enforces it rather than us.
 */

import { csError, err, ok, type CsError, type Result } from '@countersign/core'

import { EXCLUDED_FROM_CUSTOM_ID, HASHED_MEMBERS, l1DisclosedClaim, sha256Hex } from './bundle'

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/** What §12 EC-PRIV-3 writes, as a rule: first character, three stars, the domain. */
const EMAIL_LOCAL_VISIBLE = 1
const MASK = '***'

/**
 * `asha.rao@northwind-buyer.example` → `a***@northwind-buyer.example`.
 *
 * The domain survives deliberately, and the reason is utility rather than laziness: a chargeback analyst
 * matching this packet against a PayPal record needs to recognise that the address is the one on the
 * order, and `a***@northwind-buyer.example` still says that. What it cannot do is identify a person to a
 * third party who does not already know the address.
 *
 * ### Three shapes it refuses, rather than passing through
 *
 * - **No `@`** → `'***'`. A string with no `@` is not an address, and emitting it verbatim would put an
 *   arbitrary identifier (a `payer_id`, an order id) into a field a reader reads as "an email".
 * - **`@` at position 0** (`@corp.example`) → `'***@corp.example'`: there is no local part to reveal, so
 *   revealing zero characters is the only consistent behaviour.
 * - **Empty** → `'***'`, not `''`. An empty string in a "masked email" field reads as "the field was
 *   populated with nothing", which is a more confusing claim than "there was nothing to mask".
 */
export function maskEmail(value: string | undefined | null): string {
  if (typeof value !== 'string') return MASK
  const trimmed = value.trim()
  if (trimmed.length === 0) return MASK
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return MASK
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (domain.length === 0) return MASK
  return `${local.slice(0, EMAIL_LOCAL_VISIBLE)}${MASK}@${domain}`
}

/**
 * An opaque identifier → `P***01`.
 *
 * PayPal's `payer_id` is a short alnum token with no structure to reason about, so this keeps the **first
 * and last two characters** — enough for a human to recognise the same id in two systems, not enough to
 * enumerate anybody's.
 *
 * A short input is masked harder rather than half revealed: anything under six characters becomes
 * `${first}***`, because `'AB'` → `'A***B'` would be the whole value, which defeats the point.
 */
export function maskOpaqueId(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length < 6) return `${trimmed.slice(0, 1)}${MASK}`
  return `${trimmed.slice(0, 2)}${MASK}${trimmed.slice(-2)}`
}

/** City and country, and **nothing else**. §8.18's "address city/country only". */
export interface CityCountry {
  readonly city: string | null
  readonly country: string | null
}

/** The address members this module names so it can state what it is dropping. */
export const ADDRESS_STREET_KEYS = Object.freeze([
  'line1',
  'line2',
  'street',
  'address_line_1',
  'address_line_2',
  'postal_code',
  'postcode',
  'zip',
] as const)

/**
 * Reduce an address to city + country.
 *
 * Takes `unknown` because §7.3's bundle is a jsonb mirror: an address block is an object we did not
 * validate, and a redactor that trusted its shape would throw on the one packet that matters. Every field is
 * read defensively and an unrecognised block yields `{city: null, country: null}` — "we have no address
 * detail", never "we have an address with no fields".
 */
export function addressToCityCountry(address: unknown): CityCountry {
  if (typeof address !== 'object' || address === null || Array.isArray(address)) {
    return { city: null, country: null }
  }
  const record = address as Record<string, unknown>
  return {
    city: pickString(record, ['city', 'town', 'locality']),
    country: pickString(record, ['country', 'country_code', 'countryCode']),
  }
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// ---------------------------------------------------------------------------
// The buyer block, as the redactor sees it
// ---------------------------------------------------------------------------

/**
 * The buyer identity the packet carries, **before** redaction.
 *
 * ### Where each field comes from, and why that matters
 *
 * `payerEmail` is read from the **L1's disclosure**, not from the bundle's `buyer` block. That is the
 * difference between "we masked a value that is in the signed credential" and "we printed something from a
 * database the credential never mentioned". Only the first is checkable by the reader: they decode the L1,
 * find the same disclosure, and can confirm the mask is honest. If the `buyer` block also carries an email,
 * the token's wins — a row we wrote ourselves is not evidence of anything.
 *
 * `payer_id`, `payer_city` and `payer_country` have no signed counterpart, so they come from `buyer`. They
 * are the three §8.18 permits, and they are the only buyer fields this package will read.
 */
export interface BuyerFacts {
  readonly payerEmail: string | null
  readonly payerId: string | null
  readonly payerCity: string | null
  readonly payerCountry: string | null
  /** Whether the email came out of the L1's disclosure section, or out of the `buyer` row. */
  readonly emailFromDisclosure: boolean
}

/** Read the three permitted buyer fields. Never throws; an unreadable block yields nulls. */
export function buyerFactsOf(bundle: Readonly<Record<string, unknown>>): BuyerFacts {
  const block = asRecord(bundle['buyer'])
  const fromL1 = l1DisclosedClaim(bundle, 'email')
  const emailFromDisclosure = typeof fromL1 === 'string' && fromL1.length > 0
  const rowEmail = pickString(block, ['payer_email', 'email'])
  const address = addressToCityCountry(block['address'] ?? block)
  return {
    payerEmail: emailFromDisclosure ? fromL1 : rowEmail,
    payerId: pickString(block, ['payer_id', 'payerId']),
    payerCity: address.city ?? pickString(block, ['payer_city', 'city']),
    payerCountry: address.country ?? pickString(block, ['payer_country', 'country']),
    emailFromDisclosure,
  }
}

// ---------------------------------------------------------------------------
// The redacted document
// ---------------------------------------------------------------------------

/** One chain token as the redacted page describes it: a length and a digest, never the token. */
export interface RedactedArtefact {
  readonly name: 'l1' | 'l2' | 'l3a' | 'l3b' | 'checkout_jwt' | 'gate_decision'
  /** `true` when the packet carries it. */
  readonly present: boolean
  /** UTF-8 byte length, so a reader can see the artefact exists and is of a plausible size. */
  readonly bytes: number | null
  /** `sha256` of the token, hex. Lets a reader confirm *which* token this page is describing. */
  readonly sha256: string | null
  /** What it is, and what verifying it would prove. */
  readonly role: string
}

const ARTEFACT_ROLES: Readonly<Record<RedactedArtefact['name'], string>> = {
  l1: 'The issuer credential. Its signature says who issued the buyer’s wallet binding.',
  l2: 'The user-signed mandate. This is the signature a prompt-injected agent cannot forge.',
  l3a: 'The agent’s payment authorisation, bound to the buyer’s signed spending limit.',
  l3b: 'The agent’s checkout authorisation, bound to this merchant’s price lock.',
  checkout_jwt: 'The merchant-signed price lock. It says what was agreed, and until when.',
  gate_decision:
    'Our Gate’s signed decision record: the twelve deterministic checks and their outcome.',
}

const ARTEFACT_NAMES: readonly RedactedArtefact['name'][] = [
  'l1',
  'l2',
  'l3a',
  'l3b',
  'checkout_jwt',
  'gate_decision',
]

/** What the page says was withheld. Every entry is a fact about the redaction, not about the buyer. */
export const WITHHELD_FROM_VIEW: readonly string[] = [
  'The raw L1, L2, L3a, L3b, checkout JWT and Gate decision record. Byte lengths and SHA-256 digests are ' +
    'shown instead, so you can confirm this page describes the file you downloaded.',
  'The buyer’s email address beyond its first character.',
  'The buyer’s PayPal payer_id beyond two characters at each end.',
  'The street address and the postal code. City and country only.',
  'Any mandate claim the SD-JWT did not selectively disclose. This system never held those.',
]

/**
 * The document the page renders.
 *
 * ### "Constructed, not filtered"
 *
 * Every member below is written out by hand from a named source. There is no `...(bundle as object)` and no
 * `delete`, which is the only way to be sure that a member added to §7.3 next quarter does **not** appear on
 * a public page by default. A filter must be updated to stay safe; a constructor must be updated to stay
 * *useful*, and the failure mode of forgetting is a missing field rather than a leaked one.
 */
export interface RedactedPacketDocument {
  readonly doc: 'redacted-packet-view'
  readonly docVersion: 1
  readonly packet: {
    readonly id: string
    readonly dispute_id: string
    readonly version: number
    readonly filed_at: number | null
    readonly created_at: number
  }
  /** Integer minor units as a string, plus the ISO-4217 code. Never a float, never a symbol. */
  readonly disputed_amount: { readonly minor: string; readonly currency: string }
  readonly buyer: {
    /** EC-PRIV-3's example shape: `a***@…`. */
    readonly payer_email_masked: string
    /** `null` when the packet carries none. Never the value. */
    readonly payer_id_masked: string | null
    readonly city: string | null
    readonly country: string | null
    readonly email_source: 'l1-disclosure' | 'packet-row' | 'none'
  }
  /** §12 EC-MER-6. Present and hashed, so omitting it is visible rather than merely arguable. */
  readonly consent: {
    readonly readback: string | null
    readonly readback_sha256: string | null
    readonly preferences: Record<string, string> | null
    readonly preferences_sha256: string | null
  }
  readonly artefacts: readonly RedactedArtefact[]
  /** §7.3's `paypal` member, `custom_id` intact — it is a digest, and §7.3 and D18 both need it. */
  readonly paypal: {
    readonly order_id: string | null
    readonly capture_ids: readonly string[]
    readonly custom_id: string | null
  } | null
  readonly shipments: readonly {
    readonly carrier: string
    readonly tracking: string
    readonly lines: readonly { readonly sku: string; readonly qty: number }[]
  }[]
  readonly vi_lib_commit: string | null
  /** `evidence_packets.bundle_hash`, hex. Echoed so the page and the download agree on the digest. */
  readonly bundle_hash: string | null
  /** The rule a reader needs in order to recompute any of the above. */
  readonly canonicalisation: {
    readonly spec: string
    readonly algorithm: string
    readonly hashed_members: readonly string[]
    readonly excluded_from_custom_id: readonly string[]
  }
  /** What was withheld, in the reader's own terms. A redaction nobody can see is not a redaction. */
  readonly redacted: {
    readonly withheld: readonly string[]
    readonly raw_download_url: string
    readonly note: string
  }
}

/** What {@link buildRedactedPacketDocument} needs. Deliberately not the whole row. */
export interface RedactedPacketInput {
  readonly packetId: string
  readonly disputeId: string
  readonly version: number
  readonly filedAtSec: number | null
  readonly createdAtSec: number
  readonly amountMinor: bigint
  readonly amountCurrency: string
  readonly bundle: Readonly<Record<string, unknown>>
  /** `evidence_packets.bundle_hash`, hex. */
  readonly bundleHash: string
  /**
   * Absolute URL of the raw download.
   *
   * Passed in rather than computed here so the URL exists in exactly **one** implementation —
   * `verify-view.ts::publicPacketUrl`, which also builds the page's own address. Two implementations of
   * that string is how a QR code ends up pointing at a 404 (§8.15/§8.18's shared helper; see the contract
   * issue in `README.md`).
   */
  readonly rawDownloadUrl: string
}

/**
 * Build the page's document.
 *
 * ### The three hash choices, because "hash the tokens" sounds like overkill and is not
 *
 * `artefacts[].sha256` is a digest of each **raw token**, and its job is to let a reader who has the
 * download confirm that the page is describing *their* copy rather than a different one. A digest is not a
 * redaction — a token is not reversible from one — and it gives the redacted page and the raw download a
 * verifiable join key without the page ever holding the token. That join key is what makes "different code
 * paths" a testable claim rather than an assertion.
 *
 * ### `payer_id_masked` and §8.18
 *
 * §8.18 says "email masked, address city/country only" and does not mention `payer_id`, while §7.2's
 * `paypalWallets` does hold one. Emitting it verbatim would publish a stable per-buyer identifier on an
 * unauthenticated page, so it is masked with the same rule as any other opaque id — and the rule is stated in
 * the page's own "what was withheld" list, because a mask a reader cannot predict is not a privacy control.
 * A reader who needs the real value has the L1's disclosures and PayPal's own record; a reader who needs to
 * know *we* hold one sees that too.
 */
export function buildRedactedPacketDocument(input: RedactedPacketInput): RedactedPacketDocument {
  const bundle = input.bundle
  const buyer = buyerFactsOf(bundle)
  const paypal = asRecord(bundle['paypal'])
  const hasPaypal = typeof bundle['paypal'] === 'object' && bundle['paypal'] !== null

  const artefacts: RedactedArtefact[] = ARTEFACT_NAMES.map((name) => {
    const raw = bundle[name]
    const token = typeof raw === 'string' && raw.length > 0 ? raw : null
    return {
      name,
      present: token !== null,
      bytes: token === null ? null : Buffer.byteLength(token, 'utf8'),
      sha256: token === null ? null : sha256Hex(token),
      role: ARTEFACT_ROLES[name],
    }
  })

  return {
    doc: 'redacted-packet-view',
    docVersion: 1,
    packet: {
      id: input.packetId,
      dispute_id: input.disputeId,
      version: input.version,
      filed_at: input.filedAtSec,
      created_at: input.createdAtSec,
    },
    disputed_amount: {
      // A string, deliberately. `bigint` has no JSON representation, and `Number()` on a minor-unit amount
      // is the exact float-money bug `scripts/check-money-discipline.mjs` exists to catch (§0, EC-FX-6).
      minor: input.amountMinor.toString(),
      currency: input.amountCurrency,
    },
    buyer: {
      payer_email_masked: maskEmail(buyer.payerEmail),
      payer_id_masked: maskOpaqueId(buyer.payerId),
      city: buyer.payerCity,
      country: buyer.payerCountry,
      email_source: buyer.payerEmail
        ? buyer.emailFromDisclosure
          ? 'l1-disclosure'
          : 'packet-row'
        : 'none',
    },
    consent: {
      readback: pickString(bundle, ['readback']),
      readback_sha256: pickString(bundle, ['readback_sha256']),
      preferences: preferencesOf(bundle),
      preferences_sha256: pickString(bundle, ['preferences_sha256']),
    },
    artefacts,
    paypal: hasPaypal
      ? {
          order_id: pickString(paypal, ['order_id']),
          capture_ids: Array.isArray(paypal['capture_ids'])
            ? paypal['capture_ids'].filter((v): v is string => typeof v === 'string')
            : [],
          custom_id: pickString(paypal, ['custom_id']),
        }
      : null,
    shipments: shipmentsOf(bundle),
    vi_lib_commit: pickString(bundle, ['vi_lib_commit']),
    bundle_hash: input.bundleHash,
    canonicalisation: {
      spec: 'RFC 8785 (JSON Canonicalization Scheme)',
      algorithm: 'SHA-256 over the UTF-8 bytes of the canonical form',
      hashed_members: [...HASHED_MEMBERS],
      excluded_from_custom_id: [...EXCLUDED_FROM_CUSTOM_ID],
    },
    redacted: {
      withheld: [...WITHHELD_FROM_VIEW],
      raw_download_url: input.rawDownloadUrl,
      note:
        'This page holds a redacted document. The bundle you can download is a different document with ' +
        'different contents. Nothing on this page is hidden behind styling — there is no raw token in ' +
        'this page’s source.',
    },
  }
}

function preferencesOf(bundle: Readonly<Record<string, unknown>>): Record<string, string> | null {
  const raw = bundle['preferences']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

interface ShipmentView {
  carrier: string
  tracking: string
  lines: { sku: string; qty: number }[]
}

function shipmentsOf(bundle: Readonly<Record<string, unknown>>): readonly ShipmentView[] {
  const raw = bundle['shipments']
  if (!Array.isArray(raw)) return []
  const out: ShipmentView[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    const lines = Array.isArray(record['lines'])
      ? record['lines']
          .map((line) => {
            const l = asRecord(line)
            const sku = pickString(l, ['sku'])
            const qty = l['qty']
            return sku !== null && typeof qty === 'number' ? { sku, qty } : null
          })
          .filter((l): l is { sku: string; qty: number } => l !== null)
      : []
    out.push({
      carrier: pickString(record, ['carrier']) ?? 'unknown',
      tracking: pickString(record, ['tracking']) ?? '',
      lines,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * An address pattern a mask cannot match, so a real address in the served bytes is loud.
 *
 * `a***@northwind-buyer.example` does not match: `***` is not in `[A-Za-z0-9._%+-]`. That asymmetry is the
 * whole point of the pattern — it fires on a leak and stays quiet on a correct mask.
 */
const EMAIL_SHAPED = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * Find raw material in a **serialised** redacted document.
 *
 * Checking the serialised bytes rather than walking the object is deliberate: a nested array, a stringified
 * `details` bag or a future `JSON.stringify` call site are all ways an object-level check passes while the
 * served bytes do not.
 *
 * @param redacted the document to scan.
 * @param forbidden literals that must not appear — each at least 8 characters, so a two-letter value cannot
 * produce a meaningless hit on every member.
 */
export function findLeakedSubstrings(
  redacted: unknown,
  forbidden: readonly string[],
): readonly string[] {
  const text = JSON.stringify(redacted) ?? ''
  const leaks: string[] = []
  for (const needle of forbidden) {
    if (typeof needle !== 'string' || needle.length < 8) continue
    if (text.includes(needle)) leaks.push(needle)
  }
  return leaks
}

/** Every string the guard will treat as raw material in `bundle`. Exported so the test can assert the list. */
export function rawSecretsOf(bundle: Readonly<Record<string, unknown>>): readonly string[] {
  const out: string[] = []
  for (const name of ARTEFACT_NAMES) {
    const raw = bundle[name]
    if (typeof raw === 'string' && raw.length >= 8) out.push(raw)
  }
  const buyer = asRecord(bundle['buyer'])
  for (const key of ['payer_email', 'email', 'payer_id'] as const) {
    const value = pickString(buyer, [key])
    if (value !== null && value.length >= 4) out.push(value)
  }
  for (const value of streetValuesOf(buyer['address'])) out.push(value)
  return out
}

/**
 * EC-PRIV-3's assertion, as code.
 *
 * Two independent sweeps, because they fail for different reasons:
 *
 * 1. **Literal sweep** — the raw tokens, the buyer's email, the `payer_id` and the street values must not
 *    appear in the served bytes. This catches the classic "the L1 is in the page's JSON" bug.
 * 2. **Pattern sweep** — no email-shaped string may appear at all. This catches the case nobody planned for:
 *    a new member added to the builder that quotes the buyer's address from somewhere else entirely.
 *
 * Returns `err(CS_INTERNAL)` naming what leaked. `CS_INTERNAL` and not `CS_VALIDATION` because a redaction
 * failure is never the reader's fault and must never be reported as one (D-007).
 */
export function assertRedactionHolds(
  redacted: unknown,
  bundle: Readonly<Record<string, unknown>>,
  extra: readonly string[] = [],
): Result<true, CsError> {
  const text = JSON.stringify(redacted) ?? ''

  const leaks = findLeakedSubstrings(redacted, [...rawSecretsOf(bundle), ...extra])
  if (leaks.length > 0) {
    return err(
      csError(
        'CS_INTERNAL',
        `The redacted packet view would have published ${leaks.length} raw value(s) and was not served: ${leaks
          .map((l) => `${l.slice(0, 24)}…`)
          .join(', ')}`,
        { leaked_count: leaks.length },
        {
          userMessage:
            'This packet could not be displayed safely. Nothing was published; please tell the operator.',
        },
      ),
    )
  }

  EMAIL_SHAPED.lastIndex = 0
  const emailShaped = EMAIL_SHAPED.exec(text)
  if (emailShaped !== null) {
    return err(
      csError(
        'CS_INTERNAL',
        `The redacted packet view contains an unmasked email-shaped string (${emailShaped[0]}) and was ` +
          'not served.',
        { match: emailShaped[0] },
        {
          userMessage:
            'This packet could not be displayed safely. Nothing was published; please tell the operator.',
        },
      ),
    )
  }

  return ok(true)
}

function streetValuesOf(address: unknown): readonly string[] {
  if (typeof address !== 'object' || address === null || Array.isArray(address)) return []
  const record = address as Record<string, unknown>
  const out: string[] = []
  for (const key of ADDRESS_STREET_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) out.push(value.trim())
  }
  return out
}
