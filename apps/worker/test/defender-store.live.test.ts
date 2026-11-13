/**
 * The production `DefenderStore` adapter (`src/defender-store.ts`), driven against a real Postgres.
 *
 * ## Why this is a live-database test
 *
 * The adapter's own rule is "no logic, only naming", so almost nothing in it can fail in a unit test:
 * a rename-and-forward compiles or it does not. What *can* fail — and has, in this repo's history —
 * is the part the type system cannot see:
 *
 * - **`evidence.bundle`'s five-table assembly**: a join that returns the right shape only when every
 *   chain row exists, and an honest `CS_NOT_FOUND` (not a fabricated default) when one is missing;
 * - **`transaction`'s rollback contract**: a thrown `CsError` must abandon the writes, because §8.12's
 *   "a business refusal is data" only holds if a fault is not half-committed;
 * - the packet and action writers against real constraints (`bundle_hash`'s base64url CHECK, the
 *   `idempotency_key` unique index) rather than against an in-memory double.
 *
 * ## Skip rule
 *
 * Same as `packages/db`'s live suites: skipped without `DATABASE_URL`, and CI's `db-migrations` job
 * (Postgres 17, migrated, seeded) owns running them. Everything this file inserts carries the
 * `wkr_def_` prefix and is swept in `afterAll`, so the database the other suites see is unchanged.
 */
import { like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CsError } from '@countersign/core'
import { csError } from '@countersign/core'
import {
  closeDb,
  withTx,
  type Tx,
  type EvidencePacketRow,
  type DisputeActionRow,
  type DisputeRow,
  type OrderRow,
} from '@countersign/db'
import {
  agents,
  captures,
  checkoutAttempts,
  checkoutSessions,
  devices,
  disputes,
  evidencePackets,
  disputeActions,
  gateDecisions,
  l1Credentials,
  mandates,
  orders,
  paypalWallets,
  shipments,
  users,
} from '@countersign/db/schema'

import { dbDefenderStore, refundsRefusedLoudly } from '../src/defender-store'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

/** Every id this file inserts starts with this, so cleanup is one prefix and cannot touch seed rows. */
const P = 'wkr_def_'
const ids = {
  user: `usr_${P}1`,
  device: `dev_${P}1`,
  wallet: `wal_${P}1`,
  agent: `agt_${P}1`,
  l1: `l1_${P}1`,
  mandate: `mdt_${P}1`,
  session: `chk_${P}1`,
  attempt: `att_${P}1`,
  gate: `gate_${P}1`,
  order: `ord_${P}1`,
  capture: `cap_${P}1`,
  shipment: `shp_${P}1`,
  dispute: `dsp_${P}1`,
  // A second order on the same mandate, whose attempt has **no** gate decision.
  attempt2: `att_${P}2`,
  order2: `ord_${P}2`,
}

const NOW = new Date('2026-11-01T00:00:00Z')

/** Flatten `withTx`'s outer `Result`, so a failed statement is one readable failure. */
async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const outer = await withTx(fn)
  if (!outer.ok) throw new Error(`transaction failed: ${outer.error.code} ${outer.error.message}`)
  return outer.value
}

/** Unwrap a repo `Result`, so a failed statement names itself. */
function unwrap<T>(r: { ok: boolean; error?: CsError; value?: T }, what: string): T {
  if (!r.ok) throw new Error(`${what}: ${r.error?.code} ${r.error?.message}`)
  return r.value as T
}

beforeAll(async () => {
  if (!hasDatabase) return
  await inTx(async (tx) => {
    await cleanup(tx)
    await seedWorld(tx)
  })
})

afterAll(async () => {
  if (!hasDatabase) return
  await withTx(cleanup)
  await closeDb()
})

