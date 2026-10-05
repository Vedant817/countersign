/**
 * The 20-case drafter eval — **citation coverage** and **false-claim rate**.
 *
 * ```bash
 * pnpm --filter @countersign/defender eval
 * ```
 *
 * ## What it measures, and what it is honest about
 *
 * The router's 40-case eval measures a pure function, so 100% is the bar. **This one cannot be, and
 * pretending otherwise would be the dishonest part.** A model writes prose, so the two numbers here are
 * *rates*, not exact matches, and both are reported whether they are good or bad:
 *
 * | Metric | Definition | Denominator |
 * |---|---|---|
 * | **citation coverage** | of the sentences carrying a marker, the fraction whose marker resolves to a real claim **and** whose phrase appears verbatim | every marker-bearing sentence the model wrote |
 * | **false-claim rate** | of all the sentences the model wrote, the fraction the checker refuses for a *claim* reason | every sentence the model wrote |
 *
 * The false-claim rate's denominator is **all** sentences, not only marker-bearing ones, because a sentence
 * with no marker is the most dangerous kind: it reads perfectly and asserts something nobody signed.
 *
 * ## The number that actually matters
 *
 * **After the pipeline runs — one repair turn, then the deterministic template — the note that gets filed
 * has a false-claim rate of zero on every case.** That is the invariant; the two rates above describe how
 * much work the model did. A model that scores 0% coverage and 100% false claims still produces a filing
 * that is 100% clean, and that asymmetry *is* the product claim: the model's quality is a cost, our honesty
 * is a property of the code.
 *
 * ## The committed cache, and its provenance
 *
 * `docs/HUMAN_TODO.md` **H-02** is open — there is no OpenAI key — so `drafter-cases.jsonl` cannot contain
 * live model output yet. Every row therefore carries an explicit `provenance`, and the test **prints which
 * one it scored**:
 *
 * - `"scripted"` — written by hand against the prompt's stated contract. Honest about being a fixture: it
 *   measures the *pipeline*, and it is what makes `pnpm eval` green in CI with no network and no key.
 * - `"live"` — captured from a real run. Drop a `drafter-cases.live.jsonl` beside the scripted file (one JSON
 *   object per line, `{id, modelText}`) and it is merged in by id, winning over the scripted row.
 *
 * The eval asserts its own honesty: every row states a provenance, the printed report says which mix it
 * scored, and **a number that does not say where it came from is not a measurement.**
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { isCurrency, money } from '@countersign/core'

import {
  claimSourcesFor,
  splitSentences,
  type ClaimSource,
  type CitationProblemCode,
} from '../src/citation-check'
import { route } from '../src/router'
import type { DisputeContext } from '../src/types'

// ---------------------------------------------------------------------------
// The case shape
// ---------------------------------------------------------------------------

/** Where a row's `modelText` came from. See the file header; this is load-bearing, not decoration. */
export type DrafterCaseProvenance = 'scripted' | 'live'

export interface DrafterCase {
  readonly id: string
  /** One line, prose, so a diff reads as English rather than as JSON. */
  readonly text: string
  readonly reason: string
  /** Integer minor units (spec §0 rule 9), as the router eval records them. */
  readonly amountMinor: number
  readonly currency: string
  readonly refunds?: readonly { readonly amountMinor: number; readonly status: string }[]
  readonly tracking?: {
    readonly carrier: string
    readonly number: string
    /** Registered with PayPal, so the claim is a `record` and not an `assertion` (EC-MER-4). */
    readonly registered?: boolean
  }
  readonly chainValid?: boolean
  readonly webauthn?: boolean
  /**
   * What the model wrote, **in the marker form** — `[[clm_x]]` — because that is §8.15's contract and what
   * the checker parses. A case whose whole point is a missing marker simply omits it.
   */
  readonly modelText: string
  readonly provenance: DrafterCaseProvenance
  /** For a reviewer. Ignored by the scorer; mirrors `_comment` in the compiler's golden set. */
  readonly _note?: string
  readonly ec?: readonly string[]
}

/** §8.15 asks for a 20-case drafter eval; the test asserts the count so a case cannot be quietly dropped. */
export const DRAFTER_EVAL_SIZE = 20

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const evalDir = fileURLToPath(new URL('.', import.meta.url))

/** Parse JSONL, skipping blanks and `//` comments, with the line number in any error. */
export function parseJsonl<T>(text: string, label: string): T[] {
  const out: T[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('//')) return
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch (cause) {
      throw new Error(`${label}:${index + 1} is not valid JSON: ${(cause as Error).message}`)
    }
  })
  return out
}

/**
 * The scripted cases, with any live capture merged in by id.
 *
 * A live capture wins over the scripted row for the same id, so a partial re-capture does not throw away
 * the rest of the set. **Read-only: nothing in this file writes to the JSONL.**
 */
