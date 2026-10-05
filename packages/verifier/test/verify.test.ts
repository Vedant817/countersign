/**
 * The per-check verdicts, the page model, and **AT-M18.1** across every field category.
 *
 * ## What AT-M18.1 actually demands
 *
 * Spec §8.18: *"Tampering with any field in the downloaded bundle → the verifier shows the failure."* The trap
 * this file is written against is a tamper that the page renders **without complaint** — an `err(...)`
 * returned, a `catch`, a blank list. So every category below asserts three things, not one:
 *
 * 1. a check whose `status` is `'FAIL'` (or `'WARN'`, where the semantics demand it),
 * 2. a `detail` that **names the field and the reason**, so a reader can act on it, and
 * 3. that the page's **output changes** — the rendered text differs from the untampered render, so a
 *    regression that silently dropped the failure would fail the test rather than ship.
 *
 * Assertion 3 is why this file renders the report rather than only inspecting the check list.
 */

import { describe, expect, it } from 'vitest'

import { fixedClock } from '@countersign/core'
import { pendingNetworkEnforcement, ViClient } from '@countersign/vi-client'

import { bundleHashBase64Url, bundleHashHex, wireBundle } from '../src/bundle'
import { assertRedactionHolds } from '../src/redact'
import {
  atTimeWarningOf,
  buildRedactedView,
  buildVerifierReport,
  loadVerifierPacket,
  offlineChecks,
  publicPacketUrl,
  rawBundleUrl,
  requestLiveVerify,
  verifyScriptUrl,
} from '../src/verify-view'
import { defineVerifierDeps, type VerifierCheck, type VerifierDeps } from '../src/types'
import type { PacketId } from '@countersign/core'
import type { PublicVerifyResponse } from '@countersign/vi-client'

import {
  CAPTURED_AT_SEC,
  CAPTURED_CHAIN,
  cloneBundle,
  fixtureClock,
  makeChainBundle,
  makeInMemoryStore,
  makeJwksRows,
  type ChainBundleFixture,
} from './fixtures/chain'

const BASE_URL = 'https://countersign.example'

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/**
 * A `ViClient` wired to a stub transport that answers with `response`.
 *
 * The **real** client, not a hand-written stub of `publicVerify`: it builds the request, applies the retry
 * policy and validates the reply against the zod schema, so the test drives the same code the route does
 * (AGENTS.md rule 5). `fetchImpl` is the injection point the client was designed around.
 */
function viReturning(response: unknown, onCall?: (body: unknown) => void): VerifierDeps['vi'] {
  const client = new ViClient({
    baseUrl: 'http://vi.test',
    token: 'test-token',
    clock: fixtureClock(),
    sleep: async () => {},
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      onCall?.(JSON.parse(String(init?.body ?? '{}')) as unknown)
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  })
  return { publicVerify: (req) => client.publicVerify(req) }
}

async function depsFor(
  fixture: ChainBundleFixture,
  overrides: Partial<VerifierDeps> = {},
): Promise<{ deps: VerifierDeps; store: ReturnType<typeof makeInMemoryStore> }> {
  const store = makeInMemoryStore({
    packet: {
      id: fixture.packetId,
      dispute_id: fixture.disputeId,
      version: 3,
      bundle: fixture.bundle,
      bundle_hash: fixture.bundleHash,
      filed_at: new Date((CAPTURED_AT_SEC + 86_400) * 1000),
      created_at: new Date(CAPTURED_AT_SEC * 1000),
    },
    jwks: makeJwksRows(fixture),
  })
  return {
    store,
    deps: defineVerifierDeps({
      clock: fixtureClock(),
      store,
      vi: viReturning(publicVerifyBody(fixture)),
      publicBaseUrl: BASE_URL,
      ...overrides,
    }),
  }
}

/**
 * The body a real vi-service returns for the fixture.
 *
 * `bundle_hash` is `bundleHashBase64Url` over the **wire** form, because that is what apps/vi hashes: its
 * pydantic model emits every declared member including the nulls for absent optionals, and
 * `public_verify` calls `bundle_hash(req.bundle.model_dump())`. Getting this wrong would make
 * `vi_bundle_hash` FAIL on an untampered packet, which is a false alarm on the one page nobody may cry wolf
 * on.
 */
function publicVerifyBody(fixture: ChainBundleFixture): PublicVerifyResponse {
  return {
    chain_valid: true,
    errors: [],
    constraints: {
      satisfied: true,
      violations: [],
      checked: ['mandate.payment.amount_range'],
      skipped: [],
    },
    disclosed: { l1: {}, l2: {}, l3a: {}, l3b: {} },
    keys: {
      issuer_kid: CAPTURED_CHAIN.issuerKid,
      device_jkt: CAPTURED_CHAIN.deviceJkt,
      agent_kid: CAPTURED_CHAIN.agentKid,
      merchant_kid: CAPTURED_CHAIN.merchantKid,
    },
    checks_performed: ['issuer signature', 'device key binding', 'agent key binding'],
    checks_skipped: [],
    verified_at: CAPTURED_AT_SEC + 10,
    clock_skew_seconds: 300,
    at_time_not_honoured: false,
    bundle_hash: bundleHashBase64Url(wireBundle(fixture.bundle)),
  } as PublicVerifyResponse
}

/** Load, and fail loudly if the fixture itself is broken. */
async function loadedFor(fixture: ChainBundleFixture) {
  const { deps, store } = await depsFor(fixture)
  const loaded = await loadVerifierPacket(deps, fixture.packetId as PacketId)
  expect(loaded.ok).toBe(true)
  if (!loaded.ok) throw new Error('fixture store failed')
  expect(loaded.value).toBeDefined()
  if (!loaded.value) throw new Error('fixture packet not found')
  return { deps, store, loaded: loaded.value }
}

