/**
 * The binding checks, named after what each one answers.
 *
 * ## Why this file exists separately from `verify.test.ts`
 *
 * `verify.test.ts` covers AT-M18.1 — *tampering is shown*, one field per category. This file covers the
 * property an audit found missing and that no per-field test could have caught: **every artefact in the bundle
 * must be compared against something the person rewriting the bundle cannot recompute.**
 *
 * A digest is not that. `bundle_hash` and `custom_id` are both functions of the document in front of you, so
 * an attacker with the document re-derives both in one line and every "integrity" row agrees again. The checks
 * here compare against three things that are not functions of the bundle: the merchant-signed price lock, the
 * chain's own `iat` window, and **the `disputes` row** — a different table, which is the only anchor on the
 * page that a holder of a packet URL cannot reach.
 *
 * ## What each group asserts, and what it does not
 *
 * | Group | Question | Answerable here? |
 * |---|---|---|
 * | `gate_record_*` | does the signed record describe *this* purchase? | amount, currency, payee, chain, library, **time** — yes. attempt, mandate — **no**, and reported as uncovered. |
 * | `paypal_dispute_binding` | is this packet filed for *this* transaction? | yes, against the dispute row. |
 * | `readback_*` | is the read-back the buyer's? | a **ceiling** only; no signature covers the text, and the page says so. |
 *
 * The two "no" rows are the point of the exercise. A suite that asserted every field was bound would be
 * asserting something false about §7.3, and the honest version of this file states the gap rather than
 * papering over it.
 */

import { describe, expect, it } from 'vitest'

import { toPayPalValue } from '@countersign/core'
import { signDecisionRecord, type GateJwks } from '@countersign/gate'

import { bundleHashHex, customIdForBundle, sha256Hex } from '../src/bundle'
import {
  isCompilerReadback,
  READBACK_HEADER,
  readChainAnchors,
  readMonetaryCeiling,
  readStatedCaps,
} from '../src/binding'
import { offlineChecks, type LoadedPacket } from '../src/verify-view'
import type { VerifierCheck } from '../src/types'
import type { PacketId } from '@countersign/core'

import { makeGateKey } from './fixtures/chain'
import {
  CAPTURED_AT_SEC,
  CAPTURED_CHAIN,
  cloneBundle,
  FIXTURE_READBACK,
  makeChainBundle,
  type ChainBundleFixture,
} from './fixtures/chain'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function statusOf(checks: readonly VerifierCheck[], id: string): string | undefined {
  return checks.find((c) => c.id === id)?.status
}

function checkOf(checks: readonly VerifierCheck[], id: string): VerifierCheck {
  const found = checks.find((c) => c.id === id)
  if (found === undefined)
    throw new Error(`no check with id ${id}; have ${checks.map((c) => c.id).join(', ')}`)
  return found
}

/** The rows that failed, by id — the assertion shape every test below uses. */
function failures(checks: readonly VerifierCheck[]): string[] {
  return checks.filter((c) => c.status === 'FAIL').map((c) => c.id)
}

/**
 * Load the fixture the way the route does, optionally replacing the signed record and the dispute row.
 *
 * `sign` is a **real** Ed25519 signature over whatever payload it is given, produced by `signDecisionRecord`.
 * That matters: a test that built its own JWS string would be testing a mock, and AGENTS.md rule 5 is about
 * exactly this. Every forged record below is genuine and correctly signed — the point is that a genuine
 * signature is not enough.
 */
async function loadedWith(
  options: {
    record?: Partial<Record<string, unknown>>
    dispute?: { capture_id?: string | null; order_id?: string | null }
    bundleMutate?: (bundle: Record<string, unknown>) => void
    rehash?: boolean
  } = {},
): Promise<{ checks: readonly VerifierCheck[]; fixture: ChainBundleFixture }> {
  // One Gate key per call, and the fixture is re-signed with **it**, so the JWKS and the record always agree.
  // A test that reused one key for both would prove nothing about a substitution; this one produces a genuinely
  // valid signature over whatever payload it is handed, which is the whole difficulty.
  const gate = await makeGateKey()
  const signed = await signRecord(gate, options.record ?? {})
  const fixture = await bundleWithRecord(gate, signed)

  const bundle = cloneBundle(fixture.bundle)
  options.bundleMutate?.(bundle)

  const packet: LoadedPacket = {
    packetId: fixture.packetId as PacketId,
    disputeId: fixture.disputeId as LoadedPacket['disputeId'],
    version: 3,
    bundle,
    storedBundleHash: options.rehash === false ? fixture.bundleHash : bundleHashHex(bundle),
    filedAtSec: CAPTURED_AT_SEC + 86_400,
    createdAtSec: CAPTURED_AT_SEC,
    amountMinor: fixture.amountMinor,
    amountCurrency: fixture.amountCurrency,
    stage: 'CHARGEBACK',
    status: 'UNDER_REVIEW',
    gateJwks: gateJwksOf(gate),
    disputeCaptureId:
      options.dispute?.capture_id === undefined ? 'FIXTURECAPTURE001' : options.dispute.capture_id,
    disputeOrderId:
      options.dispute?.order_id === undefined ? 'FIXTUREORDER001' : options.dispute.order_id,
  }
  return { checks: await offlineChecks(packet, CAPTURED_AT_SEC), fixture }
}

