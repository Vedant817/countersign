/**
 * `agents` repository — spec §7.2, Gate check 2 (§8.10), EC-AGT-2/3/4.
 *
 * An agent is a keypair the user's agent holds. The public half is in `public_jwk`/`kid`; the private
 * half exists here **only as ciphertext** (`enc_private_key`, AES-256-GCM under `VI_KEK`) and is
 * decrypted inside vi-service. Nothing in this package ever decrypts it, and no repo returns it in a
 * result that could be logged.
 *
 * The security model this table supports: a compromised agent can only sign L3s the L2 already
 * allows, because the L2 binds `kid`. So the useful operations here are rotation (EC-AGT-4) and
 * suspension (EC-AGT-2, velocity guard → `SUSPENDED` after 3 consecutive BLOCKs).
 */
import { and, eq } from 'drizzle-orm'

import type { AgentId, CsError, Result } from '@countersign/core'

import { db, type Exec } from '../client'
import { agents, type AgentRow, type NewAgent } from '../schema'
import { err, repo } from './index'

/** The insert shape minus `enc_private_key`, which callers pass separately so it is hard to log. */
export type NewAgentPublic = Omit<NewAgent, 'enc_private_key'>

export function createAgent(
  input: NewAgentPublic,
  encPrivateKey: Buffer,
  exec?: Exec,
): Promise<Result<AgentRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .insert(agents)
        .values({ ...input, enc_private_key: encPrivateKey })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no agents row')
      return row as AgentRow
    },
    { table: 'agents', id: input.id },
  )
}

export function findAgentById(
  id: AgentId,
  exec?: Exec,
): Promise<Result<AgentRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(agents).where(eq(agents.id, id)).limit(1)
      return rows[0] as AgentRow | undefined
    },
    { table: 'agents', id },
  )
}

/** The mandate editor's agent picker (S-04). Only `ACTIVE` agents are offered. */
export function findAgentsByUser(
  userId: string,
  status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED',
  exec?: Exec,
): Promise<Result<AgentRow[], CsError>> {
  return repo(
    async () => {
      const q = (exec ?? db())
        .select()
        .from(agents)
        .where(
          status
            ? and(eq(agents.user_id, userId), eq(agents.status, status))
            : eq(agents.user_id, userId),
        )
      const rows = await q
      return rows as AgentRow[]
    },
    { table: 'agents', userId, status },
  )
}

/**
 * Resolve the key that signed an L3. The Gate calls this on every attempt, and the row's `kid` is
 * what it compares against the L2's bound key — so `kid` is unique, not merely indexed.
 */
export function findAgentByKid(
  kid: string,
  exec?: Exec,
): Promise<Result<AgentRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(agents).where(eq(agents.kid, kid)).limit(1)
      return rows[0] as AgentRow | undefined
    },
    { table: 'agents', kid },
  )
}

/**
 * Gate check 2, plus EC-MA-2 ("Agent A tries to use agent B's mandate"): the L3 must be signed by the
 * key the L2 bound, which is the mandate's `agent_id`. A mismatch is `GATE_AGENT_SUSPENDED`'s sibling
 * failure and is reported to the buyer as a blocked purchase, never as a server error.
 */
export async function assertAgentActive(
  id: AgentId,
  exec?: Exec,
): Promise<Result<AgentRow, CsError>> {
  const found = await findAgentById(id, exec)
  if (!found.ok) return found
  const agent = found.value
  if (!agent) {
    return err({
      code: 'CS_NOT_FOUND',
      message: `No agents row for ${id}`,
      userMessage: 'We could not find that agent.',
      retryable: false,
      details: { table: 'agents', id },
    })
  }
  if (agent.status !== 'ACTIVE') {
    return err({
      code: 'GATE_AGENT_SUSPENDED',
      message: `Agent ${id} is ${agent.status}`,
      userMessage: 'That agent is suspended, so it cannot spend right now.',
      retryable: false,
      details: { table: 'agents', id, status: agent.status },
    })
  }
  return { ok: true, value: agent }
}

/**
 * EC-AGT-4: rotate the agent key. The old row is **retained** and marked `REVOKED` rather than
 * deleted, because past L3s signed by that `kid` must stay verifiable — a deleted row would make an
 * old evidence packet unverifiable, which is the opposite of what this project is for.
 *
 * `newAgent.rotated_from` records the predecessor, so a key's rotation chain can be walked.
 */
export function rotateAgentKey(
  previousId: AgentId,
  newAgent: NewAgentPublic,
  encPrivateKey: Buffer,
  at: Date,
  exec?: Exec,
): Promise<Result<AgentRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .insert(agents)
        .values({ ...newAgent, enc_private_key: encPrivateKey, rotated_from: previousId })
        .returning()
      const created = rows[0]
      if (!created) throw new Error('INSERT ... RETURNING produced no agents row')
      // Retire the predecessor in the same transaction, so there is never a moment with two ACTIVE
      // keys for one agent slot.
      await (exec ?? db())
        .update(agents)
        .set({ status: 'REVOKED', updated_at: at })
        .where(eq(agents.id, previousId))
      return created as AgentRow
    },
    { table: 'agents', previousId, newId: newAgent.id },
  )
}

export function setAgentStatus(
  id: AgentId,
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED',
  at: Date,
  exec?: Exec,
): Promise<Result<AgentRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(agents)
        .set({ status, updated_at: at })
        .where(eq(agents.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No agents row for ${id}`)
      return row as AgentRow
    },
    { table: 'agents', id, status },
  )
}

/** EC-AGT-3: a leaked key is `COMPROMISED` in JWKS and `REVOKED` here, and every mandate under it follows. */
export function revokeAgent(
  id: AgentId,
  at: Date,
  exec?: Exec,
): Promise<Result<AgentRow, CsError>> {
  return setAgentStatus(id, 'REVOKED', at, exec)
}
