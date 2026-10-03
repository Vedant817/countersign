/**
 * `devices` repository — spec §7.2, Gate check 3 (§8.10), EC-KEY-1.
 *
 * A device row is a public key plus its RFC 7638 thumbprint. The device signs L2 payloads; the
 * private half never leaves the browser (§3.1 trust boundary), so this table stores nothing secret
 * and is safe to include in a subject-access export.
 *
 * `findDeviceByJkt` is the hot path: the L1 binds `cnf.jkt`, and the Gate resolves the device behind
 * a mandate on every single attempt. It reads `(user_id, jkt)`, which is a unique index.
 */
import { and, eq } from 'drizzle-orm'

import type { CsError, DeviceId, L1Id, Result } from '@countersign/core'

import { db, type Exec } from '../client'
import {
  devices,
  l1Credentials,
  type DeviceRow,
  type L1Row,
  type NewDevice,
  type NewL1,
} from '../schema'
import { err, repo } from './index'

export function createDevice(input: NewDevice, exec?: Exec): Promise<Result<DeviceRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(devices).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no devices row')
      return row as DeviceRow
    },
    { table: 'devices', id: input.id },
  )
}

export function findDeviceById(
  id: DeviceId,
  exec?: Exec,
): Promise<Result<DeviceRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(devices).where(eq(devices.id, id)).limit(1)
      return rows[0] as DeviceRow | undefined
    },
    { table: 'devices', id },
  )
}

/** Gate check 3: resolve the device behind a mandate and read its status. */
export function findDeviceByJkt(
  userId: string,
  jkt: string,
  exec?: Exec,
): Promise<Result<DeviceRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(devices)
        .where(and(eq(devices.user_id, userId), eq(devices.jkt, jkt)))
        .limit(1)
      return rows[0] as DeviceRow | undefined
    },
    { table: 'devices', userId, jkt },
  )
}

export function findDevicesByUser(
  userId: string,
  exec?: Exec,
): Promise<Result<DeviceRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(devices).where(eq(devices.user_id, userId))
      return rows as DeviceRow[]
    },
    { table: 'devices', userId },
  )
}

/**
 * Gate check 3 needs "is this device usable", which is a status question, not an existence one. A
 * `LOST` or `REVOKED` device fails the check with `GATE_REVOKED` (EC-BUY-3 / EC-KEY-1: the agent key
 * signs purchases, but the device's status is still evidence of a compromised machine).
 */
export async function assertDeviceActive(
  id: DeviceId,
  exec?: Exec,
): Promise<Result<DeviceRow, CsError>> {
  const found = await findDeviceById(id, exec)
  if (!found.ok) return found
  const device = found.value
  if (!device) {
    return err({
      code: 'CS_NOT_FOUND',
      message: `No devices row for ${id}`,
      userMessage: 'We could not find that device.',
      retryable: false,
      details: { table: 'devices', id },
    })
  }
  if (device.status !== 'ACTIVE') {
    return err({
      code: 'GATE_REVOKED',
      message: `Device ${id} is ${device.status}`,
      userMessage:
        'Your device was reported lost or revoked, so nothing further can be charged on it.',
      retryable: false,
      details: { table: 'devices', id, status: device.status },
    })
  }
  return { ok: true, value: device }
}

/**
 * EC-KEY-1: a lost device is **not** deleted and its mandates keep working until they expire, because
 * the agent key — not the device key — signs purchases. `LOST` is recorded so R-UNAUTH-2 can tell a
 * buyer that a device went missing *after* the mandate was signed.
 */
export function markDeviceLost(
  id: DeviceId,
  at: Date,
  exec?: Exec,
): Promise<Result<DeviceRow, CsError>> {
  return setDeviceStatus(id, 'LOST', at, exec)
}

export function markDeviceRevoked(
  id: DeviceId,
  at: Date,
  exec?: Exec,
): Promise<Result<DeviceRow, CsError>> {
  return setDeviceStatus(id, 'REVOKED', at, exec)
}

function setDeviceStatus(
  id: DeviceId,
  status: 'LOST' | 'REVOKED',
  at: Date,
  exec?: Exec,
): Promise<Result<DeviceRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(devices)
        .set({ status, updated_at: at })
        .where(eq(devices.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No devices row for ${id}`)
      return row as DeviceRow
    },
    { table: 'devices', id, status },
  )
}

/** `last_used_at` is what the settings screen shows ("last used 4 Oct, 10:02 IST"). */
export function touchDevice(
  id: DeviceId,
  at: Date,
  exec?: Exec,
): Promise<Result<DeviceRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(devices)
        .set({ last_used_at: at, updated_at: at })
        .where(eq(devices.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No devices row for ${id}`)
      return row as DeviceRow
    },
    { table: 'devices', id },
  )
}