export function loadDrafterCases(): { cases: DrafterCase[]; liveCount: number } {
  const scripted = parseJsonl<DrafterCase>(
    readFileSync(`${evalDir}drafter-cases.jsonl`, 'utf8'),
    'drafter-cases.jsonl',
  )
  let live: { readonly id: string; readonly modelText: string }[] = []
  try {
    live = parseJsonl<{ id: string; modelText: string }>(
      readFileSync(`${evalDir}drafter-cases.live.jsonl`, 'utf8'),
      'drafter-cases.live.jsonl',
    )
  } catch {
    // No capture file yet. Not an error: H-02 is open and CI must not need a key.
  }
  const byId = new Map(scripted.map((c) => [c.id, c]))
  for (const c of live) {
    const base = byId.get(c.id)
    if (base === undefined) continue
    byId.set(c.id, { ...base, modelText: c.modelText, provenance: 'live' })
  }
  const cases = [...byId.values()]
  return { cases, liveCount: cases.filter((c) => c.provenance === 'live').length }
}

// ---------------------------------------------------------------------------
// The context a case stands for
// ---------------------------------------------------------------------------

const CASE_NOW_SEC = 1_800_000_000

/**
 * Turn one case into a `DisputeContext`.
 *
 * The same choice as `eval/router-cases.ts` and for the same reason: money converts with `BigInt` at the JSON
 * boundary, and one capture per disputed capture with the sibling list empty keeps `R-AMT-2` out of the way
 * — these cases are about the *drafter*, not the router, and `test/eval.test.ts` already scores the router
 * at 100% over its own 40.
 */
export function buildCaseContext(c: DrafterCase): DisputeContext {
  if (!isCurrency(c.currency))
    throw new Error(`drafter-cases: ${c.currency} is not a supported currency`)
  const cur = c.currency
  const tracking = c.tracking
  const lines = [{ sku: 'SKU-TRAIL-42', qty: 1 }]
  return {
    nowSec: CASE_NOW_SEC,
    dispute: {
      id: `dsp_${c.id}`,
      paypalDisputeId: `PP-DSP-${c.id.toUpperCase()}`,
      reason: c.reason,
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: money(BigInt(c.amountMinor), cur),
      captureId: `cap_${c.id}`,
      orderId: `ord_${c.id}`,
      sellerResponseDueSec: CASE_NOW_SEC + 5 * 86_400,
    },
    capture: {
      id: `cap_${c.id}`,
      paypalCaptureId: `3AB${c.id.toUpperCase().slice(0, 8).padEnd(8, '0')}`,
      amount: money(BigInt(c.amountMinor), cur),
      shipmentId: 'shp_1',
    },
    order: {
      id: `ord_${c.id}`,
      customId: 'cs1:AbCdEf0123456789',
      invoiceId: `INV-${c.id}`,
      amount: money(BigInt(c.amountMinor), cur),
    },
    refunds: (c.refunds ?? []).map((r, i) => ({
      id: `ref_${c.id}_${i}`,
      paypalRefundId: `REF-${i}`,
      amount: money(BigInt(r.amountMinor), cur),
      status: r.status,
      atSec: CASE_NOW_SEC - 86_400,
    })),
    shipments: [
      {
        id: 'shp_1',
        carrier: tracking?.carrier ?? 'DHL',
        trackingNumber: tracking?.number ?? 'JD0002000031',
        ...(tracking?.registered === true ? { paypalTrackerId: `PPTRK-${c.id}` } : {}),
        status: 'SHIPPED',
        lines,
      },
    ],
    siblingCaptures: [],
    chain: {
      mandatePresent: c.chainValid !== false,
      verifyAtCaptureChainValid: c.chainValid !== false,
      webauthnPresent: c.webauthn !== false,
      deviceStatus: 'ACTIVE',
      iatSec: CASE_NOW_SEC - 86_400,
      gateDecision: 'ALLOW',
    },
    checkoutLines: lines,
    corpus: { fulfilmentDocument: true, receiptCopy: true },
  }
}

