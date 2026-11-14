/**
 * `POST /api/auth/merchant-signup` — create a merchant account.
 *
 * ## The same shape as the buyer signup route
 *
 * Same-origin, then shape, then rate limit, then credentials, then session rotation — the order
 * `/api/auth/signup` uses and for the same reasons. A merchant sign-up is a credential operation:
 * it takes a password, it is a spam target, and it writes the row every later login depends on.
 *
 * ## The two refusals, and why they are indistinguishable
 *
 * A duplicate address and an unusable one both answer `401` with the same sentence. Telling them apart
 * would turn the form into a directory of the deployment's accounts.
 */
import { createHash } from 'node:crypto'

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, newId, toBody, type CsError } from '@countersign/core'
import { appendAudit } from '@countersign/db'

import { normalizeEmail, registerMerchant, SIGNUP_MIN_PASSWORD, startSession } from '@/lib/auth'
import { safeNextPath } from '@/lib/next-path'
import { checkLoginRateLimit, loginRateLimitKey, type RateLimitVerdict } from '@/lib/rate-limit'
import { requireSameOrigin } from '@/lib/same-origin'

export const dynamic = 'force-dynamic'

const requestSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(1_024),
    businessName: z.string().trim().min(2).max(120),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
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

/** The domain only, so the audit log records where an address claims to be from without storing it. */
function emailDomain(email: string): string {
  return email.split('@')[1] ?? ''
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

  if (parsed.data.password.length < SIGNUP_MIN_PASSWORD) {
    return NextResponse.json(
      toBody(validation([`password: use at least ${SIGNUP_MIN_PASSWORD} characters`])),
      { status: 400 },
    )
  }

  const address = clientAddress(request)
  const limitKey = `merchant-signup:${loginRateLimitKey(parsed.data.email, address)}`

  let verdict: RateLimitVerdict
  try {
    verdict = await checkLoginRateLimit(limitKey)
  } catch {
    console.error('Merchant sign-up rate limit check failed; failing closed.')
    return NextResponse.json(
      toBody(
        csError(
          'CS_INTERNAL',
          'Sign-in is temporarily unavailable. Try again shortly.',
          undefined,
          { userMessage: 'Sign-in is temporarily unavailable. Try again shortly.' },
        ),
      ),
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

  const created = await registerMerchant({
    email: parsed.data.email,
    password: parsed.data.password,
    businessName: parsed.data.businessName,
    ...(parsed.data.country === undefined ? {} : { country: parsed.data.country }),
  })
  if (!created.ok) {
    return NextResponse.json(toBody(created.error), {
      status: created.error.code === 'CS_UNAUTHENTICATED' ? 401 : 400,
    })
  }

  const session = await startSession({ userId: created.value.user.id })
  if (!session.ok) return NextResponse.json(toBody(session.error), { status: 503 })

  await appendAudit({
    id: newId('aud'),
    chainId: created.value.user.id,
    actor: created.value.user.id,
    action: 'merchant.signup',
    subject: created.value.merchantId,
    ipHash: ipHash(address),
    details: {
      merchant_id: created.value.merchantId,
      persona: created.value.user.persona,
      business_name: parsed.data.businessName,
      email_domain: emailDomain(normalizeEmail(parsed.data.email)),
    },
  })

  return NextResponse.json(
    {
      ok: true,
      merchantId: created.value.merchantId,
      next: safeNextPath(parsed.data.next, '/disputes'),
    },
    { status: 201 },
  )
}
