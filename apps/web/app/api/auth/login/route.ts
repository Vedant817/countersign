/**
 * `POST /api/auth/login` — the merchant sign-in, D-059.
 *
 * ## Why a route handler and not a Server Action
 *
 * The same three reasons `/api/disputes/{id}/decision` gives: a login is a request an operator can replay
 * with `curl`, its refusal has to be a real status code, and its response is data the form acts on rather
 * than markup. It also keeps the whole flow testable without a React runtime — the acceptance test drives
 * it with `fetch`, which is how a browser does.
 *
 * ## The order the guards run in
 *
 * 1. **Same-origin.** A cross-site `POST` is refused before a password is read. The cookie is `sameSite:
 *    'lax'`; this is the second lock on the same door (`lib/same-origin.ts`).
 * 2. **Shape.** A body that is not the expected object is a `400`, never a partially-read credential.
 * 3. **Rate limit.** Counted before `authenticate`, because the point is to stop the *attempt*, not the
 *    successful answer.
 * 4. **Credentials.** `authenticate` answers one generic refusal for every failure, and spends a scrypt
 *    check even when the account does not exist.
 * 5. **Session rotation.** `startSession` destroys any cookie the browser already held and writes a fresh
 *    one, so a sign-in cannot inherit a pre-auth session.
 *
 * ## What it deliberately does not do
 *
 * It does not reveal whether an email exists, does not distinguish a missing password from a wrong one, and
 * does not lock an account permanently: the limit is per (email, address) and resets after 15 minutes, so a
 * merchant who mistypes five times is not locked out of their own deployment for the rest of the day.
 */
import { createHash } from 'node:crypto'

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, newId, toBody } from '@countersign/core'
import { appendAudit } from '@countersign/db'

import { authenticate, startSession } from '@/lib/auth'
import { safeNextPath } from '@/lib/next-path'
import { checkLoginRateLimit, loginRateLimitKey, type RateLimitVerdict } from '@/lib/rate-limit'
import { requireSameOrigin } from '@/lib/same-origin'

export const dynamic = 'force-dynamic'

const requestSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(1_024),
    next: z.string().max(512).optional(),
  })
  .strict()

/** `createHash` here is a receipt, not a secret: the audit log stores a digest of the address (EC-PRIV-3). */
function ipHash(address: string): string {
  return createHash('sha256').update(address).digest('hex')
}

/** The address the proxy chain names, or `unknown`. Never logged in the clear. */
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
  const limitKey = loginRateLimitKey(parsed.data.email, address)
  let verdict: RateLimitVerdict
  try {
    verdict = await checkLoginRateLimit(limitKey)
  } catch {
    console.error('Login rate limit check failed; failing closed.')
    return NextResponse.json(
      { error: 'Sign-in is temporarily unavailable. Try again shortly.' },
      { status: 503 },
    )
  }
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
    // The generic refusal is already `CS_UNAUTHENTICATED`; a wrong password and an unknown email must be
    // the same status and the same sentence.
    return NextResponse.json(toBody(signedIn.error), { status: 401 })
  }

  const session = await startSession({ userId: signedIn.value.id })
  if (!session.ok) return NextResponse.json(toBody(session.error), { status: 503 })

  // A login is an audit event. A failure to write it is not a reason to refuse the merchant: the session
  // is already rotated, and the honest alternative (a login that depends on a logging table) is worse.
  await appendAudit({
    id: newId('aud'),
    chainId: signedIn.value.id,
    actor: signedIn.value.id,
    action: 'AUTH_LOGIN',
    subject: signedIn.value.id,
    ipHash: ipHash(address),
    details: { persona: signedIn.value.persona },
  })

  return NextResponse.json({
    ok: true,
    user: { displayName: signedIn.value.displayName, persona: signedIn.value.persona },
    next: safeNextPath(parsed.data.next),
  })
}
