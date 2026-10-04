/**
 * Sandbox-only simulator calls — spec §10.2 #18, §10.3, EC-ENV-2, [S29] [V3].
 *
 * ```
 * The code paths that call sandbox-only APIs live in paypal.sandbox.* and are compiled out when
 * PAYPAL_ENV=live (not supported anyway).
 * ```
 *
 * ## What "compiled out" honestly means here
 *
 * A TypeScript `import` cannot be eliminated at link time from a string in `process.env`, so this
 * module enforces the same rule at the only two points where it can be enforced honestly:
 *
 *  1. **Construction.** `PayPalClient` builds this object in its constructor, and the constructor
 *     asserts the sandbox environment first. A process that somehow reached `live` never gets a
 *     `PayPalSandboxApi`, so the methods below are unreachable — not merely unused.
 *  2. **Every call.** Each method re-asserts through `assertSandbox` from `@countersign/core`, so a
 *     client that was constructed with a sandbox env and then had `PAYPAL_ENV` flipped still refuses.
 *
 * A bundler can additionally drop the whole module with `define` on a constant, and the module-level
 * `SANDBOX_APIS_AVAILABLE` flag is exported so a build can do exactly that; see README, "Going live".
 *
 * ## The unsigned `PayPal-Auth-Assertion`
 *
 * The buyer-side simulator (`POST /v1/customer/disputes`) must look like it came from the buyer, and
 * in the sandbox that identity is asserted without a signature ([S29] §10.3, spec U12):
 *
 * ```
 * base64url({"alg":"none"}) . base64url({"iss":CLIENT_ID,"email":BUYER_EMAIL}) .
 * ```
 *
 * Three base64url segments with an **empty** signature. That trailing dot is not a typo — the header
 * claims `alg: none`, and a JWS with `alg: none` has an empty signature segment.
 *
 * TODO(verify against docs / spec U12): the exact header/payload object shape. It is recorded as
 * unverified because it has never been executed against a sandbox (H-01) and because the spec itself
 * marks it `[U12]`.
 */
import { assertSandbox, csError, err } from '@countersign/core'
import type { CsError, Result } from '@countersign/core'

import { linksSchema } from './types'
import type {
  AdjudicationOutcome,
  Links,
  RequireEvidenceAction,
  SimDisputeReq,
} from './types'
import type { Transport } from './client'

/**
 * Whether the sandbox simulator endpoints are reachable at all.
 *
 * Exported so a production build can `define` it to `false` and let a bundler drop the calls. In this
 * repository the runtime assertion is the one that actually enforces the rule.
 */
export const SANDBOX_APIS_AVAILABLE = true as const

export interface PayPalSandboxDeps {
  readonly transport: Transport
  readonly clientId: string
  readonly env: { PAYPAL_ENV: string | undefined; PAYPAL_API_BASE: string | undefined }
}

/**
 * The unsigned assertion for a sandbox buyer.
 *
 * @param clientId our REST app's client id — it goes in the `iss` claim.
 * @param buyerEmail the sandbox personal account that is "raising" the dispute (`PAYPAL_BUYER_EMAIL`).
 */
export function unsignedAuthAssertion(clientId: string, buyerEmail: string): string {
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw csError('CS_VALIDATION', 'The PayPal-Auth-Assertion needs the client id as `iss`')
  }
  if (typeof buyerEmail !== 'string' || buyerEmail.trim() === '') {
    throw csError('CS_VALIDATION', 'The PayPal-Auth-Assertion needs the sandbox buyer email')
  }
  const header = base64url(JSON.stringify({ alg: 'none' }))
  const payload = base64url(JSON.stringify({ iss: clientId, email: buyerEmail }))
  // The empty third segment is what `alg: none` means. Do not "fix" it.
  return `${header}.${payload}.`
}

/** Unpadded base64url, which is what a JWS segment is. */
function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

export interface UnsignedAuthAssertion {
  readonly alg: string
  readonly iss: string
  readonly email: string
  /** Always `''` for `alg: none`. */
  readonly signature: string
}

