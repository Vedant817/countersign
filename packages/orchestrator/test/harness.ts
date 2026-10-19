/**
 * The orchestrator's test harness — one recording `fetch`, one Gate world, one order world, and one
 * {@link OrchestratorStore} that bridges them.
 *
 * ## What is real and what is replaced, and why that is not a shortcut
 *
 * | Thing | Real? | Why |
 * |---|---|---|
 * | `packages/gate`'s `evaluate` — twelve checks, the reservation, the compensation, a real Ed25519 signature | **yes** | The claim under test is about what the Gate decides. |
 * | `packages/orders`' `createOrderFromDecisionDetailed` — draft resolution, idempotency, the over-refund guard, the budget hooks | **yes** | and it is the second of I-1's two independent guards. |
 * | `@countersign/db`'s `reserveIn` / `releaseIn` / `commitIn` over `createInMemoryBudgetStore` | **yes** | The ledger arithmetic is the arithmetic that ships; only the `FOR UPDATE` *row* is in memory. |
 * | `PayPalClient` — request building, headers, `PayPal-Request-Id`, the retry loop, zod validation | **yes**, with `fetchImpl` replaced | AGENTS.md rule 5 forbids faking PayPal's *behaviour*; replacing the socket is the seam `PayPalClientOpts` already declares and the one `packages/paypal/test/fixtures` uses. The responses are doc-derived, and no test asserts PayPal's behaviour from them. |
 * | Our own rows | two in-memory worlds, one per port | `packages/gate` and `packages/orders` each expose their own store port. See the seam note below. |
 * | `@countersign/compiler`'s `compile` | **no** — a scripted {@link IntentCompiler} | This package asserts *sequencing*. `compile` has 285 tests of its own, covering EC-LLM-1 and EC-LLM-2. What must be real in a sequencing test is the **shape** of what comes back, so the double returns a real `CompiledMandate` and delegates `readBack` to the **real** `readBack` — the string a test asserts is the string the product renders. |
 *
 * ## The one seam that deserves an explanation
 *
 * In production there is **one** `checkout_attempts` table: Gate check 7 inserts a row into it and
 * `createOrderFromDecision` reads the same row. Here there are two in-memory worlds, each with its own
 * attempt map, because each package exposes its own port.
 *
 * {@link OrchestratorStoreDouble.decide} therefore **copies the row the Gate actually inserted** into the
 * order world rather than having the harness pre-seed an equivalent. That matters for the assertion: the
 * copied row's `amount_minor`, `currency` and `payee` are the values the Gate derived from the signed L3a,
 * so "the PayPal request carries exactly the decision's amount, currency and payee" is a claim about values
 * that travelled through the Gate rather than about numbers a test typed in two places.
 */
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose'

import {
  csError,
  fixedClock,
  type AttemptId,
  type Clock,
  type CsError,
  type MandateId,
  type Result,
} from '@countersign/core'
import { hasBlockingAmbiguities, readBack, type CompiledMandate } from '@countersign/compiler'
import type {
  BudgetEntryRow,
  CheckoutAttemptRow,
  CheckoutSessionRow,
  GateDecisionRow,
  ProductRow,
} from '@countersign/db'
import {
  createInMemoryGateWorld,
  gateJwks,
  recordSigner,
  verifyDecisionRecord,
  type GateDecision,
  type GateInput,
  type GateJwks,
  type InMemoryGateWorld,
  type InMemoryGateWorldSeed,
  type MerchantKeySet,
} from '@countersign/gate'
import { PayPalClient } from '@countersign/paypal'
import {
  budgetHooksFromStore,
  createInMemoryOrderWorld,
  defineOrderDeps,
  type InMemoryOrderWorld,
} from '@countersign/orders'

import type { IntentCompiler, OrchestratorDeps, OrchestratorStore } from '../src/types'

/* ============================================================================================ */
/* 1. Ids and money                                                                                */
/* ============================================================================================ */

/** One fixed instant, so no assertion is ever about wall time (AGENTS.md rule 10). */
export const NOW_SEC = 1_789_000_000

