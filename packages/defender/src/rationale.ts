/**
 * Rationale composition — the sentence a buyer reads in S-18 and a judge reads in the packet.
 *
 * ## The rule of this file: **no model, ever**
 *
 * `packages/compiler`'s read-back is the string a user signs, and it is pure for the same reason this file
 * is pure. Spec **§18 question 27** asks how we stop a model inventing facts in evidence; question 46 asks
 * how we stop a user signing something they did not understand. Both answers are the same shape — a
 * template, composed from values we already decided — and neither is a prompt.
 *
 * So every rationale in this file is:
 *
 * - **a template with the facts substituted**, never an interpolation of model output;
 * - **anchored on the rule id in brackets**, so the packet's `rule` field and its prose cannot disagree
 *   (§8.15: "each has a rule ID shown in the UI and the packet");
 * - **specific about the fact compared**, because "the router decided to refund" is not reviewable and
 *   "the user asked for size 9 and size 10 arrived" is;
 * - **snapshot-tested verbatim** in `test/router.test.ts`. A wording change is a visible test diff, which is
 *   the only way a sentence a customer reads can be changed responsibly.
 *
 * ## Why the deadline sentence is appended rather than baked in
 *
 * EC-DSP-7/8 are about the clock, and the clock is not a fact about the case. Appending one of three
 * sentences (pressure / critical / passed) keeps twenty-one base sentences readable instead of
 * twenty-one × three, and keeps the base sentences testable without constructing a deadline in every
 * fixture.
 */

import { formatCountdown, formatIstHuman, formatMoney, formatMoneyCode } from '@countersign/core'

import {
  attributeConflicts,
  capturedTotal,
  completedRefunds,
  disputedSkus,
  duplicateShipmentCaptures,
  lineKey,
  reasonPhrase,
  refundedTotal,
  shipmentLinesMatchCheckout,
  trackedShipments,
  type AttributeKey,
} from './rules'
import type {
  DeadlineState_,
  DisputeContext,
  Liability,
  Posture,
  RouterFact,
  RuleId,
} from './types'

/** Fixed user-facing line for the no-chain case. Spec EC-DSP-9's "Not a Countersign order". */
export const NO_MANDATE_LINE = "No mandate on this payment. Countersign can't help here."

/** §8.15 R-UNAUTH-1's required user-facing flag. */
export const COMPROMISED_DEVICE_ALERT =
  'This purchase was signed with your passkey. If you did not make it, mark this device lost.'

const ATTRIBUTE_NOUNS: Readonly<Record<AttributeKey, string>> = {
  size: 'size',
  color: 'colour',
  model: 'model',
}

function money(ctx: DisputeContext): string {
  return formatMoney(ctx.dispute.amount)
}

/** The countdown to the response deadline, as `formatCountdown` prints it ("1d 16h"). */
function countdownOf(ctx: DisputeContext): string {
  const due = ctx.dispute.sellerResponseDueSec
  if (due === null || due === undefined) return 'not yet set'
  return formatCountdown(due - ctx.nowSec)
}

/**
 * Close a clause with a full stop.
 *
 * Needed because a rationale is assembled from two or three sentences written in different files, and
 * `"…The amount is right and the receipt shows it" + " But PayPal's deadline…"` is a missing full stop, not
 * a stylistic choice. Appending it here rather than at each sentence's end keeps every `ruleSentence`
 * branch free of trailing punctuation to keep in sync.
 */
