/**
 * The login rate limit — D-059.
 *
 * ## What this is, and the limit it honestly has
 *
 * A password login is the one endpoint where an attacker can try a guess without any other capability,
 * so it gets a budget: **5 attempts per 15 minutes per (email, client address)**. After that the route
 * answers `429` with `Retry-After` and does not read the password at all.
 *
 * The counter now lives in Postgres table login_attempts (D-059 update), shared across replicas and
 * restarts. What it does buy is the thing a password form actually faces: a single attacker hammering
 * one account from one address, which is the shape of every credential-stuffing run against a small deployment.
 *
 * ## Why the key includes both the email and the address
 *
 * Per-email alone lets an attacker lock out a merchant they know the address of — a denial of service on
 * the one person who can approve a dispute. Per-address alone lets a botnet try one password per address.
 * Both together mean a distributed guesser needs a fresh address per *few* guesses and a local attacker
 * cannot lock the account out from elsewhere.
 *
 * ## Why the window is fixed rather than sliding
 *
 * A fixed window is two lines and cannot be gamed by spreading attempts across a boundary in a way that
 * matters here; the abuse it is stopping is volume, not a precise rate. The cost of being wrong is that a
 * caller can make 10 attempts across two adjacent windows, which is still five orders of magnitude below
 * an online guessing attack on a 16-byte salt.
 */
import { consumeLoginAttempt, db, resetLoginAttempts } from '@countersign/db'

export const LOGIN_ATTEMPTS_PER_WINDOW = 5
export const LOGIN_WINDOW_MS = 15 * 60 * 1000

export interface RateLimitVerdict {
  readonly allowed: boolean
  /** Whole seconds until the caller may try again. `0` when the attempt was allowed. */
  readonly retryAfterSec: number
}

/** The bucket key. Lower-cased so `A@Example.test` and `a@example.test` share one budget. */
export function loginRateLimitKey(email: string, clientAddress: string): string {
  return `${clientAddress}|${email.trim().toLowerCase()}`
}

/**
 * Spend one attempt. `allowed: false` means the attempt was **not** counted and the caller must wait;
 * a blocked caller cannot extend their own block by continuing to knock, which is the property that stops
 * the limit from being a permanent denial the attacker controls.
 */
export async function checkLoginRateLimit(
  key: string,
  now: number = Date.now(),
): Promise<RateLimitVerdict> {
  return consumeLoginAttempt(db(), key, now, LOGIN_ATTEMPTS_PER_WINDOW, LOGIN_WINDOW_MS)
}

/** Test and operational helper: forget one key, or every key when none is given. */
export async function resetLoginRateLimit(key?: string): Promise<void> {
  await resetLoginAttempts(db(), key)
}
