/**
 * The only time source — spec §8.1 M1, §0 ("Time is UTC epoch seconds in tokens").
 *
 * Nothing in this codebase calls `Date.now()` directly for business logic. Every module that needs
 * the time takes a `Clock`, so tests can pin expiry, price-lock boundaries, honour periods and
 * dispute deadlines deterministically (EC-MDT-1, EC-TIME-3, EC-TIME-4, EC-TIME-5, EC-DSP-7/8).
 *
 * Presentation converts to IST at the edge (see `formatIst` below) and never anywhere else.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch, UTC. */
  nowMs(): number
  /** Whole seconds since the Unix epoch, UTC — what goes into `iat`, `exp`, `nbf` and `jti`. */
  nowSec(): number
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowSec: () => Math.floor(Date.now() / 1000),
}

/**
 * Whole epoch seconds for a `Date` read out of the database.
 *
 * ## Why this exists rather than an inline `Math.floor(d.getTime() / 1000)`
 *
 * AGENTS.md rule 10 puts time in the database as `timestamptz` and in tokens as **UTC epoch
 * seconds**, so every DB read has to make that conversion, and `Math.floor(x / 1000)` is the shape of
 * it. That is the *same shape* as the money bug the discipline scanner hunts — `Math.round(totalMinor
 * / 100)` — with the opposite meaning, and the scanner cannot tell them apart from text alone. It
 * flagged `apps/worker`'s `reservedAtSec: Math.floor(attempt.created_at.getTime() / 1000)` because
 * `MONEY_NAME` matches `reserve` inside `reservedAtSec`.
 *
 * Rounding a **timestamp** to whole seconds is not a defect; it is what the storage format requires.
 * Rounding an **amount** from minor units to major units loses or invents money. Both are
 * `Math.floor(x / 1000)`.
 *
 * So the conversion is named here, once, where the intent is unambiguous, and callers say which
 * conversion they mean. {@link fromMinorUnits} is the money one, and it takes a `Money`.
 */
export function epochSecFrom(date: Date): number {
  const ms = date.getTime()
  if (!Number.isFinite(ms)) {
    // A `timestamptz` column is `NOT NULL`, so this means the driver handed back something that is
    // not a date. Rounding it to 0 would silently place the event at the epoch, which is worse than
    // refusing: a reservation released "infinitely long ago" and one released "now" are both wrong,
    // and only one of them is visible.
    throw new RangeError(`epochSecFrom: not a valid Date (getTime() returned ${String(ms)})`)
  }
  return Math.floor(ms / 1000)
}

/** A clock frozen at `sec`. Tests advance it by reassigning `sec` or using {@link advanceClock}. */
export function fixedClock(
  sec: number,
): Clock & { set(sec: number): void; advance(deltaSec: number): void } {
  let current = Math.floor(sec)
  return {
    nowMs: () => current * 1000,
    nowSec: () => current,
    set(next: number) {
      current = Math.floor(next)
    },
    advance(deltaSec: number) {
      current += Math.floor(deltaSec)
    },
  }
}

/** Default allowed skew, matching the Verifiable Intent library default (spec §8.3, [B2]). */
export const DEFAULT_CLOCK_SKEW_SECONDS = 300

/**
 * Is `atSec` inside `[iat - skew, exp + skew]`?
 *
 * The skew is asymmetric on purpose and matches how JWT consumers behave: we accept a token that
 * expired up to `skew` seconds ago, because two hosts can be a few seconds apart and a payment in
 * flight must not fail because of a clock. It is documented in spec §12.5 EC-TIME-2.
 */
export function withinValidity(
  atSec: number,
  bounds: { iat?: number; nbf?: number; exp?: number },
  skewSeconds: number = DEFAULT_CLOCK_SKEW_SECONDS,
): { valid: boolean; reason?: 'NOT_YET_VALID' | 'EXPIRED' } {
  const skew = Math.max(0, Math.floor(skewSeconds))
  if (bounds.nbf !== undefined && atSec < bounds.nbf - skew) {
    return { valid: false, reason: 'NOT_YET_VALID' }
  }
  if (bounds.iat !== undefined && atSec < bounds.iat - skew) {
    return { valid: false, reason: 'NOT_YET_VALID' }
  }
  if (bounds.exp !== undefined && atSec > bounds.exp + skew) {
    return { valid: false, reason: 'EXPIRED' }
  }
  return { valid: true }
}

const IST_OFFSET_MINUTES = 330 // Asia/Kolkata has no DST, so a fixed offset is exact, not an approximation.
export const IST_OFFSET_MINUTES_EXPORT = IST_OFFSET_MINUTES

export interface IstParts {
  year: number
  month: string
  day: string
  hour: string
  minute: string
  second: string
  weekday: string
}

/**
 * Break a UTC timestamp into IST calendar parts without pulling in a timezone database.
 *
 * Asia/Kolkata is UTC+05:30 with **no daylight saving since 1945**, so a fixed offset is correct
 * forever for our purposes (spec §0: "IST only in the UI and in reports to Vedant").
 */
export function toIstParts(epochMs: number): IstParts {
  const d = new Date(epochMs + IST_OFFSET_MINUTES * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    year: d.getUTCFullYear(),
    month: pad(d.getUTCMonth() + 1),
    day: pad(d.getUTCDate()),
    hour: pad(d.getUTCHours()),
    minute: pad(d.getUTCMinutes()),
    second: pad(d.getUTCSeconds()),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] as string,
  }
}

/** ISO-8601 string for `epochSec` with an explicit `+05:30` offset, e.g. `2026-10-09T23:59:00+05:30`. */
export function formatIst(epochSec: number, opts: { seconds?: boolean } = {}): string {
  const p = toIstParts(epochSec * 1000)
  const time = `${p.hour}:${p.minute}${opts.seconds === false ? '' : `:${p.second}`}`
  return `${p.year}-${p.month}-${p.day}T${time}+05:30`
}

/**
 * Readable IST form for the UI: `"Fri 9 Oct, 11:59 PM IST"` — exactly the shape the read-back
 * templates in `packages/compiler` promise the user (spec §8.8 "Read-back").
 */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

export function formatIstHuman(epochSec: number): string {
  const p = toIstParts(epochSec * 1000)
  const h24 = Number(p.hour)
  const ampm = h24 < 12 ? 'AM' : 'PM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${p.weekday} ${Number(p.day)} ${MONTHS[Number(p.month) - 1]}, ${h12}:${p.minute} ${ampm} IST`
}

/** `"2h 14m"` / `"41s"` — countdown strings for price locks and dispute deadlines. */
export function formatCountdown(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return '0s'
  const d = Math.floor(secondsRemaining / 86_400)
  const h = Math.floor((secondsRemaining % 86_400) / 3_600)
  const m = Math.floor((secondsRemaining % 3_600) / 60)
  const s = Math.floor(secondsRemaining % 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
