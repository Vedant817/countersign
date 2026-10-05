/**
 * **EC-PRIV-3**: the redacted page must not contain what the raw download legitimately does.
 *
 * The acceptance test here is not "the mask function returns `a***@…`". It is the stronger property the design
 * exists for: **the redacted document's serialised bytes contain none of the raw material** — no token, no
 * email, no `payer_id`, no street line — while the download does contain the email and the `payer_id`, and the
 * two documents are built by different code paths with no shared object.
 *
 * Every assertion scans `JSON.stringify(document)` rather than walking the object, because a nested array, a
 * stringified `details` bag or a future `JSON.stringify` call site are all ways an object-level check passes
 * while the served bytes do not.
 */

import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
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
} from '../src/redact'
import { buildRawBundleDocument } from '../src/bundle'
import {
  CAPTURED_AT_SEC,
  CAPTURED_CHAIN,
  cloneBundle,
  FIXTURE_READBACK,
  makeChainBundle,
} from './fixtures/chain'

const BASE_URL = 'https://countersign.example'

function redactedFor(
  bundle: Record<string, unknown>,
  packetId = 'pkt_fixture_0000000000000001',
  bundleHash = 'f'.repeat(64),
) {
  return buildRedactedPacketDocument({
    packetId,
    disputeId: 'dsp_fixture_000000000000001',
    version: 3,
    filedAtSec: CAPTURED_AT_SEC + 86_400,
    createdAtSec: CAPTURED_AT_SEC,
    amountMinor: 13_300n,
    amountCurrency: 'USD',
    bundle,
    bundleHash,
    rawDownloadUrl: `${BASE_URL}/v/${packetId}/download`,
  })
}

// ---------------------------------------------------------------------------
// The masks
// ---------------------------------------------------------------------------

describe('maskEmail follows the spec EC-PRIV-3 example', () => {
  it('renders the first character, three stars, and the domain', () => {
    expect(maskEmail('asha.rao@northwind-buyer.example')).toBe('a***@northwind-buyer.example')
    expect(maskEmail('b@example.com')).toBe('b***@example.com')
  })

  it('refuses to pass through a string that is not an address', () => {
    // Emitting a payer_id here would put a stable per-buyer identifier into a field a reader reads as
    // "an email", and a reader would not notice.
    for (const bad of ['PAYERFIXTURE001', '', '   ', '@corp.example', 'a@', null, undefined, 42]) {
      expect(maskEmail(bad as string | null | undefined)).toBe('***')
    }
  })

  it('does not become the real address under any input shape', () => {
    const email = 'asha.rao@northwind-buyer.example'
    for (const variant of [email, ` ${email} `, email.toUpperCase(), `${email} `]) {
      const masked = maskEmail(variant)
      expect(masked).not.toContain('asha.rao')
      // The mask must not match the address pattern the guard scans for, or the guard could not tell a
      // mask from a leak.
      expect(masked).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    }
  })

  it('keeps the domain, because that is what makes the mask useful to a chargeback analyst', () => {
    // A reader matching this against a PayPal record needs to recognise the address; what the mask must not
    // do is identify a person to somebody who does not already know it.
    expect(maskEmail('asha.rao@northwind-buyer.example')).toContain('@northwind-buyer.example')
  })
})

describe('maskOpaqueId', () => {
  it('keeps two characters at each end', () => {
    expect(maskOpaqueId('PAYERFIXTURE001')).toBe('PA***01')
  })

  it('masks a short id harder rather than revealing most of it', () => {
    // 'AB' -> 'A***B' would be the whole value, which defeats the point.
    expect(maskOpaqueId('ABCDE')).toBe('A***')
    expect(maskOpaqueId('ABCDEF')).toBe('AB***EF')
  })

  it('returns null for nothing, rather than a mask that reads as a value', () => {
    expect(maskOpaqueId(undefined)).toBeNull()
    expect(maskOpaqueId(null)).toBeNull()
    expect(maskOpaqueId('  ')).toBeNull()
  })

  it('does not emit the original identifier', () => {
    const id = 'PAYERFIXTURE001'
    expect(maskOpaqueId(id)).not.toContain('FIXTURE')
  })
})

