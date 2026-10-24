/**
 * `mandates` repository — spec §7.2, §3.3 (mandate state machine), Gate checks 1 and 3 (§8.10).
 *
 * This repo owns two invariants that cannot live in the schema:
 *
 *  1. **`mandate.exp <= L1.exp`** (spec §7.2). A CHECK constraint may only see its own row, and the
 *     credential expiry lives in `l1_credentials`. {@link assertMandateWithinL1} therefore runs
 *     inside the same transaction as the insert, so a mandate can never outlive the credential that
 *     authorised it. `mandate.exp > mandate.iat` *is* a CHECK, because both values are on one row.
 *  2. **Terminal states are never left** (§3.3). `EXHAUSTED`, `EXPIRED` and `REVOKED` are terminal,
 *     so {@link setMandateStatus} refuses to move out of one. That is the rule that makes EC-MDT-4
 *     ("the purchase stands, it was authorised before the revoke") true by construction: the
 *     orchestrator compares capture time to `revoked_at`, and a mandate that could be un-revoked
 *     could not be compared.
 */
import { and, eq, lt, notInArray } from 'drizzle-orm'

import { systemClock } from '@countersign/core'
import type { Clock, CsError, MandateId, Result } from '@countersign/core'

import { db, type Exec } from '../client'
import { mandates, type L1Row, type MandateRow, type NewMandate } from '../schema'
import { assertL1Usable, findL1ForDeviceWallet } from './devices'
import { err, repo } from './index'

export type MandateStatus =
  | 'DRAFT'
  | 'PENDING_SIGNATURE'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'EXHAUSTED'
  | 'EXPIRED'
  | 'REVOKED'

/** Spec §3.3: terminal states are never left. */
export const TERMINAL_MANDATE_STATES: readonly MandateStatus[] = ['EXHAUSTED', 'EXPIRED', 'REVOKED']

export function isTerminalMandateState(status: MandateStatus): boolean {
  return TERMINAL_MANDATE_STATES.includes(status)
}

export function createMandate(
  input: NewMandate,
  exec?: Exec,
): Promise<Result<MandateRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(mandates).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no mandates row')
      return row as MandateRow
    },
    { table: 'mandates', id: input.id },
  )
}

export function findMandateById(
  id: MandateId,
  exec?: Exec,
): Promise<Result<MandateRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(mandates).where(eq(mandates.id, id)).limit(1)
      return rows[0] as MandateRow | undefined
    },
    { table: 'mandates', id },
  )
}

/** Gate check 1's single read. Status and expiry are evaluated by the Gate, not guessed here. */
export async function requireMandate(
  id: MandateId,
  exec?: Exec,
): Promise<Result<MandateRow, CsError>> {
  const found = await findMandateById(id, exec)
  if (!found.ok) return found
  const mandate = found.value
  if (!mandate) {
    return err({
      code: 'CS_NOT_FOUND',
      message: `No mandates row for ${id}`,
      userMessage: 'We could not find that mandate.',
      retryable: false,
      details: { table: 'mandates', id },
    })
  }
  return { ok: true, value: mandate }
}

/**
 * `SELECT … FROM mandates WHERE id = $1 FOR UPDATE` — Gate check 8's locking read.
 *
 * ## Why this is a separate function and not an option on `requireMandate`
 *
 * A locking read and a plain read are different statements, and the difference is invisible at the
 * call site: `requireMandate` inside a transaction looks identical while taking no lock, so a
 * read-modify-write against a mandate would race two agents on one wallet (EC-MA-1) and pass a cap
 * only one of them can spend. Naming the lock in the function name is what makes the mistake a
 * compile error rather than a load-dependent one.
 *
 * ## Why it takes an `Exec` and not an optional one
 *
 * `FOR UPDATE` outside a transaction locks for exactly one statement, which is the same as not
 * locking. Requiring the handle means the caller has already opened the transaction the Gate runs
 * checks 8 and 9 in — `gateDepsFromRepos` passes it through `handles.withTx`, so the lock and the
 * budget reservation commit or roll back together (AT-M10.4). `docs/contract-issues.md` gap #3
 * recorded this as missing; it is the last handle the Gate needed.
 *
 * @returns `undefined` for an unknown id. The Gate decides what a missing mandate means; this
 * function does not invent a `CS_NOT_FOUND`, because inside a transaction that has already read the
 * row the distinction between "gone" and "never existed" belongs to the caller.
 */