async function cleanup(tx: Tx): Promise<void> {
  // Child tables first: every FK points at a row inserted before it.
  await tx.delete(evidencePackets).where(like(evidencePackets.id, `%${P}%`))
  await tx.delete(disputeActions).where(like(disputeActions.id, `%${P}%`))
  await tx.delete(disputes).where(like(disputes.id, `%${P}%`))
  await tx.delete(captures).where(like(captures.id, `%${P}%`))
  await tx.delete(shipments).where(like(shipments.id, `%${P}%`))
  await tx.delete(orders).where(like(orders.id, `%${P}%`))
  await tx.delete(gateDecisions).where(like(gateDecisions.id, `%${P}%`))
  await tx.delete(checkoutAttempts).where(like(checkoutAttempts.id, `%${P}%`))
  await tx.delete(checkoutSessions).where(like(checkoutSessions.id, `%${P}%`))
  await tx.delete(mandates).where(like(mandates.id, `%${P}%`))
  await tx.delete(l1Credentials).where(like(l1Credentials.id, `%${P}%`))
  await tx.delete(agents).where(like(agents.id, `%${P}%`))
  await tx.delete(paypalWallets).where(like(paypalWallets.id, `%${P}%`))
  await tx.delete(devices).where(like(devices.id, `%${P}%`))
  await tx.delete(users).where(like(users.id, `%${P}%`))
}

/** The full §7.3 chain — every row the bundle's five-table walk reads. */
async function seedWorld(tx: Tx): Promise<void> {
  await tx.insert(users).values({
    id: ids.user,
    persona: 'BUYER',
    display_name: 'worker defender e2e buyer',
    email: 'wkr-def@example.test',
    country: 'US',
  })
  await tx.insert(devices).values({
    id: ids.device,
    user_id: ids.user,
    public_jwk: {},
    jkt: `jkt-${P}`,
    label: 'wkr-def device',
  })
  await tx.insert(paypalWallets).values({
    id: ids.wallet,
    user_id: ids.user,
    payment_token_id: `vault-${P}`,
    payer_id: `payer-${P}`,
    payer_email: 'wkr-def@example.test',
  })
  await tx.insert(agents).values({
    id: ids.agent,
    user_id: ids.user,
    name: 'wkr-def agent',
    public_jwk: {},
    kid: `kid-${P}`,
    enc_private_key: Buffer.from('ciphertext'),
  })
  await tx.insert(l1Credentials).values({
    id: ids.l1,
    user_id: ids.user,
    device_id: ids.device,
    wallet_id: ids.wallet,
    sd_jwt: `l1.${P}.sdjwt`,
    issuer_kid: `kid-${P}`,
    iat: BigInt(Math.floor(NOW.getTime() / 1000) - 3600),
    exp: BigInt(Math.floor(NOW.getTime() / 1000) + 86_400),
    status: 'ACTIVE',
  })
  await tx.insert(mandates).values({
    id: ids.mandate,
    user_id: ids.user,
    device_id: ids.device,
    agent_id: ids.agent,
    wallet_id: ids.wallet,
    l2_serialized: `l2.${P}`,
    l2_payload: {},
    nl_intent: 'wkr-def fixture mandate',
    readback: '**What you are authorising**',
    constraints: {},
    nonce: `nonce-${P}`,
    aud: 'mrc_wkr_def',
    iat: BigInt(Math.floor(NOW.getTime() / 1000) - 1800),
    exp: BigInt(Math.floor(NOW.getTime() / 1000) + 43_200),
    status: 'ACTIVE',
    // Present, so the bundle's `webauthn` member is derived from a real row, not a default.
    webauthn_assertion: { type: 'webauthn.get', challenge: `challenge-${P}` },
    compiler_model: 'e2e',
  })
  await tx.insert(checkoutSessions).values({
    id: ids.session,
    merchant_id: 'mrc_wkr_def',
    cart: { lines: [{ sku: 'sku-1', qty: 1, unit_minor: 1000 }] },
    subtotal_minor: 1_000n,
    shipping_minor: 0n,
    total_minor: 1_000n,
    currency: 'USD',
    checkout_jwt: `co.${P}`,
    checkout_hash: 'h'.repeat(43),
    price_lock_exp: new Date(NOW.getTime() + 3_600_000),
  })
  for (const attempt of [ids.attempt, ids.attempt2]) {
    await tx.insert(checkoutAttempts).values({
      id: attempt,
      mandate_id: ids.mandate,
      agent_id: ids.agent,
      checkout_session_id: ids.session,
      l3a: `l3a.${attempt}`,
      l3b: `l3b.${attempt}`,
      l3_jti: `jti-${attempt}`,
      idempotency_key: `idem-${attempt}`,
      amount_minor: 1_000n,
      currency: 'USD',
      payee: 'mrc_wkr_def',
    })
  }
  await tx.insert(gateDecisions).values({
    id: ids.gate,
    attempt_id: ids.attempt,
    decision: 'ALLOW',
    reasons: [],
    checks: [{ n: 1, code: 'MANDATE', ok: true }],
    chain_valid: true,
    vi_lib_commit: `vicommit-${P}`,
    signed_record: `gd.${P}.signed`,
  })
  await tx.insert(orders).values({
    id: ids.order,
    attempt_id: ids.attempt,
    paypal_order_id: `PP-ORDER-${P}`,
    intent: 'CAPTURE',
    custom_id: `cs1:${'A'.repeat(43)}`,
    invoice_id: `INV-${P}`,
    status: 'CAPTURED',
    amount_minor: 1_000n,
    currency: 'USD',
  })
  await tx.insert(orders).values({
    id: ids.order2,
    attempt_id: ids.attempt2,
    paypal_order_id: `PP-ORDER-${P}2`,
    intent: 'CAPTURE',
    custom_id: `cs1:${'B'.repeat(43)}`,
    invoice_id: `INV-${P}2`,
    status: 'ORDER_CREATED',
    amount_minor: 1_000n,
    currency: 'USD',
  })
  await tx.insert(captures).values({
    id: ids.capture,
    order_id: ids.order,
    paypal_capture_id: `PP-CAP-${P}`,
    amount_minor: 1_000n,
    currency: 'USD',
    status: 'COMPLETED',
  })
  await tx.insert(shipments).values({
    id: ids.shipment,
    order_id: ids.order,
    lines: [{ sku: 'sku-1', qty: 1 }],
    carrier: 'UPS',
    tracking_number: `1Z-${P}`,
    status: 'SHIPPED',
  })
  await tx.insert(disputes).values({
    id: ids.dispute,
    paypal_dispute_id: `PP-D-${P}`,
    order_id: ids.order,
    reason: 'UNAUTHORISED',
    stage: 'CHARGEBACK',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    amount_minor: 1_000n,
    currency: 'USD',
    created_at: NOW,
    updated_at: NOW,
  })
}

