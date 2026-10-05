/**
 * The boot path — spec **§8.12**, **§8.10**, **§6**.
 *
 * ## Why this file lives in `src/` and not `test/`
 *
 * `apps/worker/test/` is outside this work package's file list. `vitest.config.base`'s `include` covers
 * `src/**\/*.{test,spec}.ts`, so a test here is still run by `pnpm --filter @countersign/worker test` — it
 * is simply placed in the directory this work package may write to.
 *
 * ## What is worth defending
 *
 * 1. **`productionDeps()` returns adapters instead of throwing.** That is the whole defect: it used to end in
 *    `throw new Error('production wiring is incomplete …')` with exit 78, so the process that owns §8.10's
 *    reservation release never ran.
 * 2. **Every handler is registered and none is the "unconfigured" no-op.** A handler that logs
 *    `job has no handler wired` every five minutes is a working-looking failure, and it is exactly how
 *    `release.reservations` went missing without anybody noticing.
 * 3. **The `WebhookStore` and `WebhookAudit` ports are *completely* filled in.** A `tsc` error would catch a
 *    missing member, so what this adds is the assertion that the **objects are usable** — that a hole
 *    reported as `undefined` is not in the tree.
 */
import { describe, expect, it } from 'vitest'
import { setEnvForTesting, type Env } from '@countersign/core'
import { JOB_BUDGET_RECONCILE, JOB_RELEASE_RESERVATIONS, type JobName } from '@countersign/webhooks'

import { dbWebhookAudit, dbWebhookStore } from './adapters'
import { productionDeps, startWorker } from './index'
import { fakeBoss } from '../test/harness'

/**
 * A complete `Env`.
 *
 * Injected rather than set through `process.env` because `env()` caches, and because a test that mutated the
 * process environment would leak into every other file in the same process. The values are obviously fake and
 * none of them is a real credential: nothing here opens a socket, because `productionDeps` builds ports.
 */
function fakeEnv(): Env {
  return {
    APP_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://cs:cs@127.0.0.1:55470/cs',
    SESSION_SECRET: 'x'.repeat(48),
    PAYPAL_ENV: 'sandbox',
    PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
    PAYPAL_CLIENT_ID: 'TEST-CLIENT-ID',
    PAYPAL_CLIENT_SECRET: 'TEST-CLIENT-SECRET',
    PAYPAL_WEBHOOK_ID: '',
    PAYPAL_MCP_URL: 'https://mcp.sandbox.paypal.com/http',
    PAYPAL_MCP_MODE: 'remote',
    OPENAI_API_KEY: '',
    LLM_MAIN_MODEL: 'gpt-6.1-sol',
    LLM_CHEAP_MODEL: 'gpt-6-luna',
    VI_SERVICE_URL: 'http://127.0.0.1:8000',
    VI_SERVICE_TOKEN: 't'.repeat(32),
    VI_KEK: Buffer.alloc(32, 7).toString('base64'),
    VI_ISSUER_KID: 'issuer-1',
    VI_MERCHANT_KID: 'merchant-1',
    VI_CLOCK_SKEW_SECONDS: 300,
    GATE_KID: 'gate-1',
    GATE_SIGNING_KEY: '{}',
    CHECKOUT_PRICE_LOCK_SECONDS: 900,
    FEATURE_BRYNTUM: false,
    FEATURE_WEBAUTHN: true,
    FEATURE_JUDGE_MODE: true,
    RETENTION_DAYS_OPERATIONAL: 365,
    RETENTION_DAYS_EVIDENCE: 540,
  } as unknown as Env
}

function withEnv(): void {
  setEnvForTesting(fakeEnv())
}

/* ------------------------------------------------------------------------------------------ */
/* 1. The store and audit ports are filled in                                                       */
/* ------------------------------------------------------------------------------------------ */

