/**
 * WP-19 retention and erasure — spec §8.19 (AT-M19.1) and §12.13 (EC-PRIV-1).
 *
 * The acceptance test this file exists for is AT-M19.1: *"Erasure blocked by a legal hold, then
 * allowed after resolution."* That sentence is easy to satisfy weakly — any function that returns
 * HOLD when a dispute exists and ERASE otherwise passes it — so the cases below pin the parts that a
 * weak implementation gets wrong:
 *
 *  - resolution releases the **dispute** hold, and the **evidence window** is checked separately, so
 *    a resolved dispute inside the 540-day window is still a HOLD with a date rather than a deletion;
 *  - a dispute hold promises **no date** (we cannot know when a case closes) while a window hold
 *    promises the exact day;
 *  - the 48-hour notice is a floor on the purge even when nothing is held; and
 *  - a class with no timer refuses to produce a deadline instead of inventing one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EVIDENCE_WINDOW_DAYS,
  LOG_RETENTION_DAYS,
  PRE_ERASURE_NOTICE_HOURS,
  RETENTION_POLICY,
  SECONDS_PER_DAY,
  evidenceWindowEndsAtSec,
  isoDate,
  planErasure,
  retentionDeadline,
  retentionRule,
  withinRetention,
} from '../src/index'

/** A fixed clock: 2027-01-15T00:00:00Z. Every case is relative to it, so the file never drifts. */
const NOW = Date.UTC(2027, 0, 15) / 1000

const insideWindow = NOW - 30 * SECONDS_PER_DAY
const outsideWindow = NOW - (EVIDENCE_WINDOW_DAYS + 1) * SECONDS_PER_DAY

describe('AT-M19.1 / EC-PRIV-1: erasure is blocked by a legal hold and allowed after resolution', () => {
  it('holds while a dispute is open, naming it and promising no date it cannot keep', () => {
    const decision = planErasure({
      userId: 'usr_1',
      openDisputes: [{ disputeId: 'dsp_01HX', captureId: 'cap_1' }],
      lastCaptureAtSec: insideWindow,
      nowSec: NOW,
    })
    if (!decision.ok) throw new Error(`unexpected error: ${decision.error.code}`)

    expect(decision.value.action).toBe('HOLD')
    expect(decision.value.holdReason).toBe('open dispute dsp_01HX')
    // EC-PRIV-1 requires a date in the message, so there is one — but it is marked provisional,
    // because the case may still be open when the window closes.
    expect(decision.value.eraseAfterSec).toBe(evidenceWindowEndsAtSec(insideWindow))
    expect(decision.value.provisional).toBe(true)
    expect(decision.value.userMessage).toContain('dsp_01HX')
    expect(decision.value.userMessage).toContain('moves')
  })

  it('is still held after the dispute resolves, because the 540-day window is separate', () => {
    const decision = planErasure({
      userId: 'usr_1',
      openDisputes: [],
      lastCaptureAtSec: insideWindow,
      nowSec: NOW,
    })
    if (!decision.ok) throw new Error(`unexpected error: ${decision.error.code}`)

    expect(decision.value.action).toBe('HOLD')
    expect(decision.value.holdReason).toBe(
      `evidence window until ${isoDate(insideWindow + EVIDENCE_WINDOW_DAYS * SECONDS_PER_DAY)}`,
    )
    // Unlike the dispute case, this date is arithmetic and therefore final.
    expect(decision.value.provisional).toBe(false)
    // Unlike the dispute case, this date is final and is what the subject is told.
    expect(decision.value.userMessage).toContain(
      isoDate(insideWindow + EVIDENCE_WINDOW_DAYS * SECONDS_PER_DAY),
    )
  })

  it('allows erasure once no dispute is open and the window has closed', () => {
    const decision = planErasure({
      userId: 'usr_1',
      openDisputes: [],
      lastCaptureAtSec: outsideWindow,
      nowSec: NOW,
    })
    if (!decision.ok) throw new Error(`unexpected error: ${decision.error.code}`)

    expect(decision.value.action).toBe('ERASE')
    expect(decision.value.holdReason).toBeUndefined()
    // The 48-hour notice is a floor on the purge, not a hold: the subject asked for this.
    expect(decision.value.eraseAfterSec).toBe(NOW + PRE_ERASURE_NOTICE_HOURS * 3_600)
    expect(decision.value.provisional).toBe(false)
  })

  it('erases a subject who never bought anything, with no window to wait for', () => {
    const decision = planErasure({
      userId: 'usr_never_bought',
      openDisputes: [],
      lastCaptureAtSec: null,
      nowSec: NOW,
    })
    if (!decision.ok) throw new Error(`unexpected error: ${decision.error.code}`)
    expect(decision.value.action).toBe('ERASE')
  })

  it('holds on the dispute even when the window has closed, so a case is never deleted mid-flight', () => {
    const decision = planErasure({
      userId: 'usr_1',
      openDisputes: [{ disputeId: 'dsp_open', captureId: 'cap_1' }],
      lastCaptureAtSec: outsideWindow,
      nowSec: NOW,
    })
    if (!decision.ok) throw new Error(`unexpected error: ${decision.error.code}`)
    expect(decision.value.action).toBe('HOLD')
    expect(decision.value.holdReason).toBe('open dispute dsp_open')
  })

  it('lists several open disputes deterministically, so two runs give the same reason string', () => {
    const decision = planErasure({
      userId: 'usr_1',
      openDisputes: [
        { disputeId: 'dsp_b', captureId: null },
        { disputeId: 'dsp_a', captureId: 'cap_1' },
      ],
      lastCaptureAtSec: insideWindow,
      nowSec: NOW,
    })
    if (!decision.ok) throw new Error(`unexpected error: ${decision.error.code}`)
    expect(decision.value.holdReason).toBe('open dispute dsp_a, dsp_b')
  })

  it('refuses malformed facts rather than guessing', () => {
    expect(
      planErasure({ userId: 'u', openDisputes: [], lastCaptureAtSec: null, nowSec: -1 }).ok,
    ).toBe(false)
    expect(
      planErasure({
        userId: 'u',
        openDisputes: [{ disputeId: '  ', captureId: null }],
        lastCaptureAtSec: null,
        nowSec: NOW,
      }).ok,
    ).toBe(false)
    expect(
      planErasure({ userId: 'u', openDisputes: [], lastCaptureAtSec: 1.5, nowSec: NOW }).ok,
    ).toBe(false)
  })
})

