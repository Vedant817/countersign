/**
 * `POST /api/auth/buyer-login` — the buyer sign-in, D-060.
 *
 * ## Why a second route rather than a `persona` field on the merchant one
 *
 * `/api/auth/login` is the merchant's, and the buyer half needed the same five steps (same-origin, shape,
 * rate limit, credentials, rotation) with one difference: where a successful sign-in lands. Folding the two
 * together would mean a shared route that decides the landing page from the persona it just verified — a
 * credential check whose answer depends on a database read, which is exactly the shape of bug this project
 * keeps finding. Two routes, one `authenticate`, one `startSession`, one limiter: no second auth system
 * (the constraint the supervisor set), just a second front door.
 *
 * ## What it deliberately does not do
 *
 * It does not restrict who may sign in to buyers. A merchant who posts here is authenticated normally and
 * then gets a buyer session for a merchant row; the buyer surfaces refuse that session (`requireBuyer` →
 * 403), so the persona check is on the door of each surface rather than on the door of the credential.
 * That is the safer direction: the credential check is the same for everyone, and a role is read from the
 * row on every request.
 */
import { createHash } from 'node:crypto'

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, newId, toBody } from '@countersign/core'
import { appendAudit } from '@countersign/db'

import { authenticate, startSession } from '@/lib/auth'
import { safeNextPath } from '@/lib/next-path'
import { checkLoginRateLimit, loginRateLimitKey } from '@/lib/rate-limit'
import { requireSameOrigin } from '@/lib/same-origin'

export const dynamic = 'force-dynamic'

const requestSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(1_024),
    next: z.string().max(512).optional(),
  })
  .strict()

function ipHash(address: string): string {
  return createHash('sha256').update(address).digest('hex')
}

function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded ?? request.headers.get('x-real-ip')?.trim() ?? 'unknown'
}

export async function POST(request: Request): Promise<Response> {
  const originRefusal = requireSameOrigin(request)
  if (originRefusal !== null) return NextResponse.json(toBody(originRefusal), { status: 403 })

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json(toBody(csError('CS_VALIDATION', 'A JSON body is required.')), {
      status: 400,
    })
  }
  const parsed = requestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      toBody(
        csError('CS_VALIDATION', 'The sign-in did not match the expected shape.', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      ),
      { status: 400 },
    )
  }

  const address = clientAddress(request)
  // The same bucket the merchant login uses: an attacker spraying one address across both front doors gets
  // one budget, not two.
  const verdict = checkLoginRateLimit(loginRateLimitKey(parsed.data.email, address))
  if (!verdict.allowed) {
    return NextResponse.json(
      toBody(
        csError(
          'CS_RATE_LIMITED',
          `Too many sign-in attempts from this address for ${parsed.data.email}.`,
          { retryAfterSec: verdict.retryAfterSec },
          {
            userMessage: `Too many attempts. Try again in ${Math.max(1, Math.ceil(verdict.retryAfterSec / 60))} minute(s).`,
          },
        ),
      ),
      { status: 429, headers: { 'retry-after': String(verdict.retryAfterSec) } },
    )
  }

  const signedIn = await authenticate(parsed.data.email, parsed.data.password)
  if (!signedIn.ok) {
    return NextResponse.json(toBody(signedIn.error), { status: 401 })
  }

  const session = await startSession({ userId: signedIn.value.id })
  if (!session.ok) return NextResponse.json(toBody(session.error), { status: 503 })

  await appendAudit({
    id: newId('aud'),
    chainId: signedIn.value.id,
    actor: signedIn.value.id,
    action: 'AUTH_LOGIN',
    subject: signedIn.value.id,
    ipHash: ipHash(address),
    details: { persona: signedIn.value.persona, via: 'buyer-login' },
  })

  return NextResponse.json({
    ok: true,
    user: { displayName: signedIn.value.displayName, persona: signedIn.value.persona },
    next: safeNextPath(parsed.data.next, '/agent'),
  })
}
