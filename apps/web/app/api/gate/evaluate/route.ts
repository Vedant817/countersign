/**
 * `POST /api/gate/evaluate` — spec §9's `api/gate/evaluate`, and the Gate's first call site in an app.
 *
 * ## What this route is for
 *
 * It answers one question: *may this purchase proceed?* The merchant's server asks it with a signed
 * L3 chain, and gets back the twelve checks, the outcome and the reasons. Nothing here decides
 * anything — the Gate does, deterministically, from the persisted world — which is the entire point of
 * I-1. This file is transport: validate the wire shape, build the deps, call `evaluate`, serialise.
 *
 * ## What it deliberately does not do
 *
 * It does not create an order and it does not call PayPal. An `ALLOW` here is a **permission**, not a
 * transaction; §8.11's order creation is the orchestrator's, and it needs the PayPal client this
 * deployment does not have. Returning a decision and stopping is the honest boundary — the alternative
 * is a route that implies a purchase happened, which is the claim D-046 and D-048 exist to prevent.
 *
 * ## Refusals
 *
 * A missing `VI_SERVICE_URL`, `VI_SERVICE_TOKEN` or `GATE_SIGNING_KEY` is a **503 with a sentence**,
 * not a 500. Check 4 with no verifier is not a Gate, and an unsigned decision record is exactly the
 * fabrication D-039 forbids, so there is no degraded mode to fall into — but a judge running this
 * locally should be told which variable to set, not handed a stack trace (D-053).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import {
  csError,
  toBody,
  type AgentId,
  type AttemptId,
  type CheckoutId,
  type MandateId,
} from '@countersign/core'
import { evaluate } from '@countersign/gate'
import { orchestratorStoreFromRepos } from '@countersign/orchestrator'

import { gateRuntime } from '@/lib/gate-runtime'

/** Bounds are §8.0 rule "bound every wire input": an unbounded chain is a memory-exhaustion vector. */
const MAX_TOKEN_CHARS = 64 * 1024
const MAX_ID_CHARS = 128

const requestSchema = z
  .object({
    attempt_id: z.string().min(1).max(MAX_ID_CHARS),
    mandate_id: z.string().min(1).max(MAX_ID_CHARS),
    checkout_id: z.string().min(1).max(MAX_ID_CHARS),
    agent_id: z.string().min(1).max(MAX_ID_CHARS),
    l3a: z.string().min(1).max(MAX_TOKEN_CHARS),
    l3b: z.string().min(1).max(MAX_TOKEN_CHARS),
  })
  // `.strict()` so a typo'd field is a 400 rather than a silently-ignored one. A caller that sends
  // `mandateId` instead of `mandate_id` must not get a decision about a different field's default.
  .strict()

/** The status a `CsError` code deserves as HTTP. Anything unmapped is a 500, never a success. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  CS_VALIDATION: 400,
  CS_NOT_FOUND: 404,
  CS_CONFLICT: 409,
  CS_FORBIDDEN: 403,
  CS_UNAUTHENTICATED: 401,
  CS_RATE_LIMITED: 429,
  CS_INTERNAL: 503,
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
        // `unrecognized_keys` carries an empty `path` and names the offending keys instead, so a
        // caller that sent `mandateId` is told *which* field was wrong rather than being handed `""`.
        path: path !== '' ? path : issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : '',
        message: issue.message,
      }
    })
    return NextResponse.json(
      toBody(
        csError('CS_VALIDATION', 'The evaluation request did not match the expected shape.', {
          issues,
        }),
      ),
      { status: 400 },
    )
  }

  const runtime = await gateRuntime()
  if (!runtime.ok) {
    return NextResponse.json(toBody(runtime.error), {
      status: STATUS_BY_CODE[runtime.error.code] ?? 500,
    })
  }

  const body = parsed.data
  const decision = await evaluate(
    {
      attemptId: body.attempt_id as AttemptId,
      mandateId: body.mandate_id as MandateId,
      checkoutId: body.checkout_id as CheckoutId,
      agentId: body.agent_id as AgentId,
      l3a: body.l3a,
      l3b: body.l3b,
    },
    runtime.value,
  )

  if (!decision.ok) {
    return NextResponse.json(toBody(decision.error), {
      status: STATUS_BY_CODE[decision.error.code] ?? 500,
    })
  }

  const value = decision.value

  /**
   * Persist the decision, linked to its attempt, atomically.
   *
   * An evaluation that is not recorded is a **permission nobody can audit** — the whole claim of the
   * project is that an `ALLOW` is provable afterwards, and a decision that exists only in a response
   * body cannot be. `orchestratorStoreFromRepos().decide` is the writer that already exists for this;
   * re-implementing the insert here would be a second source of truth for what a decision row means.
   *
   * `ok(undefined)` means **nothing was written** because the attempt row does not exist. That is not
   * an error to swallow: an `ALLOW` with no attempt is a permission that will fail closed one step
   * later, and the caller is told rather than left to discover it. `recorded` makes the difference
   * visible in the response instead of inferred from the status code.
   */
  const recorded = await orchestratorStoreFromRepos().decide({
    decision: value,
    attemptId: body.attempt_id as AttemptId,
    at: new Date(),
  })
  if (!recorded.ok) {
    return NextResponse.json(toBody(recorded.error), {
      status: STATUS_BY_CODE[recorded.error.code] ?? 500,
    })
  }

  return NextResponse.json(
    {
      decision_id: value.id,
      outcome: value.decision,
      reasons: value.reasons,
      // All twelve, in order, with `notApplicable` preserved: reporting a not-applicable check as
      // `passed` would claim an enforcement that did not happen (D19's failure mode).
      checks: value.checks,
      /**
       * Whether the decision reached `gate_decisions`. `false` means the attempt id is unknown to this
       * deployment, so the decision was **not** persisted — an `ALLOW` in that state cannot become an
       * order, and saying so here is cheaper than letting the caller find out at order creation.
       */
      recorded: recorded.value !== undefined,
    },
    // A `BLOCK` is a successful evaluation, so it is a 200 with an outcome — not a 4xx. A caller that
    // branched on the status would treat "we checked and refused" the same as "we could not check",
    // and those are different answers.
    { status: 200 },
  )
}
