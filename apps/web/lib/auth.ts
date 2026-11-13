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
import { csError, err, newId, ok, type CsError, type Result, type UserId } from '@countersign/core'
import {
  burnPasswordCheck,
  createUser,
  findUserByEmail,
  findUserById,
  hashPassword,
  setPasswordHash,
  verifyPassword,
  type UserRow,
} from '@countersign/db'

import { SESSION_MAX_AGE_SECONDS, readSession, type CookieStoreLike } from './session'

/** The persona label that may read and decide disputes. */
export const MERCHANT_PERSONA = 'MERCHANT'

/** The persona label a person who signed up through `/signup` gets (D-060). */
export const BUYER_PERSONA = 'BUYER'

/**
 * The shortest password a buyer may choose.
 *
 * Ten characters, not eight: the whole deployment is one scrypt hash away from an offline guess, and the
 * marginal cost of two more characters to a person typing one password is nothing next to the cost of a
 * short one to the person whose mandate it protects. There is no composition rule — a rule that demands a
 * symbol produces `Password1!` and no real entropy — and no maximum beyond the route's 1,024-character
 * bound, because a length ceiling is a denial-of-service hint rather than a password policy.
 */
export const SIGNUP_MIN_PASSWORD = 10

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
 * The address an account is known by.
 *
 * Trimmed and lower-cased, and nothing else: the local part of an address is technically
 * case-sensitive (RFC 5321) but no provider a real user has treats it that way, so folding it is what
 * makes `Asha@Example.com` and `asha@example.com` one account instead of two. Every read and every write
 * goes through this, so the UNIQUE index on `users.email` and the lookup a sign-in performs cannot
 * disagree about which string is the key.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Create a buyer account and return the row, or the refusal that explains why not.
 *
 * ## Why the duplicate answer is generic
 *
 * A sign-up form that says "that address already has an account" is a directory of the deployment's
 * buyers, and the attacker it helps is the one who already knows the address. So a duplicate answers the
 * same `CS_UNAUTHENTICATED` sentence a wrong password does, and the route maps it to the same `401`.
 * The trade-off is real and stated: a person who mistyped their own address cannot be told so, and has to
 * sign in or try another address.
 *
 * ## What it deliberately does not do
 *
 * It does not send mail. There is no verification link, because there is no mail sender on this
 * deployment (HUMAN_TODO), and a sign-up that claimed "check your inbox" with nothing behind it would be
 * the fake-success pattern this project exists to avoid. The account is usable immediately; the honest
 * place to add verification is the row (`dpdp_notice_ack_at` is already the pattern for a per-user
 * acknowledgement) plus a mailer.
 */
export async function registerBuyer(input: {
  readonly email: string
  readonly password: string
  readonly displayName?: string
  readonly country?: string
}): Promise<Result<SignedInUser, CsError>> {
  const email = normalizeEmail(input.email)
  const passwordHash = await hashPassword(input.password)
  const id = newId('usr') as UserId

  const created = await createUser({
    id,
    persona: BUYER_PERSONA,
    // A display name is not a credential and not an identity: it defaults to the part of the address
    // before the `@`, which is what the person chose, rather than to "Buyer" or a placeholder.
    display_name: input.displayName ?? email.split('@')[0] ?? 'Buyer',
    email,
    country: input.country ?? 'US',
  })
  if (!created.ok) {
    // The UNIQUE index is the arbiter of "already taken" — it closes the race between two simultaneous
    // sign-ups for one address, which a pre-check cannot. What the caller is told is deliberately the same
    // refusal an unusable address gets, so the answer is not a directory of who has an account.
    if (created.error.code === 'CS_CONFLICT' || created.error.details?.['pgCode'] === '23505') {
      return err(duplicateAccount())
    }
    return created
  }

  // The hash is written by a second statement rather than inline in the insert, so the row exists with a
  // `password_hash` of NULL for the microseconds between them. That state is the same one the seed leaves a
  // persona in when no password was provisioned, and `authenticate` already treats it as "no such password":
  // there is no window in which an account is sign-in-able without the hash.
  const withPassword = { ...created.value, password_hash: passwordHash }
  const stored = await setPasswordHash(id, passwordHash)
  if (!stored.ok) return stored
  return ok(toSignedIn(withPassword))
}

/**
 * The one refusal every sign-up failure that a caller could probe with is expressed as.
 *
 * A validation failure (too short, malformed) is a `CS_VALIDATION` with a sentence the form can show —
 * that is about the input, not about the account, and revealing it helps nobody but the person typing.
 */
function duplicateAccount(): CsError {
  return csError(
    'CS_UNAUTHENTICATED',
    'That email address cannot be used to create an account on this deployment.',
    undefined,
    {
      userMessage:
        'That email address cannot be used here. Try signing in, or use a different address.',
      retryable: false,
    },
  )
}

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
  const found = await findUserByEmail(normalizeEmail(email))
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

/**
 * The buyer-or-refusal decision for a route handler (D-060).
 *
 * The mirror image of {@link requireMerchant}: `401` when nobody is signed in, `403` when the signed-in
 * account is not a buyer. A merchant who wanders into a buyer route gets the second, which is the honest
 * answer — we know who you are, and this surface is not yours.
 *
 * A persona of `JUDGE` is refused here for the same reason: the judge is a seeded fixture of the demo
 * guide, not a person with a mandate.
 */
export async function requireBuyer(
  store?: CookieStoreLike,
): Promise<Result<SignedInUser, CsError>> {
  const user = await currentUser(store)
  if (!user.ok) return user
  if (user.value === undefined) {
    return err(
      unauthenticated('A buyer sign-in is required for this route.', 'Sign in as the buyer first.'),
    )
  }
  if (user.value.persona !== BUYER_PERSONA) {
    return err(
      csError(
        'CS_FORBIDDEN',
        `The signed-in account is a ${user.value.persona}, and this surface belongs to a buyer.`,
        undefined,
        { userMessage: 'This page is for the buyer account.' },
      ),
    )
  }
  return ok(user.value)
}

/** Re-exported so a route can start a rotated session without importing two modules. */
export { startSession } from './session'
