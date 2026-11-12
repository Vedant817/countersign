/**
 * `POST /api/agent/run` — S-10's agent run, streamed as Server-Sent Events.
 *
 * One request per buyer turn. It mints a short-lived `agt_` bearer, opens an MCP client against **our own
 * merchant MCP** (§8.13: the agent uses only the merchant MCP for commerce operations), builds the two
 * ports the agent package asks for, and streams `ShopEvent`s as they happen.
 *
 * ## Why SSE and not a JSON array
 *
 * The whole point of S-10 is that a viewer *watches* the agent work: the tool calls, the flagged listing,
 * the Gate's verdict. A response assembled at the end would make the demo a screenshot. Each event is one
 * `data:` frame carrying the same object `runShoppingAgent` yielded, so the client is a `for await` loop
 * over parsed JSON and nothing else.
 *
 * ## The three modes
 *
 * | `mode` | What drives the loop | When |
 * |---|---|---|
 * | `llm` (default) | the configured model, via `runShoppingAgent` | a provider key is configured |
 * | `scripted` | `runScriptedShopper`, no model | no key, or a reproducible demo |
 * | `compromised` | the scripted shopper, submitting an authorisation it never obtained | the Gate demo |
 *
 * `llm` falling back to `scripted` is deliberate and is announced in the stream (`error` + `thought`
 * events), never silent: a demo that quietly stops using the model is a demo that lies about itself.
 *
 * ## Local only
 *
 * The same `COUNTERSIGN_AGENT_DEMO=1` gate as the session route. This endpoint mints a bearer and spends a
 * mandate; it is not a production surface.
 */
import {
  csError,
  systemClock,
  toBody,
  type AgentId,
  type MandateId,
  type UserId,
} from '@countersign/core'
import { createMCPClient } from '@ai-sdk/mcp'
import {
  runScriptedShopper,
  runShoppingAgent,
  type ShopDeps,
  type ShopEvent,
} from '@countersign/agent'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { merchantMcpUrl } from '@/app/api/mcp/[transport]/endpoint'
import { sessionMandatePort, sessionSigner, agentDemoAllowed } from '@/lib/agent-session'
import { currentUserId, guardRunUser } from '@/lib/session'
import { languageModel } from '@/lib/llm'
import { MCP_TOKEN_TTL_SECONDS, mintAgentToken } from '@/lib/mcp-token'

const requestSchema = z
  .object({
    user_id: z.string().min(1).max(128),
    mandate_id: z.string().min(1).max(128),
    agent_id: z.string().regex(/^agt_[A-Za-z0-9_-]+$/u),
    message: z.string().min(1).max(500),
    mode: z.enum(['llm', 'scripted', 'compromised', 'instructed']).default('llm'),
    /** The SKU the scripted shopper should target. Ignored by the LLM path. */
    sku: z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/)
      .optional(),
  })
  .strict()