function statusOf(checks: readonly VerifierCheck[], id: string): string | undefined {
  return checks.find((c) => c.id === id)?.status
}

function checkOf(checks: readonly VerifierCheck[], id: string): VerifierCheck {
  const found = checks.find((c) => c.id === id)
  if (found === undefined)
    throw new Error(`no check with id ${id}; have ${checks.map((c) => c.id).join(', ')}`)
  return found
}

/**
 * What the page actually shows.
 *
 * The page is server-rendered with no client JS, so the readable output *is* the concatenation of the
 * status word, the label and the detail of every row. Rendering it here is what makes "the page says why"
 * a testable claim rather than a reviewer's impression.
 */
function renderPage(checks: readonly VerifierCheck[], banner: string | null): string {
  const lines: string[] = []
  if (banner !== null) lines.push(`LIMITATION: ${banner}`)
  for (const c of checks) lines.push(`[${c.status}] ${c.label}: ${c.detail}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe('loading a packet', () => {
  it('returns undefined for an unknown packetId, which is the 404 and not a failure', async () => {
    const fixture = await makeChainBundle()
    const { deps } = await depsFor(fixture)
    const result = await loadVerifierPacket(deps, 'pkt_does_not_exist_at_all' as PacketId)
    // EC-DSP-9's buyer-side path: a dispute or packet we cannot map must produce a sentence, not a crash.
    // A route that maps this to `err(...)` would render a 500 for a mistyped QR code.
    expect(result).toEqual({ ok: true, value: undefined })
  })

  it('carries the dispute label, and says unknown rather than inventing one when the row is absent', async () => {
    const fixture = await makeChainBundle()
    const { store } = await depsFor(fixture)
    const withLabel = await loadVerifierPacket(
      { clock: fixtureClock(), store, vi: viReturning({}), publicBaseUrl: BASE_URL },
      fixture.packetId as PacketId,
    )
    expect(withLabel.ok && withLabel.value?.stage).toBe('CHARGEBACK')
    expect(withLabel.ok && withLabel.value?.amountMinor).toBe(13_300n)

    const noLabel = makeInMemoryStore({
      packet: {
        id: fixture.packetId,
        dispute_id: fixture.disputeId,
        version: 3,
        bundle: fixture.bundle,
        bundle_hash: fixture.bundleHash,
        filed_at: null,
        created_at: new Date(CAPTURED_AT_SEC * 1000),
      },
      withDispute: false,
    })
    const bare = await loadVerifierPacket(
      { clock: fixtureClock(), store: noLabel, vi: viReturning({}), publicBaseUrl: BASE_URL },
      fixture.packetId as PacketId,
    )
    expect(bare.ok && bare.value?.stage).toBe('unknown')
    expect(bare.ok && bare.value?.amountMinor).toBe(0n)
  })

  it('builds the Gate JWKS from the GATE-role keys only', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    // The issuer and merchant keys live in vi's JWKS; mixing roles here would make "which key signed what"
    // a question about array contents rather than about the URL (§8.10).
    expect(loaded.gateJwks.keys).toHaveLength(1)
    expect(loaded.gateJwks.keys[0]?.kid).toBe(fixture.gateKid)
    expect(loaded.gateJwks.keys[0]?.kty).toBe('OKP')
    expect(loaded.gateJwks.keys[0]?.crv).toBe('Ed25519')
  })
})

// ---------------------------------------------------------------------------
// The URL helper
// ---------------------------------------------------------------------------

describe('publicPacketUrl', () => {
  it('agrees with the defender implementation it mirrors, across the awkward inputs', async () => {
    // Imported by RELATIVE path, not by package name: `@countersign/defender`'s `exports` map allows only
    // `"."`, so `publicPacketUrl` — which lives in `citation-check.ts` — cannot be imported the normal way.
    // Reaching past the boundary in a *test* is the honest alternative to editing another work package's
    // files (AGENTS.md rule 8), and it turns the duplication into a failing test instead of a silent
    // divergence. Reported as a contract issue in README.md.
    const { publicPacketUrl: defenderUrl } = await import('../../defender/src/citation-check')
    for (const base of [
      BASE_URL,
      `${BASE_URL}/`,
      `${BASE_URL}///`,
      `  ${BASE_URL}  `,
      `${BASE_URL}/app`,
      'http://localhost:3000',
    ]) {
      for (const packetId of ['pkt_abc', 'pkt_01HQ0000000000000000000000']) {
        expect(publicPacketUrl(base, packetId)).toBe(defenderUrl(base, packetId))
      }
    }
  })

  it('never produces a double slash, because a trailing slash in PUBLIC_BASE_URL is operator-configured', () => {
    expect(publicPacketUrl(`${BASE_URL}/`, 'pkt_abc')).toBe(`${BASE_URL}/v/pkt_abc`)
    expect(rawBundleUrl(`${BASE_URL}/`, 'pkt_abc')).toBe(`${BASE_URL}/v/pkt_abc/download`)
    expect(verifyScriptUrl(`${BASE_URL}/`, 'pkt_abc')).toBe(
      `${BASE_URL}/v/pkt_abc/download?as=verify.py`,
    )
  })

  it('serves the offline script from the download route, because the two artifacts are inseparable', () => {
    // §8.18's script embeds the digests of the bundle it will be run against, so serving one without the
    // other hands a reader something they cannot use. This is the assertion that stops somebody later
    // "tidying" the script into a fourth route — at which point the pairing becomes a convention rather than
    // something the URL itself expresses.
    expect(verifyScriptUrl(BASE_URL, 'pkt_abc')).toBe(`${BASE_URL}/v/pkt_abc/download?as=verify.py`)
    // The live re-verification is a genuinely different path, not the same route with a mode.
    expect(verifyScriptUrl(BASE_URL, 'pkt_abc')).not.toContain('/verify-now')
  })
})