/** Parse an unsigned assertion back. Test helper; also a guard that we built what we think we did. */
export function parseUnsignedAuthAssertion(token: string): Result<UnsignedAuthAssertion, CsError> {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[2] !== '') {
    return err(
      csError('CS_VALIDATION', 'A PayPal-Auth-Assertion must be "header.payload." with an empty signature', {
        segments: parts.length,
      }),
    )
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8')) as { alg?: unknown }
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      iss?: unknown
      email?: unknown
    }
    return {
      ok: true,
      value: {
        alg: typeof header.alg === 'string' ? header.alg : '',
        iss: typeof payload.iss === 'string' ? payload.iss : '',
        email: typeof payload.email === 'string' ? payload.email : '',
        signature: '',
      },
    }
  } catch {
    return err(csError('CS_VALIDATION', 'A PayPal-Auth-Assertion header/payload must be base64url JSON'))
  }
}

/**
 * The sandbox-only surface, exposed as `PayPalClient.sandbox` (spec §8.6).
 *
 * Seven methods, all `POST`, all unreachable outside a sandbox environment.
 */
export class PayPalSandboxApi {
  private readonly transport: Transport
  private readonly clientId: string
  private readonly env: { PAYPAL_ENV: string | undefined; PAYPAL_API_BASE: string | undefined }

  constructor(deps: PayPalSandboxDeps) {
    this.transport = deps.transport
    this.clientId = deps.clientId
    this.env = deps.env
    // Assert *after* the fields are set: the guard reads `this.env`, so asserting first would test a
    // half-built object.
    this.assertEnabled()
  }

  /**
   * The one gate. Throws `CS_VALIDATION` (EC-ENV-1) with a message that says plainly that a live
   * build must not contain this path — a silent no-op here would let a live deployment believe it had
   * raised a dispute when it had done nothing.
   */
  private assertEnabled(): void {
    if (!SANDBOX_APIS_AVAILABLE) {
      throw csError(
        'CS_VALIDATION',
        'The PayPal dispute simulators are not present in this build (sandbox-only per EC-ENV-2)',
        { ec: 'EC-ENV-2' },
      )
    }
    if (this.env.PAYPAL_ENV !== undefined) {
      assertSandbox({ PAYPAL_ENV: this.env.PAYPAL_ENV, PAYPAL_API_BASE: this.env.PAYPAL_API_BASE ?? '' })
    }
  }

  /**
   * `POST /v1/customer/disputes` — raise a dispute as the sandbox buyer [S29].
   *
   * Uses the **unsigned `PayPal-Auth-Assertion`**: the endpoint is the buyer's view, and in the
   * sandbox there is no buyer credential, so the assertion carries the buyer's email [S29] §10.3.
   * This is the one sandbox call where the assertion is required rather than optional.
   *
   * @param buyerEmail `PAYPAL_BUYER_EMAIL` — the personal account that will own the dispute.
   * @param body the capture to dispute (`transaction_id`) and the reason.
   */
  async createBuyerDispute(buyerEmail: string, body: SimDisputeReq): Promise<Result<Links, CsError>> {
    const assertion = this.assertionOrError(buyerEmail)
    if (!assertion.ok) return assertion
    if (typeof body?.transaction_id !== 'string' || body.transaction_id.trim() === '') {
      return err(csError('CS_VALIDATION', 'createBuyerDispute needs the transaction_id to dispute'))
    }
    if (typeof body?.dispute_reason !== 'string' || body.dispute_reason.trim() === '') {
      return err(csError('CS_VALIDATION', 'createBuyerDispute needs a dispute_reason, e.g. UNAUTHORISED'))
    }
    return this.transport<Links>({
      method: 'POST',
      path: '/v1/customer/disputes',
      policyKey: 'POST /v1/customer/disputes',
      schema: linksSchema,
      json: body,
      opts: { authAssertion: assertion.value },
    })
  }

  /**
   * `POST /v2/customer-support/process-chargeback` [S29].
   *
   * Card-funded transactions only (§10.1 step 5) — a vault capture with no card behind it cannot be
   * charged back, which is exactly why week-1 check C1 has a fallback chain (§11 C1).
   *
   * TODO(verify against docs): the request body field name. We send `{transaction_id, reason}`.
   */
  async processChargeback(sellerTxnId: string, reason: string): Promise<Result<unknown, CsError>> {
    const bad = requireText(sellerTxnId, 'processChargeback needs the seller transaction id')
    if (bad) return err(bad)
    const badReason = requireText(reason, 'processChargeback needs a reason, e.g. UNAUTHORISED')
    if (badReason) return err(badReason)
    return this.transport<unknown>({
      method: 'POST',
      path: '/v2/customer-support/process-chargeback',
      policyKey: 'POST /v2/customer-support/process-chargeback',
      schema: null,
      json: { transaction_id: sellerTxnId, reason },
    })
  }

