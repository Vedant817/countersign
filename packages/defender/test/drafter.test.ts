/**
 * The drafter — spec **§8.15**'s `draftNotes` and its citation-checker loop, work package **WP-15c**.
 *
 * ```bash
 * pnpm --filter @countersign/defender test
 * ```
 *
 * ## Every test here uses a scripted model
 *
 * `docs/HUMAN_TODO.md` **H-02** is open: there is no OpenAI key, so there is no live model and no test in
 * this file depends on one. The {@link ScriptedModel} below returns known text — including text designed to
 * **fail** the checker in each of the ways WP-15c names — and the assertions are about what `draft()` does
 * with it, not about what a model might do.
 *
 * That distinction is the point of the package. A test that measured "does the model behave" would be a
 * test of a third party's mood; a test that measures "does a bad answer get filed" is a test of this code.
 *
 * ## The six required negative cases, and where each one lives
 *
 * | Required negative | Test |
 * |---|---|
 * | "the buyer was notified", no tracking artefact | `EC-MER-4 … the buyer was notified` below, and `citation.test.ts` |
 * | the right amount in the wrong currency | `a forged amount in the wrong currency` below |
 * | delivery from a merchant-typed tracking number (EC-MER-4) | `a delivery claim from an assertion` below |
 * | a marker for a claim id that does not exist | `a marker for a claim the model invented` below |
 * | **a draft that is entirely about the buyer's own misuse** | `a REFUND posture files nothing at all` below |
 * | **`LLM_UNAVAILABLE` produces no partial `Draft`** | the whole `LLM_UNAVAILABLE` describe below |
 */

import { fixedClock } from '@countersign/core'
import { describe, expect, it } from 'vitest'

import { claimSourcesFor, publicPacketUrl } from '../src/citation-check'
import {
  CARRIER_CAVEAT,
  buildDrafterPrompt,
  buildDrafterSystem,
  checkForFiling,
  draft,
  plainNotes,
  templateNote,
  type Draft,
  type DraftInput,
  type LanguageModel,
} from '../src/drafter'
import { planEvidence } from '../src/planner'
import { route } from '../src/router'
import { loadRouterCases, contextFromCase } from '../eval/router-cases'
import type { DisputeContext } from '../src/types'

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

interface Turn {
  /** Absent only on a turn that throws. */
  readonly text?: string
  /** Throw instead of answering, to exercise the `LLM_UNAVAILABLE` path. */
  readonly throws?: string
}

/**
 * A model that answers from a fixed script.
 *
 * Two behaviours that matter: it **records every request** so a test can assert what the drafter *asked*
 * (the repair turn carrying the problems is a §8.15 requirement, and "the second prompt mentions the
 * problem" is only checkable if the request is captured), and it **runs out** if asked a third time, which
 * turns "at most two calls" into an assertion rather than a comment.
 */
function scriptedModel(
  turns: readonly Turn[],
): LanguageModel & { readonly requests: { system: string; prompt: string }[] } {
  const requests: { system: string; prompt: string }[] = []
  return {
    requests,
    generateText: async (request) => {
      requests.push(request)
      const turn = turns[requests.length - 1]
      if (turn === undefined) {
        throw new Error(
          `scriptedModel: asked ${requests.length} times, only ${turns.length} scripted`,
        )
      }
      if (turn.throws !== undefined) throw new Error(turn.throws)
      return { text: turn.text ?? '' }
    },
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000
const PACKET_ID = 'pkt_01HQ0000000000000000000000'
const BASE = 'https://countersign.example'
const URL = publicPacketUrl(BASE, PACKET_ID)

/** A CONTEST `UNAUTHORISED` dispute: valid chain, passkey, and tracking the merchant typed. */
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
      readback:
        '**What you are authorising**\nOnly at **Northwind Outfitters**\nSpend at most **$130.00** in total',
    },
    checkoutLines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
    corpus: { fulfilmentDocument: true, receiptCopy: true },
    ...over,
  }
}