/**
 * Sign a §8.10 payload, defaulting to the fixture's honest one.
 *
 * `amount` defaults to `toPayPalValue({minor: 13300n, currency: 'USD'})` — the string `packages/gate` actually
 * writes — rather than to raw minor units, because a fixture that signs a format no Gate produces would make
 * every amount assertion vacuous.
 */
async function signRecord(
  gate: Awaited<ReturnType<typeof makeGateKey>>,
  overrides: Partial<Record<string, unknown>>,
): Promise<string> {
  const signed = await signDecisionRecord({
    key: gate.privateKey,
    kid: gate.kid,
    payload: {
      gdc: 'gdc_fixture_000000000000000001',
      att: 'att_fixture_00000000000000001',
      mdt: 'mdt_fixture_00000000000000001',
      amount: toPayPalValue({ minor: 13_300n, currency: 'USD' }),
      currency: 'USD',
      payee: 'mrc_northwind',
      checks_hash: 'a'.repeat(64),
      chain_valid: true,
      vi_commit: CAPTURED_CHAIN.viLibCommit,
      iat: CAPTURED_AT_SEC,
      ...overrides,
    },
  })
  if (!signed.ok) throw new Error(`could not sign: ${signed.error.message}`)
  return signed.value
}

/**
 * The fixture bundle with `gate_decision` replaced by `record`.
 *
 * **`custom_id` is recomputed afterwards**, which is the real order of operations and also what an attacker
 * does. Without it, `custom_id` would fail on every case in this file and the substitution rows would be
 * asserting a digest mismatch rather than a binding failure.
 */
async function bundleWithRecord(
  gate: Awaited<ReturnType<typeof makeGateKey>>,
  record: string,
): Promise<ChainBundleFixture> {
  const base = await makeChainBundle()
  const bundle = cloneBundle(base.bundle)
  bundle['gate_decision'] = record
  const paypal = bundle['paypal'] as Record<string, unknown>
  paypal['custom_id'] = customIdForBundle(bundle) ?? ''
  return {
    ...base,
    bundle,
    bundleHash: bundleHashHex(bundle),
    customId: paypal['custom_id'] as string,
    gateJwk: gate.publicJwk,
    gateKid: gate.kid,
  }
}

/**
 * The `GateJwks` for the key that signed the record.
 *
 * **Exactly one key**, and that is the honest shape of the test: with a second GATE key present, a record could
 * verify under the wrong one and the assertion would be weaker than it reads. The key material comes from the
 * same `makeGateKey()` call that signed, so the two cannot drift.
 */
function gateJwksOf(gate: Awaited<ReturnType<typeof makeGateKey>>): GateJwks {
  const x = gate.publicJwk['x']
  if (typeof x !== 'string') throw new Error('the generated Gate key has no x coordinate')
  return { keys: [{ kid: gate.kid, kty: 'OKP', crv: 'Ed25519', x }] }
}

// ---------------------------------------------------------------------------
// 1. EC-MER-6 / §3.1 I-1 — the record must describe this purchase
// ---------------------------------------------------------------------------

