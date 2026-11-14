/**
 * The merchant's click, in isolation — spec §8.15, S-17.
 *
 * `packages/defender` proves the filer; `packages/db` proves the repositories. What neither can prove is
 * the **guard order** this module owns: that a case past approval never reaches PayPal, that the buyer on
 * the disputed order cannot authorise the filing, that a decline records and does not act, and that the
 * filer's own idempotency conflict is reported as "already recorded" rather than as a fault. Those are the
 * properties that keep one click from becoming two PayPal actions, so they are asserted here against
 * repository and filer doubles — no database, and **no PayPal**.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  csError,
  err,
  ok,
  type CsError,
  type DisputeId,
  type Result,
  type UserId,
} from '@countersign/core'
import type * as DbModule from '@countersign/db'
import type { FileDeps, FileOutcome } from '@countersign/orchestrator'

const db = vi.hoisted(() => ({
  findDisputeForMerchant: vi.fn(),
  findDisputeBuyerUserId: vi.fn(),
  appendAudit: vi.fn(),
}))

vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...db,
}))

// The filer and its wiring are injected through `DecisionDeps`, so these are here only to keep the module's
// own imports from reaching a real PayPal client or a real database pool.
vi.mock('@countersign/defender', () => ({ fileDispute: vi.fn() }))
vi.mock('./defender-runtime', () => ({ defenderFileDeps: vi.fn() }))

import {
  AUDIT_ALREADY_FILED,
  AUDIT_APPROVED,
  AUDIT_DECLINED,
  approvedMessage,
  decideDispute,
  decisionAuditId,
  type DecisionDeps,
} from './dispute-approval'

const DISPUTE_ID = 'dsp_000000000000000000000001'
const MERCHANT_ID = 'mer_00000000000000000000000001'
const ACTOR = 'usr_merchant_000000000000000'
const BUYER = 'usr_buyer_00000000000000000'
const FIXED_NOW = new Date('2026-11-13T10:00:00.000Z')

/** A dispute row with only the members this module reads. The repository double does not type-check it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DISPUTE_ID,
    paypal_dispute_id: 'PP-D-TEST-1',
    order_id: null,
    reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
    stage: 'CHARGEBACK',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    amount_minor: 4_800n,
    currency: 'USD',
    defense_state: 'AWAITING_MERCHANT_APPROVAL',
    liability: 'USER_AUTHORISED',
    router_trace: null,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    ...overrides,
  }
}

/** A filer outcome with only the members this module reads. */
function outcome(overrides: Partial<FileOutcome> = {}): FileOutcome {
  return {
    disputeId: DISPUTE_ID as DisputeId,
    paypalDisputeId: 'PP-D-TEST-1',
    decision: {
      ruleId: 'R-TEST-1',
      liability: 'USER_AUTHORISED',
      posture: 'CONTEST',
    } as unknown as FileOutcome['decision'],
    disposition: 'FILE',
    filed: true,
    alreadyFiled: false,
    awaitingApproval: false,
    awaitingHuman: false,
    paypalCalls: ['provideEvidence'],
    warnings: [],
    ...overrides,
  }
}

let file: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  db.findDisputeForMerchant.mockResolvedValue(ok(row()))
  db.findDisputeBuyerUserId.mockResolvedValue(ok(undefined))
  db.appendAudit.mockResolvedValue(ok({ id: 'aud_test' }))
  file = vi.fn().mockResolvedValue(ok(outcome()))
})

function deps(overrides: Partial<DecisionDeps> = {}): DecisionDeps {
  return {
    file: file as unknown as NonNullable<DecisionDeps['file']>,
    fileDeps: () => ok({} as FileDeps),
    now: () => FIXED_NOW,
    ...overrides,
  }
}

function input(
  overrides: Partial<{
    disputeId: string
    merchantId: string
    decision: 'approve' | 'decline'
    note: string
  }> = {},
): Parameters<typeof decideDispute>[0] {
  return {
    disputeId: DISPUTE_ID,
    merchantId: MERCHANT_ID,
    decision: 'approve',
    actorUserId: ACTOR as UserId,
    ...overrides,
  }
}

