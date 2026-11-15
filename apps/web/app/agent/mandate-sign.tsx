/**
 * The buyer's browser signs the mandate — commit 3b of `docs/plans/agent-real-path.md`.
 *
 * The three steps, in order, and why each one is where it is:
 *
 *  1. **Prepare** (`POST /api/agent/mandate/prepare`). The server compiles the buyer's sentence, refuses
 *     an ambiguous one (`CS_VALIDATION` with the compiler's own question in `userMessage`), and returns
 *     the exact `signingInput` bytes for this device key. A non-2xx here means **nothing is signed**:
 *     the refusal (an open question, no wallet, a lost device) is surfaced and the flow stops.
 *  2. **Step up** (`stepUp`). A passkey ceremony whose challenge is the `signingInput` itself. A `null`
 *     assertion means the ceremony was cancelled or is unavailable — the lab's rule applies unchanged:
 *     **do not sign** (this plan, §b.4; `lab/device-sign/page.tsx:200`–`:204`).
 *  3. **Sign and finalize.** `signSigningInput` signs the exact `signingInput` string, byte for byte —
 *     a re-encoded copy would verify against nothing (`vi-client`'s note on `signing_input`) — and
 *     `POST /api/agent/mandate/finalize` writes the mandate. The finalized session (ids, read-back) is
 *     what the chat renders; the `pending` token is spent and is not handed back.
 *
 * The results are a discriminated union, not thrown strings: every caller needs to distinguish "the
 * server refused, here is its question" from "the buyer cancelled" from "the network died", and a
 * single `message: string` would erase exactly the distinctions the buyer needs to act on.
 */
import type { UserId } from '@countersign/core'

import { getOrCreateDeviceKey, signSigningInput, type DeviceKey } from '@/lib/browser-keystore'
import { stepUp } from '@/lib/webauthn'

/** The session shape `POST /api/agent/session` returns; finalize returns the same fields minus the cap. */
export interface SignedMandate {
  readonly userId: string
  readonly mandateId: string
  readonly agentId: string
  readonly agentKid: string
  readonly readback: string
  readonly readbackSummary: string
  readonly expiresAtEpochSec: number
}

/** What the chat shows the buyer between prepare and the passkey prompt. */
export interface PreparedMandateView {
  readonly readbackSummary: string
  readonly capDisplay: string
  readonly expiresAtEpochSec: number
}

export type SignMandateResult =
  | { readonly ok: true; readonly session: SignedMandate }
  /**
   * The server refused, with its own buyer-safe sentence — the ambiguity question, "save a payment
   * method first", a signature that did not verify. The buyer can act on it (answer the question, go
   * to the wallet, reload), so it is rendered, not swallowed.
   */
  | { readonly ok: false; readonly reason: 'refused'; readonly userMessage: string }
  /** The passkey ceremony was cancelled or unavailable: nothing was signed, and the copy says so. */
  | { readonly ok: false; readonly reason: 'cancelled'; readonly userMessage: string }
  /** The request never reached the server (offline, DNS, a tab closed mid-flight). */
  | { readonly ok: false; readonly reason: 'network'; readonly userMessage: string }

export interface SignMandateInput {
  readonly userId: UserId
  /** The buyer's own words; become the mandate's `nl_intent` and the read-back's first line. */
  readonly intent: string
  /** The per-purchase cap in minor units, as the chat's select holds it. A ceiling only. */
  readonly capMinor: bigint
  /** Called with the prepare read-back once the server accepts it, **before** the passkey prompt. */
  readonly onPrepared?: (prepared: PreparedMandateView) => void
}

const MAX_INTENT_CHARS = 200
/** The prepare route's own ceiling (§8.0's "bound every wire input"), in minor units. */
const MAX_CAP_MINOR = 1_000_000_000n

interface PrepareResponseBody {
  prepareId?: unknown
  signingInput?: unknown
  readback?: unknown
  readback_summary?: unknown
  cap_display?: unknown
  expires_at_epoch_sec?: unknown
  pending?: unknown
  error?: { code?: unknown; message?: unknown; userMessage?: unknown }
}

