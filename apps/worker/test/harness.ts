/**
 * A `WebhookDeps` for the worker's tests, and a recording pg-boss double.
 *
 * ## Why the worker needs its own and does not reuse `packages/webhooks`'s
 *
 * The `packages/webhooks` harness is excellent at what it was built for — driving the **real** `PayPalClient`
 * over an injected `fetch` to prove §8.12's ingest and rank rules. But this package tests a different
 * question: *does the worker wire the right job name to the right function, register in a survivable order,
 * and retry what deserves retrying?* Almost none of those assertions need a PayPal response at all.
 *
 * Reusing the other harness would mean importing a `.test.ts` across a package boundary, and this file's
 * whole value is that it is a **fake store, not a stub**: `captures.reconcileCandidates` returns rows, so a
 * sweep genuinely walks them, and the counters below let a test assert that the sweep reached PayPal at all.
 *
 * What this file is **not** allowed to do is decide what PayPal would have said. `paypal` is a recorder whose
 * methods return `ok(undefined)`-shaped answers by default, and every test that needs a specific answer sets
 * it explicitly. Nothing here encodes PayPal's behaviour (AGENTS.md rule 5).
 */
import type { CsError, Logger, Result } from '@countersign/core'
import { csError, fixedClock } from '@countersign/core'
import type { CaptureRow } from '@countersign/db'
import type { WebhookAudit, WebhookDeps, WebhookPayPal } from '@countersign/webhooks'

import type { PgBossLike, PgBossWorkOptions } from '../src/job-runner'

/** A fixed instant: 2026-10-04T12:00:00Z. Matches the other package's harness so logs line up. */
export const NOW_SEC = 1_789_004_800
export const NOW = new Date(NOW_SEC * 1000)

function pass<T>(value: T): Result<T, CsError> {
  return { ok: true, value }
}

/**
 * A failure built by `csError`, not hand-assembled.
 *
 * The obvious shortcut — a literal `{ code, message, retryable: false }` — is wrong in a way that quietly
 * breaks the retry tests: `retryable` is **derived** from the code in `packages/core`, so a hand-written
 * `PP_UNAVAILABLE` marked permanent would make a job that should be retried complete instead, and the
 * worker's entire retry policy would look correct while being inverted.
 */
function failed(code: CsError['code'], message: string): Result<never, CsError> {
  return { ok: false, error: csError(code, message) }
}

export interface WorkerHarness {
  readonly deps: WebhookDeps
  readonly clock: ReturnType<typeof fixedClock>
  readonly calls: string[]
  readonly audit: { chainId: string; action: string; subject: string }[]
  readonly sent: { name: string; data: unknown }[]
}

/**
 * The minimum viable `WebhookDeps`.
 *
 * `failures` names the ports that should answer `err`, which is how the retry-policy tests reach a
 * `PP_UNAVAILABLE` and a `PP_NOT_FOUND` without needing a whole failure-injecting PayPal double.
 */
export function workerHarness(
  options: {
    readonly fail?: Partial<
      Record<'captures' | 'orders' | 'disputes' | 'unverified' | 'events', CsError['code']>
    >
    readonly captures?: readonly CaptureRow[]
    readonly throttle?: WebhookDeps['throttle']
    readonly queue?: WebhookDeps['queue']
  } = {},
): WorkerHarness {
  const calls: string[] = []
  const audit: { chainId: string; action: string; subject: string }[] = []
  const sent: { name: string; data: unknown }[] = []
  const clock = fixedClock(NOW_SEC)

  const paypal = {
    async getOrder() {
      calls.push('getOrder')
      return failed('PP_NOT_FOUND', 'no order')
    },
    async getAuthorization() {
      calls.push('getAuthorization')
      return failed('PP_NOT_FOUND', 'no authorization')
    },
    async getCapture() {
      calls.push('getCapture')
      return failed('PP_NOT_FOUND', 'no capture')
    },
    async getRefund() {
      calls.push('getRefund')
      return failed('PP_NOT_FOUND', 'no refund')
    },
    async getDispute() {
      calls.push('getDispute')
      return failed('PP_NOT_FOUND', 'no dispute')
    },
    async listDisputes() {
      calls.push('listDisputes')
      if (options.fail?.disputes !== undefined) return failed(options.fail.disputes, 'list failed')
      return pass({ items: [] })
    },
    async verifyWebhookSignature() {
      calls.push('verifyWebhookSignature')
      return pass({ verification_status: 'SUCCESS' as const })
    },
  } as unknown as WebhookPayPal

  const store: WebhookDeps['store'] = {
    events: {
      async ingestEvent() {
        calls.push('events.ingestEvent')
        return failed('CS_INTERNAL', 'not used by the worker')
      },
      async findByPaypalId() {
        return pass(undefined)
      },
      async findById() {
        calls.push('events.findById')
        return pass(undefined)
      },
      async markVerifiedState() {
        return failed('CS_INTERNAL', 'not used by the worker')
      },
      async markProcessed() {
        return failed('CS_INTERNAL', 'not used by the worker')
      },
      async markIgnored() {
        return failed('CS_INTERNAL', 'not used by the worker')
      },
      async countFailedSince() {
        return pass(0)
      },
      async listUnverified() {
        calls.push('events.listUnverified')
        if (options.fail?.unverified !== undefined) return failed(options.fail.unverified, 'no')
        return pass([])
      },
      async listUnprocessed() {
        calls.push('events.listUnprocessed')
        if (options.fail?.events !== undefined) return failed(options.fail.events, 'no')
        return pass([])
      },
    },
    aggregates: {
      orders: {
        async findByPaypalId() {
          return pass(undefined)
        },
        async reconcileCandidates() {
          calls.push('orders.reconcileCandidates')
          if (options.fail?.orders !== undefined) return failed(options.fail.orders, 'no')
          return pass([])
        },
        async setStatus() {
          return failed('CS_INTERNAL', 'unused')
        },
        async recordFetched() {
          return failed('CS_INTERNAL', 'unused')
        },
      },
      authorizations: {
        async findByPaypalId() {
          return pass(undefined)
        },
        async reconcileCandidates() {
          calls.push('authorizations.reconcileCandidates')
          return pass([])
        },
        async setStatus() {
          return failed('CS_INTERNAL', 'unused')
        },
      },
      captures: {
        async findByPaypalId() {
          return pass(undefined)
        },
        async reconcileCandidates() {
          calls.push('captures.reconcileCandidates')
          if (options.fail?.captures !== undefined) return failed(options.fail.captures, 'no')
          return pass(
            (options.captures ?? []).map((c) => ({ paypal_capture_id: c.paypal_capture_id })),
          )
        },
        async applyFromFetch() {
          return failed('CS_INTERNAL', 'unused')
        },
      },
      refunds: {
        async findByPaypalId() {
          return pass(undefined)
        },
        async setStatus() {
          return failed('CS_INTERNAL', 'unused')
        },
      },
      disputes: {
        async findByPaypalId() {
          return pass(undefined)
        },
        async upsertFromFetch() {
          return failed('CS_INTERNAL', 'unused')
        },
        async updatedSince() {
          return pass([])
        },
      },
    },
  }

  const queue: WebhookDeps['queue'] = options.queue ?? {
    async send(name, data) {
      sent.push({ name, data })
      return pass(`job_${sent.length}`)
    },
    async work() {
      return pass(undefined)
    },
    async schedule() {
      return pass(undefined)
    },
    async start() {
      return pass(undefined)
    },
    async stop() {
      return pass(undefined)
    },
  }

  const sink: WebhookAudit = {
    async append(input) {
      audit.push({ chainId: input.chainId, action: input.action, subject: input.subject })
      return pass(undefined)
    },
  }

  return {
    deps: {
      clock,
      paypal,
      store,
      queue,
      audit: sink,
      throttle: options.throttle ?? {
        rps: 2,
        async run(task) {
          return task()
        },
      },
      webhookId: 'WH-WORKER-TEST',
    },
    clock,
    calls,
    audit,
    sent,
  }
}

