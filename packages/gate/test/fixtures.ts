/**
 * Shared fixtures for the Gate's tests — spec §8.10's AT-M10.1 through AT-M10.6.
 *
 * ## Why these are built here and not in each test
 *
 * Every one of the acceptance tests needs the *same* world: a mandate that is ACTIVE, an agent and a
 * device that are ACTIVE, a clean `/v1/verify` verdict, a price-locked cart, and a signed decision record.
 * If each test assembled its own, a change to the happy path would break six files at once and the
 * failing test would be whichever one happened to run first — which is the opposite of what a test suite
 * is for.
 *
 * ## What the helpers deliberately do *not* do
 *
 * - **No real signature where a fake is honest.** {@link makeGateSigner} produces a *real* Ed25519 JWS
 *   with a *real* JWKS, because AT-M10.5 is about verification and a fake signature would make that test
 *   pass without proving anything. But {@link fakeL3a} produces a structurally valid JWS with a bogus
 *   signature, and that is honest: the Gate reads the L3a **claims** only as cross-checks against
 *   server-side rows, and check 4 is what verifies signatures for real (against vi-service, in
 *   production). A comment at each call site says which is which.
 * - **No database.** `createInMemoryGateWorld` models `FOR UPDATE` deliberately — see its doc comment —
 *   so AT-M10.2's "exactly 3 ALLOW" tests the lock rather than the absence of one.
 */
import { SignJWT, compactVerify, exportJWK, generateKeyPair, importJWK, type CryptoKey } from 'jose'
import {
  money,
  type AttemptId,
  type CheckoutId,
  type Currency,
  type MandateId,
} from '@countersign/core'
import type { CheckoutSessionRow, JsonValue, ProductRow } from '@countersign/db'

import { decodeL3, gateJwks, recordSigner } from '../src/decision-record'
import {
  createInMemoryGateWorld,
  type InMemoryGateWorld,
  type InMemoryGateWorldSeed,
} from '../src/deps'
import type { GateDeps, GateInput, GateRecordPayload, MerchantKeySet } from '../src/types'

/** A fixed instant, so nothing in these tests depends on the wall clock. */
/**
 * A fixed instant: **2025-10-09T08:53:20Z**.
 *
 * Chosen so that `2025-01-01` and `2025-12-31` bracket it comfortably for the recurrence tests — a
 * fixture clock that sits in a leap year, near a month boundary, or near midnight would make a date-window
 * test fail for reasons that have nothing to do with the Gate. Nothing here depends on the wall clock.
 */
export const NOW_SEC = 1_760_000_000

/** `YYYY-MM-DD` bracketing {@link NOW_SEC}, for signed recurrence windows. */
export const DATE_BEFORE = '2025-01-01'
export const DATE_AFTER = '2025-12-31'

export const MANDATE_ID = 'mdt_0000000000000000000000000A' as MandateId
export const AGENT_ID = 'agt_0000000000000000000000000A' as `agt_${string}`
export const DEVICE_ID = 'dev_0000000000000000000000000A' as `dev_${string}`
export const CHECKOUT_ID = 'chk_0000000000000000000000000A' as CheckoutId
export const WALLET_ID = 'wal_0000000000000000000000000A' as `wal_${string}`
export const MERCHANT_ID = 'MERCHANT_NORTHWIND'
export const AGENT_KID = 'agent-key-1'
export const MERCHANT_KID = 'merchant-1'

/** $30.00 — the cart AT-M10.2 races twenty of against a $100.00 cap. */
export const CART_MINOR = 3_000n
/** $130.00 — the spec's worked example limit, and the default cap in the in-memory world. */
export const CAP_MINOR = 13_000n

/* ------------------------------------------------------------------------------------------ */
/* JWS builders                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** base64url of a JSON value — the middle segment of a compact JWS. */
function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/**
 * A structurally valid, **unsigned** L3a.
 *
 * Unsigned on purpose, and honest about it: the Gate never verifies this signature itself — check 4 asks
 * vi-service to, and vi-service is the only party that holds the issuer's private key. What the Gate reads
 * from the L3a is its *claims*, and only to cross-check them against its own rows. Every test that mutates
 * a claim is testing that cross-check, which is exactly what should fail closed.
 *
 * The fuzz suite needs a **signed** variant, because a JWS header is not a claim: flipping a bit in it
 * changes nothing the Gate cross-checks, so an unsigned fixture would report an ALLOW that says nothing
 * about the Gate. {@link makeWorld} signs for real and verifies for real — see `verifySignatures`.
 */
