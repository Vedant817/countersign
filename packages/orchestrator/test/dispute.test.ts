/**
 * `ingestAndDefend` — spec **§10.2** rows 13–16, **§8.12**, **§8.15**, **§3.3**, §12.11.
 *
 * ## What this file proves, and what it does not
 *
 * **It proves the orchestrator's half**: that the dispute is re-fetched rather than read from a payload,
 * that the fetch happens *first*, that ingest precedes filing, that a fetch or ingest failure stops the run
 * before anything is filed, and that a **refusal is `ok`** so the S-17 timeline keeps it.
 *
 * **It does not re-test the Defender.** `ingestDisputeToDefender` and `fileDispute` have their own suites
 * (`packages/defender/test/ingest.test.ts`, `filer.test.ts`, plus a 40-case router eval), and the in-memory
 * world that drives them — `createInMemoryDefenderWorld` — **is not re-exported from
 * `@countersign/defender`'s index**. This package therefore cannot construct a `DefenderStore` without
 * restating twenty members of somebody else's port, and restating a port that already exists is the second
 * data-access layer AGENTS.md rule 8 exists to prevent. Recorded as a contract issue in the README; the fix
 * is one export line in WP-15e's package.
 *
 * So the two Defender calls here are **recording doubles** — honest about being that. Each is typed from the
 * real function's own signature (`Parameters<typeof fileDispute>` and friends, recovered in `types.ts`), so
 * if the Defender's contract changes this file fails to compile rather than quietly asserting the old one.
 */
import { describe, expect, it } from 'vitest'

import { csError, ok, type CsError, type Result } from '@countersign/core'
import type { Dispute } from '@countersign/paypal'

import { ingestAndDefend, type IngestAndDefendDeps } from '../src/dispute'
import type { DefenderSeam, FileDeps, FileOutcome } from '../src/types'
import { harness, type Harness } from './harness'

/* ------------------------------------------------------------------------------------------ */
/* Fixtures                                                                                       */
/* ------------------------------------------------------------------------------------------ */

const DISPUTE_ID = 'PP-D-2781AB12CD34'
const OUR_DISPUTE_ID = 'dsp_00000000000000000000000001'

/** A documented PayPal dispute body. `dispute_id` is the only thing the orchestrator keys on. */
function paypalDispute(overrides: Record<string, unknown> = {}): Dispute {
  return {
    dispute_id: DISPUTE_ID,
    dispute_life_cycle_stage: 'CHARGEBACK',
    status: 'REQUIRED_ACTION',
    reason: 'UNAUTHORISED',
    disputed_transactions: [
      {
        buyer_transaction_id: '4TX12345CD0234056',
        amount: { currency_code: 'USD', value: '30.00' },
      },
    ],
    seller_response_due_date: '2026-10-12T00:00:00Z',
    buyer_response_due_date: '2026-10-19T00:00:00Z',
    update_time: '2026-10-05T00:00:00Z',
    ...overrides,
  } as unknown as Dispute
}

/** A `FileOutcome` skeleton, typed from the real `fileDispute`'s success branch. */
function fileOutcome(overrides: Record<string, unknown> = {}): FileOutcome {
  return {
    disputeId: OUR_DISPUTE_ID,
    paypalDisputeId: DISPUTE_ID,
    decision: { posture: 'CONTEST', liability: 'MERCHANT_FAULT' },
    disposition: 'FILE',
    filed: true,
    alreadyFiled: false,
    awaitingApproval: false,
    awaitingHuman: false,
    paypalCalls: ['provideEvidence'],
    warnings: [],
    ...overrides,
  } as unknown as FileOutcome
}

interface Recorder {
  /** Every step, in the order it ran. The whole point of this file. */
  readonly order: string[]
  /** What `ingest` received — asserted to be the **fetched** body, never a payload. */
  readonly ingested: Dispute[]
  readonly filed: Array<{ disputeId: string; options: unknown }>
  readonly paypal: { getDispute: IngestAndDefendDeps['paypal']['getDispute'] }
  readonly seam: DefenderSeam & { deps: FileDeps }
  /** Full deps, ready to hand to `ingestAndDefend`. */
  deps(base: Harness['deps']): IngestAndDefendDeps
}

interface RecorderOptions {
  /** Make the fetch fail. */
  readonly fetchFails?: CsError
  /** Make the ingest fail. */
  readonly ingestFails?: CsError
  readonly fileOutcome?: () => FileOutcome
}

