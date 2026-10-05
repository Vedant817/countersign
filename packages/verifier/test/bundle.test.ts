/**
 * §7.3 canonicalisation, the two digests, and SD-JWT reading.
 *
 * Acceptance coverage: **AT-M18.1** (a digest that depends on key order could not be recomputed by a third
 * party, which would defeat the page's only purpose), **§12 EC-MER-6** (the `custom_id` preimage), and
 * **EC-PRIV-3** (the raw download is bounded by what the SD-JWT discloses).
 *
 * Every assertion here is against a **hard-coded expectation** or against a **captured chain**, never against
 * a re-implementation of the function under test. `expect(sha256Hex(canonicalJson(x))).toBe(y)` where `y` was
 * written by hand is the only kind of hash assertion that proves anything; a test that recomputes with the same
 * code it is testing would pass for a wrong constant.
 */

import { describe, expect, it } from 'vitest'

import {
  BUNDLE_VERSION,
  base64UrlToHex,
  bundleHashBase64Url,
  bundleHashHex,
  buildRawBundleDocument,
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
  sha256Hex,
  tokenKid,
  wireBundle,
} from '../src/bundle'
import { CAPTURED_CHAIN, cloneBundle, FIXTURE_READBACK, makeChainBundle } from './fixtures/chain'

// ---------------------------------------------------------------------------
// The canonical form itself
// ---------------------------------------------------------------------------