export async function POST(request: Request): Promise<Response> {
  if (!agentDemoAllowed()) {
    return NextResponse.json(
      toBody(
        csError(
          'CS_FORBIDDEN',
          'The agent demo is available only when COUNTERSIGN_AGENT_DEMO=1 and NODE_ENV is not production.',
          undefined,
          { userMessage: 'The live agent demo is not enabled on this deployment.' },
        ),
      ),
      { status: 403 },
    )
  }

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
      toBody(csError('CS_VALIDATION', 'The run request did not match the expected shape.')),
      { status: 400 },
    )
  }
  const body = parsed.data

  // Per-user isolation (audit §4): when this browser has a session, the run belongs to that buyer and to no
  // other. A body that names a different user is refused before a mandate is read, let alone spent — the
  // mandate id in the body is otherwise a handle to someone else's budget.
  const session = await currentUserId()
  if (!session.ok) {
    return NextResponse.json(toBody(session.error), { status: 503 })
  }
  const allowed = guardRunUser(session.value, body.user_id)
  if (!allowed.ok) {
    return NextResponse.json(toBody(allowed.error), { status: 403 })
  }

  const token = await mintAgentToken({ agentId: body.agent_id })
  if (!token.ok) {
    return NextResponse.json(toBody(token.error), { status: 503 })
  }

  // One definition of the merchant MCP path, shared with the route that serves it (audit 8.7).
  const mcpUrl = merchantMcpUrl(request.url)
  const merchantMcp = await createMCPClient({
    transport: {
      type: 'http',
      url: mcpUrl,
      headers: { authorization: `Bearer ${token.value}` },
    },
    clientName: 'countersign-shopping-agent',
  })

  const model = languageModel()
  const deps: ShopDeps = {
    // The LLM path needs a model; the scripted path never reads this field, and `mode` decides which runs.
    llm: model.ok ? model.value : ({} as ShopDeps['llm']),
    merchantMcp,
    mandate: sessionMandatePort(),
    signer: sessionSigner(body.mandate_id as MandateId),
    clock: systemClock,
  }

  const shopRequest = {
    userId: body.user_id as UserId,
    mandateId: body.mandate_id as MandateId,
    agentId: body.agent_id as AgentId,
    message: body.message,
  }

  const stream = resolveStream(body, shopRequest, deps, model)

  return new Response(toSse(stream), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx-style buffering would defeat the point of streaming on the deployed path.
      'x-accel-buffering': 'no',
    },
  })
}

/** Pick the loop for this request. See the table in the module header. */
function resolveStream(
  body: z.infer<typeof requestSchema>,
  request: Parameters<typeof runScriptedShopper>[0],
  deps: ShopDeps,
  model: ReturnType<typeof languageModel>,
): AsyncIterable<ShopEvent> {
  if (body.mode === 'compromised' || body.mode === 'scripted' || body.mode === 'instructed') {
    return runScriptedShopper(request, deps, {
      behaviour:
        body.mode === 'compromised'
          ? 'compromised'
          : body.mode === 'instructed'
            ? 'instructed'
            : 'lawful',
      ...(body.sku === undefined ? {} : { sku: body.sku }),
    })
  }
  if (!model.ok) return degradedToScripted(request, deps, body.sku, model.error.message)
  return runShoppingAgent(request, deps)
}

/**
 * The `mode: 'llm'` fallback, announced rather than silent.
 *
 * A judge without a provider key still gets a working demo — but the stream says which planner ran, and
 * why, in the first two events. The alternative (quietly scripting it) is the failure this project keeps
 * calling out: a demo that reports a capability it did not exercise.
 */
async function* degradedToScripted(
  request: Parameters<typeof runScriptedShopper>[0],
  deps: ShopDeps,
  sku: string | undefined,
  reason: string | null,
): AsyncIterable<ShopEvent> {
  const at = deps.clock.nowMs()
  yield {
    kind: 'thought',
    at,
    data: {
      text:
        `No model is configured (${reason ?? 'LLM_UNAVAILABLE'}), so this run uses the deterministic ` +
        'scripted shopper: same tools, same controls, no model in the loop.',
    },
  }
  yield* runScriptedShopper(request, deps, {
    behaviour: 'lawful',
    ...(sku === undefined ? {} : { sku }),
  })
}

/** Encode an event iterable as SSE frames. One JSON object per frame; the client owns the framing. */
function toSse(events: AsyncIterable<ShopEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = events[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done === true) {
          controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'))
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`))
      } catch (cause) {
        // The agent loop does not throw, but the SSE writer is the last place a surprise would land and
        // a half-open stream would leave the UI spinning. Close it with a frame that says what happened.
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              kind: 'error',
              at: Date.now(),
              data: {
                error: {
                  code: 'CS_INTERNAL',
                  message: cause instanceof Error ? cause.message : 'stream failure',
                },
              },
            })}\n\n`,
          ),
        )
        controller.close()
      }
    },
    async cancel() {
      await iterator.return?.(undefined)
    },
  })
}

/** Re-exported so a test can assert the bearer lifetime the run mints without importing `jose` itself. */
export { MCP_TOKEN_TTL_SECONDS }