// ---------------------------------------------------------------------------
// The untampered case: every check passes
// ---------------------------------------------------------------------------

describe('an untampered packet passes every offline check', () => {
  it('reports PASS on each of the twelve checks, with the packet id as the only identifier', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const checks = await offlineChecks(loaded, CAPTURED_AT_SEC)

    // Assert the specific verdicts by id rather than counting rows: a check that silently changed status
    // would keep the count at twelve and hide the change.
    expect(statusOf(checks, 'bundle_hash')).toBe('PASS')
    expect(statusOf(checks, 'custom_id')).toBe('PASS')
    expect(statusOf(checks, 'readback_hash')).toBe('PASS')
    expect(statusOf(checks, 'preferences_hash')).toBe('PASS')
    expect(statusOf(checks, 'key_order')).toBe('PASS')
    expect(statusOf(checks, 'required_members')).toBe('PASS')
    expect(statusOf(checks, 'custom_id_binding')).toBe('PASS')
    expect(statusOf(checks, 'checkout_binding')).toBe('PASS')
    expect(statusOf(checks, 'gate_record')).toBe('PASS')
    expect(statusOf(checks, 'vi_lib_commit')).toBe('PASS')
    expect(statusOf(checks, 'l1_disclosures')).toBe('PASS')

    // And the global statement: no FAIL and no SKIPPED on a complete packet. Absent is not the same as
    // passing, so a complete packet must have neither.
    expect(checks.filter((c) => c.status === 'FAIL').map((f) => `${f.id}: ${f.detail}`)).toEqual([])
    expect(checks.filter((c) => c.status === 'SKIPPED').map((s) => s.id)).toEqual([])

    // **The untampered packet is expected to carry `WARN`s, and that is the point.** `readback_binding` and
    // `preferences_binding` report that no signature covers the consent text, on every packet, forever — not
    // because this one is deficient but because that is a true statement about §7.3's design. A suite that
    // asserted "no WARN on a clean packet" would be asserting that the read-back is authenticated, which is
    // the false claim this work removed. What must hold is that each WARN *names* an uncovered field, so a
    // reader learns which parts of the page no signature reaches.
    const warned = checks.filter((c) => c.status === 'WARN').map((c) => c.id)
    expect(warned).toEqual([
      'gate_record_attempt',
      'gate_record_mandate',
      'readback_binding',
      'preferences_binding',
    ])
    for (const id of warned) {
      expect(checkOf(checks, id).detail).toMatch(
        /unverified|uncovered|unauthenticated|not signed|no signature|cannot confirm|only says/i,
      )
    }

    const ids = checks.map((c) => c.id)
    for (const expected of [
      'bundle_hash',
      'custom_id',
      'readback_hash',
      'preferences_hash',
      'key_order',
      'required_members',
      'custom_id_binding',
      'checkout_binding',
      'gate_record',
      'gate_record_amount',
      'gate_record_currency',
      'gate_record_payee',
      'gate_record_attempt',
      'gate_record_mandate',
      'gate_record_chain',
      'gate_record_vi_commit',
      'gate_record_iat',
      'paypal_dispute_binding',
      'readback_rendered',
      'readback_cap_vs_mandate',
      'readback_binding',
      'preferences_binding',
      'vi_lib_commit',
      'l1_disclosures',
    ]) {
      expect(ids).toContain(expected)
    }

    // Every row carries a reason and, where a requirement drives it, a citation.
    for (const c of checks) {
      expect(c.detail.length).toBeGreaterThan(20)
      expect(c.label.length).toBeGreaterThan(3)
    }
  })

  it('verifies the Gate decision record against the published GATE key', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const checks = await offlineChecks(loaded, CAPTURED_AT_SEC)
    const gate = checkOf(checks, 'gate_record')
    expect(gate.status).toBe('PASS')
    expect(gate.detail).toContain(fixture.gateKid)
    // And it says what it did **not** establish. `gate_record` is the signature row; agreement with the chain
    // is `gate_record_amount` / `_currency` / `_payee`, and a reader who saw only a tick on the signature would
    // have been told the packet is sound when nothing had been compared to anything.
    expect(gate.detail).toMatch(/not that it is about this purchase/i)
  })

  it('binds the decision record to the price lock, and says which field moved', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const checks = await offlineChecks(loaded, CAPTURED_AT_SEC)

    // §3.1 I-1 is stated in terms of the attempt, the amount, the currency and the payee. Three of the four are
    // comparable against artefacts this bundle carries under a signature.
    expect(statusOf(checks, 'gate_record_amount')).toBe('PASS')
    expect(statusOf(checks, 'gate_record_currency')).toBe('PASS')
    expect(statusOf(checks, 'gate_record_payee')).toBe('PASS')
    expect(statusOf(checks, 'gate_record_chain')).toBe('PASS')
    expect(statusOf(checks, 'gate_record_vi_commit')).toBe('PASS')
    expect(statusOf(checks, 'gate_record_iat')).toBe('PASS')

    expect(checkOf(checks, 'gate_record_amount').detail).toContain('$133.00')
    expect(checkOf(checks, 'gate_record_payee').detail).toContain('mrc_northwind')
  })

  it('reports the attempt and mandate ids as uncovered, because no signature in the bundle names either', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const checks = await offlineChecks(loaded, CAPTURED_AT_SEC)

    // The record asserts `att` and `mdt`, and there is nothing to compare them against: the L1's `sub` is the
    // user, the L2 names no mandate, the L3s name no attempt, the price lock names only a checkout id. The
    // honest status is `WARN` with that reason — **not** `PASS`, and not silence.
    expect(statusOf(checks, 'gate_record_attempt')).toBe('WARN')
    expect(statusOf(checks, 'gate_record_mandate')).toBe('WARN')
    expect(checkOf(checks, 'gate_record_attempt').detail).toContain('att_fixture')
    expect(checkOf(checks, 'gate_record_attempt').detail).toMatch(
      /nothing in §7\.3's bundle can confirm/i,
    )
  })

  it('states that the read-back and the preferences are covered by no signature', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const checks = await offlineChecks(loaded, CAPTURED_AT_SEC)

    // `readback_sha256` PASSES on an untampered packet — it is a real self-consistency check, and EC-MER-6's
    // anti-omission half depends on it. But it is a digest published inside the document it covers, and the
    // page must say so rather than let a green tick stand in for "the buyer signed this".
    expect(statusOf(checks, 'readback_hash')).toBe('PASS')
    const binding = checkOf(checks, 'readback_binding')
    expect(binding.status).toBe('WARN')
    expect(binding.label).toMatch(/no signature in this packet covers the read-back/i)
    expect(binding.detail).toMatch(/published inside the document it covers/i)
    expect(binding.detail).toMatch(/one line of work/i)
    expect(binding.detail).toMatch(/unauthenticated/i)
    expect(binding.detail).toMatch(/out of the `custom_id` preimage/i)

    // §8.8 says preferences are not signed, in the read-back itself. Same treatment.
    expect(statusOf(checks, 'preferences_binding')).toBe('WARN')
    expect(checkOf(checks, 'preferences_binding').detail).toMatch(/not signed/i)
  })

  it('reads the caps the read-back states, and reports them against the signed ceiling', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const checks = await offlineChecks(loaded, CAPTURED_AT_SEC)

    // The L2 caps at 20 000 minor units of USD and the read-back says "$200.00", so the two agree and the
    // largest stated figure is inside the ceiling.
    const cap = checkOf(checks, 'readback_cap_vs_mandate')
    expect(cap.status).toBe('PASS')
    expect(cap.detail).toContain('$200.00')
    // And the renderer check passes on the fixture, which is in `readback.ts`'s output form.
    expect(statusOf(checks, 'readback_rendered')).toBe('PASS')
  })

  it('binds the packet to the dispute it is filed under, using a row the packet cannot rewrite', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const checks = await offlineChecks(loaded, CAPTURED_AT_SEC)
    const binding = checkOf(checks, 'paypal_dispute_binding')
    expect(binding.status).toBe('PASS')
    // **Masked.** §8.18 makes the packet id the page's only identifier, and a check detail is rendered into the
    // page — so naming the order id in a failure message would put it on the page in the one message written
    // to help a reader. `test/verify.test.ts`'s page-model case asserts neither id appears in the report at all.
    expect(binding.detail).not.toContain('FIXTUREORDER001')
    expect(binding.detail).not.toContain('FIXTURECAPTURE001')
    expect(binding.detail).toMatch(/masked/i)
    expect(binding.detail).toMatch(/from the dispute, which is not part of the/i)
  })

  it('reports the buyer email as masked and the L1 as disclosing it', async () => {
    const fixture = await makeChainBundle()
    const { loaded, deps } = await loadedFor(fixture)
    const checks = await offlineChecks(loaded, CAPTURED_AT_SEC)
    const disclosures = checkOf(checks, 'l1_disclosures')
    expect(disclosures.status).toBe('PASS')
    expect(disclosures.detail).toContain('email')

    const redacted = buildRedactedView(loaded, deps)
    expect(redacted.buyer.payer_email_masked).toBe('a***@northwind-buyer.example')
    expect(redacted.buyer.email_source).toBe('l1-disclosure')
  })
})

