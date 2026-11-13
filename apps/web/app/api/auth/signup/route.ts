/**
 * `POST /api/auth/signup` — create a buyer account, D-060.
 *
 * ## The same shape as the login route, on purpose
 *
 * Same-origin, then shape, then rate limit, then credentials, then session rotation — the order
 * `/api/auth/login` uses and for the same reasons. A sign-up is a credential operation: it takes a
 * password, it is a spam target, and it writes the row every later login depends on.
 *
 * ## The two refusals, and why they are indistinguishable
 *
 * A duplicate address and an unusable one both answer `401` with the same sentence. Telling them apart
 * would turn the form into a directory of the deployment's accounts ("is `asha@…` registered?"), which is
 * the same leak the login route's single generic refusal exists to prevent. The cost is stated rather than
 * hidden: a person who mistyped their own address is not told so, and has to sign in or try another one.
 *
 * ## What it does not do
 *
 * No mail, no verification link: there is no mail sender on this deployment (HUMAN_TODO), and a form that
 * promised "check your inbox" with nothing behind it would be a fake success. The account works as soon as
 * it exists, and the sign-in is the next request.
 */
import { createHash } from 'node:crypto'

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, newId, toBody, type CsError } from '@countersign/core'
import { appendAudit } from '@countersign/db'

import { normalizeEmail, registerBuyer, SIGNUP_MIN_PASSWORD, startSession } from '@/lib/auth'
import { safeNextPath } from '@/lib/next-path'
import { checkLoginRateLimit, loginRateLimitKey, type RateLimitVerdict } from '@/lib/rate-limit'
import { requireSameOrigin } from '@/lib/same-origin'

export const dynamic = 'force-dynamic'

const requestSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(1_024),
    displayName: z.string().trim().max(120).optional(),
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

/**
 * A `400` for the input the person controls, as a `CsError`.
 *
 * The password rule is the only one worth naming back: "at least 10 characters" is a sentence a form can
 * put under the field, and a generic "invalid" would leave someone guessing which field was wrong.
 */
function validation(issues: readonly string[]): CsError {
  return csError(
    'CS_VALIDATION',
    'The sign-up did not match the expected shape.',
    { issues },
    {
      userMessage: issues[0] ?? 'Check the form and try again.',
    },
  )
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
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.')
      return path !== '' ? `${path}: ${issue.message}` : issue.message
    })
    return NextResponse.json(toBody(validation(issues)), { status: 400 })
  }

  // The password floor is checked here rather than left to the hash, because hashing a two-character
  // password is work spent on an answer the route could give without it — and because the message a person
  // needs is "ten characters", not a scrypt result.
  if (parsed.data.password.length < SIGNUP_MIN_PASSWORD) {
    return NextResponse.json(
      toBody(validation([`password: use at least ${SIGNUP_MIN_PASSWORD} characters`])),
      { status: 400 },
    )
  }

  const address = clientAddress(request)
  // The same bucket as a login attempt: a sign-up is a credential operation too, and an unthrottled one is
  // a way to fill `users` with rows and to spend scrypt on someone else's CPU.
  let verdict: RateLimitVerdict
  try {
    verdict = await checkLoginRateLimit(loginRateLimitKey(parsed.data.email, address))
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
          'Too many attempts from this address. Try again later.',
          { retryAfterSec: verdict.retryAfterSec },
          {
            userMessage: `Too many attempts. Try again in ${Math.max(1, Math.ceil(verdict.retryAfterSec / 60))} minute(s).`,
          },
        ),
      ),
      { status: 429, headers: { 'retry-after': String(verdict.retryAfterSec) } },
    )
  }

  const created = await registerBuyer({
    email: parsed.data.email,
    password: parsed.data.password,
    ...(parsed.data.displayName === undefined ? {} : { displayName: parsed.data.displayName }),
  })
  if (!created.ok) {
    // A duplicate is the same answer as an unusable address, and `401` is the same status the login route
    // uses for "we will not tell you whether that account exists". A `CS_VALIDATION` (bad shape, short
    // password) stays a `400`: that is about the input, not about who has an account.
    return NextResponse.json(toBody(created.error), {
      status: created.error.code === 'CS_UNAUTHENTICATED' ? 401 : 400,
    })
  }

  // A sign-up is a sign-in: the person is here, with the password they just chose, so making them type it
  // again is ceremony with no security value. `startSession` rotates rather than reuses whatever cookie the
  // browser arrived with, exactly as the login route does.
  const session = await startSession({ userId: created.value.id })
  if (!session.ok) return NextResponse.json(toBody(session.error), { status: 503 })

  await appendAudit({
    id: newId('aud'),
    chainId: created.value.id,
    actor: created.value.id,
    action: 'AUTH_SIGNUP',
    subject: created.value.id,
    ipHash: ipHash(address),
    // The address is not in the audit row: the digest above is the record, and `users.email` is the row it
    // points at (EC-PRIV-3).
    details: {
      persona: created.value.persona,
      email_domain: emailDomain(normalizeEmail(parsed.data.email)),
    },
  })

  return NextResponse.json({
    ok: true,
    user: { displayName: created.value.displayName, persona: created.value.persona },
    // The buyer's landing page, not the merchant queue: the default in `safeNextPath` is `/disputes` because
    // that is what the merchant login means, and a buyer who signed up from `/signup` asked for `/agent`.
    next: safeNextPath(parsed.data.next, '/agent'),
  })
}

/** The domain only, so the audit log records where an address claims to be from without storing it. */
function emailDomain(email: string): string {
  return email.split('@')[1] ?? ''
}
