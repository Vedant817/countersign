/**
 * A real Verifiable Intent chain, captured offline from the pinned library, plus the §7.3 bundle built over
 * it.
 *
 * ## Where the tokens come from
 *
 * `chain.json` in this directory is the capture, and it is not hand-written. It was produced on
 * **2026-10-05** by driving `apps/vi`'s own routes (`/v1/keys/agent`, `/v1/l1/issue`, `/v1/l2/prepare`,
 * `/v1/l2/finalize`, `/v1/checkout-jwt`, `/v1/l3/create`) through `fastapi.testclient` with a fixed clock at
 * epoch `1800000000`. No sockets, no PayPal, no credentials. Every token in it was signed by the real library
 * at commit `356c29635f1c44df7de02edb58699ca9f29bece6`, and `vi_bundle_hash_reference` is the digest
 * `vi_service/verify.py::bundle_hash` itself produced — which is why `test/bundle.test.ts` can compare this
 * package's TypeScript canonicaliser against a Python one.
 *
 * **Why the JSON is a file rather than inlined constants.** An earlier draft inlined the tokens, and the
 * result was a fixture with elided token bodies (`"…ACHK6KF92"`) that decoded to nothing — and a test suite
 * that still passed, because the tests only asserted on shapes the truncated strings happened to satisfy. A
 * capture that cannot be corrupted by transcription is worth one extra file. `test/bundle.test.ts` now pins
 * the digests against `vi_bundle_hash_reference`, which is exactly the assertion that would have caught it.
 *
 * ### What the capture is not
 *
 * Not a PayPal interaction and not a live dispute. The `paypal`, `shipments`, `buyer`, `readback` and
 * `preferences` members are shaped the way `packages/defender` shapes them and their values are made up. Every
 * check in this package is a check on the *document*, so none of that needs to be real — and §8.0 rule 5's
 * concern (never fake upstream behaviour) is about the **chain**, which is genuine throughout.
 *
 * ### Why the Gate key is generated rather than captured
 *
 * `gate_decision` is signed with an Ed25519 key in-process via `crypto.subtle.generateKey`, so
 * `signDecisionRecord` produces a genuine JWS that `verifyDecisionRecord` checks with `jose`. Nothing about the
 * signature is faked; only the key is ephemeral, which is fine because the fixtures assert round-trip behaviour
 * rather than a frozen signature string.
 */

import { webcrypto, type webcrypto as WebCrypto } from 'node:crypto'

import { currency, fixedClock, toPayPalValue, type Clock } from '@countersign/core'
import { canonicalJson } from '@countersign/db'
import { signDecisionRecord } from '@countersign/gate'

import { bundleHashHex, customIdForBundle, sha256Hex } from '../../src/bundle'
import type { VerifierStore } from '../../src/types'

import CAPTURED from './chain.json'

/** `node:crypto`'s `CryptoKey`, which is the one this Node build actually has. */
type WebCryptoKey = WebCrypto.CryptoKey

/** The instant the capture was minted at. The library's own `iat`, and the basis of every digest. */
export const CAPTURED_AT_SEC = CAPTURED.issued_at

/** The captured tokens and public keys, as this package's tests read them. */
export const CAPTURED_CHAIN = {
  capturedAtUtc: CAPTURED.captured_at_utc,
  capturedWith: CAPTURED.captured_with,
  viLibCommit: CAPTURED.vi_lib_commit,
  issuerKid: CAPTURED.issuer_kid,
  issuerPublicJwk: CAPTURED.issuer_public_jwk as Record<string, unknown>,
  merchantKid: CAPTURED.merchant_kid,
  merchantPublicJwk: CAPTURED.merchant_public_jwk as Record<string, unknown>,
  deviceKid: CAPTURED.device_kid,
  deviceJkt: CAPTURED.device_jkt,
  agentKid: CAPTURED.agent_kid,
  userId: CAPTURED.user_id,
  payerId: CAPTURED.payer_id,
  payerEmail: CAPTURED.payer_email,
  cardId: CAPTURED.card_id,
  l1: CAPTURED.l1,
  l2: CAPTURED.l2,
  l3a: CAPTURED.l3a,
  l3b: CAPTURED.l3b,
  checkoutJwt: CAPTURED.checkout_jwt,
  checkoutHash: CAPTURED.checkout_hash,
  totalMinor: CAPTURED.total_minor,
  currency: CAPTURED.currency,
  /** The digest `vi_service/verify.py` computed for this chain. An independent implementation, for comparison. */
  viBundleHashReference: CAPTURED.vi_bundle_hash_reference,
} as const

/** The merchant and item, exactly as `l2/prepare` and `checkout-jwt` received them. */
export const FIXTURE_MERCHANT = CAPTURED.merchant as { id: string; name: string; website: string }
export const FIXTURE_ITEM = CAPTURED.item as { id: string; title: string }