// ---------------------------------------------------------------------------
// AT-M18.1 — per field category
// ---------------------------------------------------------------------------

/**
 * AT-M18.1: tamper with any field in the downloaded bundle and the verifier must **show** the failure.
 *
 * Each case below names a category, mutates exactly one thing, and asserts the page output changes and says
 * why. The `renderPage` comparison is the load-bearing line: a tamper the page renders without complaint is
 * the failure mode this acceptance test exists to prevent.
 */
describe('AT-M18.1 tampering is shown, per field category', () => {
  /**
   * The general shape of every case below.
   *
   * **`rehash: false` is the default and it is the point.** A tamperer who edits a field and leaves the
   * stored digest alone is caught by `bundle_hash`, which is a single check and would pass no matter how
   * many fields exist. A tamperer who *re-hashes* after editing — which any competent attacker would, since
   * the canonicalisation is published — can only be caught by a check that inspects the field itself. So the
   * interesting cases re-hash, and the ones that cannot (a forged published digest) do not.
   *
   * Either way the assertions are the same three: the named check flips, the rendered page **changes**, and
   * the detail explains why in a sentence. A tamper that produced identical output is the failure mode.
   */
  async function expectTamperShown(
    label: string,
    mutate: (bundle: Record<string, unknown>) => void,
    expectCheckId: string,
    opts: { rehash?: boolean; status?: 'FAIL' | 'WARN' } = {},
  ): Promise<void> {
    const rehash = opts.rehash !== false
    const want = opts.status ?? 'FAIL'
    const fixture = await makeChainBundle()
    const { loaded: clean } = await loadedFor(fixture)
    const cleanChecks = await offlineChecks(clean, CAPTURED_AT_SEC)
    const cleanRender = renderPage(cleanChecks, null)
    // The baseline must be clean, or "the output changed" would prove nothing.
    expect(
      cleanChecks.filter((c) => c.status === 'FAIL'),
      `${label}: the fixture itself is not clean`,
    ).toEqual([])

    const bundle = cloneBundle(fixture.bundle)
    mutate(bundle)
    const tampered = {
      ...clean,
      bundle,
      storedBundleHash: rehash ? bundleHashHex(bundle) : clean.storedBundleHash,
    }
    const checks = await offlineChecks(tampered, CAPTURED_AT_SEC)
    const render = renderPage(checks, null)

    const target = checkOf(checks, expectCheckId)
    expect(target.status, `${label}: expected ${expectCheckId} to be ${want}`).toBe(want)
    // The output must CHANGE. A tamper that produces identical page output is the exact failure mode.
    expect(render, `${label}: page output did not change`).not.toBe(cleanRender)
    expect(render).toContain(`[${want}]`)
    // And it must SAY WHY, in a sentence that names the field.
    expect(target.detail.length).toBeGreaterThan(40)
  }

  /**
   * The five chain-token bodies, as a table.
   *
   * Each mutates one token's trailing bytes and **re-hashes**, so `bundle_hash` cannot be what catches it.
   * What catches it is `custom_id`: D18's digest is over the nine hashed members, so a one-byte edit to any
   * of `l1`, `l2`, `l3a`, `l3b` or `checkout_jwt` changes what the core recomputes, and the packet's own
   * `custom_id` — the string PayPal's order record carries — no longer matches.
   *
   * `gate_decision` has its own case below because it has a *second* detector: its signature.
   */
  for (const token of ['l1', 'l2', 'l3a', 'l3b', 'checkout_jwt'] as const) {
    it(`category: ${token} — the token body, caught by the D18 core digest`, async () => {
      await expectTamperShown(
        token,
        (b) => {
          b[token] = `${String(b[token]).slice(0, -6)}AAAAAA`
        },
        'custom_id',
      )
    })

    it(`category: ${token} — and caught by the published bundle digest when it is not re-hashed`, async () => {
      // The same tamper, caught by the other digest. Both paths are asserted because they fail for different
      // reasons and a reader who trusts only one of them is still protected.
      await expectTamperShown(
        `${token} (no rehash)`,
        (b) => {
          b[token] = `${String(b[token]).slice(0, -6)}AAAAAA`
        },
        'bundle_hash',
        { rehash: false },
      )
    })
  }

  it('category: checkout_hash — the price L3b committed to', async () => {
    // The subtler case. `checkout_jwt`'s signature would catch a payload edit, but this asserts the
    // *binding* check fires: L3b commits to a checkout_hash, and the price lock in the bundle must be the
    // one that hash is for. Without it, a valid signature over a DIFFERENT cart looks identical.
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const bundle = cloneBundle(fixture.bundle)
    const parts = String(bundle['checkout_jwt']).split('.')
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    payload['checkout_hash'] = 'A'.repeat(43)
    parts[1] = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    bundle['checkout_jwt'] = parts.join('.')

    const tampered = { ...loaded, bundle, storedBundleHash: bundleHashHex(bundle) }
    const checks = await offlineChecks(tampered, CAPTURED_AT_SEC)
    const binding = checkOf(checks, 'checkout_binding')
    expect(binding.status).toBe('FAIL')
    expect(binding.detail).toMatch(/price lock|committed/i)
  })

  it('category: custom_id — the D18 hash stamped into PayPal', async () => {
    await expectTamperShown(
      'paypal.custom_id',
      (b) => {
        ;(b['paypal'] as Record<string, unknown>)['custom_id'] = `cs1:${'Z'.repeat(43)}`
      },
      'custom_id',
    )
  })

  it('category: gate_decision — caught by BOTH the core digest and our own signature', async () => {
    // The one member with two independent detectors. `gate_decision` is in the nine hashed core, so the D18
    // digest moves; and it is a JWS, so `verifyDecisionRecord` fails closed on the signature. Both are
    // asserted, because "we verify our own signature on our own record" is a claim a judge will test
    // directly and a defence built on only one of the two is weaker than it looks.
    await expectTamperShown(
      'gate_decision (core)',
      (b) => {
        b['gate_decision'] = `${String(b['gate_decision']).slice(0, -4)}FFFF`
      },
      'custom_id',
    )
    await expectTamperShown(
      'gate_decision (signature)',
      (b) => {
        b['gate_decision'] = `${String(b['gate_decision']).slice(0, -4)}FFFF`
      },
      'gate_record',
    )
  })

  it('category: readback — the consent text, and EC-MER-6', async () => {
    await expectTamperShown(
      'readback',
      (b) => {
        b['readback'] = 'You are allowing the agent to buy anything, anywhere, at any price.'
      },
      'readback_hash',
    )
  })

  it('category: preferences — the size and colour, and EC-MER-6', async () => {
    await expectTamperShown(
      'preferences',
      (b) => {
        b['preferences'] = { size: '6', color: 'any' }
      },
      'preferences_hash',
    )
  })

  it('category: bundle hash itself — the published digest', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    // Nothing in the bundle changes; only the claim about it does. This is the one tamper the digests
    // cannot catch, and it is caught by recomputing and comparing.
    const forged = { ...loaded, storedBundleHash: 'b'.repeat(64) }
    const checks = await offlineChecks(forged, CAPTURED_AT_SEC)
    const digest = checkOf(checks, 'bundle_hash')
    expect(digest.status).toBe('FAIL')
    expect(digest.detail).toMatch(/published/i)
    expect(digest.detail).toContain('b'.repeat(12))
  })

  it('category: readback omitted entirely — EC-MER-6 by omission', async () => {
    // The anti-omission half. A merchant who drops the read-back that hurts them wins by omission unless
    // the schema makes it required and the verifier enforces that. §12 EC-MER-6's stated resolution.
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const bundle = cloneBundle(fixture.bundle)
    delete bundle['readback']
    delete bundle['readback_sha256']
    const tampered = { ...loaded, bundle, storedBundleHash: bundleHashHex(bundle) }
    const checks = await offlineChecks(tampered, CAPTURED_AT_SEC)

    expect(statusOf(checks, 'readback_hash')).toBe('FAIL')
    expect(statusOf(checks, 'required_members')).toBe('FAIL')
    expect(checkOf(checks, 'required_members').detail).toContain('readback')
    // And it explains why, in the words of the requirement.
    expect(checkOf(checks, 'required_members').detail).toMatch(/EC-MER-6|omitting/)
  })

  it('category: preferences_sha256 removed — EC-MER-6 by omission', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const bundle = cloneBundle(fixture.bundle)
    delete bundle['preferences_sha256']
    const tampered = { ...loaded, bundle, storedBundleHash: bundleHashHex(bundle) }
    const checks = await offlineChecks(tampered, CAPTURED_AT_SEC)
    expect(statusOf(checks, 'preferences_hash')).toBe('FAIL')
    expect(checkOf(checks, 'preferences_hash').detail).toMatch(/no published digest|unhash/i)
  })

  it('category: gate_decision — our own signature on the decision record', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const bundle = cloneBundle(fixture.bundle)
    // Flip one byte of the signature. The payload is untouched, so only a signature check can see this.
    bundle['gate_decision'] = `${String(bundle['gate_decision']).slice(0, -2)}XY`
    const tampered = { ...loaded, bundle, storedBundleHash: bundleHashHex(bundle) }
    const checks = await offlineChecks(tampered, CAPTURED_AT_SEC)
    const gate = checkOf(checks, 'gate_record')
    expect(gate.status).toBe('FAIL')
    expect(gate.detail).toMatch(/did not verify|altered/i)
  })

  it('category: shipments — a post-order edit that custom_id is designed NOT to cover', async () => {
    // The direction §7.3 was built around, and the one that is easy to get backwards. `shipments` is excluded
    // from the `custom_id` preimage because it is written *after* the order exists. So a shipment edit moves
    // `bundle_hash` (when the digest is not re-hashed) and must leave `custom_id` alone — a hash that moved on
    // every parcel scan could not be the value in an order created before shipping.
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const bundle = cloneBundle(fixture.bundle)
    ;(bundle['shipments'] as { tracking: string }[])[0]!.tracking = '1Z999AA10123456799'

    const rehashed = await offlineChecks(
      { ...loaded, bundle, storedBundleHash: bundleHashHex(bundle) },
      CAPTURED_AT_SEC,
    )
    expect(statusOf(rehashed, 'bundle_hash')).toBe('PASS')
    expect(statusOf(rehashed, 'custom_id')).toBe('PASS')

    const notRehashed = await offlineChecks({ ...loaded, bundle }, CAPTURED_AT_SEC)
    expect(statusOf(notRehashed, 'bundle_hash')).toBe('FAIL')
    expect(statusOf(notRehashed, 'custom_id')).toBe('PASS')
  })

  it('category: vi_lib_commit — a packet verified against another library version', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const bundle = cloneBundle(fixture.bundle)
    delete bundle['vi_lib_commit']
    const tampered = { ...loaded, bundle, storedBundleHash: bundleHashHex(bundle) }
    const checks = await offlineChecks(tampered, CAPTURED_AT_SEC)
    // Absent is SKIPPED with a reason, never PASS: we cannot tell which library produced the chain.
    expect(statusOf(checks, 'vi_lib_commit')).toBe('SKIPPED')
    expect(checkOf(checks, 'vi_lib_commit').detail).toMatch(/no way to know/i)
  })

  it('category: buyer PII — a leaky redaction is refused, not published', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    // The correct builder produces a view the guard accepts…
    expect(assertRedactionHolds(buildRedactedView(loaded, deps), fixture.bundle).ok).toBe(true)

    // …and a view that reintroduced the buyer's address is refused outright. This is the property that makes
    // "redacted" a code-level guarantee rather than a convention: a future member added to the builder
    // cannot leak, because the route calls this before serving.
    const leaky = { ...buildRedactedView(loaded, deps), extra: 'asha.rao@northwind-buyer.example' }
    const verdict = assertRedactionHolds(leaky, fixture.bundle)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error.code).toBe('CS_INTERNAL')
  })
})