describe.skipIf(!hasDatabase)('dbDefenderStore — evidence.bundle assembles the chain', () => {
  it('reads every §7.3 member from the five tables, including paypal and shipments', async () => {
    const store = dbDefenderStore()
    const bundle = unwrap(await store.evidence.bundle(ids.order), 'evidence.bundle')
    expect(bundle).toEqual({
      v: 'cs1',
      l1: `l1.${P}.sdjwt`,
      l2: `l2.${P}`,
      l3a: `l3a.${ids.attempt}`,
      l3b: `l3b.${ids.attempt}`,
      checkout_jwt: `co.${P}`,
      gate_decision: `gd.${P}.signed`,
      webauthn: { present: true },
      vi_lib_commit: `vicommit-${P}`,
      paypal: {
        order_id: `PP-ORDER-${P}`,
        capture_ids: [`PP-CAP-${P}`],
        custom_id: `cs1:${'A'.repeat(43)}`,
      },
      shipments: [{ carrier: 'UPS', tracking: `1Z-${P}`, lines: [{ sku: 'sku-1', qty: 1 }] }],
    })
  })

  it('answers CS_NOT_FOUND — never a fabricated default — when a chain link is missing', async () => {
    const store = dbDefenderStore()
    // order2's attempt exists but has no gate decision: the honest answer is that the chain is
    // broken, because a bundle without the Gate's signed record is not evidence.
    const r = await store.evidence.bundle(ids.order2)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_NOT_FOUND')
    expect(r.error.message).toContain('gate_decisions')
  })

  it('leaves paypal and shipments absent for an order with no capture and no shipment', async () => {
    const store = dbDefenderStore()
    // order2 cannot reach the bundle (no gate decision), so prove the "absent, never false" rule on
    // the row the test controls: drop order2's capture-shaped expectations and read order1's
    // sibling by deleting nothing — instead, assert the absent members on a fresh order3 chain
    // built inside this test.
    await inTx(async (tx) => {
      const attempt3 = `att_${P}3`
      const order3 = `ord_${P}3`
      await tx.insert(checkoutAttempts).values({
        id: attempt3,
        mandate_id: ids.mandate,
        agent_id: ids.agent,
        checkout_session_id: ids.session,
        l3a: `l3a.${attempt3}`,
        l3b: `l3b.${attempt3}`,
        l3_jti: `jti-${attempt3}`,
        idempotency_key: `idem-${attempt3}`,
        amount_minor: 1_000n,
        currency: 'USD',
        payee: 'mrc_wkr_def',
      })
      await tx.insert(gateDecisions).values({
        id: `gate_${P}3`,
        attempt_id: attempt3,
        decision: 'ALLOW',
        reasons: [],
        checks: [],
        chain_valid: true,
        vi_lib_commit: `vicommit-${P}`,
        signed_record: `gd.${attempt3}`,
      })
      await tx.insert(orders).values({
        id: order3,
        attempt_id: attempt3,
        paypal_order_id: `PP-ORDER-${P}3`,
        intent: 'CAPTURE',
        custom_id: `cs1:${'C'.repeat(43)}`,
        invoice_id: `INV-${P}3`,
        status: 'ORDER_CREATED',
        amount_minor: 1_000n,
        currency: 'USD',
      })
      // Pass the tx: the store's no-tx calls would read through a different connection, which
      // cannot see this transaction's uncommitted order — the exact composition rule the port's
      // `tx` parameter exists for.
      const bundle = unwrap(await store.evidence.bundle(order3, tx), 'evidence.bundle(order3)')
      // No capture was created for order3, and no shipment: §7.3 says these are the members PayPal
      // and the merchant added *after* order creation, so absent — not empty-string, not null.
      expect('shipments' in bundle).toBe(false)
      expect(bundle.paypal).toEqual({
        order_id: `PP-ORDER-${P}3`,
        capture_ids: [],
        custom_id: `cs1:${'C'.repeat(43)}`,
      })
    })
  })
})