describe('EC-MER-6: the signed Gate record is bound to the price lock, field by field', () => {
  it('a record for a different amount fails gate_record_amount and no other amount row', async () => {
    const { checks } = await loadedWith({ record: { amount: '999999.00' } })
    expect(statusOf(checks, 'gate_record_amount')).toBe('FAIL')
    expect(statusOf(checks, 'gate_record_currency')).toBe('PASS')
    expect(statusOf(checks, 'gate_record_payee')).toBe('PASS')
    // The row names the field and both values, so the failure identifies itself.
    const row = checkOf(checks, 'gate_record_amount')
    // Both sides rendered as money, so the failure is readable by anyone and not only by someone holding the
    // raw signed string. `$999,999.00` is `amount: '999999.00'` — a genuine PayPal decimal string, which is the
    // format §8.10's payload really uses.
    expect(row.detail).toContain('$133.00')
    expect(row.detail).toContain('$999,999.00')
    expect(row.detail).toMatch(/different amount/i)
  })

  it('a record for a different currency fails gate_record_currency, and the amount row names the mismatch too', async () => {
    // `amount` is a PayPal decimal string *in the record's own currency*, so changing the currency without
    // changing the string would be a nonsense record. The amount row catching it is the correct behaviour: two
    // rows disagree with a chain whose two claims disagree with each other.
    const { checks } = await loadedWith({ record: { currency: 'JPY', amount: '13300' } })
    expect(statusOf(checks, 'gate_record_currency')).toBe('FAIL')
    expect(checkOf(checks, 'gate_record_currency').detail).toMatch(/JPY/)
    expect(checkOf(checks, 'gate_record_currency').detail).toMatch(/different amount of/i)
  })

  it('a record for a different payee fails gate_record_payee and names both merchants', async () => {
    const { checks } = await loadedWith({ record: { payee: 'SOME_OTHER_MERCHANT' } })
    expect(statusOf(checks, 'gate_record_payee')).toBe('FAIL')
    const row = checkOf(checks, 'gate_record_payee')
    expect(row.detail).toContain('SOME_OTHER_MERCHANT')
    expect(row.detail).toContain('mrc_northwind')
  })

  it('a record whose chain_valid is false fails gate_record_chain, because I-1 says only ALLOW reaches PayPal', async () => {
    const { checks } = await loadedWith({ record: { chain_valid: false } })
    expect(statusOf(checks, 'gate_record_chain')).toBe('FAIL')
    expect(checkOf(checks, 'gate_record_chain').detail).toMatch(/authorised nothing/i)
  })

  it('a record made by a different library fails gate_record_vi_commit', async () => {
    const { checks } = await loadedWith({ record: { vi_commit: 'b'.repeat(40) } })
    expect(statusOf(checks, 'gate_record_vi_commit')).toBe('FAIL')
    expect(checkOf(checks, 'gate_record_vi_commit').detail).toMatch(/cannot be re-verified/i)
  })

  it('a record that is not a decimal amount fails rather than passing, because an unreadable claim is unchecked', async () => {
    const { checks } = await loadedWith({ record: { amount: 'a lot' } })
    expect(statusOf(checks, 'gate_record_amount')).toBe('FAIL')
    expect(checkOf(checks, 'gate_record_amount').detail).toMatch(/not a plain decimal/i)
  })
})

describe('§12 EC-MER-6 / D18: the record is bound in TIME, in both directions', () => {
  it('a record decided before the chain existed fails gate_record_iat', async () => {
    // A decision cannot predate the mandate it authorised. This is the "record for a superseded attempt"
    // direction: a genuine signature over an older transaction, sitting inside a newer packet.
    const { checks } = await loadedWith({ record: { iat: CAPTURED_AT_SEC - 86_400 } })
    expect(statusOf(checks, 'gate_record_iat')).toBe('FAIL')
    expect(checkOf(checks, 'gate_record_iat').detail).toMatch(/cannot predate/i)
  })

  it('a record decided after the chain was issued fails gate_record_iat in the other direction too', async () => {
    // **Both directions, and this is the assertion that matters.** A check that only caught "too old" would be
    // satisfied by any implementation comparing `iat` against `nowSec`, which is the direction the pre-existing
    // `fresh` WARN already covered. The window here is the *chain's own*, so a record from a *later* attempt is
    // caught too.
    const { checks } = await loadedWith({ record: { iat: CAPTURED_AT_SEC + 86_400 } })
    expect(statusOf(checks, 'gate_record_iat')).toBe('FAIL')
    expect(checkOf(checks, 'gate_record_iat').detail).toMatch(/different transaction/i)
  })

  it('a record inside the chain window passes, so the window is a range and not a wall', async () => {
    const { checks } = await loadedWith({})
    expect(statusOf(checks, 'gate_record_iat')).toBe('PASS')
  })
})

