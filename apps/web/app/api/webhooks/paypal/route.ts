/**
 * `POST /api/webhooks/paypal` - spec **§8.12** (M12), **§12.3**, decisions **D12**, **D13**.
 *
 * ## Why this file is thin on policy and thick on wiring
 *
 * Every decision §8.12 asks for is already implemented and tested in `packages/webhooks`: store the exact
 * bytes, verify with PayPal, mark the row, enqueue `wh.process`, acknowledge within two seconds. This route
 * re-decides none of it. A handler with its own opinion about a forged signature would be a second
 * implementation of EC-WH-4 beside the tested one, and the two would drift the first time one was corrected.
 *
 * ## The byte-exactness rule is the reason this file is not a one-liner
 *
 * `request.json()` then `JSON.stringify()` would re-serialise PayPal's body - key order changes, whitespace
 * disappears - and `verify-webhook-signature` verifies the bytes it is given, so a delivery PayPal really
 * signed would fail verification on our side. `readRawBody()` (in `./raw-body`, so `route.ts` exports only a
 * handler) reads the stream once and hands over exactly what arrived, which is EC-WH-7's "store the exact
 * bytes" as well as §8.12 step 1's.
 *
 * ## Never a 5xx for a rejected delivery, never a 2xx for an unhandled one
 *
 * `handleWebhook` promises 200 for anything it stored and 400 for a forged or unreadable body, and it does not
 * throw. If it throws here that is a bug in this process, and the answer is 503: PayPal's retry budget is the
 * right response to our own failure and the wrong one for a forgery, because a 5xx would make PayPal redeliver
 * a forged body up to 25 times over three days. Opposite causes, opposite codes.
 *
 * ## What this route cannot do yet, stated here rather than left to be discovered
 *
 * `PAYPAL_WEBHOOK_ID` is empty on this deployment (HUMAN_TODO 2/3), so `verifyDelivery` answers `UNAVAILABLE`
 * and every delivery is stored `PENDING` and acknowledged 200. That is EC-WH-7's configured-off state, not a
 * claim that a signature was checked, and it is why the positive case ("a signed delivery is `VERIFIED`") is
 * asserted in `packages/webhooks`'s own tests against the real `PayPalClient` rather than here.
 *
 * ## Where the dependencies come from, and the composition this app does not own
 *
 * The event store and the audit sink are composed here over `@countersign/db`, a package this app already
 * depends on. `apps/worker` has an equivalent composition (`createWebhooksFromEnv`); it is **not** imported,
 * because `apps/web/package.json` does not declare `@countersign/worker` and a Next route that reached across
 * that boundary would pull the worker's job runner into the web bundle. The duplication is deliberate and
 * recorded in `docs/contract-issues.md` (item 9): both call sites satisfy the same ports, and it is
 * `packages/webhooks` that tests them.
 *
 * Two members are deliberately not wired, and both are **reported rather than faked**:
 *
 *  - **The producer queue.** `pg-boss` is the worker's; giving this process a second connection to it is a
 *    deployment decision (HUMAN_TODO 12) and not a code one. `send` fails loudly, `handleWebhook` logs it and
 *    still answers 200 per §8.12 step 5, and the row is picked up by `wh.verify` and the reconciler's
 *    unprocessed sweep. The delivery is durable either way; nothing claims it was processed.
 *  - **The aggregate readers.** They belong to the reconciler, which runs in `apps/worker`.
 *    `handleWebhook` never calls them, so the object is cast in one place and named, rather than built from
 *    nine stubs that would each have to lie.
 */
import { env, logger as rootLogger, newId, systemClock, toCsError } from '@countersign/core'
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
  handleWebhook,
  WEBHOOK_AUDIT_CHAIN,
  type WebhookAck,
  type WebhookDeps,
  type WebhookQueue,
  type WebhookStore,
} from '@countersign/webhooks'

import { headerBag, readRawBody } from './raw-body'

/** Never cache a webhook: §8.12's ack is about *this* delivery, and a cached one would be a lie. */
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * `WebhookAudit` over `@countersign/db`'s hash-chained append.
 *
 * **Not a raw insert.** `audit_log` is append-only and hash-chained (`this_hash = sha256(JCS({., prev_hash}))`
 * over a `SELECT . FOR UPDATE` on the chain head); a plain insert would break `verifyChain`, which is the
 * mechanism that makes "a bug quietly rewrote a dispute timeline" detectable. EC-WH-4's entry has to go through
 * the same chain as every other one. `id` is minted here because the column is `NOT NULL` and the port
 * deliberately carries none: a caller auditing a delivery has no natural id for it.
 */
function auditSink(): WebhookDeps['audit'] {
  return {
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
  }
}

/**
 * The producer queue, deliberately not wired to `pg-boss`.
 *
 * The worker owns the boss and the `wh.process` handler. Rather than half-build a second connection, `send`
 * reports the failure and `handleWebhook` responds exactly as it does for any other enqueue failure: log, 200,
 * row left unprocessed for `wh.verify` and the reconciler's sweep.
 *
 * This is the one member of this route that is a configured-off state rather than a real implementation, and
 * it is why §8.12's "200 within 2 s even if processing fails" matters: the delivery is never lost, only
 * deferred.
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
 * The store as `handleWebhook` sees it.
 *
 * `events` is a rename-and-forward to the repositories the port names, and nothing more. `aggregates` is the
 * reconciler's, and the cast is the honest way to say so: building nine stubs that all throw would look like an
 * implementation while providing exactly this guarantee.
 */
