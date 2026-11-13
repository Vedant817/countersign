/**
 * The two readers the worker's `wh.disputes` defend step queues on:
 * `findDisputesNeedingAssessment` and `listEvidencePacketsForDispute`.
 *
 * ## Why these run against a real Postgres and are skipped without one
 *
 * Both are *ordering* and *filtering* contracts, and those live in SQL:
 *
 * - the candidate query's "nulls last" clause is easy to get silently wrong (Postgres's ASC default
 *   is NULLS FIRST, so a deadline-less row would jump the queue for the wrong reason), and a
 *   structural "the function is exported" test cannot see it;
 * - the packet lister must return **every** version newest first (EC-DSP-10 reads the whole history,
 *   not the head), which is a different answer from the `LIMIT 1` sibling beside it.
 *
 * The cases insert their own world rather than reading the seed, because the property under test is
 * the *relative* order of rows the seed does not control. Everything is swept at the end so the
 * database the other suites see is unchanged.
 */
import { like } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import type { CsError, DisputeId, Result } from '@countersign/core'

import { closeDb, withTx, type Tx } from '../src/client'
import { findDisputesNeedingAssessment, listEvidencePacketsForDispute } from '../src/repos'
import { disputes, evidencePackets, type DisputeRow, type EvidencePacketRow } from '../src/schema'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

/** Prefixes that make every row this file writes deletable by one `like` predicate. */
const DSP_PREFIX = 'dsp_dqa_'
const PKT_PREFIX = 'pkt_dqa_'
const PP_PREFIX = 'PP-D-DQA-'

afterAll(async () => {
  if (!hasDatabase) return
  await withTx(async (tx) => {
    await tx.delete(evidencePackets).where(like(evidencePackets.id, `${PKT_PREFIX}%`))
    await tx.delete(disputes).where(like(disputes.id, `${DSP_PREFIX}%`))
  })
  await closeDb()
})

/** Flatten `withTx`'s outer `Result` with the inner one, the same helper `repos.live.test.ts` keeps. */
async function inTx<T>(fn: (tx: Tx) => Promise<Result<T, CsError>>): Promise<Result<T, CsError>> {
  const outer = await withTx(fn)
  return outer.ok ? outer.value : outer
}

/** A minute-shaped deadline, or null for "PayPal sent no date". */
function due(offsetMinutes: number | null): Date | null {
  return offsetMinutes === null ? null : new Date(Date.UTC(2026, 10, 1, 9, offsetMinutes))
}

interface SeedDispute {
  readonly n: number
  readonly state: 'NEW' | 'ANALYSED' | 'FILED'
  readonly liability: null | 'USER_AUTHORISED'
  readonly dueAt: Date | null
  readonly createdOffsetMinutes: number
}

async function seedDispute(tx: Tx, s: SeedDispute): Promise<DisputeRow> {
  const rows = await tx
    .insert(disputes)
    .values({
      id: `${DSP_PREFIX}${s.n}`,
      paypal_dispute_id: `${PP_PREFIX}${s.n}`,
      reason: 'UNAUTHORISED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount_minor: 1_000n,
      currency: 'USD',
      defense_state: s.state,
      ...(s.liability === null ? {} : { liability: s.liability }),
      seller_response_due_date: s.dueAt,
      created_at: new Date(Date.UTC(2026, 10, 1, 8, s.createdOffsetMinutes)),
      updated_at: new Date(Date.UTC(2026, 10, 1, 8, s.createdOffsetMinutes)),
    })
    .returning()
  return rows[0] as DisputeRow
}

function seedPacket(tx: Tx, id: string, disputeId: DisputeId, version: number): Promise<unknown> {
  return tx.insert(evidencePackets).values({
    id,
    dispute_id: disputeId,
    version,
    bundle: {
      v: 'cs1',
      l2: 'l2',
      l3a: 'l3a',
      l3b: 'l3b',
      checkout_jwt: 'co',
      gate_decision: 'gd',
      webauthn: { present: false },
      vi_lib_commit: 'c',
    },
    bundle_hash: 'A'.repeat(43),
  })
}

