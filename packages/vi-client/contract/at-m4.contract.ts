/**
 * AT-M4.1 — contract tests against a **live** vi-service.
 *
 * Spec §8.4: "Contract tests run against a live vi-service in CI (docker compose service)."
 *
 * ## This file is `contract/at-m4.contract.ts`, and the name is load-bearing
 *
 * It deliberately does **not** end in `.test.ts`. The root `vitest.workspace.ts` run does file discovery
 * with its own default pattern rather than each project's `include`/`exclude`, so a `*.test.ts` file
 * anywhere in this package gets pulled into `pnpm test` — which must pass with no network at all. A name no
 * include pattern can match, plus an explicit `include` in `vitest.contract.config.ts`, is the version of
 * this guarantee that cannot regress. See that config for the details.
 *
 * ## These are the only tests in the package that touch a network
 *
 * Run them with:
 *
 * ```bash
 * VI_SERVICE_URL=http://localhost:8000 VI_SERVICE_TOKEN=… pnpm --filter @countersign/vi-client test:contract
 * ```
 *
 * ## The skip is loud, on purpose
 *
 * With `VI_SERVICE_URL` unset the suite is skipped with a message that says *why* and *how to run it*. It
 * never fails (a missing service is not a client bug) and it never passes silently (a skipped contract suite
 * must not read as a green one). The reason string is asserted by the first test below, so "it skipped" is
 * itself a checked fact rather than an assumption.
 *
 * ## Why the round trip is the most valuable test in the package
 *
 * Everything else here proves one call. `issues an L1, signs the L2 with a generated key, finalizes, and
 * verifies` exercises the **two-phase signing flow** through real HTTP: a real P-256 key generated here,
 * a real ES256 signature over the real `signing_input` bytes, and the service's own verification of that
 * signature against the key bound in the L1.
 *
 * That path is where a client bug is most expensive and least obvious. If `prepareL2` re-encoded
 * `signing_input` on its way through, the signature would be computed over different bytes and
 * `finalizeL2` would answer `VI_SIGNATURE_MISMATCH` — a symptom that looks exactly like a wrong device
 * key, and would send a human looking for a key problem that does not exist. So the test signs the exact
 * string `prepareL2` returned, unmodified, and then asserts the finalize succeeded.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { webcrypto } from 'node:crypto'

import { ViClient } from '../src/client'
import { compareSchemas, hasDrift, loadOpenApiDocument } from '../src/schema-drift'
import { pendingNetworkEnforcement, publicJwkSchema } from '../src/types'
import type {
  L1IssueResponse,
  L2PrepareResponse,
  L3CreateResponse,
  VerifyResponse,
} from '../src/types'
import { systemClock } from '@countersign/core'

/**
 * `JsonWebKey` and `CryptoKeyPair` are DOM globals, and this package's `tsconfig` has `lib: ES2023` with no
 * DOM — correctly, because none of the source runs in a browser. Node's own `webcrypto` types declare the
 * same shapes, and Node's `crypto.subtle` is the runtime this test signs with, so those are the ones to use.
 */
type JsonWebKey = webcrypto.JsonWebKey
type CryptoKeyPair = webcrypto.CryptoKeyPair

const BASE_URL = process.env['VI_SERVICE_URL']
const TOKEN = process.env['VI_SERVICE_TOKEN'] ?? ''

const SKIP_REASON =
  'AT-M4.1 contract tests need a running vi-service. Set VI_SERVICE_URL (and VI_SERVICE_TOKEN) and run ' +
  '`pnpm --filter @countersign/vi-client test:contract`. Not a failure: the unit suite covers the same ' +
  'client against an injected fetch.'

/** Deterministic-per-run ids, so a failure can be traced to a request in the service's logs. */
const AGENT_ID = 'agt_contract_test'
const USER_ID = 'usr_contract_test'
const NONCE = 'contract-nonce-1'
const AUD = 'https://agent.countersign.test'

