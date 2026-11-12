/**
 * Test-only helpers for the webhook route suite.
 *
 * ## Why a separate file
 *
 * `route.ts` is a Next route module: importing it pulls `next/server`'s module graph into the test worker,
 * which is a different module graph from the one `vitest` uses for everything else. So this file holds the
 * pieces the suite needs that are not the route's policy - turning a body into the bytes `handleWebhook` takes,
 * the canonical header bag, and the deps composed over the real repositories - and the suite imports them from
 * here. The byte-read and header-bag themselves now live in `./raw-body`, a plain module `route.ts` and this
 * file both import, so the property under test ("the bytes and headers survive the boundary") has exactly one
 * implementation instead of two that could drift.
 */
import { systemClock, logger as rootLogger, newId } from '@countersign/core'
import {
  appendAudit,
  countFailedSince,
  findWebhookEventByPaypalId,
  ingestWebhookEvent,
  listUnprocessedEvents,
  markIgnored,
  markProcessed,
  markVerificationFailed,
  markVerificationPending,
  markVerified,
} from '@countersign/db'
import { PayPalClient } from '@countersign/paypal'
import {
  defaultThrottle,
  defineWebhookDeps,
  WEBHOOK_AUDIT_CHAIN,
  type WebhookDeps,
  type WebhookQueue,
  type WebhookStore,
} from '@countersign/webhooks'

/** The canonical header bag, re-exported so the suite and the route share one implementation. */
export { headerBag as headerBagOf } from './raw-body'

/** A string body as the bytes `handleWebhook` receives. Never a re-encode of a parsed object. */
export function bytesOf(body: string): Uint8Array {
  return new Uint8Array(Buffer.from(body, 'utf8'))
}

/**
 * The producer queue, as configured off as it is in `route.ts`.
 *
 * The worker owns `pg-boss`; this process does not. `handleWebhook` logs the failure and still acks 200 per
 * §8.12 step 5, and the row is picked up by `wh.verify` and the reconciler's sweep.
 */
const producerQueue: WebhookQueue = {
  send: async () => ({
    ok: false,
    error: {
      code: 'CS_INTERNAL',
      message: 'the webhook producer queue is owned by apps/worker; this process stores and defers',
      userMessage: 'That delivery was stored. It will be processed by the reconciler.',
      retryable: true,
      details: { owner: 'apps/worker' },
    },
  }),
  work: async () => ({
    ok: false,
    error: {
      code: 'CS_INTERNAL',
      message: 'job handlers are registered by apps/worker, not by the web process',
      userMessage: 'This process does not consume webhook jobs.',
      retryable: false,
      details: {},
    },
  }),
  schedule: async () => ({
    ok: false,
    error: {
      code: 'CS_INTERNAL',
      message: 'schedules are registered by apps/worker, not by the web process',
      userMessage: 'This process does not run the reconciler.',
      retryable: false,
      details: {},
    },
  }),
  start: async () => ({ ok: true, value: undefined }),
  stop: async () => ({ ok: true, value: undefined }),
}

/**
 * The `WebhookDeps` the route composes, over the real `@countersign/db` repositories.
 *
 * PayPal is the real client with the real `fetch`; the verification call is answered by
 * `PAYPAL_WEBHOOK_ID`, which is empty in the test environment, so `verifyDelivery` takes its
 * `UNAVAILABLE` branch without opening a socket. That is the deployed configuration too.
 */
export async function realDeps(): Promise<WebhookDeps> {
  const logger = rootLogger.child({ module: 'webhooks.test' })
  const store: WebhookStore = {
    events: {
      ingestEvent: (input) => ingestWebhookEvent(input),
      findByPaypalId: (id) => findWebhookEventByPaypalId(id),
      findById: async (id) => {
        void id
        return {
          ok: false,
          error: {
            code: 'CS_INTERNAL',
            message: 'findWebhookEventById is not implemented in @countersign/db yet',
            userMessage: 'That delivery cannot be read by id.',
            retryable: false,
            details: {},
          },
        }
      },
      markVerifiedState: async (id, verified, error, at) => {
        if (verified === 'VERIFIED') return markVerified(id, at)
        if (verified === 'FAILED')
          return markVerificationFailed(id, error ?? 'verification failed', at)
        return markVerificationPending(id, error ?? 'verification deferred', at)
      },
      markProcessed: (id, error, at) => markProcessed(id, error, at),
      markIgnored: (id, reason, at) => markIgnored(id, reason, at),
      listUnprocessed: (limit) => listUnprocessedEvents(limit),
      listUnverified: async () => ({
        ok: false,
        error: {
          code: 'CS_INTERNAL',
          message:
            'unverified deliveries are retried by apps/worker (wh.verify), not by this route',
          userMessage: 'Unverified deliveries are retried by the worker.',
          retryable: false,
          details: {},
        },
      }),
      countFailedSince: (since) => countFailedSince(since),
    },
    // The reconciler's, not the ingest path's. `handleWebhook` never reaches it.
    aggregates: undefined as unknown as WebhookStore['aggregates'],
  }

  const paypal = new PayPalClient({
    baseUrl: process.env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com',
    clientId: process.env['PAYPAL_CLIENT_ID'] ?? 'test-client-id',
    clientSecret: process.env['PAYPAL_CLIENT_SECRET'] ?? 'test-client-secret',
    clock: systemClock,
    logger,
    fetchImpl: fetch,
  })

  return defineWebhookDeps({
    clock: systemClock,
    paypal,
    store,
    queue: producerQueue,
    audit: {
      append: (input) =>
        appendAudit({
          id: newId('aud'),
          chainId: WEBHOOK_AUDIT_CHAIN,
          actor: input.actor,
          action: input.action,
          subject: input.subject,
          details: input.details,
          at: input.at,
        }),
    },
    throttle: defaultThrottle(),
    webhookId: process.env['PAYPAL_WEBHOOK_ID'] ?? '',
    logger,
  })
}