describe('§8.10: the two fields nothing signed in §7.3 can name are reported as uncovered', () => {
  it('attempt and mandate are WARN, never PASS, and each says why', async () => {
    const { checks } = await loadedWith({})
    for (const id of ['gate_record_attempt', 'gate_record_mandate']) {
      const row = checkOf(checks, id)
      expect(row.status, `${id} must not claim to be verified`).toBe('WARN')
      expect(row.detail).toMatch(/nothing/i)
    }
    expect(checkOf(checks, 'gate_record_attempt').detail).toContain('att_fixture')
    expect(checkOf(checks, 'gate_record_mandate').detail).toContain('mdt_fixture')
    // And the label is the statement, so a reader scanning the table sees it without reading the detail.
    expect(checkOf(checks, 'gate_record_attempt').label).toMatch(/no signed artefact/i)
  })

  it('a substitution in the attempt id is therefore NOT caught, and this is the gap stated rather than hidden', async () => {
    // **The negative assertion.** Swapping `att` for somebody else's leaves every other row green, because
    // nothing in §7.3's bundle names an attempt. A test that did not assert this would let a future change to
    // `gate_record_attempt` look like it had closed the hole when it had not — and, worse, would let someone
    // reading the suite believe attempt substitution is caught. It is not.
    const { checks } = await loadedWith({ record: { att: 'att_SOMEONE_ELSES_ATTEMPT' } })
    expect(statusOf(checks, 'gate_record_attempt')).toBe('WARN')
    expect(failures(checks)).not.toContain('gate_record_attempt')
    expect(checkOf(checks, 'gate_record_attempt').detail).toContain('att_SOMEONE_ELSES_ATTEMPT')
    // The signature is still good: which is the whole lesson.
    expect(statusOf(checks, 'gate_record')).toBe('PASS')
  })
})

// ---------------------------------------------------------------------------
// 2. §7.2 / D18 — the packet is bound to the dispute it is filed under
// ---------------------------------------------------------------------------

describe('§12 EC-MER-6: a packet cannot be filed for a transaction it does not describe', () => {
  it('repointing paypal at another capture fails, with both digests recomputed', async () => {
    // The QA3 variant, reproduced with the real order of operations: retarget, recompute `custom_id`,
    // recompute `bundle_hash`. Every digest row then agrees — which is the point.
    const { checks } = await loadedWith({
      bundleMutate: (bundle) => {
        const paypal = bundle['paypal'] as Record<string, unknown>
        paypal['order_id'] = 'SOMEONE_ELSES_ORDER'
        paypal['capture_ids'] = ['SOMEONE_ELSES_CAPTURE']
        paypal['custom_id'] = customIdForBundle(bundle) ?? ''
      },
    })
    // The digests are clean, and they are *supposed* to be: recomputing them is legitimate.
    expect(statusOf(checks, 'bundle_hash')).toBe('PASS')
    expect(statusOf(checks, 'custom_id')).toBe('PASS')
    expect(statusOf(checks, 'custom_id_binding')).toBe('PASS')
    // And the binding fails, on the one row that compares against a table the packet cannot rewrite.
    expect(statusOf(checks, 'paypal_dispute_binding')).toBe('FAIL')
    expect(checkOf(checks, 'paypal_dispute_binding').detail).toMatch(/not evidence for this one/i)
  })

  it('the failure names both sides, masked, so §8.18\u2019s "packet id only" rule still holds', async () => {
    const { checks } = await loadedWith({
      bundleMutate: (bundle) => {
        const paypal = bundle['paypal'] as Record<string, unknown>
        paypal['capture_ids'] = ['SOMEONE_ELSES_CAPTURE']
        paypal['custom_id'] = customIdForBundle(bundle) ?? ''
      },
    })
    const detail = checkOf(checks, 'paypal_dispute_binding').detail
    expect(detail).not.toContain('SOMEONE_ELSES_CAPTURE')
    expect(detail).not.toContain('FIXTURECAPTURE001')
    expect(detail).toMatch(/SO\*\*\*/)
    expect(detail).toMatch(/FI\*\*\*/)
  })

  it('both directions are checked: the order and the capture', async () => {
    const wrongOrder = await loadedWith({
      bundleMutate: (bundle) => {
        const paypal = bundle['paypal'] as Record<string, unknown>
        paypal['order_id'] = 'OTHER_ORDER'
        paypal['custom_id'] = customIdForBundle(bundle) ?? ''
      },
    })
    expect(statusOf(wrongOrder.checks, 'paypal_dispute_binding')).toBe('FAIL')

    const wrongCapture = await loadedWith({
      bundleMutate: (bundle) => {
        const paypal = bundle['paypal'] as Record<string, unknown>
        paypal['capture_ids'] = ['OTHER_CAPTURE']
        paypal['custom_id'] = customIdForBundle(bundle) ?? ''
      },
    })
    expect(statusOf(wrongCapture.checks, 'paypal_dispute_binding')).toBe('FAIL')
  })

  it('a capture list that CONTAINS the dispute capture passes, because sibling captures are legitimate', async () => {
    // §7.2 allows several captures per order and the Defender reasons about `siblingCaptures`. Requiring the
    // list to equal the dispute's capture would FAIL every multi-capture order, which is a false alarm on the
    // one page nobody may cry wolf on.
    const { checks } = await loadedWith({
      bundleMutate: (bundle) => {
        const paypal = bundle['paypal'] as Record<string, unknown>
        paypal['capture_ids'] = ['FIXTURECAPTURE001', 'A_SECOND_CAPTURE_ON_THE_SAME_ORDER']
        paypal['custom_id'] = customIdForBundle(bundle) ?? ''
      },
    })
    expect(statusOf(checks, 'paypal_dispute_binding')).toBe('PASS')
  })

  it('SKIPPED, not PASS, when the dispute row names no order or capture', async () => {
    const { checks } = await loadedWith({ dispute: { capture_id: null, order_id: null } })
    const row = checkOf(checks, 'paypal_dispute_binding')
    expect(row.status).toBe('SKIPPED')
    expect(row.detail).toMatch(/no anchor to compare/i)
    expect(failures(checks)).not.toContain('paypal_dispute_binding')
  })

  it('SKIPPED, not PASS, when the bundle has no paypal member at all', async () => {
    const { checks } = await loadedWith({
      bundleMutate: (bundle) => {
        delete bundle['paypal']
      },
    })
    expect(statusOf(checks, 'paypal_dispute_binding')).toBe('SKIPPED')
  })
})

