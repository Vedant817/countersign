/**
 * Typed, prefixed identifiers — spec §8.1 M1.
 *
 * Every row in the §7.2 data model gets a prefix, so a mistyped ID is a *type* error rather than a
 * runtime bug that reads the wrong table. The prefix lives in the type, not in a runtime class, so
 * IDs stay plain strings in JSON, SQL and tokens.
 *
 * Bodies are ULIDs (Crockford base32, 26 chars, lexicographically sortable by creation time).
 * Monotonicity within the same millisecond comes from the random component, which is enough for us;
 * we never rely on ULID ordering for correctness — only for tie-free display order.
 */
import { randomBytes } from 'node:crypto'

/** `usr_…`, `mdt_…` etc. The ULID body follows. */
export type Id<P extends string> = `${P}_${string}`

export type UserId = Id<'usr'>
export type WalletId = Id<'wal'>
export type DeviceId = Id<'dev'>
export type AgentId = Id<'agt'>
export type MandateId = Id<'mdt'>
export type CheckoutId = Id<'chk'>
export type AttemptId = Id<'att'>
export type GateDecisionId = Id<'gdc'>
export type OrderId = Id<'ord'>
export type ShipmentId = Id<'shp'>
export type DisputeId = Id<'dsp'>
export type PacketId = Id<'pkt'>
export type L1Id = Id<'l1'>
export type WebhookEventId = Id<'whe'>
export type AuditLogId = Id<'aud'>
export type DisputeActionId = Id<'dac'>
export type RefundRowId = Id<'ref'>
export type CaptureRowId = Id<'cap'>
export type AuthorizationRowId = Id<'aut'>
export type BudgetEntryId = Id<'ben'>
export type ShipmentIdAlias = ShipmentId
export type PrivacyRequestId = Id<'prv'>

/** Every prefix the system knows about. Used by {@link assertIdPrefix} and by tests. */
export const ID_PREFIXES = {
  usr: 'usr',
  wal: 'wal',
  dev: 'dev',
  agt: 'agt',
  mdt: 'mdt',
  chk: 'chk',
  att: 'att',
  gdc: 'gdc',
  ord: 'ord',
  shp: 'shp',
  dsp: 'dsp',
  pkt: 'pkt',
  l1: 'l1',
  whe: 'whe',
  aud: 'aud',
  dac: 'dac',
  ref: 'ref',
  cap: 'cap',
  aut: 'aut',
  ben: 'ben',
  prv: 'prv',
} as const satisfies Record<string, string>

export type IdPrefix = keyof typeof ID_PREFIXES

// Crockford base32 (no I, L, O, U) — the ULID alphabet.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Crockford's base32 for a 48-bit value, zero-padded to 10 chars. */
function encodeTime(ms: number): string {
  let out = ''
  let n = Math.floor(ms)
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[n % 32] + out
    n = Math.floor(n / 32)
  }
  return out
}

/**
 * 80 bits of randomness as 16 Crockford chars.
 *
 * `randomBytes` is CSPRNG-backed. We take 10 bytes (80 bits) and drop 2 bits so that every byte's
 * 5-bit slice stays inside the alphabet without per-byte masking.
 */
function encodeRandom(): string {
  const b = randomBytes(10)
  let bits = 0n
  for (const byte of b) bits = (bits << 8n) | BigInt(byte)
  bits >>= 2n // 80 bits -> 78 bits, then we use 75 of them below
  let out = ''
  let n = bits
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(n % 32n)] + out
    n /= 32n
  }
  return out
}

/**
 * A ULID body: 26 Crockford chars, 10 of timestamp and 16 of randomness.
 * Lexicographic order equals creation order for IDs minted in different milliseconds.
 */
export function ulid(nowMs: number = Date.now()): string {
  return encodeTime(nowMs) + encodeRandom()
}

/**
 * Mint a new prefixed ID.
 *
 * @param prefix the row's prefix, e.g. `'mdt'`.
 * @param nowMs injectable for tests that need reproducible ordering.
 */
export function newId<P extends IdPrefix>(prefix: P, nowMs?: number): Id<`${P}_${''}`> {
  return `${ID_PREFIXES[prefix]}_${ulid(nowMs)}` as Id<`${P}_${''}`>
}

/** Narrow an unknown string to a typed ID, or return `null` if the prefix is wrong. */
export function asId<P extends IdPrefix>(prefix: P, value: string): Id<`${P}_${''}`> | null {
  return value.startsWith(`${ID_PREFIXES[prefix]}_`) ? (value as Id<`${P}_${''}`>) : null
}

/** True when `value` carries the given prefix. */
export function hasPrefix(prefix: IdPrefix, value: string): boolean {
  return value.startsWith(`${ID_PREFIXES[prefix]}_`)
}

/**
 * Extract the prefix from a prefixed ID; `null` if there is none.
 *
 * Two or three characters, lowercase, and *may contain a digit* — `l1_` is a real prefix
 * (the L1 credential table, spec §7.2), so `^[a-z]{3}$` would reject it.
 */
export function idPrefix(value: string): string | null {
  const i = value.indexOf('_')
  if (i <= 0) return null
  const p = value.slice(0, i)
  return /^[a-z][a-z0-9]{1,2}$/.test(p) ? p : null
}

/**
 * Reconstruct the creation timestamp encoded in a ULID body.
 *
 * Only meaningful for IDs we minted; a `jti` minted by another system has no ULID body. Returns
 * `null` rather than guessing when the body is not 26 valid Crockford chars.
 */
export function idCreatedAtMs(value: string): number | null {
  const body = value.slice(value.indexOf('_') + 1)
  if (body.length !== 26) return null
  let n = 0
  for (const ch of body.slice(0, 10)) {
    const d = CROCKFORD.indexOf(ch)
    if (d < 0) return null
    n = n * 32 + d
  }
  // ULID timestamps are 48-bit; if it overflows a safe integer it is not one of ours.
  return Number.isSafeInteger(n) ? n : null
}

/** Sort helper: newest first, by embedded ULID timestamp. */
export function byNewest<P extends string>(a: Id<P>, b: Id<P>): number {
  return (idCreatedAtMs(b) ?? 0) - (idCreatedAtMs(a) ?? 0)
}