export function lockMandateForUpdate(
  id: MandateId,
  exec: Exec,
): Promise<Result<MandateRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await exec
        .select()
        .from(mandates)
        .where(eq(mandates.id, id))
        .limit(1)
        .for('update')
      return rows[0] as MandateRow | undefined
    },
    { table: 'mandates', id, op: 'lock_mandate_for_update' },
  )
}

export function findMandatesByUser(
  userId: string,
  exec?: Exec,
): Promise<Result<MandateRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(mandates).where(eq(mandates.user_id, userId))
      return rows as MandateRow[]
    },
    { table: 'mandates', userId },
  )
}

/** S-03: "every mandate under this wallet", which is also Gate check 9's grouping. */
export function findMandatesByWallet(
  walletId: string,
  status?: MandateStatus,
  exec?: Exec,
): Promise<Result<MandateRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(mandates)
        .where(
          status
            ? and(eq(mandates.wallet_id, walletId), eq(mandates.status, status))
            : eq(mandates.wallet_id, walletId),
        )
      return rows as MandateRow[]
    },
    { table: 'mandates', walletId, status },
  )
}

export function findMandatesByAgent(
  agentId: string,
  status?: MandateStatus,
  exec?: Exec,
): Promise<Result<MandateRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(mandates)
        .where(
          status
            ? and(eq(mandates.agent_id, agentId), eq(mandates.status, status))
            : eq(mandates.agent_id, agentId),
        )
      return rows as MandateRow[]
    },
    { table: 'mandates', agentId, status },
  )
}

/**
 * Cross-table invariant: the mandate must not outlive the credential it descends from (§7.2).
 *
 * @param mandate the L2 claims whose `exp`/`iat`/device/wallet are being checked.
 * @param l1 the credential loaded for the same (device, wallet) pair.
 * @returns `err(VI_EXPIRED)` when `mandate.exp > l1.exp`.
 */
export function assertMandateWithinL1(
  mandate: { exp: bigint; iat: bigint },
  l1: L1Row,
): Result<true, CsError> {
  if (mandate.exp > l1.exp) {
    return err({
      code: 'VI_EXPIRED',
      message: `Mandate exp ${mandate.exp} exceeds L1 ${l1.id} exp ${l1.exp} (spec §7.2)`,
      userMessage: 'That mandate would outlive your credential. Ask for a shorter one.',
      retryable: false,
      details: {
        table: 'mandates',
        mandateExp: mandate.exp.toString(),
        l1Id: l1.id,
        l1Exp: l1.exp.toString(),
      },
    })
  }
  if (mandate.iat < l1.iat) {
    return err({
      code: 'VI_NOT_YET_VALID',
      message: `Mandate iat ${mandate.iat} precedes L1 ${l1.id} iat ${l1.iat}`,
      userMessage: 'That mandate predates your credential. Create it again.',
      retryable: false,
      details: {
        table: 'mandates',
        mandateIat: mandate.iat.toString(),
        l1Id: l1.id,
        l1Iat: l1.iat.toString(),
      },
    })
  }
  return { ok: true, value: true }
}

/**
 * Create a mandate **and** prove it fits inside its L1, atomically.
 *
 * This is the only sanctioned way to write a mandate row. Splitting it would leave a window in which
 * a mandate outlives the credential that authorised it, which is precisely the gap EC-KEY-1 exploits
 * when a device is re-enrolled.
 */