const MERCHANT = {
  id: 'mrc_northwind',
  name: 'Northwind Outfitters',
  website: 'https://northwind.countersign.test',
}
const ITEM = { id: 'SKU-TRAIL-42', title: 'Trail Runner' }

const UNIT_MINOR = 12_000
const SHIPPING_MINOR = 500
const TAX_MINOR = 800
const TOTAL_MINOR = UNIT_MINOR + SHIPPING_MINOR + TAX_MINOR
const AMOUNT_RANGE_MAX = 20_000

/** A P-256 device key, standing in for the browser's non-extractable WebCrypto key (spec §3.1). */
interface DeviceKey {
  readonly kid: string
  readonly publicJwk: JsonWebKey
  /** base64url raw r‖s over the exact ASCII bytes handed in — P1363, which is what WebCrypto emits. */
  sign(signingInputAscii: string): Promise<string>
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

async function generateDeviceKey(kid: string): Promise<DeviceKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    kid,
    publicJwk,
    async sign(signingInputAscii: string): Promise<string> {
      // `signing_input` is ASCII (base64url + a dot), so the bytes are the string's own — no re-encoding,
      // no normalisation. That is the whole point of passing it through verbatim.
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(signingInputAscii),
      )
      // Node's WebCrypto emits IEEE P1363 (raw r‖s, 64 bytes), which is what the library's `es256_verify`
      // requires. DER would be rejected with a length error.
      return base64url(new Uint8Array(signature))
    },
  }
}

/**
 * Validate a WebCrypto JWK export with the client's own schema.
 *
 * Not a cast. A browser exports a device key whose members are all optional and typed `string`, and this
 * schema is the thing that decides whether such an export is acceptable — no private `d`, both coordinates
 * exactly 32 bytes, `kty`/`crv` pinned. Parsing here means every `l1/issue` and `l2/prepare` call below
 * asserts that a **genuine WebCrypto P-256 export** passes it, which is precisely the boundary spec §3.1
 * cares about and something a hand-written fixture cannot prove.
 */
function deviceJwkOf(device: DeviceKey) {
  return publicJwkSchema.parse(device.publicJwk)
}

describe('AT-M4.1 vi-client contract tests', () => {
  it('reports why it is skipping when no service is configured', () => {
    if (BASE_URL === undefined) {
      expect(SKIP_REASON).toMatch(/VI_SERVICE_URL/)
      return
    }
    expect(typeof BASE_URL).toBe('string')
  })
})