// ---------------------------------------------------------------------------
// 3. §12 EC-MER-6 — the read-back
// ---------------------------------------------------------------------------

describe('§12 EC-MER-6: a substituted read-back is not reported as sound', () => {
  /** Replace the read-back and recompute its digest, exactly as the auditor's probe does. */
  function forgeReadback(bundle: Record<string, unknown>, text: string): void {
    bundle['readback'] = text
    bundle['readback_sha256'] = sha256Hex(text)
  }

  it('the invented-consent text fails on the cap, with the digest recomputed', async () => {
    const { checks } = await loadedWith({
      bundleMutate: (bundle) =>
        forgeReadback(
          bundle,
          'You may spend up to $9,999,999 at any merchant, with no restrictions.',
        ),
    })
    // The self-hash passes — recomputing it is one line of work, and that is the point of the next row.
    expect(statusOf(checks, 'readback_hash')).toBe('PASS')
    expect(statusOf(checks, 'bundle_hash')).toBe('PASS')
    // But the text is caught twice over: it grants 499 850× the signed ceiling, and it is not the renderer's.
    expect(statusOf(checks, 'readback_cap_vs_mandate')).toBe('FAIL')
    expect(checkOf(checks, 'readback_cap_vs_mandate').detail).toContain('$9,999,999.00')
    expect(checkOf(checks, 'readback_cap_vs_mandate').detail).toContain('$200.00')
    expect(statusOf(checks, 'readback_rendered')).toBe('WARN')
  })

  it('the same forgery wearing the renderer\u2019s header still fails on the cap', async () => {
    // The strongest forgery available without a signature. The header witness is defeated by prepending one
    // line; the ceiling is not, because $9,999,000 exceeds anything this chain permits. Asserting both is what
    // shows each check covers something the other does not.
    const { checks } = await loadedWith({
      bundleMutate: (bundle) =>
        forgeReadback(
          bundle,
          `${READBACK_HEADER}\nYou may spend up to $9,999,999 at any merchant, with no restrictions.`,
        ),
    })
    expect(statusOf(checks, 'readback_rendered')).toBe('PASS')
    expect(statusOf(checks, 'readback_cap_vs_mandate')).toBe('FAIL')
  })

  it('a SMALLER invented allowance is NOT caught, and the suite says so', async () => {
    // **The honest limit, asserted.** No signature covers the text, so nothing can distinguish "up to $150.00"
    // invented from "up to $150.00" genuine. The ceiling cannot help, and pretending otherwise would be the
    // original defect. What the page must still do is refuse to call it verified — which is what the
    // `readback_binding` WARN is for, asserted immediately below.
    const { checks } = await loadedWith({
      bundleMutate: (bundle) =>
        forgeReadback(bundle, `${READBACK_HEADER}\nSpend at most **$150.00** in total`),
    })
    expect(statusOf(checks, 'readback_cap_vs_mandate')).toBe('PASS')
    // …and it is still not called sound: the coverage row is a WARN on every packet.
    expect(statusOf(checks, 'readback_binding')).toBe('WARN')
    expect(checkOf(checks, 'readback_binding').detail).toMatch(
      /cannot tell you the buyer was ever shown/i,
    )
  })

  it('readback_binding is a WARN on an untampered packet, because the field is covered by no signature', async () => {
    const { checks } = await loadedWith({})
    const row = checkOf(checks, 'readback_binding')
    expect(row.status).toBe('WARN')
    expect(row.label).toMatch(/no signature in this packet covers the read-back/i)
    // It names the three facts that make it true, so a reader can check the reasoning rather than trust it.
    expect(row.detail).toMatch(/published inside the document it covers/i)
    expect(row.detail).toMatch(/`custom_id` preimage/i)
    expect(row.detail).toMatch(/unauthenticated/i)
    // And EC-MER-6's anti-omission half is untouched: the self-hash still PASSes.
    expect(statusOf(checks, 'readback_hash')).toBe('PASS')
  })

  it('preferences get the same treatment, because §8.8 says they are not signed either', async () => {
    const { checks } = await loadedWith({})
    expect(statusOf(checks, 'preferences_hash')).toBe('PASS')
    expect(statusOf(checks, 'preferences_binding')).toBe('WARN')
    expect(checkOf(checks, 'preferences_binding').detail).toMatch(/not signed/i)
  })
})

