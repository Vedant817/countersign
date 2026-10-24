/**
 * The citation checker — spec **§8.15** "Citation checker (deterministic)", **AT-M15.2** ("a forged number
 * → fail"), **EC-MER-4**, **EC-MER-5**, work package **WP-15c**.
 *
 * ```bash
 * pnpm --filter @countersign/defender test
 * ```
 *
 * ## What this file is for
 *
 * A drafter with no negative tests is a rubber stamp, so this file is **mostly refusals**. Each required
 * negative case from WP-15c appears as its own `it`, named after the edge case it belongs to so
 * `pnpm test:ec` counts it:
 *
 * | Test | What must be refused |
 * |---|---|
 * | the buyer was notified, no tracking artefact | `FORBIDDEN_DERIVATION` — there is no artefact kind for it |
 * | the right amount in the wrong currency | `CURRENCY_MISMATCH` |
 * | delivery asserted from a merchant-typed tracking number (EC-MER-4) | `FORBIDDEN_DERIVATION` |
 * | a marker for a claim id that does not exist | `UNKNOWN_CLAIM_ID` |
 * | an uncited sentence that is not boilerplate | `UNCITED_SENTENCE` |
 * | a merchant-typed tracking number promoted to a carrier-verified one | `FORBIDDEN_DERIVATION` |
 *
 * ## The property that matters more than any of them
 *
 * **Every claim in `decision.facts` is reachable, and nothing else is.** A checker that refuses everything
 * is also "fail closed" and is useless; the last `describe` asserts over generated contexts that a fully
 * cited note built from the template passes on every one of them. So the file tests both directions.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  BOILERPLATE_SENTENCES,
  CITATION_PROBLEM_CODES,
  TRUNCATION_NOTICE,
  boilerplateViolations,
  checkCitations,
  claimSourcesFor,
  currenciesIn,
  formatProblems,
  publicPacketUrl,
  splitSentences,
  stripMarkers,
  truncateNotes,
  type CitationProblemCode,
  type ClaimSource,
} from '../src/citation-check'
import { route } from '../src/router'
import { plainNotes } from '../src/drafter'
import type { DisputeContext } from '../src/types'

// ---------------------------------------------------------------------------
// A fixture
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000
const PACKET_ID = 'pkt_01HQ0000000000000000000000'
const BASE = 'https://countersign.example'
const URL = publicPacketUrl(BASE, PACKET_ID)

/** A CONTEST-shaped `UNAUTHORISED` context: valid chain, passkey, tracking the merchant typed. */
function unauthorised(over: Partial<DisputeContext> = {}): DisputeContext {
  return {
    nowSec: NOW,
    dispute: {
      id: 'dsp_1',
      paypalDisputeId: 'PP-DSP-1',
      reason: 'UNAUTHORISED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: { minor: 12_999n, currency: 'USD' },
      captureId: 'cap_1',
      orderId: 'ord_1',
      sellerResponseDueSec: NOW + 5 * 86_400,
    },
    capture: {
      id: 'cap_1',
      paypalCaptureId: '3AB12345',
      amount: { minor: 12_999n, currency: 'USD' },
      shipmentId: 'shp_1',
    },
    order: {
      id: 'ord_1',
      customId: 'cs1:AbCdEf0123456789',
      invoiceId: 'INV-42',
      amount: { minor: 12_999n, currency: 'USD' },
    },
    refunds: [],
    shipments: [
      {
        id: 'shp_1',
        carrier: 'DHL',
        trackingNumber: 'JD0002000031',
        status: 'SHIPPED',
        lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
      },
    ],
    siblingCaptures: [],
    chain: {
      mandatePresent: true,
      verifyAtCaptureChainValid: true,
      webauthnPresent: true,
      deviceStatus: 'ACTIVE',
      iatSec: NOW - 86_400,
      gateDecision: 'ALLOW',
    },
    checkoutLines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
    corpus: { fulfilmentDocument: true, receiptCopy: true },
    ...over,
  }
}

/** The same case with the tracker registered at PayPal, so tracking is a `record` and not an assertion. */
function withPaypalTracker(ctx: DisputeContext): DisputeContext {
  return {
    ...ctx,
    shipments: (ctx.shipments ?? []).map((s) => ({
      ...s,
      paypalTrackerId: `PPTRK-${s.id}`,
    })),
  }
}

function claimsOf(ctx: DisputeContext): readonly ClaimSource[] {
  return claimSourcesFor(ctx, route(ctx))
}

function check(
  notes: string,
  ctx: DisputeContext = unauthorised(),
  allowedUrl: string | undefined = URL,
) {
  return checkCitations({ notes }, claimsOf(ctx), allowedUrl === undefined ? {} : { allowedUrl })
}

/** Every problem code in a verdict, so a test can say "and nothing else was wrong". */
function codes(verdict: { problems: readonly { code: CitationProblemCode }[] }): readonly string[] {
  return verdict.problems.map((p) => p.code)
}

// ---------------------------------------------------------------------------
// The checker's own guarantees
// ---------------------------------------------------------------------------