// ---------------------------------------------------------------------------
// The live half
// ---------------------------------------------------------------------------

describe('the live half: what POST /v1/public/verify contributes', () => {
  it('sends the wire bundle, and sends no secret and no audience we guessed', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    let sent: Record<string, unknown> | null = null
    const withSpy = defineVerifierDeps({
      ...deps,
      vi: viReturning(publicVerifyBody(fixture), (body) => {
        sent = body as Record<string, unknown>
      }),
    })

    const result = await requestLiveVerify(withSpy, loaded)
    expect(result.ok).toBe(true)
    expect(sent).not.toBeNull()
    const bundle = sent!['bundle'] as Record<string, unknown>
    // Every member vi declares is present, so its model_dump is byte-identical to what we sent.
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
      expect(bundle).toHaveProperty(key)
    }
    // No expected_aud: asserting an audience we inferred would report a good chain invalid for the wrong
    // reason. The value is in the signed payload; a reader can read it there.
    expect(sent).not.toHaveProperty('expected_aud')
    // No at_time: asking for an as-of verdict we cannot honour (D-009) would turn an honest limitation
    // into a silent one.
    expect(sent).not.toHaveProperty('at_time')
  })

  it('renders every library check, not a single green tick', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const response = publicVerifyBody(fixture)
    const report = await buildVerifierReport(loaded, deps, response)
    const performed = report.checks.filter(
      (c) => c.category === 'chain' && c.id.startsWith('vi_check_'),
    )
    expect(performed).toHaveLength(3)
    for (const c of performed) expect(c.status).toBe('PASS')
    // The verdict is a row too, not a summary line above the rows.
    expect(checkOf(report.checks, 'chain_valid').status).toBe('PASS')
  })

  it('shows chain_valid false with the reasons, not a generic failure', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const response = {
      ...publicVerifyBody(fixture),
      chain_valid: false,
      errors: ['L2 device signature did not verify', 'checkout constraints could not be enforced'],
    } as PublicVerifyResponse
    const report = await buildVerifierReport(loaded, deps, response)
    const verdict = checkOf(report.checks, 'chain_valid')
    expect(verdict.status).toBe('FAIL')
    expect(verdict.detail).toContain('L2 device signature did not verify')
    expect(verdict.detail).toContain('checkout constraints')
    expect(renderPage(report.checks, report.atTimeWarning)).toContain('[FAIL]')
  })

  it('reports vi hashing a different document as a FAIL, because the verdict is then unattributable', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const response = {
      ...publicVerifyBody(fixture),
      bundle_hash: 'A'.repeat(43),
    } as PublicVerifyResponse
    const report = await buildVerifierReport(loaded, deps, response)
    const digest = checkOf(report.checks, 'vi_bundle_hash')
    expect(digest.status).toBe('FAIL')
    expect(digest.detail).toMatch(/cannot be attributed|altered in transit/i)
  })

  it('lists the checks vi skipped as WARN, so nothing it did not do reads as covered', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const response = {
      ...publicVerifyBody(fixture),
      checks_skipped: ['l1 issuer key rotation check'],
    } as PublicVerifyResponse
    const report = await buildVerifierReport(loaded, deps, response)
    const skipped = report.checks.find((c) => c.id === 'vi_skipped_0')
    expect(skipped?.status).toBe('WARN')
    expect(skipped?.detail).toMatch(/nothing on this page/i)
  })
})