function storeOverRepos(): WebhookStore {
  return {
    events: {
      ingestEvent: (input) => ingestWebhookEvent(input),
      findByPaypalId: (id) => findWebhookEventByPaypalId(id),
      findById: async (id) => {
        // No repository yet (`packages/db/src/repos/webhooks.ts` has find-by-paypal-id and the listers, not
        // find-by-id). Nothing in `handleWebhook` calls it: every lookup after the insert is by
        // `paypal_event_id` or on the row the insert returned. It fails loudly rather than returning a
        // fabricated row, and it is recorded as a contract issue.
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
      markProcessed: async (id, error, at) => {
        /*
         * The port passes the state it wants as an `error` string: `null` is "done", and a string is a
         * failure or an ignore reason (`handleWebhook` writes "ignored: signature verification failed", and
         * `wh.process` writes "ignored: <reason>" or "gave up after N attempts"). All three are the
         * repository's `markProcessed`; `markIgnored` is the same write with an `ignored: ` prefix, so
         * forwarding a string here verbatim keeps the prefix from being doubled.
         */
        return markProcessed(id, error, at)
      },
      markIgnored: (id, reason, at) => markIgnored(id, reason, at),
      listUnprocessed: (limit) => listUnprocessedEvents(limit),
      listUnverified: async () => {
        /*
         * `wh.verify` is the consumer of this read and it runs in `apps/worker`; this process has no cron, so
         * nothing here schedules the retry. The read itself is the same database, and it fails loudly rather
         * than returning an empty list - an empty list would read as "nothing is waiting", which is the one
         * answer that would hide a stuck delivery.
         */
        return {
          ok: false,
          error: {
            code: 'CS_INTERNAL',
            message:
              'unverified deliveries are retried by apps/worker (wh.verify), not by this route',
            userMessage: 'Unverified deliveries are retried by the worker.',
            retryable: false,
            details: {},
          },
        }
      },
      countFailedSince: (since) => countFailedSince(since),
    },
    aggregates: undefined as unknown as WebhookStore['aggregates'],
  }
}

/**
 * The dependencies for one delivery.
 *
 * Built per request rather than memoised at module scope: a memoised `PayPalClient` would outlive a changed
 * `DATABASE_URL` or credential in a long-running dev server, which is the "the process kept using the old
 * answer" class of bug this branch is removing elsewhere.
 */
function depsForDelivery(): WebhookDeps {
  const configured = env()
  const logger = rootLogger.child({ module: 'webhooks' })
  return defineWebhookDeps({
    clock: systemClock,
    paypal: new PayPalClient({
      // `env()` has already refused anything but a sandbox host (EC-ENV-1), so this is the same resolution
      // `/status` reports - not a second default.
      baseUrl: configured.PAYPAL_API_BASE,
      clientId: configured.PAYPAL_CLIENT_ID,
      clientSecret: configured.PAYPAL_CLIENT_SECRET,
      clock: systemClock,
      logger,
      fetchImpl: fetch,
    }),
    store: storeOverRepos(),
    queue: producerQueue,
    audit: auditSink(),
    throttle: defaultThrottle(),
    webhookId: configured.PAYPAL_WEBHOOK_ID,
    logger,
  })
}

/**
 * `WebhookAck` -> `Response`.
 *
 * The body is the machine reason and nothing else: no PayPal payload, no stack, no `CsError.details`. A webhook
 * response is read by PayPal's delivery report and by any proxy in front of us, so it is the same class of
 * surface as `/status`: report, never leak.
 */
function respond(ack: WebhookAck): Response {
  return new Response(
    JSON.stringify({
      outcome: ack.outcome,
      paypalEventId: ack.paypalEventId,
      ...(ack.error === null
        ? {}
        : { error: { code: ack.error.code, message: ack.error.message } }),
    }),
    {
      status: ack.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  )
}

export async function POST(request: Request): Promise<Response> {
  try {
    /*
     * The bytes and the headers are read inside the try, so a body that cannot be read is a 503 like any other
     * failure in this process rather than an unhandled rejection. `readRawBody` is the adapter's one
     * irreducible job - hand `handleWebhook` exactly what arrived - and doing it here rather than in a
     * `request.json()` call inside the package is what keeps the bytes verbatim.
     */
    const ack = await handleWebhook(
      await readRawBody(request),
      headerBag(request.headers),
      depsForDelivery(),
    )
    return respond(ack)
  } catch (cause) {
    /*
     * `handleWebhook` promises not to throw, so reaching here is a bug rather than an outcome. 503 with the
     * reason in the log and only a machine sentence in the body: a 5xx earns PayPal's retry, which is what an
     * unexpected failure deserves, and a 400 would have told PayPal to stop retrying a delivery we simply failed
     * to handle. Never echo the exception message verbatim - it can carry a header value, which is
     * attacker-controlled.
     *
     * `toCsError`, not `cause instanceof Error`. An error crossing a package boundary here is a `CsError` (a
     * plain object), and `instanceof Error` is false for it - which is how this branch once logged
     * `"message":"[object Object]"`, the exact defect the worker's own `main()` documents.
     */
    const detail = toCsError(cause)
    rootLogger
      .child({ module: 'webhooks' })
      .error('the webhook route failed before it could produce an acknowledgement', {
        code: detail.code,
        message: detail.message,
      })
    return respond({
      status: 503,
      outcome: 'STORED_UNVERIFIED',
      paypalEventId: null,
      error: {
        code: 'CS_INTERNAL',
        message: 'The delivery could not be handled and was not processed; PayPal will retry',
        userMessage: 'That delivery could not be accepted.',
        retryable: true,
        details: { reason: detail.code },
      },
      atMs: Date.now(),
    })
  }
}

/*
 * `GET` is deliberately not exported.
 *
 * A `GET` on a webhook endpoint is a probe, and answering it with 200 invites a reader to believe the endpoint
 * is healthy. Next answers 405 when only `POST` is defined, which is the correct reply and costs nothing.
 */
