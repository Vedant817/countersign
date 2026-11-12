/**
 * The heartbeat wrapper — spec §8.19, `docs/PROD_AUDIT.md` §7.
 *
 * ## What is worth asserting here
 *
 * Two things, and they are the two ways this wrapper could make the system worse rather than better:
 *
 *  1. **It records the truth, including the throw.** A handler that returns is an `ok` run; a handler that
 *     throws is an `error` run *and still throws*, because pg-boss reads a rejection as "retry me" and a
 *     heartbeat must not turn a retryable failure into a completed one.
 *  2. **It never changes the outcome.** The sink is a status page; if it fails, the job still runs. A wrapper
 *     that let its own write break a capture would be the worst trade in the system.
 *
 * The sink is a double, so these run with no Postgres — which is also why the wrapper takes a port at all.
 */
import { describe, expect, it } from 'vitest'

import { fixedClock, type CsError } from '@countersign/core'
import type { JobName } from '@countersign/webhooks'

import { codeOf, withHeartbeats, workerId, type HeartbeatSink } from '../src/heartbeat'
import type { QueueHandler } from '../src/job-runner'

interface Recorded {
  readonly job: string
  readonly outcome: 'ok' | 'error'
  readonly errorCode: string | null | undefined
  readonly startedAt: Date
  readonly finishedAt: Date
}

/** A sink that records what it was handed and answers `ok`. */
function recordingSink(): { sink: HeartbeatSink; events: Recorded[] } {
  const events: Recorded[] = []
  return {
    events,
    sink: {
      async record(event) {
        events.push({
          job: event.job,
          outcome: event.outcome,
          errorCode: event.errorCode,
          startedAt: event.startedAt,
          finishedAt: event.finishedAt,
        })
        return { ok: true, value: event }
      },
    },
  }
}

const CLOCK = fixedClock(1_800_000_000)

function table(handler: QueueHandler): Record<JobName, QueueHandler> {
  return { 'wh.reconcile': handler } as unknown as Record<JobName, QueueHandler>
}

describe('§8.19 heartbeat wrapper', () => {
  it('records a successful run, with the elapsed time the row claims', async () => {
    const { sink, events } = recordingSink()
    const handlers = withHeartbeats(
      table(async () => 'done'),
      sink,
      {
        workerId: 'worker-a',
        clock: CLOCK,
      },
    )

    await expect(handlers['wh.reconcile']!({})).resolves.toBe('done')

    expect(events).toHaveLength(1)
    expect(events[0]!.job).toBe('wh.reconcile')
    expect(events[0]!.outcome).toBe('ok')
    expect(events[0]!.errorCode).toBeNull()
    expect(events[0]!.startedAt.getTime()).toBe(CLOCK.nowMs())
    expect(events[0]!.finishedAt.getTime()).toBe(CLOCK.nowMs())
  })

  it('records the error code and re-throws the original cause', async () => {
    const { sink, events } = recordingSink()
    const thrown: CsError = {
      code: 'PP_UNAVAILABLE',
      message: 'PayPal did not answer',
      userMessage: 'We could not reach PayPal. Nothing was charged.',
      retryable: true,
    }
    const handlers = withHeartbeats(
      table(async () => {
        throw thrown
      }),
      sink,
      { workerId: 'worker-a', clock: CLOCK },
    )

    // `rejects.toBe` rather than a message check: the wrapper must not wrap or replace the error, because
    // `classifyForQueue` reads `retryable` off the *original* object to decide whether pg-boss retries.
    await expect(handlers['wh.reconcile']!({})).rejects.toBe(thrown)

    expect(events).toHaveLength(1)
    expect(events[0]!.outcome).toBe('error')
    expect(events[0]!.errorCode).toBe('PP_UNAVAILABLE')
  })

  it('still runs the job when the heartbeat write fails', async () => {
    const sink: HeartbeatSink = {
      async record() {
        return {
          ok: false,
          error: {
            code: 'CS_INTERNAL',
            message: 'the table is read-only',
            userMessage: 'The server is misconfigured.',
            retryable: false,
          },
        }
      },
    }
    const handlers = withHeartbeats(
      table(async () => 42),
      sink,
      {
        workerId: 'worker-a',
        clock: CLOCK,
      },
    )

    await expect(handlers['wh.reconcile']!({})).resolves.toBe(42)
  })

  it('still runs the job when the sink throws, which a port is allowed to do', async () => {
    const sink: HeartbeatSink = {
      async record() {
        throw new Error('socket hang up')
      },
    }
    const handlers = withHeartbeats(
      table(async () => 'ok'),
      sink,
      {
        workerId: 'worker-a',
        clock: CLOCK,
      },
    )

    await expect(handlers['wh.reconcile']!({})).resolves.toBe('ok')
  })

  it('wraps every handler it is given, so no job is silently unmonitored', async () => {
    const { sink, events } = recordingSink()
    const handlers = withHeartbeats(
      {
        'wh.process': async () => 'a',
        'wh.reconcile': async () => 'b',
        'wh.disputes': async () => 'c',
      } as unknown as Record<JobName, QueueHandler>,
      sink,
      { workerId: 'worker-a', clock: CLOCK },
    )

    await handlers['wh.process']!({})
    await handlers['wh.reconcile']!({})
    await handlers['wh.disputes']!({})

    expect(events.map((e) => e.job)).toEqual(['wh.process', 'wh.reconcile', 'wh.disputes'])
  })

  it('names a non-CsError throw as CS_INTERNAL rather than "undefined"', () => {
    expect(codeOf(new Error('boom'))).toBe('CS_INTERNAL')
    expect(codeOf('boom')).toBe('CS_INTERNAL')
    expect(codeOf({ code: 'WH_DUPLICATE' })).toBe('WH_DUPLICATE')
  })

  it('prefers WORKER_ID, and falls back to hostname-pid', () => {
    expect(workerId({ WORKER_ID: ' reconciler-1 ' })).toBe('reconciler-1')
    const fallback = workerId({})
    expect(fallback).toMatch(/^[^-].*-\d+$/)
    expect(fallback).not.toBe('')
  })
})