/**
 * §8.8's deterministic read-back — the text the user *signed*.
 *
 * Quoted rather than paraphrased, because a verifier that printed a paraphrase would be printing something no
 * signature covers. EC-MER-6 makes this a required packet field precisely so a merchant cannot omit the part
 * that hurts them.
 *
 * ### It is in `readback.ts`'s output form, deliberately
 *
 * `readBack()` emits `READBACK_HEADER` first, always, then one line per constraint in `READBACK_ORDER`. So this
 * fixture is header-first and uses the `**bold**` emphasis around each amount, which is what
 * `verify-view.ts::readStatedCaps` reads. It is not passed through the real renderer — `fixtures/` cannot
 * depend on `packages/compiler`, and re-deriving it here would be a second implementation of a template, the
 * exact antipattern `bundle.ts` exists to avoid. Instead `test/binding.test.ts` asserts the **sentinel**
 * (`READBACK_HEADER`) agrees with `packages/compiler`'s own constant, so the one string this fixture depends on
 * cannot drift. The remaining prose is fixture data, and every check that reads it reads it as data.
 *
 * The amounts match the capture: the L2's `budget` and `amount_range` both cap at 20 000 minor units of USD,
 * which is the $200.00 the older paraphrase quoted, and `total_minor` is 13 300 — so the read-back's cap and
 * the cart's total are different numbers, which is correct and is what `readback_cap_vs_mandate` expects.
 */
export const FIXTURE_READBACK = [
  '**What you are authorising**',
  'Spend at most **$200.00** in total',
  'Spend at most **$200.00** per payment',
  'Only at **Northwind Outfitters**',
  'Pay only **Northwind Outfitters**',
  'Buy at least **1** of **Trail Runner**',
  'This mandate expires **Fri 15 Jan 2027, 11:59 PM**',
  '',
  '**How we read your request**',
  '- We read size "10" and colour "grey" as a preference, not a limit. These are not signed and do not bound ' +
    'what the agent may buy.',
  '',
  '**Not covered**',
  '- Expiry: there is no automatic renewal. When this mandate expires the agent cannot spend under it again, ' +
    'even if it meant to.',
].join('\n')

export const FIXTURE_PREFERENCES: Readonly<Record<string, string>> = { size: '10', color: 'grey' }

/** `sha256` over the read-back, hex — what EC-MER-6 requires the packet to carry. */
export const FIXTURE_READBACK_SHA256 = sha256Hex(FIXTURE_READBACK)

/**
 * `sha256` over the canonical form of the preferences block, hex.
 *
 * `canonicalJson` from `@countersign/db` rather than a hand-rolled `JSON.stringify` with sorted keys, for the
 * same reason `bundle.ts` uses it: the digest has to be the one the rest of the system computes. A test that
 * computed it differently would be testing its own serialiser, and would then "prove" that a correctly hashed
 * packet fails.
 */
export const FIXTURE_PREFERENCES_SHA256 = sha256Hex(canonicalJson(FIXTURE_PREFERENCES))

/** A clock frozen at the capture instant, so every digest and every `iat` comparison is deterministic. */
export function fixtureClock(atSec: number = CAPTURED_AT_SEC): Clock {
  return fixedClock(atSec)
}

// ---------------------------------------------------------------------------
// The Gate key
// ---------------------------------------------------------------------------

/**
 * A real Ed25519 key pair. See the file header for why it is generated per call.
 *
 * The key type is named structurally from `node:crypto`'s own `webcrypto.CryptoKey` rather than the bare
 * `CryptoKey`: `tsconfig.json` here declares `types: ['node']` — matching every other package in this repo —
 * and the unqualified `CryptoKey` is a **DOM** type that a Node build does not have in scope. Referencing
 * `webcrypto.CryptoKey` is the same type from the module that actually provides it.
 */
