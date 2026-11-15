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
 * that); the intent is compiled through a real compiler run.
 *
 * **The buyer is not created here (D-060).** `provisionAgentSession` requires the id of a row that already
 * exists — one a person created by signing up — and refuses anything else. Before this it minted a fresh
 * `usr_…` for a request with no cookie, so a browser could hold an identity nobody had authenticated for
 * and `user_id` in a request body was the only thing saying whose budget it was.
 *
 * The alternative — a hand-written `MandateRow` — was rejected on purpose. A fabricated mandate would
 * make the whole demo a mock of itself, and the one thing this project cannot afford is a demo that
 * proves nothing about the code.
 *
 * ## Provisioning, step by step
 *
 * ```
 *   user ─▶ wallet ─▶ device key (browser, non-extractable)
 *                        │
 *                        ├─▶ vi POST /v1/keys/agent          → agent kid + encrypted private key
 *                        ├─▶ vi POST /v1/l1/issue            → the L1 that binds the device key
 *                        ├─▶ vi POST /v1/l2/prepare          → the signing input
 *                        ├─▶ sign the signing input (P-256)  → the buyer's own signature
 *                        ├─▶ vi POST /v1/l2/finalize         → the L2, with disclosures
 *                        └─▶ mint_delegated (db)             → mandates + budget + wallet cap
 * ```
 *
 * ## Prepare and finalize
 *
 * That pipeline has the buyer's device key at its centre, so it is written as two phases:
 * `prepareAgentSession` does everything up to and including `vi POST /v1/l2/prepare` and seals what
 * the second phase needs into a `pending` token (`./pending-session-token.ts`, HMAC under
 * `SESSION_SECRET`); the buyer's browser signs `signing_input` with its own non-extractable key; and
 * `finalizeAgentSession` verifies the token, hands vi the signature, and writes the mandate, budget
 * and wallet cap. `provisionAgentSession` is the two phases back to back with the demo's own
 * server-held key (`./demo-device.ts`) — the fixture whose custody the real flow removes.
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
import { db, jwksKeys } from '@countersign/db'
import { contentWords } from '@countersign/agent'
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
import type { L2PrepareRequest, ViClient } from '@countersign/vi-client'

/** The input types vi's own request schema accepts, recovered from the request rather than re-declared. */
type ViCheckoutConstraints = NonNullable<L2PrepareRequest['checkout_constraints']>
type ViPaymentConstraints = NonNullable<L2PrepareRequest['payment_constraints']>

import { merchantIdentity } from './merchant'
import { applyCap, assertStoreCurrency } from './apply-cap'
import { assertNoAmbiguities } from './agent-intent'
import { compileIntent, compilerModelLabel } from './intent-compiler'
import { createDemoDeviceKey } from './demo-device'
import { deviceThumbprint } from './device-thumbprint'
import { pickActiveWallet } from './active-wallet'
import {
  PENDING_SESSION_TTL_SECONDS,
  signPendingSessionToken,
  verifyPendingSessionToken,
  type PendingAgentSession,
} from './pending-session-token'
import { AGENT_AUDIENCE, agentIssuer, createViClient, readServiceConfig } from './vi-client'

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
  /**
   * Whose mandate this is — a buyer that already exists, resolved by the caller from the session.
   *
   * **Required, and not defaulted.** This used to be optional: with no cookie the provisioner minted a
   * fresh `usr_…` (`demo.buyer.<id>@example.test`), which is how a browser got an identity without a
   * credential (audit §4, D-060). A default here would be the same door under a different name, so the
   * type refuses to compile a call that does not name the buyer it is acting for.
   *
   * A cookie that names a row which is gone (a restored database, or a forged id shaped like a real one)
   * refuses with `CS_NOT_FOUND` rather than silently minting a stranger: a session that quietly becomes a
   * different person is the bug this parameter exists to remove.
   */
  readonly userId: UserId
}

