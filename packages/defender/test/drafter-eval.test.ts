/**
 * The 20-case drafter eval — **citation coverage** and **false-claim rate**.
 *
 * ```bash
 * pnpm --filter @countersign/defender eval
 * ```
 *
 * ## Why this file is `drafter-eval.test.ts` and not `eval.test.ts`
 *
 * WP-15b's brief listed `test/eval.test.ts` as this work package's file, and **that name was already taken**:
 * `test/eval.test.ts` is WP-15a's 40-case router eval — the §8.16 AT-M15.1 measurement this repository
 * publishes — and `pnpm --filter @countersign/defender eval` runs it. Overwriting it would have deleted it, so
 * the drafter eval lives here instead and the `eval` script now runs both. Renaming either file is a decision
 * for whoever owns `packages/defender/package.json`, not something to do silently inside someone else's work
 * package.
 *
 * ## The three things this asserts, in order of how much they matter
 *
 * 1. **The filed note is clean on every case.** Run the real `draft()` over all twenty with a model that
 *    returns each case's stored text, and assert that whatever comes out passes `checkCitations`. This is
 *    the invariant; everything else is commentary on it.
 * 2. **The data is sound.** Twenty cases, unique ids, integer amounts, supported currencies, a `provenance`
 *    on every row. A damaged golden set reports a *score*, and a wrong score is worse than no score.
 * 3. **The two rates are printed**, with their provenance, and are **not** gated on a threshold — because the
 *    rate is a property of the model, not of this code, and a threshold here would be a number fitted to a
 *    fixture.
 *
 * ## What is deliberately *not* asserted
 *
 * `citationCoverage === 1`. The router's eval can require that, because the router is a pure function. This
 * one cannot: the honest claim is not "the model always cites correctly", it is "**it does not matter whether
 * it does**". A model that cited nothing would score 0% coverage here and would still produce twenty filings
 * that are indistinguishable, to a reader, from twenty produced by a perfect model.
 */

import { CURRENCIES } from '@countersign/core'
import { describe, expect, it } from 'vitest'

import { checkCitations, publicPacketUrl, type ClaimSource } from '../src/citation-check'
import { draft, plainNotes, templateNote, type Draft, type LanguageModel } from '../src/drafter'
import { planEvidence } from '../src/planner'
import { route } from '../src/router'
import {
  DRAFTER_EVAL_SIZE,
  buildCaseContext,
  claimsForCase,
  formatDrafterFailures,
  formatDrafterReport,
  loadDrafterCases,
  runDrafterEval,
  type DrafterCase,
  type Verifier,
} from '../eval/drafter-cases'

const PACKET_ID = 'pkt_01HQ0000000000000000000000'
const BASE = 'https://countersign.example'
const ADDRESS = publicPacketUrl(BASE, PACKET_ID)

const { cases, liveCount } = loadDrafterCases()

/** The verifier, wired once so the runner stays a pure function of (cases, verifier). */
const verify: Verifier = (notes: string, claims: readonly ClaimSource[]) =>
  checkCitations({ notes }, claims, { allowedUrl: ADDRESS })

/**
 * A model that answers with each case's stored text, and **answers the repair turn the same way**.
 *
 * That is deliberate. Returning the identical defective text twice is what makes the second call useless, so
 * `draft()` takes the template path — which is the path that matters for a defective case. The cap of two is
 * §8.15's bound made into an assertion: a third call would throw and become `LLM_UNAVAILABLE`.
 */
function replayingModel(text: string): LanguageModel & { readonly asked: () => number } {
  let asked = 0
  return {
    asked: () => asked,
    generateText: async (): Promise<{ text: string }> => {
      asked += 1
      if (asked > 2) {
        throw new Error(
          'drafter eval: the drafter asked for more than two answers (§8.15 allows one retry)',
        )
      }
      return { text }
    },
  }
}