/** The one audit row this module writes, or `undefined` when it wrote none. */
function auditRow(): Record<string, unknown> | undefined {
  const call = db.appendAudit.mock.calls[0]?.[0] as Record<string, unknown> | undefined
  return call
}

describe('decideDispute — approve', () => {
  it('runs the real filer with the merchant as the approver and records the decision', async () => {
    const result = await decideDispute(input(), deps())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(file).toHaveBeenCalledTimes(1)
    expect(file).toHaveBeenCalledWith(DISPUTE_ID, expect.anything(), {
      approval: { by: ACTOR },
    })

    expect(result.value.applied).toBe(true)
    expect(result.value.filed).toBe(true)
    expect(result.value.disposition).toBe('FILE')
    expect(result.value.ruleId).toBe('R-TEST-1')
    expect(result.value.paypalCalls).toEqual(['provideEvidence'])
    expect(result.value.actionRowId).toBeNull()

    expect(auditRow()).toMatchObject({
      id: decisionAuditId(DISPUTE_ID, 'approve', FIXED_NOW),
      chainId: DISPUTE_ID,
      actor: ACTOR,
      action: AUDIT_APPROVED,
      subject: DISPUTE_ID,
    })
  })

  it('carries the merchant’s note to the filer, verbatim, when they typed one', async () => {
    await decideDispute(input({ note: 'the buyer kept the item' }), deps())
    expect(file).toHaveBeenCalledWith(DISPUTE_ID, expect.anything(), {
      approval: { by: ACTOR, note: 'the buyer kept the item' },
    })
    expect((auditRow()?.['details'] as Record<string, unknown>)['note']).toBe(
      'the buyer kept the item',
    )
  })

  it('does not invent a note the merchant did not type', async () => {
    await decideDispute(input(), deps())
    expect(file).toHaveBeenCalledWith(DISPUTE_ID, expect.anything(), { approval: { by: ACTOR } })
    expect((auditRow()?.['details'] as Record<string, unknown>)['note']).toBeNull()
  })

  it('refuses before the filer when the deployment cannot build the filer’s dependencies', async () => {
    const failure: Result<never, CsError> = err(
      csError('CS_INTERNAL', 'PUBLIC_BASE_URL is not set'),
    )
    const result = await decideDispute(input(), deps({ fileDeps: () => failure }))
    expect(result).toEqual(failure)
    expect(file).not.toHaveBeenCalled()
    expect(db.appendAudit).not.toHaveBeenCalled()
  })
})

describe('decideDispute — decline', () => {
  it('records the decision, sends nothing to PayPal, and does not call the filer', async () => {
    const result = await decideDispute(input({ decision: 'decline' }), deps())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(file).not.toHaveBeenCalled()
    expect(result.value.applied).toBe(false)
    expect(result.value.disposition).toBeNull()
    expect(result.value.paypalCalls).toEqual([])
    expect(result.value.filed).toBe(false)

    expect(auditRow()).toMatchObject({
      chainId: DISPUTE_ID,
      actor: ACTOR,
      action: AUDIT_DECLINED,
      subject: DISPUTE_ID,
    })
  })
})