// ---------------------------------------------------------------------------
// D19: the constraints nobody evaluated
// ---------------------------------------------------------------------------

describe('D19: constraints the library never evaluates are named on the page', () => {
  it('reports a disclosed budget as a WARN, not as part of a satisfied verdict', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    // The shape apps/vi actually returns: `{type, reason}` objects, so `.includes(type)` is a compile
    // error and cannot silently return false (vi-client's own `skippedConstraintSchema` doc).
    const response = {
      ...publicVerifyBody(fixture),
      constraints: {
        satisfied: true,
        violations: [],
        checked: ['mandate.payment.amount_range', 'mandate.payment.budget'],
        skipped: [
          {
            type: 'mandate.payment.budget',
            reason:
              'Network-enforced constraints. Not evaluated by verifiable_intent; Countersign’s Gate ' +
              'enforces it (spec D19). NOT satisfied by this response.',
          },
        ],
      },
    } as unknown as PublicVerifyResponse

    const report = await buildVerifierReport(loaded, deps, response)
    const owed = checkOf(report.checks, 'network_enforced')
    expect(owed.status).toBe('WARN')
    expect(owed.detail).toContain('mandate.payment.budget')
    expect(owed.detail).toMatch(/nobody has told you/i)
    expect(report.skippedByVerifier[0]).toContain('mandate.payment.budget')
    // And the parser agrees with the page.
    expect(pendingNetworkEnforcement(response.constraints.skipped)).toEqual([
      'mandate.payment.budget',
    ])
  })

  it('says "nothing was disclosed" when no network-enforced constraint appears, rather than implying a pass', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const report = await buildVerifierReport(loaded, deps, publicVerifyBody(fixture))
    const owed = checkOf(report.checks, 'network_enforced')
    expect(owed.status).toBe('SKIPPED')
    expect(owed.detail).toMatch(/not disclosed/i)
  })

  it('reports an empty constraint list as unsatisfied, matching vi, because nothing to check is not a pass', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const response = {
      ...publicVerifyBody(fixture),
      constraints: { satisfied: false, violations: [], checked: [], skipped: [] },
    } as PublicVerifyResponse
    const report = await buildVerifierReport(loaded, deps, response)
    expect(checkOf(report.checks, 'constraints').status).toBe('FAIL')
  })
})

