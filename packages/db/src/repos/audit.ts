/**
 * `audit_log` repository — spec §7.2, §8.19 (observability and audit, WP-19), §12.13 (EC-PRIV-2/3).
 *
 * The log is **append-only and hash-chained**:
 *
 * ```
 * this_hash = sha256( canonicalJson({ chain_id, actor, action, subject, at, ip_hash, details, prev_hash }) )
 * ```
 *
 * The point is not tamper-evidence against a DBA — it is against *ourselves*. A bug that quietly
 * rewrites a dispute timeline is exactly the kind of thing that destroys a case, and a chain turns that
 * from undetectable into "the chain breaks at row N and someone has to explain it". Rows are keyed by
 * `chain_id` so one broken chain does not make every other log unverifiable.
 *
 * **Canonical JSON.** The hash is over a canonical encoding: keys sorted lexicographically, no
 * whitespace, and `undefined` omitted. Without that, two runs over the same logical entry would produce
 * different digests (property order is not stable across object construction) and the chain would break
 * on every write. `null` is *kept*, because `ip_hash: null` and an absent `ip_hash` are different
 * facts.
 *
 * **`ip_hash`, never the address.** §12.13 wants hashes, not PII. The caller hashes; this repo only
 * stores what it is given, and refuses nothing so that a missing hash stays visible as a gap.
 */
import { createHash } from 'node:crypto'

import { asc, eq, sql } from 'drizzle-orm'

import type { AuditLogId, CsError, Result } from '@countersign/core'

import { db, type Exec } from '../client'
import { auditLog, type AuditLogRow, type NewAuditEntry } from '../schema'
import { err, now, repo } from './index'

/** Who did it. `actor` is a string so a user id, an agent id and a job name can all appear. */
export type AuditActor = string

/** What the entry says happened. Free-form on purpose — an audit log that needs a migration per new
 *  event type stops being written. */
export type AuditAction = string

/**
 * The exact fields that participate in the hash.
 *
 * `created_at`/`updated_at` are excluded on purpose: they are `now()` defaults that differ from the
 * value the caller supplied for `at`, so including them would make the digest depend on write timing
 * rather than on the entry. `id` is excluded for the same reason it is a mint, not a fact.
 */
export interface AuditChainInput {
  readonly chainId: string
  readonly actor: AuditActor
  readonly action: AuditAction
  readonly subject: string
  /** ISO-8601 UTC instant. Stored as `timestamptz`, hashed as its ISO string. */
  readonly at: string
  readonly ipHash: string | null
  readonly details: unknown
  readonly prevHash: string | null
}

/**
 * Canonical JSON: keys sorted at every level, `undefined` dropped, no insignificant whitespace.
 *
 * A hand-rolled serializer rather than `JSON.stringify(obj, sortedReplacer)` because the replacer form
 * sees keys before it can sort them, so it cannot guarantee sorted output for nested objects.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value as number)) throw new TypeError('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (t === 'bigint') return `"${(value as bigint).toString()}"`
  if (t === 'boolean' || t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (t === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  // `undefined` and functions cannot appear in a stored entry; refusing is louder than dropping them.
  throw new TypeError(`canonicalJson: unsupported value of type ${t}`)
}

/**
 * `sha256(canonicalJson(input))`, hex, lowercase.
 *
 * Exported so a verifier can recompute a digest from an exported row without a database (EC-PRIV-2's
 * subject-access export has to be checkable offline).
 */
export function computeAuditHash(input: AuditChainInput): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex')
}

/** `prev_hash` is null only for the first row of a chain; chains are per `chain_id`. */
export const GENESIS_HASH = null

/**
 * Build the entry and its hash together, so the two can never disagree.
 *
 * @param prevHash the previous row's `this_hash` in the same chain, or `null` for the first entry.
 */
export function buildAuditEntry(
  input: {
    chainId: string
    actor: AuditActor
    action: AuditAction
    subject: string
    at: Date
    ipHash?: string | null
    details?: unknown
    id: AuditLogId
  },
  prevHash: string | null,
): NewAuditEntry {
  const chainInput: AuditChainInput = {
    chainId: input.chainId,
    actor: input.actor,
    action: input.action,
    subject: input.subject,
    at: input.at.toISOString(),
    ipHash: input.ipHash ?? null,
    details: input.details ?? null,
    prevHash,
  }
  return {
    id: input.id,
    chain_id: input.chainId,
    actor: input.actor,
    action: input.action,
    subject: input.subject,
    at: input.at,
    ip_hash: chainInput.ipHash,
    details: (chainInput.details ?? null) as NewAuditEntry['details'],
    prev_hash: prevHash,
    this_hash: computeAuditHash(chainInput),
    created_at: input.at,
    updated_at: input.at,
  }
}

