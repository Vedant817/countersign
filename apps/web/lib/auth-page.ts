import 'server-only'

/**
 * The page-level auth guard — D-059.
 *
 * It lives beside `lib/auth.ts` rather than inside it so the decision logic (which route handlers and
 * tests import) stays free of `next/navigation`: `redirect` and `forbidden` work by throwing Next's own
 * control-flow errors, and a unit test that only wants `authenticate` should not have to know that.
 */
import { forbidden, redirect } from 'next/navigation'

import { currentUser, MERCHANT_PERSONA, type SignedInUser } from './auth'
import { safeNextPath } from './next-path'

/**
 * The page guard: anonymous goes to the login page, the wrong role gets Next's 403.
 *
 * `redirect` and `forbidden` throw (`NEXT_REDIRECT` / `NEXT_HTTP_ERROR_FALLBACK;403`), which is why the
 * return type is `Promise<SignedInUser>` and callers do not check a result: control does not continue past
 * a refusal. Both run on the render path only.
 */
export async function requireMerchantPage(returnTo: string): Promise<SignedInUser> {
  const user = await currentUser()
  if (!user.ok) {
    // A misconfigured signing secret is a deployment fault, not a login problem; rendering the login page
    // would invite the merchant to retry something a retry cannot fix.
    throw new Error(`the session could not be read: ${user.error.code} ${user.error.message}`)
  }
  if (user.value === undefined)
    redirect(`/login?next=${encodeURIComponent(safeNextPath(returnTo))}`)
  if (user.value.persona !== MERCHANT_PERSONA) forbidden()
  return user.value
}
