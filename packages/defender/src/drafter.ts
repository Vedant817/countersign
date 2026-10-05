/**
 * `draft()` — spec **§8.15**'s `draftNotes`, work package **WP-15c**.
 *
 * ```ts
 * const result = await draft({ ctx, decision, plan, packetId, publicBaseUrl, claims }, { llm })
 * // result.ok === false → never file. Either DEF_WRONG_STATE, LLM_UNAVAILABLE or DEF_CITATION_FAILED.
 * ```
 *
 * ## The division of labour, which is the whole product claim
 *
 * Spec **§8.15** gives the drafter one job and **§18 question 27** gives the checker another:
 *
 * > "**The model plans and drafts, and a deterministic checker decides whether the text is allowed to
 * > be filed.**"
 *
 * So this file is allowed to be the only part of the Defender that talks to a model, and it is allowed
 * to produce nonsense. What it is not allowed to do is *keep* anything. Every path out of `draft()`
 * runs {@link checkCitations} over the **final** text, in this order:
 *
 * ```text
 * model text ──▶ check ──▶ ok? ──yes──▶ truncate ──▶ check ──▶ ok? ──yes──▶ FILE
 *                          │no                              │no
 *                          ▼                                ▼
 *                    retry once, problems              deterministic template ──▶ check ──▶ FILE
 *                    listed (§8.15)                                  │no
 *                                                            DEF_CITATION_FAILED
 * ```
 *
 * Three properties the diagram is asserting, each pinned by a test in `test/drafter.test.ts`:
 *
 * 1. **`LLM_UNAVAILABLE` produces no partial `Draft`.** Not a `Draft` with `blocked`, not a `Draft` with
 *    empty `notes` — no value at all. A caller that ignores `ok` and reads `.notes` gets `undefined` and
 *    fails, rather than filing the empty string to PayPal.
 * 2. **The checker runs on the final text, after truncation** (spec **EC-MER-5**: "The citation checker
 *    runs on the **final** text at file time"). Truncation drops whole sentences, so re-checking is
 *    what makes the citation list a list of what is *in the packet* rather than what the model wrote.
 * 3. **A posture that files nothing never reaches the model.** `R-SNAD-AGENT` decided `REFUND`; asking a
 *    model to write an argument for it is asking it to argue against our own finding, and the answer
 *    would then need a checker to notice. `draft()` returns `DEF_WRONG_STATE` before it calls anything.
 *
 * ## The prompt is not the control
 *
 * The system prompt (§8.15's shape: the signer-approved read-back, the chain identifiers, the order and
 * capture facts, and **the exact list of claims that are allowed**) exists to give the model the best
 * chance of passing. It is not what stops a bad draft. A prompt is a request; the checker is a rule. If
 * the prompt were the control, every one of the six required negative tests would be a test of the
 * model's mood on the day — and the day a model is confidently wrong is exactly the day a merchant's
 * good customer gets a dispute filed against them.
 *
 * ## No model import, in this file or in the checker's
 *
 * `draft()` takes an injected {@link LanguageModel} port rather than importing `ai`, and
 * `checkCitations.ts` is on ESLint's `no-restricted-imports` ban list alongside `rules.ts` / `router.ts`
 * / `rationale.ts`. The consequence is stronger than it looks: **nothing in this package imports a model
 * runtime.** The caller supplies a function; the package never learns which SDK, or whether there is
 * one, is behind it. `docs/HUMAN_TODO.md` H-02 (no OpenAI key) therefore cannot affect a single test
 * here, which is why the 20-case eval in `eval/drafter-cases.jsonl` scores a committed transcript.
 */

import { csError, err, ok, type Clock, type CsError, type Result } from '@countersign/core'

import {
  BOILERPLATE_SENTENCES,
  TRUNCATION_NOTICE,
  checkCitations,
  claimSourcesFor,
  formatProblems,
  publicAddressSentence,
  publicPacketUrl,
  splitSentences,
  stripMarkers,
  truncateNotes,
  type Citation,
  type CitationProblem,
  type CitationVerdict,
  type ClaimSource,
} from './citation-check'
import {
  NOTES_MAX_CHARS,
  type DisputeContext,
  type EvidencePlan,
  type LiabilityDecision,
} from './types'

