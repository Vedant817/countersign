import 'server-only'

/**
 * The one session this app has: an encrypted, `httpOnly` cookie naming the buyer the request belongs to.
 *
 * ## Why this exists, and what it deliberately does not hold
 *
 * Before this file, `SESSION_SECRET` was validated at boot (`packages/core/src/env.ts`) and **never read**:
 * `grep -r iron-session` found no call site, `/api/agent/session` minted a fresh `usr_…` on every request, and
 * there was no ownership check anywhere in `apps/web` (`docs/PROD_AUDIT.md` §4). Two browsers were two
 * throwaway users and nothing distinguished them.
 *
 * The cookie carries **identity and nothing else**: a user id, the email it was issued for, and the persona
 * label the UI shows. It does not carry a role, a balance, a mandate, or a PayPal id — every one of those is
 * re-read from the database on the request that needs it. That is the property that makes revoking a row take
 * effect immediately instead of at cookie expiry: a session is a pointer, not a cache of authority.
 *
 * ## Why the secret is read per call, not at module load
 *
 * A module-level `process.env.SESSION_SECRET ?? throw` makes the whole web app unimportable in a test that has
 * not set the variable, and it hides a deployment mistake behind an import error. Reading it per call means the
 * failure is a `CS_INTERNAL` on the request that needs a session — with a sentence a reader can act on — and a
 * test can set the variable without a module reset.
 *
 * ## Cookie flags
 *
 * `httpOnly` (the chat has no reason to read it), `sameSite: 'lax'` (the run route is same-origin), `secure`
 * whenever `NODE_ENV === 'production'` (never in a plain-HTTP local run), `path: '/'`, and iron-session's own
 * `ttl` so an abandoned laptop is signed out in a week rather than never.
 */
import { getIronSession, type IronSession } from 'iron-session'
import { cookies } from 'next/headers'

import { csError, err, ok, type CsError, type Result, type UserId } from '@countersign/core'

/** Short, product-named, and not a vendor name: the value is ciphertext, not an identifier anyone reads. */
export const SESSION_COOKIE = 'cs_session'

/** Seven days. Long enough for a demo, short enough that a shared laptop is not a permanent login. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

/**
 * The session's contents: one user id, and when it was last written.
 *
 * Nothing else belongs here. A second field is a second thing that can disagree with the row it names — an
 * email that changed, a persona that was corrected, a cap that was raised — and the cookie would win until it
 * expired. Every fact about a user is read from `users` on the request that needs it.
 */
export interface SessionData {
  /** `users.id` this request acts as. Absent means "not signed in". */
  userId?: string
  /** Epoch seconds of the last write, so a session's age is visible without decoding the cookie twice. */
  seenAtSec?: number
}

export type Session = IronSession<SessionData>

/** What iron-session needs from a cookie store — exactly the shape of `await cookies()` in Next 16. */
export interface CookieStoreLike {
  get(name: string): { name: string; value: string } | undefined
  set(name: string, value: string, cookie: Record<string, unknown>): unknown
}

/**
 * The cookie the app issues.
 *
 * `secure` follows `NODE_ENV` rather than the request's protocol: a TLS-terminating proxy in front of a
 * production process would otherwise serve a `Secure` cookie over plain HTTP to the browser and the session
 * would silently never come back.
 */
export function sessionCookieOptions(): {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  path: '/'
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
  }
}

/**
 * The signing password, or the refusal that says it is missing.
 *
 * 32 characters is iron-session's own floor and `env.ts`'s schema. A shorter value is not "a weaker session";
 * it is a session anyone can forge, so this refuses rather than pads.
 */
export function sessionSecret(): Result<string, CsError> {
  const secret = process.env['SESSION_SECRET']?.trim() ?? ''
  if (secret.length < 32) {
    return err(
      csError(
        'CS_INTERNAL',
        'SESSION_SECRET must be set to at least 32 characters for cookie sessions.',
        undefined,
        {
          userMessage: 'Sign-in is not configured on this deployment.',
        },
      ),
    )
  }
  return ok(secret)
}