/**
 * What `prepareAgentSession` needs before it will run. The buyer is named by id (D-060) and the
 * device key arrives from the caller — the browser's own non-extractable key in the real flow, the
 * demo's server-minted one in `provisionAgentSession`.
 */
export interface PrepareAgentSessionInput {
  /** Whose mandate this is — an existing `BUYER` row's id, resolved by the caller from the session. */
  readonly userId: UserId
  /** The buyer's own words. They become the mandate's `nl_intent` and the first line of the read-back. */
  readonly intent: string
  /** The per-purchase cap in minor units. */
  readonly capMinor: bigint
  /** The device public key, in the shape vi's `device_public_jwk` expects. */
  readonly devicePublicJwk: JsonWebKey
  /** `dev_<jkt>` for that key, matching `browser-keystore.ts`'s `deviceKeyId`. */
  readonly deviceKid: string
}

/** What `prepareAgentSession` hands back: the bytes to sign, and the token that opens phase 2. */
export interface PreparedAgentSession {
  /** vi's prepare-record id — `finalizeAgentSession` passes it to `l2/finalize` verbatim. */
  readonly prepareId: string
  /**
   * The exact ASCII the device key signs, `header.payload`. Passed through byte for byte: a
   * re-encoded copy would be signed instead of the bytes vi verifies, and the failure would surface
   * as `VI_SIGNATURE_MISMATCH` (see `@countersign/vi-client`'s note on `signing_input`).
   */
  readonly signingInput: string
  /** The HMAC token carrying everything `finalizeAgentSession` needs (`./pending-session-token.ts`). */
  readonly pending: string
  /**
   * The read-back of the mandate this prepare is for, already rendered.
   *
   * It is returned here rather than recomputed by the caller for the same reason the read-back is not
   * paraphrased anywhere: it is the exact string the buyer will sign, and a second rendering is a second
   * thing that can disagree with the signature (D-040).
   */
  readonly readback: string
  /** UTC epoch seconds when the mandate this prepare is for expires. */
  readonly expiresAtEpochSec: number
}

/** What `finalizeAgentSession` takes from the browser after it has signed `signingInput`. */
export interface FinalizeAgentSessionInput {
  /** Whose session this is. The token must name the same buyer, or the token is refused. */
  readonly userId: UserId
  /** The `pending` token `prepareAgentSession` returned. */
  readonly pending: string
  /** The `prepareId` the prepare phase returned; must be the one the token names. */
  readonly prepareId: string
  /** ES256 over `signingInput`, raw P1363 r‖s, base64url — from the buyer's own device key. */
  readonly signatureB64Url: string
}

/**
 * Phase 1 of provisioning: everything up to and including `vi POST /v1/l2/prepare`.
 *
 * A fresh mandate per call is deliberate: each run gets its own mandate and budget, so a buyer can ask for
 * a second cap without the first reservation changing the answer. The cost is a handful of rows per run,
 * and the alternative — reusing a mandate — would make the second run fail with `GATE_BUDGET_EXCEEDED`
 * for a reason a viewer would misread as a bug.
 *
 * **The buyer is never created here (D-060).** The caller resolved the id from the session, and this
 * function refuses one that names no row rather than minting an account to match it.
 *
 * **The device is the buyer's own now, not a per-run fixture.** The key arrives in `input`, its
 * thumbprint is recomputed server-side (the browser's claim about its own key is verified, not
 * trusted), and `deviceKid` must be exactly `dev_<that thumbprint>`. The buyer's existing device row
 * for that thumbprint is reused when there is one — the browser holds the same non-extractable key
 * across sessions — and created (`Browser device`) when there is not. A reused device is also why
 * the L1 write is an upsert: `l1_credentials` is UNIQUE (device_id, wallet_id), and a second
 * provision from the same browser is a re-issue over the same pair (EC-KEY-2), not a conflict.
 *
 * Nothing is signed yet when this returns: the L2 signing input goes to the buyer's browser, and the
 * state `finalizeAgentSession` needs travels there inside the sealed `pending` token rather than in
 * any request body.
 */
