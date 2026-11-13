/**
 * The real dispute queue, against Postgres.
 *
 * `packages/db` proves the reader (`listDisputesForReview`) and `packages/defender` proves the router.
 * What neither can prove is the composition this page uses: that the queue row carries the *stored*
 * verdict rather than a re-derived one, that an unlinked dispute stays unlinked, and that the packet and
 * action counts come from the tables rather than from a default. That is what this suite asserts, and it
 * is the reason the suite inserts real rows instead of mocking the repositories.
 *
 * Skipped, not failed, without a database — the same rule the webhook route suite follows.
 */
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { closeDb, db, disputes } from '@countersign/db'

import {
  DISPUTE_QUEUE_LIMIT,
  disputesUseDemoView,
  loadDisputeQueue,
  routerRuleId,
} from './dispute-queue'

const DATABASE_URL = process.env['DATABASE_URL']
const describeWithDb = DATABASE_URL ? describe : describe.skip

/** Every id this file inserts starts with this, so cleanup is one prefix and cannot touch seed rows. */
const P = 'qtest_'
const disputeId = (n: number): string => `dsp_${P}${String(n).padStart(24, '0')}`

const inserted: string[] = []

async function insertDispute(input: {
  n: number
  paypalId: string
  trace: unknown
  updatedAt: Date
}): Promise<void> {
  const id = disputeId(input.n)
  inserted.push(id)
  await db()
    .insert(disputes)
    .values({
      id,
      paypal_dispute_id: input.paypalId,
      order_id: null,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount_minor: 4_800n,
      currency: 'USD',
      seller_response_due_date: new Date('2026-12-01T00:00:00Z'),
      defense_state: 'NEW',
      router_trace: input.trace as never,
      created_at: input.updatedAt,
      updated_at: input.updatedAt,
    })
}

afterEach(async () => {
  for (const id of inserted.splice(0, inserted.length)) {
    await db().delete(disputes).where(eq(disputes.id, id))
  }
})

afterAll(async () => {
  await closeDb()
})

describeWithDb('loadDisputeQueue', () => {
  it('is a read: an id this suite has not inserted never appears, whatever else is in the table', async () => {
    const result = await loadDisputeQueue(DISPUTE_QUEUE_LIMIT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Array.isArray(result.value)).toBe(true)
    expect(result.value.some((row) => row.id.startsWith(`dsp_${P}`))).toBe(false)
  })

  it('carries the stored verdict and never re-derives one', async () => {
    await insertDispute({
      n: 1,
      paypalId: 'PP-D-QTEST-1',
      trace: { ruleId: 'R-SNAD-OK' },
      updatedAt: new Date('2026-11-01T00:00:00Z'),
    })

    const result = await loadDisputeQueue(DISPUTE_QUEUE_LIMIT)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const row = result.value.find((r) => r.id === disputeId(1))
    expect(row).toBeDefined()
    expect(row?.paypalDisputeId).toBe('PP-D-QTEST-1')
    // No liability column value: the router has not run, and the page must say that rather than guess.
    expect(row?.liability).toBeNull()
    expect(row?.ruleId).toBe('R-SNAD-OK')
    // No order was linked, so the row says so instead of guessing.
    expect(row?.orderId).toBeNull()
    expect(row?.orderStatus).toBeNull()
    // Nothing was filed and nothing was recorded.
    expect(row?.packetId).toBeNull()
    expect(row?.actions).toBe(0)
    // Money is integer minor units and its own currency, never a formatted string.
    expect(row?.amountMinor).toBe(4_800n)
    expect(row?.currency).toBe('USD')
  })

  it('orders newest first and applies the caller’s bound in the query', async () => {
    await insertDispute({
      n: 2,
      paypalId: 'PP-D-QTEST-2',
      trace: null,
      updatedAt: new Date('2026-11-02T00:00:00Z'),
    })
    await insertDispute({
      n: 3,
      paypalId: 'PP-D-QTEST-3',
      trace: null,
      updatedAt: new Date('2026-11-03T00:00:00Z'),
    })

    const result = await loadDisputeQueue(1)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(1)
    expect(result.value[0]?.id).toBe(disputeId(3))
  })
})

describe('disputesUseDemoView', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('serves fixtures only in a non-production build with the flag on', () => {
    vi.stubEnv('COUNTERSIGN_AGENT_DEMO', '1')
    vi.stubEnv('NODE_ENV', 'development')
    expect(disputesUseDemoView()).toBe(true)
  })

  it('never serves fixtures from `next start`, even with the flag on', () => {
    vi.stubEnv('COUNTERSIGN_AGENT_DEMO', '1')
    vi.stubEnv('NODE_ENV', 'production')
    expect(disputesUseDemoView()).toBe(false)
  })

  it('serves the real queue when no flag is set', () => {
    vi.stubEnv('COUNTERSIGN_AGENT_DEMO', '')
    vi.stubEnv('NODE_ENV', 'development')
    expect(disputesUseDemoView()).toBe(false)
  })
})

describe('routerRuleId', () => {
  it('reads the rule id out of a stored trace', () => {
    expect(routerRuleId({ ruleId: 'R-APPEAL-1' })).toBe('R-APPEAL-1')
    expect(routerRuleId({ rule_id: 'R-NOCHAIN-1' })).toBe('R-NOCHAIN-1')
  })

  it('answers null for anything that is not a usable trace, rather than throwing', () => {
    expect(routerRuleId(null)).toBeNull()
    expect(routerRuleId({})).toBeNull()
    expect(routerRuleId({ ruleId: 42 })).toBeNull()
    expect(routerRuleId({ ruleId: '' })).toBeNull()
    expect(routerRuleId('R-SNAD-OK')).toBeNull()
  })
})