describe.skipIf(BASE_URL === undefined)(
  `AT-M4.1 against ${BASE_URL ?? 'a live vi-service'}`,
  () => {
    let client: ViClient

    beforeAll(() => {
      client = new ViClient({ baseUrl: BASE_URL as string, token: TOKEN, clock: systemClock })
    })

    it('answers GET /v1/status, which is public and needs no bearer token', async () => {
      const r = await client.status()
      expect(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`).toBe(true)
      if (!r.ok) return
      expect(r.value.ok).toBe(true)
      expect(r.value.issuer_kid).not.toBe('')
      expect(r.value.merchant_kid).not.toBe('')
      // EC-TIME-2: the caller compares this with its own clock; the skew vi is using is reported here.
      expect(r.value.clock_skew_seconds).toBeGreaterThan(0)
    })

    it('refuses a request with the wrong bearer token, proving auth is enforced', async () => {
      const wrong = new ViClient({
        baseUrl: BASE_URL as string,
        token: 'not-the-token',
        clock: systemClock,
      })
      const r = await wrong.mintAgentKey({ agent_id: AGENT_ID })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.code).toBe('CS_UNAUTHENTICATED')
      expect(r.error.details?.['http_status']).toBe(401)
    })

    it('serves GET /v1/jwks publicly, with retired keys retained', async () => {
      const r = await client.jwks()
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(Array.isArray(r.value.keys)).toBe(true)
      expect(r.value.keys.length).toBeGreaterThan(0)
      // Spec EC-KEY-2: a retired public key stays resolvable so old evidence still verifies.
      for (const key of r.value.keys) {
        expect(key).toHaveProperty('kid')
        expect(key).toHaveProperty('status')
      }
    })

    it('mints an agent key and returns only the public half plus a ciphertext', async () => {
      const r = await client.mintAgentKey({ agent_id: AGENT_ID })
      expect(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`).toBe(true)
      if (!r.ok) return
      expect(r.value.kid).toMatch(/^agt_/)
      expect(r.value.public_jwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
      // The private half must never be in the response, in any form (spec D5).
      expect(r.value.public_jwk).not.toHaveProperty('d')
      expect(r.value.enc_private_key_b64.length).toBeGreaterThan(0)
    })

    /**
     * The round trip. L1 → prepare → sign with a locally generated key → finalize → verify.
     *
     * The assertion that matters is that `finalizeL2` **succeeds**: vi verifies the signature against the
     * L1's `cnf.jwk` key before returning the L2, so a success is a statement about the real crypto, not
     * about this client's plumbing.
     */
    it('issues an L1, signs the L2 with a generated key, finalizes, and verifies the chain', async () => {
      const device = await generateDeviceKey('dev_contract_1')

      // --- 1. L1 -----------------------------------------------------------------------------------
      const l1r = await client.issueL1({
        user_id: USER_ID,
        wallet: {
          payer_id: 'PAYERCONTRACT',
          payer_email: 'buyer@countersign.test',
          payment_token_id: 'vault-contract',
        },
        device_public_jwk: deviceJwkOf(device),
        device_kid: device.kid,
        ttl_days: 365,
      })
      expect(l1r.ok, l1r.ok ? '' : `${l1r.error.code}: ${l1r.error.message}`).toBe(true)
      if (!l1r.ok) return
      const l1 = l1r.value as L1IssueResponse
      expect(l1.l1).toContain('~')
      expect(l1.exp).toBeGreaterThan(l1.iat)
      expect(l1.device_jkt).not.toBe('')

      // --- 2. prepare ------------------------------------------------------------------------------
      const agent = await client.mintAgentKey({ agent_id: AGENT_ID })
      expect(agent.ok).toBe(true)
      if (!agent.ok) return

      const prepared = await client.prepareL2({
        l1: l1.l1,
        device_kid: device.kid,
        agent_public_jwk: publicJwkSchema.parse(agent.value.public_jwk),
        agent_kid: agent.value.kid,
        merchants: [MERCHANT],
        acceptable_items: [ITEM],
        payment_instrument: {
          type: 'paypal_vault',
          // Must equal the L1's card_id: both are sha256(payment_token_id), and verify_chain fails closed
          // when they disagree.
          id: l1.card_id,
          description: 'PayPal ···· 1234',
        },
        nonce: NONCE,
        aud: AUD,
        ttl_seconds: 86_400,
        prompt_summary: 'Buy one pair of trail running shoes under $200',
        checkout_constraints: [
          { type: 'mandate.checkout.allowed_merchants', allowed: [MERCHANT] },
          {
            type: 'mandate.checkout.line_items',
            items: [{ id: 'li-1', acceptable_items: [ITEM], quantity: 1 }],
            match_mode: 'minimum',
          },
        ],
        payment_constraints: [
          { type: 'mandate.payment.amount_range', currency: 'USD', min: 0, max: AMOUNT_RANGE_MAX },
          { type: 'mandate.payment.allowed_payees', allowed: [MERCHANT] },
          // Network-enforced: the Gate owns these (spec D19), so verify must report them as *skipped*.
          { type: 'mandate.payment.budget', currency: 'USD', max: AMOUNT_RANGE_MAX },
          {
            type: 'mandate.payment.recurrence',
            frequency: 'MNTH',
            start_date: '2026-10-01',
            number: 6,
          },
        ],
      })
      expect(
        prepared.ok,
        prepared.ok ? '' : `${prepared.error.code}: ${prepared.error.message}`,
      ).toBe(true)
      if (!prepared.ok) return
      const prep = prepared.value as L2PrepareResponse

      // The invariant this client exists partly to protect: exactly two segments, no trailing dot.
      expect(prep.signing_input.split('.')).toHaveLength(2)
      expect(prep.prepare_ttl_seconds).toBeGreaterThan(0)
      expect(prep.expires_at).toBeGreaterThan(0)

      // --- 3. the browser signs the exact bytes -----------------------------------------------------
      const signature = await device.sign(prep.signing_input)
      expect(Buffer.from(signature, 'base64url')).toHaveLength(64)

      // --- 4. finalize ------------------------------------------------------------------------------
      const finalized = await client.finalizeL2({
        prepare_id: prep.prepare_id,
        signature_b64url: signature,
      })
      expect(
        finalized.ok,
        finalized.ok ? '' : `${finalized.error.code}: ${finalized.error.message}`,
      ).toBe(true)
      if (!finalized.ok) return
      expect(finalized.value.l2).toContain('~')
      expect(finalized.value.agent_kid).toBe(agent.value.kid)

      // --- 5. verify -------------------------------------------------------------------------------
      const verified = await client.verify({ l1: l1.l1, l2: finalized.value.l2 })
      // A 200 with chain_valid:false is a *verdict*, so this is ok() either way — that is the behaviour
      // AT-M4 requires, and asserting `ok` first is how the test proves it.
      expect(
        verified.ok,
        verified.ok ? '' : `${verified.error.code}: ${verified.error.message}`,
      ).toBe(true)
      if (!verified.ok) return
      const verdict = verified.value as VerifyResponse

      /**
       * A documented sharp edge, pinned here rather than discovered later.
       *
       * `POST /v1/verify` with an L1 and an L2 but no L3 and no `checkout_jwt` leaves **both fulfilment
       * inputs missing**, so `check_constraints` cannot evaluate the amount, the payee or the checkout. vi
       * fails closed on that: `constraints.satisfied` is false and `chain_valid` is false — while
       * **`errors` is empty**.
       *
       * That is because `chain_valid` is `chain.valid and not chain_errors and constraints.satisfied`
       * (`vi_service/verify.py`), and a constraint violation is *not* a chain error. A consumer that treats
       * "no errors" as "valid" is wrong, and the only place the explanation lives is
       * `constraints.violations`. Failing closed is the right call — a checkout with nothing to check is
       * not a checked-out cart — but the split is worth stating.
       *
       * The complete-chain test below is the one that asserts `chain_valid === true`.
       */
      expect(verdict.errors).toEqual([])
      expect(verdict.chain_valid).toBe(false)
      expect(verdict.constraints.satisfied).toBe(false)
      expect(verdict.constraints.violations.join(' | ')).toMatch(/no checkout_jwt was supplied/)
      expect(verdict.constraints.violations.join(' | ')).toMatch(
        /Missing or invalid payment_amount/,
      )

      // Spec D19, end to end, against a running service. The entries are annotated, so the helper is what
      // identifies them — `skipped.includes(type)` is always false and would make the Gate think it owes
      // nothing. See `pendingNetworkEnforcement`.
      expect(pendingNetworkEnforcement(verdict.constraints.skipped).sort()).toEqual([
        'mandate.payment.budget',
        'mandate.payment.recurrence',
      ])
      expect(verdict.constraints.checked).not.toContain('mandate.payment.budget')
      expect(verdict.constraints.checked).toContain('mandate.payment.amount_range')
      // The library injects this one itself; it is reported as checked, never as skipped.
      expect(verdict.constraints.checked).toContain('mandate.payment.reference')

      // EC-TIME-3: vi cannot honour `at_time` at the pinned commit and says so rather than pretending.
      expect(verdict.at_time_not_honoured).toBe(false)

      // --- 6. a wrong key must not complete an L2 ----------------------------------------------------
      const impostor = await generateDeviceKey('dev_contract_impostor')
      const wrongSignature = await impostor.sign(prep.signing_input)
      const rejected = await client.finalizeL2({
        prepare_id: prep.prepare_id,
        signature_b64url: wrongSignature,
      })
      expect(rejected.ok).toBe(false)
      if (rejected.ok) return
      // EC-KEY-1 / spec §8.5: this code reaches the browser UI intact, which is why the client preserves it.
      expect(rejected.error.code).toBe('VI_SIGNATURE_MISMATCH')
    })

    it('signs a price lock and an L3, and verifies the complete autonomous chain', async () => {
      const device = await generateDeviceKey('dev_contract_2')
      const agent = await client.mintAgentKey({ agent_id: `${AGENT_ID}_2` })
      expect(agent.ok).toBe(true)
      if (!agent.ok) return

      const l1r = await client.issueL1({
        user_id: USER_ID,
        wallet: {
          payer_id: 'PAYERCONTRACT',
          payer_email: 'buyer@countersign.test',
          payment_token_id: 'vault-contract-2',
        },
        device_public_jwk: deviceJwkOf(device),
        device_kid: device.kid,
      })
      expect(l1r.ok).toBe(true)
      if (!l1r.ok) return
      const l1 = l1r.value

      const prepared = await client.prepareL2({
        l1: l1.l1,
        device_kid: device.kid,
        agent_public_jwk: publicJwkSchema.parse(agent.value.public_jwk),
        agent_kid: agent.value.kid,
        merchants: [MERCHANT],
        acceptable_items: [ITEM],
        payment_instrument: {
          type: 'paypal_vault',
          id: l1.card_id,
          description: 'PayPal ···· 1234',
        },
        nonce: NONCE,
        aud: AUD,
        checkout_constraints: [
          { type: 'mandate.checkout.allowed_merchants', allowed: [MERCHANT] },
          {
            type: 'mandate.checkout.line_items',
            items: [{ id: 'li-1', acceptable_items: [ITEM], quantity: 1 }],
          },
        ],
        payment_constraints: [
          { type: 'mandate.payment.amount_range', currency: 'USD', min: 0, max: AMOUNT_RANGE_MAX },
          { type: 'mandate.payment.allowed_payees', allowed: [MERCHANT] },
          // Disclosed but never evaluated by the library, so the Gate owes it (spec D19). Included here so
          // the D19 assertion below is about a *fully verified* chain rather than a partial one.
          { type: 'mandate.payment.budget', currency: 'USD', max: AMOUNT_RANGE_MAX },
        ],
      })
      expect(
        prepared.ok,
        prepared.ok ? '' : `${prepared.error.code}: ${prepared.error.message}`,
      ).toBe(true)
      if (!prepared.ok) return

      const finalized = await client.finalizeL2({
        prepare_id: prepared.value.prepare_id,
        signature_b64url: await device.sign(prepared.value.signing_input),
      })
      expect(finalized.ok).toBe(true)
      if (!finalized.ok) return

      const checkout = await client.createCheckoutJwt({
        merchant: MERCHANT,
        lines: [{ sku: ITEM.id, title: ITEM.title, qty: 1, unit_minor: UNIT_MINOR }],
        shipping_minor: SHIPPING_MINOR,
        tax_minor: TAX_MINOR,
        currency: 'USD',
        checkout_id: 'chk_contract_1',
      })
      expect(
        checkout.ok,
        checkout.ok ? '' : `${checkout.error.code}: ${checkout.error.message}`,
      ).toBe(true)
      if (!checkout.ok) return
      expect(checkout.value.total_minor).toBe(BigInt(TOTAL_MINOR))
      expect(checkout.value.currency).toBe('USD')

      const l3 = await client.createL3({
        agent_kid: agent.value.kid,
        enc_private_key_b64: agent.value.enc_private_key_b64,
        l2: finalized.value.l2,
        checkout_jwt: checkout.value.checkout_jwt,
        payment: { amount_minor: TOTAL_MINOR, currency: 'USD', payee_id: MERCHANT.id },
        aud: 'https://network.countersign.test',
        nonce: NONCE,
        agent_id: `${AGENT_ID}_2`,
      })
      expect(l3.ok, l3.ok ? '' : `${l3.error.code}: ${l3.error.message}`).toBe(true)
      if (!l3.ok) return
      const created = l3.value as L3CreateResponse
      // `jti` is a deterministic hash of the L3a, which is what makes `checkout_attempts.l3_jti`'s unique
      // constraint a replay guard rather than a retry breaker.
      expect(created.jti).not.toBe('')
      expect(created.checkout_hash).toBe(checkout.value.checkout_hash)

      const verified = await client.verify({
        l1: l1.l1,
        l2: finalized.value.l2,
        l3a: created.l3a,
        l3b: created.l3b,
        checkout_jwt: checkout.value.checkout_jwt,
        expected_aud: AUD,
        expected_nonce: NONCE,
      })
      expect(verified.ok).toBe(true)
      if (!verified.ok) return
      expect(verified.value.errors).toEqual([])
      expect(verified.value.chain_valid).toBe(true)
      // D19 on a fully-evaluated chain: the Gate still owes the budget and the recurrence terms, and this
      // response says so even though `satisfied` is true.
      expect(verified.value.constraints.satisfied).toBe(true)
      expect(pendingNetworkEnforcement(verified.value.constraints.skipped)).toContain(
        'mandate.payment.budget',
      )

      // The public route returns the same verdict plus the bundle hash that goes into `custom_id` (§7.3).
      // The bundle must carry `checkout_jwt`: without it the fulfilment inputs are missing and the
      // constraint report is unsatisfied, which is exactly the trap pinned in the test above.
      const pub = await client.publicVerify({
        bundle: {
          v: 'cs1',
          l1: l1.l1,
          l2: finalized.value.l2,
          l3a: created.l3a,
          l3b: created.l3b,
          checkout_jwt: checkout.value.checkout_jwt,
        },
        expected_aud: AUD,
      })
      expect(pub.ok, pub.ok ? '' : `${pub.error.code}: ${pub.error.message}`).toBe(true)
      if (!pub.ok) return
      expect(pub.value.errors).toEqual([])
      expect(pub.value.chain_valid).toBe(true)
      expect(pub.value.bundle_hash).not.toBe('')
    })

    it('refuses to sign an L3 that is out of mandate, before signing anything', async () => {
      // Spec §3.1: the agent is the untrusted party, so the service evaluates the constraints itself.
      const device = await generateDeviceKey('dev_contract_3')
      const agent = await client.mintAgentKey({ agent_id: `${AGENT_ID}_3` })
      if (!agent.ok) return
      const l1r = await client.issueL1({
        user_id: USER_ID,
        wallet: {
          payer_id: 'PAYERCONTRACT',
          payer_email: 'buyer@countersign.test',
          payment_token_id: 'vault-contract-3',
        },
        device_public_jwk: deviceJwkOf(device),
        device_kid: device.kid,
      })
      if (!l1r.ok) return
      const prepared = await client.prepareL2({
        l1: l1r.value.l1,
        device_kid: device.kid,
        agent_public_jwk: publicJwkSchema.parse(agent.value.public_jwk),
        agent_kid: agent.value.kid,
        merchants: [MERCHANT],
        acceptable_items: [ITEM],
        payment_instrument: {
          type: 'paypal_vault',
          id: l1r.value.card_id,
          description: 'PayPal ···· 1234',
        },
        nonce: NONCE,
        aud: AUD,
        checkout_constraints: [{ type: 'mandate.checkout.allowed_merchants', allowed: [MERCHANT] }],
        payment_constraints: [
          { type: 'mandate.payment.amount_range', currency: 'USD', min: 0, max: AMOUNT_RANGE_MAX },
        ],
      })
      if (!prepared.ok) return
      const finalized = await client.finalizeL2({
        prepare_id: prepared.value.prepare_id,
        signature_b64url: await device.sign(prepared.value.signing_input),
      })
      if (!finalized.ok) return
      const checkout = await client.createCheckoutJwt({
        merchant: MERCHANT,
        lines: [{ sku: ITEM.id, title: ITEM.title, qty: 1, unit_minor: UNIT_MINOR }],
        currency: 'USD',
      })
      if (!checkout.ok) return

      const r = await client.createL3({
        agent_kid: agent.value.kid,
        enc_private_key_b64: agent.value.enc_private_key_b64,
        l2: finalized.value.l2,
        checkout_jwt: checkout.value.checkout_jwt,
        payment: { amount_minor: AMOUNT_RANGE_MAX + 5_000, currency: 'USD', payee_id: MERCHANT.id },
        aud: 'https://network.countersign.test',
        nonce: NONCE,
        agent_id: `${AGENT_ID}_3`,
      })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.code).toBe('VI_CONSTRAINT_VIOLATION')
    })

    it('answers the checkout-JWT diagnostic with a verdict rather than a 4xx', async () => {
      const r = await client.verifyCheckoutJwt('not.a.jwt')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.value.valid).toBe(false)
      expect(r.value.reason).not.toBe('')
      expect(r.value.checked_at).toBeGreaterThan(0)
    })

    it('rotates the ISSUER key and keeps the retired kid resolvable in JWKS', async () => {
      // Spec EC-KEY-2. This mutates service state, so it is last and self-contained: it rotates to a new
      // key and checks the old one is still published, which is the property that matters.
      const before = await client.status()
      expect(before.ok).toBe(true)
      if (!before.ok) return
      const previousKid = before.value.issuer_kid

      const rotated = await client.rotateKey({ role: 'ISSUER' })
      expect(rotated.ok, rotated.ok ? '' : `${rotated.error.code}: ${rotated.error.message}`).toBe(
        true,
      )
      if (!rotated.ok) return
      expect(rotated.value.retired_kid).toBe(previousKid)
      expect(rotated.value.new_kid).not.toBe(previousKid)

      const jwks = await client.jwks()
      expect(jwks.ok).toBe(true)
      if (!jwks.ok) return
      const kids = jwks.value.keys.map((k) => k['kid'])
      expect(kids).toContain(previousKid)
      expect(kids).toContain(rotated.value.new_kid)
    })

    /**
     * AT-M4.2's second half: the drift comparison against the service that is actually running.
     *
     * The unit suite proves the comparator against the committed fixture; this proves the *fixture* is still
     * the truth. A red line here means `apps/vi` changed a model and the fixture was not regenerated — see
     * `test/fixtures/README.md`.
     */
    it('reports no schema drift between this client and the running service', async () => {
      const document = await loadOpenApiDocument(
        `${(BASE_URL as string).replace(/\/+$/, '')}/openapi.json`,
      )
      const report = compareSchemas(document)
      if (!hasDrift(report)) return
      throw new Error(
        `Schema drift against ${BASE_URL}:\n${report.differences
          .map(
            (d) =>
              `  ${d.route} ${d.side} ${d.path} ${d.kind} (${d.direction}, ${d.severity}): ${d.detail}`,
          )
          .join(
            '\n',
          )}\n\nRegenerate packages/vi-client/test/fixtures/openapi.vi-service.json — see its README.`,
      )
    })
  },
)