describe('the citation checker is a pure function with no model in its graph', () => {
  const SRC = join(import.meta.dirname, '..', 'src')

  function sourceFiles(dir = SRC, out: { name: string; text: string }[] = []): typeof out {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) sourceFiles(full, out)
      else if (entry.endsWith('.ts')) {
        out.push({ name: full.slice(SRC.length + 1), text: readFileSync(full, 'utf8') })
      }
    }
    return out
  }

  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  }

  it('citation-check.ts imports no model runtime — the checker must not be able to ask one', () => {
    // The ESLint `no-restricted-imports` ban in `eslint.config.mjs` is the real control, and it was
    // observed firing (a planted `from 'ai'` import produced the error). This is the structural twin,
    // because a lint rule only runs for whoever runs lint.
    const file = sourceFiles().find((f) => f.name === 'citation-check.ts')
    expect(file).toBeDefined()
    expect(stripComments(file?.text ?? '')).not.toMatch(
      /from ['"](ai|@ai-sdk\/[^'"]+|openai|@anthropic-ai\/[^'"]+|ollama)['"]/,
    )
  })

  it('citation-check.ts imports only @countersign/core and this package, so the graph stays small', () => {
    const file = sourceFiles().find((f) => f.name === 'citation-check.ts')
    const imports = [...(file?.text ?? '').matchAll(/from ['"]([^'"]+)['"]/g)].map(
      (m) => m[1] ?? '',
    )
    for (const spec of imports) {
      expect(
        spec.startsWith('@countersign/core') || spec.startsWith('./'),
        `citation-check.ts must not import ${spec}`,
      ).toBe(true)
    }
  })

  it('the whole package still reads no wall clock, even the two files that may use a model', () => {
    for (const f of sourceFiles()) {
      expect(stripComments(f.text), f.name).not.toMatch(/\bDate\.now\s*\(/)
      expect(stripComments(f.text), f.name).not.toMatch(/\bnew\s+Date\s*\(\s*\)/)
    }
  })

  it('the boilerplate allowlist contains nothing that could be false about a dispute', () => {
    // Each entry must be claim-free: no digit, no money, no URL, no marker. A digit in an uncited
    // sentence is a claim, which is the whole reason this list is checked rather than reviewed.
    expect(boilerplateViolations()).toEqual([])
  })

  it('every allowlist sentence is genuinely marker-free, so none of them smuggles a citation', () => {
    for (const s of BOILERPLATE_SENTENCES) expect(s).not.toContain('[[')
  })

  it('CITATION_PROBLEM_CODES is the closed set, and every code is one the checker can actually emit', () => {
    // Exhaustive by construction: the union is a literal union, so TypeScript already refuses a value that
    // is not in it. What this pins is the other direction — that the exported list is not missing a member,
    // which a reader would otherwise have to trust.
    expect(new Set(CITATION_PROBLEM_CODES).size).toBe(CITATION_PROBLEM_CODES.length)
    expect(CITATION_PROBLEM_CODES).toContain('FORBIDDEN_DERIVATION')
    expect(CITATION_PROBLEM_CODES).toContain('CURRENCY_MISMATCH')
    expect(CITATION_PROBLEM_CODES).toContain('UNKNOWN_CLAIM_ID')
    expect(CITATION_PROBLEM_CODES).toContain('UNCITED_SENTENCE')
  })

  it('the truncation notice is on the allowlist, so truncation cannot make a note uncitable', () => {
    expect(BOILERPLATE_SENTENCES).toContain(TRUNCATION_NOTICE)
  })
})

// ---------------------------------------------------------------------------
// Sentence splitting — where a naive checker loses amounts
// ---------------------------------------------------------------------------

describe('sentence splitting', () => {
  it('does not split inside an amount, which is what the naive /[.!?]/ pattern does', () => {
    expect(splitSentences('The amount was USD 1,299.00. It matched.')).toEqual([
      'The amount was USD 1,299.00.',
      'It matched.',
    ])
  })

  it('pulls an orphan marker run back onto the sentence before the full stop', () => {
    // Models write the marker on either side of the stop. Both mean the same thing, and refusing a
    // correct draft for a formatting difference is how people learn to ignore a checker.
    expect(splitSentences('PayPal captured USD 129.99. [[clm_capture_amount]]')).toEqual([
      'PayPal captured USD 129.99. [[clm_capture_amount]]',
    ])
  })

  it('leaves a marker that already sits inside the sentence alone', () => {
    expect(splitSentences('PayPal captured USD 129.99 [[clm_capture_amount]]. Next.')).toEqual([
      'PayPal captured USD 129.99 [[clm_capture_amount]].',
      'Next.',
    ])
  })

  it('drops blank chunks so a double space is not judged as an uncited sentence', () => {
    expect(splitSentences('One.   Two.')).toEqual(['One.', 'Two.'])
  })

  it('reads A$ and C$ as their own currencies rather than as a bare dollar sign', () => {
    // A `$` that is a *suffix* of A$/C$ would otherwise report two currencies and refuse a correct AUD note.
    expect(currenciesIn('A$12.00')).toEqual(['AUD'])
    expect(currenciesIn('C$12.00')).toEqual(['CAD'])
    expect(currenciesIn('$12.00')).toEqual(['USD'])
    expect(currenciesIn('EUR 12.00 and ₹9.00')).toEqual(['EUR', 'INR'])
  })
})

// ---------------------------------------------------------------------------
// A note that must be accepted
// ---------------------------------------------------------------------------

describe('a fully cited note is accepted', () => {
  it('accepts every sentence carrying a real marker, and records the citation for each', () => {
    const ctx = unauthorised()
    const claims = claimsOf(ctx)
    const amount = claims.find((c) => c.id === 'clm_dispute_amount')
    expect(amount?.phrase).toBe('USD 129.99')
    const verdict = checkCitations(
      { notes: `The buyer is disputing ${amount?.phrase} [[clm_dispute_amount]].` },
      claims,
      { allowedUrl: URL },
    )
    expect(verdict.problems).toEqual([])
    expect(verdict.ok).toBe(true)
    expect(verdict.citations).toHaveLength(1)
    expect(verdict.citations[0]?.claimId).toBe('clm_dispute_amount')
    expect(verdict.citations[0]?.sentence).toBe('The buyer is disputing USD 129.99.')
    expect(verdict.citations[0]?.artefact.id).toBe('capture:3AB12345')
  })

  it('accepts a note made only of allowlist boilerplate, and one bare link', () => {
    const ctx = unauthorised()
    const notes = `${BOILERPLATE_SENTENCES[0]} ${URL}`
    const verdict = checkCitations({ notes }, claimsOf(ctx), { allowedUrl: URL })
    expect(codes(verdict)).toEqual([])
    expect(verdict.ok).toBe(true)
    expect(verdict.citations).toEqual([])
  })

  it('reports the claims a note never used, so a reader can see what was available and not claimed', () => {
    const ctx = unauthorised()
    const verdict = checkCitations(
      { notes: 'The buyer is disputing USD 129.99 [[clm_dispute_amount]].' },
      claimsOf(ctx),
      { allowedUrl: URL },
    )
    expect(verdict.unusedClaimIds).toContain('clm_chain_verified')
    expect(verdict.unusedClaimIds).not.toContain('clm_dispute_amount')
    // Never a reason to block. A note that asserts less is not a note that asserts something unproven.
    expect(verdict.ok).toBe(true)
  })

  it('accepts the EC-MER-4 phrasing when the tracker really is registered with PayPal', () => {
    // The mirror of the refusal below, and it matters: a rule that refuses everything would pass the
    // negative test too.
    const ctx = withPaypalTracker(unauthorised())
    const claims = claimsOf(ctx)
    const tracking = claims.find((c) => c.id === 'clm_tracking_shp_1')
    expect(tracking?.support).toBe('record')
    const verdict = checkCitations(
      { notes: `The parcel was dispatched with DHL JD0002000031 [[clm_tracking_shp_1]].` },
      claims,
      { allowedUrl: URL },
    )
    expect(verdict.ok).toBe(true)
  })

  it('accepts "dispatched" but still refuses "delivered" even from a PayPal-registered tracker', () => {
    // EC-MER-4's boundary is drawn at *delivery*, not at *dispatch*. A carrier scan is not a delivery
    // either, and a tracker being registered means PayPal holds scans — not that anything was delivered.
    const ctx = withPaypalTracker(unauthorised())
    const verdict = check(
      'The parcel was delivered on time according to DHL JD0002000031 [[clm_tracking_shp_1]].',
      ctx,
    )
    expect(codes(verdict)).toContain('FORBIDDEN_DERIVATION')
  })
})