export async function makeGateKey(): Promise<{
  readonly kid: string
  readonly privateKey: WebCryptoKey
  readonly publicJwk: Record<string, unknown>
}> {
  const pair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as { privateKey: WebCryptoKey; publicKey: WebCryptoKey }
  const jwk = (await webcrypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>
  return { kid: 'gate-key-fixture-1', privateKey: pair.privateKey, publicJwk: jwk }
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/** What {@link makeChainBundle} returns. */
export interface ChainBundleFixture {
  readonly bundle: Record<string, unknown>
  /** `evidence_packets.bundle_hash`, hex — computed over `bundle`, so it agrees by construction. */
  readonly bundleHash: string
  /** D18's `custom_id`, over the nine hashed members. */
  readonly customId: string
  readonly gateJwk: Record<string, unknown>
  readonly gateKid: string
  readonly packetId: string
  readonly disputeId: string
  /** `disputes.amount_minor`, as `bigint`. Integer minor units end to end (§0). */
  readonly amountMinor: bigint
  readonly amountCurrency: string
}

/**
 * A complete, untampered §7.3 bundle with the EC-MER-6 members and a freshly signed Gate decision record.
 *
 * The digests are computed **after** the gate record is signed, which is the real order of operations:
 * `packages/orders` signs the record, then derives `custom_id` from a bundle that contains it. Getting that
 * order wrong produces a bundle whose `custom_id` cannot be reproduced, and a test would then be asserting a
 * fiction.
 *
 * ### Why `paypal`, `shipments` and `buyer` are present
 *
 * - `paypal` is §7.3's and carries the `custom_id` D18 needs to bind the packet to a PayPal transaction.
 * - `shipments` is §7.3's fulfilment record and is **deliberately outside the `custom_id` preimage** — the
 *   bundle's own `core_excludes` check asserts it, because a hash that moved every time a parcel shipped could
 *   not be the value in an order created before shipping.
 * - `buyer` is §8.18/EC-PRIV-3's block: the three fields the public view may show, plus the street address and
 *   the unmasked `payer_id` it must not.
 */
export async function makeChainBundle(
  overrides: Partial<ChainBundleFixture> = {},
): Promise<ChainBundleFixture> {
  const gate = await makeGateKey()
  const signed = await signDecisionRecord({
    key: gate.privateKey,
    kid: gate.kid,
    payload: {
      gdc: 'gdc_fixture_000000000000000001',
      att: 'att_fixture_00000000000000001',
      mdt: 'mdt_fixture_00000000000000001',
      // **`toPayPalValue`, not `String(total_minor)`.** `packages/gate/src/evaluate.ts` writes
      // `amount: amount ? toPayPalValue(amount) : '0.00'`, so the signed payload carries a PayPal *decimal
      // string* (`"133.00"`, and `"500"` for JPY). This fixture previously wrote the raw minor units
      // (`"13300"`), which no Gate has ever produced — and it went unnoticed precisely because nothing
      // compared the record's amount against the price lock. `verify-view.ts::gate_record_amount` now does,
      // and read the fixture's invented format as a $13,300 decision on a $133.00 cart. The check was right and
      // the fixture was wrong, which is the direction a fixture bug should be caught in.
      amount: toPayPalValue({
        minor: BigInt(CAPTURED.total_minor),
        currency: currency(CAPTURED.currency),
      }),
      // The ISO code, and never a float anywhere: §0 rule 9 / EC-FX-6.
      currency: currency(CAPTURED.currency),
      payee: FIXTURE_MERCHANT.id,
      checks_hash: 'a'.repeat(64),
      chain_valid: true,
      vi_commit: CAPTURED.vi_lib_commit,
      iat: CAPTURED_AT_SEC,
    },
  })
  if (!signed.ok) throw new Error(`fixture could not sign the Gate record: ${signed.error.message}`)

  const bundle: Record<string, unknown> = {
    v: 'cs1',
    l1: CAPTURED_CHAIN.l1,
    l2: CAPTURED_CHAIN.l2,
    l3a: CAPTURED_CHAIN.l3a,
    l3b: CAPTURED_CHAIN.l3b,
    checkout_jwt: CAPTURED_CHAIN.checkoutJwt,
    gate_decision: signed.value,
    webauthn: { present: true, at: CAPTURED_AT_SEC },
    vi_lib_commit: CAPTURED_CHAIN.viLibCommit,
    paypal: {
      order_id: 'FIXTUREORDER001',
      capture_ids: ['FIXTURECAPTURE001'],
      custom_id: '',
    },
    shipments: [
      {
        carrier: 'UPS',
        tracking: '1Z999AA10123456784',
        lines: [{ sku: FIXTURE_ITEM.id, qty: 1 }],
      },
    ],
    readback: FIXTURE_READBACK,
    readback_sha256: FIXTURE_READBACK_SHA256,
    preferences: { ...FIXTURE_PREFERENCES },
    preferences_sha256: FIXTURE_PREFERENCES_SHA256,
    buyer: {
      payer_id: CAPTURED_CHAIN.payerId,
      payer_email: CAPTURED_CHAIN.payerEmail,
      address: {
        line1: '221B Baker Street',
        city: 'Bengaluru',
        region: 'KA',
        postal_code: '560001',
        country: 'IN',
      },
    },
    dispute_id: 'dsp_fixture_000000000000001',
    version: 3,
    filed_at: CAPTURED_AT_SEC + 86_400,
  }

  // D18's `custom_id` is over the nine core members, which do not include `paypal` — so the blank
  // placeholder above cannot affect it, and filling it in afterwards is safe. `packages/orders` has the same
  // two-step property, and a test asserts it (see test/bundle.test.ts).
  const paypal = bundle['paypal'] as Record<string, unknown>
  paypal['custom_id'] = customIdForBundle(bundle) ?? ''

  return {
    bundle,
    bundleHash: bundleHashHex(bundle),
    customId: paypal['custom_id'] as string,
    gateJwk: gate.publicJwk,
    gateKid: gate.kid,
    packetId: 'pkt_fixture_0000000000000001',
    disputeId: 'dsp_fixture_000000000000001',
    amountMinor: BigInt(CAPTURED.total_minor),
    // `currency` is `string` in the JSON import but a closed union in `core`. The capture wrote a real ISO
    // code, and `currency()` is the one function that can enforce that without an `as Currency` cast — which
    // would be exactly the sort of unchecked narrowing this package refuses elsewhere.
    amountCurrency: currency(CAPTURED.currency),
    ...overrides,
  }
}

/**
 * Deep-clone a bundle so a test can mutate it without touching the shared fixture.
 *
 * `structuredClone` rather than `JSON.parse(JSON.stringify(...))` because the latter would silently drop a
 * `bigint`, and a test that thought it was tampering with a number would instead be tampering with `null`.
 */
export function cloneBundle<T>(value: T): T {
  return structuredClone(value)
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** The packet row `VerifierStore` needs. Deliberately minimal — the adapter is the test's job. */
export interface PacketRowFixture {
  readonly id: string
  readonly dispute_id: string
  readonly version: number
  readonly bundle: unknown
  readonly bundle_hash: string
  readonly filed_at: Date | null
  readonly created_at: Date
}

export interface StoreFixtureOptions {
  readonly packet: PacketRowFixture
  readonly jwks?: readonly {
    readonly kid: string
    readonly role: string
    readonly public_jwk: unknown
    readonly status: string
  }[]
  /** Omit the dispute row, to exercise the "label unavailable" path. */
  readonly withDispute?: boolean
}

/**
 * {@link VerifierStore} over plain objects — no database, no network, no fixtures directory.
 *
 * `findById` returns `ok(undefined)` for an unknown id rather than `err`, because "no such packet" is a
 * **value** on this page (the 404) and not a failure. Getting that backwards is how a page ends up rendering a
 * 500 for a typo in a QR code.
 */
export function makeInMemoryStore(options: StoreFixtureOptions): VerifierStore {
  const jwks = options.jwks ?? []
  const withDispute = options.withDispute !== false
  const at = (n: number): Date => new Date(n * 1000)
  return {
    packets: {
      async findById(id) {
        return { ok: true, value: id === options.packet.id ? (options.packet as never) : undefined }
      },
    },
    disputes: {
      async findById(id) {
        if (!withDispute || id !== options.packet.dispute_id) return { ok: true, value: undefined }
        return {
          ok: true,
          value: {
            id,
            amount_minor: 13_300n,
            currency: 'USD',
            stage: 'CHARGEBACK',
            status: 'UNDER_REVIEW',
            // **Present, and this is load-bearing.** `verify-view.ts::paypalDispute_binding` compares these two
            // against `bundle.paypal`, because they are the only anchor on the page that a holder of a packet
            // URL cannot recompute — they live on a different row. A fixture whose dispute row carried neither
            // would leave that check permanently `SKIPPED`, which is the one state in which it proves nothing,
            // and every test in this package would still pass.
            capture_id: 'FIXTURECAPTURE001',
            order_id: 'FIXTUREORDER001',
          } as never,
        }
      },
    },
    jwks: {
      async listAll() {
        return {
          ok: true,
          value: jwks.map((k) => ({
            ...k,
            public_jwk: k.public_jwk as never,
            not_before: at(CAPTURED_AT_SEC - 1000),
            not_after: null,
            created_at: at(CAPTURED_AT_SEC - 1000),
            updated_at: at(CAPTURED_AT_SEC - 1000),
          })) as never,
        }
      },
    },
  }
}

/** A `jwks_keys` set for the fixture: the captured issuer and merchant keys plus the fresh Gate key. */
export function makeJwksRows(fixture: ChainBundleFixture): {
  readonly kid: string
  readonly role: string
  readonly public_jwk: unknown
  readonly status: string
}[] {
  return [
    {
      kid: CAPTURED_CHAIN.issuerKid,
      role: 'ISSUER',
      public_jwk: CAPTURED_CHAIN.issuerPublicJwk,
      status: 'ACTIVE',
    },
    {
      kid: CAPTURED_CHAIN.merchantKid,
      role: 'MERCHANT',
      public_jwk: CAPTURED_CHAIN.merchantPublicJwk,
      status: 'ACTIVE',
    },
    { kid: fixture.gateKid, role: 'GATE', public_jwk: fixture.gateJwk, status: 'ACTIVE' },
  ]
}