/**
 * Append one entry, reading the chain head and writing the new head in **one statement**.
 *
 * `SELECT … FOR UPDATE` on the chain head is what keeps concurrent appenders from both reading the
 * same `prev_hash` and forking the chain — the same reason every budget mutation locks its row
 * (D19). Without it, two simultaneous audit writes would produce two rows claiming the same parent,
 * and neither branch could be verified as the linear history.
 */
export function appendAudit(
  input: {
    id: AuditLogId
    chainId: string
    actor: AuditActor
    action: AuditAction
    subject: string
    ipHash?: string | null
    details?: unknown
    at?: Date
  },
  exec?: Exec,
): Promise<Result<AuditLogRow, CsError>> {
  return repo(
    async () => {
      const e = exec ?? db()
      const at = input.at ?? now()
      const head = await e
        .select({ thisHash: auditLog.this_hash })
        .from(auditLog)
        .where(eq(auditLog.chain_id, input.chainId))
        .orderBy(auditLog.at)
        .for('update')
      const rows = await e
        .insert(auditLog)
        .values(buildAuditEntry({ ...input, at }, head[0]?.thisHash ?? GENESIS_HASH))
        .returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no audit_log row')
      return row as AuditLogRow
    },
    { table: 'audit_log', chainId: input.chainId, action: input.action },
  )
}

export function findAuditById(
  id: AuditLogId,
  exec?: Exec,
): Promise<Result<AuditLogRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(auditLog).where(eq(auditLog.id, id)).limit(1)
      return rows[0] as AuditLogRow | undefined
    },
    { table: 'audit_log', id },
  )
}

/** One chain, oldest first. This is what the verifier walks. */
export function listChain(chainId: string, exec?: Exec): Promise<Result<AuditLogRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(auditLog)
        .where(eq(auditLog.chain_id, chainId))
        .orderBy(asc(auditLog.at), asc(auditLog.id))
      return rows as AuditLogRow[]
    },
    { table: 'audit_log', chainId },
  )
}

/** EC-PRIV-2 subject access, and the dispute timeline's "what happened to this order". */
export function listBySubject(
  subject: string,
  exec?: Exec,
): Promise<Result<AuditLogRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(auditLog)
        .where(eq(auditLog.subject, subject))
        .orderBy(asc(auditLog.at))
      return rows as AuditLogRow[]
    },
    { table: 'audit_log', subject },
  )
}

export function listRecent(limit: number, exec?: Exec): Promise<Result<AuditLogRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(auditLog)
        .orderBy(sql`${auditLog.at} desc`)
        .limit(limit)
      return rows as AuditLogRow[]
    },
    { table: 'audit_log', limit },
  )
}

/**
 * Walk a chain and report where (if anywhere) it stops verifying.
 *
 * @returns the index of the first row whose digest or `prev_hash` does not match. `ok: true` and
 * `brokenAt: -1` means the chain is intact. This is the check that makes the chain worth maintaining:
 * a chain nobody ever verifies is decoration.
 */
export function verifyChain(
  chainId: string,
  exec?: Exec,
): Promise<Result<{ ok: boolean; brokenAt: number; length: number }, CsError>> {
  return repo(
    async () => {
      const chain = await listChain(chainId, exec)
      if (!chain.ok) return chain
      let prev: string | null = GENESIS_HASH
      for (let i = 0; i < chain.value.length; i++) {
        const row = chain.value[i]!
        const expected = computeAuditHash({
          chainId: row.chain_id,
          actor: row.actor,
          action: row.action,
          subject: row.subject,
          at: row.at.toISOString(),
          ipHash: row.ip_hash,
          details: row.details,
          prevHash: prev,
        })
        if (row.prev_hash !== prev || expected !== row.this_hash) {
          return { ok: true, value: { ok: false, brokenAt: i, length: chain.value.length } }
        }
        prev = row.this_hash
      }
      return { ok: true, value: { ok: true, brokenAt: -1, length: chain.value.length } }
    },
    { table: 'audit_log', chainId, op: 'verify_chain' },
  )
}

/**
 * The chain head's digest, for a caller that wants to append without holding a transaction.
 *
 * Note this reads *without* `FOR UPDATE`, so it is only safe for display and for computing a value to
 * compare afterwards. Appending goes through {@link appendAudit}.
 */
export function chainHeadHash(
  chainId: string,
  exec?: Exec,
): Promise<Result<string | null, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select({ thisHash: auditLog.this_hash })
        .from(auditLog)
        .where(eq(auditLog.chain_id, chainId))
        .orderBy(auditLog.at)
        .limit(1)
      const row = rows[0]
      return row ? row.thisHash : GENESIS_HASH
    },
    { table: 'audit_log', chainId, op: 'chain_head' },
  )
}

export { err }
