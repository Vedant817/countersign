/**
 * Password hashing for the merchant sign-in — decision D-059.
 *
 * ## Why `scrypt` and not argon2
 *
 * argon2 is the stronger default, and it would be the wrong choice *here*: the only bindings are
 * Node's built-in `crypto.scrypt` and a native package that needs a compiler on every machine that
 * installs the monorepo (Render's build image included). A password hash that cannot be installed is
 * not a password hash. `scrypt` is in Node's standard library, is memory-hard, and is the primitive
 * Node's own documentation recommends for passwords. The parameters below are the RFC 7914
 * interactive-login profile (`N=16384, r=8, p=1`), which costs about 16 MiB and ~50 ms per hash —
 * high enough to make bulk guessing expensive, low enough that a login is not a wait.
 *
 * ## Why the format carries its parameters
 *
 * `scrypt$N$r$p$<salt>$<hash>` — not a bare digest. The parameters travel with the hash so they can be
 * raised later without invalidating every stored password: `verifyPassword` reads them from the string
 * rather than from this file's constants, and a future rehash-on-login compares them. A hash whose
 * parameters are a code constant is a hash that cannot be upgraded without a migration.
 *
 * ## Why every check is constant-time
 *
 * `timingSafeEqual` over the derived bytes, and a stored value that does not parse is a **false**, not
 * an exception: a malformed row must read as "this password is wrong", never as a server fault that
 * reveals which accounts have unreadable hashes.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

const scrypt = (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })

/** The RFC 7914 interactive profile. `maxmem` is raised because Node's default (32 MiB) is close to the
 * 128·N·r bytes this profile needs, and a hash that throws on a valid parameter set is a login outage. */
export const SCRYPT_N = 16_384
export const SCRYPT_R = 8
export const SCRYPT_P = 1
const KEY_LENGTH = 32
const SALT_BYTES = 16
const MAXMEM = 64 * 1024 * 1024

const PREFIX = 'scrypt'

interface ParsedHash {
  readonly N: number
  readonly r: number
  readonly p: number
  readonly salt: Buffer
  readonly hash: Buffer
}

/** `null` for anything that is not a hash this module wrote — never a throw. */
function parseStored(stored: string): ParsedHash | null {
  const parts = stored.split('$')
  if (parts.length !== 6) return null
  const [prefix, n, r, p, salt, hash] = parts
  if (prefix !== PREFIX) return null
  const parsed = [n, r, p].map((value) => Number(value))
  if (parsed.some((value) => !Number.isInteger(value) || value <= 0)) return null
  const [N, rValue, pValue] = parsed
  if (N === undefined || rValue === undefined || pValue === undefined) return null
  return {
    N,
    r: rValue,
    p: pValue,
    salt: Buffer.from(salt ?? '', 'base64url'),
    hash: Buffer.from(hash ?? '', 'base64url'),
  }
}

/** Hash a password for storage. The salt is random per call, so the same password never hashes twice alike. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  })
  return [
    PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

/** `true` only when the password matches a hash {@link hashPassword} produced. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored)
  if (parsed === null) return false
  if (parsed.salt.length === 0 || parsed.hash.length === 0) return false
  const derived = await scrypt(password, parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: MAXMEM,
  })
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash)
}

let dummyHash: Promise<string> | null = null

/**
 * Spend the same work as a real verification, for a login that found no user.
 *
 * Without this, "no such email" answers in ~1 ms and "wrong password" answers in ~50 ms, and the
 * difference tells an attacker which addresses have accounts. The value is generated once per process
 * and discarded; nothing about it is a credential.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'))
  await verifyPassword(password, await dummyHash)
}
