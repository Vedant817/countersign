/**
 * `scrypt` password hashing — decision D-059.
 *
 * The properties that matter are not "it produces a string": they are that the same password never
 * hashes twice alike (a per-call salt), that a wrong password is a **false** rather than a throw, that a
 * malformed stored value is also a false (so a corrupt row cannot become a server fault that reveals the
 * row is corrupt), and that the parameters travel with the hash so a future increase does not invalidate
 * stored passwords.
 */
import { describe, expect, it } from 'vitest'

import {
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  burnPasswordCheck,
  hashPassword,
  verifyPassword,
} from '../src/password'

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
  })

  it('salt is random per call: the same password never hashes twice alike', async () => {
    const first = await hashPassword('same password')
    const second = await hashPassword('same password')
    expect(first).not.toBe(second)
    expect(await verifyPassword('same password', second)).toBe(true)
  })

  it('carries its parameters, so they can be raised without invalidating a stored hash', async () => {
    const stored = await hashPassword('a password')
    const [, n, r, p] = stored.split('$')
    expect(Number(n)).toBe(SCRYPT_N)
    expect(Number(r)).toBe(SCRYPT_R)
    expect(Number(p)).toBe(SCRYPT_P)
  })

  it.each([
    ['empty', ''],
    ['not a hash at all', 'plaintext'],
    ['wrong prefix', 'argon2$1$2$3$AAAA$BBBB'],
    ['too few fields', 'scrypt$16384$8$1$AAAA'],
    ['non-numeric cost', 'scrypt$sixteen$8$1$AAAA$BBBB'],
    ['zero cost', 'scrypt$0$8$1$AAAA$BBBB'],
    ['empty salt and digest', 'scrypt$16384$8$1$$'],
  ])('treats %s as a failed check, not an error', async (_label, stored) => {
    expect(await verifyPassword('anything', stored)).toBe(false)
  })

  it('burns a check for a login that found no account, so the two answers cost the same', async () => {
    await expect(burnPasswordCheck('a password')).resolves.toBeUndefined()
  })
})