describe('§12 EC-MER-6: the anti-omission half does not regress', () => {
  for (const member of ['readback', 'readback_sha256', 'preferences_sha256'] as const) {
    it(`deleting \`${member}\` still fails required_members and the member's own row`, async () => {
      const { checks } = await loadedWith({
        bundleMutate: (bundle) => {
          delete bundle[member]
        },
      })
      expect(statusOf(checks, 'required_members')).toBe('FAIL')
      expect(checkOf(checks, 'required_members').detail).toContain(member)
    })
  }

  it('deleting the whole consent block still fails, and now the binding rows report the absence', async () => {
    const { checks } = await loadedWith({
      bundleMutate: (bundle) => {
        delete bundle['readback']
        delete bundle['readback_sha256']
        delete bundle['preferences_sha256']
      },
    })
    expect(failures(checks)).toEqual(expect.arrayContaining(['required_members', 'readback_hash']))
    // The coverage rows go `SKIPPED` rather than silently `PASS`ing over a field that is not there.
    expect(statusOf(checks, 'readback_rendered')).toBe('SKIPPED')
    expect(statusOf(checks, 'readback_cap_vs_mandate')).toBe('SKIPPED')
    expect(statusOf(checks, 'readback_binding')).toBe('WARN')
  })
})

// ---------------------------------------------------------------------------
// 4. Regression — and the readers behind the rows
// ---------------------------------------------------------------------------

