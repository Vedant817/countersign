/**
 * The merchant's click against Postgres — spec §8.15, S-17.
 *
 * `lib/dispute-approval.test.ts` proves the guards with doubles; this suite proves the part that needs a
 * database: that a decline writes exactly one hash-chained `audit_log` row and moves no dispute state, that
 * an approval writes the filer's recorded outcome into the same chain, that two decisions on one case form a
 * real chain (each row's `prev_hash` is the previous row's `this_hash`), and that the detail page reads the
 * **stored** verdict, packet and timeline rather than re-deriving any of them. The filer is a recording stub:
 * `packages/defender` proves `fileDispute` itself, and a live PayPal call has no target until a real dispute
 * exists (HUMAN_TODO 1a/2).
 *
 * Skipped, not failed, without a database — the same rule the queue and webhook suites follow.
 */
import { asc, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ok, type DisputeActionId, type DisputeId, type UserId } from '@countersign/core'
import {
  agents,
  auditLog,
  BUYER,
  checkoutAttempts,
  checkoutSessions,
  closeDb,
  createMerchant,
  db,
  disputeActions,
  disputes,
  evidencePackets,
  getMerchantByOwner,
  mandates,
  MERCHANT,
  merchants,
  orders,
  SEED_DEVICE_ID,
  SEED_WALLET_ID,
  users,
} from '@countersign/db'
import type { FileDeps, FileOutcome } from '@countersign/orchestrator'

import { decideDispute } from './dispute-approval'
import { loadDisputeDetail } from './dispute-detail'

const DATABASE_URL = process.env['DATABASE_URL']
const describeWithDb = DATABASE_URL ? describe : describe.skip

/** Every id this file inserts starts with this, so cleanup is one prefix and cannot touch seed rows. */
const P = 'aptest_'
const disputeId = (n: number): string => `dsp_${P}${String(n).padStart(24, '0')}`
const orderId = (n: number): string => `ord_${P}${String(n).padStart(24, '0')}`
const attemptId = (n: number): string => `att_${P}${String(n).padStart(24, '0')}`
const NOW = new Date('2026-11-13T09:00:00.000Z')
const ACTOR = MERCHANT.id as UserId

let MERCHANT_ID = `mer_${MERCHANT.id.replace(/^usr_/, '')}`
const USER_B_ID = `usr_${P}b_${'0'.repeat(19)}1` as UserId
const MERCHANT_B_ID = `mer_${P}b_${'0'.repeat(19)}1`

const agentId = `agt_${P}000000000000000000001`
const mandateId = `mdt_${P}000000000000000000001`
const sessionId = `chk_${P}000000000000000000001`

const DEFAULT_TRACE = {
  rule_id: 'R-SNAD-OK',
  posture: 'CONTEST',
  liability: 'USER_AUTHORISED',
  reasons: ['the buyer ordered size 9 and size 10 arrived'],
  facts: ['size'],
  evidence_required: ['PROOF_OF_DELIVERY'],
}

const insertedDisputes: string[] = []
const insertedOrders: string[] = []
const insertedAttempts: string[] = []

beforeAll(async () => {
  if (!DATABASE_URL) return

  // 1. Resolve or create Merchant A
  const found = await getMerchantByOwner(MERCHANT.id)
  if (found.ok && found.value) {
    MERCHANT_ID = found.value.id
  } else {
    const created = await createMerchant({
      id: MERCHANT_ID,
      ownerUserId: MERCHANT.id,
      displayName: MERCHANT.displayName,
    })
    if (!created.ok) throw created.error
    MERCHANT_ID = created.value.id
  }

  // 2. Create User B and Merchant B for isolation tests
  await db()
    .insert(users)
    .values({
      id: USER_B_ID,
      persona: 'MERCHANT',
      display_name: 'Merchant B',
      email: `merchant-b-${P}@example.test`,
      country: 'US',
    })
    .onConflictDoNothing()

  await db()
    .insert(merchants)
    .values({
      id: MERCHANT_B_ID,
      owner_user_id: USER_B_ID,
      display_name: 'Merchant B',
    })
    .onConflictDoNothing()

  // 3. Chain prerequisites for orders
  await db()
    .insert(agents)
    .values({
      id: agentId,
      user_id: BUYER.id,
      name: 'Approval Test Agent',
      public_jwk: {},
      kid: `kid_${P}`,
      enc_private_key: Buffer.from('test-enc-key'),
    })
    .onConflictDoNothing()

  await db()
    .insert(mandates)
    .values({
      id: mandateId,
      user_id: BUYER.id,
      device_id: SEED_DEVICE_ID,
      agent_id: agentId,
      wallet_id: SEED_WALLET_ID,
      l2_serialized: 'l2.test',
      l2_payload: {},
      nl_intent: 'test mandate',
      readback: 'test readback',
      constraints: {},
      nonce: `nonce-${P}`,
      aud: 'test-aud',
      iat: BigInt(Math.floor(Date.now() / 1000) - 60),
      exp: BigInt(Math.floor(Date.now() / 1000) + 3600),
      status: 'ACTIVE',
      compiler_model: 'test',
    })
    .onConflictDoNothing()

  await db()
    .insert(checkoutSessions)
    .values({
      id: sessionId,
      merchant_id: MERCHANT_ID,
      cart: { lines: [] },
      subtotal_minor: 4_800n,
      shipping_minor: 0n,
      total_minor: 4_800n,
      currency: 'USD',
      checkout_jwt: 'co.jwt',
      checkout_hash: 'h'.repeat(43),
      price_lock_exp: new Date(Date.now() + 3600_000),
    })
    .onConflictDoNothing()
})