/** The claims this case's packet may assert — the same derivation the drafter uses. */
export function claimsForCase(c: DrafterCase): readonly ClaimSource[] {
  const ctx = buildCaseContext(c)
  return claimSourcesFor(ctx, route(ctx))
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * The problems that mean "the model asserted something no record supports", as distinct from "it was ugly".
 *
 * `TOO_LONG`, `DISALLOWED_URL` and `DUPLICATE_URL` are real refusals but not *false claims*: nothing was
 * asserted that we did not record, so counting them as lies would overstate the model's dishonesty. They are
 * reported separately as `otherProblems`.
 */
const FALSE_CLAIM_CODES: readonly CitationProblemCode[] = [
  'MALFORMED_MARKER',
  'UNKNOWN_CLAIM_ID',
  'UNCITED_SENTENCE',
  'PHRASE_NOT_IN_SENTENCE',
  'CURRENCY_MISMATCH',
  'FORBIDDEN_DERIVATION',
]

export function isFalseClaim(code: CitationProblemCode): boolean {
  return FALSE_CLAIM_CODES.includes(code)
}

/** Injected rather than imported, so the runner is a pure function of (cases, verifier). */
export type Verifier = (
  notes: string,
  claims: readonly ClaimSource[],
) => {
  readonly ok: boolean
  readonly problems: readonly { readonly code: CitationProblemCode; readonly sentence: string }[]
}

export interface DrafterCaseResult {
  readonly id: string
  readonly text: string
  readonly provenance: DrafterCaseProvenance
  /** Every sentence the model wrote. */
  readonly sentences: number
  /** Of those, the ones carrying at least one `[[claim_id]]` marker. */
  readonly markerSentences: number
  /** Of those, the ones the checker accepted. */
  readonly citedSentences: number
  /** Sentences refused for a claim reason. */
  readonly falseClaims: number
  /** Problems that are refusals but not false claims. */
  readonly otherProblems: number
  readonly codes: readonly CitationProblemCode[]
}

export interface DrafterReport {
  readonly total: number
  readonly sentences: number
  readonly markerSentences: number
  readonly citedSentences: number
  readonly falseClaimSentences: number
  readonly otherProblems: number
  /** 0..1, over marker-bearing sentences. */
  readonly citationCoverage: number
  /** 0..1, over every sentence. */
  readonly falseClaimRate: number
  readonly results: readonly DrafterCaseResult[]
  readonly provenance: { readonly scripted: number; readonly live: number }
}

/**
 * Score one case's model text.
 *
 * Two counts, both derived from **one** run of the checker so the two can never disagree:
 *
 * - `falseClaims` — the number of *distinct* offending sentences the checker refused for a claim reason.
 *   Distinct, because one sentence can produce several problems (`EUR 129.99` gives both
 *   `PHRASE_NOT_IN_SENTENCE` and `CURRENCY_MISMATCH`) and counting problems would make a single bad
 *   sentence look like two lies.
 * - `citedSentences` — marker-bearing sentences, minus the distinct ones refused for a marker problem.
 */
export function scoreDrafterCase(c: DrafterCase, verify: Verifier): DrafterCaseResult {
  const claims = claimsForCase(c)
  const verdict = verify(c.modelText, claims)
  const parts = splitSentences(c.modelText)
  const markerSentences = parts.filter((s) => /\[\[[a-z0-9_]+\]\]/.test(s)).length

  const falseClaimSentences = new Set(
    verdict.problems.filter((p) => isFalseClaim(p.code)).map((p) => p.sentence),
  ).size
  const markerProblems = new Set(
    verdict.problems
      .filter(
        (p) =>
          p.code === 'UNKNOWN_CLAIM_ID' ||
          p.code === 'PHRASE_NOT_IN_SENTENCE' ||
          p.code === 'MALFORMED_MARKER',
      )
      .map((p) => p.sentence),
  ).size

  return {
    id: c.id,
    text: c.text,
    provenance: c.provenance,
    sentences: parts.length,
    markerSentences,
    citedSentences: Math.max(0, markerSentences - markerProblems),
    falseClaims: falseClaimSentences,
    otherProblems: verdict.problems.length - falseClaimSentences,
    codes: [...new Set(verdict.problems.map((p) => p.code))],
  }
}

export function runDrafterEval(cases: readonly DrafterCase[], verify: Verifier): DrafterReport {
  const results = cases.map((c) => scoreDrafterCase(c, verify))
  const sum = (pick: (r: DrafterCaseResult) => number): number =>
    results.reduce((a, r) => a + pick(r), 0)
  const markerSentences = sum((r) => r.markerSentences)
  const citedSentences = sum((r) => r.citedSentences)
  const sentences = sum((r) => r.sentences)
  const falseClaimSentences = sum((r) => r.falseClaims)
  return {
    total: results.length,
    sentences,
    markerSentences,
    citedSentences,
    falseClaimSentences,
    otherProblems: sum((r) => r.otherProblems),
    citationCoverage: markerSentences === 0 ? 0 : citedSentences / markerSentences,
    falseClaimRate: sentences === 0 ? 0 : falseClaimSentences / sentences,
    results,
    provenance: {
      scripted: results.filter((r) => r.provenance === 'scripted').length,
      live: results.filter((r) => r.provenance === 'live').length,
    },
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

/** One line, for the test name, that says what was measured **and where the data came from**. */
export function formatDrafterReport(report: DrafterReport): string {
  const source =
    report.provenance.live > 0
      ? `${report.provenance.live} live, ${report.provenance.scripted} scripted`
      : `${report.provenance.scripted} scripted (no live capture: H-02 open)`
  return (
    `${report.citedSentences}/${report.markerSentences} citations (${pct(report.citationCoverage)} coverage), ` +
    `${report.falseClaimSentences}/${report.sentences} false claims (${pct(report.falseClaimRate)}), ` +
    `${report.total} cases, ${source}`
  )
}

/** One block per case the checker refused for a claim reason. */
export function formatDrafterFailures(report: DrafterReport): string {
  return report.results
    .filter((r) => r.falseClaims > 0)
    .map((r) => `  ${r.id} [${r.provenance}]\n    ${r.text}\n    refused: ${r.codes.join(', ')}`)
    .join('\n')
}
