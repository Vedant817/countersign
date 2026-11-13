/**
 * `users` repository — spec §7.2.
 *
 * Small by design: one row per person, created by the persona picker (S-01) or by onboarding. The
 * only interesting behaviour is `findByPersona`, which the demo's persona switcher and the seed's
 * idempotency check both rely on.
 */
import { eq, type SQL } from 'drizzle-orm'

import type { CsError, Result, UserId } from '@countersign/core'

import { db, type Exec } from '../client'
import { users, type NewUser, type UserRow } from '../schema'
import { err, repo } from './index'

/** Insert a user. `id` is supplied by the caller so the seed is reproducible. */
export function createUser(input: NewUser, exec?: Exec): Promise<Result<UserRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(users).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no users row')
      return row as UserRow
    },
    { table: 'users', id: input.id },
  )
}

export function findUserById(id: UserId, exec?: Exec): Promise<Result<UserRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(users).where(eq(users.id, id)).limit(1)
      return rows[0] as UserRow
    },
    { table: 'users', id },
  )
}

/** The account with this email, or `undefined` — "no such account" is an answer, not a fault. */
export async function findUserByEmail(
  email: string,
  exec?: Exec,
): Promise<Result<UserRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(users).where(eq(users.email, email)).limit(1)
      return rows[0] as UserRow | undefined
    },
    { table: 'users' },
  )
}

/**
 * Set (or clear, with `null`) a password hash.
 *
 * Written as a repository rather than a raw `db().update(users)` in the seed or a script because the
 * audit rule for this project is that the package's tables are written through the package (AGENTS.md
 * rule 9's neighbour): a caller that bypasses it cannot be reviewed in one place.
 */
export function setPasswordHash(
  id: UserId,
  passwordHash: string | null,
  exec?: Exec,
): Promise<Result<UserRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(users)
        .set({ password_hash: passwordHash, updated_at: new Date() })
        .where(eq(users.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No users row for ${id}`)
      return row as UserRow
    },
    { table: 'users', id },
  )
}

/** `undefined` rather than an error: "no such user" is an expected answer, not a failure. */
export async function findUserByPersona(
  persona: string,
  exec?: Exec,
): Promise<Result<UserRow | undefined, CsError>> {
  const found = await repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(users)
        .where(eq(users.persona, persona))
        .limit(1)
      return rows[0] as UserRow | undefined
    },
    { table: 'users', persona },
  )
  return found
}

/** Records the DPDP/GDPR notice acknowledgement (S-02 checkbox, §12.13). */
export function acknowledgeNotice(
  id: UserId,
  at: Date,
  exec?: Exec,
): Promise<Result<UserRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(users)
        .set({ dpdp_notice_ack_at: at, updated_at: at })
        .where(eq(users.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No users row for ${id}`)
      return row as UserRow
    },
    { table: 'users', id },
  )
}

/** Any predicate, so callers (WP-17 settings, WP-19 privacy) are not forced to add a repo method. */
export function findUsersWhere(
  where: SQL | undefined,
  exec?: Exec,
): Promise<Result<UserRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(users).where(where)
      return rows as UserRow[]
    },
    { table: 'users' },
  )
}

/** Guard used by the seed: refuse to create two people with the same email. */
export async function assertEmailFree(email: string, exec?: Exec): Promise<Result<true, CsError>> {
  const existing = await repo(
    async () => {
      const rows = await (exec ?? db())
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      return rows.length
    },
    { table: 'users' },
  )
  if (!existing.ok) return existing
  if (existing.value > 0) {
    return err({
      code: 'CS_CONFLICT',
      message: `A user with email ${email} already exists`,
      userMessage: 'That account already exists.',
      retryable: false,
      details: { table: 'users', email },
    })
  }
  return { ok: true, value: true }
}