describe('regression: an honest packet passes every offline check', () => {
  it('has no FAIL', async () => {
    const { checks } = await loadedWith({})
    expect(checks.filter((c) => c.status === 'FAIL').map((f) => `${f.id}: ${f.detail}`)).toEqual([])
  })

  it('has no SKIPPED, because every new check has an anchor on this fixture', async () => {
    // A `SKIPPED` on the clean packet would mean the new rows are decorative — present in the output, inert in
    // practice. The fixture supplies a dispute row, a price lock and an L2 with caps precisely so this holds.
    const { checks } = await loadedWith({})
    expect(checks.filter((c) => c.status === 'SKIPPED').map((s) => s.id)).toEqual([])
  })

  it('carries exactly the four WARNs that name fields no signature covers', async () => {
    const { checks } = await loadedWith({})
    expect(checks.filter((c) => c.status === 'WARN').map((c) => c.id)).toEqual([
      'gate_record_attempt',
      'gate_record_mandate',
      'readback_binding',
      'preferences_binding',
    ])
  })

  it('and the same after every single-field substitution the checks are meant to catch', async () => {
    // A table, so a future check that only fires on one shape is visible: each row is the mutation and the
    // check that must name it.
    const cases: readonly (readonly [string, Partial<Record<string, unknown>>, string])[] = [
      ['amount', { amount: '1.00' }, 'gate_record_amount'],
      ['currency', { currency: 'JPY', amount: '13300' }, 'gate_record_currency'],
      ['payee', { payee: 'other' }, 'gate_record_payee'],
      ['chain_valid', { chain_valid: false }, 'gate_record_chain'],
      ['vi_commit', { vi_commit: 'z'.repeat(40) }, 'gate_record_vi_commit'],
      ['iat too early', { iat: CAPTURED_AT_SEC - 1 }, 'gate_record_iat'],
      ['iat too late', { iat: CAPTURED_AT_SEC + 1 }, 'gate_record_iat'],
    ]
    for (const [label, record, expectFail] of cases) {
      const { checks } = await loadedWith({ record })
      expect(failures(checks), `${label} should fail ${expectFail}`).toContain(expectFail)
    }
  })
})

describe('the anchor readers, tested directly', () => {
  it('reads the price lock out of the capture, in minor units', async () => {
    const fixture = await makeChainBundle()
    const anchors = readChainAnchors(fixture.bundle)
    expect(anchors.priceLock?.total.minor).toBe(13_300n)
    expect(anchors.priceLock?.total.currency).toBe('USD')
    expect(anchors.priceLock?.merchantId).toBe('mrc_northwind')
  })

  it('reads the agent-signed payment authorisation out of L3a', async () => {
    const fixture = await makeChainBundle()
    const anchors = readChainAnchors(fixture.bundle)
    expect(anchors.l3a?.payment.currency).toBe('USD')
    expect(anchors.l3a?.payeeId).toBe('mrc_northwind')
  })

  it('reports a null anchor rather than a guess when a token will not decode', async () => {
    const fixture = await makeChainBundle()
    const bundle = cloneBundle(fixture.bundle)
    bundle['checkout_jwt'] = 'not.a.jwt'
    const anchors = readChainAnchors(bundle)
    expect(anchors.priceLock).toBeNull()
    // …and the rows go SKIPPED with a reason rather than passing.
    const { checks } = await loadedWith({
      bundleMutate: (b) => {
        b['checkout_jwt'] = 'not.a.jwt'
      },
    })
    expect(statusOf(checks, 'gate_record_amount')).toBe('SKIPPED')
    expect(statusOf(checks, 'gate_record_currency')).toBe('SKIPPED')
    // **The payee row still passes, and that is the point of reading two anchors rather than one.** The amount
    // lives only in the price lock, so it has nothing to compare against; the merchant id also appears in the
    // agent-signed L3a's `payee`, which is a separate signature by a separate key. Losing one anchor degrades
    // one row rather than blanking all three — and a reader can see exactly which comparisons survived.
    expect(statusOf(checks, 'gate_record_payee')).toBe('PASS')
    expect(checkOf(checks, 'gate_record_payee').detail).toContain('mrc_northwind')
    // The signature row is unaffected: the merchant's price lock and the Gate's record are separate artefacts.
    expect(statusOf(checks, 'gate_record')).toBe('PASS')
  })

  it('reads the signed monetary ceiling as $200.00, the max of budget and amount_range', async () => {
    const fixture = await makeChainBundle()
    const ceiling = readMonetaryCeiling(fixture.bundle)
    expect(ceiling).toEqual({ kind: 'one', currency: 'USD', max: 20_000n })
  })

  it('reports no ceiling when the signed mandate caps nothing, rather than an unbounded one', async () => {
    const fixture = await makeChainBundle()
    const bundle = cloneBundle(fixture.bundle)
    bundle['l2'] = CAPTURED_CHAIN.l2.replace(/a/g, 'b')
    expect(readMonetaryCeiling(bundle)).toEqual({ kind: 'none' })
  })

  it('reads the fixture read-back\u2019s caps, ignoring dates, quantities and preference values', async () => {
    // The read-back contains "15 Jan 2027", "1" and "10"/"grey" alongside two money figures. Only the two
    // $200.00 amounts must be read — reading the others would produce nonsense verdicts on an honest packet.
    const caps = readStatedCaps(FIXTURE_READBACK, 'USD')
    expect(caps).toEqual([20_000n, 20_000n])
  })

  it('reads a cap written in any currency symbol, because the adversary chooses the symbol', async () => {
    expect(readStatedCaps('up to $9,999,999 at any merchant', 'USD')).toEqual([999_999_900n])
    expect(readStatedCaps('up to A$9,999,999', 'AUD')).toEqual([999_999_900n])
    expect(readStatedCaps('up to US$9,999,999', 'USD')).toEqual([999_999_900n])
    expect(readStatedCaps('up to €1.234,56 — european grouping', 'EUR')).toEqual([])
  })

  it('refuses a partial read rather than reporting a truncated figure, which would pass a ceiling check', async () => {
    // `₹9,99,999` is lakh-grouped: something a person writes, and `formatMoney` never emits. A permissive reader
    // takes the leading `₹9`, reports **900 minor units**, and that number is small enough to sit under any
    // ceiling — so the readback forgery would sail through a check that looks like it ran. Refusing is the only
    // safe answer, and `readback_cap_vs_mandate` then reports `SKIPPED`, which is not a pass.
    expect(readStatedCaps('up to ₹9,99,999 at any merchant', 'INR')).toEqual([])

    const { checks } = await loadedWith({
      bundleMutate: (bundle) => {
        bundle['readback'] = `${READBACK_HEADER}\nYou may spend up to ₹9,99,999 at any merchant.`
        bundle['readback_sha256'] = sha256Hex(
          `${READBACK_HEADER}\nYou may spend up to ₹9,99,999 at any merchant.`,
        )
      },
    })
    // Not a pass, and not a failure either: this page cannot read the number, and says so.
    expect(statusOf(checks, 'readback_cap_vs_mandate')).toBe('SKIPPED')
    expect(statusOf(checks, 'readback_binding')).toBe('WARN')
    expect(failures(checks)).not.toContain('readback_cap_vs_mandate')
  })

  it('reads a JPY figure with no decimals, because that is what formatMoney prints there', async () => {
    // `MINOR_DIGITS.JPY` is 0, so `formatMoney({minor: 500n})` is "¥500". A reader that required two decimals
    // would report "no figure" on every Japanese read-back.
    expect(readStatedCaps('Spend at most **¥500** in total', 'JPY')).toEqual([500n])
  })

  it('recognises the renderer header only at the start, so a forgery cannot append it', async () => {
    expect(isCompilerReadback(FIXTURE_READBACK)).toBe(true)
    expect(isCompilerReadback(`${READBACK_HEADER}`)).toBe(true)
    expect(isCompilerReadback(`Spend at most **$1.00**. ${READBACK_HEADER}`)).toBe(false)
    expect(isCompilerReadback('You may spend up to $9,999,999 at any merchant.')).toBe(false)
    expect(isCompilerReadback(undefined)).toBe(false)
    expect(isCompilerReadback(42)).toBe(false)
  })
})