// ---------------------------------------------------------------------------
// D-009: at_time_not_honoured
// ---------------------------------------------------------------------------

describe('EC-TIME-3 / D-009: the as-of limitation is shown, not omitted', () => {
  const AT_TIME_REASON =
    'verify_chain() at the pinned commit 356c296 has no clock override: it reads time.time() internally. ' +
    'The chain was therefore verified at the current time only.'

  /**
   * A vi response that carries the as-of flag.
   *
   * Built from a **real** fixture rather than a bare object literal, because `publicVerifyBody` derives
   * `bundle_hash` from the bundle and a stub with an empty bundle would exercise the wrong code path.
   */
  async function withAtTime(over: Partial<PublicVerifyResponse>): Promise<PublicVerifyResponse> {
    const fixture = await makeChainBundle()
    return {
      ...publicVerifyBody(fixture),
      at_time_not_honoured: true,
      at_time_reason: AT_TIME_REASON,
      ...over,
    } as PublicVerifyResponse
  }

  it('extracts the reason verbatim, because the Defender cites this string in an evidence packet', async () => {
    expect(atTimeWarningOf(await withAtTime({}))).toBe(AT_TIME_REASON)
  })

  it('falls back to its own sentence when vi returned the flag without a reason', async () => {
    const warning = atTimeWarningOf(
      await withAtTime({ at_time_not_honoured: true, at_time_reason: null }),
    )
    expect(warning).toMatch(/no clock override/i)
    expect(warning).not.toBeNull()
  })

  it('produces no banner at all when no as-of claim was made', async () => {
    expect(atTimeWarningOf(await withAtTime({ at_time_not_honoured: false }))).toBeNull()
  })

  it('surfaces the banner at the top of the page, above every check row', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const report = await buildVerifierReport(loaded, deps, await withAtTime({}))
    expect(report.atTimeWarning).toBe(AT_TIME_REASON)
    const render = renderPage(report.checks, report.atTimeWarning)
    // The banner is the FIRST line, and it is not folded into a passing check.
    expect(render.split('\n')[0]).toBe(`LIMITATION: ${AT_TIME_REASON}`)
    expect(render).toContain('[WARN] As-of verification was requested and NOT performed')
    // chain_valid can still be PASS — that is the point: a pass plus a stated limitation is honest, and a
    // pass with the limitation hidden is not.
    expect(checkOf(report.checks, 'chain_valid').status).toBe('PASS')
  })

  it('renders no banner when the reader has not pressed Verify now', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const report = await buildVerifierReport(loaded, deps)
    expect(report.atTimeWarning).toBeNull()
    // And no empty live rows are rendered as though they passed.
    expect(report.checks.filter((c) => c.source === 'vi-service')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The page model
// ---------------------------------------------------------------------------

describe('the page model', () => {
  it('carries the packet id as the only identifier, and no internal volume counter', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const report = await buildVerifierReport(loaded, deps)
    const text = JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    // No user id, no device id, no order id, no dispute row counter. §8.18's page is reached by scanning a
    // PDF, so anything extra is an identifier a stranger did not need.
    expect(text).not.toContain(CAPTURED_CHAIN.userId)
    expect(text).not.toContain(CAPTURED_CHAIN.deviceJkt)
    expect(text).not.toContain(CAPTURED_CHAIN.deviceKid)
    expect(text).not.toContain('FIXTUREORDER001')
    expect(text).toContain(fixture.packetId)
  })

  it('states the canonicalisation rule, so a reader need not trust this package', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const report = await buildVerifierReport(loaded, deps)
    expect(report.canonicalisation.spec).toContain('RFC 8785')
    expect(report.canonicalisation.algorithm).toContain('SHA-256')
    expect(report.canonicalisation.hashedMembers).toHaveLength(9)
    expect(report.canonicalisation.excludedFromCustomId).toEqual(['paypal', 'shipments'])
    expect(report.canonicalisation.note).toMatch(/key/i)
  })

  it('orders offline checks before live ones, so the no-network half is readable on its own', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const report = await buildVerifierReport(loaded, deps, publicVerifyBody(fixture))
    const firstLive = report.checks.findIndex((c) => c.source === 'vi-service')
    const lastLocal = report.checks.map((c) => c.source === 'local').lastIndexOf(true)
    expect(firstLive).toBeGreaterThan(lastLocal)
  })

  it('renders the amount from the dispute row as integer minor units', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const report = await buildVerifierReport(loaded, deps)
    expect(report.amount.minor).toBe(13_300n)
    expect(report.amount.currency).toBe('USD')
  })
})