describe('the §12.13 retention table', () => {
  it('carries all six rows the spec lists, with the spec numbers', () => {
    expect(RETENTION_POLICY).toHaveLength(6)
    expect(retentionRule('MANDATES_AND_DECISIONS').days).toBe(540)
    expect(retentionRule('EVIDENCE_PACKETS').days).toBe(540)
    expect(retentionRule('OPERATIONAL_LOGS').days).toBe(365)
    expect(retentionRule('LLM_PROMPTS').days).toBe(30)
    expect(retentionRule('WEBHOOK_PAYLOADS').days).toBe(90)
    expect(retentionRule('ACCOUNT_AND_WALLET').days).toBeNull()
  })

  it('marks only the DPDP log minimum as a floor, because only it is legally imposed', () => {
    const floors = RETENTION_POLICY.filter((rule) => rule.floor).map((rule) => rule.id)
    expect(floors).toEqual(['OPERATIONAL_LOGS'])
  })

  it('computes a deadline in whole days from the processing instant', () => {
    const processed = 1_700_000_000
    const deadline = retentionDeadline('WEBHOOK_PAYLOADS', processed)
    if (!deadline.ok) throw new Error('expected a deadline')
    expect(deadline.value).toBe(processed + 90 * SECONDS_PER_DAY)
  })

  it('refuses to invent a deadline for a class that has none', () => {
    const result = retentionDeadline('ACCOUNT_AND_WALLET', 1_700_000_000)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('CS_VALIDATION')
  })

  it('treats "no timer" as retained, never as expired', () => {
    // The bug this catches: `deadline.ok ? now < value : false` would purge every account row on the
    // first run of the sweep, because "no deadline" would read as "past its deadline".
    expect(withinRetention('ACCOUNT_AND_WALLET', 0, NOW)).toBe(true)
  })

  it('is inside the window up to the instant before the deadline', () => {
    const processed = 1_700_000_000
    const deadline = processed + LOG_RETENTION_DAYS * SECONDS_PER_DAY
    expect(withinRetention('OPERATIONAL_LOGS', processed, deadline - 1)).toBe(true)
    expect(withinRetention('OPERATIONAL_LOGS', processed, deadline)).toBe(false)
  })
})

describe('isoDate', () => {
  it('renders a UTC date, not a local one', () => {
    // 2027-01-15T00:00:00Z is still the 14th in every negative-offset timezone; a local-date
    // implementation would fail this on the machine that runs it, which is the point.
    expect(isoDate(NOW)).toBe('2027-01-15')
  })
})

describe('the pseudonym salt', () => {
  const original = process.env['PRIVACY_PSEUDONYM_SALT']

  beforeEach(() => {
    process.env['PRIVACY_PSEUDONYM_SALT'] = 'a-test-salt-long-enough'
  })
  afterEach(() => {
    if (original === undefined) delete process.env['PRIVACY_PSEUDONYM_SALT']
    else process.env['PRIVACY_PSEUDONYM_SALT'] = original
  })

  it('is not required for the planner, which never hashes anything', () => {
    delete process.env['PRIVACY_PSEUDONYM_SALT']
    const decision = planErasure({
      userId: 'usr_1',
      openDisputes: [],
      lastCaptureAtSec: null,
      nowSec: NOW,
    })
    expect(decision.ok).toBe(true)
  })
})