function asSentence(text: string): string {
  const trimmed = text.trimEnd()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function lastRefundDate(ctx: DisputeContext): string {
  const done = completedRefunds(ctx)
  const newest = done.reduce<number | undefined>(
    (max, r) => (max === undefined || r.atSec > max ? r.atSec : max),
    undefined,
  )
  return newest === undefined ? 'an earlier date' : formatIstHuman(newest)
}

function fact(key: string, value: string, source: string): RouterFact {
  return { key, value, source }
}

// ---------------------------------------------------------------------------
// The twenty-one base sentences
// ---------------------------------------------------------------------------

/**
 * The base clause for a rule, without the deadline sentence and without the `[R-…]` suffix.
 *
 * Exported so a test can assert each sentence without constructing a deadline.
 */
export function ruleSentence(
  ruleId: RuleId,
  ctx: DisputeContext,
  posture: Posture,
  supersedes?: RuleId,
): string {
  const d = ctx.dispute
  const reason = reasonPhrase(d.reason)

  switch (ruleId) {
    // --- 1. money already moved ---------------------------------------------------------------
    case 'R-REF-1': {
      const refunded = refundedTotal(ctx)
      return (
        `We already refunded ${formatMoney(refunded)} on ${lastRefundDate(ctx)}, and this claim is for ` +
        `${money(ctx)} of the same payment. That is one refund being claimed twice, not a second loss, so ` +
        `the refund receipt is the answer and there is nothing to contest`
      )
    }
    case 'R-CNP-1': {
      const refunded = refundedTotal(ctx)
      return (
        `The buyer says a credit never arrived. We refunded ${formatMoney(refunded)} on ` +
        `${lastRefundDate(ctx)}, with a PayPal refund id, and that id is the proof. This is a receipt ` +
        `question, not a dispute about the purchase`
      )
    }

    // --- 2. lost, and appealable ----------------------------------------------------------------
    case 'R-APPEAL-1':
      return (
        'We lost this case and PayPal is still offering an appeal, and something material arrived since ' +
        'the decision — a carrier response or a tracking update that landed late. The appeal carries the ' +
        'original signed packet plus the new fact. Without that new fact the appeal would only repeat a ' +
        'packet that already lost'
      )

    // --- 3. no proof at all ----------------------------------------------------------------------
    case 'R-NOCHAIN-1': {
      const tail =
        posture === 'ACCEPT_CLAIM'
          ? `At ${money(ctx)} it is at or under the auto-accept limit this merchant set, so we settle it ` +
            `ourselves instead of filing something we cannot support`
          : `There is no Countersign order, mandate or signed chain attached to this capture, so there is ` +
            `nothing to file and no argument we could make. Settling it or writing it off is a money ` +
            `decision, and an unconfigured merchant has not delegated that to us, so a person decides`
      return `${NO_MANDATE_LINE} PayPal raised ${reason} for ${money(ctx)}. ${tail}`
    }
    case 'R-CHAIN-BAD': {
      const errors = ctx.chain?.verifyErrors ?? []
      const why = errors.length > 0 ? ` It failed with: ${errors.join('; ')}.` : ''
      return (
        `There is a mandate on this payment and its chain does not verify.${why} Every argument we could ` +
        `make would rest on that chain, so a packet built on it would collapse on inspection. We do not ` +
        `contest with a broken chain — we accept the claim`
      )
    }

    // --- 4a. not received ------------------------------------------------------------------------
    case 'R-INR-1':
      return (
        `The buyer says ${disputedSkus(ctx).join(', ')} never arrived, and no shipment carries tracking ` +
        `for that line. There is no delivery record to file, so there is no case to make: the parcel was ` +
        `ours and it is not accounted for. Refund`
      )
    case 'R-INR-3': {
      const s = trackedShipments(ctx)[0]
      const tracking = s === undefined ? '' : ` (${s.carrier} ${s.trackingNumber})`
      return (
        `Tracking${tracking} is registered with PayPal and the parcel is still moving. Nothing has gone ` +
        `wrong yet and the cheapest thing that can still be true is that it arrives, so we write to the ` +
        `buyer instead of spending one of our response attempts on a parcel that has not landed`
      )
    }
    case 'R-INR-2': {
      const tracked = trackedShipments(ctx)
      const first = tracked[0]
      const carrier = first === undefined ? 'the carrier' : first.carrier
      const tracking = first === undefined ? '' : ` ${first.trackingNumber}`
      const status = first?.status === undefined ? '' : ` and PayPal's tracker says ${first.status}`
      const rest = tracked.length > 1 ? ` and ${tracked.length - 1} more shipment(s)` : ''
      return (
        `Tracking exists for the disputed line${rest}: ${carrier}${tracking}${status}. The parcel left the ` +
        `warehouse, which is the fact the buyer is disputing, and it is ours to prove`
      )
    }

    // --- 4b. not as described ---------------------------------------------------------------------
    case 'R-SNAD-AGENT': {
      const conflicts = attributeConflicts(ctx)
      const first = conflicts[0]
      const noun = first === undefined ? 'item' : ATTRIBUTE_NOUNS[first.key]
      const wanted = first?.wanted ?? 'what the user asked for'
      const shipped = first?.shipped ?? 'what arrived'
      const readback =
        first?.statedInReadback === undefined
          ? 'The read-back the user approved does not mention this variant at all'
          : `The read-back showed ${noun} "${first.statedInReadback}", not what arrived`
      return (
        `Our own agent made this purchase. The user asked for ${noun} ${wanted}; ${noun} ${shipped} is ` +
        `what arrived. ${readback}. The chain is valid, so the agent stayed inside the budget and the ` +
        `merchant list the user signed — it read the request wrong. Blaming the buyer for a software ` +
        `misreading is not something we will file, so we refund`
      )
    }
    case 'R-SNAD-MERCH': {
      const shipped = (ctx.shipments ?? []).flatMap((s) => s.lines)
      return (
        `What shipped is not what the merchant signed at checkout. We sent [${lineKey(shipped)}] and the ` +
        `signed order says [${lineKey(ctx.checkoutLines)}]. Our own evidence would be evidence against our ` +
        `own customer, so we refund rather than file it`
      )
    }
    case 'R-SNAD-THIN': {
      const receipt = ctx.corpus?.fulfilmentDocument === true
      return (
        `The item matches the signed checkout and the user's own mandate permits it, so the purchase was ` +
        `authorised. What we do not have is anything that shows the goods were as described${receipt ? '' : ' — the only photographs we hold are of a packed box, and a photograph of a box is not evidence about what was in it'}. ` +
        `Contesting on that would spend a response on a packet with nothing in it. A refund in exchange for ` +
        `the item settles the same money with none of the handling cost`
      )
    }
    case 'R-SNAD-OK':
      return (
        `What arrived is exactly what the merchant signed at checkout, and the signed mandate permits it. ` +
        `The buyer is right that the goods differ from what they expected; the signed read-back says ` +
        `nothing was promised about that, and the item description and the order are both on file. That is ` +
        `a case we can actually argue`
      )

    // --- 4c. unauthorised -------------------------------------------------------------------------
    case 'R-UNAUTH-2': {
      const lostAt = ctx.chain?.deviceLostAtSec
      const iat = ctx.chain?.iatSec
      return (
        `The device that signed this mandate was already reported lost — on ` +
        `${lostAt === undefined ? 'an earlier date' : formatIstHuman(lostAt)} — and the mandate was signed ` +
        `at ${iat === undefined ? 'an unknown time' : formatIstHuman(iat)}, after that. A key on a lost ` +
        `device still verifies, and that is all the chain can prove here. We cannot show the person who ` +
        `signed was the account holder, so we accept`
      )
    }
    case 'R-UNAUTH-3': {
      const tail =
        posture === 'ACCEPT_CLAIM'
          ? `At ${money(ctx)} it is at or under the weak-case limit this merchant set, so we accept it ` +
            `rather than argue a case we cannot support`
          : `There is no configured limit below which we may settle this, so the decision to absorb it or ` +
            `to fight a case without a passkey is a person's`
      return (
        `The chain verifies, so this came through Countersign — but no passkey user-verification was ` +
        `recorded when the mandate was signed, so we cannot show that a person authorised it rather than ` +
        `something holding the device key. ${tail}`
      )
    }
    case 'R-UNAUTH-1': {
      const iat = ctx.chain?.iatSec
      return (
        `This mandate was signed by the user's own device key with a passkey user-verification` +
        `${iat === undefined ? '' : ` at ${formatIstHuman(iat)}`}, and the L3 that authorised this ` +
        `purchase was signed by the agent key bound inside that same mandate. The spend was inside the ` +
        `budget, at an allowed merchant, inside the expiry. A valid chain and a passkey is an authorised ` +
        `purchase, and the packet carries the whole chain so anyone can re-verify it`
      )
    }

    // --- 4d. amounts -----------------------------------------------------------------------------
    case 'R-AMT-1': {
      const captured = capturedTotal(ctx)
      const order = ctx.order
      return (
        `The captures on this order total ${formatMoney(captured)}, which is exactly what the signed ` +
        `checkout authorised${order === undefined ? '' : ` (order ${order.invoiceId ?? order.id})`}, and ` +
        `there is one capture per shipment — no duplicate. The amount is right and the receipt shows it`
      )
    }
    case 'R-AMT-2': {
      const dupes = duplicateShipmentCaptures(ctx)
      const capture = ctx.capture
      return (
        `We captured this order more than once for the same shipment` +
        `${dupes.length > 0 ? ` (${dupes.join(', ')})` : ''}` +
        `${capture === undefined ? '' : `, at ${formatMoney(capture.amount)} each time`}. We took the ` +
        `money twice for one delivery. That is a correction, not a defence: refund the duplicate`
      )
    }

    // --- 4e. the four unassigned reasons ----------------------------------------------------------
    case 'R-OTHER-REFUND':
      return (
        `The buyer is claiming ${reason} on a payment whose chain verifies and whose capture matches the ` +
        `order, so there is no signed fact that answers it. Refunding costs ${money(ctx)} once. ` +
        `Contesting a case with no evidence behind it costs the same money plus the ~$82 handling cost of a ` +
        `lost first-party dispute [V13], escalates the case, and teaches merchants that this packet argues ` +
        `everything — which is how a packet stops being believed when it matters. This rule is one line to ` +
        `change if a merchant disagrees`
      )

    case 'R-STAGE-INQUIRY': {
      const base =
        supersedes === undefined ? '' : `${asSentence(ruleSentence(supersedes, ctx, 'CONTEST'))} `
      return (
        `${base}But this is still an inquiry: PayPal has not asked us for a response, so no filing window is ` +
        `open and there is usually no deadline to miss. Writing to the buyer costs nothing, and a packet ` +
        `filed now would spend one of our responses on a claim that may still be withdrawn. The moment ` +
        `PayPal asks for a response the analysis re-runs and files`
      )
    }

    // --- 5. we cannot prove our own case ------------------------------------------------------------
    case 'R-DEADLINE-1': {
      const base =
        supersedes === undefined ? '' : `${asSentence(ruleSentence(supersedes, ctx, 'CONTEST'))} `
      const from =
        supersedes === undefined ? '' : ` Without the clock this would have been ${supersedes}.`
      return (
        `${base}PayPal's response deadline is ${countdownOf(ctx)}, and the evidence that case needs is not ` +
        `in hand: we cannot file what we do not have, so we settle rather than lose on a packet that never ` +
        `got sent.${from} Gather the document and re-run the analysis — the decision is deterministic, so a ` +
        `second run with the document attached gives a different answer`
      )
    }
    case 'R-NO-EVIDENCE': {
      const base =
        supersedes === undefined ? '' : `${asSentence(ruleSentence(supersedes, ctx, 'CONTEST'))} `
      const from =
        supersedes === undefined
          ? ''
          : ` Without the missing evidence this would have been ${supersedes}.`
      const settleClause = `At ${money(ctx)} we can settle it ourselves instead of filing nothing`
      const escalateClause = (c: DisputeContext): string =>
        `At ${money(c)} there is no configured limit below which we may settle this, so whether to ` +
        `absorb it or file an empty packet is a person's decision`
      return (
        `${base}But the evidence that case needs does not exist. Filing anyway would spend one of our ` +
        `responses on a packet PayPal would reject or ignore, and a rejected response can move the dispute ` +
        `up a stage.${from} ${posture === 'REFUND' ? settleClause : escalateClause(ctx)}`
      )
    }
    // --- 6. nothing fits ----------------------------------------------------------------------------
    case 'R-DEFAULT': {
      const known = [
        'no order is linked to this capture',
        ctx.chain?.mandatePresent === true ? 'a mandate is linked' : 'no mandate is linked',
        'no completed refund on the capture',
      ]
      return (
        `Nothing in the signed record answers ${reason}. ${known.join('; ')}. The router will not guess at a ` +
        `case it cannot support, so this one goes to a person with the evidence plan attached`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Facts and reasons
// ---------------------------------------------------------------------------

/**
 * The citation vocabulary. Every key is stable, every value is a plain string, and WP-15c's
 * `checkCitations` requires a drafted sentence to quote one of these verbatim.
 *
 * A fact that cannot be stated — no order, no tracking, no refund — is **absent** rather than empty, so
 * "we have no refund" can never be cited as though it were a value.
 */
export function factsFor(ctx: DisputeContext, ruleId: RuleId): readonly RouterFact[] {
  const facts: RouterFact[] = [
    fact('dispute.amount', formatMoneyCode(ctx.dispute.amount), 'disputes'),
    fact('dispute.reason', ctx.dispute.reason, 'disputes'),
    fact('router.rule', ruleId, 'defender.router'),
  ]
  if (ctx.order !== undefined) {
    facts.push(fact('order.custom_id', ctx.order.customId, 'orders'))
    facts.push(fact('order.amount', formatMoneyCode(ctx.order.amount), 'orders'))
  }
  if (ctx.capture !== undefined) {
    facts.push(fact('capture.id', ctx.capture.paypalCaptureId, 'captures'))
    facts.push(fact('capture.amount', formatMoneyCode(ctx.capture.amount), 'captures'))
  }
  const refunded = refundedTotal(ctx)
  if (completedRefunds(ctx).length > 0) {
    facts.push(fact('refund.total', formatMoneyCode(refunded), 'refunds'))
    facts.push(fact('refund.at', lastRefundDate(ctx), 'refunds'))
  }
  for (const s of trackedShipments(ctx)) {
    facts.push(fact('shipment.tracking', `${s.carrier} ${s.trackingNumber}`, 'shipments'))
    if (s.status !== undefined) facts.push(fact(`shipment.status.${s.id}`, s.status, 'shipments'))
  }
  if (ctx.shipments !== undefined && ctx.shipments.length > 0 && ctx.checkoutLines !== undefined) {
    facts.push(fact('lines.match_checkout', String(shipmentLinesMatchCheckout(ctx)), 'shipments'))
  }
  if (ctx.chain !== undefined) {
    if (ctx.chain.verifyAtCaptureChainValid !== undefined) {
      facts.push(
        fact(
          'chain.valid_at_capture',
          String(ctx.chain.verifyAtCaptureChainValid),
          'gate_decisions',
        ),
      )
    }
    if (ctx.chain.verifyNowChainValid !== undefined) {
      facts.push(fact('chain.valid_now', String(ctx.chain.verifyNowChainValid), 'verify'))
    }
    if (ctx.chain.webauthnPresent !== undefined) {
      facts.push(fact('mandate.webauthn', String(ctx.chain.webauthnPresent), 'mandates'))
    }
    if (ctx.chain.iatSec !== undefined) {
      facts.push(fact('mandate.signed_at', formatIstHuman(ctx.chain.iatSec), 'mandates'))
    }
    if (ctx.chain.deviceStatus !== undefined) {
      facts.push(fact('device.status', ctx.chain.deviceStatus, 'devices'))
    }
    if (ctx.chain.deviceLostAtSec !== undefined) {
      facts.push(fact('device.lost_at', formatIstHuman(ctx.chain.deviceLostAtSec), 'audit_log'))
    }
  }
  for (const c of attributeConflicts(ctx)) {
    facts.push(fact(`conflict.${c.key}.wanted`, c.wanted, 'mandates.preferences'))
    facts.push(fact(`conflict.${c.key}.shipped`, c.shipped, 'shipments'))
    if (c.statedInReadback !== undefined) {
      facts.push(fact(`conflict.${c.key}.in_readback`, c.statedInReadback, 'mandates.readback'))
    }
  }
  const skus = disputedSkus(ctx)
  if (skus.length > 0) facts.push(fact('dispute.lines', skus.join(', '), 'shipments'))
  return facts
}

/** The "why" list the UI renders under the decision: one sentence per rule. */
export function reasonsFor(
  ctx: DisputeContext,
  ruleId: RuleId,
  posture: Posture,
  supersedes?: RuleId,
): readonly string[] {
  const out: string[] = []
  switch (ruleId) {
    case 'R-REF-1':
      out.push(
        `Refunded ${formatMoney(refundedTotal(ctx))} already covers the ${money(ctx)} claimed.`,
      )
      break
    case 'R-CNP-1':
      out.push(
        `Refund of ${formatMoney(refundedTotal(ctx))} on ${lastRefundDate(ctx)} is on record.`,
      )
      break
    case 'R-APPEAL-1':
      out.push('PayPal still offers the appeal link and new evidence has arrived since the loss.')
      break
    case 'R-NOCHAIN-1':
      out.push('No order, mandate or signed chain is attached to this capture.')
      if (posture === 'ACCEPT_CLAIM') {
        out.push(
          `Within the merchant's auto-accept limit, so no human is woken up for ${money(ctx)}.`,
        )
      } else {
        out.push('No auto-accept limit is configured, so a person decides.')
      }
      break
    case 'R-CHAIN-BAD':
      out.push('The chain did not verify at capture time and has not recovered.')
      for (const e of ctx.chain?.verifyErrors ?? []) out.push(`vi: ${e}`)
      break
    case 'R-INR-1':
      out.push('No shipment carries tracking for the disputed line.')
      break
    case 'R-INR-3':
      out.push('Tracking is registered with PayPal and the parcel is still in transit.')
      break
    case 'R-INR-2':
      for (const s of trackedShipments(ctx)) {
        out.push(
          `${s.carrier} ${s.trackingNumber}${s.status === undefined ? '' : ` (${s.status})`}`,
        )
      }
      break
    case 'R-SNAD-AGENT':
      for (const c of attributeConflicts(ctx)) {
        out.push(
          `${ATTRIBUTE_NOUNS[c.key]}: user asked for "${c.wanted}", "${c.shipped}" arrived, read-back ` +
            `${c.statedInReadback === undefined ? 'did not state it' : `said "${c.statedInReadback}"`}.`,
        )
      }
      break
    case 'R-SNAD-MERCH':
      out.push(
        `Shipped [${lineKey((ctx.shipments ?? []).flatMap((s) => s.lines))}] ≠ signed [${lineKey(ctx.checkoutLines)}].`,
      )
      break
    case 'R-SNAD-THIN':
      out.push('No document shows the goods were as described.')
      break
    case 'R-SNAD-OK':
      out.push('Shipped lines match the merchant-signed checkout and the mandate permits it.')
      break
    case 'R-UNAUTH-2':
      out.push('Device reported lost before the mandate was signed.')
      break
    case 'R-UNAUTH-3':
      out.push('No passkey user-verification at signing.')
      break
    case 'R-UNAUTH-1':
      out.push(
        'Device-key signature with passkey user-verification, L3 signed by the L2-bound key.',
      )
      break
    case 'R-AMT-1':
      out.push(`Captures total ${formatMoney(capturedTotal(ctx))}, equal to the signed order.`)
      break
    case 'R-AMT-2':
      out.push(`Duplicate captures on ${duplicateShipmentCaptures(ctx).join(', ')}.`)
      break
    case 'R-OTHER-REFUND':
      out.push(
        `${reasonPhrase(ctx.dispute.reason)} is one of the four reasons with no evidence that helps.`,
      )
      break
    case 'R-DEADLINE-1':
      if (supersedes !== undefined)
        out.push(`Without the clock this would have been ${supersedes}.`)
      out.push('Required evidence is not in hand and the deadline is inside 48 hours.')
      break
    case 'R-NO-EVIDENCE':
      if (supersedes !== undefined)
        out.push(`Without the missing evidence this would have been ${supersedes}.`)
      out.push('The evidence this case needs does not exist.')
      break
    case 'R-STAGE-INQUIRY':
      out.push(
        `Stage is ${ctx.dispute.stage}, status is ${ctx.dispute.status}: no filing window is open.`,
      )
      if (supersedes !== undefined)
        out.push(`Once PayPal asks for a response this becomes ${supersedes}.`)
      break
    case 'R-DEFAULT':
      out.push('No rule matched, and the router will not guess.')
      break
  }
  return out
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The deadline clause. Appended for every state except `COMFORTABLE` and `UNKNOWN`. */
export function deadlineSentence(deadline: DeadlineState_): string {
  switch (deadline.state) {
    case 'UNKNOWN':
      return ''
    case 'PASSED':
      return "PayPal's response deadline has already passed, so nothing can be filed for this dispute now."
    case 'CRITICAL':
      return (
        `PayPal's response deadline is ${deadline.countdown} away, inside the hour where we refuse to ` +
        `upload automatically: a packet that only half uploads has spent the response.`
      )
    case 'PRESSURE':
      return (
        `PayPal's response deadline is ${deadline.countdown} away, so there is no room for evidence we ` +
        `have not gathered yet.`
      )
    case 'COMFORTABLE':
      return ''
  }
}

export interface ComposedRationale {
  readonly text: string
  readonly reasons: readonly string[]
  readonly facts: readonly RouterFact[]
  readonly blockingReason?: string
}

/**
 * Compose the full rationale for one rule: base sentence, then the deadline, then the rule id.
 *
 * The rule id is last and in brackets because §8.15 requires it in the packet and a reader needs the
 * sentence first. It is also what makes the eval's exact-match on `ruleId` and this string agree: the id in
 * the prose is generated from the same value the decision carries, so they cannot drift.
 */
export function composeRationale(input: {
  readonly ctx: DisputeContext
  readonly ruleId: RuleId
  readonly posture: Posture
  readonly liability: Liability
  readonly deadline: DeadlineState_
  readonly supersedes?: RuleId
}): ComposedRationale {
  const { ctx, ruleId, posture, deadline, supersedes } = input
  const base = asSentence(ruleSentence(ruleId, ctx, posture, supersedes))
  // `R-DEADLINE-1` already names the countdown in its own sentence — the downgrade *is* the clock — so
  // appending the generic deadline clause would say the same thing twice in one paragraph.
  const clock = ruleId === 'R-DEADLINE-1' ? '' : deadlineSentence(deadline)
  const parts = [base, clock, `[${ruleId}]`].filter((p) => p.length > 0)
  const composed: ComposedRationale = {
    text: parts.join(' '),
    reasons: reasonsFor(ctx, ruleId, posture, supersedes),
    facts: factsFor(ctx, ruleId),
  }
  return blockingReasonFor(composed, ruleId, posture, ctx)
}

/**
 * `blockingReason` — set **only** on `REVIEW`, and only for "a human must decide".
 *
 * It is never set for a deadline. EC-DSP-8 is a `DEF_DEADLINE_PASSED` error raised by the filer; a timeout
 * is a fact about the clock, and turning it into a blocking reason would make the UI say "waiting on a
 * person" for a case that no person can unblock.
 *
 * It is also **not** cleared by a passed deadline, and that is a deliberate distinction rather than an
 * oversight. `R-NOCHAIN-1` on a passed deadline is still `REVIEW` because the *case* has no evidence and no
 * person is going to acquire one before the deadline that has already gone; the reason is written in terms of
 * the evidence, never the clock. The `PASSED` state is carried separately on `decision.deadline`, so the UI
 * can render a red "deadline passed" banner and a "needs a person" note as two separate facts. A test
 * asserts that no `blockingReason` **text** mentions the deadline.
 */
function blockingReasonFor(
  composed: ComposedRationale,
  ruleId: RuleId,
  posture: Posture,
  ctx: DisputeContext,
): ComposedRationale {
  if (posture !== 'REVIEW') return composed
  const why =
    ruleId === 'R-NOCHAIN-1'
      ? 'There is no Countersign evidence on this payment, so whether to settle it or write it off is a money decision.'
      : ruleId === 'R-UNAUTH-3'
        ? 'Contesting an unauthorised claim with no passkey is a judgement about the account holder, not a fact we hold.'
        : ruleId === 'R-NO-EVIDENCE'
          ? `The evidence for a contest does not exist and ${formatMoney(ctx.dispute.amount)} is above the configured settle limit.`
          : 'No rule in the table covers this case, so it needs a person rather than a guess.'
  return { ...composed, blockingReason: why }
}