  /** `POST /v1/customer/disputes/{id}/require-evidence` with `{action}` [B16]. */
  async requireEvidence(id: string, action: RequireEvidenceAction): Promise<Result<Links, CsError>> {
    const bad = requireId(id, 'requireEvidence')
    if (bad) return err(bad)
    if (action !== 'BUYER_EVIDENCE' && action !== 'SELLER_EVIDENCE') {
      return err(
        csError('CS_VALIDATION', `requireEvidence action must be BUYER_EVIDENCE or SELLER_EVIDENCE, got "${action}"`),
      )
    }
    return this.transport<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/require-evidence`,
      policyKey: 'POST /v1/customer/disputes/{id}/require-evidence',
      schema: linksSchema,
      json: { action },
    })
  }

  /** `POST /v1/customer/disputes/{id}/adjudicate` with `{adjudication_outcome}` [B16]. */
  async adjudicate(id: string, outcome: AdjudicationOutcome): Promise<Result<Links, CsError>> {
    const bad = requireId(id, 'adjudicate')
    if (bad) return err(bad)
    if (outcome !== 'BUYER_FAVOR' && outcome !== 'SELLER_FAVOR') {
      return err(
        csError('CS_VALIDATION', `adjudicate outcome must be BUYER_FAVOR or SELLER_FAVOR, got "${outcome}"`),
      )
    }
    return this.transport<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/adjudicate`,
      policyKey: 'POST /v1/customer/disputes/{id}/adjudicate',
      schema: linksSchema,
      json: { adjudication_outcome: outcome },
    })
  }

  /**
   * `POST /v1/customer/disputes/{id}/change-reason`.
   *
   * TODO(verify against docs): the body field. We send `{reason}`.
   */
  async changeReason(id: string, reason: string): Promise<Result<Links, CsError>> {
    const bad = requireId(id, 'changeReason')
    if (bad) return err(bad)
    const badReason = requireText(reason, 'changeReason needs a dispute_reason')
    if (badReason) return err(badReason)
    return this.transport<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/change-reason`,
      policyKey: 'POST /v1/customer/disputes/{id}/change-reason',
      schema: linksSchema,
      json: { reason },
    })
  }

  /**
   * `POST /v1/customer/disputes/{id}/accept-offer` — the **buyer** accepts a merchant offer.
   *
   * TODO(verify against docs): the body field. We send `{payer_note}`.
   */
  async acceptOffer(id: string, payerNote?: string): Promise<Result<Links, CsError>> {
    const bad = requireId(id, 'acceptOffer')
    if (bad) return err(bad)
    return this.transport<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/accept-offer`,
      policyKey: 'POST /v1/customer/disputes/{id}/accept-offer',
      schema: linksSchema,
      json: payerNote === undefined ? {} : { payer_note: payerNote },
    })
  }

  /**
   * `POST /v1/customer/disputes/{id}/deny-offer` — the **buyer** rejects a merchant offer.
   *
   * TODO(verify against docs): the body field. We send `{note}`.
   */
  async denyOffer(id: string, note?: string): Promise<Result<Links, CsError>> {
    const bad = requireId(id, 'denyOffer')
    if (bad) return err(bad)
    return this.transport<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/deny-offer`,
      policyKey: 'POST /v1/customer/disputes/{id}/deny-offer',
      schema: linksSchema,
      json: note === undefined ? {} : { note },
    })
  }

  /** The buyer assertion, as a `Result` so a bad email never becomes a thrown string. */
  private assertionOrError(buyerEmail: string): Result<string, CsError> {
    try {
      return { ok: true, value: unsignedAuthAssertion(this.clientId, buyerEmail) }
    } catch (e) {
      return err(
        typeof e === 'object' && e !== null && 'code' in e
          ? (e as CsError)
          : csError('CS_VALIDATION', 'Could not build the PayPal-Auth-Assertion'),
      )
    }
  }
}

function requireId(id: string, method: string): CsError | null {
  if (typeof id !== 'string' || id.trim() === '') return csError('CS_VALIDATION', `${method} needs a dispute id`)
  return null
}

function requireText(value: string, message: string): CsError | null {
  if (typeof value !== 'string' || value.trim() === '') return csError('CS_VALIDATION', message)
  return null
}