describe('addressToCityCountry keeps city and country only', () => {
  it('extracts the two permitted fields and drops everything else', () => {
    expect(
      addressToCityCountry({
        line1: '221B Baker Street',
        line2: 'Flat 3',
        city: 'Bengaluru',
        region: 'KA',
        postal_code: '560001',
        country: 'IN',
      }),
    ).toEqual({ city: 'Bengaluru', country: 'IN' })
  })

  it('yields nulls for an unreadable block rather than throwing', () => {
    for (const bad of [undefined, null, 'Bengaluru', 42, [], {}]) {
      expect(addressToCityCountry(bad)).toEqual({ city: null, country: null })
    }
  })

  it('names the street members it drops, so the module states what it is discarding', () => {
    // A redaction nobody can audit is a rumour.
    expect([...ADDRESS_STREET_KEYS]).toContain('line1')
    expect([...ADDRESS_STREET_KEYS]).toContain('postal_code')
  })
})

// ---------------------------------------------------------------------------
// EC-PRIV-3: the two documents
// ---------------------------------------------------------------------------

describe('EC-PRIV-3: the redacted view holds no raw material', () => {
  it('contains no email-shaped string anywhere in its serialised bytes', async () => {
    const fixture = await makeChainBundle()
    const text = JSON.stringify(redactedFor(fixture.bundle))
    const matches = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []
    expect(matches).toEqual([])
    // And it does carry a mask, so the reader is not left with nothing.
    expect(JSON.parse(text).buyer.payer_email_masked).toBe('a***@northwind-buyer.example')
  })

  it('contains none of the raw token strings', async () => {
    const fixture = await makeChainBundle()
    const text = JSON.stringify(redactedFor(fixture.bundle))
    for (const member of ['l1', 'l2', 'l3a', 'l3b', 'checkout_jwt', 'gate_decision'] as const) {
      const token = fixture.bundle[member]
      expect(typeof token).toBe('string')
      expect(text).not.toContain(token as string)
      expect((token as string).length).toBeGreaterThan(100)
    }
  })

  it('contains no payer_id beyond the permitted mask, and no street address', async () => {
    const fixture = await makeChainBundle()
    const doc = redactedFor(fixture.bundle)
    const text = JSON.stringify(doc)
    expect(text).not.toContain(CAPTURED_CHAIN.payerId)
    expect(doc.buyer.payer_id_masked).toBe('PA***01')
    expect(text).not.toContain('221B Baker Street')
    expect(text).not.toContain('560001')
    // City and country do survive: §8.18 permits them and a chargeback analyst needs them.
    expect(doc.buyer.city).toBe('Bengaluru')
    expect(doc.buyer.country).toBe('IN')
  })

  it('describes each artefact by digest and length instead of by content', async () => {
    const fixture = await makeChainBundle()
    const doc = redactedFor(fixture.bundle)
    expect(doc.artefacts).toHaveLength(6)
    for (const artefact of doc.artefacts) {
      expect(artefact.present).toBe(true)
      expect(artefact.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(artefact.bytes).toBeGreaterThan(100)
      expect(artefact.role.length).toBeGreaterThan(20)
    }
    // The digest really is of the token, so a reader with the download can confirm the join.
    const l1 = doc.artefacts.find((a) => a.name === 'l1')
    expect(l1?.sha256).toBe(createHash('sha256').update(CAPTURED_CHAIN.l1, 'utf8').digest('hex'))
  })

  it('keeps custom_id, which is a digest rather than a secret, because §7.3 and D18 both need it', async () => {
    const fixture = await makeChainBundle()
    const doc = redactedFor(fixture.bundle)
    expect(doc.paypal?.custom_id).toBe(fixture.customId)
    expect(doc.paypal?.order_id).toBe('FIXTUREORDER001')
  })

  it('reports the amount as integer minor units and never as a float', async () => {
    const fixture = await makeChainBundle()
    const doc = redactedFor(fixture.bundle)
    expect(doc.disputed_amount).toEqual({ minor: '13300', currency: 'USD' })
    // bigint has no JSON representation, and Number() on a minor-unit amount is the float-money bug
    // scripts/check-money-discipline.mjs exists to catch (spec §0, EC-FX-6).
    expect(JSON.stringify(doc)).toContain('"minor":"13300"')
    expect(JSON.stringify(doc)).not.toContain('13300.0')
  })

  it('passes its own guard, which is what the page route calls before serving', async () => {
    const fixture = await makeChainBundle()
    const verdict = assertRedactionHolds(redactedFor(fixture.bundle), fixture.bundle)
    expect(verdict.ok).toBe(true)
  })
})

describe('EC-PRIV-3: the raw download does contain the selectively disclosed fields', () => {
  it('carries the buyer email, because the L1 discloses it and EC-PRIV-3 permits that', async () => {
    const fixture = await makeChainBundle()
    const doc = buildRawBundleDocument({
      packetId: fixture.packetId,
      disputeId: fixture.disputeId,
      version: 3,
      bundleHash: fixture.bundleHash,
      bundle: fixture.bundle,
      filedAtSec: null,
      viLibCommit: CAPTURED_CHAIN.viLibCommit,
      publicKeys: [],
      gateKid: fixture.gateKid,
    })
    // The email is reachable two ways, and both are legitimate: the L1's disclosure, and the buyer block.
    expect(JSON.stringify(doc)).toContain(CAPTURED_CHAIN.payerEmail)
    expect(JSON.stringify(doc)).toContain(CAPTURED_CHAIN.payerId)
    // And the raw L1 token itself is present, byte for byte.
    expect(doc.bundle['l1']).toBe(CAPTURED_CHAIN.l1)
  })

  it('is served by a different code path, and the two documents share no member holding raw material', async () => {
    const fixture = await makeChainBundle()
    const redacted = redactedFor(fixture.bundle)
    const raw = buildRawBundleDocument({
      packetId: fixture.packetId,
      disputeId: fixture.disputeId,
      version: 3,
      bundleHash: fixture.bundleHash,
      bundle: fixture.bundle,
      filedAtSec: null,
      viLibCommit: CAPTURED_CHAIN.viLibCommit,
      publicKeys: [],
      gateKid: fixture.gateKid,
    })

    // Different document kinds, so nothing downstream can confuse them.
    expect(redacted.doc).toBe('redacted-packet-view')
    expect(raw.doc).toBe('countersign-evidence-bundle')

    // The redacted document has no member that could hold a token; the raw one has no artefact digests.
    expect(Object.keys(redacted).sort()).not.toContain('bundle')
    expect(redacted).not.toHaveProperty('artefacts.digestOnly')
    expect(raw).not.toHaveProperty('artefacts')

    // And the separation holds in the only direction that matters: nothing raw is in the redacted bytes.
    expect(findLeakedSubstrings(redacted, rawSecretsOf(fixture.bundle))).toEqual([])
  })

  it('names the same packet, dispute, version and digest in both documents', async () => {
    const fixture = await makeChainBundle()
    // The same stored digest goes into both builders, exactly as the two routes do — the page echoes
    // `evidence_packets.bundle_hash` and the download carries it as the value a reader recomputes.
    const redacted = redactedFor(fixture.bundle, fixture.packetId, fixture.bundleHash)
    const raw = buildRawBundleDocument({
      packetId: fixture.packetId,
      disputeId: fixture.disputeId,
      version: 3,
      bundleHash: fixture.bundleHash,
      bundle: fixture.bundle,
      filedAtSec: null,
      viLibCommit: CAPTURED_CHAIN.viLibCommit,
      publicKeys: [],
      gateKid: fixture.gateKid,
    })
    // Both name the packet, the dispute, the version and the digest — a reader needs to know the two
    // documents are about the same thing.
    expect(redacted.packet.id).toBe(raw.packet.id)
    expect(redacted.packet.dispute_id).toBe(raw.packet.dispute_id)
    expect(redacted.packet.version).toBe(raw.packet.version)
    expect(redacted.bundle_hash).toBe(raw.bundle_hash)
  })
})

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe('assertRedactionHolds fails loudly rather than publishing a leak', () => {
  it('refuses a document that contains a raw token', async () => {
    const fixture = await makeChainBundle()
    const leaky = { ...redactedFor(fixture.bundle), oops: CAPTURED_CHAIN.l1 }
    const verdict = assertRedactionHolds(leaky, fixture.bundle)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    // CS_INTERNAL, not CS_VALIDATION: a redaction failure is never the reader's fault (D-007).
    expect(verdict.error.code).toBe('CS_INTERNAL')
    expect(verdict.error.message).toMatch(/would have published/)
    expect(verdict.error.details?.['leaked_count']).toBe(1)
  })

  it('refuses a document with an unmasked email even when no raw value was passed in', async () => {
    // The case nobody planned for: a new member quoting the buyer's address from somewhere else entirely.
    // The literal sweep would miss it; the pattern sweep catches it.
    const fixture = await makeChainBundle()
    const leaky = {
      ...redactedFor(fixture.bundle),
      note: 'Contact asha.rao@northwind-buyer.example',
    }
    const verdict = assertRedactionHolds(leaky, {})
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.error.message).toMatch(/unmasked email-shaped string/)
  })

  it('accepts a caller-supplied extra secret', async () => {
    const fixture = await makeChainBundle()
    const leaky = { ...redactedFor(fixture.bundle), x: 'AN-OPERATOR-ONLY-VALUE' }
    expect(assertRedactionHolds(leaky, fixture.bundle).ok).toBe(true)
    const withExtra = assertRedactionHolds(leaky, fixture.bundle, ['AN-OPERATOR-ONLY-VALUE'])
    expect(withExtra.ok).toBe(false)
  })

  it('ignores a literal too short to be meaningful, so a two-letter value is not a false alarm', () => {
    expect(findLeakedSubstrings({ a: 'US' }, ['US'])).toEqual([])
    expect(findLeakedSubstrings({ a: 'northwind' }, ['northwind'])).toHaveLength(1)
  })

  it('survives a document that cannot be serialised, rather than throwing', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    // JSON.stringify throws on a cycle. A guard that crashed would take the page down with it, which is a
    // worse outcome than a check that did not run — but it must not be silent either, so this asserts the
    // caller sees a thrown error rather than a false PASS.
    expect(() => findLeakedSubstrings(cyclic, ['abcdefgh'])).toThrow()
  })
})

