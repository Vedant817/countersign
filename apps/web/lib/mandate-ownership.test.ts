/**
 * The mandate-ownership rule for an agent run (D-060).
 *
 * These are the two functions that stand between "a buyer names a mandate id" and "a budget is spent", so
 * the tests are about the three answers and not about SQL:
 *
 *  1. **A mandate the buyer owns is theirs.**
 *  2. **Another buyer's mandate is `CS_NOT_FOUND`, not `CS_FORBIDDEN`.** A `403` would confirm the id is
 *     real, which is exactly the fact a caller who does not own it must not learn.
 *  3. **An agent key the buyer has no mandate under is refused before a bearer is minted** — the run route
 *     mints a token for `agent_id` first, so a bearer for someone else's key is the leak this closes.
 *
 * `findMandatesByUser` is the only repository call here and it is a double: what this file is about is the
 * rule, and the query itself is `packages/db/test/repos.live.test.ts`'s subject.
 */
import { describe, expect, it, vi } from 'vitest'

import { ok, type UserId } from '@countersign/core'
import type * as DbModule from '@countersign/db'

const db = vi.hoisted(() => ({ findMandatesByUser: vi.fn() }))
vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...db,
}))

import { requireOwnedAgent, requireOwnedMandate } from './session'

const BUYER = 'usr_01HZX0000000000000000BUYERA' as UserId
const OTHER = 'usr_01HZX0000000000000000BUYERB' as UserId
const OWNED_MANDATE = 'mdt_01HZX0000000000000000OWNED'
const OWNED_AGENT = 'agt_01HZX0000000000000000OWNED'

function mandateRow(overrides: Partial<{ id: string; agent_id: string }> = {}) {
  return {
    id: overrides.id ?? OWNED_MANDATE,
    agent_id: overrides.agent_id ?? OWNED_AGENT,
    user_id: BUYER,
  }
}

describe('requireOwnedMandate', () => {
  it('accepts a mandate the buyer owns', async () => {
    db.findMandatesByUser.mockResolvedValue(ok([mandateRow()]))
    const result = await requireOwnedMandate(BUYER, OWNED_MANDATE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.id).toBe(OWNED_MANDATE)
  })

  it("refuses another buyer's mandate as CS_NOT_FOUND, so the id's existence is not confirmed", async () => {
    // The buyer has mandates, but not this one: the same fact as an id that never existed.
    db.findMandatesByUser.mockResolvedValue(
      ok([mandateRow({ id: 'mdt_01HZX0000000000000000SOMEONE' })]),
    )
    const result = await requireOwnedMandate(BUYER, OWNED_MANDATE)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')
    expect(result.error.userMessage).toBe('That mandate does not belong to this account.')
  })

  it('refuses an id that never existed with the same answer', async () => {
    db.findMandatesByUser.mockResolvedValue(ok([]))
    const result = await requireOwnedMandate(BUYER, 'mdt_does_not_exist')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')
  })

  it('does not swallow a repository failure', async () => {
    db.findMandatesByUser.mockResolvedValue({
      ok: false,
      error: { code: 'CS_INTERNAL', message: 'the database is down' },
    })
    const result = await requireOwnedMandate(BUYER, OWNED_MANDATE)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_INTERNAL')
  })
})

describe('requireOwnedAgent', () => {
  it('accepts an agent the buyer has a mandate under', async () => {
    db.findMandatesByUser.mockResolvedValue(ok([mandateRow()]))
    const result = await requireOwnedAgent(BUYER, OWNED_AGENT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.id).toBe(OWNED_AGENT)
  })

  it("refuses another buyer's agent key as CS_NOT_FOUND", async () => {
    db.findMandatesByUser.mockResolvedValue(ok([mandateRow({ agent_id: 'agt_other' })]))
    const result = await requireOwnedAgent(OTHER, OWNED_AGENT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')
  })
})