// ---------------------------------------------------------------------------
// The types §8.15 names
// ---------------------------------------------------------------------------

/**
 * What the model may be asked to do: **return text**.
 *
 * Not `generateText`, not a structured-output schema, and deliberately not the AI SDK's `LanguageModel`
 * type. The port is one function, so a caller can satisfy it with
 * `(system, prompt) => generateText({ model, system, prompt, temperature: 0 }).then((r) => r.text)`
 * and the package still never imports `ai`. A narrower port is also a narrower attack surface: the model
 * cannot be handed a tool to call, so "the model did something" is not a state this code can reach.
 */
export interface LanguageModel {
  readonly generateText: (request: {
    readonly system: string
    readonly prompt: string
  }) => Promise<{ readonly text: string }>
}

/** Where the text in a {@link Draft} came from. Recorded so S-18 can say which it is showing. */
export type DraftSource = 'model' | 'model-repaired' | 'template'

export interface Draft {
  /**
   * The note to file. **A string, not `string[]`** — PayPal's `evidence.notes` is
   * `minLength 1, maxLength 2000` (`SPEC-D`), corrected from `string[]` in spec D-012 and enforced by
   * `@countersign/paypal`'s `provideEvidenceInputSchema`. `Test 3` below pins both facts.
   */
  readonly notes: string
  /**
   * One entry per cited sentence, in filing order, each naming the artefact that backs it.
   *
   * Persisted to `evidence_packets.citations` (spec §7.2), so a packet row carries the same
   * sentence→artefact mapping the checker verified. It is **not** model output: every field is copied
   * from a {@link ClaimSource}, so a mis-copied artefact id cannot survive the copy.
   */
  readonly citations: readonly Citation[]
  /**
   * Why the checker refused, one quotable line each, or absent.
   *
   * **Present and non-empty only when the model wrote something we would not file.** The deterministic
   * template is composed from facts and passes the same check, so a `template` draft with `blocked` set
   * is a bug in this package and is asserted not to be.
   */
  readonly blocked?: readonly string[]
  /** Which of the three sources produced `notes`. */
  readonly source: DraftSource
  /** The checker's full verdict, including the problems. Persisted to `evidence_packets.citation_check`. */
  readonly verdict: CitationVerdict
  /** Present whenever `notes` is not the model's own text, and whenever anything was dropped. */
  readonly truncation?: TruncationReportLike
  /** Number of model calls made: 0, 1 or 2. §8.15 allows exactly one repair turn. */
  readonly modelCalls: number
}

/** Structurally {@link TruncationReport} from `citation-check.ts`, re-declared so this file's public surface is self-contained. */
export interface TruncationReportLike {
  readonly writtenChars: number
  readonly keptChars: number
  readonly droppedSentences: number
  readonly notice: string
}

export interface DraftInput {
  readonly ctx: DisputeContext
  readonly decision: LiabilityDecision
  readonly plan: EvidencePlan
  /** `evidence_packets.id`. Goes in the QR and in the one permitted URL. */
  readonly packetId: string
  /** `PUBLIC_BASE_URL`. Operator-configured, and the only host a note may name. */
  readonly publicBaseUrl: string
  /** Defaults to `claimSourcesFor(ctx, decision)`. Injectable so a test can prove the checker, not the derivation, refuses. */
  readonly claims?: readonly ClaimSource[]
}

export interface DraftDeps {
  readonly llm: LanguageModel
  /** Used only for the log line. Never for content: nothing in a note is "now". */
  readonly clock?: Clock
  readonly onLog?: (line: string) => void
}

// ---------------------------------------------------------------------------
// The prompt (§8.15's shape)
// ---------------------------------------------------------------------------