export function fakeL3a(overrides: Record<string, unknown> = {}, kid: string = AGENT_KID): string {
  const header = b64({ alg: 'EdDSA', kid, typ: 'JWT' })
  const payload = b64({
    jti: 'jti-1',
    amount_minor: Number(CART_MINOR),
    currency: 'USD',
    payee_id: MERCHANT_ID,
    aud: 'https://merchant.example',
    iss: 'https://issuer.example',
    iat: NOW_SEC - 5,
    exp: NOW_SEC + 295,
    ...overrides,
  })
  return `${header}.${payload}.${Buffer.from('not-a-real-signature', 'utf8').toString('base64url')}`
}

/** An unsigned L3b binding a `checkout_hash`. Same honesty as {@link fakeL3a}. */
export function fakeL3b(
  checkoutHash: string,
  overrides: Record<string, unknown> = {},
  kid: string = AGENT_KID,
): string {
  const header = b64({ alg: 'EdDSA', kid, typ: 'JWT' })
  const payload = b64({
    checkout_hash: checkoutHash,
    aud: 'https://merchant.example',
    iss: 'https://agent.example',
    iat: NOW_SEC - 5,
    exp: NOW_SEC + 295,
    ...overrides,
  })
  return `${header}.${payload}.${Buffer.from('not-a-real-signature', 'utf8').toString('base64url')}`
}

/** A **real** L3a, signed by the agent key. What the fuzz mutates. */
export async function signL3a(
  key: CryptoKey,
  overrides: Record<string, unknown> = {},
  kid: string = AGENT_KID,
): Promise<string> {
  return new SignJWT({
    jti: 'jti-1',
    amount_minor: Number(CART_MINOR),
    currency: 'USD',
    payee_id: MERCHANT_ID,
    aud: 'https://merchant.example',
    iss: 'https://agent.example',
    iat: NOW_SEC - 5,
    exp: NOW_SEC + 295,
    ...overrides,
  } as never)
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
    .sign(key)
}

/** A **real** L3b, signed by the agent key. */
export async function signL3b(
  key: CryptoKey,
  checkoutHash: string,
  overrides: Record<string, unknown> = {},
  kid: string = AGENT_KID,
): Promise<string> {
  return new SignJWT({
    checkout_hash: checkoutHash,
    aud: 'https://merchant.example',
    iss: 'https://agent.example',
    iat: NOW_SEC - 5,
    exp: NOW_SEC + 295,
    ...overrides,
  } as never)
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
    .sign(key)
}

