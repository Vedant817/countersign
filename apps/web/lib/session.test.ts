/**
 * The cookie session (`lib/session.ts`).
 *
 * These tests are about the three properties a session has to have before anything else can depend on it:
 *
 *  1. **It round-trips.** What `rememberUser` wrote is what `readSession` reads, on a later call.
 *  2. **A forged cookie is anonymous, not an error.** iron-session fails to decrypt a value it did not write;
 *     the reader must see "not signed in", because a stranger's cookie is not a server fault.
 *  3. **No secret, no session — and the refusal is legible.** `SESSION_SECRET` is 32+ characters or this
 *     refuses with `CS_INTERNAL` and a sentence a reader can act on, rather than issuing a cookie anyone can
 *     forge.
 *
 * The fake store is the shape `await cookies()` returns (`get` + `set`), so the module under test is the same
 * one a route handler calls; nothing here needs a running Next server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  currentUserId,
  forgetUser,
  guardRunUser,
  readSession,
  rememberUser,
  sessionCookieOptions,
  startSession,
} from './session'
import type { CookieStoreLike } from './session'

/** A cookie jar in the shape Next hands the session. */
function jar(): CookieStoreLike & { raw: Map<string, string> } {
  const raw = new Map<string, string>()
  return {
    raw,
    get: (name: string) => {
      const value = raw.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set: (name: string, value: string) => {
      raw.set(name, value)
      return undefined
    },
  }
}

const SECRET = 'test-session-secret-of-at-least-32-characters'
const USER = 'usr_01HZX0000000000000000DEMO' as never

beforeEach(() => {
  process.env['SESSION_SECRET'] = SECRET
})

afterEach(() => {
  delete process.env['SESSION_SECRET']
})

describe('the session cookie', () => {
  it('round-trips a user id', async () => {
    const store = jar()

    const written = await rememberUser({ userId: USER }, store)
    expect(written.ok).toBe(true)
    // The cookie is set under our name and is not the user id in the clear.
    expect(store.raw.has(SESSION_COOKIE)).toBe(true)
    expect(store.raw.get(SESSION_COOKIE)).not.toBe(USER as string)

    const read = await readSession(store)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.userId).toBe(USER as string)
    expect(read.value.seenAtSec).toBeTypeOf('number')
  })

  it('reads an absent cookie as anonymous, not as a failure', async () => {
    const read = await readSession(jar())
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.userId).toBeUndefined()

    const id = await currentUserId(jar())
    expect(id.ok).toBe(true)
    if (!id.ok) return
    expect(id.value).toBeUndefined()
  })

  it('reads a forged cookie as anonymous, not as an error', async () => {
    const store = jar()
    store.raw.set(SESSION_COOKIE, 'not-a-cookie-iron-session-wrote')

    const read = await readSession(store)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.userId).toBeUndefined()
  })

  it('refuses to issue a session without a 32+ character secret', async () => {
    process.env['SESSION_SECRET'] = 'too-short'
    const store = jar()

    const read = await readSession(store)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe('CS_INTERNAL')
    expect(read.error.userMessage).toBe('Sign-in is not configured on this deployment.')
    // Nothing was written: a refusal must not leave half a cookie behind.
    expect(store.raw.size).toBe(0)
  })

  it('forgets the user', async () => {
    const store = jar()
    await rememberUser({ userId: USER }, store)

    const dropped = await forgetUser(store)
    expect(dropped.ok).toBe(true)

    const read = await readSession(store)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.userId).toBeUndefined()
  })

  it('anchors a sign-in with a login timestamp, so an old cookie fails closed', async () => {
    const store = jar()
    await rememberUser({ userId: USER }, store)
    const read = await readSession(store)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.loginAtSec).toBeTypeOf('number')
  })

  it('rotates the seal on sign-in rather than reusing the cookie the browser arrived with', async () => {
    const store = jar()
    await rememberUser({ userId: 'usr_01HZX0000000000000000OTHER' as never }, store)
    const before = store.raw.get(SESSION_COOKIE)
    expect(before).toBeTypeOf('string')

    const started = await startSession({ userId: USER }, store)
    expect(started.ok).toBe(true)
    const after = store.raw.get(SESSION_COOKIE)
    expect(after).toBeTypeOf('string')
    // A rotation is a new seal, not the same bytes under a new name.
    expect(after).not.toBe(before)

    const read = await readSession(store)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.userId).toBe(USER as string)
    expect(read.value.loginAtSec).toBeTypeOf('number')
  })
})

describe('the run-user rule', () => {
  it('refuses a body that names another user', () => {
    const refused = guardRunUser(USER, 'usr_01HZX0000000000000000OTHER')
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    // The reader sees the sentence, not the code: this is the one a judge would read.
    expect(refused.error.code).toBe('CS_FORBIDDEN')
    expect(refused.error.userMessage).toBe('That mandate does not belong to this browser.')
  })

  it('allows the user the session names', () => {
    expect(guardRunUser(USER, USER as string).ok).toBe(true)
  })

  it('allows an anonymous request, because the demo gate is what closes that door', () => {
    // On a deployment with real accounts this branch becomes a login requirement; today the run route is
    // already refused by agentDemoAllowed() unless COUNTERSIGN_AGENT_DEMO=1 and NODE_ENV is not production.
    expect(guardRunUser(undefined, 'usr_anyone').ok).toBe(true)
  })
})

describe('the cookie flags', () => {
  it('is httpOnly, same-site lax, and path /', () => {
    const options = sessionCookieOptions()
    expect(options.httpOnly).toBe(true)
    expect(options.sameSite).toBe('lax')
    expect(options.path).toBe('/')
  })

  it('is Secure only in production', () => {
    // `process.env.NODE_ENV` is typed read-only (Next replaces it at build time); the test needs to move it,
    // so it goes through the index signature the type checker cannot narrow.
    const env = process.env as Record<string, string | undefined>
    const previous = env['NODE_ENV']
    try {
      env['NODE_ENV'] = 'production'
      expect(sessionCookieOptions().secure).toBe(true)
      env['NODE_ENV'] = 'development'
      // A plain-HTTP local run that set Secure would never see its own cookie come back.
      expect(sessionCookieOptions().secure).toBe(false)
    } finally {
      env['NODE_ENV'] = previous
    }
  })

  it('expires in a week', () => {
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60)
  })
})