/**
 * Build the system prompt: the signer-approved read-back, the chain identifiers, the order and capture
 * facts, and **the exact list of claims that are allowed**.
 *
 * The read-back is included verbatim because §8.17's argument is that the signed read-back is the single
 * string the buyer approved, and a note that paraphrases it is asserting something the buyer never saw.
 * EC-MER-6 is why it is a hard requirement rather than a nicety: omitting the read-back is how a merchant
 * would hide the part that hurts them, so the packet always carries it.
 *
 * The prompt states the output contract explicitly — `[[claim_id]]` after every sentence that asserts
 * something, and the boilerplate allowlist — because a model that does not know the contract produces
 * text the checker must refuse, and refusing costs a human. Asking properly is cheaper than blocking.
 */
export function buildDrafterSystem(input: DraftInput, repair?: readonly string[]): string {
  const { ctx, decision } = input
  const claims = input.claims ?? claimSourcesFor(ctx, decision)
  const allowedUrl = publicPacketUrl(input.publicBaseUrl, input.packetId)
  const chain = ctx.chain ?? {}

  const lines: string[] = [
    'You are writing the `notes` text-box for one PayPal dispute evidence packet.',
    '',
    'You are NOT deciding whether to contest. A deterministic rules table already decided that, and it',
    'cannot be changed by anything you write. You are writing the prose for a decision that exists.',
    '',
    '## What the rules table decided',
    `Rule: ${decision.ruleId}`,
    `Posture: ${decision.posture}`,
    `Liability: ${decision.liability}`,
    `Deterministic rationale: ${decision.rationale}`,
    '',
    '## The facts you are allowed to assert, and nothing else',
    'Every sentence that asserts something must end with one or more `[[claim_id]]` markers, using the',
    'ids below and copying the quoted text into the sentence **verbatim**.',
    '',
  ]
  for (const c of claims) {
    lines.push(`- [[${c.id}]] — you must write exactly "${c.phrase}" when you use this claim.`)
    lines.push(`  Artefact: ${c.artefact.id} (${c.artefact.description}).`)
    lines.push(`  ${c.instruction}`)
  }
  lines.push(
    '',
    '## Sentences that need no marker',
    'Only these, word for word:',
    ...BOILERPLATE_SENTENCES.filter((s) => s !== TRUNCATION_NOTICE).map((s) => `- ${s}`),
    'Anything else without a marker is refused, so do not add your own framing sentences.',
    '',
    '## The signed chain',
    `Mandate read-back, exactly as the buyer approved it:\n${chain.readback ?? '(no read-back recorded)'}`,
    `Mandate signed at: ${chain.iatSec === undefined ? 'not recorded' : `epoch ${chain.iatSec} seconds`}`,
    `Chain verified at capture: ${String(chain.verifyAtCaptureChainValid)}`,
    `Passkey user-verification at signing: ${String(chain.webauthnPresent)}`,
    `Device status: ${chain.deviceStatus ?? 'not recorded'}`,
    `Merchant Gate decision: ${chain.gateDecision ?? 'not recorded'}`,
    '',
    '## Order and capture',
    `Disputed amount: ${decision.facts.find((f) => f.key === 'dispute.amount')?.value ?? 'unknown'}`,
    `Capture id: ${ctx.capture?.paypalCaptureId ?? 'none'}`,
    `Order custom_id: ${ctx.order?.customId ?? 'none'}`,
    '',
    '## Hard rules',
    `1. One link only, and it must be this exact sentence: "${publicAddressSentence(allowedUrl)}"`,
    '2. No other URL, no bare domain, no tracking parameters.',
    '3. Never claim the buyer was notified. We hold no artefact for that.',
    '4. A tracking number the merchant typed is not a delivery record. Never write "delivered",',
    '   "confirmed by the carrier", or anything like it from a merchant-entered tracking number.',
    `5. At most ${NOTES_MAX_CHARS} characters. Write short, complete sentences.`,
    '6. Money is an integer amount plus its ISO-4217 code, exactly as quoted above. Never convert.',
  )
  if (repair !== undefined && repair.length > 0) {
    lines.push(
      '',
      '## Your previous attempt was refused',
      'A deterministic checker — not a judgement — rejected it. Every sentence below is the reason. Fix',
      'each one and return the whole note again. Do not argue, and do not explain.',
      ...repair.map((r) => `- ${r}`),
    )
  }
  return lines.join('\n')
}