export const ATTEMPT_ID = 'att_0000000000000000000000000A' as AttemptId
export const MANDATE_ID = 'mdt_0000000000000000000000000A' as MandateId
export const CHECKOUT_ID = 'chk_0000000000000000000000000A' as `chk_${string}`
export const AGENT_ID = 'agt_0000000000000000000000000A' as `agt_${string}`
export const DEVICE_ID = 'dev_0000000000000000000000000A' as `dev_${string}`
export const WALLET_ID = 'wal_0000000000000000000000000A' as `wal_${string}`
export const MERCHANT_ID = 'MERCHANT_NORTHWIND'
export const AGENT_KID = 'agent-key-1'
export const MERCHANT_KID = 'merchant-1'
export const GATE_KID = 'gate-key-1'
export const VAULT_ID = '5TY05013RG002845M'
export const CHECKOUT_HASH = 'hash-1'

/** $30.00. */
export const CART_MINOR = 3_000n
/** $130.00 — §8.8's worked example limit. */
export const CAP_MINOR = 13_000n

/** PayPal's own ids, from the documentation examples in `packages/paypal/test/fixtures`. */
export const PAYPAL = {
  orderId: '5O190127TN364715T',
  authorizationId: '8AB12345AB6789123',
} as const

/* ============================================================================================ */
/* 2. The fetch double                                                                             */
/* ============================================================================================ */

export interface RecordedCall {
  readonly index: number
  readonly method: string
  /** Path with the base URL stripped, e.g. `/v2/checkout/orders`. */
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

export interface StubResponse {
  readonly status?: number
  readonly body?: unknown
}

/** `"<METHOD> <path template>"` → a response. `{id}` is a one-segment wildcard. */
export type Routes = Record<string, StubResponse | ((call: RecordedCall) => StubResponse)>

export interface RecordingPayPal {
  readonly fetchImpl: typeof fetch
  readonly calls: RecordedCall[]
  /** Calls whose path contains `fragment`. */
  callsTo(fragment: string): RecordedCall[]
  /** The parsed JSON body of the nth call whose path contains `fragment`. */
  bodyOf<T = Record<string, unknown>>(fragment: string, nth?: number): T
  /** `PayPal-Request-Id` of the nth call whose path contains `fragment`. */
  requestIdOf(fragment: string, nth?: number): string | undefined
  setRoutes(routes: Routes): void
}

/**
 * Segment-wise matching with `{…}` as a one-segment wildcard.
 *
 * Precise on purpose: `/v2/payments/authorizations/{id}/capture` and `/v2/checkout/orders/{id}/capture`
 * share their last two segments, so a substring matcher would answer a capture with the order's capture
 * stub and the assertion would pass for the wrong reason.
 */
function matches(path: string, template: string): boolean {
  const a = path.split('/')
  const b = template.split('/')
  if (a.length !== b.length) return false
  return b.every((seg, i) => seg.startsWith('{') || seg === a[i])
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {}
  const h = init?.headers
  if (!h) return out
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v
    })
    return out
  }
  if (Array.isArray(h)) for (const [k, v] of h) out[String(k).toLowerCase()] = String(v)
  else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = v
  }
  return out
}

export function recordingPayPal(routes: Routes): RecordingPayPal {
  const calls: RecordedCall[] = []
  let table = routes

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const method = (init?.method ?? 'GET').toUpperCase()
    const call: RecordedCall = {
      index: calls.length,
      method,
      path,
      headers: headersOf(init),
      body: init?.body,
    }
    calls.push(call)

    for (const [key, value] of Object.entries(table)) {
      const [routeMethod, template] = key.split(' ', 2)
      if (routeMethod !== undefined && routeMethod !== method) continue
      if (!matches(path, template ?? key)) continue
      const spec = typeof value === 'function' ? value(call) : value
      const status = spec.status ?? 200
      const headers = new Headers({ 'paypal-debug-id': `DEBUG-TEST-${call.index}` })
      if (spec.body === undefined) return new Response(null, { status, headers })
      headers.set('content-type', 'application/json')
      return new Response(JSON.stringify(spec.body), { status, headers })
    }

    // An unstubbed call answers 422 with PayPal's own envelope rather than hanging, so a test that reaches
    // an endpoint it did not stub fails loudly instead of timing out.
    return new Response(
      JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', message: `No stub for ${method} ${path}` }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )
  }

  return {
    fetchImpl: impl as typeof fetch,
    calls,
    callsTo: (fragment) => calls.filter((c) => c.path.includes(fragment)),
    bodyOf<T>(fragment: string, nth = 0) {
      const call = calls.filter((c) => c.path.includes(fragment))[nth]
      if (!call || typeof call.body !== 'string') {
        throw new Error(`No JSON body on call ${nth} to a path containing "${fragment}"`)
      }
      return JSON.parse(call.body) as T
    },
    requestIdOf: (fragment, nth = 0) =>
      calls.filter((c) => c.path.includes(fragment))[nth]?.headers['paypal-request-id'],
    setRoutes: (next) => {
      table = next
    },
  }
}

