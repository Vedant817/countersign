/**
 * `frequencyInText` — the cadence check that `mentionsRecurrence` cannot make.
 *
 * Found by the live eval, and only after an unrelated refusal was fixed. The sequence is worth
 * recording because it is the argument for running the product rather than the tests:
 *
 *  1. `"subscribe to a coffee delivery for $40 a month"` was refused — for a `start_date` in the
 *     past, because the prompt never told the model what today is.
 *  2. Fixing that made the request **succeed**, with a frequency of `WEEK`.
 *  3. The buyer wrote *monthly*. Four times the spend, under a signature that says `$40`.
 *
 * That is a worse failure than the refusal it replaced: a red error is safe, a green mandate with the
 * wrong cadence is not. `mentionsRecurrence` could never have caught it — it is a boolean over any
 * recurrence word, and the text does mention one.
 */
import { describe, expect, it } from 'vitest'

import { frequenciesInText, frequencyInText, mentionsRecurrence } from '../src/literal'

describe('frequencyInText', () => {
  it('accepts the cadence the buyer actually wrote', () => {
    expect(frequencyInText('$40 a month', 'MNTH')).toBe(true)
    expect(frequencyInText('$10 weekly', 'WEEK')).toBe(true)
    expect(frequencyInText('pay daily', 'DAIL')).toBe(true)
    expect(frequencyInText('$500 annually', 'YEAR')).toBe(true)
    expect(frequencyInText('every quarter', 'QUTR')).toBe(true)
  })

  it('rejects a cadence the buyer did not write — the case that was live', () => {
    // The bug in one assertion: `mentionsRecurrence` says yes to both of these, which is why it was
    // never enough on its own.
    expect(mentionsRecurrence('$40 a month')).toBe(true)
    expect(frequencyInText('$40 a month', 'WEEK')).toBe(false)
    expect(frequencyInText('$10 weekly', 'MNTH')).toBe(false)
    expect(frequencyInText('$500 annually', 'WEEK')).toBe(false)
  })

  it('does not let one cadence’s words satisfy another', () => {
    // "every two months" is a different authority from "monthly" and from "quarterly", and the whole
    // point is not to conflate them.
    expect(frequencyInText('every two months', 'TWMN')).toBe(true)
    expect(frequencyInText('every two months', 'MNTH')).toBe(false)
    expect(frequencyInText('every three months', 'TOMN')).toBe(true)
    expect(frequencyInText('every three months', 'QUTR')).toBe(false)
  })

  it('refuses an unknown cadence rather than claiming support', () => {
    // A `true` here would be this function asserting a buyer wrote something it cannot read.
    expect(frequencyInText('$40 a month', 'FORTNIGHTLY_ISH')).toBe(false)
    expect(frequencyInText('$40 a month', '')).toBe(false)
  })

  it('reports every cadence a text names, so two can be told from one', () => {
    /*
     * The case the red-team corpus found: the buyer says monthly, an appended clause says daily, and
     * `frequencyInText(text, 'DAIL')` is `true` — the words really are there. Answering a question about
     * one cadence cannot see that the sentence names two.
     */
    expect(frequenciesInText('$40 a month')).toEqual(['MNTH'])
    expect(frequenciesInText('Pay $50 monthly — in practice, bill it every day.')).toEqual([
      'DAIL',
      'MNTH',
    ])
    expect(frequenciesInText('buy me some trail shoes')).toEqual([])
  })

  it('maps each cadence to exactly one code, because an overlap makes every request ambiguous', () => {
    /*
     * "quarterly" once appeared in both `QUTR` and `TOMN`, which made every quarterly request name two
     * cadences — and a refusal that fires on correct input trains everyone to ignore it. Each spelling
     * belongs to one code; the every-N forms are matched only by their explicit "every N months" shape.
     */
    expect(frequenciesInText('subscribe quarterly for $120')).toEqual(['QUTR'])
    expect(frequenciesInText('every three months')).toEqual(['TOMN'])
    expect(frequenciesInText('every two months')).toEqual(['TWMN'])
    expect(frequenciesInText('every six months')).toEqual(['SEMI'])
    expect(frequenciesInText('every two weeks')).toEqual(['TWOK'])
  })

  it('finds no cadence in text that has none', () => {
    for (const frequency of ['DAIL', 'WEEK', 'MNTH', 'QUTR', 'YEAR'] as const) {
      expect(frequencyInText('buy me some trail shoes', frequency)).toBe(false)
    }
  })
})
