/**
 * `webhook_events` repository — spec §7.2, **§8.12 (M12, WP-12)**, EC-WH-1/2/3/6/7.
 *
 * The whole table exists to answer one question safely: *have I seen this event before?* PayPal retries
 * the same event up to 25 times over 3 days [V14], so `paypal_event_id` is unique and the ingest path
 * is `INSERT … ON CONFLICT DO NOTHING` followed by an unconditional `200` (§8.12 step 3 and 5).
 *
 * Two decisions worth stating, because they look like over-engineering until the first incident:
 *
 *  - **`verified` is an enum, not a boolean** (`PENDING | VERIFIED | FAILED`). EC-WH-7 requires
 *    storing an event whose verify-signature call was unavailable — "don't act, retry later" — and a
 *    boolean cannot tell that row apart from one that was checked and rejected. Those two rows must
 *    be handled by opposite code paths.
 *  - **The insert and the enqueue are separate.** A row is written first so the event is durable even
 *    if the queue is down; the worker's `processed_at`/`attempts` columns are then the honest record of
 *    how far processing got. Reconciler crons cover the rest (EC-WH-1, EC-WH-5).
 *
 * Nothing here reads a resource's state from `raw`. §8.12: "never trust payload state" — `raw` is kept
 * for the case file, and the reconciler re-fetches.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import type { CsError, Id, Result } from '@countersign/core'

import { db, type Exec } from '../client'
import { webhookEvents, type NewWebhookEvent, type WebhookEventRow } from '../schema'
import { err, repo } from './index'

export type WebhookVerified = 'PENDING' | 'VERIFIED' | 'FAILED'

export function createWebhookEvent(
  input: NewWebhookEvent,
  exec?: Exec,
): Promise<Result<WebhookEventRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(webhookEvents).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no webhook_events row')
      return row as WebhookEventRow
    },
    { table: 'webhook_events', id: input.id, paypalEventId: input.paypal_event_id },
  )
}

/**
 * EC-WH-2, the dedupe. Returns the row that exists **after** the call: the newly inserted one, or the
 * pre-existing one if `paypal_event_id` was already known.
 *
 * `DO NOTHING` + `RETURNING` is used rather than `DO UPDATE` on purpose — a redelivered event must not
 * bump `received_at` or overwrite the first body we stored, because the *first* copy is the one the
 * case file should show. When the conflict path returns no row at all, the caller re-reads by
 * `paypal_event_id`.
 */
export async function ingestWebhookEvent(
  input: NewWebhookEvent,
  exec?: Exec,
): Promise<Result<{ row: WebhookEventRow; duplicate: boolean }, CsError>> {
  return repo(
    async () => {
      const inserted = await (exec ?? db())
        .insert(webhookEvents)
        .values(input)
        .onConflictDoNothing({ target: webhookEvents.paypal_event_id })
        .returning()
      const fresh = inserted[0]
      if (fresh) return { row: fresh as WebhookEventRow, duplicate: false }
      const existing = await (exec ?? db())
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.paypal_event_id, input.paypal_event_id))
        .limit(1)
      const row = existing[0]
      if (!row) {
        return err({
          code: 'CS_CONFLICT',
          message: `Webhook ${input.paypal_event_id} conflicted but no existing row was readable`,
          userMessage: 'Something went wrong. Nothing was charged.',
          retryable: true,
          details: { table: 'webhook_events', paypalEventId: input.paypal_event_id },
        })
      }
      return { row: row as WebhookEventRow, duplicate: true }
    },
    { table: 'webhook_events', paypalEventId: input.paypal_event_id },
  )
}

export function findWebhookEventByPaypalId(
  paypalEventId: string,
  exec?: Exec,
): Promise<Result<WebhookEventRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.paypal_event_id, paypalEventId))
        .limit(1)
      return rows[0] as WebhookEventRow | undefined
    },
    { table: 'webhook_events', paypalEventId },
  )
}

/** §8.12 step 4 makes `resource_id` the job's singleton key; this is the same view, for reads. */
export function findWebhookEventsByResource(
  resourceId: string,
  exec?: Exec,
): Promise<Result<WebhookEventRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.resource_id, resourceId))
        .orderBy(asc(webhookEvents.received_at))
      return rows as WebhookEventRow[]
    },
    { table: 'webhook_events', resourceId },
  )
}