async function defaultStore(): Promise<CookieStoreLike> {
  return (await cookies()) as unknown as CookieStoreLike
}

/**
 * The request's session, or the refusal that explains why there is not one.
 *
 * A malformed or forged cookie is **not** an error: iron-session fails to decrypt it and hands back an empty
 * session, which is the same state as "never signed in". That is the right answer — a stranger's cookie is
 * not a server fault — and it is why a caller checks `session.get('userId')` rather than catching.
 */
export async function readSession(store?: CookieStoreLike): Promise<Result<Session, CsError>> {
  const secret = sessionSecret()
  if (!secret.ok) return secret
  const target = store ?? (await defaultStore())
  try {
    const session = await getIronSession<SessionData>(target, {
      password: secret.value,
      cookieName: SESSION_COOKIE,
      ttl: SESSION_TTL_SECONDS,
      cookieOptions: sessionCookieOptions(),
    })
    return ok(session)
  } catch (cause) {
    return err(
      csError('CS_INTERNAL', 'The session cookie could not be read.', {
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    )
  }
}

/**
 * The user this request acts as, or `undefined` when the request is anonymous.
 *
 * iron-session v9 hands back the data itself (a `Partial` of it), not a `get`/`set` map — a session that does
 * not exist yet reads as an empty object, so every field is optional at the type level and every read here
 * narrows before it is used.
 */
export async function currentUserId(
  store?: CookieStoreLike,
): Promise<Result<UserId | undefined, CsError>> {
  const session = await readSession(store)
  if (!session.ok) return session
  const id = session.value.userId
  return ok(typeof id === 'string' && id.length > 0 ? (id as UserId) : undefined)
}

/**
 * Bind this session to a user.
 *
 * Called once, right after a user row is created or resolved, so the *next* request is that user's and not a
 * new stranger. Returns the session it wrote so a caller can carry on with it in the same request.
 */
export async function rememberUser(
  input: { userId: UserId },
  store?: CookieStoreLike,
): Promise<Result<Session, CsError>> {
  const session = await readSession(store)
  if (!session.ok) return session
  session.value.userId = input.userId
  session.value.seenAtSec = Math.floor(Date.now() / 1000)
  await session.value.save()
  return session
}

/**
 * The per-user rule for an agent run (audit §4).
 *
 * A run spends a mandate, and a mandate id in a request body is a handle to a budget — so when this browser has
 * a session, the run belongs to that buyer and to no other. A body naming a different user is refused **before**
 * the mandate is read.
 *
 * An anonymous request is allowed through, and that is deliberate rather than an oversight: the agent demo is
 * already gated on `COUNTERSIGN_AGENT_DEMO=1` plus a non-production `NODE_ENV` (`agentDemoAllowed()`), and the
 * acceptance script drives the run route with plain `fetch` and no cookie jar. What this guard removes is the
 * hole that mattered — one browser acting as another user — not the demo's own single-user surface. On a
 * deployment with real accounts, the `session === undefined` branch is where a login requirement goes.
 */
export function guardRunUser(
  sessionUserId: UserId | undefined,
  requestedUserId: string,
): Result<true, CsError> {
  if (sessionUserId === undefined) return ok(true)
  if (sessionUserId === (requestedUserId as UserId)) return ok(true)
  return err(
    csError(
      'CS_FORBIDDEN',
      'This run belongs to the signed-in buyer, not the one named in the request.',
      undefined,
      { userMessage: 'That mandate does not belong to this browser.' },
    ),
  )
}

/** Drop the session. The cookie is cleared by iron-session; the rows are not touched. */
export async function forgetUser(store?: CookieStoreLike): Promise<Result<true, CsError>> {
  const session = await readSession(store)
  if (!session.ok) return session
  session.value.destroy()
  await session.value.save()
  return ok(true)
}