describe('decideDispute — the guards', () => {
  it('refuses a case already past approval with CS_CONFLICT and no PayPal call', async () => {
    db.findDisputeForMerchant.mockResolvedValue(ok(row({ defense_state: 'FILED' })))
    const result = await decideDispute(input(), deps())
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.code).toBe('CS_CONFLICT')
    expect(file).not.toHaveBeenCalled()
    expect(db.appendAudit).not.toHaveBeenCalled()
  })

  it.each([
    'FILED',
    'OFFERED',
    'ACCEPTED',
    'CLOSED_WON',
    'CLOSED_LOST',
    'CLOSED_REFUNDED',
  ] as const)('treats %s as already past the click', async (state) => {
    db.findDisputeForMerchant.mockResolvedValue(ok(row({ defense_state: state })))
    const result = await decideDispute(input(), deps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_CONFLICT')
    expect(file).not.toHaveBeenCalled()
  })

  it.each(['approve', 'decline'] as const)(
    'refuses the buyer on the disputed order from deciding (%s)',
    async (decision) => {
      db.findDisputeBuyerUserId.mockResolvedValue(ok(BUYER))
      const asBuyer = await decideDispute(
        { ...input({ decision }), actorUserId: BUYER as UserId },
        deps(),
      )
      expect(asBuyer.ok).toBe(false)
      if (asBuyer.ok) return
      expect(asBuyer.error.code).toBe('CS_FORBIDDEN')
      expect(file).not.toHaveBeenCalled()
      expect(db.appendAudit).not.toHaveBeenCalled()
    },
  )

  it('reports the filer’s idempotency conflict as “already recorded”, not as a fault', async () => {
    file.mockResolvedValue(err(csError('CS_CONFLICT', 'duplicate idempotency key')))
    const result = await decideDispute(input(), deps())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.applied).toBe(false)
    expect(result.value.paypalCalls).toEqual([])
    expect(auditRow()).toMatchObject({ action: AUDIT_ALREADY_FILED, chainId: DISPUTE_ID })
  })

  it('propagates a real PayPal 404 instead of turning it into a success', async () => {
    // The honest S-17 case: no captured payment, so PayPal has no dispute to file against. The merchant
    // reads PayPal’s own answer; nothing here pretends the packet was filed.
    file.mockResolvedValue(err(csError('PP_NOT_FOUND', 'PayPal has no dispute PP-D-ABSENT')))
    const result = await decideDispute(input(), deps())
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.code).toBe('PP_NOT_FOUND')
    expect(db.appendAudit).not.toHaveBeenCalled()
  })

  it('reports a dispute that is not in this deployment’s records as CS_NOT_FOUND', async () => {
    db.findDisputeForMerchant.mockResolvedValue(ok(undefined))
    const result = await decideDispute(input(), deps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')
    expect(file).not.toHaveBeenCalled()
  })

  it("another merchant's dispute -> CS_NOT_FOUND and no PayPal call (file not invoked)", async () => {
    // When queried with another merchant's id, the repo returns undefined (not found for that merchant)
    db.findDisputeForMerchant.mockImplementation(async (dispId, mId) => {
      if (mId === 'mer_other') return ok(undefined)
      return ok(row())
    })

    const result = await decideDispute(input({ merchantId: 'mer_other' }), deps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')
    expect(file).not.toHaveBeenCalled()
    expect(db.appendAudit).not.toHaveBeenCalled()
  })

  it('propagates a repository failure rather than rendering an empty case', async () => {
    const failure: Result<never, CsError> = err(
      csError('CS_INTERNAL', 'the database is unreachable'),
    )
    db.findDisputeForMerchant.mockResolvedValue(failure)
    expect(await decideDispute(input(), deps())).toEqual(failure)
    expect(file).not.toHaveBeenCalled()
  })
})

describe('decisionAuditId', () => {
  it('is stable for the same click and distinct for a different click', () => {
    const base = decisionAuditId(DISPUTE_ID, 'approve', FIXED_NOW)
    expect(decisionAuditId(DISPUTE_ID, 'approve', FIXED_NOW)).toBe(base)
    expect(decisionAuditId(DISPUTE_ID, 'approve', new Date(FIXED_NOW.getTime() + 1_000))).not.toBe(
      base,
    )
    expect(decisionAuditId(DISPUTE_ID, 'decline', FIXED_NOW)).not.toBe(base)
    expect(base.startsWith('aud_')).toBe(true)
    expect(base).toHaveLength('aud_'.length + 26)
  })
})

describe('approvedMessage', () => {
  it('names the refusal, the filing, the PayPal call, the human and the wait', () => {
    expect(
      approvedMessage(
        outcome({
          refusal: {
            code: 'DEF_DEADLINE_PASSED',
            reason: 'too late to file',
            manual: true,
            userMessage: 'the deadline passed',
          },
        }),
      ),
    ).toContain('refused')
    expect(approvedMessage(outcome())).toContain('filed')
    expect(approvedMessage(outcome({ filed: false, paypalCalls: ['refund'] }))).toContain('refund')
    expect(
      approvedMessage(outcome({ filed: false, paypalCalls: [], awaitingHuman: true })),
    ).toContain('human')
    expect(
      approvedMessage(outcome({ filed: false, paypalCalls: [], awaitingApproval: true })),
    ).toContain('waiting')
  })
})
