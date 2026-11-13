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

import {
  csError,
  err,
  ok,
  type AgentId,
  type CsError,
  type MandateId,
  type Result,
  type UserId,
} from '@countersign/core'
import { findMandatesByUser } from '@countersign/db'

/** Short, product-named, and not a vendor name: the value is ciphertext, not an identifier anyone reads. */
export const SESSION_COOKIE = 'cs_session'

/** Seven days. Long enough for a demo, short enough that a shared laptop is not a permanent login. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

/**
 * The absolute lifetime of a sign-in — D-059.
 *
 * The cookie's `ttl` is a *cookie* lifetime: it is reissued on every response that touches the session,
 * so a session that is used daily would otherwise live forever. This is the wall clock that ends it
 * regardless of activity. Twelve hours is one working day: long enough that a merchant does not sign in
 * per dispute, short enough that a stolen laptop is not a permanent merchant session.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12

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
  /** Epoch seconds this sign-in began. Absent means "this cookie is not a sign-in" (D-059). */
  loginAtSec?: number
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
 * Bind this session to a user without a password check.
 *
 * ## Why this is not on the sign-in path any more (D-060)
 *
 * `rememberUser` writes a session for a `users.id` with no credential behind it. It was written for
 * `/api/agent/session`, which minted a buyer on the spot and then bound the browser to it — so the cookie
 * said "signed in" for an account nobody had authenticated for. That call site is gone: `startSession` is
 * the only thing a password sign-in writes.
 *
 * It stays exported, and tested, because it is the honest primitive underneath `startSession` — the write
 * without the rotation, which is what a future non-password sign-in (a passkey, an OAuth round trip) will
 * need once it has verified something. It is deliberately **not** what any route calls today, and a grep for
 * it is the check that a new caller has to justify.
 */
export async function rememberUser(
  input: { userId: UserId },
  store?: CookieStoreLike,
): Promise<Result<Session, CsError>> {
  const session = await readSession(store)
  if (!session.ok) return session
  const nowSec = Math.floor(Date.now() / 1000)
  session.value.userId = input.userId
  session.value.loginAtSec = nowSec
  session.value.seenAtSec = nowSec
  await session.value.save()
  return session
}

/**
 * Start a fresh sign-in: destroy whatever session this browser held, then write a new one.
 *
 * ## Why destruction is the first step, not an optimisation
 *
 * A sign-in is a privilege change, and a privilege change that reuses the cookie it was given is a session
 * fixation: an attacker who can plant a cookie before the merchant signs in keeps the authenticated cookie
 * afterwards. iron-session refuses to `save()` data written back into a destroyed session (it would restore
 * the cookie `destroy()` just cleared), so the fresh session is read from the now-empty jar rather than
 * written into the destroyed object. The seal is new either way; this makes the replacement explicit.
 */
export async function startSession(
  input: { userId: UserId },
  store?: CookieStoreLike,
): Promise<Result<Session, CsError>> {
  const previous = await readSession(store)
  if (!previous.ok) return previous
  previous.value.destroy()
  const fresh = await readSession(store)
  if (!fresh.ok) return fresh
  const nowSec = Math.floor(Date.now() / 1000)
  fresh.value.userId = input.userId
  fresh.value.loginAtSec = nowSec
  fresh.value.seenAtSec = nowSec
  await fresh.value.save()
  return fresh
}

/**
 * The per-user rule for an agent run (audit §4, D-060).
 *
 * A run spends a mandate, and a mandate id in a request body is a handle to a budget — so the run belongs
 * to the signed-in buyer and to nobody else. **There is no anonymous branch any more.** D-057 allowed one
 * because the demo gate (`COUNTERSIGN_AGENT_DEMO=1` plus a non-production `NODE_ENV`) was thought to be the
 * lock on the door; it is not, because the gate is a process-wide flag rather than a per-request identity,
 * and the acceptance script's plain `fetch` was never a reason to leave a hole in the product's rule.
 *
 * The route now derives the buyer from the session and this function only compares; the `requestedUserId`
 * is what the caller claimed, and the answer is the same `403` whether it names a stranger or nothing.
 */
export function guardRunUser(
  sessionUserId: UserId | undefined,
  requestedUserId: string,
): Result<true, CsError> {
  if (sessionUserId === undefined) {
    return err(
      csError('CS_UNAUTHENTICATED', 'A buyer sign-in is required to run the agent.', undefined, {
        userMessage: 'Sign in as the buyer first.',
      }),
    )
  }
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

/**
 * The mandate-ownership rule for an agent run (D-060).
 *
 * Comparing the body's `user_id` to the cookie is not enough: the body also carries a `mandate_id`, and a
 * mandate is what holds the money. A buyer who names their own id and another buyer's mandate id would
 * pass `guardRunUser` and then spend someone else's budget, so the mandate is checked against the buyer's
 * own rows before anything is minted.
 *
 * The answer is `CS_NOT_FOUND` rather than `CS_FORBIDDEN`, deliberately: a mandate id that exists under
 * another buyer and one that never existed are the same fact to a caller who does not own it, and a
 * `403` would confirm the id is real.
 */
export async function requireOwnedMandate(
  userId: UserId,
  mandateId: string,
): Promise<Result<{ readonly id: MandateId }, CsError>> {
  const owned = await findMandatesByUser(userId as string)
  if (!owned.ok) return owned
  const match = owned.value.find((row) => row.id === mandateId)
  if (match === undefined) {
    return err(
      csError(
        'CS_NOT_FOUND',
        `No mandate ${mandateId} belongs to ${userId}.`,
        { mandate_id: mandateId },
        { userMessage: 'That mandate does not belong to this account.' },
      ),
    )
  }
  return ok({ id: match.id as MandateId })
}

/**
 * The agent id on a mandate, or the refusal that says it is not this buyer's.
 *
 * The run route mints a bearer for `agent_id` before it ever loads the mandate, so the agent has to be
 * checked against the same ownership rule rather than trusted from the body: a bearer minted for another
 * buyer's agent key is a credential for a key this buyer does not hold. The check is "does this buyer have
 * a mandate under that agent" rather than a lookup of the agent row, because `agents` has no owner column
 * the session could be compared to without a second query — the mandate is the ownership record.
 */
export async function requireOwnedAgent(
  userId: UserId,
  agentId: string,
): Promise<Result<{ readonly id: AgentId }, CsError>> {
  const owned = await findMandatesByUser(userId as string)
  if (!owned.ok) return owned
  const match = owned.value.find((row) => row.agent_id === agentId)
  if (match === undefined) {
    return err(
      csError(
        'CS_NOT_FOUND',
        `No agent ${agentId} belongs to ${userId}.`,
        { agent_id: agentId },
        { userMessage: 'That agent does not belong to this account.' },
      ),
    )
  }
  return ok({ id: match.agent_id as AgentId })
}

/** Drop the session. The cookie is cleared by iron-session; the rows are not touched. */
export async function forgetUser(store?: CookieStoreLike): Promise<Result<true, CsError>> {
  const session = await readSession(store)
  if (!session.ok) return session
  session.value.destroy()
  await session.value.save()
  return ok(true)
}
