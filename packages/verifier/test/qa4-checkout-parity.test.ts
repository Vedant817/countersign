import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { PacketId } from '@countersign/core'
import { ViClient, type PublicVerifyResponse } from '@countersign/vi-client'

import { bundleHashBase64Url, bundleHashHex, textSha256Hex, wireBundle } from '../src/bundle'
import { renderVerifyPy, type VerifyPyKey } from '../src/verify-py'
import { defineVerifierDeps } from '../src/types'
import { loadVerifierPacket, offlineChecks } from '../src/verify-view'
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

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const VI_PROJECT = join(REPO_ROOT, 'apps', 'vi')
const BASE_URL = 'https://countersign.example'

function runPython(script: string, doc: unknown): { code: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cs-parity-'))
  writeFileSync(join(dir, 'verify.py'), script, 'utf8')
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(doc, null, 2), 'utf8')
  try {
    const stdout = execFileSync(
      'uv',
      ['run', '--project', VI_PROJECT, 'python', 'verify.py', 'bundle.json'],
      {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    return { code: 0, stdout }
  } catch (error) {
    const e = error as { status?: number; stdout?: string }
    return { code: e.status ?? -1, stdout: `${e.stdout ?? ''}` }
  }
}

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

async function loadedFor(fixture: ChainBundleFixture) {
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
  const client = new ViClient({
    baseUrl: 'http://vi.test',
    token: 'test-token',
    clock: fixtureClock(),
    sleep: async () => {},
    fetchImpl: (async () =>
      new Response(JSON.stringify(publicVerifyBody(fixture)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  })
  const deps = defineVerifierDeps({
    clock: fixtureClock(),
    store,
    vi: { publicVerify: (req) => client.publicVerify(req) },
    publicBaseUrl: BASE_URL,
  })
  const loaded = await loadVerifierPacket(deps, fixture.packetId as PacketId)
  expect(loaded.ok).toBe(true)
  if (!loaded.ok) throw new Error('fixture store failed')
  return { deps, loaded: loaded.value! }
}

/** Generate a genuinely ES256-signed alternative checkout JWT (valid signature, different cart). */
async function makeAlternateCheckoutJwt(): Promise<{
  jwt: string
  jwk: Record<string, unknown>
  kid: string
}> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const jwk = (await webcrypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>
  const kid = 'merchant-alt-signed-1'
  jwk.kid = kid
  jwk.alg = 'ES256'
  jwk.use = 'sig'

  const header = { alg: 'ES256', typ: 'JWT', kid }
  const payload = {
    iss: 'https://merchant.example',
    sub: 'user_fixture_0000000000000001',
    checkout_id: 'chk_alternate_cart_999',
    cart: {
      items: [{ sku: 'SKU-ALT-99', title: 'Substituted genuine cart', qty: 1, unit_minor: 11900 }],
      shipping_minor: 600,
      tax_minor: 800,
      total: { amount_minor: 13300, currency: 'USD' },
    },
    iat: CAPTURED_AT_SEC,
    exp: CAPTURED_AT_SEC + 900,
  }
  const enc = new TextEncoder()
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const data = enc.encode(`${headerB64}.${payloadB64}`)
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data)
  const sigB64 = Buffer.from(sig).toString('base64url')
  return { jwt: `${headerB64}.${payloadB64}.${sigB64}`, jwk, kid }
}

describe('QA4-VERIFIER-1 / EC-PRICE-1: offline verifier parity and checkout binding', () => {
  it('EC-PRICE-1: auditor repro - substituted merchant-signed checkout JWT rejected by both TS and verify.py', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const alt = await makeAlternateCheckoutJwt()

    // Substitute the genuinely signed checkout JWT into the bundle
    const bundle = cloneBundle(fixture.bundle)
    bundle['checkout_jwt'] = alt.jwt
    const storedBundleHash = bundleHashHex(bundle)

    const packet = { ...loaded, bundle, storedBundleHash }

    // 1. TypeScript offlineChecks
    const tsChecks = await offlineChecks(packet, CAPTURED_AT_SEC)
    const bindingCheck = tsChecks.find((c) => c.id === 'checkout_binding')
    expect(bindingCheck).toBeDefined()
    expect(bindingCheck?.status).toBe('FAIL')
    expect(bindingCheck?.detail).toMatch(/authorised a different cart|does not match/i)

    // 2. Python verify.py
    const keys: VerifyPyKey[] = [
      { kid: CAPTURED_CHAIN.issuerKid, role: 'ISSUER', public_jwk: CAPTURED_CHAIN.issuerPublicJwk },
      {
        kid: CAPTURED_CHAIN.merchantKid,
        role: 'MERCHANT',
        public_jwk: CAPTURED_CHAIN.merchantPublicJwk,
      },
      { kid: alt.kid, role: 'MERCHANT', public_jwk: alt.jwk },
      { kid: fixture.gateKid, role: 'GATE', public_jwk: fixture.gateJwk },
    ]
    const script = renderVerifyPy({
      packetId: fixture.packetId,
      bundle,
      bundleHashHex: storedBundleHash,
      keys,
      gateKid: fixture.gateKid,
    })
    const pyResult = runPython(script, { bundle })
    expect(pyResult.code).not.toBe(0)
    expect(pyResult.stdout).toContain('[FAIL] checkout_binding')
    expect(pyResult.stdout).toContain('authorised a different cart')
  })

  it('EC-PRICE-1: parity test - corpus yields identical verdicts across TypeScript offlineChecks and verify.py', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)
    const alt = await makeAlternateCheckoutJwt()

    const corpus = [
      { name: 'honest', checkoutJwt: fixture.bundle.checkout_jwt, expectedPass: true },
      { name: 'substituted_valid_cart', checkoutJwt: alt.jwt, expectedPass: false },
      {
        name: 'mismatched_raw_hash',
        checkoutJwt: `${String(fixture.bundle.checkout_jwt).slice(0, -6)}AAAAAA`,
        expectedPass: false,
      },
    ]

    const keys: VerifyPyKey[] = [
      { kid: CAPTURED_CHAIN.issuerKid, role: 'ISSUER', public_jwk: CAPTURED_CHAIN.issuerPublicJwk },
      {
        kid: CAPTURED_CHAIN.merchantKid,
        role: 'MERCHANT',
        public_jwk: CAPTURED_CHAIN.merchantPublicJwk,
      },
      { kid: alt.kid, role: 'MERCHANT', public_jwk: alt.jwk },
      { kid: fixture.gateKid, role: 'GATE', public_jwk: fixture.gateJwk },
    ]

    for (const item of corpus) {
      const bundle = cloneBundle(fixture.bundle)
      bundle['checkout_jwt'] = item.checkoutJwt
      const storedBundleHash = bundleHashHex(bundle)

      const packet = { ...loaded, bundle, storedBundleHash }

      const tsChecks = await offlineChecks(packet, CAPTURED_AT_SEC)
      const tsStatus = tsChecks.find((c) => c.id === 'checkout_binding')?.status

      const script = renderVerifyPy({
        packetId: fixture.packetId,
        bundle,
        bundleHashHex: storedBundleHash,
        keys,
        gateKid: fixture.gateKid,
      })
      const pyResult = runPython(script, { bundle })
      const pyPassed = pyResult.stdout.includes('[PASS] checkout_binding')
      const pyFailed = pyResult.stdout.includes('[FAIL] checkout_binding')

      if (item.expectedPass) {
        expect(tsStatus).toBe('PASS')
        expect(pyPassed).toBe(true)
        expect(pyFailed).toBe(false)
      } else {
        expect(tsStatus).toBe('FAIL')
        expect(pyPassed).toBe(false)
        expect(pyFailed).toBe(true)
      }
    }
  })

  it('EC-PRICE-1: honest bundle passes in both TypeScript offlineChecks and verify.py', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)

    const tsChecks = await offlineChecks(loaded, CAPTURED_AT_SEC)
    const tsFailed = tsChecks.filter((c) => c.status === 'FAIL')
    expect(tsFailed).toEqual([])
    expect(tsChecks.find((c) => c.id === 'checkout_binding')?.status).toBe('PASS')

    const keys: VerifyPyKey[] = [
      { kid: CAPTURED_CHAIN.issuerKid, role: 'ISSUER', public_jwk: CAPTURED_CHAIN.issuerPublicJwk },
      {
        kid: CAPTURED_CHAIN.merchantKid,
        role: 'MERCHANT',
        public_jwk: CAPTURED_CHAIN.merchantPublicJwk,
      },
      { kid: fixture.gateKid, role: 'GATE', public_jwk: fixture.gateJwk },
    ]
    const script = renderVerifyPy({
      packetId: fixture.packetId,
      bundle: fixture.bundle,
      bundleHashHex: fixture.bundleHash,
      keys,
      gateKid: fixture.gateKid,
    })
    const pyResult = runPython(script, { bundle: fixture.bundle })
    expect(pyResult.code).toBe(0)
    expect(pyResult.stdout).not.toContain('[FAIL]')
    expect(pyResult.stdout).toContain('RESULT: the document is internally consistent')
  })

  it('EC-MER-6: regression - previously-fixed substitutions stay caught (Gate record, packet, read-back)', async () => {
    const fixture = await makeChainBundle()
    const { loaded } = await loadedFor(fixture)

    // 1. Gate record substitution (tampered record payload)
    const bundleGate = cloneBundle(fixture.bundle)
    bundleGate['gate_decision'] = `${String(bundleGate['gate_decision']).slice(0, -4)}FFFF`
    const packetGate = {
      ...loaded,
      bundle: bundleGate,
      storedBundleHash: bundleHashHex(bundleGate),
    }
    const tsGate = await offlineChecks(packetGate, CAPTURED_AT_SEC)
    expect(tsGate.find((c) => c.id === 'gate_record')?.status).toBe('FAIL')

    // 2. Packet substitution (custom_id / bundle_hash mismatch)
    const bundlePacket = cloneBundle(fixture.bundle)
    ;(bundlePacket['paypal'] as Record<string, unknown>)['custom_id'] =
      'cs1:invalid_hash_value_fffffffffffffffffffffff'
    const packetTampered = {
      ...loaded,
      bundle: bundlePacket,
      storedBundleHash: fixture.bundleHash, // deliberately stale hash
    }
    const tsPacket = await offlineChecks(packetTampered, CAPTURED_AT_SEC)
    expect(tsPacket.find((c) => c.id === 'custom_id')?.status).toBe('FAIL')

    // 3. Readback substitution (forged ceiling)
    const bundleReadback = cloneBundle(fixture.bundle)
    bundleReadback['readback'] =
      '**What you are authorising**\nSpend at most **$9,999,999.00** in total'
    bundleReadback['readback_sha256'] = textSha256Hex(String(bundleReadback['readback']))
    const packetReadback = {
      ...loaded,
      bundle: bundleReadback,
      storedBundleHash: bundleHashHex(bundleReadback),
    }
    const tsReadback = await offlineChecks(packetReadback, CAPTURED_AT_SEC)
    expect(tsReadback.find((c) => c.id === 'readback_cap_vs_mandate')?.status).toBe('FAIL')
  })

  it('EC-PRICE-1 / AT-M18.1: verify.py executes via python on honest bundle (exit 0) and substituted bundle (exit 1 with failing check name)', async () => {
    const fixture = await makeChainBundle()
    const alt = await makeAlternateCheckoutJwt()

    const keys: VerifyPyKey[] = [
      { kid: CAPTURED_CHAIN.issuerKid, role: 'ISSUER', public_jwk: CAPTURED_CHAIN.issuerPublicJwk },
      {
        kid: CAPTURED_CHAIN.merchantKid,
        role: 'MERCHANT',
        public_jwk: CAPTURED_CHAIN.merchantPublicJwk,
      },
      { kid: alt.kid, role: 'MERCHANT', public_jwk: alt.jwk },
      { kid: fixture.gateKid, role: 'GATE', public_jwk: fixture.gateJwk },
    ]

    // 1. Honest bundle: exit 0
    const honestScript = renderVerifyPy({
      packetId: fixture.packetId,
      bundle: fixture.bundle,
      bundleHashHex: fixture.bundleHash,
      keys,
      gateKid: fixture.gateKid,
    })
    const honestRun = runPython(honestScript, { bundle: fixture.bundle })
    expect(honestRun.code).toBe(0)

    // 2. Substituted bundle: exit non-zero and prints failed check name
    const subBundle = cloneBundle(fixture.bundle)
    subBundle['checkout_jwt'] = alt.jwt
    const subHash = bundleHashHex(subBundle)
    const subScript = renderVerifyPy({
      packetId: fixture.packetId,
      bundle: subBundle,
      bundleHashHex: subHash,
      keys,
      gateKid: fixture.gateKid,
    })
    const subRun = runPython(subScript, { bundle: subBundle })
    expect(subRun.code).not.toBe(0)
    expect(subRun.stdout).toContain('checkout_binding')
    expect(subRun.stdout).toContain('FAILED checks:')
  })
})
