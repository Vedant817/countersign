import 'server-only'

/**
 * The agent demo's session: a real mandate, a real agent key, a real checkout — provisioned server-side.
 *
 * ## What this file is for
 *
 * S-10 (`/agent`) needs a buyer before it can show anything: a wallet, a device credential, an agent
 * key bound into a signed mandate, a budget and a price lock. Every one of those is real here — vi
 * issues the L1, vi prepares and signs the L2, and the row that lands in `mandates` is the same row the
 * Gate reads. What is **fixture-like** is only the custody of the device key (`./demo-device.ts` explains
 * that) and the intent, which the caller supplies instead of a compiler run.
 *
 * The alternative — a hand-written `MandateRow` — was rejected on purpose. A fabricated mandate would
 * make the whole demo a mock of itself, and the one thing this project cannot afford is a demo that
 * proves nothing about the code.
 *
 * ## Provisioning, step by step
 *
 * ```
 *   user ─▶ wallet ─▶ device key (server, single use)
 *                        │
 *                        ├─▶ vi POST /v1/keys/agent          → agent kid + encrypted private key
 *                        ├─▶ vi POST /v1/l1/issue            → the L1 that binds the device key
 *                        ├─▶ vi POST /v1/l2/prepare          → the signing input
 *                        ├─▶ sign the signing input (P-256)  → the buyer's own signature
 *                        ├─▶ vi POST /v1/l2/finalize         → the L2, with disclosures
 *                        └─▶ mint_delegated (db)             → mandates + budget + wallet cap
 * ```
 *
 * ## Refusals, not throws
 *
 * Every step returns a `Result` and the first failure stops the run with a sentence naming what is
 * missing. A demo that 500s when `VI_SERVICE_URL` is unset is a demo a judge cannot diagnose; the same
 * rule as `gate-runtime.ts` and D-053.
 *
 * ## The constraint set, and why it is small
 *
 * The mandate carries `allowed_merchants`, `allowed_payees`, `amount_range.max = cap` and
 * `budget.max = cap`. It deliberately does **not** carry `line_items`: the demo's intent is "buy running
 * shoes under $50", the item category is a preference rather than a limit, and a line-items constraint
 * whose vocabulary the catalog has to match exactly would make the demo fail for a reason that has
 * nothing to do with the control being demonstrated. §8.13's demo is about the cap.
 */
import {
  csError,
  err,
  money,
  newId,
  systemClock,
  type AgentId,
  type CheckoutId,
  type CsError,
  type DeviceId,
  type MandateId,
  type Result,
  type UserId,
  type WalletId,
} from '@countersign/core'
import * as repository from '@countersign/db'
import {
  readBack,
  toJsonSafe,
  type CompiledMandate,
  type VIConstraint,
} from '@countersign/compiler'
import type {
  L3Signer,
  MandatePort,
  MandateView,
  SignL3Result,
  CheckoutView,
} from '@countersign/agent'
import type { ViClient } from '@countersign/vi-client'

import { merchantIdentity } from './merchant'
import { createDemoDeviceKey } from './demo-device'
import {
  AGENT_AUDIENCE,
  agentIssuer,
  createViClient,
  readServiceConfig,
} from '../app/lab/device-sign/vi'

/** The demo is opt-in, local only, and never production — the same gate the signing lab uses. */
export function agentDemoAllowed(): boolean {
  return process.env.COUNTERSIGN_AGENT_DEMO === '1' && process.env.NODE_ENV !== 'production'
}

export interface AgentSession {
  readonly userId: UserId
  readonly walletId: WalletId
  readonly deviceId: DeviceId
  readonly agentId: AgentId
  readonly mandateId: MandateId
  /** The plain-English read-back the (demo) device key signed. Rendered in the UI's mandate chip. */
  readonly readback: string
  readonly agentKid: string
  readonly expiresAtEpochSec: number
  /** UTC epoch seconds. */
  readonly createdAtEpochSec: number
}

export interface ProvisionInput {
  /** The buyer's own words. They become the mandate's `nl_intent` and the first line of the read-back. */
  readonly intent: string
  /** The per-purchase cap in minor units. */
  readonly capMinor: bigint
  /** Display name for the demo buyer. */
  readonly displayName?: string
}

/**
 * Provision one demo session.
 *
 * A fresh session per call is deliberate: each run gets its own mandate and budget, so a demo can be
 * replayed without the previous run's reservation changing this one's answer. The cost is a handful of
 * rows per run, and the alternative — reusing a mandate — would make the second run fail with
 * `GATE_BUDGET_EXCEEDED` for a reason a viewer would misread as a bug.
 */
