/**
 * `POST /api/intent/compile` — a buyer's sentence becomes a proposed spending mandate.
 *
 * The transport, not the compiler: validate the wire shape, call `compileIntent`, serialise the
 * `Result`. Every rule about what a mandate may contain lives in `packages/compiler`, and every rule
 * about which model is in use lives in `lib/llm`.
 *
 * ## Why the response is not just the constraints
 *
 * `readBack` is what the buyer actually signs — the deterministic rendering of the mandate in words,
 * pinned byte-identical across calls (D-008). Returning only the machine constraints would push the
 * UI into inventing prose about them, and the sentence a person approves is the artefact that has to
 * be stable. The ambiguities travel with it because "this is not ready to sign" is a sanctioned
 * outcome, not an error: §8.8 says an intent with no amount cap MUST produce a question rather than a
 * guess.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { csError, toBody, type UserId } from '@countersign/core'
import { readBack } from '@countersign/compiler'

import { compileIntent } from '@/lib/intent-compiler'
import { merchantIdentity } from '@/lib/merchant'

const MAX_INTENT_CHARS = 2_000

const requestSchema = z
  .object({
    intent: z.string().min(1).max(MAX_INTENT_CHARS),
    locale: z.enum(['en-IN', 'en-US']).optional(),
    user_id: z.string().min(1).max(128).optional(),
  })
  .strict()

/** The status a `CsError` code deserves. Anything unmapped is a 500, never a success. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  CS_VALIDATION: 400,
  CS_NOT_FOUND: 404,
  CS_CONFLICT: 409,
  CS_FORBIDDEN: 403,
  CS_UNAUTHENTICATED: 401,
  CS_RATE_LIMITED: 429,
  // The model is a dependency, not the product: unreachable is 503, and EC-LLM-1's fallback is the
  // manual form rather than a retry storm on the consent screen.
  LLM_UNAVAILABLE: 503,
  LLM_SCHEMA: 502,
  CS_INTERNAL: 500,
}

export async function POST(request: Request): Promise<Response> {
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
      return {
        path: path !== '' ? path : issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : '',
        message: issue.message,
      }
    })
    return NextResponse.json(
      toBody(csError('CS_VALIDATION', 'The intent did not match the expected shape.', { issues })),
      { status: 400 },
    )
  }

  // The demo has no buyer session yet, so an anonymous caller is identified as such rather than
  // refused: `compile` records whose intent this is, and inventing a real user id would be worse than
  // naming the absence.
  const userId = (parsed.data.user_id ?? 'usr_local_visitor') as UserId

  const compiled = await compileIntent({
    userId,
    text: parsed.data.intent,
    ...(parsed.data.locale === undefined ? {} : { locale: parsed.data.locale }),
  })

  if (!compiled.ok) {
    return NextResponse.json(toBody(compiled.error), {
      status: STATUS_BY_CODE[compiled.error.code] ?? 500,
    })
  }

  const mandate = compiled.value
  const merchant = merchantIdentity()
  const readBackText = readBack(mandate, {
    // Merchant id → display name. Supplied here rather than reached for inside `readBack`, so the
    // read-back stays pure and a test can pin its output byte for byte.
    merchants: merchant.ok ? { [merchant.value.id]: merchant.value.name } : {},
    tz: 'Asia/Kolkata',
  })

  return NextResponse.json(
    {
      currency: mandate.currency,
      ttl_seconds: mandate.ttlSeconds,
      constraints: mandate.constraints,
      // The sentence the buyer approves. Deterministic, so a UI can diff two runs and see nothing.
      read_back: readBackText,
      assumptions: mandate.assumptions,
      // Non-empty means "not ready to sign yet". §8.8: question, never guess.
      ambiguities: mandate.ambiguities,
    },
    { status: 200 },
  )
}
