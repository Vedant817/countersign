import 'server-only'

/**
 * Who this request is, and whether they may act as the merchant — D-059.
 *
 * ## Why this is a second file beside `session.ts`
 *
 * `session.ts` owns the cookie: what is in it, how long it lives, how it is sealed. This file owns the
 * *decision*: read the cookie, re-read the row it names, and answer one of three things — a real user, an
 * anonymous request, or a refusal. Keeping the two apart is what lets a route test mock the decision without
 * minting a cookie, and a page test render the refusal without a database.
 *
 * ## The two properties that make it a guard and not a lookup
 *
 * 1. **Authority is never read from the cookie.** The cookie names a `users.id`; the persona, the email and
 *    the display name are read from the row on this request. Revoking a row takes effect immediately, and a
 *    cookie whose persona was edited cannot keep the old role until it expires.
 * 2. **A cookie is not a sign-in unless it carries a `loginAtSec`.** A pre-D-059 cookie, a forged one, or a
 *    session minted by a future non-password flow has no anchor, so it is treated as anonymous. Failing
 *    closed here costs a re-login; failing open would be a role the server never granted.
 *
 * ## What "the merchant" means in a one-merchant deployment
 *
 * `orders` has no `merchant_id` column, and the whole deployment signs as one merchant
 * (`MERCHANT_ID`). So "scoped to its own disputes" is currently expressed as "the row whose persona is
 * MERCHANT". A second merchant needs a schema column (`orders.merchant_id`) before this check can be more
 * precise; `docs/DECISIONS.md` records that as the boundary rather than pretending the check is per-merchant.
 */
import { csError, err, ok, type CsError, type Result, type UserId } from '@countersign/core'
import {
  burnPasswordCheck,
  findUserByEmail,
  findUserById,
  verifyPassword,
  type UserRow,
} from '@countersign/db'

import { SESSION_MAX_AGE_SECONDS, readSession, type CookieStoreLike } from './session'

/** The persona label that may read and decide disputes. */
export const MERCHANT_PERSONA = 'MERCHANT'

/** What the app knows about a signed-in person, after the row has been read. */
export interface SignedInUser {
  readonly id: UserId
  readonly persona: string
  readonly displayName: string
  readonly email: string
}

function toSignedIn(row: UserRow): SignedInUser {
  return {
    id: row.id as UserId,
    persona: row.persona,
    displayName: row.display_name,
    email: row.email,
  }
}

/**
 * The person this request acts as, or `undefined` when it is anonymous.
 *
 * An expired session is **ignored** here rather than deleted: a Server Component's cookie store is
 * read-only, so clearing it during render would throw `cookies().set` on the page the merchant is trying
 * to read. The stale cookie is harmless — every check is against `loginAtSec` — and the next successful
 * sign-in rotates it away (`startSession`). Logout and login are route handlers, where writing the cookie
 * is allowed.
 */
export async function currentUser(
  store?: CookieStoreLike,
): Promise<Result<SignedInUser | undefined, CsError>> {
  const session = await readSession(store)
  if (!session.ok) return session

  const id = session.value.userId
  if (typeof id !== 'string' || id.length === 0) return ok(undefined)

  const loginAtSec = session.value.loginAtSec
  const nowSec = Math.floor(Date.now() / 1000)
  if (typeof loginAtSec !== 'number' || nowSec - loginAtSec > SESSION_MAX_AGE_SECONDS) {
    return ok(undefined)
  }

  const row = await findUserById(id as UserId)
  if (!row.ok) return row
  if (row.value === undefined) {
    // The cookie names an account that no longer exists. A pointer to nothing is not permission.
    return ok(undefined)
  }
  return ok(toSignedIn(row.value))
}

const GENERIC_LOGIN_REFUSAL =
  'Email or password is incorrect. No account is named, so nothing about who tried is revealed.'

/**
 * Check an email and password. Answers the same refusal for every failure.
 *
 * The three failures — no such account, an account with no password, a wrong password — are one answer on
 * purpose: a login form that says "no account with that email" is a directory of the deployment's users.
 * The no-account branch still spends a scrypt verification (`burnPasswordCheck`), so it does not answer
 * faster than a wrong password and become an oracle by timing.
 */
export async function authenticate(
  email: string,
  password: string,
): Promise<Result<SignedInUser, CsError>> {
  const normalized = email.trim().toLowerCase()
  const found = await findUserByEmail(normalized)
  if (!found.ok) return found

  const row = found.value
  if (row === undefined || row.password_hash === null) {
    await burnPasswordCheck(password)
    return err(unauthenticated(GENERIC_LOGIN_REFUSAL))
  }

  const matches = await verifyPassword(password, row.password_hash)
  if (!matches) return err(unauthenticated(GENERIC_LOGIN_REFUSAL))
  return ok(toSignedIn(row))
}

/**
 * The merchant-or-refusal decision for a route handler.
 *
 * `401` and `403` are different answers to different questions: "we do not know you" and "we know you, and
 * you may not". A buyer hitting `/api/disputes/...` gets the second, which is the distinction the acceptance
 * test for this item asks for.
 */
export async function requireMerchant(
  store?: CookieStoreLike,
): Promise<Result<SignedInUser, CsError>> {
  const user = await currentUser(store)
  if (!user.ok) return user
  if (user.value === undefined) {
    return err(
      unauthenticated(
        'A merchant sign-in is required for this route.',
        'Sign in as the merchant first.',
      ),
    )
  }
  if (user.value.persona !== MERCHANT_PERSONA) {
    return err(
      csError(
        'CS_FORBIDDEN',
        `The signed-in account is a ${user.value.persona}, and disputes belong to the merchant.`,
        undefined,
        { userMessage: 'This page is for the merchant account.' },
      ),
    )
  }
  return ok(user.value)
}

function unauthenticated(message: string, userMessage?: string): CsError {
  return csError('CS_UNAUTHENTICATED', message, undefined, {
    ...(userMessage === undefined ? {} : { userMessage }),
  })
}

/** Re-exported so a route can start a rotated session without importing two modules. */
export { startSession } from './session'