/** A `Logger` that keeps every line, for asserting on what the worker reported. */
export function recordingLogger(): {
  logger: Logger
  lines: { level: string; msg: string; fields?: Record<string, unknown> }[]
} {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = []
  const build = (): Logger => ({
    debug: (msg, fields) => lines.push({ level: 'debug', msg, ...(fields ? { fields } : {}) }),
    info: (msg, fields) => lines.push({ level: 'info', msg, ...(fields ? { fields } : {}) }),
    warn: (msg, fields) => lines.push({ level: 'warn', msg, ...(fields ? { fields } : {}) }),
    error: (msg, fields) => lines.push({ level: 'error', msg, ...(fields ? { fields } : {}) }),
    child: () => build(),
  })
  return { logger: build(), lines }
}

/* ------------------------------------------------------------------------------------------ */
/* The pg-boss double                                                                            */
/* ------------------------------------------------------------------------------------------ */

export interface PgBossDouble extends PgBossLike {
  /** Times `start()` was called. */
  started: number
  /** Times `stop()` was called. `Worker.stop()` is idempotent, so this must stay at 1. */
  stopped: number
  readonly worked: { name: string; options: PgBossWorkOptions }[]
  readonly scheduled: { name: string; cron: string }[]
  /** Call order across every method, so "handlers before schedules" is assertable. */
  readonly order: string[]
  /** The handler pg-boss would invoke for a name, so a test can drive a job without a queue. */
  readonly handlers: Map<string, (data: unknown) => Promise<unknown>>
  /** Names whose `work()` should reject, to exercise `registerJobs`' error path. */
  failWorkFor: Set<string>
  failScheduleFor: Set<string>
  failStart: boolean
}

/** A pg-boss double that records what the worker asked of it. */
export function fakeBoss(): PgBossDouble {
  const handlers = new Map<string, (data: unknown) => Promise<unknown>>()
  return {
    started: 0,
    stopped: 0,
    worked: [],
    scheduled: [],
    order: [],
    handlers,
    failWorkFor: new Set(),
    failScheduleFor: new Set(),
    failStart: false,
    async start() {
      this.started += 1
      this.order.push('start')
      if (this.failStart) throw new Error('pg-boss: connection refused')
      return this
    },
    async stop() {
      this.stopped += 1
      this.order.push('stop')
    },
    async send(name) {
      this.order.push(`send:${name}`)
      return null
    },
    async work(name, options, handler) {
      this.order.push(`work:${name}`)
      if (this.failWorkFor.has(name)) throw new Error(`pg-boss: cannot register ${name}`)
      this.worked.push({ name, options })
      handlers.set(name, async (data: unknown) => handler({ data }))
      return `worker-${name}`
    },
    async schedule(name, cron) {
      this.order.push(`schedule:${name}`)
      // pg-boss 12 rejects `schedule()` before `start()` with `Database connection is not opened`,
      // because `boss.schedule()` inserts into `pgboss.schedule` and needs a live connection. The
      // fake used to accept any order, which is how a boot sequence that **cannot work** came to be
      // asserted as correct. Reproducing the refusal is what makes the ordering assertion mean
      // something: it now fails for the same reason production would.
      if (this.started === 0) throw new Error('Database connection is not opened')
      if (this.failScheduleFor.has(name)) throw new Error(`pg-boss: cannot schedule ${name}`)
      this.scheduled.push({ name, cron })
    },
  }
}