/** OAuth plus a `POST /v2/checkout/orders` that authorizes **inline** (the audit's §17 shape). */
export function happyRoutes(orderId = PAYPAL.orderId): Routes {
  return {
    'POST /v1/oauth2/token': {
      status: 200,
      body: {
        access_token: 'A21AAFakeAccessToken0000000000000000',
        token_type: 'Bearer',
        expires_in: 32_400,
      },
    },
    'POST /v2/checkout/orders': orderCreated(orderId),
    'POST /v2/checkout/orders/{id}/authorize': orderCreated(orderId),
  }
}

/**
 * A documented `POST /v2/checkout/orders` 201.
 *
 * Doc-derived rather than captured (`HUMAN_TODO` H-01 is open), and no test asserts PayPal's behaviour from
 * it — the same seam `packages/paypal/test/fixtures/transport-double.ts` uses. The inline
 * `authorizations[0]` block is PayPal's documented shape for a `vault_id` order, which is what §11's
 * week-1 check C2 is about.
 */
export function orderCreated(orderId = PAYPAL.orderId): StubResponse {
  return {
    status: 201,
    body: {
      id: orderId,
      intent: 'AUTHORIZE',
      status: 'CREATED',
      purchase_units: [
        {
          reference_id: 'default',
          custom_id: `cs1:${'A'.repeat(43)}`,
          invoice_id: 'ord_00000000000000000000000001',
          amount: { currency_code: 'USD', value: '30.00' },
          payee: { merchant_id: MERCHANT_ID },
          payments: {
            authorizations: [
              {
                id: PAYPAL.authorizationId,
                status: 'CREATED',
                amount: { currency_code: 'USD', value: '30.00' },
                expiration_time: '2026-11-02T00:00:00Z',
                seller_protection: { status: 'ELIGIBLE' },
              },
            ],
          },
        },
      ],
      payer: {},
      create_time: '2026-10-04T00:00:00Z',
      links: [
        {
          href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`,
          rel: 'self',
          method: 'GET',
        },
      ],
    },
  }
}

/* ============================================================================================ */
/* 3. Keys                                                                                         */
/* ============================================================================================ */

let cachedKeys: Promise<HarnessKeys> | null = null

export interface HarnessKeys {
  /** Ed25519 private key plus the JWKS a verifier needs. §6's `GATE_SIGNING_KEY` is the JWK of such a key. */
  readonly gate: { readonly key: CryptoKey; readonly jwks: GateJwks }
  /** The merchant's price-lock key. Check 5 verifies the checkout JWT against it, locally and for real. */
  readonly merchant: { readonly key: CryptoKey; readonly publicJwk: Record<string, unknown> }
}

function keys(): Promise<HarnessKeys> {
  cachedKeys ??= buildKeys()
  return cachedKeys
}

async function buildKeys(): Promise<HarnessKeys> {
  const gatePair = await generateKeyPair('Ed25519', { extractable: true })
  const merchantPair = await generateKeyPair('Ed25519', { extractable: true })
  const gatePublic = (await exportJWK(gatePair.publicKey)) as Record<string, unknown>
  const merchantPublic = (await exportJWK(merchantPair.publicKey)) as Record<string, unknown>
  return {
    gate: { key: gatePair.privateKey, jwks: gateJwks(GATE_KID, { ...gatePublic, alg: 'EdDSA' }) },
    // `alg` is required on the JWK: `jose` refuses to import a key whose JWK does not name its own
    // algorithm, and check 5 imports this one to verify the checkout JWT.
    merchant: {
      key: merchantPair.privateKey,
      publicJwk: { ...merchantPublic, kid: MERCHANT_KID, alg: 'EdDSA' },
    },
  }
}

/* ============================================================================================ */
/* 4. Tokens                                                                                       */
/* ============================================================================================ */

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/**
 * A structurally valid, **unsigned** L3a carrying the payment claims.
 *
 * Unsigned for the reason `packages/gate`'s own fixtures give: the Gate never verifies this signature
 * itself — check 4 asks vi-service, the only party that holds the issuer's private key — and what the Gate
 * reads here are the *claims*, cross-checked against our own rows. `verifySignatures` is left at the world's
 * accepting default so these tests are about the orchestrator's sequencing rather than about check 4's
 * cryptography, which `packages/gate` tests with real Ed25519 signatures of its own.
 */
export function l3a(overrides: Record<string, unknown> = {}): string {
  const header = b64({ alg: 'EdDSA', kid: AGENT_KID, typ: 'JWT' })
  const payload = b64({
    jti: 'jti-attempt-0A',
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

/** An unsigned L3b binding the checkout hash, the way §8.9's price lock does. */
export function l3b(overrides: Record<string, unknown> = {}): string {
  const header = b64({ alg: 'EdDSA', kid: AGENT_KID, typ: 'JWT' })
  const payload = b64({
    checkout_hash: CHECKOUT_HASH,
    aud: 'https://merchant.example',
    iss: 'https://agent.example',
    iat: NOW_SEC - 5,
    exp: NOW_SEC + 295,
    ...overrides,
  })
  return `${header}.${payload}.${Buffer.from('not-a-real-signature', 'utf8').toString('base64url')}`
}

/** A checkout JWT signed by a **real** merchant key, so Gate check 5 verifies it cryptographically. */
export async function checkoutJwt(k: HarnessKeys): Promise<string> {
  return new SignJWT({
    sub: MERCHANT_ID,
    total_minor: Number(CART_MINOR),
    currency: 'USD',
    checkout_id: CHECKOUT_ID,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: MERCHANT_KID })
    .setIssuedAt(NOW_SEC - 5)
    .setExpirationTime(NOW_SEC + 895)
    .sign(k.merchant.key)
}

/* ============================================================================================ */
/* 5. The OrchestratorStore double                                                                 */
/* ============================================================================================ */

/**
 * The bridge between the two in-memory worlds.
 *
 * `decide` is the important one: it takes the row **the Gate actually inserted** and makes it the order
 * orchestrator's attempt row, then writes the `gate_decisions` row `createOrderFromDecision` re-reads by
 * id. Two writes, and the order matters — a decision with no attempt behind it is the state EC-IDEM-2 cannot
 * recover from.
 */
export interface OrchestratorStoreDouble extends OrchestratorStore {
  /** Every `decide` call, in order. */
  readonly decided: Array<{ attemptId: AttemptId; decisionId: string; outcome: string }>
  /** How many times `decisionForAttempt` was read. */
  decisionReads(): number
  /** Overrides the candidates `staleAttempts` returns. */
  setStaleAttempts(rows: readonly CheckoutAttemptRow[]): void
  /** Makes `budgetEntries` answer with a failure, to prove the sweep reports rather than swallows. */
  failBudgetEntries(error: CsError): void
}

export function storeDouble(args: {
  readonly gateWorld: InMemoryGateWorld
  readonly orderWorld: InMemoryOrderWorld
  readonly budget: { entries(): BudgetEntryRow[] }
  readonly now: Date
}): OrchestratorStoreDouble {
  const decided: OrchestratorStoreDouble['decided'] = []
  let stale: CheckoutAttemptRow[] = []
  let budgetFailure: CsError | null = null
  let reads = 0

  return {
    decided,
    decisionReads: () => reads,
    setStaleAttempts: (rows) => {
      stale = [...rows]
    },
    failBudgetEntries: (error) => {
      budgetFailure = error
    },

    async decide({
      decision,
      attemptId,
      at,
    }): Promise<Result<GateDecisionRow | undefined, CsError>> {
      const inserted = args.gateWorld.insertedAttempts.find((a) => a.id === attemptId)
      // A `GATE_REPLAY` means check 7 refused the insert, so there is no attempt row and
      // `gate_decisions.attempt_id`'s foreign key has nothing to point at. Nothing is written.
      if (inserted === undefined) return { ok: true, value: undefined }
      args.orderWorld.rows.attempts.set(attemptId, { ...inserted, state: 'GATED_ALLOW' })

      const row = {
        id: decision.id,
        attempt_id: attemptId,
        decision: decision.decision,
        reasons: decision.reasons as unknown as GateDecisionRow['reasons'],
        checks: decision.checks as unknown as GateDecisionRow['checks'],
        chain_valid: true,
        vi_lib_commit: '356c29635f1c44df7de02edb58699ca9f29bece6',
        signed_record: decision.signedRecord,
        decided_at: at,
        budget_version: decision.reservation?.budgetVersion ?? null,
        created_at: at,
        updated_at: at,
      } as unknown as GateDecisionRow
      args.orderWorld.rows.decisions.set(row.id, row)
      decided.push({ attemptId, decisionId: row.id, outcome: decision.decision })
      return { ok: true, value: row }
    },

    async decisionForAttempt(attemptId) {
      reads += 1
      for (const row of args.orderWorld.rows.decisions.values()) {
        if (row.attempt_id === attemptId) return { ok: true, value: row }
      }
      return { ok: true, value: undefined }
    },

    async staleAttempts(olderThan) {
      // `findStaleAttempts`' own predicate, so the filter under test is the sweep's and not the query's.
      //
      // Read from the **order** world's attempt map, not the Gate's: `createOrderFromDecision` advances the
      // state (`ORDER_CREATED` → `AUTHORIZED`) through the order store, and there is one `checkout_attempts`
      // table in production. Reading the Gate's copy would show a stale `GATED_ALLOW` for an attempt that
      // already has an order — and a sweep that released a real payment's reservation is the worst bug this
      // job could have.
      const all = stale.length > 0 ? stale : [...args.orderWorld.rows.attempts.values()]
      return {
        ok: true,
        value: all.filter(
          (a) =>
            a.created_at.getTime() < olderThan.getTime() &&
            (a.state === 'CREATED' || a.state === 'GATED_ALLOW'),
        ) as CheckoutAttemptRow[],
      }
    },

    async budgetEntries(mandateId) {
      if (budgetFailure !== null) return { ok: false, error: budgetFailure }
      return {
        ok: true,
        value: args.budget.entries().filter((e) => e.mandate_id === mandateId) as BudgetEntryRow[],
      }
    },

    async setAttemptState(attemptId, state, at) {
      const row = args.orderWorld.rows.attempts.get(attemptId)
      if (row === undefined) throw new Error(`no attempt ${attemptId} to mark ${state}`)
      const next = { ...row, state, updated_at: at }
      args.orderWorld.rows.attempts.set(attemptId, next)
      const gateRow = args.gateWorld.insertedAttempts.find((a) => a.id === attemptId)
      if (gateRow !== undefined) gateRow.state = state
      return { ok: true, value: next }
    },
  }
}

/* ============================================================================================ */
/* 6. The compiler double                                                                          */
/* ============================================================================================ */

/**
 * A scripted {@link IntentCompiler}.
 *
 * A double **on purpose, and only here** — see the table in the file header. `readBack` and
 * `hasBlockingAmbiguities` are the **real** functions, so a read-back assertion is an assertion about the
 * string the product renders.
 */
export function scriptedCompiler(input: {
  readonly mandate?: CompiledMandate
  readonly failWith?: CsError
}): IntentCompiler & { calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    async compile() {
      calls += 1
      if (input.failWith !== undefined) return { ok: false, error: input.failWith }
      if (input.mandate !== undefined) return { ok: true, value: input.mandate }
      throw new Error('scriptedCompiler: no mandate and no failure were configured')
    },
    readBack: (mandate, ctx) => readBack(mandate, ctx),
    hasBlockingAmbiguities: (mandate) => hasBlockingAmbiguities(mandate),
  }
}

/** A `CompiledMandate` with one amount cap — the shape §8.8 produces for "under $130 at Northwind". */
export function compiledMandate(): CompiledMandate {
  return {
    // `max` is integer **minor units** (`minorUnitsSchema`), which is what `readBack` renders. `min` is
    // genuinely optional in the schema, so it is absent rather than `null` — the two are different facts.
    constraints: [{ type: 'mandate.payment.amount_range', currency: 'USD', max: 13_000 }],
    currency: 'USD',
    ttlSeconds: 604_800,
    expiresAtEpochSec: NOW_SEC + 604_800,
    preferences: {},
    assumptions: [],
    ambiguities: [],
  } as unknown as CompiledMandate
}

/** The same, with one blocking question — §8.8's "an unresolvable intent produces an ambiguity". */
export function compiledWithAmbiguity(): CompiledMandate {
  return {
    ...compiledMandate(),
    ambiguities: [
      {
        field: 'amount_range.max',
        question: 'What is the most you want to spend in total on this order?',
        options: ['$50.00', '$130.00', '$250.00'],
      },
    ],
  } as unknown as CompiledMandate
}

/* ============================================================================================ */
/* 7. The harness                                                                                  */
/* ============================================================================================ */

type HarnessVerifyOptions = Omit<NonNullable<InMemoryGateWorldSeed['verify']>, 'disclosed'> & {
  readonly disclosed?: Partial<NonNullable<InMemoryGateWorldSeed['verify']>['disclosed']>
}

export interface HarnessOptions {
  /** Which outcome the Gate should reach. `REVIEW` is velocity's, so it needs six recent attempts. */
  readonly gateOutcome?: 'ALLOW' | 'BLOCK' | 'REVIEW'
  /** Flip exactly one thing so a BLOCK test can name the check it broke. */
  readonly mandateStatus?: 'ACTIVE' | 'REVOKED' | 'SUSPENDED'
  /** vi's response, including disclosures resolved from the supplied signed chain. */
  readonly verify?: HarnessVerifyOptions
  readonly routes?: Routes
  readonly nowSec?: number
  /** The compiled mandate the scripted compiler returns. Defaults to a clean one. */
  readonly compiled?: CompiledMandate
  /** Make the compiler fail, to prove the run stops before the Gate. */
  readonly compilerFails?: CsError
}

export interface Harness {
  readonly deps: OrchestratorDeps
  readonly gateWorld: InMemoryGateWorld
  readonly orderWorld: InMemoryOrderWorld
  readonly paypal: RecordingPayPal
  readonly store: OrchestratorStoreDouble
  readonly clock: Clock
  readonly keys: HarnessKeys
  /** The attempt row the Gate inserted, once it has run. */
  insertedAttempt(): CheckoutAttemptRow | undefined
  /** Σ RESERVE − Σ RELEASE over the ledger, the balance the buyer's budget is left with. */
  reserved(): bigint
  readonly entries: () => BudgetEntryRow[]
}

/** A `GateInput` for the harness's fixture ids. */
export function gateInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    attemptId: ATTEMPT_ID,
    mandateId: MANDATE_ID,
    checkoutId: CHECKOUT_ID,
    l3a: l3a(),
    l3b: l3b(),
    agentId: AGENT_ID,
    ...overrides,
  }
}

/** Six attempts inside the window, which is what trips Gate check 12's first rule (> 5 in 10 min). */
function recentAttempts(nowSec: number): CheckoutAttemptRow[] {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `att_000000000000000000000000${i}B` as AttemptId,
    mandate_id: MANDATE_ID,
    agent_id: AGENT_ID,
    checkout_session_id: CHECKOUT_ID,
    l3a: '',
    l3b: '',
    l3_jti: `jti-history-${i}`,
    idempotency_key: `idem-history-${i}`,
    amount_minor: CART_MINOR,
    currency: 'USD',
    payee: MERCHANT_ID,
    state: 'GATED_ALLOW',
    gate_decision_id: null,
    created_at: new Date((nowSec - 60) * 1000),
    updated_at: new Date((nowSec - 60) * 1000),
  })) as unknown as CheckoutAttemptRow[]
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const nowSec = options.nowSec ?? NOW_SEC
  const clock = fixedClock(nowSec)
  const now = new Date(nowSec * 1000)
  const k = await keys()
  const outcome = options.gateOutcome ?? 'ALLOW'
  const { disclosed: verifyDisclosed, ...verifyOverrides } = options.verify ?? {}

  const products: ProductRow[] = [
    {
      sku: 'NW-001',
      title: 'Trail Runner',
      description: 'A running shoe.',
      price_minor: CART_MINOR,
      currency: 'USD',
      stock: 10,
      ships_in_days: 2,
      digital: false,
      listing_html: '<p>A running shoe.</p>',
      created_at: now,
      updated_at: now,
    } as ProductRow,
  ]

  const merchantKeys: MerchantKeySet = {
    currentKid: MERCHANT_KID,
    acceptedKids: [MERCHANT_KID],
    jwks: { [MERCHANT_KID]: k.merchant.publicJwk as never },
  }

  const status = options.mandateStatus ?? (outcome === 'BLOCK' ? 'REVOKED' : 'ACTIVE')

  const gateWorld = createInMemoryGateWorld({
    nowSec,
    budget: { cap: { minor: CAP_MINOR, currency: 'USD' } },
    products,
    mandate: {
      id: MANDATE_ID,
      device_id: DEVICE_ID,
      agent_id: AGENT_ID,
      wallet_id: WALLET_ID,
      status,
    },
    agent: { id: AGENT_ID, kid: AGENT_KID },
    device: { id: DEVICE_ID },
    session: {
      id: CHECKOUT_ID,
      merchant_id: MERCHANT_ID,
      cart: { lines: [{ sku: 'NW-001', qty: 1, unit_minor: CART_MINOR.toString() }] },
      subtotal_minor: CART_MINOR,
      tax_minor: 0n,
      shipping_minor: 0n,
      total_minor: CART_MINOR,
      currency: 'USD',
      checkout_jwt: await checkoutJwt(k),
      checkout_hash: CHECKOUT_HASH,
      price_lock_exp: new Date((nowSec + 900) * 1000),
      status: 'CREATED',
    },
    merchantKeys,
    // A **real** signature over the decision record, so the I-1 assertion verifies it instead of decoding it
    // and trusting the decode.
    signRecord: recordSigner(k.gate.key, GATE_KID),
    verify: {
      ...verifyOverrides,
      disclosed: {
        l1: {},
        l2: {
          delegate_payload: [{ vct: 'mandate.payment.1', constraints: [] }],
        },
        l3a: {
          delegate_payload: [
            {
              vct: 'mandate.payment.1',
              payment_amount: { amount: CART_MINOR.toString(), currency: 'USD' },
              payee: { id: MERCHANT_ID },
            },
          ],
        },
        l3b: {
          delegate_payload: [{ vct: 'mandate.checkout.1', checkout_hash: CHECKOUT_HASH }],
        },
        ...verifyDisclosed,
      },
    },
    ...(outcome === 'REVIEW' ? { attempts: recentAttempts(nowSec) } : {}),
  })

  const sessionOverrides: Partial<CheckoutSessionRow> = {
    // Stated rather than defaulted, so the two worlds cannot drift apart on the checkout id — the join key
    // `createOrderFromDecision` resolves the attempt through.
    id: CHECKOUT_ID,
    // `unit_minor` is a `bigint` in memory and a decimal string in `jsonb` (§7.2). The in-memory form is
    // the honest one for a seed; `cartLines` reads the stored string back with `bigintFromJson`.
    cart: { lines: [{ sku: 'NW-001', qty: 1, unit_minor: CART_MINOR }] } as never,
    subtotal_minor: CART_MINOR,
    tax_minor: 0n,
    shipping_minor: 0n,
    total_minor: CART_MINOR,
    currency: 'USD',
    checkout_jwt: await checkoutJwt(k),
    checkout_hash: CHECKOUT_HASH,
    price_lock_exp: new Date((nowSec + 900) * 1000),
    status: 'SUBMITTED',
  }

  const orderWorld = createInMemoryOrderWorld({
    nowSec,
    products,
    session: sessionOverrides,
    mandate: { id: MANDATE_ID, device_id: DEVICE_ID, agent_id: AGENT_ID, wallet_id: WALLET_ID },
    wallet: { id: WALLET_ID, payment_token_id: VAULT_ID },
    l1: { device_id: DEVICE_ID, wallet_id: WALLET_ID },
  })

  // `createInMemoryOrderWorld` seeds its own `att_…01` attempt and `gdc_…01` decision so that package's
  // own tests have a world to read. Ours is `…000A`, written by the Gate, and leaving a second seeded
  // attempt sitting in `GATED_ALLOW` would put a phantom reservation in front of the 30-minute sweep — a
  // test that released two things when only one existed.
  for (const id of [...orderWorld.rows.attempts.keys()]) {
    if (id !== ATTEMPT_ID) orderWorld.rows.attempts.delete(id)
  }
  for (const id of [...orderWorld.rows.decisions.keys()]) {
    if (id !== 'gdc_0000000000000000000000000A') orderWorld.rows.decisions.delete(id)
  }

  const paypal = recordingPayPal(options.routes ?? happyRoutes())
  const client = new PayPalClient({
    baseUrl: 'https://api-m.sandbox.paypal.com',
    clientId: 'TEST-CLIENT-ID',
    clientSecret: 'TEST-CLIENT-SECRET',
    clock,
    fetchImpl: paypal.fetchImpl,
    env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' },
    // One attempt: "exactly one HTTP request" must be assertable, and the retry loop has its own tests.
    maxRetries: 1,
    sleep: async () => undefined,
  })

  const store = storeDouble({ gateWorld, orderWorld, budget: gateWorld.store, now })

  const compiler = scriptedCompiler(
    options.compilerFails !== undefined
      ? { failWith: options.compilerFails }
      : { mandate: options.compiled ?? compiledMandate() },
  )

  const deps: OrchestratorDeps = {
    clock,
    compiler,
    gate: gateWorld.deps,
    orders: defineOrderDeps({
      clock,
      paypal: client,
      store: orderWorld.store,
      budget: budgetHooksFromStore(gateWorld.deps.budget),
      notify: { notify() {} },
    }),
    budget: gateWorld.deps.budget,
    store,
  }

  return {
    deps,
    gateWorld,
    orderWorld,
    paypal,
    store,
    clock,
    keys: k,
    insertedAttempt: () => gateWorld.insertedAttempts.find((a) => a.id === ATTEMPT_ID),
    reserved: () => {
      const row = gateWorld.store.accounts().get(MANDATE_ID)
      return row ? row.reserved_minor : 0n
    },
    entries: () => gateWorld.store.entries() as unknown as BudgetEntryRow[],
  }
}

/**
 * Verify a decision record this harness produced, with the real Ed25519 signature check.
 *
 * ### Why it refuses a record that pins no amount, currency or payee
 *
 * `GateRecordPayload` makes those three nullable, and `null` is the honest value for a run that could not
 * read the checkout session. This helper is only ever called on the **ALLOW** path, where §3.1 I-1 requires
 * the record to name all three exactly — so returning `null` here would be worse than useless: every caller
 * compares the result against a real expected value, and `expect(unit.amount.value).toBe(null)` fails in a
 * way that reads like a pricing bug rather than "the record stopped pinning what it must".
 *
 * So it throws, naming the field. A regression that silently dropped a value from the signed record then
 * fails here too, instead of being papered over by a comparison that happens to pass.
 */
export async function readSignedRecord(
  record: string,
  k: HarnessKeys,
  nowSec = NOW_SEC,
): Promise<{ amount: string; currency: string; payee: string; att: string; mdt: string }> {
  const verdict = await verifyDecisionRecord(record, { jwks: k.gate.jwks, nowSec })
  if (!verdict.valid) throw new Error(`decision record did not verify: ${verdict.reason}`)
  const p = verdict.payload
  const pinned = (value: string | null, field: string): string => {
    if (value === null) {
      throw new Error(
        `decision record does not pin ${field}: the ALLOW path must name it for I-1, and a record with ` +
          `none means the Gate could not read the checkout session.`,
      )
    }
    return value
  }
  return {
    amount: pinned(p.amount, 'amount'),
    currency: pinned(p.currency, 'currency'),
    payee: pinned(p.payee, 'payee'),
    att: p.att,
    mdt: p.mdt,
  }
}

/** A `CS_VALIDATION` error, for a test that needs a specific failure. */
export function validationError(message: string): CsError {
  return csError('CS_VALIDATION', message)
}

export type { GateDecision }