interface FinalizeResponseBody {
  user_id?: unknown
  mandate_id?: unknown
  agent_id?: unknown
  agent_kid?: unknown
  readback?: unknown
  readback_summary?: unknown
  expires_at_epoch_sec?: unknown
  error?: { code?: unknown; message?: unknown; userMessage?: unknown }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The buyer-safe sentence from a `CsErrorBody`, falling back to the HTTP status. */
function userMessageFrom(body: unknown, status: number, what: string): string {
  const parsed = body as { error?: { userMessage?: unknown } } | null
  const message = parsed?.error?.userMessage
  if (typeof message === 'string' && message.trim() !== '') {
    return message
  }
  return `The ${what} route answered HTTP ${status}. Nothing was signed.`
}

/**
 * The full buyer-side signing flow: prepare -> step-up -> sign -> finalize.
 *
 * Signs nothing on any refusal: a prepare 4xx (the ambiguity question among them) returns before
 * `stepUp` is ever called, and a cancelled or failed ceremony returns before `signSigningInput` is
 * ever called. The `signingInput` the server prepared is the exact string signed.
 */
export async function signMandate(input: SignMandateInput): Promise<SignMandateResult> {
  const { userId, intent, capMinor, onPrepared } = input

  if (intent.trim() === '' || intent.length > MAX_INTENT_CHARS) {
    return {
      ok: false,
      reason: 'refused',
      userMessage: 'Say what you want the agent to buy before creating a mandate.',
    }
  }
  if (capMinor <= 0n || capMinor > MAX_CAP_MINOR) {
    return {
      ok: false,
      reason: 'refused',
      userMessage: 'The signed cap is not a whole number of cents this deployment accepts.',
    }
  }

  // --- 1. The browser's own key, created on first use ----------------------------------------------
  let deviceKey: DeviceKey
  try {
    deviceKey = await getOrCreateDeviceKey(userId)
  } catch (cause) {
    return {
      ok: false,
      reason: 'network',
      userMessage: `This browser could not create its signing key (${describeError(cause)}).`,
    }
  }

  // --- 2. Prepare: the server compiles the sentence and hands back the exact bytes -------------------
  // The prepare route's zod schema takes `cap_minor` as a JSON number of integer minor units
  // (`route.ts:58`), and a bigint cannot be serialised into JSON. The cap is validated above as an
  // integer at or below 1e9, so this single boundary conversion is exact — no float ever exists.
  const capMinorWire = Number.parseInt(capMinor.toString(), 10)

  let prepareBody: PrepareResponseBody
  let prepareStatus: number
  try {
    const response = await fetch('/api/agent/mandate/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intent,
        cap_minor: capMinorWire,
        deviceKid: deviceKey.kid,
        devicePublicJwk: deviceKey.publicJwk,
      }),
    })
    prepareStatus = response.status
    prepareBody = (await response.json()) as PrepareResponseBody
  } catch (cause) {
    return {
      ok: false,
      reason: 'network',
      userMessage: `The prepare request could not reach the server (${describeError(cause)}). Nothing was signed.`,
    }
  }
  if (prepareStatus < 200 || prepareStatus >= 300) {
    // The server's own `userMessage` is the answer: the ambiguity question, the missing wallet, the
    // lost device. It is rendered as-is (never paraphrased here) and the flow stops.
    return {
      ok: false,
      reason: 'refused',
      userMessage: userMessageFrom(prepareBody, prepareStatus, 'prepare'),
    }
  }

  const { prepareId, signingInput, pending } = prepareBody
  if (
    typeof prepareId !== 'string' ||
    prepareId === '' ||
    typeof signingInput !== 'string' ||
    signingInput === '' ||
    typeof pending !== 'string' ||
    pending === ''
  ) {
    return {
      ok: false,
      reason: 'refused',
      userMessage: 'The prepare response did not match the mandate contract. Nothing was signed.',
    }
  }
  if (onPrepared !== undefined) {
    const readbackSummary = prepareBody.readback_summary
    const capDisplay = prepareBody.cap_display
    const expiresAt = prepareBody.expires_at_epoch_sec
    if (
      typeof readbackSummary === 'string' &&
      typeof capDisplay === 'string' &&
      typeof expiresAt === 'number'
    ) {
      onPrepared({ readbackSummary, capDisplay, expiresAtEpochSec: expiresAt })
    }
  }

  // --- 3. The passkey ceremony over the exact signing input -------------------------------------------
  let assertion
  try {
    assertion = await stepUp(userId, signingInput)
  } catch (cause) {
    return {
      ok: false,
      reason: 'cancelled',
      userMessage: `Confirmation with your passkey failed (${describeError(cause)}). Nothing was signed.`,
    }
  }
  if (assertion === null) {
    return {
      ok: false,
      reason: 'cancelled',
      userMessage: 'Confirmation with your passkey was cancelled — nothing was signed.',
    }
  }

  // --- 4. Sign the exact bytes the server prepared ------------------------------------------------------
  let signatureB64Url: string
  try {
    signatureB64Url = await signSigningInput(deviceKey.kid, signingInput)
  } catch (cause) {
    return {
      ok: false,
      reason: 'network',
      userMessage: `This browser could not sign the mandate (${describeError(cause)}). Nothing was sent.`,
    }
  }

  // --- 5. Finalize: the signature is verified by vi before a single row is written ----------------------
  let finalizeBody: FinalizeResponseBody
  let finalizeStatus: number
  try {
    const response = await fetch('/api/agent/mandate/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending, prepareId, signatureB64Url }),
    })
    finalizeStatus = response.status
    finalizeBody = (await response.json()) as FinalizeResponseBody
  } catch (cause) {
    return {
      ok: false,
      reason: 'network',
      userMessage: `The finalize request could not reach the server (${describeError(cause)}). Nothing was signed.`,
    }
  }
  if (finalizeStatus < 200 || finalizeStatus >= 300) {
    return {
      ok: false,
      reason: 'refused',
      userMessage: userMessageFrom(finalizeBody, finalizeStatus, 'finalize'),
    }
  }

  if (
    typeof finalizeBody.user_id !== 'string' ||
    typeof finalizeBody.mandate_id !== 'string' ||
    typeof finalizeBody.agent_id !== 'string' ||
    typeof finalizeBody.agent_kid !== 'string' ||
    typeof finalizeBody.readback !== 'string' ||
    typeof finalizeBody.readback_summary !== 'string' ||
    typeof finalizeBody.expires_at_epoch_sec !== 'number'
  ) {
    return {
      ok: false,
      reason: 'refused',
      userMessage: 'The finalize response did not match the mandate contract.',
    }
  }

  return {
    ok: true,
    session: {
      userId: finalizeBody.user_id,
      mandateId: finalizeBody.mandate_id,
      agentId: finalizeBody.agent_id,
      agentKid: finalizeBody.agent_kid,
      readback: finalizeBody.readback,
      readbackSummary: finalizeBody.readback_summary,
      expiresAtEpochSec: finalizeBody.expires_at_epoch_sec,
    },
  }
}

/** The `devicePublicJwk` payload shape the prepare route's schema expects (re-exported for callers). */
export type { DeviceKey }
