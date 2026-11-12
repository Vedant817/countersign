/**
 * The rule behind the agent's first `thought` — the buyer's own first limit, as plain text.
 *
 * ## The regression
 *
 * `runShoppingAgent` and `runScriptedShopper` both built that line as `readback.split('\n')[0]`. The
 * first line of `readBack()` is `**What you are authorising**` (`packages/compiler/src/readback.ts`),
 * so a live run's transcript opened with:
 *
 * ```
 * thought: {"text":"Reading your mandate. **What you are authorising**"}
 * ```
 *
 * which is a heading and not a limit: the buyer's cap never appeared in the chat at all, and the
 * markdown was rendered literally.
 *
 * ## Why the tests are written against markdown, not against English
 *
 * The first attempted fix in `agent-chat.tsx` filtered `startsWith('**What')`. That is the same defect
 * one file over — a hardcoded English prefix that stops matching when the wording changes. These tests
 * therefore assert the *structural* rule: any line that is entirely a bold span is a heading and is
 * skipped; the first line that is not is content, and it comes back with no markup.
 */
import { readBack, type CompiledMandate } from '@countersign/compiler'
import { describe, expect, it } from 'vitest'

import { READBACK_SUMMARY_MAX_CHARS, readbackSummaryLine } from '../src/readback-summary'

const NOW_MS = Date.UTC(2026, 10, 13, 0, 0, 0)

function mandateWith(overrides: Partial<CompiledMandate> = {}): CompiledMandate {
  return {
    // `readBack` distinguishes an absent bound from a `null` one (`min: null` throws inside
    // `formatMoney`, which is exactly what agent-session.ts documents), so the array omits `min`.
    constraints: [
      { type: 'mandate.payment.amount_range', currency: 'USD', max: 5_000n },
      {
        type: 'mandate.payment.allowed_payees',
        allowed: [
          {
            id: 'mrc_northwind',
            name: 'Northwind Outfitters',
            website: 'https://merchant.example.test',
          },
        ],
      },
    ],
    currency: 'USD',
    ttlSeconds: 86_400,
    expiresAtEpochSec: Math.floor(NOW_MS / 1000) + 86_400,
    preferences: {},
    assumptions: [],
    ambiguities: [],
    ...overrides,
  }
}

const ctx = {
  merchants: { mrc_northwind: 'Northwind Outfitters' },
  tz: 'Asia/Kolkata' as const,
  nowMs: NOW_MS,
}

describe('readbackSummaryLine', () => {
  it('returns the cap, not the read-back heading, for a real readBack() output', () => {
    const readback = readBack(mandateWith(), ctx)

    // The premise: the first line really is the heading the bug shipped.
    expect(readback.split('\n')[0]).toBe('**What you are authorising**')

    const summary = readbackSummaryLine(readback)
    expect(summary).not.toContain('What you are authorising')
    expect(summary).not.toContain('**')
    expect(summary).toContain('$50.00')
    // The first line that is not a heading, with its markdown removed — whatever order the compiler
    // emits its limits in, the chip shows the first one rather than the heading above it.
    expect(summary).toBe(readback.split('\n')[1]?.replaceAll('**', ''))
  })

  it('skips every bold-only heading, whatever its wording', () => {
    // Not "What you are authorising": any all-bold line is a heading. A hardcoded English prefix would
    // return the first of these two lines and call it a limit.
    const readback = [
      '**Your spending limits**',
      'Spend at most **$50.00** in total',
      '**Not covered**',
    ].join('\n')
    expect(readbackSummaryLine(readback)).toBe('Spend at most $50.00 in total')
  })

  it('strips list bullets and inline bold from the content line', () => {
    expect(readbackSummaryLine('**Limits**\n- Spend at most **$50.00** in total')).toBe(
      'Spend at most $50.00 in total',
    )
  })

  it('truncates a long content line on a word boundary', () => {
    const long = `${'word '.repeat(80).trim()}`
    const summary = readbackSummaryLine(long, 40)
    expect(summary.length).toBeLessThanOrEqual(41)
    expect(summary.endsWith('…')).toBe(true)
    // No word is cut in half: everything before the ellipsis is whole words.
    expect(
      summary
        .slice(0, -1)
        .split(' ')
        .every((word) => word === 'word'),
    ).toBe(true)
    expect(READBACK_SUMMARY_MAX_CHARS).toBe(160)
  })

  it('is empty for an empty read-back rather than inventing a limit', () => {
    expect(readbackSummaryLine('')).toBe('')
    expect(readbackSummaryLine('\n\n')).toBe('')
    expect(readbackSummaryLine('**What you are authorising**')).toBe('')
  })

  it('is deterministic: the same read-back gives the same line every time', () => {
    const readback = readBack(mandateWith(), ctx)
    expect(readbackSummaryLine(readback)).toBe(readbackSummaryLine(readback))
  })
})