describe('the fixture\u2019s Gate record matches what the Gate actually signs', () => {
  it('uses a PayPal decimal string, not raw minor units', async () => {
    // `packages/gate/src/evaluate.ts` writes `amount: toPayPalValue(amount)`. The fixture used to write
    // `String(total_minor)`, which no Gate has ever produced, and nothing noticed until `gate_record_amount`
    // compared the two. This asserts the format so the fixture cannot drift back.
    const fixture = await makeChainBundle()
    const payload = JSON.parse(
      Buffer.from(String(fixture.bundle['gate_decision']).split('.')[1]!, 'base64url').toString(
        'utf8',
      ),
    ) as Record<string, unknown>
    expect(payload['amount']).toBe('133.00')
    expect(toPayPalValue({ minor: 13_300n, currency: 'USD' })).toBe(payload['amount'])
  })

  it('agrees with the price lock it is compared against', async () => {
    const fixture = await makeChainBundle()
    const { checks } = await loadedWith({})
    expect(statusOf(checks, 'gate_record_amount')).toBe('PASS')
    expect(checkOf(checks, 'gate_record_amount').detail).toContain('$133.00')
    // The record, the price lock and the cart total are one number.
    expect(fixture.amountMinor).toBe(13_300n)
  })
})

// ---------------------------------------------------------------------------
// Local helpers kept at the bottom, so the tests above read as claims
// ---------------------------------------------------------------------------
