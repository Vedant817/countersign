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
 * base64url({"alg":"none","typ":"JWT"}) . base64url({"iss":CLIENT_ID,"email":BUYER_EMAIL}) .
 * ```
 *
 * Three base64url segments with an **empty** signature. That trailing dot is not a typo — the header
 * claims `alg: none`, and a JWS with `alg: none` has an empty signature segment. PayPal's own page
 * emits that trailing dot, and `SPEC-P` carries the unsigned form in its own header example.
 *
 * The `typ: "JWT"` is included because PayPal's snippet includes it (report §31/#25). A JWS `alg: none`
 * header is *supposed* to be `{"alg":"none"}` on its own, so this is very unlikely to matter — but
 * matching the documented form exactly costs nothing and removes a difference to explain.
 *
 * Still unverified by execution: it has never been run against a sandbox (`docs/HUMAN_TODO.md` H-01).
 * Two prerequisites also block it and are **not** things an agent can do: the REST app needs the
 * `DISPUTE_CREATE` (`…/services/disputes/create`) and `UPDATE_BUYER` (`…/services/disputes/update-buyer`)
 * scopes from the account manager, and the buyer must complete an interactive "Log in with PayPal"
 * consent flow first. A sandbox probe cannot skip that consent step.
 *
 * ## Which encoding each simulator takes
 *
 * These bodies were wrong in a way only a live call would have exposed, so the encoding is spelled out
 * per method rather than left implicit (report §1/#1, §27/#2, §30/#13).
 */
import { assertSandbox, csError, err } from '@countersign/core'
import type { CsError, Result } from '@countersign/core'

import { buildEvidenceForm } from './multipart'
import {
  changeReasonReqSchema,
  linksSchema,
  processChargebackReqSchema,
  processChargebackResSchema,
  simDisputeReqSchema,
} from './types'
import type {
  AdjudicationOutcome,
  ChangeReasonReq,
  Links,
  PPMoney,
  ProcessChargebackRes,
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
  // `typ: "JWT"` is in PayPal's documented snippet (set-up page, report §31). A minimal JWS header
  // would be `{"alg":"none"}` alone, so this is belt-and-braces rather than a correction.
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
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
  /** `JWT` — present because PayPal's documented snippet includes it (report §31). */
  readonly typ: string
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
    const header = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8')) as {
      alg?: unknown
      typ?: unknown
    }
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      iss?: unknown
      email?: unknown
    }
    return {
      ok: true,
      value: {
        alg: typeof header.alg === 'string' ? header.alg : '',
        typ: typeof header.typ === 'string' ? header.typ : '',
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
   * **Encoding: `multipart/form-data` with a single JSON part named `input`** (report §1/#1). The
   * previous `json: {transaction_id, dispute_reason}` shared no field name with PayPal's documented
   * request: it is `disputed_transactions[].buyer_transaction_id` and `reason`, and the body has to be
   * multipart. This is the body from the "Test go live" page, verbatim:
   *
   * ```
   * -F 'input={"disputed_transactions":[{"buyer_transaction_id":"BUYER-TRANSACTION-ID"}],
   *          "reason":"MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
   *          "dispute_amount":{"currency_code":"USD","value":"20"},
   *          "extensions":{…}};type=application/json'
   * ```
   *
   * `buyer_transaction_id` is the id **as the buyer sees the transaction** — PayPal's own note says to
   * use the transaction id available when logging in as the business test account for
   * `process-chargeback`, and for a create-dispute it is the buyer's view of the same capture. §10.3
   * step 1 says the same thing, which is why this field was already named that in the spec.
   *
   * Returns `201 Created` with a HATEOAS link for the new dispute, which is why the return type is
   * `Links`. §10.3 step 3 still polls `listDisputes` for the dispute itself — do not assume the link
   * is the resource.
   *
   * ASSUMPTION (report §28): this endpoint is **not in `SPEC-D`**; `TGL` is the only source and flags
   * it sandbox-only.
   *
   * @param buyerEmail `PAYPAL_BUYER_EMAIL` — the personal account that will own the dispute.
   * @param body the `input` payload: the disputed transaction, the reason, optionally the amount.
   */
  async createBuyerDispute(buyerEmail: string, body: SimDisputeReq): Promise<Result<Links, CsError>> {
    const assertion = this.assertionOrError(buyerEmail)
    if (!assertion.ok) return assertion
    const parsed = simDisputeReqSchema.safeParse(body)
    if (!parsed.success) {
      return err(
        csError(
          'CS_VALIDATION',
          'createBuyerDispute needs {disputed_transactions:[{buyer_transaction_id}], reason} — that is the ' +
            'documented `input` part, not {transaction_id, dispute_reason}',
          {
            issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        ),
      )
    }
    const form = await buildEvidenceForm(parsed.data, [])
    if (!form.ok) return form
    return this.transport<Links>({
      method: 'POST',
      path: '/v1/customer/disputes',
      policyKey: 'POST /v1/customer/disputes',
      schema: linksSchema,
      form: form.value,
      opts: { authAssertion: assertion.value },
    })
  }

  /**
   * `POST /v2/customer-support/process-chargeback` [S29].
   *
   * Card-funded transactions only (§10.1 step 5, corroborated by [S29]: "ensure you use a credit card
   * to send money", and `instrument.instrument_type` must be `CARD`) — a vault capture with no card
   * behind it cannot be charged back, which is exactly why week-1 check C1 has a fallback chain
   * (§11 C1).
   *
   * **The previous body was entirely made up** (report §27/#2): `{transaction_id, reason}` shares no
   * field name with PayPal's contract. The documented body for a PayPal-funded transaction is
   * `adjacency: "PAYPAL"`, `file_layout: "ATCK_CB"`, `merchant_id`,
   * `financial_institution.processor: "FDMS"`, `transaction.{id_enc, amount}`,
   * `instrument.instrument_type: "CARD"` and a `dispute{}` object — and the call answers
   * **`201 Created` with a body**, so a `schema: null` would have discarded the dispute id PayPal
   * just minted.
   *
   * `merchant_id` and `transaction.amount` are caller-supplied because they are facts about *our*
   * PayPal account and *our* capture, not something this class can know. No `Clock` is injected
   * here, so `receiveDate`/`moneyMovementDate`/`responseDate` are the caller's too — nothing in this
   * package invents a time (spec §8.0 rule 10). `processor_info.notes` carries the dispute reason
   * because that is the free-text field the documented sample uses for it.
   *
   * ASSUMPTION (report §28): there is **no OpenAPI for this endpoint at all**; `TGL` is the only
   * source, so the field names rest on that page alone.
   */
  async processChargeback(input: {
    /** The capture id as the **business** account sees it — PayPal's `SELLER-TRANSACTION-ID`. */
    sellerTransactionId: string
    /** "The merchant ID associated with the PayPal account" (Business account → merchant id). */
    merchantId: string
    /** The captured amount being charged back. */
    amount: PPMoney
    /** One of `DISPUTE_REASONS`, recorded in `dispute.processor_info.notes`. */
    reason: string
    /** Card network reason code, e.g. `1330` in the documented sample. */
    reasonCode?: string
    cardBrand?: string
    creditCardTransactionId?: string
    /** RFC 3339. `dispute.receive_date` / `money_movement_date`. Caller-owned: no Clock here. */
    receiveDate?: string
    responseDate?: string
  }): Promise<Result<ProcessChargebackRes, CsError>> {
    const bad = requireText(input?.sellerTransactionId, 'processChargeback needs the seller transaction id')
    if (bad) return err(bad)
    const badMerchant = requireText(input?.merchantId, 'processChargeback needs the merchant id')
    if (badMerchant) return err(badMerchant)
    const badReason = requireText(input?.reason, 'processChargeback needs a reason, e.g. UNAUTHORISED')
    if (badReason) return err(badReason)
    if (input.amount === undefined) {
      return err(csError('CS_VALIDATION', 'processChargeback needs the captured amount'))
    }

    const body = {
      adjacency: 'PAYPAL',
      file_layout: 'ATCK_CB',
      merchant_id: input.merchantId,
      financial_institution: { processor: 'FDMS' },
      transaction: { id_enc: input.sellerTransactionId, amount: input.amount },
      instrument: {
        instrument_type: 'CARD',
        ...(input.cardBrand !== undefined ? { card_brand: input.cardBrand } : {}),
        ...(input.creditCardTransactionId !== undefined
          ? { credit_card_transaction_id: input.creditCardTransactionId }
          : {}),
      },
      dispute: {
        stage: 'CHARGEBACK',
        ...(input.receiveDate !== undefined
          ? { receive_date: input.receiveDate, money_movement_date: input.receiveDate }
          : {}),
        ...(input.responseDate !== undefined ? { response_date: input.responseDate } : {}),
        event_code: 'CHARGEBACK_INITIATED',
        event_type: 'DEBIT',
        chargeback_type: 'REPORTED_TO_PROCESSOR',
        processor_info: {
          ...(input.reasonCode !== undefined ? { reason_code: input.reasonCode } : {}),
          notes: input.reason,
        },
      },
    }
    const parsed = processChargebackReqSchema.safeParse(body)
    if (!parsed.success) {
      return err(
        csError('CS_VALIDATION', 'processChargeback built a body that does not match PayPal\'s schema', {
          issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      )
    }
    return this.transport<ProcessChargebackRes>({
      method: 'POST',
      path: '/v2/customer-support/process-chargeback',
      policyKey: 'POST /v2/customer-support/process-chargeback',
      schema: processChargebackResSchema,
      json: parsed.data,
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
   * The documented body is `{reason, note, item_info[]}` and the documented encoding is
   * **`multipart/related`** with a single `input` JSON part (report §30/#13). We send
   * `multipart/form-data` with the same single `input` part, because producing a `multipart/related`
   * body means hand-writing the boundary — which this package refuses to do anywhere (see
   * `multipart.ts`): a guessed boundary makes every part unparseable at PayPal and fails as a bare
   * 400 with no detail. The part name, the field names and the JSON payload are identical to the
   * documented form, and the two sibling simulators that create/change a dispute both take
   * `multipart/form-data`.
   *
   * `reason` alone was the previous body; `note` and `item_info` are documented fields and are
   * missing from it.
   *
   * ASSUMPTION (report §28): this endpoint is **not in `SPEC-D`** — the "Test go live" page is the only
   * source and flags it sandbox-only, so the encoding and the field names rest on that page alone.
   */
  async changeReason(id: string, body: ChangeReasonReq): Promise<Result<Links, CsError>> {
    const bad = requireId(id, 'changeReason')
    if (bad) return err(bad)
    const parsed = changeReasonReqSchema.safeParse(body)
    if (!parsed.success) {
      return err(
        csError(
          'CS_VALIDATION',
          'changeReason needs {reason, note?, item_info?} — the documented `input` part (report §30)',
          {
            issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        ),
      )
    }
    const form = await buildEvidenceForm(parsed.data, [])
    if (!form.ok) return form
    return this.transport<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/change-reason`,
      policyKey: 'POST /v1/customer/disputes/{id}/change-reason',
      schema: linksSchema,
      form: form.value,
    })
  }

  /**
   * `POST /v1/customer/disputes/{id}/accept-offer` — the **buyer** accepts a merchant offer.
   *
   * The body field is **`note`, not `payer_note`** (report §30/#12) — `SPEC-D.accept_offer` and the
   * "Test go live" page both say `application/json` with `{"note": "I am ok with the refund offered."}`.
   * `note` is optional (1–2000 chars) and "PayPal can view these notes, but the merchant cannot".
   *
   * **`202 Accepted` is a success here**, and is not a failure to retry: PayPal documents `200 OK` or
   * `202 Accepted` "if the offer's money movement is delayed". The client treats every 2xx as success
   * and `linksSchema` tolerates a body-less 202 by returning `{ links: [] }`, so a delayed refund is
   * reported as an accepted offer rather than an error. It also means an ambiguous failure here is
   * *more* dangerous, not less: the buyer may have accepted while we saw a timeout — which is why this
   * row of `IDEMPOTENCY.md` is `RE-READ FIRST`.
   */
  async acceptOffer(id: string, note?: string): Promise<Result<Links, CsError>> {
    const bad = requireId(id, 'acceptOffer')
    if (bad) return err(bad)
    if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) {
      return err(csError('CS_VALIDATION', 'acceptOffer note must be at most 2000 characters'))
    }
    return this.transport<Links>({
      method: 'POST',
      path: `/v1/customer/disputes/${encodeURIComponent(id)}/accept-offer`,
      policyKey: 'POST /v1/customer/disputes/{id}/accept-offer',
      schema: linksSchema,
      json: note === undefined ? {} : { note },
    })
  }

  /**
   * `POST /v1/customer/disputes/{id}/deny-offer` — the **buyer** rejects a merchant offer.
   *
   * `{note}` is correct and verified: `SPEC-D.deny_offer` and "Test go live" both say
   * `application/json` with `{"note": …}`, `note` **required**, 1–2000 characters (report §30).
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

  /**
   * The buyer assertion for the calls that document it.
   *
   * [S29] shows `PayPal-Auth-Assertion` on `POST /v1/customer/disputes` and `change-reason` (and on
   * `accept-offer` / `deny-offer`); `adjudicate` and `require-evidence` show only `Authorization:
   * Bearer`, so the assertion is buyer-side only.
   *
   * The assertion needs a buyer email, which is **caller** state (`PAYPAL_BUYER_EMAIL`), not client
   * state — so it is not injected here and this class reads no `process.env` of its own. For now
   * `changeReason` goes without it, which is the pre-existing behaviour: it is the one item on this
   * endpoint the sandbox probe has to settle along with the encoding.
   */
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