async function recorder(options: RecorderOptions = {}): Promise<Recorder> {
  const order: string[] = []
  const ingested: Dispute[] = []
  const filed: Array<{ disputeId: string; options: unknown }> = []

  const paypal: Recorder['paypal'] = {
    getDispute: async (_id: string) => {
      order.push('getDispute')
      if (options.fetchFails !== undefined) return { ok: false, error: options.fetchFails }
      return ok(paypalDispute())
    },
  }

  const seam: Recorder['seam'] = {
    deps: {} as FileDeps,
    ingest: (async (raw: unknown) => {
      order.push('ingest')
      ingested.push(raw as Dispute)
      if (options.ingestFails !== undefined) return { ok: false, error: options.ingestFails }
      return {
        ok: true,
        value: {
          dispute: { id: OUR_DISPUTE_ID },
          join: { kind: 'LINKED', orderId: 'ord_00000000000000000000000001', captureId: 'cap_x' },
          linked: true,
          created: true,
          context: {},
          withdrawal: { withdrew: false, reason: '' },
          warnings: [],
          disputeId: OUR_DISPUTE_ID,
        },
      }
    }) as unknown as DefenderSeam['ingest'],
    file: (async (disputeId: string, _deps: unknown, fileOptions: unknown) => {
      order.push('file')
      filed.push({ disputeId, options: fileOptions })
      return ok((options.fileOutcome ?? fileOutcome)())
    }) as unknown as DefenderSeam['file'],
  }

  return {
    order,
    ingested,
    filed,
    paypal,
    seam,
    deps: (base) => ({ ...base, paypal, defender: seam }),
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The order                                                                                      */
/* ------------------------------------------------------------------------------------------ */

describe('§10.2 the dispute path: fetch → ingest → file', () => {
  it('§3.3 the dispute is re-fetched, never read from a payload, and the fetch comes first', async () => {
    const h = await harness()
    const rec = await recorder()
    const result = await ingestAndDefend({ paypalDisputeId: DISPUTE_ID }, rec.deps(h.deps))
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)

    // The order is the claim. §3.3: "we never trust payload state" — so `getDispute` is step one and
    // `ingest` receives **its** body, not whatever a webhook happened to send.
    expect(rec.order).toEqual(['getDispute', 'ingest', 'file'])
    expect(rec.ingested).toHaveLength(1)
    expect(rec.ingested[0]?.dispute_id).toBe(DISPUTE_ID)
  })

  it('§0 rule 6 the file step receives our `dsp_…` id, never PayPal’s', async () => {
    const h = await harness()
    const rec = await recorder()
    const result = await ingestAndDefend({ paypalDisputeId: DISPUTE_ID }, rec.deps(h.deps))
    if (!result.ok) throw new Error(result.error.message)

    // Request ids are derived from our own ids. A `dispute_actions.idempotency_key` built from PayPal's id
    // would collide with any other system keying on the same string.
    expect(rec.filed[0]?.disputeId).toBe(OUR_DISPUTE_ID)
    expect(rec.filed[0]?.disputeId).not.toBe(DISPUTE_ID)
    expect(result.value.disputeId).toBe(OUR_DISPUTE_ID)
    expect(result.value.paypalDisputeId).toBe(DISPUTE_ID)
  })

  it('§8.15 the options bag is forwarded, so an approval is what turns a filing into a PayPal call', async () => {
    const h = await harness()
    const rec = await recorder()
    const approval = { by: 'usr_merchant', note: 'signed mandate attached' }
    await ingestAndDefend({ paypalDisputeId: DISPUTE_ID }, rec.deps(h.deps), { approval })

    expect(rec.filed[0]?.options).toEqual({ approval })
  })

  it('§8.15 the posture is named at the top level, so a caller need not reach into the outcome', async () => {
    const h = await harness()
    const rec = await recorder({
      fileOutcome: () => fileOutcome({ disposition: 'REFUND', filed: false }),
    })
    const result = await ingestAndDefend({ paypalDisputeId: DISPUTE_ID }, rec.deps(h.deps))
    if (!result.ok) throw new Error(result.error.message)

    expect(result.value.posture).toBe('CONTEST')
    expect(result.value.file.disposition).toBe('REFUND')
    expect(result.value.linked).toBe(true)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Failures                                                                                       */
/* ------------------------------------------------------------------------------------------ */

describe('a failure at any step stops the run', () => {
  it('a failed fetch never reaches ingest or file, and stays retryable', async () => {
    // EC-PP-1: PayPal being unreachable must be retried, not treated as "there is no dispute".
    const h = await harness()
    const rec = await recorder({ fetchFails: csError('PP_UNAVAILABLE', 'PayPal did not answer') })
    const result = await ingestAndDefend({ paypalDisputeId: DISPUTE_ID }, rec.deps(h.deps))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_UNAVAILABLE')
    expect(result.error.retryable).toBe(true)
    // Nothing was stored and nothing was filed: a dispute row written from an unreachable PayPal is a row
    // built on nothing.
    expect(rec.order).toEqual(['getDispute'])
  })

  it('an ingest failure never reaches the filer', async () => {
    const h = await harness()
    const rec = await recorder({
      ingestFails: csError('CS_VALIDATION', 'no dispute_id on the body'),
    })
    const result = await ingestAndDefend({ paypalDisputeId: DISPUTE_ID }, rec.deps(h.deps))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('no dispute_id')
    expect(rec.order).toEqual(['getDispute', 'ingest'])
  })

  it('an empty dispute id is refused before any socket is opened', async () => {
    const h = await harness()
    const rec = await recorder()
    const result = await ingestAndDefend({ paypalDisputeId: '   ' }, rec.deps(h.deps))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(rec.order).toEqual([])
  })
})

/* ------------------------------------------------------------------------------------------ */
/* A refusal is an answer                                                                         */
/* ------------------------------------------------------------------------------------------ */

describe('a refused filing is a recorded outcome, not a fault', () => {
  it('§8.15 a refusal comes back as ok, with the router’s verdict attached', async () => {
    // §18 question 24: the S-17 timeline is built out of `dispute_actions` rows, including the ones that
    // record a refusal. Collapsing a refusal into an error would delete every refusal from the merchant's
    // dispute history — the artefact the whole product exists to produce.
    const h = await harness()
    const rec = await recorder({
      fileOutcome: () =>
        fileOutcome({
          disposition: 'NONE',
          filed: false,
          awaitingHuman: true,
          refusal: {
            code: 'DEF_DEADLINE_PASSED',
            reason: 'PayPal’s response deadline has passed.',
          },
        }),
    })
    const result = await ingestAndDefend({ paypalDisputeId: DISPUTE_ID }, rec.deps(h.deps))
    if (!result.ok) throw new Error(result.error.message)

    expect(result.value.file.refusal?.code).toBe('DEF_DEADLINE_PASSED')
    expect(result.value.file.awaitingHuman).toBe(true)
    expect(result.value.file.disposition).toBe('NONE')
    expect(rec.order).toEqual(['getDispute', 'ingest', 'file'])
  })

  it('EC-DSP-10 an already-filed packet is reported, not re-sent', async () => {
    const h = await harness()
    const rec = await recorder({
      fileOutcome: () => fileOutcome({ alreadyFiled: true, filed: false, disposition: 'NONE' }),
    })
    const result = await ingestAndDefend({ paypalDisputeId: DISPUTE_ID }, rec.deps(h.deps))
    if (!result.ok) throw new Error(result.error.message)

    expect(result.value.file.alreadyFiled).toBe(true)
    expect(result.value.file.filed).toBe(false)
  })

  it('a PayPal-side failure during filing is reported as err, because we do not know the outcome', async () => {
    // The mirror of the refusal case, and the distinction matters: a refusal is *our* decision, known and
    // recorded; a `PP_UNAVAILABLE` during `provide-evidence` is an unknown, and the queue must retry it.
    const h = await harness()
    const order: string[] = []
    const seam: DefenderSeam & { deps: FileDeps } = {
      deps: {} as FileDeps,
      ingest: (async () => {
        order.push('ingest')
        return { ok: true, value: { dispute: { id: OUR_DISPUTE_ID } } }
      }) as unknown as DefenderSeam['ingest'],
      file: (async () => {
        order.push('file')
        return { ok: false, error: csError('PP_UNAVAILABLE', 'PayPal did not answer') }
      }) as unknown as DefenderSeam['file'],
    }
    const result: Result<unknown, CsError> = await ingestAndDefend(
      { paypalDisputeId: DISPUTE_ID },
      {
        ...h.deps,
        paypal: { getDispute: async () => ok(paypalDispute()) },
        defender: seam,
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_UNAVAILABLE')
    expect(result.error.retryable).toBe(true)
    expect(order).toEqual(['ingest', 'file'])
  })
})