/** The user turn. Kept short so the system turn stays the instruction and this stays the case. */
export function buildDrafterPrompt(input: DraftInput): string {
  const { ctx, plan } = input
  return [
    `Evidence types being filed: ${plan.items.map((i) => i.evidenceType).join(', ') || '(none)'}`,
    `Buyer claim: ${ctx.dispute.reason}`,
    `Respond now with the note text only. No preamble, no markdown, no headings.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------

/** The postures that put something in a text box at PayPal. Mirrors `planner.ts`'s `FILING`. */
const FILING_POSTURES: readonly LiabilityDecision['posture'][] = [
  'CONTEST',
  'ACCEPT_CLAIM',
  'APPEAL',
  'OFFER',
]

/**
 * Draft the note, or say why it may not be drafted.
 *
 * Never throws. Every failure is a `CsError` whose `code` comes from the §8.1 registry, because this
 * function's callers are a job and a UI (AGENTS.md rule 3).
 */
export async function draft(input: DraftInput, deps: DraftDeps): Promise<Result<Draft, CsError>> {
  const { ctx, decision } = input
  const claims = input.claims ?? claimSourcesFor(ctx, decision)
  const allowedUrl = publicPacketUrl(input.publicBaseUrl, input.packetId)
  const log = deps.onLog ?? ((): void => {})

  // --- 1. Is there a text box to fill? -------------------------------------------------------------
  if (!FILING_POSTURES.includes(decision.posture) || input.plan.items.length === 0) {
    return err(
      csError(
        'DEF_WRONG_STATE',
        `Rule ${decision.ruleId} decided ${decision.posture}, which files no note, so nothing may be ` +
          `drafted or filed for this dispute. A drafted argument for a decision to pay the buyer is ` +
          'exactly the artefact the router exists to prevent.',
        { ruleId: decision.ruleId, posture: decision.posture, packetId: input.packetId },
        {
          userMessage:
            'This case is being settled rather than contested, so there is no evidence note to write.',
        },
      ),
    )
  }

  // --- 2. Is there anything citable? ----------------------------------------------------------------
  if (claims.length === 0) {
    return err(
      csError(
        'DEF_NO_CHAIN',
        `No claim on this packet has an artefact behind it, so every sentence would be an assertion. ` +
          `Rule ${decision.ruleId} should not have produced a filing posture here (EC-DSP-9).`,
        { ruleId: decision.ruleId, packetId: input.packetId },
      ),
    )
  }

  // --- 3. One call, then at most one repair (§8.15: "retry the draft once with the problems listed") ---
  //
  // `ignoreLength` on the first pass, for a reason worth stating: truncation happens *after* this check and
  // before the next one, so checking the length here as well would refuse every long-but-honest note and
  // send it down the repair turn for a problem the drafter is about to solve itself. Skipping it here cannot
  // hide anything, because the truncated text is checked immediately afterwards with the limit in force.
  const first = await ask(deps.llm, input, allowedUrl, undefined)
  if (!first.ok) return first
  let modelCalls = 1

  let attempt = first.value
  let verdict = checkCitations({ notes: attempt }, claims, { allowedUrl, ignoreLength: true })
  if (!verdict.ok) {
    log(
      `defender.draft: first attempt refused (${verdict.problems.length} problem(s), rule ` +
        `${decision.ruleId}); one repair turn allowed`,
    )
    const repair = await ask(deps.llm, input, allowedUrl, formatProblems(verdict.problems))
    if (!repair.ok) return repair
    modelCalls = 2
    attempt = repair.value
    verdict = checkCitations({ notes: attempt }, claims, { allowedUrl, ignoreLength: true })
  }

  // --- 4. If it passed, file the model's text — truncated, then checked again -------------------------
  if (verdict.ok) {
    const trimmed = truncateNotes(attempt)
    const finalVerdict =
      trimmed.report === null
        ? verdict
        : checkCitations({ notes: trimmed.notes }, claims, { allowedUrl })
    if (finalVerdict.ok) {
      if (trimmed.report !== null) {
        log(
          `defender.draft: note truncated explicitly, ${trimmed.report.writtenChars} chars written, ` +
            `${trimmed.report.keptChars} kept, ${trimmed.report.droppedSentences} whole sentence(s) ` +
            `dropped; notice: "${trimmed.report.notice}"`,
        )
      }
      return ok({
        notes: trimmed.notes,
        citations: finalVerdict.citations,
        source: modelCalls === 2 ? 'model-repaired' : 'model',
        verdict: finalVerdict,
        ...(trimmed.report === null ? {} : { truncation: trimmed.report }),
        modelCalls,
      })
    }
    // Truncation broke a valid note. Not a third model call — §8.15 allows one retry — so fall through to
    // the template, and say why in the log rather than filing something we half believe.
    log(
      'defender.draft: the model note passed before truncation and failed after it, so the note is ' +
        'rebuilt from the deterministic template. This is a defect in truncateNotes, not a model fault.',
    )
  } else {
    log(
      `defender.draft: refused after ${modelCalls} call(s); ${verdict.problems.length} problem(s). ` +
        'Falling back to the deterministic template note.',
    )
  }

  // --- 5. The deterministic template — the same check, no model, no excuse --------------------------------
  const template = templateNote(input, claims, allowedUrl)
  const templateVerdict = checkCitations({ notes: template }, claims, { allowedUrl })
  if (!templateVerdict.ok) {
    // Unreachable by construction: every sentence below is either boilerplate or carries its claim's
    // own phrase. Kept anyway, because the whole point of this package is that "unreachable" is asserted
    // rather than believed — `test/drafter.test.ts` runs it over all 40 eval contexts.
    return err(
      csError(
        'DEF_CITATION_FAILED',
        `The deterministic template note failed its own citation check, which is a defect in ` +
          `packages/defender, not in the model's answer: ${formatProblems(templateVerdict.problems).join(' ')}`,
        {
          ruleId: decision.ruleId,
          packetId: input.packetId,
          problems: templateVerdict.problems.map((p) => p.code),
        },
      ),
    )
  }
  return ok({
    notes: template,
    citations: templateVerdict.citations,
    source: 'template',
    verdict: templateVerdict,
    modelCalls,
  })
}

