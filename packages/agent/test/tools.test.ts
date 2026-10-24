/**
 * The tool layer — spec §8.13's two local tools, §8.9's wire encoding, and the three ways a merchant
 * answer could be misread into permission.
 *
 * The tests here are about **parsing**, because parsing is where this package's authority lives: the
 * agent's story is "every authority is a tool result", and that is only true if a malformed or hostile
 * tool result cannot be read as an `ALLOWED`, a price of `0`, or a mandate that is not the bound one.
 */
import { describe, expect, it } from 'vitest'
import type { MandateId } from '@countersign/core'

import {
  AGENT_TOOL_NAMES,
  MERCHANT_TOOL_NAMES,
  createAgentOps,
  decodeToolResult,
  mandateToOutput,
  parseMinor,
  toGateOutcome,
} from '../src/tools'
import { fakeDeps, fakeMandate, REQUEST } from './support/harness'

describe('the tool surface', () => {
  it('declares the five merchant tools §8.9 names and the two local ones §8.13 names', () => {
    expect([...MERCHANT_TOOL_NAMES]).toEqual([
      'search_products',
      'get_product',
      'create_checkout',
      'submit_checkout',
      'get_order_status',
    ])
    expect([...AGENT_TOOL_NAMES]).toContain('read_my_mandate')
    expect([...AGENT_TOOL_NAMES]).toContain('sign_l3')
    // Seven, not more: a tool the agent has is authority the agent can be talked into using.
    expect(AGENT_TOOL_NAMES).toHaveLength(7)
  })
})

describe('decodeToolResult', () => {
  it('reads the JSON payload out of a text content part', () => {
    const decoded = decodeToolResult({ content: [{ type: 'text', text: '{"items":[]}' }] })
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.value).toEqual({ items: [] })
  })

  it('fails rather than defaulting when there is no text part', () => {
    expect(decodeToolResult({ content: [] }).ok).toBe(false)
    expect(decodeToolResult({}).ok).toBe(false)
  })

  it('fails on invalid JSON instead of returning an empty object', () => {
    expect(decodeToolResult({ content: [{ type: 'text', text: 'not json' }] }).ok).toBe(false)
  })

  it('turns the merchant error envelope into a CsError with a registered code', () => {
    const decoded = decodeToolResult({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: { code: 'GATE_REVOKED', message: 'revoked', userMessage: 'gone' },
          }),
        },
      ],
    })
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) {
      expect(decoded.error.code).toBe('GATE_REVOKED')
      expect(decoded.error.userMessage).toBe('gone')
    }
  })

  it('refuses an unregistered error code rather than passing it through to a buyer', () => {
    const decoded = decodeToolResult({
      isError: true,
      content: [
        { type: 'text', text: JSON.stringify({ error: { code: 'NOT_A_CODE', message: 'x' } }) },
      ],
    })
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error.code).toBe('CS_INTERNAL')
  })
})

describe('parseMinor', () => {
  it('accepts canonical decimal strings and safe integers', () => {
    expect(parseMinor('4500')).toBe(4500n)
    expect(parseMinor(4500)).toBe(4500n)
  })

  it('refuses anything that is not a whole number of minor units', () => {
    // Money is never a float (AGENTS.md rule 9). Each of these would be a real defect if accepted.
    for (const bad of ['45.00', '', '1e3', '-1', ' 45 ', null, undefined, {}, 45.5, Number.NaN]) {
      expect(parseMinor(bad)).toBeUndefined()
    }
  })

  it('accepts zero, because a free item is a real cart', () => {
    expect(parseMinor('0')).toBe(0n)
  })
})

describe('toGateOutcome', () => {
  it('reads an ALLOWED decision', () => {
    const outcome = toGateOutcome({
      status: 'ALLOWED',
      decision_id: 'gdc_1',
      reasons: [],
      checks: [{ code: 'CHAIN_VERIFY', passed: true }],
      order_id: 'ord_1',
      amount_minor: '4500',
      currency: 'USD',
      payee: 'MERCHANT_NORTHWIND',
    })
    expect('status' in outcome && outcome.status).toBe('ALLOWED')
    if ('status' in outcome) {
      expect(outcome.orderId).toBe('ord_1')
      expect(outcome.amountMinor).toBe('4500')
    }
  })

  it('reads a BLOCKED decision with its reasons', () => {
    const outcome = toGateOutcome({
      status: 'BLOCKED',
      decision_id: 'gdc_2',
      reasons: [
        { code: 'GATE_BUDGET_EXCEEDED', message: 'over', userMessage: 'Your limit is $50.00.' },
      ],
      checks: [{ code: 'BUDGET', passed: false, detail: 'reserved 4500 + 4500 > 5000' }],
      order_id: null,
    })
    expect('status' in outcome && outcome.status).toBe('BLOCKED')
    if ('status' in outcome) {
      expect(outcome.reasons[0]?.userMessage).toBe('Your limit is $50.00.')
      expect(outcome.checks[0]?.passed).toBe(false)
    }
  })

  it('refuses an answer with no readable status — the one thing that must never read as permission', () => {
    for (const value of [{}, { status: 'MAYBE' }, null]) {
      const result = toGateOutcome(value)
      expect('code' in result).toBe(true)
      if ('code' in result) expect(result.code).toBe('CS_INTERNAL')
    }
  })
})

describe('the bound mandate', () => {
  it('refuses a submission against a mandate the session is not bound to', async () => {
    const { deps } = fakeDeps({})
    const ops = createAgentOps({ mandate: fakeMandate(), deps })
    const result = await ops.submitCheckout({
      checkoutId: 'chk_0000000000000000000000000A',
      mandateId: 'mdt_someone_else' as MandateId,
      l3a: 'x',
      l3b: 'y',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CS_FORBIDDEN')
  })

  it('exposes the read-back and both caps, and nothing that could widen them', () => {
    const output = mandateToOutput(fakeMandate())
    expect(output.readback).toContain('$50.00')
    expect(output.max_amount_minor).toBe('5000')
    expect(output.budget_minor).toBe('5000')
    // A `null` cap is `null`, never `0` and never a default: "no cap" and "a cap of zero" are different.
    expect(mandateToOutput(fakeMandate({ maxAmountMinor: null })).max_amount_minor).toBeNull()
  })

  it('has no writer anywhere in the port', () => {
    const { deps } = fakeDeps({})
    // The assertion is structural: `MandatePort` has one method, and this is it.
    expect(Object.keys(deps.mandate)).toEqual(['load'])
  })
})

describe('the ops against a merchant that maps prose', () => {
  it('fences listing text and flags the seeded payload', async () => {
    const { deps } = fakeDeps({})
    const ops = createAgentOps({ mandate: fakeMandate(), deps })
    const detail = await ops.getProduct({ sku: 'NW-011' })
    expect(detail.ok).toBe(true)
    if (detail.ok) {
      expect(detail.value.suspected_injection.length).toBeGreaterThan(0)
      const listing = detail.value.product?.['listing_html'] as
        | { untrusted_text: string }
        | undefined
      expect(listing?.untrusted_text).toContain('<<<UNTRUSTED_MERCHANT_DATA>>>')
    }
  })

  it('resolves the buyer words to the catalog', async () => {
    const { deps } = fakeDeps({})
    const ops = createAgentOps({ mandate: fakeMandate(), deps })
    const found = await ops.searchProducts({ query: REQUEST.message })
    expect(found.ok).toBe(true)
    if (found.ok) expect(found.value.items.length).toBeGreaterThan(0)
  })
})
