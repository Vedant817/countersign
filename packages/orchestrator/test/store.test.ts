/**
 * `orchestratorStoreFromRepos` — spec **§8.10**, **§7.2**; the `gate_decisions` writer the package README
 * names as its reason for existing.
 *
 * ## What these tests are really about
 *
 * `decide` writes the row that every downstream step depends on. `createOrderFromDecision` re-reads it by
 * id and refuses with `CS_NOT_FOUND` when it is absent, and `decisionForAttempt` is the idempotency read
 * that stops a duplicate submission reaching the Gate a second time. So a silently wrong `decide` does not
 * crash — it produces an `ALLOW` that can never become an order, or a chain-invalid decision recorded as
 * chain-valid, which is the kind of thing a dispute packet would later quote.
 *
 * Three claims are pinned here, and each one is a place the obvious implementation is wrong:
 *
 * 1. **`chain_valid` is read from the record, not derived.** The test harness's own double hardcodes
 *    `true`, which is correct there and would be a fabrication here. The strongest available check is that
 *    the decoder agrees with the *real* producer, so a real decision record from a real `evaluate` is run
 *    through it rather than a hand-built payload alone.
 * 2. **An unreadable record refuses.** Neither `true` nor `false` is a safe default: one asserts a
 *    verification that did not happen, the other reports a good chain as broken. Both would be values
 *    nothing signed.
 * 3. **The signature is not re-verified here, and that is deliberate.** {@link chainValidFromRecord} says
 *    so in its own documentation; a test pins the contract rather than leaving it to be "tidied up" later
 *    by someone who reads it as an oversight.
 *
 * The members that need a live database are deliberately **not** exercised here. `decide`'s transaction
 * behaviour — abort-on-error, and writing nothing when the attempt row is missing — is a property of
 * Postgres, and asserting it against a double would be the soft claim the package README warns about twice.
 * That belongs in a DB-backed test, not here.
 */
import { describe, expect, it } from 'vitest'

import { chainValidFromRecord, orchestratorStoreFromRepos } from '../src/store'
import { createOrderFromIntent } from '../src/purchase'
import { gateInput, harness } from './harness'

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * A compact JWS with a real base64url payload.
 *
 * The signature segment is a fixed non-empty string: {@link chainValidFromRecord} does not verify it, and
 * {@link does not verify the signature} asserts that on purpose.
 */
function jws(payload: unknown, signature = 'c2lnbmF0dXJl'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'gate-test' })).toString(
    'base64url',
  )
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.${signature}`
}

/** The decoded value, or a readable throw. */
function chainValid(record: string): boolean {
  const result = chainValidFromRecord(record)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Assert the record is refused rather than believed. */
function expectRefusal(record: string): void {
  const result = chainValidFromRecord(record)
  if (result.ok) throw new Error(`expected a refusal, got chain_valid=${String(result.value)}`)
  expect(result.error.code).toBe('CS_INTERNAL')
}

/* ------------------------------------------------------------------------------------------ */

describe('chainValidFromRecord', () => {
  it('reads chain_valid out of the signed payload', () => {
    expect(chainValid(jws({ chain_valid: true, gdc: 'gd_1' }))).toBe(true)
    expect(chainValid(jws({ chain_valid: false, gdc: 'gd_1' }))).toBe(false)
  })

  it('does not verify the signature, and says so', () => {
    // The value is read from the payload the Gate minted in this same process; verification belongs to
    // `verifyDecisionRecord` at read time. A tampered signature must therefore still decode — if a future
    // change makes this fail, the documentation and this test are both wrong together, which is the point.
    expect(chainValid(jws({ chain_valid: true }, 'bm90LWEtc2lnbmF0dXJl'))).toBe(true)
  })

  it('refuses a record that is not a compact JWS', () => {
    expectRefusal('')
    expectRefusal('not-a-jws')
    expectRefusal('only.two')
    expectRefusal('a.b.c.d')
  })

  it('refuses a payload that is not JSON, rather than defaulting', () => {
    const notJson = `${Buffer.from('{"alg":"EdDSA"}').toString('base64url')}.${Buffer.from('not json').toString('base64url')}.sig`
    expectRefusal(notJson)
  })

  it('refuses a payload that is not a JSON object', () => {
    expectRefusal(jws('a string'))
    expectRefusal(jws(null))
    expectRefusal(jws(42))
  })

  it('refuses a payload with no chain_valid', () => {
    // The signed payload's nine fields always include it, so its absence means this is not a §8.10
    // decision record — the case where defaulting to `true` would be most dangerous.
    expectRefusal(jws({ gdc: 'gd_1', att: 'att_1', iat: 1 }))
    expectRefusal(jws({}))
  })

  it('refuses a chain_valid that is not a boolean, and does not coerce it', () => {
    // `"true"` and `1` are the shapes a careless read would accept as a valid chain.
    expectRefusal(jws({ chain_valid: 'true' }))
    expectRefusal(jws({ chain_valid: 1 }))
    expectRefusal(jws({ chain_valid: null }))
  })
})

describe('chainValidFromRecord against a real decision record', () => {
  it('agrees with the record a real evaluate produced', async () => {
    // The harness runs the real `evaluate` and the real signing key, so this is a producer/consumer
    // agreement test rather than a round-trip through a fixture: if §8.10's payload ever stops carrying
    // `chain_valid` under that name, this is the test that fails, not a dispute packet.
    const h = await harness()
    const result = await createOrderFromIntent(
      {
        userId: 'usr_00000000000000000000000001' as `usr_${string}`,
        gate: gateInput(),
        merchants: { mrc_northwind: 'Northwind Outfitters' },
      },
      h.deps,
    )
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    const signedRecord = result.value.decision?.signedRecord
    if (signedRecord === undefined) throw new Error('expected a recorded decision')

    expect(signedRecord.split('.')).toHaveLength(3)
    expect(chainValid(signedRecord)).toBe(true)
  })
})

describe('orchestratorStoreFromRepos', () => {
  it('satisfies every member of the port', () => {
    // A structural check only. What each member does against a real database is not asserted here, and
    // claiming otherwise would be the same soft claim `probe.ts` refuses to make about a configured key.
    const store = orchestratorStoreFromRepos()
    expect(typeof store.decide).toBe('function')
    expect(typeof store.decisionForAttempt).toBe('function')
    expect(typeof store.staleAttempts).toBe('function')
    expect(typeof store.budgetEntries).toBe('function')
    expect(typeof store.setAttemptState).toBe('function')
  })
})