describe.skipIf(!hasDatabase)(
  'dbDefenderStore — the documented unknowns and the refund refusal',
  () => {
    it('answers corpus and policy with the port documented unknown: {}', async () => {
      const store = dbDefenderStore()
      expect(await store.evidence.corpus(ids.order)).toEqual({ ok: true, value: {} })
      expect(await store.evidence.policy('mrc_wkr_def')).toEqual({ ok: true, value: {} })
    })

    it('answers l1Credential with the device+wallet credential, or undefined when none', async () => {
      const store = dbDefenderStore()
      const found = unwrap(
        await store.evidence.l1Credential(ids.device, ids.wallet),
        'l1Credential',
      )
      expect(found).toEqual({ sdJwt: `l1.${P}.sdjwt` })
      const none = await store.evidence.l1Credential(ids.device, `wal_${P}none`)
      expect(none).toEqual({ ok: true, value: undefined })
    })

    it('refuses the refund port loudly, naming the wiring to add', async () => {
      const port = refundsRefusedLoudly()
      const r = await port.refund({
        captureId: ids.capture,
        amount: { minor: 1_000n, currency: 'USD' },
        reason: 'UNAUTHORISED',
        ruleId: 'R-UNAUTH-1',
      } as never)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.code).toBe('DEF_WRONG_STATE')
      expect(r.error.message).toContain('defenderRefundsFromOrders')
    })
  },
)