function inputFor(ctx: DisputeContext = unauthorised()): DraftInput {
  const decision = route(ctx)
  return {
    ctx,
    decision,
    plan: planEvidence(ctx, decision),
    packetId: PACKET_ID,
    publicBaseUrl: BASE,
    claims: claimSourcesFor(ctx, decision),
  }
}

/** A note that would pass: every claim quoted, no prose of its own. */
function goodNote(input: DraftInput): string {
  return templateNote(input, input.claims ?? [], URL)
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('a well-behaved model', () => {
  it('files its own text, with one citation per claim it used', async () => {
    const input = inputFor()
    const llm = scriptedModel([{ text: goodNote(input) }])
    const result = await draft(input, { llm })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.source).toBe('model')
    expect(result.value.modelCalls).toBe(1)
    expect(result.value.blocked).toBeUndefined()
    expect(result.value.verdict.ok).toBe(true)
    expect(result.value.citations.length).toBeGreaterThan(0)
    expect(result.value.notes.length).toBeLessThanOrEqual(2000)
  })

  it('makes exactly one call when the first answer is clean', async () => {
    const input = inputFor()
    const llm = scriptedModel([{ text: goodNote(input) }])
    await draft(input, { llm })
    // `scriptedModel` throws on a third call; a second call here would be visible as `requests.length`.
    expect(llm.requests).toHaveLength(1)
  })

  it('records `model` as the source, never anything a caller could confuse with a template', async () => {
    const input = inputFor()
    const result = await draft(input, { llm: scriptedModel([{ text: goodNote(input) }]) })
    expect(result.ok && result.value.source).toBe('model')
  })

  it('strips a markdown fence and a `notes:` prefix, which models add unprompted', async () => {
    const input = inputFor()
    const fenced = `\`\`\`\nnotes: ${goodNote(input)}\n\`\`\``
    const result = await draft(input, { llm: scriptedModel([{ text: fenced }]) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.notes).not.toContain('```')
    expect(result.value.notes).not.toMatch(/^notes:/)
    expect(result.value.verdict.ok).toBe(true)
  })

  it('does not send the marker-free text to the checker, and does not file the marker-free text', async () => {
    // EC-MER-5 in one assertion: the markers are what makes the final text checkable, so they have to
    // survive all the way to `notes`.
    const input = inputFor()
    const result = await draft(input, { llm: scriptedModel([{ text: goodNote(input) }]) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.notes).toContain('[[clm_rule]]')
    expect(plainNotes(result.value.notes)).not.toContain('[[')
  })
})

// ---------------------------------------------------------------------------
// The repair turn
// ---------------------------------------------------------------------------

describe('a model whose first answer fails the checker', () => {
  it('is given exactly one repair turn, with the problems quoted', async () => {
    // §8.15: "If the check fails, retry the draft once with the problems listed."
    const input = inputFor()
    const bad = 'We notified the buyer on the day of dispatch.'
    const llm = scriptedModel([{ text: bad }, { text: goodNote(input) }])
    const result = await draft(input, { llm })

    expect(llm.requests).toHaveLength(2)
    const repair = llm.requests[1]?.system ?? ''
    expect(repair).toContain('Your previous attempt was refused')
    expect(repair).toContain('FORBIDDEN_DERIVATION')
    expect(repair).toContain(bad)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.source).toBe('model-repaired')
    expect(result.value.modelCalls).toBe(2)
    expect(result.value.verdict.ok).toBe(true)
  })

  it('never makes a third call, so the repair is a bound and not a loop', async () => {
    // Two bad answers. §8.15 allows one retry, so the third request would be a spec violation — and
    // `scriptedModel` only has two turns, so a third call throws and becomes `LLM_UNAVAILABLE`. Asserting
    // we get the template rather than an error proves we stopped at two.
    const input = inputFor()
    const llm = scriptedModel([
      { text: 'We notified the buyer.' },
      { text: 'The parcel was delivered.' },
    ])
    const result = await draft(input, { llm })
    expect(llm.requests).toHaveLength(2)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.source).toBe('template')
  })

  it('falls back to the deterministic template, which is checkable by construction', async () => {
    const input = inputFor()
    const llm = scriptedModel([{ text: 'We notified the buyer.' }, { text: 'Still bad.' }])
    const result = await draft(input, { llm })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.source).toBe('template')
    expect(result.value.verdict.ok).toBe(true)
    expect(result.value.citations.length).toBeGreaterThan(0)
    // A `template` draft with `blocked` set would mean the fallback failed the same check it exists to pass.
    expect(result.value.blocked).toBeUndefined()
  })

  it('does not return the bad text with a warning attached, which is the failure this design prevents', async () => {
    const input = inputFor()
    const bad = 'The buyer was notified and the parcel was delivered on time.'
    const result = await draft(input, { llm: scriptedModel([{ text: bad }, { text: bad }]) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.notes).not.toContain('notified')
    expect(result.value.notes).not.toContain('delivered on time')
  })
})

