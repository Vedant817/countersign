import 'server-only'

import { csError, err, ok, type CsError, type Result } from '@countersign/core'
import { getMerchantByOwner } from '@countersign/db'

import type { SignedInUser } from './auth'

/**
 * Resolve the merchant row identifier for a signed-in merchant user.
 *
 * Spec §7.2 / D-059: Every merchant action operates on rows scoped to a merchant profile (`mer_...`),
 * not a user account (`usr_...`). This maps the user session to their merchant row.
 */
export async function merchantIdFor(user: SignedInUser): Promise<Result<string, CsError>> {
  const result = await getMerchantByOwner(user.id)
  if (!result.ok) {
    return result
  }
  if (!result.value) {
    return err(
      csError('CS_FORBIDDEN', `Merchant user ${user.id} has no merchants row.`, undefined, {
        userMessage: 'This account has no merchant profile yet.',
      }),
    )
  }
  return ok(result.value.id)
}