/** One model call, with the throw converted. A throw becomes `LLM_UNAVAILABLE` and **no value**. */
async function ask(
  llm: LanguageModel,
  input: DraftInput,
  allowedUrl: string,
  repair: readonly string[] | undefined,
): Promise<Result<string, CsError>> {
  const request = {
    system: buildDrafterSystem(input, repair),
    prompt: buildDrafterPrompt(input),
  }
  try {
    const result = await llm.generateText(request)
    const text = typeof result.text === 'string' ? result.text : ''
    if (text.trim().length === 0) {
      return err(
        csError(
          'LLM_SCHEMA',
          'The model returned no text for the dispute note, so there is nothing to check or file.',
          { ruleId: input.decision.ruleId, packetId: input.packetId },
        ),
      )
    }
    // A model that answers with a fenced block would otherwise ship the fences to PayPal.
    return ok(unfence(text))
  } catch (cause) {
    // EC-LLM-1. `retryable: true` comes from the registry, so the caller can offer "try later" and the
    // deterministic template path stays available (spec §18 question 35).
    return err(
      csError(
        'LLM_UNAVAILABLE',
        `The model could not be reached while drafting the evidence note, so nothing was drafted and ` +
          `nothing will be filed from it. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
        { ruleId: input.decision.ruleId, packetId: input.packetId },
        { cause },
      ),
    )
  }
}

/** Strip a leading ```` ``` ```` fence and a `notes:`-style prefix. Models do both. */
function unfence(text: string): string {
  let out = text.trim()
  const fence = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/.exec(out)
  if (fence !== null && fence[1] !== undefined) out = fence[1].trim()
  out = out.replace(/^(notes|note|text)\s*:\s*/i, '')
  return out.trim()
}

// ---------------------------------------------------------------------------
// The deterministic template
// ---------------------------------------------------------------------------

/**
 * The fallback note: **composed, never generated**, and checked by the same checker.
 *
 * §8.15 says "If it fails again, fall back to the deterministic template notes", and this is that note.
 * Each sentence is one of two things — a member of the boilerplate allowlist, or a sentence built from a
 * {@link ClaimSource}'s own `phrase` with its `[[id]]` marker appended — so it cannot fail the check by
 * construction. `test/drafter.test.ts` asserts that over all 40 router eval contexts, which is a
 * stronger statement than any single fixture.
 *
 * The point of the template is not that it reads well. It is that **the note we file when the model is
 * unavailable is the same shape of note as the one it would have been allowed to file**, so a filing
 * looks the same to a judge whichever path produced it.
 */
export function templateNote(
  input: DraftInput,
  claims: readonly ClaimSource[],
  allowedUrl: string,
): string {
  const chain = input.ctx.chain ?? {}
  const webauthn = claims.find((c) => c.id === 'clm_user_verification')

  /**
   * One sentence, or nothing.
   *
   * Returns `undefined` when **any** of the claims is absent, so the note can never end up citing a claim
   * that is not there and never mentions a fact it does not have. Each value that *is* printed is the
   * claim's own `phrase`, which is the same string the checker looks for — so the template cannot drift
   * out of agreement with the check it has to pass.
   */
  const say = (
    lead: string,
    ids: readonly string[],
    connector = ' ',
    trailer = '',
  ): string | undefined => {
    const found = ids.map((id) => claims.find((c) => c.id === id))
    if (found.some((c) => c === undefined)) return undefined
    return `${lead} ${found.map((c) => `${c!.phrase} [[${c!.id}]]`).join(connector)}${trailer}.`
  }
  const one = (lead: string, ...ids: readonly string[]): string | undefined => say(lead, ids)

  const sentences: string[] = [
    "This note was written from the merchant's own records by Countersign, the payment-intent layer.",
    `The deterministic Dispute Defender decided this case under rule ${input.decision.ruleId} [[clm_rule]].`,
  ]

  // --- the money ---------------------------------------------------------------------------------
  for (const s of [
    one('The buyer is disputing', 'clm_dispute_amount'),
    say('PayPal captured', ['clm_capture_amount', 'clm_capture_id'], ' in capture '),
  ]) {
    if (s !== undefined) sentences.push(s)
  }

  // --- the signed chain -------------------------------------------------------------------------
  if (claims.some((c) => c.id === 'clm_chain_verified')) {
    for (const s of [
      one("The buyer's own device signed the mandate on", 'clm_mandate_signed_at'),
      one('Our records show that the', 'clm_chain_verified'),
      webauthn?.phrase === 'no user-verification'
        ? say(
            'No passkey',
            ['clm_user_verification'],
            ' ',
            ' was recorded when the mandate was signed',
          )
        : say(
            'A passkey',
            ['clm_user_verification'],
            ' ',
            ' was recorded when the mandate was signed',
          ),
      one('Our records show the device status', 'clm_device_status'),
      one('The device was', 'clm_device_reported_lost'),
    ]) {
      if (s !== undefined) sentences.push(s)
    }
    for (const s of [
      one('The signed order records custom_id', 'clm_custom_id'),
      one('The signed order records invoice', 'clm_invoice_id'),
      one('The signed order totals', 'clm_order_amount'),
      one('The disputed line is', 'clm_disputed_lines'),
      one("The merchant's own payment Gate recorded", 'clm_gate_decision'),
    ]) {
      if (s !== undefined) sentences.push(s)
    }
  }

  // --- refunds, one sentence per refund ---------------------------------------------------------
  for (let i = 0; ; i += 1) {
    const s = say(
      'We refunded',
      [`clm_refund_amount_${i}`, `clm_refund_id_${i}`, `clm_refund_at_${i}`],
      ' on PayPal refund ',
    )
    if (s === undefined) break
    sentences.push(s)
  }

  // --- tracking, and EC-MER-4's honesty line, said exactly once -----------------------------------
  let saidCarrierCaveat = false
  for (const c of claims) {
    if (c.id.startsWith('clm_tracking_status_')) {
      const s = one('Our records show the shipment status', c.id)
      if (s !== undefined) sentences.push(s)
      continue
    }
    if (!c.id.startsWith('clm_tracking_')) continue
    const s = one('Our records hold tracking', c.id)
    if (s !== undefined) sentences.push(s)
    if (c.support === 'assertion' && !saidCarrierCaveat) {
      saidCarrierCaveat = true
      sentences.push(CARRIER_CAVEAT)
    }
  }
  if (
    chain.deviceStatus === 'LOST' &&
    !sentences.some((s) => s.includes('clm_device_reported_lost'))
  ) {
    const s = one('The device was', 'clm_device_reported_lost')
    if (s !== undefined) sentences.push(s)
  }

  // --- the packet itself ------------------------------------------------------------------------
  sentences.push('The signed purchase record is in the attached packet.')
  sentences.push(publicAddressSentence(allowedUrl))

  return truncateNotes(sentences.join(' ')).notes
}

/** The EC-MER-4 line, shared with the prompt's boilerplate list so there is one wording of it. */
export const CARRIER_CAVEAT =
  'This packet makes no claim about the carrier, and treats a merchant-entered tracking number as an assertion only.'

// ---------------------------------------------------------------------------
// The check that must run at file time, exposed so WP-15e cannot skip it
// ---------------------------------------------------------------------------

/**
 * The note with its citation markers removed — what a human reads in S-18 and what the packet PDF prints.
 *
 * **`Draft.notes` keeps the markers, and that is §8.15's design rather than an oversight.** The spec's
 * citation checker requires "every sentence in the notes … to carry `[F:key]` tags", so the tags live in the
 * text that is filed. Keeping them there is also what makes EC-MER-5 enforceable: the checker runs on the
 * **final** text at file time, so a merchant who edits `notes` by hand removes the markers, every edited
 * sentence becomes uncited, and the filing is blocked with "these sentences lack a source". If the filed text
 * had no markers and the citations were tracked separately, a hand edit would silently keep the old
 * citations — which is exactly the attack EC-MER-5 describes.
 *
 * So: `notes` is the filed, checkable text; `plainNotes()` is the presentation form. The PDF never prints a
 * marker, because a document that says `[[clm_rule]]` reads as a bug.
 */
export function plainNotes(notes: string): string {
  return splitSentences(notes).map(stripMarkers).join(' ')
}

/**
 * EC-MER-5: "Merchant edits the LLM notes to add unsupported claims" — "The citation checker runs on the
 * **final** text at file time".
 *
 * This is the same check, callable on whatever text is about to be sent, including text a merchant typed
 * into S-18 by hand. `draft()` already ran it, so for an untouched draft this is a **no-op that costs
 * nothing**; for an edited draft it is the only thing standing between an edit and a filing. It is
 * exported separately rather than folded into `draft()` because the two moments are different: one is
 * "should this exist", the other is "may these exact bytes go to PayPal".
 */
export function checkForFiling(
  notes: string,
  claims: readonly ClaimSource[],
  allowedUrl: string,
): CitationVerdict {
  return checkCitations({ notes }, claims, { allowedUrl })
}

/** `DEF_CITATION_FAILED` with the problems quoted. The one error a blocked filing produces. */
export function citationFailed(
  verdict: CitationVerdict,
  context: { readonly ruleId: string; readonly packetId: string },
): CsError {
  return csError(
    'DEF_CITATION_FAILED',
    `${verdict.problems.length} sentence(s) in this note are not supported by a signed record, so it was ` +
      `not filed. ${formatProblems(verdict.problems).join(' ')}`,
    {
      ruleId: context.ruleId,
      packetId: context.packetId,
      problems: verdict.problems.map((p) => p.code),
      sentences: verdict.problems.map((p) => p.sentence),
    },
  )
}

export { NOTES_MAX_CHARS } from './types'
export type { Citation, CitationProblem, CitationVerdict, ClaimSource }
export {
  checkCitations,
  claimSourcesFor,
  formatProblems,
  publicAddressSentence,
  publicPacketUrl,
  truncateNotes,
}