export async function createMandateWithinL1(
  input: NewMandate,
  exec: Exec,
  clock?: Clock,
): Promise<Result<MandateRow, CsError>> {
  const l1 = await findL1ForDeviceWallet(input.device_id, input.wallet_id, exec)
  if (!l1.ok) return l1
  const credential = l1.value
  if (!credential) {
    return err({
      code: 'VI_CHAIN_INVALID',
      message: `No l1_credentials row for device ${input.device_id} × wallet ${input.wallet_id}`,
      userMessage: 'We could not find your credential. Reconnect PayPal and try again.',
      retryable: false,
      details: { table: 'l1_credentials', deviceId: input.device_id, walletId: input.wallet_id },
    })
  }
  const usable = assertL1Usable(credential, (clock ?? systemClock).nowSec())
  if (!usable.ok) return usable
  const within = assertMandateWithinL1({ exp: input.exp, iat: input.iat }, credential)
  if (!within.ok) return within
  return createMandate(input, exec)
}

/**
 * Move a mandate along the §3.3 machine. Refuses to leave a terminal state.
 *
 * `SUSPENDED → ACTIVE | REVOKED` is allowed (a security hold is temporary), and `ACTIVE → SUSPENDED`
 * is what the Gate's velocity guard does after three consecutive BLOCKs (check 12, EC-AGT-2).
 */
export function setMandateStatus(
  id: MandateId,
  status: MandateStatus,
  at: Date,
  exec?: Exec,
): Promise<Result<MandateRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(mandates)
        .set({
          status,
          updated_at: at,
          ...(status === 'REVOKED' ? { revoked_at: at } : {}),
        })
        .where(and(eq(mandates.id, id), notInArray(mandates.status, [...TERMINAL_MANDATE_STATES])))
        .returning()
      const row = rows[0]
      if (!row) {
        // Either the mandate does not exist, or it is already terminal. Distinguish so the caller
        // can tell "unknown mandate" from "tried to un-expire something".
        const existing = await (exec ?? db())
          .select({ status: mandates.status })
          .from(mandates)
          .where(eq(mandates.id, id))
          .limit(1)
        const current = existing[0]?.status
        if (current && isTerminalMandateState(current)) {
          return err({
            code: 'GATE_REVOKED',
            message: `Mandate ${id} is ${current}, a terminal state; refusing to move it to ${status} (spec §3.3)`,
            userMessage:
              'That mandate has already ended, so nothing further can be charged under it.',
            retryable: false,
            details: { table: 'mandates', id, from: current, to: status },
          })
        }
        throw new Error(`No mandates row for ${id}`)
      }
      return row as MandateRow
    },
    { table: 'mandates', id, status },
  )
}

/** Revocation with a reason (S-04 revoke button). `revoked_reason` is what the buyer sees back. */
export function revokeMandate(
  id: MandateId,
  reason: string,
  at: Date,
  exec?: Exec,
): Promise<Result<MandateRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(mandates)
        .set({ status: 'REVOKED', revoked_at: at, revoked_reason: reason, updated_at: at })
        .where(eq(mandates.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No mandates row for ${id}`)
      return row as MandateRow
    },
    { table: 'mandates', id },
  )
}

/**
 * The expiry sweep, run by the worker. `exp` is epoch seconds (spec §8.1), so it is compared against
 * `clock.nowSec()` rather than a `timestamptz` — no timezone can shift an expiring mandate.
 */
export function findExpiredMandates(
  beforeSec: bigint,
  exec?: Exec,
): Promise<Result<MandateRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(mandates)
        .where(and(eq(mandates.status, 'ACTIVE'), lt(mandates.exp, beforeSec)))
      return rows as MandateRow[]
    },
    { table: 'mandates', beforeSec: beforeSec.toString() },
  )
}

/** `clock.nowMs()` as a `Date`, for the `timestamptz` columns. */