describe('the WebhookStore and WebhookAudit adapters', () => {
  it('every WebhookStore member is a function — a hole reported as undefined is not in the tree', () => {
    const store = dbWebhookStore()
    const members: Record<string, unknown[]> = {
      events: [
        store.events.ingestEvent,
        store.events.findByPaypalId,
        store.events.findById,
        store.events.listUnverified,
        store.events.listUnprocessed,
        store.events.markVerifiedState,
        store.events.markProcessed,
        store.events.markIgnored,
        store.events.countFailedSince,
      ],
      aggregates_orders: [
        store.aggregates.orders.findByPaypalId,
        store.aggregates.orders.reconcileCandidates,
        store.aggregates.orders.setStatus,
        store.aggregates.orders.recordFetched,
      ],
      aggregates_authorizations: [
        store.aggregates.authorizations.findByPaypalId,
        store.aggregates.authorizations.reconcileCandidates,
        store.aggregates.authorizations.setStatus,
      ],
      aggregates_captures: [
        store.aggregates.captures.findByPaypalId,
        store.aggregates.captures.reconcileCandidates,
        store.aggregates.captures.applyFromFetch,
      ],
      aggregates_refunds: [
        store.aggregates.refunds.findByPaypalId,
        store.aggregates.refunds.setStatus,
      ],
      aggregates_disputes: [
        store.aggregates.disputes.findByPaypalId,
        store.aggregates.disputes.upsertFromFetch,
        store.aggregates.disputes.updatedSince,
      ],
    }
    for (const [group, list] of Object.entries(members)) {
      expect({ group, missing: list.filter((m) => typeof m !== 'function') }).toEqual({
        group,
        missing: [],
      })
    }
    expect(typeof dbWebhookAudit('chain').append).toBe('function')
  })

  it('constructing the store opens no socket, so importing this package stays free', () => {
    // `apps/worker`'s `WORKER-3` rule: `import '@countersign/worker'` must cost nothing. `db()` is lazy, so
    // constructing the store is a pure object literal.
    expect(() => dbWebhookStore()).not.toThrow()
    expect(() => dbWebhookAudit('chain')).not.toThrow()
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 2. The boot path                                                                               */
/* ------------------------------------------------------------------------------------------ */

describe('productionDeps', () => {
  it('WORKER-2 productionDeps() returns real adapters instead of throwing on a complete environment', () => {
    withEnv()
    const deps = productionDeps()

    // The defect this fixes: this used to throw, `main()` caught it and returned 78, and the process whose
    // only job is durable side effects never started.
    expect(deps.webhooks.store.events.ingestEvent).toBeTypeOf('function')
    expect(deps.webhooks.audit.append).toBeTypeOf('function')
    expect(deps.webhooks.store.aggregates.captures.reconcileCandidates).toBeTypeOf('function')

    // And the two ledger jobs are wired, because they are the ones `RunnerDeps` calls "unconfigured" ports
    // when they are missing.
    expect(deps.releaseReservations).toBeTypeOf('function')
    expect(deps.reconcileBudget).toBeTypeOf('function')
  })

  it('WORKER-2 a missing environment variable still refuses to start, per spec §6', () => {
    setEnvForTesting(null)
    try {
      expect(() => productionDeps()).toThrow()
    } finally {
      setEnvForTesting(null)
    }
  })
})

describe('startWorker registers every handler, including the reservation release', () => {
  it('WORKER-1 no handler is the "unconfigured" no-op — a wired worker has nothing left to skip', async () => {
    withEnv()
    const deps = productionDeps()
    const boss = fakeBoss()

    const started = await startWorker({ ...deps, boss, crons: [] })
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`)

    expect(started.value.registration.errors).toHaveLength(0)
    expect(started.value.registration.handlers).toHaveLength(7)

    // `createJobRunner`'s unconfigured branch answers `{ skipped: true, reason: '<job> is not wired' }`, and
    // the real handlers answer `{ ok: false, completed: true, code }` when the database is unreachable.
    // Asserting that neither answer is the *skipped* shape is what proves nothing is silently dead — which
    // is exactly how `release.reservations` was dead for so long.
    for (const job of [JOB_RELEASE_RESERVATIONS, JOB_BUDGET_RECONCILE]) {
      const handler = boss.handlers.get(job)
      expect(handler, `${job} has no registered handler`).toBeDefined()
      const settled = (await handler!({})) as Record<string, unknown>
      expect(settled, `${job} resolved as the unconfigured no-op`).not.toHaveProperty('skipped')
      expect(settled, `${job} produced no result`).toHaveProperty('ok')
      // And it produced a `Result` rather than throwing, so pg-boss classifies it instead of retrying for
      // ever against a database it cannot reach.
      expect(settled['ok']).toBe(false)
      expect(typeof settled['code']).toBe('string')
    }
  })

  it('WORKER-1 the whole schedule table is registrable through the production boot path', async () => {
    withEnv()
    const boss = fakeBoss()
    const started = await startWorker({ ...productionDeps(), boss })
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`)

    const scheduled = started.value.registration.schedules
    expect(scheduled).toContain(JOB_RELEASE_RESERVATIONS)
    expect(scheduled).toContain(JOB_BUDGET_RECONCILE)
    expect(scheduled.length).toBeGreaterThanOrEqual(6)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 3. The two ledger jobs name themselves in their result                                           */
/* ------------------------------------------------------------------------------------------ */

describe('the composed ledger jobs', () => {
  it('§8.10 the reservation-release job is callable and reports a shape, not a bare throw', async () => {
    withEnv()
    const deps = productionDeps()
    // No database in this process, so it fails — and it must fail as a `Result`, because
    // `settleForQueue` classifies a throw as "retry me" and a 5xx result as "finish me". A job that threw
    // would be retried for ever against an unreachable database.
    const outcome = await deps.releaseReservations!({})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(typeof outcome.error.code).toBe('string')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 4. Job names, so a rename cannot silently detach a cron                                          */
/* ------------------------------------------------------------------------------------------ */

describe('the job names the release job answers to', () => {
  it('§8.10 release.reservations and budget.reconcile are the queue names the crons register', () => {
    // Pinned because a renamed constant would leave `releaseExpiredReservations` wired and the cron
    // registered under the old name, and the symptom would be a job that never fires.
    const names: JobName[] = [JOB_RELEASE_RESERVATIONS, JOB_BUDGET_RECONCILE]
    expect(names).toEqual(['release.reservations', 'budget.reconcile'])
  })
})