/**
 * The work queue: unprocessed events, oldest first.
 *
 * `attempts` is incremented on every claim so a poison event cannot be retried forever, and
 * `verified = 'FAILED'` rows are included so an operator can see them — §8.12 returns 200 and defers
 * verification when the verify API is down (EC-WH-7).
 */
export function listUnprocessedEvents(
  limit: number,
  exec?: Exec,
): Promise<Result<WebhookEventRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(webhookEvents)
        .where(isNull(webhookEvents.processed_at))
        .orderBy(asc(webhookEvents.received_at))
        .limit(limit)
      return rows as WebhookEventRow[]
    },
    { table: 'webhook_events', op: 'list_unprocessed' },
  )
}

/** EC-WH-4: a forged webhook is stored as `FAILED` with its reason, and never enqueued. */
export function markVerificationFailed(
  id: Id<'whe'>,
  error: string,
  at: Date,
  exec?: Exec,
): Promise<Result<WebhookEventRow, CsError>> {
  return setVerified(id, 'FAILED', error, at, exec)
}

/** EC-WH-7: the verify API was unavailable. Stored, unprocessed, retried with backoff. */
export function markVerificationPending(
  id: Id<'whe'>,
  error: string,
  at: Date,
  exec?: Exec,
): Promise<Result<WebhookEventRow, CsError>> {
  return setVerified(id, 'PENDING', error, at, exec)
}

export function markVerified(
  id: Id<'whe'>,
  at: Date,
  exec?: Exec,
): Promise<Result<WebhookEventRow, CsError>> {
  return setVerified(id, 'VERIFIED', null, at, exec)
}

function setVerified(
  id: Id<'whe'>,
  verified: WebhookVerified,
  error: string | null,
  at: Date,
  exec?: Exec,
): Promise<Result<WebhookEventRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(webhookEvents)
        .set({ verified, verified_at: verified === 'VERIFIED' ? at : null, error, updated_at: at })
        .where(eq(webhookEvents.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No webhook_events row for ${id}`)
      return row as WebhookEventRow
    },
    { table: 'webhook_events', id, verified },
  )
}

/**
 * Mark the event done. `error = null` means success; a string records *why* it failed so the row is
 * self-explaining without reading the logs.
 */
export function markProcessed(
  id: Id<'whe'>,
  error: string | null,
  at: Date,
  exec?: Exec,
): Promise<Result<WebhookEventRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(webhookEvents)
        .set({
          processed_at: error === null ? at : null,
          error,
          attempts: sql`${webhookEvents.attempts} + 1`,
          updated_at: at,
        })
        .where(eq(webhookEvents.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No webhook_events row for ${id}`)
      return row as WebhookEventRow
    },
    { table: 'webhook_events', id, op: 'mark_processed' },
  )
}

/** EC-WH-6: an event for a resource we have no row for. Stored and marked, never a crash. */
export function markIgnored(
  id: Id<'whe'>,
  reason: string,
  at: Date,
  exec?: Exec,
): Promise<Result<WebhookEventRow, CsError>> {
  return markProcessed(id, `ignored: ${reason}`, at, exec)
}

/** §12.13: webhook raw payloads are kept 90 days, then deleted. The retention job calls this. */
export function deleteWebhookEventsOlderThan(
  cutoff: Date,
  exec?: Exec,
): Promise<Result<number, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .delete(webhookEvents)
        .where(sql`${webhookEvents.received_at} < ${cutoff.toISOString()}`)
        .returning({ id: webhookEvents.id })
      return rows.length
    },
    { table: 'webhook_events', op: 'retention_delete' },
  )
}

/** `/status` needs "last webhook time" (spec §8.19) without scanning the table. */
export function findLatestWebhookEvent(
  exec?: Exec,
): Promise<Result<WebhookEventRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(webhookEvents)
        .orderBy(sql`${webhookEvents.received_at} desc`)
        .limit(1)
      return rows[0] as WebhookEventRow | undefined
    },
    { table: 'webhook_events', op: 'latest' },
  )
}

/** Events stuck in a failed state, for the alert in EC-WH-4 ("alert after 10/h"). */
export function countFailedSince(since: Date, exec?: Exec): Promise<Result<number, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.verified, 'FAILED'),
            sql`${webhookEvents.received_at} >= ${since.toISOString()}`,
          ),
        )
      return rows.length
    },
    { table: 'webhook_events', op: 'count_failed' },
  )
}