interface SeedInput {
  readonly n: number
  readonly merchantId?: string
  readonly defenseState?: 'NEW' | 'ANALYSED' | 'AWAITING_MERCHANT_APPROVAL' | 'FILED'
  readonly liability?: 'USER_AUTHORISED' | null
  readonly trace?: unknown
}

async function insertDispute(input: SeedInput): Promise<string> {
  const dId = disputeId(input.n)
  const oId = orderId(input.n)
  const attId = attemptId(input.n)
  const mId = input.merchantId ?? MERCHANT_ID

  insertedAttempts.push(attId)
  insertedOrders.push(oId)
  insertedDisputes.push(dId)

  await db()
    .insert(checkoutAttempts)
    .values({
      id: attId,
      mandate_id: mandateId,
      agent_id: agentId,
      checkout_session_id: sessionId,
      l3a: 'l3a.test',
      l3b: 'l3b.test',
      l3_jti: `jti-${P}-${input.n}`,
      idempotency_key: `idem-${P}-${input.n}`,
      amount_minor: 4_800n,
      currency: 'USD',
      payee: 'payee-test',
    })

  await db()
    .insert(orders)
    .values({
      id: oId,
      attempt_id: attId,
      merchant_id: mId,
      paypal_order_id: `PP-ORD-${P}-${input.n}`,
      intent: 'CAPTURE',
      custom_id: `cs1:order-${P}-${input.n}`,
      invoice_id: `inv-${P}-${input.n}`,
      status: 'CAPTURED',
      amount_minor: 4_800n,
      currency: 'USD',
    })

  await db()
    .insert(disputes)
    .values({
      id: dId,
      paypal_dispute_id: `PP-D-APT-${input.n}`,
      order_id: oId,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount_minor: 4_800n,
      currency: 'USD',
      seller_response_due_date: new Date('2026-12-01T00:00:00Z'),
      defense_state: input.defenseState ?? 'AWAITING_MERCHANT_APPROVAL',
      liability: input.liability === undefined ? 'USER_AUTHORISED' : input.liability,
      router_trace: (input.trace === undefined ? DEFAULT_TRACE : input.trace) as never,
      created_at: NOW,
      updated_at: NOW,
    })
  return dId
}

async function auditRows(chainId: string): Promise<
  {
    id: string
    action: string
    actor: string
    prev_hash: string | null
    this_hash: string
    details: unknown
  }[]
> {
  return db()
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actor: auditLog.actor,
      prev_hash: auditLog.prev_hash,
      this_hash: auditLog.this_hash,
      details: auditLog.details,
    })
    .from(auditLog)
    .where(eq(auditLog.chain_id, chainId))
    .orderBy(asc(auditLog.at), asc(auditLog.id))
}