/** A signed checkout JWT by a real merchant key. Check 5 verifies its signature locally. */
export async function signedCheckoutJwt(
  key: CryptoKey,
  kid: string,
  claims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({
    sub: MERCHANT_ID,
    total_minor: Number(CART_MINOR),
    currency: 'USD',
    checkout_id: CHECKOUT_ID,
    iat: NOW_SEC - 5,
    exp: NOW_SEC + 895,
    ...claims,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
    .sign(key)
}

/* ------------------------------------------------------------------------------------------ */
/* Keys                                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface TestKeys {
  /** The Gate's own signing key. Ed25519, so `jose` needs no curve parameters. */
  readonly gate: {
    key: CryptoKey
    kid: string
    jwks: ReturnType<typeof gateJwks>
    privateJwk: Record<string, unknown>
  }
  /**
   * The **agent** key — the one that signs L3a and L3b.
   *
   * Present because AT-M10.6's fuzz needs real signature verification. A JWS header carries `alg`, `kid`
   * and `typ`, and flipping a bit in it changes no *claim* the Gate reads, so against an always-valid
   * `/v1/verify` double a header flip would ALLOW — a "critical finding" that is an artefact of the test
   * rather than of the Gate. Signing for real and verifying for real is what makes "0 ALLOWs" mean what it
   * says.
   */
  readonly agent: { key: CryptoKey; kid: string; publicJwk: Record<string, unknown> }
  /** The merchant's price-lock key, and the one check 5 verifies against. */
  readonly merchant: { key: CryptoKey; kid: string; publicJwk: Record<string, unknown> }
  /** A *second* merchant key, for "signed by an unknown kid". */
  readonly rogue: { key: CryptoKey; kid: string; publicJwk: Record<string, unknown> }
  readonly merchantKeySet: (extra?: {
    acceptedKids?: readonly string[]
    currentKid?: string
  }) => MerchantKeySet
  /** Verifies a JWS against the agent key. The `verifySignatures` implementation for a world. */
  readonly verifyAgentSignature: (tokens: {
    l3a: string
    l3b: string
  }) => Promise<{ valid: boolean; errors: string[] }>
}

/**
 * Real Ed25519 keys, generated once per test file.
 *
 * `jose`'s `generateKeyPair` returns a fresh pair each call, which would make every test pay for key
 * generation; a module-level promise is enough because nothing here mutates a key.
 */
let cached: Promise<TestKeys> | null = null

export function testKeys(): Promise<TestKeys> {
  cached ??= buildKeys()
  return cached
}

async function buildKeys(): Promise<TestKeys> {
  const gatePair = await generateKeyPair('Ed25519', { extractable: true })
  const agentPair = await generateKeyPair('Ed25519', { extractable: true })
  const merchantPair = await generateKeyPair('Ed25519', { extractable: true })
  const roguePair = await generateKeyPair('Ed25519', { extractable: true })

  const gatePublic = (await exportJWK(gatePair.publicKey)) as Record<string, unknown>
  const gatePrivate = (await exportJWK(gatePair.privateKey)) as Record<string, unknown>
  const agentPublic = {
    ...((await exportJWK(agentPair.publicKey)) as Record<string, unknown>),
    alg: 'EdDSA',
  }
  const merchantPublic = {
    ...((await exportJWK(merchantPair.publicKey)) as Record<string, unknown>),
    alg: 'EdDSA',
  }
  const roguePublic = {
    ...((await exportJWK(roguePair.publicKey)) as Record<string, unknown>),
    alg: 'EdDSA',
  }

  const gateKid = 'gate-key-1'
  const merchantKid = MERCHANT_KID
  const rogueKid = 'merchant-rogue'

  return {
    gate: {
      key: gatePair.privateKey,
      kid: gateKid,
      jwks: gateJwks(gateKid, { ...gatePublic, alg: 'EdDSA' }),
      // What §6 puts in `GATE_SIGNING_KEY`: a JWK string.
      privateJwk: { ...gatePrivate, kid: gateKid, alg: 'EdDSA' },
    },
    agent: { key: agentPair.privateKey, kid: AGENT_KID, publicJwk: agentPublic },
    merchant: {
      key: merchantPair.privateKey,
      kid: merchantKid,
      publicJwk: { ...merchantPublic, kid: merchantKid },
    },
    rogue: {
      key: roguePair.privateKey,
      kid: rogueKid,
      publicJwk: { ...roguePublic, kid: rogueKid },
    },
    merchantKeySet: (extra = {}) => ({
      currentKid: extra.currentKid ?? merchantKid,
      acceptedKids: extra.acceptedKids ?? [merchantKid],
      jwks: {
        [merchantKid]: { ...merchantPublic, kid: merchantKid },
        [rogueKid]: { ...roguePublic, kid: rogueKid },
      },
    }),

    async verifyAgentSignature(tokens) {
      const errors: string[] = []
      const publicKey = (await importJWK(agentPublic as never, 'EdDSA')) as CryptoKey
      for (const [label, token] of Object.entries(tokens)) {
        if (token === '') continue
        try {
          await compactVerify(token, publicKey)
        } catch (cause) {
          errors.push(`${label}: ${(cause as Error).message}`)
        }
      }
      return { valid: errors.length === 0, errors }
    },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Products                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** A `products` row. `description` and `listing_html` are untrusted by §8.9 and §8.13. */
export function product(
  sku: string,
  priceMinor: bigint,
  overrides: Partial<ProductRow> = {},
): ProductRow {
  return {
    sku,
    title: `Item ${sku}`,
    description: `A perfectly ordinary description of ${sku}.`,
    price_minor: priceMinor,
    currency: 'USD',
    stock: 10,
    ships_in_days: 3,
    digital: false,
    listing_html: `<p>Ordinary listing for ${sku}.</p>`,
    created_at: new Date(NOW_SEC * 1000),
    updated_at: new Date(NOW_SEC * 1000),
    ...overrides,
  } as ProductRow
}

/** One $30.00 line, which is what the session is priced from by default. */
export const DEFAULT_PRODUCTS: readonly ProductRow[] = [product('NW-001', CART_MINOR)]

/* ------------------------------------------------------------------------------------------ */
/* The signed constraints, as vi discloses them                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * A `mandate.payment.budget` constraint exactly as it appears in the signed L2.
 *
 * `max` is a **JSON number** of integer minor units, because that is the shape `vi-client`'s
 * `budgetConstraintSchema` accepts (`z.number().int()`). The Gate converts it to `bigint` through
 * core's `bigintFromJson`; nothing here does the conversion, so a test cannot accidentally smuggle a
 * rounded double into a money assertion.
 */
export function budgetConstraint(
  maxMinor: bigint | number,
  currency: Currency = 'USD',
): Record<string, JsonValue> {
  const max = typeof maxMinor === 'bigint' ? Number(maxMinor) : maxMinor
  if (!Number.isSafeInteger(max)) {
    throw new Error(`budgetConstraint: ${maxMinor} is outside the safe integer range`)
  }
  return { type: 'mandate.payment.budget', currency, max, min: null }
}

/** A `mandate.payment.recurrence` constraint as it appears in the signed L2. */
export function recurrenceConstraint(
  overrides: Record<string, JsonValue> = {},
): Record<string, JsonValue> {
  return {
    type: 'mandate.payment.recurrence',
    frequency: 'MNTH',
    start_date: DATE_BEFORE,
    end_date: DATE_AFTER,
    number: 1,
    ...overrides,
  }
}

/**
 * `VerifyResponse.disclosed.l2` with these constraints inside the payment mandate's disclosure.
 *
 * ## The shape is the whole point
 *
 * This mirrors `apps/vi`'s `verify.py`: `disclosed.l2` is the resolved L2 payload, the mandates live in
 * `delegate_payload`, and each carries the `constraints` array vi itself walks to decide which types
 * were "network-enforced". So a test that puts the buyer's ceiling here is putting it in **the token**,
 * not in a column — which is the distinction the whole D19 fix turns on. A test that puts it only in
 * `mandate.constraints` is putting it in our cache, and the Gate must then be the *only* thing stopping
 * the overspend.
 */
export function disclosedL2(constraints: readonly unknown[]): Record<string, unknown> {
  return {
    iss: 'https://issuer.example',
    iat: NOW_SEC - 3_600,
    exp: NOW_SEC + 86_400,
    delegate_payload: [
      { vct: 'mandate.checkout.open.1', constraints: [] },
      { vct: 'mandate.payment.open.1', constraints: [...constraints] },
    ],
  }
}

/**
 * A complete `VerifyResponse.disclosed` whose `l2` carries these constraints.
 *
 * A helper rather than `{l2: …}` inline, because `DisclosedReport` requires all four layers and a test
 * that omits three of them should not need a cast to say "the L2 is the interesting one".
 */
export function disclosed(constraints: readonly unknown[]): {
  l1: Record<string, unknown>
  l2: Record<string, unknown>
  l3a: Record<string, unknown>
  l3b: Record<string, unknown>
} {
  return { l1: {}, l2: disclosedL2(constraints), l3a: {}, l3b: {} }
}

/** One `constraints.skipped` entry: the object form `apps/vi` emits after D-019. */
function skipsBudget(): readonly { type: string; reason: string }[] {
  return [
    {
      type: 'mandate.payment.budget',
      reason:
        'Network-enforced constraint. Not evaluated by verifiable_intent; ' +
        "Countersign's Gate enforces it (spec D19). NOT satisfied by this response.",
    },
  ]
}

/**
 * The whole D19 budget seed: vi reports the obligation **and** the chain discloses the ceiling.
 *
 * The two travel together on purpose. A test cannot say "the buyer signed a budget nobody evaluated"
 * without also saying what the ceiling is, so a fixture cannot casually describe the state where the
 * obligation exists and the signed number does not — which is the state the Gate must refuse, and which
 * {@link viSkipsBudgetButDisclosesNoCeiling} builds on purpose when that is the thing under test.
 *
 * `maxMinor` is the ceiling **in the token**, and it is deliberately not defaulted: the point of the fix
 * is that the number the buyer signed is what the Gate enforces, and a defaulted fixture would let a
 * test pass without ever naming it.
 */
export function viSkipsBudget(maxMinor: bigint | number, currency: Currency = 'USD') {
  return {
    constraints: {
      satisfied: true,
      violations: [],
      checked: ['mandate.payment.amount_range'],
      skipped: skipsBudget(),
    },
    disclosed: disclosed([budgetConstraint(maxMinor, currency)]),
  }
}

/**
 * The obligation with **no** readable ceiling in the chain — the fail-closed state.
 *
 * `mandate.payment.budget` is in `skipped` and `disclosed.l2` carries the payment mandate with an empty
 * `constraints` array, so the obligation is real and the number is genuinely absent. §8.8 would not
 * normally produce this pair, which is exactly why it is worth a test: a vi-service that dropped the
 * disclosure, a chain whose `constraints` were redacted, or any future regression in this package's
 * reader all land here, and the answer has to be "nothing was charged".
 */
export function viSkipsBudgetButDisclosesNoCeiling() {
  return {
    constraints: {
      satisfied: true,
      violations: [],
      checked: ['mandate.payment.amount_range'],
      skipped: skipsBudget(),
    },
    disclosed: disclosed([]),
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The world                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface GateWorldOptions extends InMemoryGateWorldSeed {
  /** Sign the decision record with a real key, so AT-M10.5 can verify it. */
  readonly signWithRealKey?: boolean
  /** The cap, in minor units. Defaults to $130.00. */
  readonly capMinor?: bigint
  /** The cart total, in minor units. Defaults to $30.00. */
  readonly cartMinor?: bigint
  /** The store currency. Defaults to `USD`; `JPY` exercises `MINOR_DIGITS = 0` (EC-FX-3). */
  readonly currency?: Currency
  /** Replace the signed L3a. Used by the fuzz, which mutates it. */
  readonly l3a?: string
  /** Replace the signed L3b. Used by the fuzz, which mutates it. */
  readonly l3b?: string
  /**
   * How `/v1/verify` answers about **signatures**.
   *
   * Defaults to accepting, so a test about check 6 or 7 is not also a test about check 4. Pass
   * `signWithRealChain: true` for real Ed25519 verification — which the fuzz requires, and which any test
   * about check 4's *cryptographic* behaviour requires.
   */
  readonly verifySignatures?: (tokens: {
    l3a: string
    l3b: string
  }) => Promise<{ valid: boolean; errors: string[] }>
  /**
   * Verify the L3 signatures for real, against {@link TestKeys.agent}.
   *
   * Off by default; see {@link makeWorld} for why. On for AT-M10.6's fuzz, where an accepting double would
   * make a header-bit-flip ALLOW and the whole test meaningless.
   */
  readonly signWithRealChain?: boolean
}

/** The accepting `/v1/verify` signature answer. Used when a test is not about check 4. */
const ACCEPT_SIGNATURES = async (): Promise<{ valid: boolean; errors: string[] }> => ({
  valid: true,
  errors: [],
})

/**
 * A complete, happy-path Gate world.
 *
 * The happy path here is genuinely clean — every check can pass — so a test that wants a BLOCK changes
 * exactly one thing and can name it in its title. That is the discipline AT-M10.1 ("one test per check,
 * ALLOW and BLOCK") requires: a BLOCK test that fails for a reason other than the check under test is a
 * test that will be "fixed" by widening an assertion.
 */
export async function makeWorld(
  options: GateWorldOptions = {},
): Promise<InMemoryGateWorld & { keys: TestKeys }> {
  const keys = await testKeys()
  const cartMinor = options.cartMinor ?? CART_MINOR
  const currency = options.currency ?? 'USD'
  // `products` defaults to one line in the store's own currency; a caller supplying products is
  // responsible for their currency matching, because the session total is derived from them.
  const products = options.products ?? [product('NW-001', cartMinor, { currency })]
  const cap = money(options.capMinor ?? CAP_MINOR, currency)

  const checkoutJwt = await signedCheckoutJwt(keys.merchant.key, keys.merchant.kid, {
    total_minor: Number(cartMinor),
    currency,
  })

  // Signed L3a/L3b by default, and `verifySignatures` verifies them for real. Both are overridable, and the
  // *unsiged* pair is still available via `unsignedTokens` for the tests that specifically want a token
  // whose claims are cross-checked without a signature (the check-6 and check-7 tests do not need it).
  // The L3 pair the world hands out. Signed for real by default so a test can mutate something realistic
  // (the fuzz does), but whether `/v1/verify` *verifies* it is a separate switch — see `signWithRealChain`.
  const tokens = {
    l3a:
      options.l3a ?? (await signL3a(keys.agent.key, { amount_minor: Number(cartMinor), currency })),
    l3b: options.l3b ?? (await signL3b(keys.agent.key, 'hash-1')),
  }

  /**
   * Real signature verification, or the accepting stub?
   *
   * **Accepting by default**, because most tests are about a check *other than* check 4: a test asserting
   * "check 6 refuses a currency mismatch" should not also be asserting that check 4 passes, and wiring real
   * verification in by default would make every such test depend on its tokens being signed — so a
   * deliberately malformed token (to exercise check 6 or 7) would fail check 4 first and the test would be
   * measuring the wrong thing.
   *
   * **Real when it matters**, and that is what {@link GateWorldOptions.signWithRealChain} is for. The fuzz
   * needs it: a JWS *header* is not a claim, so a bit flip in one changes nothing any check cross-checks, and
   * against an accepting double a header flip would ALLOW. That would be a "critical finding" that is an
   * artefact of the harness rather than a property of the Gate, which in production defers signature
   * verification to vi-service's `verify_chain`.
   */
  const verifySignatures =
    options.verifySignatures ??
    (options.signWithRealChain ? keys.verifyAgentSignature : ACCEPT_SIGNATURES)

  // The caller's options go **first**, so the derived values below can complete them. Putting the spread
  // last would replace `mandate` with the caller's `Partial<MandateRow>` — dropping the id and turning
  // every check into `CS_NOT_FOUND`, which reads as a Gate bug and is a fixture bug.
  const world = createInMemoryGateWorld({
    ...stripHarnessOnly(options),
    nowSec: NOW_SEC,
    budget: options.budget ?? { cap },
    products,
    // The ids are stated rather than defaulted, so a world and a `GateInput` cannot drift apart.
    mandate: {
      id: MANDATE_ID,
      device_id: DEVICE_ID,
      agent_id: AGENT_ID,
      wallet_id: WALLET_ID,
      ...(options.mandate ?? {}),
    },
    agent: { id: AGENT_ID, ...(options.agent ?? {}) },
    device: { id: DEVICE_ID, ...(options.device ?? {}) },
    session: {
      id: CHECKOUT_ID,
      merchant_id: MERCHANT_ID,
      // `cart` is a JSONB column, so `unit_minor` is stored as a *decimal string*: a `bigint` does not
      // survive `JSON.stringify`, which is exactly the bug `drizzle-kit` would hit on a schema default
      // (see the note on `budget_accounts.reserved_minor` in `packages/db/src/schema.ts`). `cartLines`
      // reads the string back with `bigintFromJson`.
      cart: {
        lines: products.map((p) => ({ sku: p.sku, qty: 1, unit_minor: p.price_minor.toString() })),
      },
      subtotal_minor: cartMinor,
      tax_minor: 0n,
      shipping_minor: 0n,
      total_minor: cartMinor,
      currency,
      checkout_jwt: checkoutJwt,
      checkout_hash: 'hash-1',
      price_lock_exp: new Date((NOW_SEC + 900) * 1000),
      status: 'CREATED',
      ...(options.session ?? {}),
    },
    merchantKeys: options.merchantKeys ?? keys.merchantKeySet(),
    verifySignatures,
    ...(options.signWithRealKey ? { signRecord: recordSigner(keys.gate.key, keys.gate.kid) } : {}),
  })

  // Test-only vi stand-in for the old flat claim fixtures. Production never falls back to JWS
  // claims. Captured or explicitly supplied disclosures are passed through unchanged.
  const verify = world.deps.verify
  world.deps.verify = async (request) => {
    const result = await verify(request)
    if (!result.ok) return result
    const l3a = result.value.disclosed.l3a
    if (Object.keys(l3a ?? {}).length > 0) return result
    const decoded = decodeL3(request.l3a ?? '')
    const claims = decoded.ok ? decoded.claims : {}
    return {
      ok: true,
      value: {
        ...result.value,
        disclosed: {
          ...result.value.disclosed,
          l3a: {
            delegate_payload: [
              {
                vct: 'mandate.payment.1',
                payment_amount: { amount: claims.amount_minor, currency: claims.currency },
                payee: { id: claims.payee_id },
              },
            ],
          },
        },
      },
    }
  }
  return Object.assign(world, { keys, tokens })
}

/** Drops the harness-only options, which are not members of `InMemoryGateWorldSeed`. */
function stripHarnessOnly(options: GateWorldOptions): InMemoryGateWorldSeed {
  const {
    signWithRealKey: _signKey,
    signWithRealChain: _signChain,
    capMinor: _cap,
    cartMinor: _cart,
    currency: _cur,
    l3a: _l3a,
    l3b: _l3b,
    ...rest
  } = options
  return rest
}

/**
 * A `GateInput` for {@link makeWorld}'s default fixture ids.
 *
 * The L3 pair defaults to the **unsigned** claim-container form, because most tests here are about a check
 * *other* than check 4 and want the simplest token that carries the claims they are varying. A world built
 * with `signWithRealChain: true` — the fuzz — must pass its own signed tokens, which is what
 * `world.tokens` is for.
 */
export function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    attemptId: 'att_0000000000000000000000000A' as AttemptId,
    mandateId: MANDATE_ID,
    checkoutId: CHECKOUT_ID,
    l3a: fakeL3a(),
    l3b: fakeL3b('hash-1'),
    agentId: AGENT_ID,
    ...overrides,
  }
}

/** The deps of a world with one member replaced — the shape every BLOCK test uses. */
export function withDeps(world: InMemoryGateWorld, overrides: Partial<GateDeps>): GateDeps {
  return { ...world.deps, ...overrides }
}

/** The nine-field payload the signer received, for asserting on `checks_hash` and `amount`. */
export function recordedPayloads(signRecord: GateDeps['signRecord']): GateRecordPayload[] {
  const seen: GateRecordPayload[] = []
  const wrapped: GateDeps['signRecord'] = async (payload) => {
    seen.push(payload)
    return signRecord(payload)
  }
  Object.assign(wrapped, { seen })
  return seen
}

/** A `checkout_sessions` row for the M9 tests. */
export function session(overrides: Partial<CheckoutSessionRow> = {}): CheckoutSessionRow {
  return {
    id: CHECKOUT_ID,
    merchant_id: MERCHANT_ID,
    cart: { lines: [{ sku: 'NW-001', qty: 1, unit_minor: CART_MINOR }] },
    subtotal_minor: CART_MINOR,
    tax_minor: 0n,
    shipping_minor: 0n,
    total_minor: CART_MINOR,
    currency: 'USD',
    checkout_jwt: 'eyJhbGciOiJFZERTQSJ9.eyJzdW0iOjEwfQ.c2ln',
    checkout_hash: 'hash-1',
    price_lock_exp: new Date((NOW_SEC + 900) * 1000),
    status: 'CREATED',
    created_at: new Date(NOW_SEC * 1000),
    updated_at: new Date(NOW_SEC * 1000),
    ...overrides,
  } as CheckoutSessionRow
}