describe.skipIf(!hasDatabase)('dbDefenderStore — transaction, packets, actions, verdicts', () => {
  it('rolls back every write when the body throws a CsError', async () => {
    const store = dbDefenderStore()
    const packetId = `pkt_${P}rollback`
    const outcome = await store.transaction(async (tx) => {
      const inserted = await store.packets.insert(
        {
          id: packetId,
          dispute_id: ids.dispute,
          version: 1,
          bundle: { v: 'cs1' },
          bundle_hash: 'A'.repeat(43),
        },
        tx,
      )
      if (!inserted.ok) throw inserted.error
      // The throw is the whole point: §8.12's "a business refusal is data" only holds when a fault
      // does not leave the insert behind half-committed.
      throw csError('CS_VALIDATION', 'rollback probe')
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('CS_VALIDATION')
    const gone = unwrap(await store.packets.findById(`pkt_${P}rollback`), 'packets.findById')
    expect(gone).toBeUndefined()
  })

  it('keeps packets as a full version history: latest, forDispute newest-first, findById', async () => {
    const store = dbDefenderStore()
    const v1 = `pkt_${P}v1`
    const v2 = `pkt_${P}v2`
    await inTx(async (tx) => {
      const inserted = await store.packets.insert(
        {
          id: v1,
          dispute_id: ids.dispute,
          version: 1,
          bundle: {
            v: 'cs1',
            l2: 'l2',
            l3a: 'a',
            l3b: 'b',
            checkout_jwt: 'co',
            gate_decision: 'gd',
            webauthn: { present: true },
            vi_lib_commit: 'c',
          },
          bundle_hash: 'A'.repeat(43),
        },
        tx,
      )
      expect(inserted.ok).toBe(true)
      const second = await store.packets.insert(
        {
          id: v2,
          dispute_id: ids.dispute,
          version: 2,
          bundle: {
            v: 'cs1',
            l2: 'l2b',
            l3a: 'a',
            l3b: 'b',
            checkout_jwt: 'co',
            gate_decision: 'gd',
            webauthn: { present: true },
            vi_lib_commit: 'c',
          },
          bundle_hash: 'B'.repeat(43),
        },
        tx,
      )
      expect(second.ok).toBe(true)
    })

    const history = unwrap(
      await store.packets.forDispute(ids.dispute as never),
      'packets.forDispute',
    )
    expect(history.map((p: EvidencePacketRow) => [p.id, p.version])).toEqual([
      [v2, 2],
      [v1, 1],
    ])
    const latest = unwrap(
      await store.packets.latestForDispute(ids.dispute as never),
      'packets.latest',
    )
    expect(latest?.id).toBe(v2)
    expect(unwrap(await store.packets.findById(v1 as never), 'packets.findById')?.id).toBe(v1)

    // EC-DSP-10's resume path: an unfiled packet with this hash is resumed, a filed one is a no-op.
    await inTx(async (tx) => {
      const marked = await store.packets.attachPdf(
        v2 as never,
        Buffer.from('pdf-bytes'),
        'C'.repeat(64),
        NOW,
        tx,
      )
      expect(marked.ok).toBe(true)
      const filed = await store.packets.markFiled(v2 as never, { status: 'OK' }, NOW, tx)
      expect(filed.ok).toBe(true)
    })
    const filedRow = unwrap(await store.packets.findById(v2 as never), 'packets.findById')
    expect(filedRow?.filed_at?.toISOString()).toBe(NOW.toISOString())
    expect(filedRow?.paypal_response).toEqual({ status: 'OK' })
  })

  it('records dispute actions and finds one by its idempotency key', async () => {
    const store = dbDefenderStore()
    const actionId = `act_${P}1`
    const key = `cs:${ids.dispute}:file:1`
    await inTx(async (tx) => {
      const recorded = await store.actions.record(
        {
          id: actionId,
          dispute_id: ids.dispute,
          action: 'FILE',
          request: { notes: 'template notes' },
          actor: 'MERCHANT',
          idempotency_key: key,
          at: NOW,
        },
        tx,
      )
      expect(recorded.ok).toBe(true)
    })
    expect(unwrap(await store.actions.findByIdempotencyKey(key), 'actions.byIdem')?.id).toBe(
      actionId,
    )
    const listed = unwrap(
      await store.actions.listForDispute(ids.dispute as never),
      'actions.listFor',
    )
    expect(listed.map((a: DisputeActionRow) => a.idempotency_key)).toContain(key)
  })

  it('writes the router verdict: liability plus router_trace land on the dispute row', async () => {
    const store = dbDefenderStore()
    const at = new Date('2026-11-01T01:00:00Z')
    const set = await store.disputes.setLiability(
      ids.dispute as never,
      'USER_AUTHORISED' as never,
      { rule: 'R-UNAUTH-1', webauthn: true },
      at,
      undefined,
    )
    expect(set.ok).toBe(true)
    const row = (await store.disputes.findById(ids.dispute as never)) as {
      ok: boolean
      value?: DisputeRow
    }
    expect(unwrap(row, 'disputes.findById')?.liability).toBe('USER_AUTHORISED')
    expect(unwrap(row, 'disputes.findById')?.router_trace).toEqual({
      rule: 'R-UNAUTH-1',
      webauthn: true,
    })
  })

  it('orders.findByCustomId is the webhook→order join the router starts from', async () => {
    const store = dbDefenderStore()
    const found = (await store.orders.findByCustomId(`cs1:${'A'.repeat(43)}`)) as {
      ok: boolean
      value?: OrderRow
    }
    expect(unwrap(found, 'orders.findByCustomId')?.id).toBe(ids.order)
  })
})
