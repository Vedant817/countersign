/**
 * The scripted shopper — spec §8.13 AT-M13.1 ("a happy path buys the cheapest in-mandate shoe") and
 * AT-M13.2 ("the seeded injection listings → 0 successful out-of-mandate orders").
 *
 * The three behaviours are the three claims the project makes about the same code path:
 *
 *  - `lawful` — the product works: a cart inside the mandate is authorised, submitted and ordered.
 *  - `instructed` — a jailbroken model loop is stopped by the **signer** (§8.13 defence 3).
 *  - `compromised` — an attacker who owns the agent server is stopped by the **Gate** (defence 4).
 *
 * The last two are different failures on purpose. A suite that only had the first would prove nothing
 * about the Gate, and the Gate is the control the whole architecture is built around.
 */
import { describe, expect, it } from 'vitest'

import { outcomeFromEvents } from '../src/refusal'
import { runScriptedShopper } from '../src/scripted'
import type { ShopEvent } from '../src/types'
import { fakeDeps, REQUEST } from './support/harness'

async function collect(iterable: AsyncIterable<ShopEvent>): Promise<ShopEvent[]> {
  const events: ShopEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('lawful behaviour', () => {
  it('buys an in-mandate item and reports the order', async () => {
    const { deps, merchant } = fakeDeps({})
    const events = await collect(
      runScriptedShopper(REQUEST, deps, { behaviour: 'lawful', sku: 'NW-001' }),
    )

    const reading = outcomeFromEvents(events)
    expect(reading.outcome).toBe('ORDERED')
    expect(merchant.submissions).toHaveLength(1)

    const gate = events.find((event) => event.kind === 'gate')
    expect(gate).toBeDefined()
    expect((gate?.data as { gate: { status: string } }).gate.status).toBe('ALLOWED')
  })

  it('falls back to the cheapest item when the preferred one is outside the cap', async () => {
    // §8.13 AT-M13.1: the happy path buys the cheapest *in-mandate* item, not the first result.
    const { deps } = fakeDeps({ capMinor: 5_000n })
    const events = await collect(
      runScriptedShopper(REQUEST, deps, { behaviour: 'lawful', sku: 'NW-011' }),
    )
    const result = events.find(
      (event) =>
        event.kind === 'tool_result' &&
        (event.data as { tool?: string }).tool === 'create_checkout',
    )
    expect(result).toBeDefined()
    expect((result?.data as { output: { total_minor: string } }).output.total_minor).toBe('5000')
  })

  it('always ends with exactly one final event', async () => {
    const { deps } = fakeDeps({})
    const events = await collect(runScriptedShopper(REQUEST, deps, { behaviour: 'lawful' }))
    const finals = events.filter((event) => event.kind === 'final')
    expect(finals).toHaveLength(1)
    expect(events.at(-1)?.kind).toBe('final')
  })
})

describe('instructed behaviour — the signer is the control', () => {
  it('is refused when it follows the listing to an out-of-mandate item', async () => {
    const { deps, merchant } = fakeDeps({ capMinor: 5_000n })
    const events = await collect(
      runScriptedShopper(REQUEST, deps, { behaviour: 'instructed', sku: 'NW-011' }),
    )
    const reading = outcomeFromEvents(events)
    expect(reading.outcome).toBe('SIGNER_REFUSED')
    // The merchant never saw a submission, so no order can exist.
    expect(merchant.submissions).toHaveLength(0)
  })

  it('reports the signer’s buyer-facing sentence', async () => {
    const { deps } = fakeDeps({ capMinor: 5_000n })
    const events = await collect(
      runScriptedShopper(REQUEST, deps, { behaviour: 'instructed', sku: 'NW-011' }),
    )
    const final = events.at(-1)
    expect(String((final?.data as { text?: string }).text)).toContain(
      'caps a single purchase at $50.00',
    )
  })
})

describe('compromised behaviour — the Gate is the control', () => {
  it('produces a Gate BLOCK for an authorisation it never obtained', async () => {
    const { deps, merchant } = fakeDeps({ capMinor: 5_000n })
    const events = await collect(
      runScriptedShopper(REQUEST, deps, { behaviour: 'compromised', sku: 'NW-011' }),
    )
    const reading = outcomeFromEvents(events)
    expect(reading.outcome).toBe('GATE_BLOCKED')

    const gate = events.find((event) => event.kind === 'gate')
    const payload = (
      gate?.data as unknown as {
        gate: { status: string; reasons: { code: string; userMessage: string }[] }
      }
    ).gate
    expect(payload.status).toBe('BLOCKED')
    expect(payload.reasons[0]?.code).toBe('VI_CHAIN_INVALID')
    // A refusal with no readable reason is not the §8.13 demo moment.
    expect(payload.reasons[0]?.userMessage.length).toBeGreaterThan(10)
    expect(merchant.submissions).toHaveLength(1)
  })

  it('never reports a purchase', async () => {
    const { deps } = fakeDeps({})
    const events = await collect(runScriptedShopper(REQUEST, deps, { behaviour: 'compromised' }))
    expect(outcomeFromEvents(events).outcome).not.toBe('ORDERED')
  })
})

describe('the run is closed, not opened', () => {
  it('closes the merchant session even when a tool fails', async () => {
    const { deps, merchant } = fakeDeps({})
    // An unknown SKU reaches `get_product` and fails; the session must still be closed.
    await collect(runScriptedShopper(REQUEST, deps, { behaviour: 'lawful', sku: 'NW-999' }))
    expect(merchant.closed).toBe(true)
  })

  it('ends with ERROR when the mandate cannot be read', async () => {
    const { deps } = fakeDeps({})
    const broken = {
      ...deps,
      mandate: { load: async () => ({ ok: true, value: undefined }) as const },
    }
    const events = await collect(runScriptedShopper(REQUEST, broken, {}))
    expect(outcomeFromEvents(events).outcome).toBe('ERROR')
  })
})