/** WebAuthn credential binding (D4). One credential id per device row; null when UV was skipped. */
export function bindWebauthnCredential(
  id: DeviceId,
  credentialId: string,
  at: Date,
  exec?: Exec,
): Promise<Result<DeviceRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(devices)
        .set({ webauthn_credential_id: credentialId, updated_at: at })
        .where(eq(devices.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No devices row for ${id}`)
      return row as DeviceRow
    },
    { table: 'devices', id },
  )
}

/* ------------------------------------------------------------------------------------------ */
/* l1_credentials — kept here because L1 *is* the device credential (§7.2, §8.7)                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * L1 is the credential that binds a device key to a wallet, issued once per device×wallet pair
 * (`l1_credentials_device_id_wallet_id_key`). It lives in this file because its only meaningful
 * lookups are by device and by wallet — both of which this repo already speaks.
 */
export function createL1Credential(input: NewL1, exec?: Exec): Promise<Result<L1Row, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(l1Credentials).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no l1_credentials row')
      return row as L1Row
    },
    { table: 'l1_credentials', id: input.id },
  )
}

/**
 * Re-issue path. `onConflictDoUpdate` on the (device, wallet) pair rather than a second insert: a
 * double-clicked "create L1" must converge on one credential, and EC-KEY-2 (issuer key rotation)
 * re-issues over the same pair deliberately.
 */
export function upsertL1Credential(input: NewL1, exec?: Exec): Promise<Result<L1Row, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .insert(l1Credentials)
        .values(input)
        .onConflictDoUpdate({
          target: [l1Credentials.device_id, l1Credentials.wallet_id],
          set: {
            sd_jwt: input.sd_jwt,
            issuer_kid: input.issuer_kid,
            iat: input.iat,
            exp: input.exp,
            status: input.status ?? 'ACTIVE',
            updated_at: new Date(),
          },
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('UPSERT ... RETURNING produced no l1_credentials row')
      return row as L1Row
    },
    { table: 'l1_credentials', deviceId: input.device_id, walletId: input.wallet_id },
  )
}

export function findL1ById(id: L1Id, exec?: Exec): Promise<Result<L1Row | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(l1Credentials)
        .where(eq(l1Credentials.id, id))
        .limit(1)
      return rows[0] as L1Row | undefined
    },
    { table: 'l1_credentials', id },
  )
}

/** The lookup `mandates.ts` needs when it enforces `mandate.exp <= L1.exp`. */
export function findL1ForDeviceWallet(
  deviceId: string,
  walletId: string,
  exec?: Exec,
): Promise<Result<L1Row | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(l1Credentials)
        .where(and(eq(l1Credentials.device_id, deviceId), eq(l1Credentials.wallet_id, walletId)))
        .limit(1)
      return rows[0] as L1Row | undefined
    },
    { table: 'l1_credentials', deviceId, walletId },
  )
}

export function findL1ByUser(userId: string, exec?: Exec): Promise<Result<L1Row[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(l1Credentials)
        .where(eq(l1Credentials.user_id, userId))
      return rows as L1Row[]
    },
    { table: 'l1_credentials', userId },
  )
}

export function findL1ByUserAndStatus(
  userId: string,
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED',
  exec?: Exec,
): Promise<Result<L1Row[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(l1Credentials)
        .where(and(eq(l1Credentials.user_id, userId), eq(l1Credentials.status, status)))
      return rows as L1Row[]
    },
    { table: 'l1_credentials', userId, status },
  )
}

/** EC-MDT-6: a deleted vault token suspends the credentials that depend on it. */
export function setL1Status(
  id: L1Id,
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED',
  at: Date,
  exec?: Exec,
): Promise<Result<L1Row, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(l1Credentials)
        .set({ status, updated_at: at })
        .where(eq(l1Credentials.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No l1_credentials row for ${id}`)
      return row as L1Row
    },
    { table: 'l1_credentials', id, status },
  )
}

/**
 * Guard for the mandate writer: refuse to sign a mandate against a credential that is expired or
 * not active. The companion rule — `mandate.exp <= l1.exp` — lives in `mandates.ts` because it spans
 * two tables and must be evaluated in the same transaction as the mandate insert.
 */
export function assertL1Usable(l1: L1Row, nowSec: number): Result<L1Row, CsError> {
  if (l1.status !== 'ACTIVE') {
    return err({
      code: 'VI_EXPIRED',
      message: `L1 credential ${l1.id} is ${l1.status}`,
      userMessage: 'That credential is no longer active. Ask for a new one and we will continue.',
      retryable: false,
      details: { table: 'l1_credentials', id: l1.id, status: l1.status },
    })
  }
  if (nowSec > l1.exp) {
    return err({
      code: 'VI_EXPIRED',
      message: `L1 credential ${l1.id} expired at ${l1.exp}; now ${nowSec}`,
      userMessage: 'That credential has expired. Ask for a new one and we will continue.',
      retryable: false,
      details: { table: 'l1_credentials', id: l1.id, exp: l1.exp.toString() },
    })
  }
  return { ok: true, value: l1 }
}