// ---------------------------------------------------------------------------
// EC-MER-6: the read-back is in the view
// ---------------------------------------------------------------------------

describe('EC-MER-6: the read-back and the preferences hash are in the redacted view', () => {
  it('carries both, so a reader can see the merchant published them', async () => {
    const fixture = await makeChainBundle()
    const doc = redactedFor(fixture.bundle)
    expect(doc.consent.readback).toBe(FIXTURE_READBACK)
    // And it is the read-back vi-service hands the UI as the consent text (§8.5), quoted verbatim rather
    // than paraphrased: a verifier printing a paraphrase would be printing something no signature covers.
    expect(doc.consent.readback).toContain('Northwind Outfitters')
    expect(doc.consent.readback).toContain('$200.00')
    expect(doc.consent.readback_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(doc.consent.preferences).toEqual({ size: '10', color: 'grey' })
    expect(doc.consent.preferences_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports them as absent rather than empty when a packet omits them', async () => {
    const fixture = await makeChainBundle()
    const stripped = cloneBundle(fixture.bundle)
    delete stripped['readback']
    delete stripped['preferences']
    const doc = redactedFor(stripped)
    // null, not '': an empty string reads as "the field was populated with nothing", which is a different
    // claim from "there was nothing to populate".
    expect(doc.consent.readback).toBeNull()
    expect(doc.consent.preferences).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// What the page tells the reader it withheld
// ---------------------------------------------------------------------------

describe('the page states what it withheld', () => {
  it('lists every category of withheld value, including the two EC-PRIV-3 names explicitly', () => {
    const text = WITHHELD_FROM_VIEW.join(' ').toLowerCase()
    expect(text).toContain('email')
    expect(text).toContain('payer_id')
    expect(text).toContain('street address')
    expect(text).toContain('raw l1')
  })

  it('points at the download, so "redacted" is not a dead end', async () => {
    const fixture = await makeChainBundle()
    const doc = redactedFor(fixture.bundle)
    expect(doc.redacted.raw_download_url).toBe(
      `${BASE_URL}/v/pkt_fixture_0000000000000001/download`,
    )
    expect(doc.redacted.note).toMatch(/no raw token in this page/i)
  })
})

// ---------------------------------------------------------------------------
// Where the buyer facts come from
// ---------------------------------------------------------------------------

describe('buyerFactsOf reads the email from the token, not from a row we wrote', () => {
  it('prefers the L1 disclosure over the buyer block', async () => {
    const fixture = await makeChainBundle()
    const facts = buyerFactsOf(fixture.bundle)
    expect(facts.payerEmail).toBe(CAPTURED_CHAIN.payerEmail)
    expect(facts.emailFromDisclosure).toBe(true)
  })

  it('falls back to the buyer block, and says so, when the token discloses nothing', () => {
    const facts = buyerFactsOf({
      l1: 'aGVhZGVy.cGF5bG9hZA',
      buyer: { payer_email: 'someone@example.test' },
    })
    expect(facts.payerEmail).toBe('someone@example.test')
    expect(facts.emailFromDisclosure).toBe(false)
  })

  it('reports nulls rather than throwing for a bundle with nothing readable', () => {
    for (const bundle of [{}, { l1: 42 }, { buyer: 'nope' }]) {
      const facts = buyerFactsOf(bundle as Record<string, unknown>)
      expect(facts.payerEmail).toBeNull()
      expect(facts.payerId).toBeNull()
    }
  })
})