export async function provisionAgentSession(
  input: ProvisionInput,
): Promise<Result<AgentSession, CsError>> {
  if (!agentDemoAllowed()) {
    return err(
      csError(
        'CS_FORBIDDEN',
        'The agent demo is available only when COUNTERSIGN_AGENT_DEMO=1 and NODE_ENV is not production.',
      ),
    )
  }
  const config = readServiceConfig()
  if (config === null) {
    return err(
      csError(
        'CS_INTERNAL',
        'VI_SERVICE_URL and VI_SERVICE_TOKEN must be set to provision an agent session.',
      ),
    )
  }
  const merchant = merchantIdentity()
  if (!merchant.ok) return err(merchant.error)

  const vi = createViClient(config)
  const nowMs = systemClock.nowMs()
  const userId = newId('usr') as UserId
  const walletId = newId('wal') as WalletId
  const deviceId = newId('dev') as DeviceId
  const agentId = newId('agt') as AgentId
  const mandateId = newId('mdt') as MandateId
  const ttlSeconds = 24 * 60 * 60

  // --- 1. The buyer, the wallet and the device key ------------------------------------------------
  const user = await repository.createUser({
    id: userId,
    persona: 'BUYER',
    display_name: input.displayName ?? 'Demo buyer',
    email: `demo.buyer.${userId.slice(-8)}@example.test`,
    country: 'US',
  })
  if (!user.ok) return user

  const wallet = await repository.createWallet({
    id: walletId,
    user_id: userId,
    // Not a vault token: no buyer credentials exist yet (HUMAN_TODO item 2). Named so that a reader
    // cannot mistake it for one, and so an order path that needs a real vault_id fails loudly.
    payment_token_id: `DEMO-NOT-A-VAULT-TOKEN-${userId.slice(-8)}`,
    payer_id: `DEMO-PAYER-${userId.slice(-8)}`,
    payer_email: `demo.buyer.${userId.slice(-8)}@example.test`,
  })
  if (!wallet.ok) return wallet

  const deviceKey = await createDemoDeviceKey()
  const device = await repository.createDevice({
    id: deviceId,
    user_id: userId,
    public_jwk: deviceKey.publicJwk as never,
    jkt: deviceKey.jkt,
    label: 'Demo device (server, single use)',
  })
  if (!device.ok) return device

  // --- 2. The agent key, minted by vi ---------------------------------------------------------------
  const minted = await vi.mintAgentKey({ agent_id: agentId })
  if (!minted.ok) return minted
  const agent = await repository.createAgent(
    {
      id: agentId,
      user_id: userId,
      name: 'Countersign demo agent',
      public_jwk: minted.value.public_jwk as never,
      kid: minted.value.kid,
    },
    Buffer.from(minted.value.enc_private_key_b64, 'base64'),
  )
  if (!agent.ok) return agent

  // --- 3. The L1, which binds the device key --------------------------------------------------------
  const issued = await vi.issueL1({
    user_id: userId,
    wallet: {
      payer_id: wallet.value.payer_id,
      payer_email: wallet.value.payer_email,
      payment_token_id: wallet.value.payment_token_id,
    },
    device_public_jwk: deviceKey.publicJwk as never,
    device_kid: deviceKey.kid,
  })
  if (!issued.ok) return issued

  const l1 = await repository.createL1Credential({
    id: newId('l1') as never,
    user_id: userId,
    device_id: deviceId,
    wallet_id: walletId,
    sd_jwt: issued.value.l1,
    issuer_kid: issued.value.issuer_kid,
    iat: BigInt(issued.value.iat),
    exp: BigInt(issued.value.exp),
  })
  if (!l1.ok) return l1

  // --- 4. The mandate: compiled, prepared, signed, finalised ----------------------------------------
  const constraints: VIConstraint[] = [
    { type: 'mandate.checkout.allowed_merchants', allowed: [merchant.value] },
    { type: 'mandate.payment.allowed_payees', allowed: [merchant.value] },
    { type: 'mandate.payment.amount_range', currency: 'USD', min: null, max: input.capMinor },
    { type: 'mandate.payment.budget', currency: 'USD', min: null, max: input.capMinor },
  ] as VIConstraint[]

  const expiresAtEpochSec = Math.floor(nowMs / 1000) + ttlSeconds
  const compiled: CompiledMandate = {
    constraints,
    currency: 'USD',
    ttlSeconds,
    expiresAtEpochSec,
    preferences: {},
    assumptions: [],
    ambiguities: [],
  }
  // The read-back is the compiler's own template, not a string written here: a demo that paraphrased the
  // sentence the buyer "signed" would be showing a promise the signature does not cover (§8.8).
  const readback = readBack(compiled, {
    merchants: { [merchant.value.id]: merchant.value.name },
    tz: 'Asia/Kolkata',
  })

  const nonce = crypto.randomUUID()
  const aud = agentIssuer() || AGENT_AUDIENCE
  const prepared = await vi.prepareL2({
    l1: issued.value.l1,
    device_kid: deviceKey.kid,
    agent_public_jwk: minted.value.public_jwk as never,
    agent_kid: minted.value.kid,
    checkout_constraints: constraints.filter(
      (constraint) => constraint.type === 'mandate.checkout.allowed_merchants',
    ) as never,
    payment_constraints: constraints.filter(
      (constraint) => constraint.type !== 'mandate.checkout.allowed_merchants',
    ) as never,
    merchants: [merchant.value],
    acceptable_items: [],
    payment_instrument: {
      type: 'paypal_vault',
      id: issued.value.card_id,
      description: 'PayPal demo wallet (no vault token yet)',
    },
    nonce,
    aud,
    iss: aud,
    device_id: deviceId,
    prompt_summary: input.intent.slice(0, 2000),
  })
  if (!prepared.ok) return prepared

  const signature = await deviceKey.sign(prepared.value.signing_input)
  const finalized = await vi.finalizeL2({
    prepare_id: prepared.value.prepare_id,
    signature_b64url: signature,
  })
  if (!finalized.ok) return finalized

  const iat = finalized.value.iat
  const exp = finalized.value.exp ?? expiresAtEpochSec

  const mandate = await repository.createMandate({
    id: mandateId,
    user_id: userId,
    device_id: deviceId,
    agent_id: agentId,
    wallet_id: walletId,
    l2_serialized: finalized.value.l2,
    l2_payload: toJsonSafe(prepared.value.payload) as never,
    nl_intent: input.intent,
    readback,
    constraints: toJsonSafe(constraints) as never,
    nonce,
    aud,
    iat: BigInt(iat),
    exp: BigInt(exp),
    status: 'ACTIVE',
    compiler_model: 'demo-fixture',
  })
  if (!mandate.ok) return mandate

  const budget = await repository.openBudget({
    mandateId,
    cap: money(input.capMinor, 'USD'),
  })
  if (!budget.ok) return budget

  const walletCap = await repository.setWalletCap(walletId, 'MONTH', money(input.capMinor, 'USD'))
  if (!walletCap.ok) return walletCap

  return {
    ok: true,
    value: {
      userId,
      walletId,
      deviceId,
      agentId,
      mandateId,
      readback,
      agentKid: minted.value.kid,
      expiresAtEpochSec: exp,
      createdAtEpochSec: new Date(nowMs).getUTCSeconds(),
    },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The two ports the agent package asks for                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * The mandate, read-only — §8.13 defence 2.
 *
 * `maxAmountMinor` is read from the mandate's own `constraints` column, which is a copy of what the
 * device key signed. It is used for *display* and for the scripted shopper's choice of cart; it is
 * **not** the enforcement point. vi re-reads the signed L2 on every `l3/create`, and the Gate re-reads it
 * again on every decision, so a wrong number here can only make the agent ask a worse question.
 */
export function sessionMandatePort(): MandatePort {
  return {
    async load(mandateId): Promise<Result<MandateView | undefined, CsError>> {
      const found = await repository.findMandateById(mandateId)
      if (!found.ok) return found
      const row = found.value
      if (row === undefined) return { ok: true, value: undefined }
      const constraints = Array.isArray(row.constraints) ? (row.constraints as VIConstraint[]) : []
      return {
        ok: true,
        value: {
          mandateId: row.id as MandateId,
          agentId: row.agent_id as AgentId,
          userId: row.user_id as UserId,
          status: row.status,
          currency: currencyOf(constraints) ?? 'USD',
          readback: row.readback,
          maxAmountMinor: capOf(constraints, 'mandate.payment.amount_range'),
          budgetMinor: capOf(constraints, 'mandate.payment.budget'),
          allowedMerchantIds: constraints
            .filter((constraint) => constraint.type === 'mandate.checkout.allowed_merchants')
            .flatMap((constraint) => constraint.allowed.map((entry) => entry.id)),
          acceptableItems: [],
          expiresAtEpochSec: Number(row.exp),
        },
      }
    },
  }
}

function currencyOf(constraints: readonly VIConstraint[]): string | null {
  for (const constraint of constraints) {
    if (constraint.type === 'mandate.payment.amount_range') return constraint.currency
  }
  return null
}

/** The cap a constraint names, as minor units, or `null` when none was disclosed. */
function capOf(
  constraints: readonly VIConstraint[],
  type: 'mandate.payment.amount_range' | 'mandate.payment.budget',
): bigint | null {
  for (const constraint of constraints) {
    if (constraint.type !== type) continue
    const value = type === 'mandate.payment.amount_range' ? constraint.max : constraint.max
    if (value === null || value === undefined) return null
    return typeof value === 'bigint' ? value : BigInt(value)
  }
  return null
}

/**
 * The signer: vi `/v1/l3/create`, with the mandate and agent key the session provisioned.
 *
 * The signer refuses an out-of-mandate cart itself (§8.13 defence 3) — `create_l3` runs the same STRICT
 * constraint check the Gate will, *before* the agent key touches anything. That refusal is returned as a
 * refusal (`refused: true`), never as a transport error, because it is a successful run of the control.
 *
 * `mandateId` is captured rather than looked up per checkout: the session knows which mandate it
 * provisioned, and a signer that guessed "the newest active mandate" would eventually sign against
 * somebody else's.
 */
export function sessionSigner(
  mandateId: MandateId,
  vi: ViClient = createViClientOrThrow(),
): L3Signer {
  return {
    async loadCheckout(checkoutId: string): Promise<Result<CheckoutView | undefined, CsError>> {
      const found = await repository.findCheckoutSessionById(checkoutId as CheckoutId)
      if (!found.ok) return found
      const row = found.value
      if (row === undefined) return { ok: true, value: undefined }
      const cart = (row.cart ?? {}) as { lines?: { sku: string; title?: string; qty: number }[] }
      const merchant = merchantIdentity()
      return {
        ok: true,
        value: {
          checkoutId: row.id,
          merchantId: row.merchant_id,
          merchantName: merchant.ok ? merchant.value.name : row.merchant_id,
          totalMinor: money(row.total_minor, row.currency),
          lines: (cart.lines ?? []).map((line) => ({
            sku: line.sku,
            qty: line.qty,
            title: line.title ?? line.sku,
          })),
          priceLockExpiresAtMs: row.price_lock_exp.getTime(),
        },
      }
    },

    async signCheckout(checkout: CheckoutView): Promise<SignL3Result> {
      const session = await repository.findCheckoutSessionById(checkout.checkoutId as CheckoutId)
      if (!session.ok) return { ok: false, refused: false, error: session.error }
      if (session.value === undefined) {
        return {
          ok: false,
          refused: false,
          error: csError('CS_NOT_FOUND', `No checkout ${checkout.checkoutId}.`),
        }
      }
      const mandate = await repository.findMandateById(mandateId)
      if (!mandate.ok) return { ok: false, refused: false, error: mandate.error }
      if (mandate.value === undefined) {
        return {
          ok: false,
          refused: false,
          error: csError('CS_NOT_FOUND', `No mandate ${mandateId}.`),
        }
      }
      const agent = await repository.findAgentById(mandate.value.agent_id as AgentId)
      if (!agent.ok) return { ok: false, refused: false, error: agent.error }
      if (agent.value === undefined) {
        return {
          ok: false,
          refused: false,
          error: csError('CS_NOT_FOUND', 'No agent for this mandate.'),
        }
      }

      const created = await vi.createL3({
        agent_kid: agent.value.kid,
        enc_private_key_b64: agent.value.enc_private_key.toString('base64'),
        l2: mandate.value.l2_serialized,
        checkout_jwt: session.value.checkout_jwt,
        payment: {
          amount_minor: checkout.totalMinor.minor,
          currency: checkout.totalMinor.currency,
          payee_id: checkout.merchantId,
        },
        aud: mandate.value.aud,
        nonce: crypto.randomUUID(),
        agent_id: mandate.value.agent_id,
      })
      if (!created.ok) {
        // `VI_CONSTRAINT_VIOLATION` and `VI_CHAIN_INVALID` are the signer's two refusals, and they are
        // different facts: "this cart is outside your mandate" and "this mandate is not usable". Both are
        // refusals rather than faults; everything else (a timeout, a 500) is a fault and is surfaced as one.
        const refused =
          created.error.code === 'VI_CONSTRAINT_VIOLATION' ||
          created.error.code === 'VI_CHAIN_INVALID'
        return { ok: false, refused, error: created.error }
      }
      return {
        ok: true,
        value: {
          l3a: created.value.l3a,
          l3b: created.value.l3b,
          jti: created.value.jti,
          amountMinor: checkout.totalMinor,
          payeeId: checkout.merchantId,
        },
      }
    },
  }
}

/** A vi client built from configuration, throwing only when the caller passed no client and none is set. */
function createViClientOrThrow(): ViClient {
  const config = readServiceConfig()
  if (config === null) {
    throw csError('CS_INTERNAL', 'VI_SERVICE_URL and VI_SERVICE_TOKEN must be set to sign an L3.')
  }
  return createViClient(config)
}