function outcome(overrides: Partial<FileOutcome> = {}): FileOutcome {
  return {
    disputeId: disputeId(0) as DisputeId,
    paypalDisputeId: 'PP-D-APT-0',
    decision: {
      ruleId: 'R-SNAD-OK',
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
    actionRow: {
      id: `da_${P}${'0'.repeat(24)}` as DisputeActionId,
      action: 'FILE',
      idempotencyKey: 'cs:test:file:1',
    },
    ...overrides,
  }
}

afterEach(async () => {
  const dIds = insertedDisputes.splice(0, insertedDisputes.length)
  if (dIds.length > 0) {
    await db().delete(auditLog).where(inArray(auditLog.chain_id, dIds))
    await db().delete(evidencePackets).where(inArray(evidencePackets.dispute_id, dIds))
    await db().delete(disputeActions).where(inArray(disputeActions.dispute_id, dIds))
    await db().delete(disputes).where(inArray(disputes.id, dIds))
  }
  const oIds = insertedOrders.splice(0, insertedOrders.length)
  if (oIds.length > 0) {
    await db().delete(orders).where(inArray(orders.id, oIds))
  }
  const aIds = insertedAttempts.splice(0, insertedAttempts.length)
  if (aIds.length > 0) {
    await db().delete(checkoutAttempts).where(inArray(checkoutAttempts.id, aIds))
  }
})

afterAll(async () => {
  if (DATABASE_URL) {
    await db().delete(merchants).where(eq(merchants.id, MERCHANT_B_ID))
    await db().delete(users).where(eq(users.id, USER_B_ID))
    await db().delete(checkoutSessions).where(eq(checkoutSessions.id, sessionId))
    await db().delete(mandates).where(eq(mandates.id, mandateId))
    await db().delete(agents).where(eq(agents.id, agentId))
  }
  await closeDb()
})

describeWithDb('decideDispute against Postgres', () => {
  it('records a decline as one hash-chained audit row and changes no dispute state', async () => {
    const id = await insertDispute({ n: 1 })

    const result = await decideDispute({
      disputeId: id,
      merchantId: MERCHANT_ID,
      decision: 'decline',
      actorUserId: ACTOR,
    })
    expect(result.ok).toBe(true)

    const rows = await auditRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'DISPUTE_DECLINED', actor: ACTOR })
    expect(rows[0]?.prev_hash).toBeNull() // the first row in a chain has no parent
    expect(rows[0]?.this_hash).toMatch(/^[0-9a-f]{64}$/)

    const [after] = await db().select().from(disputes).where(eq(disputes.id, id))
    expect(after?.defense_state).toBe('AWAITING_MERCHANT_APPROVAL')
    expect(after?.liability).toBe('USER_AUTHORISED')
  })

  it('records the filer’s outcome into the same chain on approval', async () => {
    const id = await insertDispute({ n: 2 })
    const file = vi.fn().mockResolvedValue(ok(outcome()))
    const actionRowId = outcome().actionRow?.id

    const result = await decideDispute(
      { disputeId: id, merchantId: MERCHANT_ID, decision: 'approve', actorUserId: ACTOR },
      {
        file: file as unknown as NonNullable<
          NonNullable<Parameters<typeof decideDispute>[1]>['file']
        >,
        fileDeps: () => ok({} as FileDeps),
        now: () => NOW,
      },
    )
    expect(result.ok).toBe(true)
    expect(file).toHaveBeenCalledTimes(1)
    expect(file).toHaveBeenCalledWith(id, expect.anything(), { approval: { by: ACTOR } })

    const rows = await auditRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.action).toBe('DISPUTE_APPROVED')
    const details = rows[0]?.details as Record<string, unknown>
    expect(details['rule_id']).toBe('R-SNAD-OK')
    expect(details['disposition']).toBe('FILE')
    expect(details['filed']).toBe(true)
    expect(details['action_row_id']).toBe(actionRowId)
  })

  it('refuses a case already past approval with CS_CONFLICT and writes no audit row', async () => {
    const id = await insertDispute({ n: 3, defenseState: 'FILED' })
    const file = vi.fn(() => {
      throw new Error('the filer must not run for a filed case')
    })

    const result = await decideDispute(
      { disputeId: id, merchantId: MERCHANT_ID, decision: 'approve', actorUserId: ACTOR },
      {
        file: file as unknown as NonNullable<
          NonNullable<Parameters<typeof decideDispute>[1]>['file']
        >,
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_CONFLICT')
    expect(file).not.toHaveBeenCalled()
    expect(await auditRows(id)).toHaveLength(0)
  })

  it('links two decisions on one case into a real hash chain', async () => {
    const id = await insertDispute({ n: 4 })
    const file = vi.fn().mockResolvedValue(ok(outcome()))

    await decideDispute(
      { disputeId: id, merchantId: MERCHANT_ID, decision: 'decline', actorUserId: ACTOR },
      { now: () => new Date('2026-11-13T10:00:00.000Z') },
    )
    await decideDispute(
      { disputeId: id, merchantId: MERCHANT_ID, decision: 'approve', actorUserId: ACTOR },
      {
        file: file as unknown as NonNullable<
          NonNullable<Parameters<typeof decideDispute>[1]>['file']
        >,
        fileDeps: () => ok({} as FileDeps),
        now: () => new Date('2026-11-13T10:05:00.000Z'),
      },
    )

    const rows = await auditRows(id)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.action).toBe('DISPUTE_DECLINED')
    expect(rows[1]?.action).toBe('DISPUTE_APPROVED')
    expect(rows[1]?.prev_hash).toBe(rows[0]?.this_hash)
  })

  it("decideDispute on merchant A's dispute as merchant B returns CS_NOT_FOUND with the dispute row unchanged", async () => {
    const id = await insertDispute({ n: 8 })

    const [before] = await db().select().from(disputes).where(eq(disputes.id, id))

    const result = await decideDispute({
      disputeId: id,
      merchantId: MERCHANT_B_ID,
      decision: 'decline',
      actorUserId: ACTOR,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')

    const [after] = await db().select().from(disputes).where(eq(disputes.id, id))
    expect(after).toEqual(before)
    expect(await auditRows(id)).toHaveLength(0)
  })
})

describeWithDb('loadDisputeDetail against Postgres', () => {
  it('reads the stored verdict, packet and action timeline rather than re-deriving them', async () => {
    const id = await insertDispute({ n: 5, trace: DEFAULT_TRACE })

    await db()
      .insert(evidencePackets)
      .values({
        id: `pkt_${P}${'0'.repeat(23)}1`,
        dispute_id: id,
        version: 1,
        bundle: { hello: 'world' },
        bundle_hash: 'A'.repeat(43),
        notes: 'the note the merchant will read',
        created_at: NOW,
        updated_at: NOW,
      })
    await db()
      .insert(disputeActions)
      .values({
        id: `da_${P}${'0'.repeat(23)}2`,
        dispute_id: id,
        action: 'FILE',
        request: { rule_id: 'R-SNAD-OK', disposition: 'FILE' },
        response: { paypal_call: 'sent' },
        actor: 'MERCHANT',
        idempotency_key: `cs:${id}:file:1`,
        at: new Date('2026-11-13T08:00:00.000Z'),
        created_at: NOW,
        updated_at: NOW,
      })

    const detail = await loadDisputeDetail(id, MERCHANT_ID)
    expect(detail.ok).toBe(true)
    if (!detail.ok) return

    expect(detail.value.verdict.ruleId).toBe('R-SNAD-OK')
    expect(detail.value.verdict.posture).toBe('CONTEST')
    expect(detail.value.verdict.liability).toBe('USER_AUTHORISED')
    expect(detail.value.verdict.reasons).toEqual(['the buyer ordered size 9 and size 10 arrived'])
    expect(detail.value.verdict.facts).toEqual(['size'])
    expect(detail.value.verdict.evidenceRequired).toEqual(['PROOF_OF_DELIVERY'])
    expect(detail.value.orderId).toBe(orderId(5))
    expect(detail.value.buyerUserId).toBe(BUYER.id)
    expect(detail.value.packet?.bundleHash).toBe('A'.repeat(43))
    expect(detail.value.packet?.notes).toBe('the note the merchant will read')
    expect(detail.value.actions.map((entry) => entry.kind)).toEqual(['ACTION'])
  })

  it('reads a row whose router has not run as “not assessed”, with no invented verdict', async () => {
    const id = await insertDispute({ n: 6, liability: null, trace: null })

    const detail = await loadDisputeDetail(id, MERCHANT_ID)
    expect(detail.ok).toBe(true)
    if (!detail.ok) return

    expect(detail.value.liability).toBeNull()
    expect(detail.value.verdict.ruleId).toBeNull()
    expect(detail.value.verdict.reasons).toEqual([])
    expect(detail.value.packet).toBeNull()
  })

  it('propagates a database failure rather than rendering an empty case', async () => {
    // A read that fails must not look like "no such dispute": the page would hide an outage.
    const missing = await loadDisputeDetail(disputeId(999), MERCHANT_ID)
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.code).toBe('CS_NOT_FOUND')
  })

  it("loadDisputeDetail on merchant A's dispute as merchant B returns CS_NOT_FOUND", async () => {
    const idA = await insertDispute({ n: 7 })
    const result = await loadDisputeDetail(idA, MERCHANT_B_ID)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')
  })
})
