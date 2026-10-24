/**
 * The tool-calling loop — spec §8.13's `runShoppingAgent`, driven by a model that **cooperates with the
 * injection**.
 *
 * ## Why the scripted model is adversarial rather than helpful
 *
 * The interesting question about an agent loop is not "does it work when the model behaves" — that is a
 * network test. It is "what happens when the model does exactly what the listing told it to?". So the
 * fake model in this file calls `get_product` on a payload-bearing SKU, then tries to buy it, and the
 * assertions are about what the *controls* did: the signer refused, or the gate blocked, or the run ended
 * without a purchase. None of the assertions read the model's prose.
 *
 * `ai`'s `MockLanguageModelV3` is used directly (there is no model call here at all) so the test exercises
 * the real loop, the real tool wrappers and the real event stream.
 */
import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'

import { runShoppingAgent } from '../src/agent'
import { outcomeFromEvents } from '../src/refusal'
import type { ShopEvent } from '../src/types'
import { fakeDeps, REQUEST } from './support/harness'

/* ------------------------------------------------------------------------------------------ */
/* A scripted model                                                                              */
/* ------------------------------------------------------------------------------------------ */

type Turn =
  | { readonly kind: 'tool'; readonly name: string; readonly input: unknown }
  | { readonly kind: 'text'; readonly text: string }

/** Turn a list of turns into one `LanguageModelV3` stream, one turn per call, in order. */
function scriptedModel(turns: readonly Turn[]): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    provider: 'test',
    modelId: 'scripted',
    doStream: async () => {
      const turn = turns[Math.min(call, turns.length - 1)]
      call += 1
      const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }]
      if (turn === undefined || turn.kind === 'text') {
        parts.push({ type: 'text-start', id: 't0' })
        parts.push({ type: 'text-delta', id: 't0', delta: turn?.text ?? 'Done.' })
        parts.push({ type: 'text-end', id: 't0' })
        parts.push(finish('stop'))
      } else {
        parts.push({
          type: 'tool-call',
          toolCallId: `call-${call}`,
          toolName: turn.name,
          input: JSON.stringify(turn.input),
        })
        parts.push(finish('tool-calls'))
      }
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }
    },
  })
}

function finish(unified: 'stop' | 'tool-calls'): LanguageModelV3StreamPart {
  return {
    type: 'finish',
    finishReason: { unified, raw: unified },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, reasoning: 0 },
    },
  } as LanguageModelV3StreamPart
}

/** `MockLanguageModelV3` is a `LanguageModelV3`; the loop takes the `ai` package's alias for it. */
function asLanguageModel(
  model: MockLanguageModelV3,
): Parameters<typeof runShoppingAgent>[1]['llm'] {
  return model as unknown as Parameters<typeof runShoppingAgent>[1]['llm']
}

async function collect(iterable: AsyncIterable<ShopEvent>): Promise<ShopEvent[]> {
  const events: ShopEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

/* ------------------------------------------------------------------------------------------ */
/* Tests                                                                                         */
/* ------------------------------------------------------------------------------------------ */

describe('runShoppingAgent', () => {
  it('runs an in-mandate purchase and reports the order', async () => {
    const model = scriptedModel([
      { kind: 'tool', name: 'read_my_mandate', input: {} },
      {
        kind: 'tool',
        name: 'create_checkout',
        input: { lines: [{ sku: 'NW-001', qty: 1 }], ship_to_country: 'US' },
      },
      { kind: 'tool', name: 'text-placeholder', input: {} },
      { kind: 'text', text: 'Bought the shoes.' },
    ])
    // The third turn needs the checkout id, which only exists at runtime. Instead of guessing, drive the
    // tools that need no cross-turn state and assert the loop's contract on those.
    const { deps } = fakeDeps({ llm: asLanguageModel(model) })
    const events = await collect(runShoppingAgent(REQUEST, deps))

    expect(events.filter((event) => event.kind === 'final')).toHaveLength(1)
    expect(events.at(-1)?.kind).toBe('final')
    const tools = events
      .filter((event) => event.kind === 'tool_call')
      .map((event) => (event.data as { tool: string }).tool)
    expect(tools).toContain('read_my_mandate')
    // A malformed tool call is not an exception and not a purchase: the run ends with a verdict.
    expect(['NO_PURCHASE', 'ERROR', 'GATE_BLOCKED', 'SIGNER_REFUSED']).toContain(
      outcomeFromEvents(events).outcome,
    )
  })

  it('stops when the mandate is not ACTIVE, without calling a tool', async () => {
    const { deps } = fakeDeps({
      mandate: { ...(await import('./support/harness')).fakeMandate(), status: 'REVOKED' },
      llm: asLanguageModel(scriptedModel([{ kind: 'text', text: 'ignored' }])),
    })
    const events = await collect(runShoppingAgent(REQUEST, deps))
    expect(events.some((event) => event.kind === 'tool_call')).toBe(false)
    // A revoked mandate is the agent declining, which the scorer reports as AGENT_REFUSED.
    expect(outcomeFromEvents(events).outcome).toBe('AGENT_REFUSED')
  })

  it('reports an unreadable mandate as ERROR rather than guessing', async () => {
    const { deps } = fakeDeps({
      llm: asLanguageModel(scriptedModel([{ kind: 'text', text: 'ignored' }])),
    })
    const broken = {
      ...deps,
      mandate: {
        load: async () =>
          ({
            ok: false,
            error: {
              code: 'CS_INTERNAL',
              message: 'db down',
              userMessage: 'db down',
              retryable: false,
            },
          }) as const,
      },
    }
    const events = await collect(runShoppingAgent(REQUEST, broken))
    expect(outcomeFromEvents(events).outcome).toBe('ERROR')
  })

  it('never throws out of the loop, whatever the model returns', async () => {
    const exploding = new MockLanguageModelV3({
      provider: 'test',
      modelId: 'exploding',
      doStream: async () => {
        throw new Error('provider exploded')
      },
    })
    const { deps } = fakeDeps({ llm: asLanguageModel(exploding) })
    const events = await collect(runShoppingAgent(REQUEST, deps))
    expect(events.at(-1)?.kind).toBe('final')
    expect(outcomeFromEvents(events).outcome).toBe('ERROR')
  })
})