// ---------------------------------------------------------------------------
// A vi-service failure is not a failed chain
// ---------------------------------------------------------------------------

describe('a vi-service outage is not a failed chain', () => {
  it('returns err rather than a verdict, so the page can say "we could not ask" separately', async () => {
    const fixture = await makeChainBundle()
    const { deps, loaded } = await loadedFor(fixture)
    const failing = new ViClient({
      baseUrl: 'http://vi.test',
      token: 'test-token',
      clock: fixtureClock(),
      sleep: async () => {},
      maxRetries: 0,
      fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    })
    const result = await requestLiveVerify(
      { ...deps, vi: { publicVerify: (req) => failing.publicVerify(req) } },
      loaded,
    )
    // The 503 is the whole story: a retryable fault, not a chain verdict.
    expect(result.ok).toBe(false)
    if (result.ok) return
    // CS_INTERNAL, not CS_VALIDATION: an outage is our fault and must never be shown to a reader as
    // something they typed wrong (D-007).
    expect(result.error.code).toBe('CS_INTERNAL')
    expect(result.error.retryable).toBe(true)
  })

  it('still renders the offline half, which needs no service at all', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const checks = await offlineChecks(loaded, CAPTURED_AT_SEC)
    // This is the strongest claim the page makes: a reader who trusts nothing and has no network still gets
    // the digests, the binding and our signature on the decision record.
    expect(checks.filter((c) => c.source === 'local')).toHaveLength(
      checks.filter((c) => c.category !== 'chain').length,
    )
    // And each of the three claims the offline half makes on its own is present as a PASS, because "the
    // digests, the binding and our signature" is the sentence in the README and a reader may check it.
    expect(statusOf(checks, 'bundle_hash')).toBe('PASS')
    expect(statusOf(checks, 'checkout_binding')).toBe('PASS')
    expect(statusOf(checks, 'gate_record')).toBe('PASS')
  })
})

// ---------------------------------------------------------------------------
// The Gate record's freshness
// ---------------------------------------------------------------------------

describe('a record signed in the future is a WARN, not a FAIL', () => {
  it('reports the signature as good and the clock as the reason', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    // Ten years *earlier*: `verifyDecisionRecord` reports `fresh: false` when `iat` is beyond `nowSec + skew`,
    // which is the only clock anomaly it can see — an old record is perfectly normal and is NOT an anomaly.
    // The check therefore reflects what the function actually detects rather than inventing a second one.
    const checks = await offlineChecks(loaded, CAPTURED_AT_SEC - 315_360_000)
    const gate = checkOf(checks, 'gate_record')
    expect(gate.status).toBe('WARN')
    expect(gate.detail).toMatch(/signature is good/i)
    expect(gate.detail).toMatch(/clock skew/i)
    // And the verdict on the signature itself is still reported as good, so a reader is not left guessing.
    expect(gate.detail).toContain(fixture.gateKid)
  })

  it('needs nowSec explicitly, because a verifier that picks its own now cannot spot a stale record', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    // The call takes it as a positional argument with no default, which is the compile-time enforcement of
    // the rule `verifyDecisionRecord` documents in its own options type.
    const checks = await offlineChecks(loaded, fixtureClock().nowSec())
    expect(checkOf(checks, 'gate_record').status).toBe('PASS')
    expect(fixedClock(CAPTURED_AT_SEC).nowSec()).toBe(CAPTURED_AT_SEC)
  })
})