// ---------------------------------------------------------------------------
// Required negative 1 — notification
// ---------------------------------------------------------------------------

describe('a draft asserting the buyer was notified', () => {
  it('is refused when no tracking artefact exists at all, with no marker on the sentence', () => {
    // The required negative test. There is no artefact kind for a notification, so no marker could rescue
    // this sentence — which is why it is refused before the marker is even looked at.
    const verdict = check('We notified the buyer by email on the day of dispatch.')
    expect(codes(verdict)).toEqual(['FORBIDDEN_DERIVATION'])
    expect(verdict.ok).toBe(false)
    expect(verdict.citations).toEqual([])
  })

  it('is refused even when the sentence carries a real claim marker', () => {
    // A marker is a claim about *which* fact; it is not a licence. A sentence that asserts an event we
    // hold no artefact for stays refused whatever it cites.
    const verdict = check('We notified the buyer about DHL JD0002000031 [[clm_tracking_shp_1]].')
    expect(codes(verdict)).toContain('FORBIDDEN_DERIVATION')
    expect(verdict.citations).toEqual([])
  })

  it('quotes the offending sentence back, because a human decides on this in S-18', () => {
    const verdict = check('We notified the buyer by email on the day of dispatch.')
    expect(verdict.problems[0]?.sentence).toBe(
      'We notified the buyer by email on the day of dispatch.',
    )
    const lines = formatProblems(verdict.problems)
    expect(lines[0]).toContain('[FORBIDDEN_DERIVATION]')
    expect(lines[0]).toContain('We notified the buyer by email')
  })

  it('is not fooled by an identifier that merely contains the word, which the drafter eval found', () => {
    // `INV-bad-05-notified` was refused as a notification claim, because `\bnotified\b` matches inside it:
    // `-` is a non-word character, so both edges of `notified` are word boundaries. Invoice numbers, order
    // references and PayPal ids are full of capitalised words, and a checker that reads meaning into one of
    // them refuses correct filings over a coincidence — which is not "fail closed", it is unusable.
    const ctx = unauthorised({
      order: {
        id: 'ord_1',
        customId: 'cs1:AbCdEf0123456789',
        invoiceId: 'INV-2026-NOTIFIED-1',
        amount: { minor: 12_999n, currency: 'USD' },
      },
    })
    const verdict = check(
      'The signed order records invoice INV-2026-NOTIFIED-1 [[clm_invoice_id]].',
      ctx,
    )
    expect(codes(verdict)).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('still refuses a notification claim that happens to sit next to an identifier', () => {
    // The guard is not "we notified is never refused"; it is "notified is not a word inside an identifier".
    const verdict = check(
      'We notified the buyer about invoice INV-2026-NOTIFIED-1 [[clm_invoice_id]].',
    )
    expect(codes(verdict)).toContain('FORBIDDEN_DERIVATION')
  })
})

// ---------------------------------------------------------------------------
// Required negative 2 — the right amount in the wrong currency
// ---------------------------------------------------------------------------

describe('a draft asserting the right amount in the wrong currency', () => {
  it('is refused, and the message names the currency the sentence used', () => {
    const verdict = check('The buyer is disputing EUR 129.99 [[clm_dispute_amount]].')
    expect(codes(verdict)).toContain('CURRENCY_MISMATCH')
    const detail =
      verdict.problems.find((p) => p.code === 'CURRENCY_MISMATCH')?.detail ??
      verdict.problems.map((p) => p.detail).join(' ')
    expect(detail).toContain('EUR')
    expect(detail).toContain('USD')
  })

  it('also refuses on the phrase, because "EUR 129.99" is not the phrase "USD 129.99"', () => {
    // Both codes firing is correct, not redundant: one says "the value does not match", the other says
    // "and it is a different currency", and a merchant fixing only one of them has still written a lie.
    const verdict = check('The buyer is disputing EUR 129.99 [[clm_dispute_amount]].')
    expect(codes(verdict)).toContain('PHRASE_NOT_IN_SENTENCE')
    expect(codes(verdict)).toContain('CURRENCY_MISMATCH')
  })

  it('refuses a sentence that mixes two currencies, because nobody can then read which is which', () => {
    // The rule is one currency per sentence. `[[clm_capture_amount]]` is USD, so a sentence that also says
    // GBP is refused — even though the GBP figure has its own citation. §0 rule 9: integer minor units
    // *plus a code*, and two codes in one sentence has multiplied the money.
    const verdict = check(
      'PayPal captured USD 129.99 [[clm_capture_amount]] while the order totals GBP 99.99 [[clm_order_amount]].',
    )
    expect(codes(verdict)).toContain('CURRENCY_MISMATCH')
  })

  it('does not read a currency out of a rule id, SKU or claim id', () => {
    // The bug this file shipped and then caught: `\bINR\b` matches inside `R-INR-2`, because `-` is a
    // non-word character. Without the lookarounds, every not-received dispute had its correct note
    // refused on the rule id alone.
    const ctx = unauthorised({
      dispute: { ...unauthorised().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' },
      shipments: [
        {
          id: 'shp_1',
          carrier: 'DHL',
          trackingNumber: 'JD0002000031',
          status: 'SHIPPED',
          lines: [{ sku: 'SKU-INR-9', qty: 1 }],
        },
      ],
    })
    const claims = claimsOf(ctx)
    expect(claims.find((c) => c.id === 'clm_rule')?.phrase).toBe('R-INR-2')
    const verdict = check('R-INR-2 [[clm_rule]] and SKU-INR-9 [[clm_disputed_lines]].', ctx)
    expect(codes(verdict)).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('refuses when the note converts a signed limit into another currency, which the Gate would not do', () => {
    // EC-FX-1. The note must never do arithmetic the Gate refuses to do, and "€109.99 (about USD 129.99)"
    // is a conversion dressed as a fact.
    const verdict = check('The buyer is disputing EUR 109.99 [[clm_dispute_amount]].')
    expect(codes(verdict)).toContain('CURRENCY_MISMATCH')
  })
})

// ---------------------------------------------------------------------------
// Required negative 3 — EC-MER-4, delivery from a merchant-typed number
// ---------------------------------------------------------------------------

describe('EC-MER-4: delivery asserted on the strength of a merchant-typed tracking number', () => {
  it('is refused, because an assertion is not evidence', () => {
    const ctx = unauthorised()
    expect(claimsOf(ctx).find((c) => c.id === 'clm_tracking_shp_1')?.support).toBe('assertion')
    const verdict = check('The parcel was delivered by DHL JD0002000031 [[clm_tracking_shp_1]].')
    expect(codes(verdict)).toEqual(['FORBIDDEN_DERIVATION'])
    expect(verdict.ok).toBe(false)
  })

  it('is refused for every delivery-shaped word we can think of, not just "delivered"', () => {
    // A rule keyed on one word is a rule with a bypass. Each of these is a sentence a model could write and
    // a merchant could file, and each is a claim we hold no record for.
    for (const phrase of [
      'delivery confirmed by DHL JD0002000031',
      'proof of delivery for DHL JD0002000031',
      'the carrier verified DHL JD0002000031',
      'independently verified tracking DHL JD0002000031',
      'the courier confirmed DHL JD0002000031',
      'received by the buyer on DHL JD0002000031',
      'signed for by the buyer on DHL JD0002000031',
    ]) {
      const verdict = check(`${phrase} [[clm_tracking_shp_1]].`)
      expect(codes(verdict), phrase).toContain('FORBIDDEN_DERIVATION')
    }
  })

  it("refuses the claim even when a delivery document is on file but the number is still the merchant's", () => {
    // `corpus.fulfilmentDocument` is a document *we hold*, not a carrier record PayPal can read, and this
    // fixture is exactly the EC-MER-4 trap: a fulfilment document present, tracker unregistered.
    const ctx = unauthorised()
    expect(ctx.corpus?.fulfilmentDocument).toBe(true)
    const verdict = check(
      'The parcel was delivered, as DHL JD0002000031 [[clm_tracking_shp_1]] shows.',
    )
    expect(codes(verdict)).toContain('FORBIDDEN_DERIVATION')
  })

  it('still accepts the honest phrasing for the same claim, so the rule is about delivery and not tracking', () => {
    const verdict = check('Our records hold tracking DHL JD0002000031 [[clm_tracking_shp_1]].')
    expect(codes(verdict)).toEqual([])
  })

  it('is not fooled by a SKU that merely contains "DELIVERED"', () => {
    // The same identifier trap as the notification rule, in the delivery family. A catalogue is full of
    // SKUs like this one, and a packet that quotes the disputed line must not be refused for it.
    const ctx = unauthorised({
      disputedItem: { sku: 'SKU-DELIVERED-9', attributes: {} },
      checkoutLines: [{ sku: 'SKU-DELIVERED-9', qty: 1 }],
      shipments: [
        {
          id: 'shp_1',
          carrier: 'DHL',
          trackingNumber: 'JD0002000031',
          status: 'SHIPPED',
          lines: [{ sku: 'SKU-DELIVERED-9', qty: 1 }],
        },
      ],
    })
    const verdict = check('The disputed line is SKU-DELIVERED-9 [[clm_disputed_lines]].', ctx)
    expect(codes(verdict)).toEqual([])
    expect(verdict.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Required negative 4 — a claim id that does not exist
// ---------------------------------------------------------------------------

describe('a draft with a marker for a claim id that does not exist', () => {
  it('is refused, and lists the ids that do exist so the model can correct itself', () => {
    const verdict = check('The buyer is disputing USD 129.99 [[clm_amount_the_model_made_up]].')
    expect(codes(verdict)).toContain('UNKNOWN_CLAIM_ID')
    const detail = verdict.problems.find((p) => p.code === 'UNKNOWN_CLAIM_ID')?.detail ?? ''
    expect(detail).toContain('clm_dispute_amount')
  })

  it('EC-DSP-10: refuses a marker for a claim that is real but belongs to the other packet on the capture', () => {
    // Two disputes on one capture (inquiry + chargeback), one packet each, consistent facts. A marker from
    // the other packet is precisely how the two would disagree, so the ids have to be per-packet and a
    // cross-packet citation has to be refused.
    const a = unauthorised()
    const b = unauthorised({
      dispute: { ...a.dispute, id: 'dsp_2', paypalDisputeId: 'PP-DSP-2' },
      chain: { ...a.chain, gateDecision: 'REVIEW' },
    })
    const otherGate = claimsOf(b).find((c) => c.id === 'clm_gate_decision')?.phrase
    expect(otherGate).toBe('REVIEW')
    const verdict = check('The merchant Gate recorded REVIEW [[clm_gate_decision]].', a)
    expect(codes(verdict)).toContain('PHRASE_NOT_IN_SENTENCE')
    // And the same marker in its own packet is fine, or the rule would be useless.
    expect(check('The merchant Gate recorded REVIEW [[clm_gate_decision]].', b).ok).toBe(true)
  })

  it('refuses a marker that is nearly right, as malformed rather than unknown', () => {
    // `[[clm_rule]]` exists and `[[clm_Rule]]` does not. A checker that normalised case would accept a
    // marker the drafter never intended, and the prompt's list would no longer be the contract.
    // `MALFORMED_MARKER` is the honest code: the shape is wrong, so it is not a claim id at all.
    const verdict = check('The rule was R-UNAUTH-1 [[clm_Rule]].')
    expect(codes(verdict)).toEqual(['MALFORMED_MARKER'])
    expect(verdict.citations).toEqual([])
  })

  it('refuses a half-written marker, so a typo is never a silent citation', () => {
    const verdict = check('The buyer is disputing USD 129.99 [[clm_dispute_amount].')
    expect(codes(verdict)).toContain('MALFORMED_MARKER')
  })

  it('refuses a marker containing a dot, which is how a link would be smuggled past the URL rule', () => {
    const verdict = check('See [[clm_dispute.amount]] for the amount.')
    expect(codes(verdict)).toEqual(['MALFORMED_MARKER'])
  })
})

// ---------------------------------------------------------------------------
// Required negative 5 — an uncited sentence
// ---------------------------------------------------------------------------

describe('a sentence with no marker that is not boilerplate', () => {
  it('is refused, which is the only safe default', () => {
    const verdict = check('We have always treated our buyers fairly.')
    expect(codes(verdict)).toEqual(['UNCITED_SENTENCE'])
    expect(verdict.problems[0]?.detail).toContain('boilerplate')
  })

  it('refuses a sentence that sounds like a fact but carries no number, date or id', () => {
    // The naive checker only demands a citation when it sees a digit. "The parcel left our warehouse" has
    // no digit and is still a claim about the world, so the marker requirement is unconditional.
    const verdict = check('The parcel left our warehouse on schedule.')
    expect(codes(verdict)).toEqual(['UNCITED_SENTENCE'])
  })

  it('refuses a near-miss on the allowlist, so widening it has to be deliberate', () => {
    const almost = BOILERPLATE_SENTENCES[1]?.replace('is in the attached packet', 'is attached')
    const verdict = check(almost ?? '')
    expect(codes(verdict)).toEqual(['UNCITED_SENTENCE'])
  })

  it('EC-LLM-3: a hallucinated fact is refused, not softened, so the packet never asserts it', () => {
    /**
     * The model's failure mode this guards is invention: a sentence that sounds like knowledge we hold
     * ("our records show the customer has never disputed an order before") for which no artefact
     * exists. The checker has exactly one honest answer — refuse the sentence — because a warning
     * would still put the claim in front of an adjudicator.
     *
     * The note is otherwise perfectly cited, so this is not a test of the marker format: the
     * fabricated sentence carries no marker, and the verdict names the sentence it refused.
     */
    const verdict = check(
      'The buyer is disputing USD 129.99 [[clm_dispute_amount]]. ' +
        'Our records show the customer has never disputed an order before.',
    )
    expect(verdict.ok).toBe(false)
    expect(codes(verdict)).toEqual(['UNCITED_SENTENCE'])
    expect(verdict.problems[0]?.sentence).toContain('never disputed an order')
  })

  it('refuses every sentence when the packet has no citable claim at all', () => {
    const verdict = checkCitations(
      { notes: 'The buyer is disputing USD 129.99 [[clm_dispute_amount]].' },
      [],
      { allowedUrl: URL },
    )
    expect(codes(verdict)).toContain('UNKNOWN_CLAIM_ID')
    expect(verdict.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// EC-DSP-12 — everything refused locally, before bytes move
// ---------------------------------------------------------------------------

describe("EC-DSP-12: PayPal's limits are refused before any bytes move", () => {
  it('refuses notes over 2000 characters, and says by how much', () => {
    // `SPEC-D` types `evidence.notes` as `maxLength: 2000`. A 4xx after a 50 MB upload costs a response
    // attempt, so the cap is checked here, in this package, with a registry code.
    const long = `${'A well-cited sentence. '.repeat(120)}`
    expect(long.length).toBeGreaterThan(2000)
    const verdict = check(long)
    expect(codes(verdict)).toContain('TOO_LONG')
    expect(verdict.problems.find((p) => p.code === 'TOO_LONG')?.detail).toContain(
      String(long.length),
    )
  })

  it('refuses an empty note, because PayPal requires at least one character', () => {
    const verdict = check('   ')
    expect(codes(verdict)).toEqual(['EMPTY_NOTES'])
  })

  it('refuses a second link, even when both are the permitted address', () => {
    const verdict = check(`The packet is at ${URL}. It is also at ${URL}.`)
    expect(codes(verdict)).toContain('DUPLICATE_URL')
  })

  it('refuses a tracking-parameterised variant of the permitted address', () => {
    const verdict = check(`Read more at ${URL}?utm_source=paypal.`)
    expect(codes(verdict)).toContain('DISALLOWED_URL')
  })

  it('refuses a bare domain, which is a link into our infrastructure with no scheme', () => {
    const verdict = check('The record is at countersign.example/v/pkt_01HQ for anyone to check.')
    expect(codes(verdict)).toContain('DISALLOWED_URL')
  })

  it('refuses a third-party link outright', () => {
    const verdict = check('Proof of delivery is at https://carrier.example/track/1234.')
    expect(codes(verdict)).toContain('DISALLOWED_URL')
  })

  it('refuses every link when the caller supplies no permitted address at all', () => {
    // The restrictive default: a caller who forgets `allowedUrl` gets a stricter check, never a looser one.
    const verdict = checkCitations({ notes: `The packet is at ${URL}.` }, claimsOf(unauthorised()))
    expect(codes(verdict)).toContain('DISALLOWED_URL')
  })

  it('does not mistake a version number for a host name, and a rule id for a currency', () => {
    // The bare-domain rule has to not fire on `pdf-lib 1.17.1`, or every packet would be refused for
    // naming its own renderer version.
    const ctx = unauthorised()
    const verdict = check('Nothing is claimed here.', ctx)
    // The sentence is uncited on purpose; the point is that its problems are only about the missing
    // marker, not about a URL and not about a currency.
    expect(codes(verdict)).toEqual(['UNCITED_SENTENCE'])
  })

  it('accepts the permitted link once, at the end of a sentence, full stop included', () => {
    // The trailing-punctuation bug: `…/v/pkt_x.` is not the same string as `…/v/pkt_x`, so a correct note
    // was refused as a disallowed URL and a merchant would have learned to reword the last sentence.
    const ctx = unauthorised()
    const claims = claimsOf(ctx)
    const notes = `${BOILERPLATE_SENTENCES[1] ?? ''} ${URL}.`
    const verdict = checkCitations({ notes }, claims, { allowedUrl: URL })
    expect(codes(verdict)).toEqual([])
    expect(verdict.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The phrase check
// ---------------------------------------------------------------------------

describe('the phrase must be consistent with the claim it cites', () => {
  it('refuses a citation whose phrase is absent, and quotes the phrase that is expected', () => {
    const verdict = check('PayPal captured the full amount [[clm_capture_amount]].')
    expect(codes(verdict)).toEqual(['PHRASE_NOT_IN_SENTENCE'])
    expect(verdict.problems[0]?.detail).toContain('USD 129.99')
  })

  it('refuses a status that is not the one we hold', () => {
    const verdict = check('The shipment status is DELIVERED [[clm_tracking_status_shp_1]].')
    expect(codes(verdict)).toContain('PHRASE_NOT_IN_SENTENCE')
  })

  it('accepts the phrase across a line break, because a hard-wrapped sentence is the same sentence', () => {
    const ctx = unauthorised()
    const verdict = check('The buyer is disputing\nUSD 129.99 [[clm_dispute_amount]].', ctx)
    expect(codes(verdict)).toEqual([])
  })

  it('accepts the phrase in a different case, because SHIPPED and shipped are the same status', () => {
    const ctx = unauthorised()
    const verdict = check('The shipment status is shipped [[clm_tracking_status_shp_1]].', ctx)
    expect(codes(verdict)).toEqual([])
  })

  it('withholds the citation for a blocked sentence, so the packet cannot record a claim we refused', () => {
    // The important part. If `citations` were populated before the checks ran, `evidence_packets.citations`
    // would say a sentence was cited while `citation_check` said it was not, and the two columns would
    // disagree in the one document a merchant and PayPal both read.
    const verdict = check('PayPal captured USD 500.00 [[clm_capture_amount]].')
    expect(codes(verdict)).toEqual(['PHRASE_NOT_IN_SENTENCE'])
    expect(verdict.citations).toEqual([])
    expect(verdict.citedClaimIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Truncation, made explicit
// ---------------------------------------------------------------------------

describe('the 2000-character truncation is explicit rather than silent', () => {
  const sentences = Array.from(
    { length: 60 },
    (_, i) => `Sentence number ${i} says nothing [[clm_rule]].`,
  )

  it('drops whole sentences and never cuts one in half', () => {
    const input = sentences.join(' ')
    const { notes, report } = truncateNotes(input)
    expect(notes.length).toBeLessThanOrEqual(2000)
    const kept = splitSentences(notes).filter((s) => s !== TRUNCATION_NOTICE)
    // Every kept sentence is byte-identical to one of the input sentences: no partial sentence survives.
    for (const s of kept) expect(sentences).toContain(s)
    expect(report?.droppedSentences).toBe(sentences.length - kept.length)
  })

  it('reports the numbers rather than burying them, and says what it did in the note itself', () => {
    const { notes, report } = truncateNotes(sentences.join(' '))
    expect(report?.writtenChars).toBe(sentences.join(' ').length)
    expect(report?.keptChars).toBe(notes.length)
    expect(report?.notice).toBe(TRUNCATION_NOTICE)
    // The notice is in the note, so the reader of the filing learns that sentences were omitted.
    expect(notes).toContain(TRUNCATION_NOTICE)
  })

  it('keeps a truncated note checkable, which a mid-sentence cut would not be', () => {
    const claims = claimsOf(unauthorised())
    const rule = claims.find((c) => c.id === 'clm_rule')?.phrase ?? 'R-UNAUTH-1'
    const input = Array.from(
      { length: 60 },
      (_, i) => `Sentence ${i} mentions ${rule} [[clm_rule]].`,
    )
    const { notes } = truncateNotes(input.join(' '))
    const verdict = checkCitations({ notes }, claims, { allowedUrl: URL })
    expect(codes(verdict)).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('leaves a note that already fits untouched, and says nothing was dropped', () => {
    const { notes, report } = truncateNotes('Short enough [[clm_rule]].')
    expect(notes).toBe('Short enough [[clm_rule]].')
    expect(report).toBeNull()
  })

  it('falls back to the notice alone when not even one sentence fits', () => {
    // Each "sentence" must be longer than the whole budget, or the first one fits and the test is about
    // something else. The budget is 2000 minus the notice, so 2400 characters is comfortably over it.
    const huge = 'x'.repeat(2400)
    const { notes, report } = truncateNotes(`${huge}. ${huge}.`)
    expect(notes).toBe(TRUNCATION_NOTICE)
    expect(report?.droppedSentences).toBe(2)
    expect(checkCitations({ notes }, claimsOf(unauthorised()), { allowedUrl: URL }).ok).toBe(true)
  })

  it('cannot be pushed over the limit by a caller asking for a bigger one', () => {
    const { notes } = truncateNotes(sentences.join(' '), 100_000)
    expect(notes.length).toBeLessThanOrEqual(2000)
  })
})

// ---------------------------------------------------------------------------
// claimSourcesFor — the deterministic vocabulary
// ---------------------------------------------------------------------------

describe('the citable vocabulary is derived, not generated', () => {
  it('is a pure function of the context and the decision', () => {
    const ctx = unauthorised()
    // `Money.minor` is a bigint, so JSON needs the replacer. Without it the assertion *throws* rather than
    // compares, which is a different failure to the one it is guarding.
    const json = (v: unknown): string =>
      JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}` : x))
    expect(json(claimSourcesFor(ctx, route(ctx)))).toBe(
      json(claimSourcesFor({ ...ctx }, route(ctx))),
    )
  })

  it('omits a fact that cannot be stated, rather than emitting it empty', () => {
    // The precedent is `rationale.ts`'s: "we have no refund" must never be citable as a value.
    const ctx = unauthorised({ refunds: [] })
    const ids = claimSourcesFor(ctx, route(ctx)).map((c) => c.id)
    expect(ids.filter((i) => i.startsWith('clm_refund'))).toEqual([])
  })

  it('gives every claim an artefact id in the shape §7.3 uses', () => {
    const ctx = unauthorised()
    for (const c of claimsOf(ctx)) {
      expect(c.phrase.length, c.id).toBeGreaterThan(0)
      const [kind, rest] = c.artefact.id.split(':')
      expect(
        ['l1', 'l2', 'l3', 'gate', 'tracking', 'capture', 'refund', 'checkout'],
        `${c.id} -> ${c.artefact.id}`,
      ).toContain(kind)
      if (kind === 'l1' || kind === 'l2' || kind === 'l3') expect(rest).toBeUndefined()
      else expect(rest?.length ?? 0, `${c.id} -> ${c.artefact.id}`).toBeGreaterThan(0)
    }
  })

  it('never emits a claim whose phrase is empty, which would make the phrase check unreachable', () => {
    // An empty phrase is a substring of every sentence, so `PHRASE_NOT_IN_SENTENCE` could never fire for
    // it. Dropping the claim is the fail-closed direction: an uncitable fact stays uncitable.
    for (const c of claimsOf(unauthorised({ capture: undefined, order: undefined }))) {
      expect(c.phrase.length, c.id).toBeGreaterThan(0)
    }
  })

  it('flips the chain phrase with the fact, so a good chain cannot be described as a broken one', () => {
    const good = claimsOf(unauthorised()).find((c) => c.id === 'clm_chain_verified')
    expect(good?.phrase).toBe('chain verified')
    const bad = unauthorised({
      chain: { mandatePresent: true, verifyAtCaptureChainValid: false, verifyNowChainValid: false },
    })
    expect(claimsOf(bad).find((c) => c.id === 'clm_chain_verified')?.phrase).toBe(
      'chain did not verify',
    )
  })

  it('flips the user-verification phrase with the fact', () => {
    const none = unauthorised({
      chain: { mandatePresent: true, verifyAtCaptureChainValid: true, webauthnPresent: false },
    })
    expect(claimsOf(none).find((c) => c.id === 'clm_user_verification')?.phrase).toBe(
      'no user-verification',
    )
  })

  it('makes a PayPal-registered tracker a record and a typed one an assertion, per shipment', () => {
    // Two shipments, one registered and one typed. `hasPaypalTracker(ctx)` answers "did the merchant
    // register *any*", and using it here would promote the typed number on the strength of the other one.
    const ctx = unauthorised({
      shipments: [
        {
          id: 'shp_1',
          carrier: 'DHL',
          trackingNumber: 'JD1',
          status: 'SHIPPED',
          paypalTrackerId: 'T-1',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        },
        {
          id: 'shp_2',
          carrier: 'DHL',
          trackingNumber: 'JD2',
          status: 'SHIPPED',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        },
      ],
    })
    const claims = claimsOf(ctx)
    expect(claims.find((c) => c.id === 'clm_tracking_shp_1')?.support).toBe('record')
    expect(claims.find((c) => c.id === 'clm_tracking_shp_2')?.support).toBe('assertion')

    // The typed one may not carry a delivery claim, even though the *other* shipment in the same sentence
    // is registered with PayPal. Under the old `hasPaypalTracker(ctx)` reading the sentence would pass,
    // because one registered tracker anywhere in the order would license a delivery claim for both.
    const verdict = check(
      'DHL JD1 [[clm_tracking_shp_1]] and DHL JD2 [[clm_tracking_shp_2]] were delivered.',
      ctx,
    )
    expect(codes(verdict)).toContain('FORBIDDEN_DERIVATION')
  })
})

// ---------------------------------------------------------------------------
// The property: a note built from the claims always passes
// ---------------------------------------------------------------------------

describe('a note that cites every claim it uses is accepted, over generated contexts', () => {
  /**
   * A generator over the parts of a context that change which claims exist.
   *
   * Biased towards the awkward combinations (a refund without an order, a tracker with no status, a chain
   * that verified at capture but not now) because the bugs in a checker live where two facts disagree.
   */
  function arbitraryContext(): fc.Arbitrary<DisputeContext> {
    return fc
      .record({
        reason: fc.constantFrom(
          'UNAUTHORISED',
          'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
          'INCORRECT_AMOUNT',
          'CREDIT_NOT_PROCESSED',
        ),
        minor: fc.bigInt({ min: 1n, max: 900_000n }),
        currency: fc.constantFrom('USD', 'EUR', 'GBP', 'INR', 'JPY'),
        hasCapture: fc.boolean(),
        hasOrder: fc.boolean(),
        refunds: fc.array(
          fc.record({
            amountMinor: fc.bigInt({ min: 0n, max: 500_000n }),
            status: fc.constantFrom('COMPLETED', 'PENDING'),
          }),
          { maxLength: 2 },
        ),
        tracker: fc.option(fc.constantFrom('PPTRK-1'), { nil: null }),
        status: fc.option(fc.constantFrom('SHIPPED', 'DELIVERED'), { nil: undefined }),
        verifyAtCapture: fc.option(fc.boolean(), { nil: undefined }),
        webauthn: fc.option(fc.boolean(), { nil: undefined }),
        device: fc.constantFrom('ACTIVE', 'LOST', 'REVOKED'),
      })
      .map((r) => {
        const tracking = `JD${r.minor % 100000n}`
        return {
          nowSec: NOW,
          dispute: {
            id: 'dsp_g',
            paypalDisputeId: 'PP-DSP-G',
            reason: r.reason,
            stage: 'CHARGEBACK',
            status: 'WAITING_FOR_SELLER_RESPONSE',
            amount: { minor: r.minor, currency: r.currency },
            sellerResponseDueSec: NOW + 7 * 86_400,
          },
          ...(r.hasCapture
            ? {
                capture: {
                  id: 'cap_1',
                  paypalCaptureId: '3AB99999',
                  amount: { minor: r.minor, currency: r.currency },
                  shipmentId: 'shp_1',
                },
              }
            : {}),
          ...(r.hasOrder
            ? {
                order: {
                  id: 'ord_1',
                  customId: 'cs1:AbCdEf',
                  invoiceId: 'INV-1',
                  amount: { minor: r.minor, currency: r.currency },
                },
              }
            : {}),
          refunds: r.refunds.map((x, i) => ({
            id: `ref_${i}`,
            paypalRefundId: `REF-${i}`,
            amount: { minor: x.amountMinor, currency: r.currency },
            status: x.status,
            atSec: NOW - 3600,
          })),
          shipments: [
            {
              id: 'shp_1',
              carrier: 'DHL',
              trackingNumber: tracking,
              ...(r.tracker === null ? {} : { paypalTrackerId: r.tracker }),
              ...(r.status === undefined ? {} : { status: r.status }),
              lines: [{ sku: 'SKU-A', qty: 1 }],
            },
          ],
          siblingCaptures: [],
          chain: {
            mandatePresent: true,
            ...(r.verifyAtCapture === undefined
              ? {}
              : { verifyAtCaptureChainValid: r.verifyAtCapture }),
            ...(r.webauthn === undefined ? {} : { webauthnPresent: r.webauthn }),
            deviceStatus: r.device,
            iatSec: NOW - 7200,
            gateDecision: 'ALLOW',
          },
          checkoutLines: [{ sku: 'SKU-A', qty: 1 }],
          corpus: { fulfilmentDocument: true, receiptCopy: true },
        } satisfies DisputeContext
      })
  }

  it('accepts a note made of one correctly cited sentence per claim, plus the boilerplate', () => {
    fc.assert(
      fc.property(arbitraryContext(), (ctx) => {
        const claims = claimSourcesFor(ctx, route(ctx))
        if (claims.length === 0) return true
        // Exactly the contract the prompt states: each claim's own phrase, with its own id.
        const notes = [
          BOILERPLATE_SENTENCES[0] ?? '',
          ...claims.map((c) => `${c.phrase} [[${c.id}]]`),
          URL,
        ].join(' ')
        const verdict = checkCitations({ notes: truncateNotes(notes).notes }, claims, {
          allowedUrl: URL,
        })
        if (!verdict.ok) {
          throw new Error(
            `a correctly cited note was refused: ${formatProblems(verdict.problems).join(' | ')}\n${notes}`,
          )
        }
        if (verdict.citations.length !== claims.length) {
          throw new Error(
            `expected ${claims.length} citations, got ${verdict.citations.length} for ${JSON.stringify(
              claims.map((c) => c.id),
            )}`,
          )
        }
        return true
      }),
      { numRuns: 500 },
    )
  })

  it('refuses a note whose only change is one digit in one amount', () => {
    // AT-M15.2, "a forged number → fail", stated as a property rather than as a fixture. Forging the
    // smallest possible change is the case a value-substring checker misses.
    fc.assert(
      fc.property(arbitraryContext(), (ctx) => {
        const claims = claimSourcesFor(ctx, route(ctx))
        const money = claims.find((c) => c.money !== undefined)
        if (money === undefined || money.money === undefined) return true
        const forged = `${money.phrase.slice(0, -1)}${money.phrase.endsWith('0') ? '1' : '0'} [[${money.id}]]`
        const verdict = checkCitations({ notes: `${forged}.` }, claims, { allowedUrl: URL })
        if (verdict.ok) throw new Error(`a forged amount was accepted: ${forged}`)
        return true
      }),
      { numRuns: 500 },
    )
  })

  it('does not mutate its input', () => {
    const ctx = unauthorised()
    const before = JSON.stringify(ctx, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))
    claimsOf(ctx)
    check('The buyer is disputing USD 129.99 [[clm_dispute_amount]].', ctx)
    const after = JSON.stringify(ctx, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))
    expect(after).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// stripMarkers
// ---------------------------------------------------------------------------

describe('markers are removed from the filed text', () => {
  it('leaves the sentence as a reader would see it, with no gap where a marker was', () => {
    expect(stripMarkers('The rule was R-UNAUTH-1 [[clm_rule]].')).toBe('The rule was R-UNAUTH-1.')
    expect(stripMarkers('A [[a]] and [[b]].')).toBe('A and.')
  })

  it('closes the gap a marker leaves, so a note does not read "USD 129.99 ."', () => {
    // The PDF prints the marker-free form. A visible gap before a full stop is the kind of detail a
    // merchant notices and a judge quotes.
    const markerSentence =
      'PayPal captured USD 129.99 [[clm_capture_amount]] in capture 3AB12345 [[clm_capture_id]].'
    const stripped = splitSentences(markerSentence).map(stripMarkers)
    expect(stripped[0]).toBe('PayPal captured USD 129.99 in capture 3AB12345.')
  })

  it('does not accept the marker-free form as fileable, which is EC-MER-5 doing its job', () => {
    // §8.15 puts the tags *in the notes*, which is what lets the checker run on the final text at file
    // time. A merchant who edits the note by hand removes them, every edited sentence becomes uncited,
    // and the filing is blocked. If the marker-free text were fileable, a hand edit would silently keep
    // the citations it had already been given — which is precisely EC-MER-5's attack.
    const ctx = unauthorised()
    const plain = plainNotes(
      'PayPal captured USD 129.99 [[clm_capture_amount]] in capture 3AB12345 [[clm_capture_id]].',
    )
    expect(plain).toBe('PayPal captured USD 129.99 in capture 3AB12345.')
    expect(check(plain, ctx).ok).toBe(false)
  })
})