export async function prepareAgentSession(
  input: PrepareAgentSessionInput,
): Promise<Result<PreparedAgentSession, CsError>> {
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
  // Resolved before any write, so a stale cookie cannot leave half a session behind.
  const found = await repository.findUserById(input.userId)
  if (!found.ok) return found
  const existingUser = found.value
  if (existingUser === undefined) {
    return err(
      csError(
        'CS_NOT_FOUND',
        'This session names a buyer that does not exist on this deployment.',
        undefined,
        { userMessage: 'Your session expired. Sign in again to get a new one.' },
      ),
    )
  }
  // A merchant or a judge is not a buyer: the mandate is the buyer's authority to spend, and signing one
  // against another persona's row would make the Gate's check 1 report a user who never approved it.
  if (existingUser.persona !== 'BUYER') {
    return err(
      csError(
        'CS_FORBIDDEN',
        `The signed-in account is a ${existingUser.persona}; a mandate belongs to a buyer.`,
        undefined,
        { userMessage: 'Sign in with the buyer account to create a mandate.' },
      ),
    )
  }

  const userId = existingUser.id as UserId
  const agentId = newId('agt') as AgentId
  const mandateId = newId('mdt') as MandateId
  const ttlSeconds = 24 * 60 * 60

  // --- The mandate's intent: compiled before any side effect, and refused if it is ambiguous --------
  //
  // §8.8: "Clarify before signing." A sentence with no stated limit ("something warm for the trip")
  // compiles to an `ambiguities` entry, and the compiler's own rule is that such a mandate is not ready
  // to sign. This runs **before** the key sync, the wallet/device/L1 work and vi's `l2/prepare`, so a
  // refusal produces no vi call and writes no row: an ambiguous intent never gets a mandate signed at the
  // client's default cap (the defect this step removes). The buyer answers in the chat and the client
  // re-compiles (`POST /api/intent/compile`); nothing about the compile itself changes here.
  const compiledResult = await compileIntent({ userId, text: input.intent })
  if (!compiledResult.ok) return err(compiledResult.error)
  const intentGate = assertNoAmbiguities(compiledResult.value)
  if (!intentGate.ok) return intentGate
  // The value the gate cleared; reused by the mandate build below rather than compiled twice (a second
  // compile could, in principle, answer differently and let the signed constraints drift from the ones the
  // gate inspected).
  const compiledIntent = compiledResult.value

  // --- 0. Mirror vi's public keys into our own table ------------------------------------------------
  //
  // The Gate's check 5 verifies the merchant's checkout JWT against `jwks_keys`, and vi generates its
  // keys at startup. Nothing else writes that table, so without this step every decision would block with
  // `VI_CHAIN_INVALID` — which is exactly the state this demo was in before the sync existed, and why it
  // is a provisioning step rather than a note. Idempotent by `kid`, and attempted **once per process**:
  // `GET /v1/jwks` is public and rate-limited to 30/min, and a 30-case measurement that re-synced per
  // session would spend its whole budget on a key set that only changes when vi restarts.
  if (!keysMirrored) {
    const synced = await syncViKeys(vi)
    if (synced.ok) {
      keysMirrored = true
    } else {
      // A failed refresh is only fatal when we have nothing to verify against. If the table already holds
      // a merchant key, the run continues on it and says so in the log; a demo must not die on a 429.
      const existing = await hasMerchantKey()
      if (!existing) return synced
    }
  }

  // --- 1. The wallet and the device key ------------------------------------------------------------
  //
  // The buyer row already exists and was read above: D-060 removed the "mint a user if the cookie is
  // absent" branch, which is what let a browser hold an identity nobody had authenticated for.
  //
  // The wallet is the buyer's real saved PayPal vault wallet (no placeholder is ever created). The
  // **device** is the buyer's own key from `input`: its thumbprint is recomputed here rather than
  // trusted from the browser, and `deviceKid` is refused unless it is exactly `dev_<that
  // thumbprint>` — a mismatched id would bind the L1 to a key that is not the one being verified
  // later. The row for that thumbprint is reused when the buyer already has one (the browser holds
  // the same non-extractable key across sessions), and created when there is none.
  const wallets = await repository.listWalletsForUser(userId)
  if (!wallets.ok) return wallets
  const active = pickActiveWallet(wallets.value)
  if (active === undefined) {
    return err(
      csError('CS_CONFLICT', 'The buyer has no saved PayPal payment method.', undefined, {
        userMessage: 'Save a PayPal payment method on the Wallet page first.',
      }),
    )
  }
  // The mandate, the L1 and the wallet cap all name the row that was resolved above.
  const resolvedWalletId = active.id as WalletId

  let jkt: string
  try {
    jkt = await deviceThumbprint(input.devicePublicJwk)
  } catch (cause) {
    return err(
      csError(
        'CS_VALIDATION',
        `The device public key could not be thumbprinted: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    )
  }
  if (input.deviceKid !== `dev_${jkt}`) {
    return err(
      csError(
        'CS_VALIDATION',
        'The device key id is not dev_<thumbprint> of the device public key it arrived with.',
        undefined,
        { userMessage: 'The device key does not match its id. Refresh the page and try again.' },
      ),
    )
  }
  const existingDevice = await repository.findDeviceByJkt(userId, jkt)
  if (!existingDevice.ok) return existingDevice
  let deviceId: DeviceId
  if (existingDevice.value !== undefined) {
    deviceId = existingDevice.value.id as DeviceId
  } else {
    deviceId = newId('dev') as DeviceId
    const device = await repository.createDevice({
      id: deviceId,
      user_id: userId,
      public_jwk: input.devicePublicJwk as never,
      jkt,
      label: 'Browser device',
    })
    if (!device.ok) return device
  }

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
      payer_id: active.payer_id,
      payer_email: active.payer_email,
      payment_token_id: active.payment_token_id,
    },
    device_public_jwk: input.devicePublicJwk as never,
    device_kid: input.deviceKid,
  })
  if (!issued.ok) return issued

  // An upsert, not a bare insert: a reused browser device may already hold an L1 for this wallet,
  // and re-issuing over the same (device, wallet) pair is EC-KEY-2's documented path — a second
  // provision converges on one credential instead of dying on the UNIQUE index.
  const l1 = await repository.upsertL1Credential({
    id: newId('l1') as never,
    user_id: userId,
    device_id: deviceId,
    wallet_id: resolvedWalletId,
    sd_jwt: issued.value.l1,
    issuer_kid: issued.value.issuer_kid,
    iat: BigInt(issued.value.iat),
    exp: BigInt(issued.value.exp),
  })
  if (!l1.ok) return l1

  // --- 4. The mandate: compiled above, capped, prepared ---------------------------------------------
  // The intent was compiled and cleared of ambiguities before any side effect; reuse that result here.
  const currencyOk = assertStoreCurrency(compiledIntent)
  if (!currencyOk.ok) return err(currencyOk.error)

  const finalConstraints = applyCap(compiledIntent.constraints, input.capMinor, merchant.value)

  const existingLineItems = finalConstraints.find(
    (c): c is Extract<VIConstraint, { type: 'mandate.checkout.line_items' }> =>
      c.type === 'mandate.checkout.line_items',
  )

  let itemList: { readonly id: string; readonly title: string }[]
  if (existingLineItems) {
    itemList = existingLineItems.items.flatMap((item) => item.acceptable_items)
  } else {
    const acceptable = await acceptableItemsFor(input.intent)
    if (!acceptable.ok) return acceptable
    itemList = acceptable.value
    finalConstraints.push({
      type: 'mandate.checkout.line_items',
      items: [{ id: 'intent-items', acceptable_items: [...itemList], quantity: 1 }],
      match_mode: 'minimum',
    })
  }

  // The vi-client's *input* shapes, derived from finalConstraints:
  // Types starting `mandate.checkout.` go to checkoutConstraints, `mandate.payment.` go to paymentConstraints.
  // Bigint amounts are converted with `toJsonSafe` (never `Number()`), and `min: null` is passed when a bound has no min.
  const checkoutConstraints: ViCheckoutConstraints = []
  const paymentConstraints: ViPaymentConstraints = []

  for (const c of finalConstraints) {
    if (c.type === 'mandate.checkout.allowed_merchants') {
      checkoutConstraints.push({
        type: 'mandate.checkout.allowed_merchants',
        allowed: c.allowed,
      })
    } else if (c.type === 'mandate.checkout.line_items') {
      checkoutConstraints.push({
        type: 'mandate.checkout.line_items',
        items: c.items,
        match_mode: c.match_mode,
      })
    } else if (c.type === 'mandate.payment.allowed_payees') {
      paymentConstraints.push({
        type: 'mandate.payment.allowed_payees',
        allowed: c.allowed,
      })
    } else if (c.type === 'mandate.payment.amount_range') {
      paymentConstraints.push({
        type: 'mandate.payment.amount_range',
        currency: c.currency,
        min: c.min !== undefined ? (toJsonSafe(c.min) as number) : null,
        max: c.max !== undefined ? (toJsonSafe(c.max) as number) : null,
      })
    } else if (c.type === 'mandate.payment.budget') {
      paymentConstraints.push({
        type: 'mandate.payment.budget',
        currency: c.currency,
        min: c.min !== undefined ? (toJsonSafe(c.min) as number) : null,
        max: toJsonSafe(c.max) as number,
      })
    } else if (c.type === 'mandate.payment.recurrence') {
      paymentConstraints.push({
        type: 'mandate.payment.recurrence',
        frequency: c.frequency,
        start_date: c.start_date,
        end_date: c.end_date ?? null,
        number: c.number ?? null,
      })
    } else if (c.type === 'mandate.payment.agent_recurrence') {
      paymentConstraints.push({
        type: 'mandate.payment.agent_recurrence',
        frequency: c.frequency,
        start_date: c.start_date,
        end_date: c.end_date,
        max_occurrences: c.max_occurrences ?? null,
      })
    }
  }

  const expiresAtEpochSec = Math.floor(nowMs / 1000) + ttlSeconds
  const compiled: CompiledMandate = {
    ...compiledIntent,
    constraints: finalConstraints,
    ttlSeconds,
    expiresAtEpochSec,
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
    device_kid: input.deviceKid,
    agent_public_jwk: minted.value.public_jwk as never,
    agent_kid: minted.value.kid,
    checkout_constraints: checkoutConstraints,
    payment_constraints: paymentConstraints,
    merchants: [merchant.value],
    acceptable_items: itemList,
    payment_instrument: {
      type: 'paypal_vault',
      id: issued.value.card_id,
      description: 'PayPal saved payment method',
    },
    nonce,
    aud,
    iss: aud,
    device_id: deviceId,
    prompt_summary: input.intent.slice(0, 2000),
  })
  if (!prepared.ok) return prepared

  // --- 5. Seal what phase 2 needs, and hand back the bytes the buyer signs --------------------------
  //
  // The mandate row does not exist yet: it is written by `finalizeAgentSession`, after vi has the
  // buyer's own signature over `signing_input`. Everything the write needs travels inside the token
  // — ids, L2 payload, constraints, the cap as a decimal string — so the second request needs
  // nothing from its caller but the signature and the token it was given.
  const pendingPayload: PendingAgentSession = {
    prepareId: prepared.value.prepare_id,
    mandateId,
    userId,
    deviceId,
    agentId,
    agentKid: minted.value.kid,
    walletId: resolvedWalletId,
    l2Payload: toJsonSafe(prepared.value.payload) as Record<string, unknown>,
    intent: input.intent,
    readback,
    constraints: toJsonSafe(finalConstraints) as unknown[],
    nonce,
    aud,
    capMinor: input.capMinor.toString(),
    compilerModel: compilerModelLabel(),
    expiresAtEpochSec,
    exp: Math.floor(systemClock.nowMs() / 1000) + PENDING_SESSION_TTL_SECONDS,
  }
  const pending = await signPendingSessionToken(pendingPayload)
  if (!pending.ok) return pending

  return {
    ok: true,
    value: {
      prepareId: prepared.value.prepare_id,
      signingInput: prepared.value.signing_input,
      pending: pending.value,
      readback,
      expiresAtEpochSec,
    },
  }
}

/**
 * Phase 2 of provisioning: the L2 signature arrives, and the mandate is written.
 *
 * The `pending` token is opened first — signature, then shape, then expiry, then buyer, then the
 * `prepareId` it was sealed for — because nothing in it is trusted state until it verifies; a token
 * that fails any of those is refused with `CS_VALIDATION` (or `CS_FORBIDDEN` when it names another
 * buyer or another prepare record), never a throw. What binds the token to this call's L2 signature
 * is those two facts together: the token was issued to `input.userId` for `pending.prepareId`, and
 * `input.prepareId` must be the id the token names, so a token cannot be spent against a prepare
 * record it was not minted for. vi then verifies the signature against its own stored prepare record
 * before any row is written.
 *
 * vi returns the finished L2; the
 * mandate row is then written from the token's ids and payload, with `iat`/`exp` from vi's response,
 * and the budget and wallet cap follow. The returned `AgentSession` is the same shape phase 1's
 * wrapper always reported.
 */
export async function finalizeAgentSession(
  input: FinalizeAgentSessionInput,
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
  const vi = createViClient(config)

  const verified = await verifyPendingSessionToken(input.pending, { userId: input.userId })
  if (!verified.ok) return verified
  const pending = verified.value

  // The token names the prepare record it was sealed for, and this call must name the same one. A
  // token from one prepare handed a `prepareId` from another is refused before vi is called: the
  // signature would be checked against a record this token says nothing about, and the mandate would
  // be written under ids from the wrong run. `CS_FORBIDDEN` because the token itself is valid — this
  // caller is simply not the one it was issued to, the same distinction a wrong buyer draws.
  if (pending.prepareId !== input.prepareId) {
    return err(
      csError(
        'CS_FORBIDDEN',
        'The pending session token names a different prepare record than the one this request finalises.',
        undefined,
        {
          userMessage:
            'That pending session does not match this request. Start again from the beginning.',
        },
      ),
    )
  }

  const finalized = await vi.finalizeL2({
    prepare_id: input.prepareId,
    signature_b64url: input.signatureB64Url,
  })
  if (!finalized.ok) return finalized

  const iat = finalized.value.iat
  const exp = finalized.value.exp ?? pending.expiresAtEpochSec
  const nowMs = systemClock.nowMs()

  const mandate = await repository.createMandate({
    id: pending.mandateId,
    user_id: pending.userId,
    device_id: pending.deviceId,
    agent_id: pending.agentId,
    wallet_id: pending.walletId,
    l2_serialized: finalized.value.l2,
    l2_payload: pending.l2Payload as never,
    nl_intent: pending.intent,
    readback: pending.readback,
    constraints: pending.constraints as never,
    nonce: pending.nonce,
    aud: pending.aud,
    iat: BigInt(iat),
    exp: BigInt(exp),
    status: 'ACTIVE',
    compiler_model: pending.compilerModel,
  })
  if (!mandate.ok) return mandate

  const cap = money(BigInt(pending.capMinor), 'USD')
  const budget = await repository.openBudget({
    mandateId: pending.mandateId,
    cap,
  })
  if (!budget.ok) return budget

  const walletCap = await repository.setWalletCap(pending.walletId, 'MONTH', cap)
  if (!walletCap.ok) return walletCap

  return {
    ok: true,
    value: {
      userId: pending.userId,
      walletId: pending.walletId,
      deviceId: pending.deviceId,
      agentId: pending.agentId,
      mandateId: pending.mandateId,
      readback: pending.readback,
      agentKid: pending.agentKid,
      expiresAtEpochSec: exp,
      createdAtEpochSec: new Date(nowMs).getUTCSeconds(),
    },
  }
}

/**
 * Provision one buyer session: the two phases back to back, with the demo's own server-held key.
 *
 * The real flow replaces only the middle of this function: `prepareAgentSession` is called with the
 * browser's public key, the *browser* signs `signingInput` with its non-extractable key, and
 * `finalizeAgentSession` receives that signature. Here the signing happens on the server against
 * `./demo-device.ts`'s per-call key — real bytes, real signature, fixture custody — so every
 * downstream verifier behaves exactly as the real flow's would.
 *
 * The demo gate is checked here exactly as it always was, and again inside each phase, so a future
 * caller that skips this wrapper is still gated.
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
  const deviceKey = await createDemoDeviceKey()
  const prepared = await prepareAgentSession({
    userId: input.userId,
    intent: input.intent,
    capMinor: input.capMinor,
    devicePublicJwk: deviceKey.publicJwk,
    deviceKid: deviceKey.kid,
  })
  if (!prepared.ok) return prepared
  const signature = await deviceKey.sign(prepared.value.signingInput)
  return finalizeAgentSession({
    userId: input.userId,
    pending: prepared.value.pending,
    prepareId: prepared.value.prepareId,
    signatureB64Url: signature,
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Key mirroring                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** The roles `jwks_keys` accepts. vi's own role strings are a subset; anything else is skipped, not guessed. */
const KNOWN_ROLES = new Set(['ISSUER', 'MERCHANT', 'AGENT', 'GATE'])
const KNOWN_STATUS = new Set(['ACTIVE', 'RETIRED', 'COMPROMISED'])

/** Per-process cache: see the note at the call site about vi's 30/min public rate limit. */
let keysMirrored = false

/** `true` when `jwks_keys` already holds a usable merchant key, so a failed refresh is survivable. */
async function hasMerchantKey(): Promise<boolean> {
  try {
    const rows = await db().select({ kid: jwksKeys.kid }).from(jwksKeys).limit(20)
    return rows.length > 0
  } catch {
    return false
  }
}

/**
 * Copy `GET /v1/jwks` into `jwks_keys`.
 *
 * Public keys only — `jwks_keys.public_jwk` is a public half by definition, and vi is the only holder of a
 * private one. Idempotent by `kid`, so calling it per session costs one upsert per key and never
 * duplicates. An entry whose role or status this table does not know is **skipped** rather than coerced:
 * a role mismatch here would silently change which key the Gate trusts.
 *
 * The write is inline rather than a repository function because `@countersign/db` has no `jwks_keys`
 * repository yet (the read path in `gate-runtime.ts` is a plain `db().select()` for the same reason).
 * Adding one to another work package's package would be the wrong move for a demo step; if a second
 * caller appears, that is the moment to move it.
 */
export async function syncViKeys(
  vi: ViClient = createViClientOrThrow(),
): Promise<Result<number, CsError>> {
  const response = await vi.jwks()
  if (!response.ok) return response
  let written = 0
  for (const entry of response.value.keys) {
    const kid = entry['kid']
    const role = entry['role']
    if (typeof kid !== 'string' || kid === '') continue
    if (typeof role !== 'string' || !KNOWN_ROLES.has(role)) continue
    const status =
      typeof entry['status'] === 'string' && KNOWN_STATUS.has(entry['status'])
        ? entry['status']
        : 'ACTIVE'
    const publicJwk = Object.fromEntries(
      Object.entries(entry).filter(
        ([key]) => !['role', 'status', 'owner_id', 'not_before', 'retired_at'].includes(key),
      ),
    )
    try {
      await db()
        .insert(jwksKeys)
        .values({
          kid,
          role: role as 'ISSUER' | 'MERCHANT' | 'GATE' | 'AGENT',
          public_jwk: publicJwk as never,
          status: status as 'ACTIVE' | 'RETIRED' | 'COMPROMISED',
          not_before: new Date(),
        })
        .onConflictDoUpdate({
          target: jwksKeys.kid,
          set: {
            role: role as 'ISSUER' | 'MERCHANT' | 'GATE' | 'AGENT',
            public_jwk: publicJwk as never,
            status: status as 'ACTIVE' | 'RETIRED' | 'COMPROMISED',
            updated_at: new Date(),
          },
        })
    } catch (cause) {
      return err(
        csError(
          'CS_INTERNAL',
          `Could not mirror the key ${kid} into jwks_keys: ${describe(cause)}`,
        ),
      )
    }
    written += 1
  }
  return { ok: true, value: written }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return typeof cause === 'string' ? cause : 'unknown database failure'
}

/* ------------------------------------------------------------------------------------------ */
/* The demo's catalog projection                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * The items a buyer's sentence covers, as `{id, title}` entries the mandate can name.
 *
 * A literal keyword match over the merchant catalog: the buyer's content words, any of which appears in
 * an item's title, SKU or description. No stemming, no synonyms, no model — and it **fails** rather than
 * widening when nothing matches, because a mandate with no items authorises nothing and a mandate with
 * *every* item would be a silent over-grant.
 *
 * The real product does this with `@countersign/compiler`, whose catalog projection maps a model's
 * proposal onto SKUs and is re-validated against the catalog (spec §8.8). This function exists because S-10
 * provisions a session from a sentence with no signing UI in front of it; it is deliberately small enough
 * to read in one sitting, and the read-back prints its output.
 */
export async function acceptableItemsFor(
  intent: string,
): Promise<Result<{ readonly id: string; readonly title: string }[], CsError>> {
  const listed = await repository.listProducts()
  if (!listed.ok) return listed
  // USD only: this demo's mandate is denominated in USD, and a JPY entry in a list of authorised items is
  // a currency question the mandate does not answer (EC-FX-1: never convert).
  const catalog = listed.value.filter((product) => product.currency === 'USD')
  const words = contentWords(intent)
  const matches = catalog.filter((product) => {
    const haystack = `${product.title} ${product.sku} ${product.description}`.toLowerCase()
    return words.some((word) => haystack.includes(word))
  })
  if (matches.length === 0) {
    return err(
      csError(
        'CS_NOT_FOUND',
        `Nothing in the Northwind catalog matches "${intent}", so there is no item to authorise.`,
        undefined,
        { userMessage: 'I could not find anything in the catalog matching that request.' },
      ),
    )
  }
  // Bounded so a one-word intent cannot authorise the entire catalog in one entry.
  return {
    ok: true,
    value: matches.slice(0, 25).map((product) => ({ id: product.sku, title: product.title })),
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
          // The items the buyer actually authorised, read from the signed mandate's own `line_items`
          // entry. `read_my_mandate` reports them and the lawful shopper only buys from them — vi enforces
          // the same list at `l3/create`, so an agent that ignored this list would simply be refused
          // later, with a worse error.
          acceptableItems: acceptableItemsOf(constraints),
          expiresAtEpochSec: Number(row.exp),
        },
      }
    },
  }
}

/** Every `{id, title}` an `line_items` constraint names, de-duplicated by id. */
function acceptableItemsOf(constraints: readonly VIConstraint[]): { id: string; title: string }[] {
  const items = new Map<string, string>()
  for (const constraint of constraints) {
    if (constraint.type !== 'mandate.checkout.line_items') continue
    for (const requirement of constraint.items) {
      for (const item of requirement.acceptable_items) items.set(item.id, item.title)
    }
  }
  return [...items.entries()].map(([id, title]) => ({ id, title }))
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