const CANDIDATES: readonly SeedDispute[] = [
  // Two rows the queue must return, ordered by deadline: 3 is earlier than 1.
  { n: 1, state: 'NEW', liability: null, dueAt: due(60), createdOffsetMinutes: 5 },
  { n: 3, state: 'ANALYSED', liability: null, dueAt: due(30), createdOffsetMinutes: 1 },
  // A row with no deadline: returned, but after every dated row (NULLS LAST).
  { n: 4, state: 'NEW', liability: null, dueAt: null, createdOffsetMinutes: 9 },
  // Two rows the queue must NOT return: already assessed, and already past the verdict.
  { n: 2, state: 'NEW', liability: 'USER_AUTHORISED', dueAt: due(10), createdOffsetMinutes: 2 },
  { n: 5, state: 'FILED', liability: null, dueAt: due(20), createdOffsetMinutes: 3 },
]

describe.skipIf(!hasDatabase)('findDisputesNeedingAssessment (live database)', () => {
  it('returns exactly the unassessed rows, most urgent first, deadline-less last', async () => {
    const found = await inTx(async (tx) => {
      for (const s of CANDIDATES) await seedDispute(tx, s)
      return findDisputesNeedingAssessment(10, tx)
    })
    expect(found.ok, found.ok ? '' : `query failed: ${found.error.message}`).toBe(true)
    if (!found.ok) return
    // 3 (due 09:30), then 1 (due 10:00), then 4 (no deadline) — and never 2 or 5.
    expect(found.value.map((r) => r.id)).toEqual([
      `${DSP_PREFIX}3`,
      `${DSP_PREFIX}1`,
      `${DSP_PREFIX}4`,
    ])
  })

  it('honours the limit as a page bound, still in urgency order', async () => {
    const found = await findDisputesNeedingAssessment(2)
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value.map((r) => r.id)).toEqual([`${DSP_PREFIX}3`, `${DSP_PREFIX}1`])
  })

  it('stops queueing a row once a verdict exists for it', async () => {
    // The lifecycle the worker relies on: after the router speaks (`setLiability`), the row leaves
    // the queue. Re-marking ours assessed is exactly that write, not a test-only trick.
    const swept = await withTx(async (tx) => {
      await tx
        .update(disputes)
        .set({ liability: 'USER_AUTHORISED', updated_at: new Date() })
        .where(like(disputes.id, `${DSP_PREFIX}%`))
      return 'swept'
    })
    expect(swept.ok).toBe(true)
    const found = await findDisputesNeedingAssessment(100)
    expect(found.ok).toBe(true)
    if (!found.ok) return
    // Other suites may have their own unassessed rows; assert only on this file's prefix.
    expect(found.value.filter((r) => r.id.startsWith(DSP_PREFIX))).toEqual([])
  })
})

describe.skipIf(!hasDatabase)('listEvidencePacketsForDispute (live database)', () => {
  it('returns every version, newest first, and only this dispute’s', async () => {
    const dspA = `${DSP_PREFIX}10` as DisputeId
    const dspB = `${DSP_PREFIX}11` as DisputeId
    const found = await inTx(async (tx) => {
      await seedDispute(tx, {
        n: 10,
        state: 'NEW',
        liability: null,
        dueAt: due(90),
        createdOffsetMinutes: 1,
      })
      await seedDispute(tx, {
        n: 11,
        state: 'NEW',
        liability: null,
        dueAt: due(90),
        createdOffsetMinutes: 2,
      })
      await seedPacket(tx, `${PKT_PREFIX}1`, dspA, 1)
      await seedPacket(tx, `${PKT_PREFIX}2`, dspA, 2)
      await seedPacket(tx, `${PKT_PREFIX}3`, dspB, 1)
      return listEvidencePacketsForDispute(dspA, tx)
    })
    expect(found.ok, found.ok ? '' : `query failed: ${found.error.message}`).toBe(true)
    if (!found.ok) return
    const rows: readonly EvidencePacketRow[] = found.value
    expect(rows.map((p) => [p.id, p.version])).toEqual([
      [`${PKT_PREFIX}2`, 2],
      [`${PKT_PREFIX}1`, 1],
    ])
  })

  it('answers an empty list, not undefined, for a dispute with no packets', async () => {
    const none = await listEvidencePacketsForDispute(`${DSP_PREFIX}404` as DisputeId)
    expect(none.ok).toBe(true)
    if (!none.ok) return
    expect(none.value).toEqual([])
  })
})