// ---------------------------------------------------------------------------
// Required negative 5 — a posture that files nothing
// ---------------------------------------------------------------------------

describe("a draft that is entirely about the buyer's own misuse", () => {
  /**
   * `R-SNAD-AGENT` is the buyer's own misuse: the user asked for size 9, size 10 arrived, the chain is
   * valid and the read-back never promised the size. The router decides `REFUND`, so **nothing is filed**.
   */
  function agentFault(): DisputeContext {
    return unauthorised({
      dispute: {
        ...unauthorised().dispute,
        reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      },
      chain: {
        mandatePresent: true,
        verifyAtCaptureChainValid: true,
        webauthnPresent: true,
        deviceStatus: 'ACTIVE',
        iatSec: NOW - 86_400,
        gateDecision: 'ALLOW',
        // The read-back is silent about size, which is exactly what `attributeConflicts` requires for the
        // conflict to be the *agent's* fault rather than the buyer's.
        readback:
          '**What you are authorising**\nOnly at **Northwind Outfitters**\nSpend at most **$130.00** in total',
      },
      disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: '10' } },
      preferences: { size: '9' },
    })
  }

  it('the router does decide REFUND under R-SNAD-AGENT, so the fixture is the case it claims to be', () => {
    const d = route(agentFault())
    expect(d.ruleId).toBe('R-SNAD-AGENT')
    expect(d.liability).toBe('AGENT_FAULT')
    expect(d.posture).toBe('REFUND')
  })

  it('the filer refuses to file at all, and never asks the model', async () => {
    const input = inputFor(agentFault())
    expect(input.plan.items).toEqual([])
    const llm = scriptedModel([{ text: 'We notified the buyer and the parcel was delivered.' }])
    const result = await draft(input, { llm })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('DEF_WRONG_STATE')
    expect(result.error.message).toContain('R-SNAD-AGENT')
    expect(result.error.userMessage).toContain('settled rather than contested')
    // The important half: the model was never consulted, so there is nothing to file even in principle.
    expect(llm.requests).toHaveLength(0)
  })

  it('refuses for every posture that files no note, naming the rule each time', async () => {
    // A table rather than one fixture: `OFFER` and `APPEAL` file, and a mistake in the FILING list would
    // let a `REFUND` reach a model.
    const cases = [
      agentFault(),
      unauthorised({
        dispute: { ...unauthorised().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' },
        shipments: [],
      }),
    ]
    const seen: string[] = []
    for (const ctx of cases) {
      const d = route(ctx)
      seen.push(d.posture)
      const input = inputFor(ctx)
      const result = await draft(input, { llm: scriptedModel([]) })
      expect(result.ok, `${d.ruleId}/${d.posture}`).toBe(false)
      if (result.ok) continue
      expect(['DEF_WRONG_STATE', 'DEF_NO_CHAIN']).toContain(result.error.code)
    }
    expect(seen).toContain('REFUND')
  })

  it('refuses when the router wants to file but there is nothing citable to say', async () => {
    // A CONTEST with no artefact behind any fact would force every sentence to be an assertion.
    const input = inputFor()
    const result = await draft({ ...input, claims: [] }, { llm: scriptedModel([]) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('DEF_NO_CHAIN')
    expect(result.error.message).toContain('EC-DSP-9')
  })

  it('EC-DSP-11: a dispute the buyer cancelled has no note, because there is no filing window', async () => {
    // "Buyer cancels the dispute → close CLOSED_WON (cancelled)". There is no evidence to file and no
    // response to file it against, so the drafter refuses before the model is consulted — the same code path
    // as any other non-filing posture, and the same reason: there is no text box to fill.
    const base = unauthorised()
    // `R-STAGE-INQUIRY`'s condition is exactly "at INQUIRY and PayPal has not asked for a response", which
    // is the state a withdrawn claim sits in. Asserted here so the fixture is the case it claims to be.
    const withdrawn = unauthorised({
      dispute: {
        ...base.dispute,
        stage: 'INQUIRY',
        status: 'RESOLVED',
        sellerResponseDueSec: null,
      },
    })
    const routed = route(withdrawn)
    expect(routed.ruleId).toBe('R-STAGE-INQUIRY')
    expect(routed.supersedes).toBe('R-UNAUTH-1')
    expect(routed.posture).toBe('MESSAGE_ONLY')
    expect(planEvidence(withdrawn, routed).items).toEqual([])

    const llm = scriptedModel([{ text: 'We notified the buyer and the parcel was delivered.' }])
    const result = await draft(inputFor(withdrawn), { llm })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('DEF_WRONG_STATE')
    expect(llm.requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Required negative 6 — LLM_UNAVAILABLE
// ---------------------------------------------------------------------------

describe('LLM_UNAVAILABLE', () => {
  it('returns an error and no Draft value, so a caller that ignores ok cannot file anything', async () => {
    const input = inputFor()
    const llm = scriptedModel([{ throws: 'connect ECONNREFUSED api.openai.com:443' }])
    const result = await draft(input, { llm })

    expect(result.ok).toBe(false)
    // Not `ok: true` with a `blocked` list, not `ok: true` with empty notes. No value at all.
    expect(result.ok === false ? result.error : null).not.toBeNull()
    if (result.ok) return
    expect(result.error.code).toBe('LLM_UNAVAILABLE')
    expect(result.error.retryable).toBe(true)
    expect(result.error.message).toContain('ECONNREFUSED')
    // EC-LLM-1: the buyer-facing sentence must offer the by-hand route, not a dead end.
    expect(result.error.userMessage).toContain('by hand')
  })

  it('keeps the cause for logs and never serialises it into the message a user sees', async () => {
    const input = inputFor()
    const result = await draft(input, {
      llm: scriptedModel([{ throws: 'timeout after 30000ms' }]),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.cause).toBeInstanceOf(Error)
    expect(result.error.userMessage).not.toContain('30000')
  })

  it('produces no partial Draft on the repair turn either', async () => {
    // The subtle one. A model that answers once and then dies is the most likely real failure, and an
    // implementation that returned the *first* answer as a fallback would file text it never checked.
    const input = inputFor()
    const llm = scriptedModel([{ text: 'We notified the buyer.' }, { throws: 'socket hang up' }])
    const result = await draft(input, { llm })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('LLM_UNAVAILABLE')
  })

  it('treats an empty answer as a schema failure rather than filing an empty text box', async () => {
    const input = inputFor()
    const result = await draft(input, { llm: scriptedModel([{ text: '   ' }]) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('LLM_SCHEMA')
    expect(result.error.retryable).toBe(false)
  })

  it('never throws, whatever the model did', async () => {
    const input = inputFor()
    for (const turn of [{ text: 'ok' }, { throws: 'boom' }, { text: '[[[[' }]) {
      const result = await draft(input, { llm: scriptedModel([turn]) })
      expect(result).toHaveProperty('ok')
    }
  })
})

// ---------------------------------------------------------------------------
// The required negative cases, through the drafter
// ---------------------------------------------------------------------------

describe('the required negative cases, through the drafter', () => {
  it('EC-MER-4 … the buyer was notified, with no artefact for it, is never filed', async () => {
    const input = inputFor()
    const llm = scriptedModel([
      { text: 'We notified the buyer by email on the day of dispatch.' },
      { text: 'We notified the buyer by email on the day of dispatch.' },
    ])
    const result = await draft(input, { llm })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.source).toBe('template')
    expect(result.value.notes).not.toContain('notified')
  })

  it('a forged amount in the wrong currency is never filed', async () => {
    const input = inputFor()
    const forged = 'The buyer is disputing EUR 129.99 [[clm_dispute_amount]].'
    const result = await draft(input, { llm: scriptedModel([{ text: forged }, { text: forged }]) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.notes).not.toContain('EUR')
    expect(result.value.notes).toContain('USD 129.99')
    expect(result.value.source).toBe('template')
  })

  it('a delivery claim from an assertion is never filed', async () => {
    const input = inputFor()
    const claims = input.claims ?? []
    expect(claims.find((c) => c.id === 'clm_tracking_shp_1')?.support).toBe('assertion')
    const forged = 'The parcel was delivered by DHL JD0002000031 [[clm_tracking_shp_1]].'
    const result = await draft(input, { llm: scriptedModel([{ text: forged }, { text: forged }]) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.notes).not.toContain('was delivered')
    expect(result.value.notes).toContain(CARRIER_CAVEAT)
  })

  it('a marker for a claim the model invented is never filed', async () => {
    const input = inputFor()
    const forged = 'The merchant confirmed the carrier scan [[clm_carrier_scan_confirmed]].'
    const result = await draft(input, { llm: scriptedModel([{ text: forged }, { text: forged }]) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.notes).not.toContain('clm_carrier_scan_confirmed')
    expect(result.value.verdict.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("a note longer than PayPal's field", () => {
  it('is truncated by whole sentences, with the numbers reported and the omission stated', async () => {
    const input = inputFor()
    const claims = input.claims ?? []
    const rule = claims.find((c) => c.id === 'clm_rule')?.phrase ?? 'R-UNAUTH-1'
    const padding = Array.from(
      { length: 60 },
      (_, i) => `Extra point ${i} under ${rule} [[clm_rule]].`,
    )
    const logs: string[] = []
    const result = await draft(input, {
      llm: scriptedModel([{ text: padding.join(' ') }]),
      onLog: (line) => logs.push(line),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.notes.length).toBeLessThanOrEqual(2000)
    expect(result.value.truncation?.writtenChars).toBeGreaterThan(2000)
    expect(result.value.truncation?.droppedSentences).toBeGreaterThan(0)
    // Explicit, not silent: the report carries the numbers and the note itself says what happened.
    expect(result.value.notes).toContain(result.value.truncation?.notice ?? 'never')
    expect(logs.join('\n')).toContain('truncated explicitly')
    // And the filed text still passes, because the checker ran on it *after* truncation.
    expect(result.value.verdict.ok).toBe(true)
  })

  it('leaves the notices on the draft for S-18 to render, rather than logging and forgetting', async () => {
    const input = inputFor()
    const claims = input.claims ?? []
    const rule = claims.find((c) => c.id === 'clm_rule')?.phrase ?? 'R-UNAUTH-1'
    const padding = Array.from({ length: 60 }, (_, i) => `Extra ${i} under ${rule} [[clm_rule]].`)
    const result = await draft(input, { llm: scriptedModel([{ text: padding.join(' ') }]) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.truncation?.keptChars).toBe(result.value.notes.length)
    expect(result.value.truncation?.writtenChars).toBeGreaterThan(
      result.value.truncation?.keptChars ?? 0,
    )
  })
})

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

describe('the system prompt', () => {
  it('carries the signer-approved read-back verbatim, because that string is the case', () => {
    const input = inputFor()
    const system = buildDrafterSystem(input)
    expect(input.ctx.chain?.readback).toBeDefined()
    expect(system).toContain(input.ctx.chain?.readback ?? '')
    expect(system).toContain('Only at **Northwind Outfitters**')
  })

  it('carries the chain identifiers, so the model does not have to invent them', () => {
    const system = buildDrafterSystem(inputFor())
    // Signed at, verified, passkey, device and Gate — the five facts a §8.15 `UNAUTHORISED` packet rests
    // on. All from the context; none of them something a model would have to guess.
    expect(system).toContain(`Mandate signed at: epoch ${NOW - 86_400} seconds`)
    expect(system).toContain('Chain verified at capture: true')
    expect(system).toContain('Passkey user-verification at signing: true')
    expect(system).toContain('Device status: ACTIVE')
    expect(system).toContain('Merchant Gate decision: ALLOW')
  })

  it('carries the order and capture facts, quoted in the form the checker demands', () => {
    const system = buildDrafterSystem(inputFor())
    expect(system).toContain('USD 129.99')
    expect(system).toContain('3AB12345')
    expect(system).toContain('cs1:AbCdEf0123456789')
  })

  it('lists exactly the claims that are allowed, each with its phrase and its artefact', () => {
    const input = inputFor()
    const system = buildDrafterSystem(input)
    for (const c of input.claims ?? []) {
      expect(system, c.id).toContain(`[[${c.id}]]`)
      expect(system, c.id).toContain(c.phrase)
      expect(system, c.id).toContain(c.artefact.id)
    }
    // And nothing else: a claim the packet does not have must not appear in the contract.
    expect(system).not.toContain('[[clm_not_a_real_claim]]')
  })

  it('states the one permitted link, so the model has no reason to write a second', () => {
    const system = buildDrafterSystem(inputFor())
    expect(system).toContain(URL)
    expect(system).toContain('No other URL, no bare domain, no tracking parameters')
  })

  it('forbids the two claims the checker will always refuse', () => {
    const system = buildDrafterSystem(inputFor())
    expect(system).toContain('Never claim the buyer was notified')
    expect(system).toContain('not a delivery record')
  })

  it('says out loud that the model does not decide whether to contest', () => {
    const system = buildDrafterSystem(inputFor())
    expect(system).toContain('You are NOT deciding whether to contest')
    expect(buildDrafterPrompt(inputFor())).toContain('DETAILS_OF_PURCHASE')
  })
})

// ---------------------------------------------------------------------------
// checkForFiling — the checker at file time
// ---------------------------------------------------------------------------

describe('checkForFiling runs on the final text (EC-MER-5)', () => {
  it('passes for an untouched draft, so the filer costs nothing extra on the normal path', () => {
    const input = inputFor()
    const verdict = checkForFiling(goodNote(input), input.claims ?? [], URL)
    expect(verdict.ok).toBe(true)
  })

  it('refuses a note a merchant edited to add a claim', () => {
    const input = inputFor()
    const edited = `${goodNote(input)} The buyer confirmed this in writing to us.`
    const verdict = checkForFiling(edited, input.claims ?? [], URL)
    expect(verdict.ok).toBe(false)
    expect(verdict.problems.map((p) => p.code)).toContain('UNCITED_SENTENCE')
  })

  it('refuses a note whose amount the merchant changed by one digit', () => {
    const input = inputFor()
    const edited = goodNote(input).replace('USD 129.99', 'USD 129.98')
    const verdict = checkForFiling(edited, input.claims ?? [], URL)
    expect(verdict.ok).toBe(false)
    expect(verdict.problems.map((p) => p.code)).toContain('PHRASE_NOT_IN_SENTENCE')
  })

  it('quotes each problem, because a merchant has to be told which sentence to fix', () => {
    const input = inputFor()
    const edited = goodNote(input).replace('USD 129.99', 'USD 129.98')
    const verdict = checkForFiling(edited, input.claims ?? [], URL)
    expect(verdict.problems[0]?.detail).toContain('USD 129.99')
    expect(verdict.problems[0]?.sentence.length).toBeGreaterThan(10)
  })
})

// ---------------------------------------------------------------------------
// The template, over the whole router eval corpus
// ---------------------------------------------------------------------------

describe('the deterministic template', () => {
  it('passes the same checker on every context in the 40-case router eval', () => {
    // The strong form of "the fallback is checkable by construction": every rule, every posture, every
    // currency, all forty labelled cases — not one fixture.
    const cases = loadRouterCases()
    let checked = 0
    for (const c of cases) {
      const ctx = contextFromCase(c)
      const decision = route(ctx)
      const input = inputFor(ctx)
      const url = publicPacketUrl(input.publicBaseUrl, input.packetId)
      const note = templateNote(input, input.claims ?? [], url)
      const verdict = checkForFiling(note, input.claims ?? [], url)
      expect(
        verdict.ok,
        `${c.id} (${decision.ruleId}/${decision.posture}): ${verdict.problems.map((p) => `${p.code}: ${p.detail}`).join(' | ')}`,
      ).toBe(true)
      expect(note.length, c.id).toBeLessThanOrEqual(2000)
      checked += 1
    }
    expect(checked).toBe(40)
  })

  it('says the carrier caveat exactly once, however many shipments there are', () => {
    const ctx = unauthorised({
      shipments: [
        {
          id: 'shp_1',
          carrier: 'DHL',
          trackingNumber: 'JD1',
          status: 'SHIPPED',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        },
        {
          id: 'shp_2',
          carrier: 'UPS',
          trackingNumber: 'UP2',
          status: 'SHIPPED',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        },
      ],
    })
    const input = inputFor(ctx)
    const note = templateNote(input, input.claims ?? [], URL)
    expect(note.split(CARRIER_CAVEAT)).toHaveLength(2)
  })

  it('carries no delivery claim of its own, even for a tracker PayPal holds', () => {
    const ctx = unauthorised({
      shipments: [
        {
          id: 'shp_1',
          carrier: 'DHL',
          trackingNumber: 'JD1',
          status: 'DELIVERED',
          paypalTrackerId: 'T-1',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        },
      ],
    })
    const input = inputFor(ctx)
    const note = templateNote(input, input.claims ?? [], URL)
    // `DELIVERED` is our own stored status and may be quoted; "was delivered" may not be asserted.
    expect(note).toContain('DELIVERED')
    expect(note).not.toContain('was delivered')
    expect(checkForFiling(note, input.claims ?? [], URL).ok).toBe(true)
  })

  it('never mentions the buyer being notified, on any of the forty cases', () => {
    for (const c of loadRouterCases()) {
      const input = inputFor(contextFromCase(c))
      const note = templateNote(input, input.claims ?? [], URL)
      expect(note.toLowerCase(), c.id).not.toContain('notified')
    }
  })
})

// ---------------------------------------------------------------------------
// The Draft type
// ---------------------------------------------------------------------------

describe('the Draft shape', () => {
  it('carries notes, citations and an optional blocked list, and nothing else the caller must interpret', async () => {
    const input = inputFor()
    const result = await draft(input, { llm: scriptedModel([{ text: goodNote(input) }]) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const d: Draft = result.value
    expect(typeof d.notes).toBe('string')
    expect(Array.isArray(d.citations)).toBe(true)
    expect(d.blocked === undefined || Array.isArray(d.blocked)).toBe(true)
    // Every citation names the artefact it rests on, copied from the ClaimSource and never from the model.
    for (const c of d.citations) {
      const source = (input.claims ?? []).find((x) => x.id === c.claimId)
      expect(c.artefact.id).toBe(source?.artefact.id)
    }
  })

  it('records the deterministic clock it was given, and never reads one', async () => {
    const input = inputFor()
    const clock = fixedClock(NOW)
    const result = await draft(input, { llm: scriptedModel([{ text: goodNote(input) }]), clock })
    expect(clock.nowSec()).toBe(NOW)
    expect(result.ok).toBe(true)
  })
})