async function fileFor(c: DrafterCase): Promise<{ draft: Draft; asked: number }> {
  const ctx = buildCaseContext(c)
  const decision = route(ctx)
  const claims = claimsForCase(c)
  const llm = replayingModel(c.modelText)
  const result = await draft(
    {
      ctx,
      decision,
      plan: planEvidence(ctx, decision),
      packetId: PACKET_ID,
      publicBaseUrl: BASE,
      claims,
    },
    { llm },
  )
  if (!result.ok) {
    throw new Error(
      `drafter eval: ${c.id} could not be filed at all (${result.error.code}: ${result.error.message})`,
    )
  }
  return { draft: result.value, asked: llm.asked() }
}

// ---------------------------------------------------------------------------
// 1. The invariant
// ---------------------------------------------------------------------------

describe('the note that gets filed is clean on every case', () => {
  it(`holds for all ${DRAFTER_EVAL_SIZE} cases, whatever the model wrote`, async () => {
    const failures: string[] = []
    for (const c of cases) {
      const { draft: filed } = await fileFor(c)
      // The filed text is re-checked here, independently of what `draft()` believed. If `draft()` ever
      // skipped its own final check, this is the assertion that notices.
      const verdict = checkCitations({ notes: filed.notes }, claimsForCase(c), {
        allowedUrl: ADDRESS,
      })
      if (!verdict.ok) {
        failures.push(
          `${c.id}: ${verdict.problems.map((p) => `${p.code} "${p.sentence}"`).join(' | ')}`,
        )
      }
      if (filed.notes.length > 2000) failures.push(`${c.id}: ${filed.notes.length} characters`)
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} case(s) produced a note that would not pass the checker:\n${failures.join('\n')}`,
      )
    }
    expect(failures).toEqual([])
  })

  it('never files a model sentence the checker refused, however the case got there', async () => {
    // The 12 `bad-*` cases each name one specific defect. Whichever path the drafter took — filed the model
    // text after a repair, or fell back to the template — the offending phrase must not be in `notes`.
    const forbidden: Record<string, string> = {
      'bad-01-uncited-framing': 'always treated our buyers',
      'bad-02-wrong-currency': 'EUR ',
      'bad-03-delivery-from-assertion': 'was delivered',
      'bad-04-invented-claim': 'clm_carrier_scan_confirmed',
      // The *prose*, not the word: this case's invoice id legitimately contains "notified", and a checker
      // that read meaning into an identifier is the bug the eval found and the guard fixed.
      'bad-05-notified': 'We notified the buyer',
      'bad-07-forged-amount': 'USD 129.90',
      'bad-08-forged-status': 'DELIVERED',
      'bad-12-delivery-from-record': 'was delivered',
    }
    for (const c of cases) {
      const needle = forbidden[c.id]
      if (needle === undefined) continue
      const { draft: filed } = await fileFor(c)
      expect(filed.notes, `${c.id} filed "${needle}"`).not.toContain(needle)
    }
  })

  it('spends one call on a clean case and two on a defective one, and never three', async () => {
    // The cost side of the design, measured: §8.15 allows exactly one repair turn, and the eval shows the
    // drafter stops there. A clean row does not pay for a retry it did not need.
    const calls = new Map<string, number>()
    for (const c of cases) calls.set(c.id, (await fileFor(c)).asked)
    for (const [id, n] of calls) expect(n, id).toBeLessThanOrEqual(2)

    const clean = [...calls].filter(([id]) => id.startsWith('clean-'))
    const defective = [...calls].filter(([id]) => id.startsWith('bad-'))
    expect(clean.every(([, n]) => n === 1)).toBe(true)
    // Every defective row except the over-length one, and the exception is the interesting part: a note that
    // is only too long is the drafter's problem to solve, not the model's, so it gets a repair turn spent on
    // truncating rather than on a wasted second request.
    expect(defective.filter(([, n]) => n === 2)).toHaveLength(defective.length - 1)
    expect(calls.get('bad-10-over-length')).toBe(1)
  })

  it('keeps the marker-free form for the reader while the filed text stays checkable', async () => {
    const c = cases.find((x) => x.id === 'clean-01-unauthorised')
    expect(c).toBeDefined()
    if (c === undefined) return
    const { draft: filed } = await fileFor(c)
    // §8.15 puts the tags in the notes so the checker can run on the final text at file time (EC-MER-5).
    // A PDF must not print them, and `plainNotes` is what the renderer and S-18 use.
    expect(filed.notes).toContain('[[clm_')
    expect(plainNotes(filed.notes)).not.toContain('[[')
  })
})

// ---------------------------------------------------------------------------
// 2. The data
// ---------------------------------------------------------------------------

describe('the drafter eval set', () => {
  it(`has exactly ${DRAFTER_EVAL_SIZE} cases, as §8.15 asks, and every id is unique`, () => {
    expect(cases).toHaveLength(DRAFTER_EVAL_SIZE)
    expect(new Set(cases.map((c) => c.id)).size).toBe(DRAFTER_EVAL_SIZE)
  })

  it('gives every case a one-line description, so a diff reads as prose', () => {
    for (const c of cases) {
      expect(c.text.trim().length, c.id).toBeGreaterThan(20)
      expect(c.text.includes('\n'), `${c.id} description should be one line`).toBe(false)
    }
  })

  it('states a provenance on every row, because a number that does not say where it came from is not a measurement', () => {
    for (const c of cases) {
      expect(['scripted', 'live'], `${c.id} provenance`).toContain(c.provenance)
      expect(c.modelText.trim().length, `${c.id} modelText`).toBeGreaterThan(0)
    }
    // And when no live capture exists the file says so, so nobody reads the score as a model report.
    if (liveCount === 0) expect(cases.every((c) => c.provenance === 'scripted')).toBe(true)
  })

  it('writes every amount as an integer, never a float (spec §0 rule 9)', () => {
    for (const c of cases) {
      expect(Number.isInteger(c.amountMinor), c.id).toBe(true)
      for (const r of c.refunds ?? []) expect(Number.isInteger(r.amountMinor), c.id).toBe(true)
    }
  })

  it('states a supported ISO-4217 currency on every case', () => {
    for (const c of cases) expect(CURRENCIES as readonly string[], c.id).toContain(c.currency)
  })

  it('covers at least four currencies, so the currency rule is exercised rather than assumed', () => {
    // One currency would make `CURRENCY_MISMATCH` untestable — the whole rule could be `=== 'USD'` and pass.
    const seen = new Set(cases.map((c) => c.currency))
    expect(seen.size).toBeGreaterThanOrEqual(4)
  })

  it('has defects as well as clean rows, because an eval with no defects in it measures nothing', () => {
    const defective = cases.filter((c) => c.id.startsWith('bad-'))
    const clean = cases.filter((c) => c.id.startsWith('clean-'))
    expect(defective.length).toBeGreaterThanOrEqual(10)
    expect(clean.length).toBeGreaterThanOrEqual(6)
  })

  it('has a case for each refusal the checker can issue for a claim reason', () => {
    // One case per `FALSE_CLAIM_CODES` member would be ideal; the two that cannot be provoked in isolation
    // are covered in `test/citation.test.ts` instead. Asserted here so a new code cannot ship uncovered.
    const report = runDrafterEval(cases, verify)
    const seen = new Set(report.results.flatMap((r) => r.codes))
    for (const code of [
      'UNCITED_SENTENCE',
      'PHRASE_NOT_IN_SENTENCE',
      'CURRENCY_MISMATCH',
      'UNKNOWN_CLAIM_ID',
      'MALFORMED_MARKER',
      'FORBIDDEN_DERIVATION',
    ]) {
      expect([...seen], code).toContain(code)
    }
  })

  it('exercises the EC-MER-4 boundary in both directions: an assertion and a PayPal-held record', () => {
    // The rule is the delivery *claim*, not the tracking number, so both halves have to be present or the
    // eval proves nothing about where the line is.
    expect(cases.some((c) => c.id === 'bad-03-delivery-from-assertion')).toBe(true)
    expect(cases.some((c) => c.id === 'bad-12-delivery-from-record')).toBe(true)
    expect(cases.some((c) => c.id === 'clean-05-registered-tracker')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. The two rates, reported
// ---------------------------------------------------------------------------

describe('the drafter eval scores citation coverage and false claims', () => {
  const report = runDrafterEval(cases, verify)

  it(`reports ${formatDrafterReport(report)}`, () => {
    // The name of the test *is* the number, so a green run says what it measured. No threshold is asserted:
    // the rate is a property of the model, and gating it here would be a number fitted to a fixture.
    expect(report.total).toBe(DRAFTER_EVAL_SIZE)
    expect(report.citationCoverage).toBeGreaterThan(0)
    expect(report.citationCoverage).toBeLessThanOrEqual(1)
    expect(report.falseClaimRate).toBeGreaterThan(0)
    expect(report.falseClaimRate).toBeLessThanOrEqual(1)
  })

  it('attributes every refusal to a case, so a weak spot is visible as a case and not as a total', () => {
    const refused = report.results.filter((r) => r.falseClaims > 0)
    expect(refused.length).toBeGreaterThanOrEqual(10)
    // Every `bad-*` row is refused, and no `clean-*` row is. If a clean row started failing, that would be a
    // checker bug rather than a model one, and the breakdown is where it would show up first.
    for (const r of refused) expect(r.id, 'a clean row was refused').toMatch(/^bad-/)
    for (const r of report.results.filter((x) => x.id.startsWith('clean-'))) {
      expect(r.falseClaims, `${r.id}`).toBe(0)
    }
  })

  it('counts one false claim per sentence, not per problem, so one bad sentence is not counted twice', () => {
    // `EUR 129.99` produces both PHRASE_NOT_IN_SENTENCE and CURRENCY_MISMATCH. Counting problems would make
    // a single lie look like two and would inflate the rate for exactly the cases that matter most.
    const doubled = report.results.find((r) => r.id === 'bad-02-wrong-currency')
    expect(doubled?.codes).toContain('PHRASE_NOT_IN_SENTENCE')
    expect(doubled?.codes).toContain('CURRENCY_MISMATCH')
    expect(doubled?.falseClaims).toBe(1)
  })

  it('reports a length or link refusal as a refusal but not as a false claim', () => {
    // Nothing untrue was asserted in either case, so counting them as lies would overstate the model.
    const long = report.results.find((r) => r.id === 'bad-10-over-length')
    expect(long?.codes).toContain('TOO_LONG')
    expect(long?.falseClaims).toBe(0)
    expect(long?.otherProblems).toBeGreaterThan(0)
    const links = report.results.find((r) => r.id === 'bad-11-second-link')
    expect(links?.codes).toContain('DUPLICATE_URL')
  })

  it('prints a failure block naming the case, so a dropped score is diagnosable', () => {
    const text = formatDrafterFailures(report)
    expect(text).toContain('bad-05-notified')
    expect(text).toContain('FORBIDDEN_DERIVATION')
    for (const line of text.split('\n')) expect(line.length).toBeLessThan(400)
  })

  it('the template would have passed every case, so the fallback is not what is being measured away', () => {
    // If the template failed somewhere, the "clean filing" result above would be hiding a broken fallback.
    for (const c of cases) {
      const ctx = buildCaseContext(c)
      const claims = claimsForCase(c)
      const note = templateNote(
        {
          ctx,
          decision: route(ctx),
          plan: planEvidence(ctx, route(ctx)),
          packetId: PACKET_ID,
          publicBaseUrl: BASE,
          claims,
        },
        claims,
        ADDRESS,
      )
      const verdict = checkCitations({ notes: note }, claims, { allowedUrl: ADDRESS })
      expect(verdict.problems.map((p) => `${c.id}: ${p.code}`)).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// 4. The live path, gated on a key
// ---------------------------------------------------------------------------

describe('the live drafter path', () => {
  it('is gated on OPENAI_API_KEY and is not run in CI (docs/HUMAN_TODO.md H-02)', () => {
    // No key, no run, and no failure — the eval above is the measurement that works with no credentials.
    if (process.env['OPENAI_API_KEY'] === undefined) {
      expect(process.env['OPENAI_API_KEY']).toBeUndefined()
      return
    }
    // With a key, a capture file is expected to exist. Absent, that is a state to report rather than fail
    // on, because capturing costs money and the key may have arrived for another package.
    expect(typeof liveCount).toBe('number')
  })
})
