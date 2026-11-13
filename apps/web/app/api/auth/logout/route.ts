/**
 * `POST /api/auth/logout` — end the sign-in, D-059.
 *
 * ## Why `POST` and not a `GET` link
 *
 * A logout that a third-party page can trigger with `<img src="/api/auth/logout">` is a logout an attacker
 * can force on a merchant mid-dispute. `POST` + same-origin is the same shape as the decision route: the
 * browser has to be on our origin, and the cookie's `sameSite: 'lax'` already refuses to attach it
 * cross-site. The page therefore uses a small client component that posts and then navigates.
 *
 * ## What it does and does not guarantee
 *
 * The cookie is cleared by `forgetUser` (iron-session writes an expired cookie). The audit row records who
 * signed out, when, and from which hashed address. There is no server-side session table to revoke — the
 * cookie is the session — so the honest limit is that a copy of the cookie taken before logout is still a
 * valid seal until its own expiry. That is why the absolute lifetime in `session.ts` is twelve hours rather
 * than seven days.
 */
import { createHash } from 'node:crypto'

import { NextResponse } from 'next/server'

import { newId, toBody } from '@countersign/core'
import { appendAudit } from '@countersign/db'

import { requireSameOrigin } from '@/lib/same-origin'
import { currentUserId, forgetUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded ?? request.headers.get('x-real-ip')?.trim() ?? 'unknown'
}

export async function POST(request: Request): Promise<Response> {
  const originRefusal = requireSameOrigin(request)
  if (originRefusal !== null) {
    return NextResponse.json(toBody(originRefusal), { status: 403 })
  }

  const session = await currentUserId()
  const userId = session.ok ? session.value : undefined
  await forgetUser()

  if (userId !== undefined) {
    const address = clientAddress(request)
    await appendAudit({
      id: newId('aud'),
      chainId: userId,
      actor: userId,
      action: 'AUTH_LOGOUT',
      subject: userId,
      ipHash: createHash('sha256').update(address).digest('hex'),
      details: null,
    })
  }

  return NextResponse.json({ ok: true }, { status: 200 })
}