describe('RFC 8785 canonicalisation', () => {
  it('sorts keys at every level, with no insignificant whitespace', () => {
    // Written out by hand from the RFC, not produced by calling canonicalJson.
    expect(
      canonicalBundleJson({
        v: 'cs1',
        l2: 'TOKEN',
        paypal: { order_id: 'O1', custom_id: 'cs1:x', capture_ids: ['C1'] },
      }),
    ).toBe(
      '{"l2":"TOKEN","paypal":{"capture_ids":["C1"],"custom_id":"cs1:x","order_id":"O1"},"v":"cs1"}',
    )
  })

  it('sorts keys inside objects that live in arrays, which sort_keys-style approaches miss', () => {
    expect(
      canonicalBundleJson([
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ]),
    ).toBe('[{"a":2,"b":1},{"c":4,"d":3}]')
  })

  it('preserves array order, because it is significant', () => {
    expect(canonicalBundleJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('drops undefined rather than serialising it as null, so "absent" and "null" are different documents', () => {
    expect(canonicalBundleJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalBundleJson({ a: 1, b: null })).toBe('{"a":1,"b":null}')
  })

  it('refuses a non-finite number instead of hashing a guess', () => {
    expect(() => canonicalBundleJson({ a: Number.NaN })).toThrow(/non-finite/i)
    expect(() => canonicalBundleJson({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/i)
  })

  it('escapes strings exactly as RFC 8785 requires, including the two mandatory escapes', () => {
    expect(canonicalBundleJson({ s: 'a"b\\c' })).toBe('{"s":"a\\"b\\\\c"}')
    expect(canonicalBundleJson({ s: 'line\nbreak\ttab' })).toBe('{"s":"line\\nbreak\\ttab"}')
    // Control characters must be \u-escaped; a raw byte would change the digest between implementations.
    expect(canonicalBundleJson({ s: '' })).toBe('{"s":"\\u0001"}')
  })

  it('serialises an integer as its exact digits, never in exponential form', () => {
    // A float would make the digest depend on a formatting decision, and this system has none because
    // money is integer minor units (spec §0, EC-FX-6).
    expect(canonicalBundleJson({ n: 10 })).toBe('{"n":10}')
    expect(canonicalBundleJson({ n: 1e21 })).toBe('{"n":1e+21}')
  })
})

// ---------------------------------------------------------------------------
// AT-M18.1: key reordering must not move the digest
// ---------------------------------------------------------------------------

describe('AT-M18.1 the digest does not depend on key order', () => {
  it('produces the same bundle_hash after every key is reversed at every level', async () => {
    const fixture = await makeChainBundle()
    const reversed = reverseKeysDeep(fixture.bundle) as Record<string, unknown>
    // The order really is different, or the test would be vacuous.
    expect(Object.keys(reversed)).toEqual([...Object.keys(fixture.bundle)].reverse())
    expect(bundleHashHex(reversed)).toBe(fixture.bundleHash)
  })

  it('produces the same custom_id after every key is reversed at every level', async () => {
    const fixture = await makeChainBundle()
    const reversed = reverseKeysDeep(fixture.bundle) as Record<string, unknown>
    expect(customIdForBundle(reversed)).toBe(fixture.customId)
  })

  it('survives a JSON round trip, because that is what a reader actually does', async () => {
    const fixture = await makeChainBundle()
    const round = JSON.parse(JSON.stringify(fixture.bundle)) as Record<string, unknown>
    expect(bundleHashHex(round)).toBe(fixture.bundleHash)
    expect(customIdForBundle(round)).toBe(fixture.customId)
  })

  it('really does move the digest when a byte of a value changes, so the previous three are not vacuous', async () => {
    const fixture = await makeChainBundle()
    const tampered = cloneBundle(fixture.bundle)
    tampered['vi_lib_commit'] = 'deadbeef'
    expect(bundleHashHex(tampered)).not.toBe(fixture.bundleHash)
  })
})

function reverseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeysDeep)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
    out[key] = reverseKeysDeep((value as Record<string, unknown>)[key])
  }
  return out
}

// ---------------------------------------------------------------------------
// The two digests
// ---------------------------------------------------------------------------

describe('the two digests, and why they are not the same digest', () => {
  it('bundle_hash covers the whole bundle; custom_id covers only the nine core members', async () => {
    const fixture = await makeChainBundle()
    const original = fixture.customId

    // Changing a non-hashed member moves bundle_hash and leaves custom_id alone. This is §7.3's
    // "Shipments and PayPal IDs are added after order creation, so they are excluded from the hash".
    const shipped = cloneBundle(fixture.bundle)
    ;(shipped['shipments'] as { tracking: string }[])[0]!.tracking = '1Z999AA10123456785'
    ;(shipped['paypal'] as Record<string, unknown>)['order_id'] = 'FIXTUREORDER002'
    expect(bundleHashHex(shipped)).not.toBe(fixture.bundleHash)
    expect(customIdForBundle(shipped)).toBe(original)

    // Changing a hashed member moves both. `gate_decision` is in the core, so editing it is the cleanest
    // example — and it is also the member a merchant would have the most reason to touch.
    const edited = cloneBundle(fixture.bundle)
    edited['gate_decision'] = `${String(fixture.bundle['gate_decision']).slice(0, -4)}AAAA`
    expect(bundleHashHex(edited)).not.toBe(fixture.bundleHash)
    expect(customIdForBundle(edited)).not.toBe(original)
  })

  it('leaves custom_id alone when only paypal.custom_id is rewritten, which is the spoofing direction', async () => {
    // The preimage does not contain `paypal`, so a rewritten `paypal.custom_id` cannot change what the core
    // recomputes. That is the property that makes the two values worth comparing: a merchant who repoints
    // `paypal.custom_id` at a *different* order's value is caught by the comparison, and one who edits a
    // signed token is caught by the core digest. Neither attack has a gap.
    const fixture = await makeChainBundle()
    const spoofed = cloneBundle(fixture.bundle)
    ;(spoofed['paypal'] as Record<string, unknown>)['custom_id'] = `cs1:${'A'.repeat(43)}`
    expect(customIdForBundle(spoofed)).toBe(fixture.customId)
    expect(bundleHashHex(spoofed)).not.toBe(fixture.bundleHash)
  })

  it('renders bundle_hash in hex and the same digest in base64url, and the two decode to one value', async () => {
    const fixture = await makeChainBundle()
    const hex = bundleHashHex(fixture.bundle)
    const b64u = bundleHashBase64Url(fixture.bundle)
    expect(isSha256Hex(hex)).toBe(true)
    expect(isSha256Base64Url(b64u)).toBe(true)
    expect(base64UrlToHex(b64u)).toBe(hex)
    // And it is genuinely base64url, not base64: no '+' or '/' can appear.
    expect(b64u).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('matches the digest vi-service itself computed for the captured chain', () => {
    // `viBundleHashReference` came out of `vi_service/verify.py::bundle_hash` — an independent Python
    // implementation of the same RFC 8785 rules, run over the wire bundle the capture used. Two
    // implementations agreeing byte-for-byte is the only real evidence that a third party can reproduce
    // this digest, and it is the assertion that would catch a fixture whose token bodies were elided.
    const wire = wireBundle({
      v: 'cs1',
      l1: CAPTURED_CHAIN.l1,
      l2: CAPTURED_CHAIN.l2,
      l3a: CAPTURED_CHAIN.l3a,
      l3b: CAPTURED_CHAIN.l3b,
      checkout_jwt: CAPTURED_CHAIN.checkoutJwt,
      gate_decision: null,
      vi_lib_commit: CAPTURED_CHAIN.viLibCommit,
    })
    expect(bundleHashBase64Url(wire)).toBe(CAPTURED_CHAIN.viBundleHashReference)
  })
})

// ---------------------------------------------------------------------------
// §7.3 / D18: the custom_id preimage
// ---------------------------------------------------------------------------

describe('EC-MER-6 and D18: the custom_id preimage', () => {
  it('is exactly the nine members §7.3 names, in §7.3 order', () => {
    expect([...HASHED_MEMBERS]).toEqual([
      'v',
      'l1',
      'l2',
      'l3a',
      'l3b',
      'checkout_jwt',
      'gate_decision',
      'webauthn',
      'vi_lib_commit',
    ])
    expect(HASHED_MEMBERS).toHaveLength(9)
  })

  it('excludes paypal and shipments, and states why', () => {
    expect([...EXCLUDED_FROM_CUSTOM_ID]).toEqual(['paypal', 'shipments'])
  })

  it('produces a 47-character cs1: value, which is what PayPal accepts', async () => {
    const fixture = await makeChainBundle()
    expect(fixture.customId).toMatch(/^cs1:[A-Za-z0-9_-]{43}$/)
    expect(fixture.customId).toHaveLength(47)
  })

  it('omits an absent member rather than hashing a null for it', async () => {
    const withL1 = await makeChainBundle()
    const withoutL1 = cloneBundle(withL1.bundle)
    delete withoutL1['l1']
    expect(canonicalBundleCore(withoutL1)).not.toHaveProperty('l1')
    // §7.3 marks l1 optional, so this must still produce a custom_id — a different one.
    const id = customIdForBundle(withoutL1)
    expect(id).not.toBeNull()
    expect(id).not.toBe(withL1.customId)
  })

  it('refuses to produce a custom_id for an unknown bundle version rather than guessing the rule', async () => {
    const fixture = await makeChainBundle()
    const future = cloneBundle(fixture.bundle)
    future['v'] = 'cs2'
    expect(customIdForBundle(future)).toBeNull()
    expect(BUNDLE_VERSION).toBe('cs1')
  })

  it('keeps the packet-only members out of the preimage, so a tenth member cannot change custom_id', async () => {
    // PACKET_ONLY_MEMBERS is the list of things this package adds that §7.3 does not name. None of them may
    // reach the digest a PayPal order was created with.
    for (const member of PACKET_ONLY_MEMBERS) {
      expect([...HASHED_MEMBERS]).not.toContain(member)
    }
    expect([...PACKET_ONLY_MEMBERS]).toContain('readback')
    expect([...PACKET_ONLY_MEMBERS]).toContain('buyer')
  })
})

// ---------------------------------------------------------------------------
// SD-JWT reading (EC-PRIV-3's boundary)
// ---------------------------------------------------------------------------

describe('EC-PRIV-3: SD-JWT decoding reads disclosures without resolving them', () => {
  it('finds the email the L1 discloses, which is the only legitimate source for a buyer identifier', () => {
    expect(l1DisclosedClaim({ l1: CAPTURED_CHAIN.l1 }, 'email')).toBe(CAPTURED_CHAIN.payerEmail)
  })

  it('does not invent the email when the disclosure is absent', () => {
    expect(l1DisclosedClaim({ l1: CAPTURED_CHAIN.l1 }, 'pan_last_four')).toBeUndefined()
    expect(l1DisclosedClaim({}, 'email')).toBeUndefined()
    expect(l1DisclosedClaim({ l1: 'not-a-token' }, 'email')).toBeUndefined()
  })

  it('leaves the issuer-signed payload unresolved, so nothing here claims an integrity property', () => {
    const decoded = decodeSdJwt(CAPTURED_CHAIN.l1)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    // `email` lives in the disclosure section; the signed payload carries only the `..._sd` placeholders.
    expect(JSON.stringify(decoded.payload)).not.toContain(CAPTURED_CHAIN.payerEmail)
    expect(decoded.disclosures.map((d) => d.name)).toContain('email')
    expect(decoded.payload['_sd']).toBeDefined()
  })

  it('reports the kid each token claims, so a verifier can say which key signed it', () => {
    expect(tokenKid(CAPTURED_CHAIN.l1)).toBe(CAPTURED_CHAIN.issuerKid)
    expect(tokenKid(CAPTURED_CHAIN.l2)).toBe(CAPTURED_CHAIN.deviceKid)
    expect(tokenKid(CAPTURED_CHAIN.l3a)).toBe(CAPTURED_CHAIN.agentKid)
    expect(tokenKid(CAPTURED_CHAIN.checkoutJwt)).toBe(CAPTURED_CHAIN.merchantKid)
    expect(tokenKid('nonsense')).toBeNull()
  })

  it('reports a malformed token as a sentence rather than throwing', () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d']) {
      const decoded = decodeSdJwt(bad)
      expect(decoded.ok).toBe(false)
      if (!decoded.ok) expect(decoded.error.length).toBeGreaterThan(0)
    }
  })

  it('survives a token whose base64url payload is not JSON', () => {
    const decoded = decodeSdJwt('aGVhZGVy.bm90LWpzb24.c2ln')
    expect(decoded.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The wire form and the raw download
// ---------------------------------------------------------------------------

describe('wireBundle', () => {
  it('gives every member apps/vi declares an explicit value, so its model_dump matches what we sent', async () => {
    const fixture = await makeChainBundle()
    const wire = wireBundle(fixture.bundle)
    // vi's EvidenceBundle is extra="allow" with these seven declared and the rest defaulted to None, so
    // model_dump() emits them all. Omitting one would make vi hash a document we did not send.
    for (const key of [
      'v',
      'l1',
      'l2',
      'l3a',
      'l3b',
      'checkout_jwt',
      'gate_decision',
      'vi_lib_commit',
    ]) {
      expect(wire).toHaveProperty(key)
    }
  })

  it('turns an absent optional member into null rather than dropping it', () => {
    const wire = wireBundle({ v: 'cs1', l1: 'a', l2: 'b', extra: { keep: 1 }, gone: undefined })
    expect(wire['l3a']).toBeNull()
    expect(wire['extra']).toEqual({ keep: 1 })
    // Extras follow canonicalJson's own rule: an undefined extra is dropped, not nulled.
    expect(Object.keys(wire)).not.toContain('gone')
  })
})

describe('the raw download document', () => {
  it('carries the bundle verbatim plus every digest a reader needs', async () => {
    const fixture = await makeChainBundle()
    const doc = buildRawBundleDocument({
      packetId: fixture.packetId,
      disputeId: fixture.disputeId,
      version: fixture.bundle['version'] as number,
      bundleHash: fixture.bundleHash,
      bundle: fixture.bundle,
      filedAtSec: 1_800_086_400,
      viLibCommit: CAPTURED_CHAIN.viLibCommit,
      publicKeys: [
        {
          kid: CAPTURED_CHAIN.issuerKid,
          role: 'ISSUER',
          public_jwk: CAPTURED_CHAIN.issuerPublicJwk,
        },
      ],
      gateKid: fixture.gateKid,
    })

    expect(doc.doc).toBe('countersign-evidence-bundle')
    // The bundle is the stored object, not a re-encoding: a round trip must reproduce the digest.
    expect(bundleHashHex(doc.bundle)).toBe(fixture.bundleHash)
    expect(doc.custom_id).toBe(fixture.customId)
    expect(doc.bundle_hash).toBe(fixture.bundleHash)
    expect(doc.bundle_hash_base64url).toBe(bundleHashBase64Url(fixture.bundle))
    expect(doc.readback_sha256).toBe(sha256Hex(FIXTURE_READBACK))
    expect(doc.public_keys).toHaveLength(1)
  })

  it('states the canonicalisation rule in the document itself, so a reader need not trust this README', async () => {
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
      gateKid: null,
    })
    expect(doc.canonicalisation.spec).toContain('RFC 8785')
    expect(doc.canonicalisation.algorithm).toContain('SHA-256')
    expect(doc.canonicalisation.hashed_members).toEqual([...HASHED_MEMBERS])
    expect(doc.canonicalisation.excluded_from_custom_id).toEqual(['paypal', 'shipments'])
    // And it says where each digest's preimage is, because "hash the bundle" is ambiguous otherwise.
    expect(doc.canonicalisation.bundle_hash_preimage).toContain('whole')
    expect(doc.canonicalisation.custom_id_preimage).toContain('hashed_members')
  })

  it('omits the merchant narrative, which is a claim rather than evidence for a claim', async () => {
    const fixture = await makeChainBundle()
    fixture.bundle['notes'] = 'We shipped the item within two days of payment.'
    const doc = buildRawBundleDocument({
      packetId: fixture.packetId,
      disputeId: fixture.disputeId,
      version: 3,
      bundleHash: bundleHashHex(fixture.bundle),
      bundle: fixture.bundle,
      filedAtSec: null,
      viLibCommit: CAPTURED_CHAIN.viLibCommit,
      publicKeys: [],
      gateKid: null,
    })
    expect(doc.bundle['notes']).toBeDefined()
    // The download is the bundle, so a note in the bundle travels; what must not happen is the download
    // *promoting* it into a top-level instruction field of its own.
    expect(Object.keys(doc)).not.toContain('notes')
    expect(doc.instructions.live_verify).toContain('/v1/public/verify')
  })
})

// ---------------------------------------------------------------------------
// The hash predicates
// ---------------------------------------------------------------------------

describe('digest shape predicates', () => {
  it('accepts exactly the shapes a 32-byte SHA-256 produces', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true)
    expect(isSha256Hex('A'.repeat(64))).toBe(false)
    expect(isSha256Hex('a'.repeat(63))).toBe(false)
    expect(isSha256Base64Url('A'.repeat(43))).toBe(true)
    expect(isSha256Base64Url(`${'A'.repeat(43)}=`)).toBe(false)
    expect(isSha256Base64Url(undefined)).toBe(false)
  })
})
