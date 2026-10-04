/**
 * The dedupe — spec **§8.12** step 3, **§12.3 EC-WH-2** [V14].
 *
 * ## What is being deduped
 *
 * PayPal retries the same event **up to 25 times over three days**. `webhook_events.paypal_event_id` is
 * unique and the write is `INSERT … ON CONFLICT (paypal_event_id) DO NOTHING`. §8.12 step 5 then returns 200
 * unconditionally: telling PayPal "not now" only earns more retries of a delivery that is already stored.
 *
 * ## Why there is a pure function in here at all
 *
 * The interesting decisions are not the SQL; they are the questions the SQL cannot answer:
 *
 * | Question | Answer depends on |
 * |---|---|
 * | Should we verify again? | the stored row's `verified` |
 * | Should we enqueue? | whether this event has ever been verified |
 * | Is this EC-WH-4 or EC-WH-7? | `verified === 'FAILED'` vs `'PENDING'` |
 *
 * Each is a pure function of one row, so each is testable without a database, and {@link dedupeDecision}
 * returns the **actions** rather than performing them. Making it `inserted: boolean` plus a row — rather
 * than "existing row or not" — mirrors what the store can actually tell us: `ON CONFLICT DO NOTHING …
 * RETURNING` returns a row on insert and nothing on a conflict, so the adapter re-reads and the branch
 * point is `did the INSERT return a row`.
 *
 * ## The two properties the store must have
 *
 * Stated here rather than left to the adapter, because both are load-bearing and neither is obvious:
 *
 *  1. **A conflict must not modify the stored row.** Not `received_at`, not `raw`, not `verified`. The first
 *     copy is the one the case file should show and the one whose signature was checked; a retry that
 *     overwrote `raw` would replace the evidence with the 24th delivery, and a retry that cleared `verified`
 *     would send an already-decided event back through the verifier.
 *  2. **The conflict path must be able to say which happened.** A store that reported only "something is
 *     stored" could not tell a first delivery from the twenty-fourth, and §8.12 step 5's unconditional 200
 *     would hide the difference.
 */
import type { StoredEvent } from './types'

/** What the ingest path should do with a delivery, as data. */
export interface DedupeDecision {
  /** Whether this delivery inserted a new row. `false` on the conflict path. */
  readonly inserted: boolean
  /** Whether to run `verify-webhook-signature` for this delivery. */
  readonly verify: boolean
  /**
   * Whether to enqueue `wh.process` **once it is verified**.
   *
   * Never true for a row that is not `VERIFIED`, which is what makes EC-WH-7 structural: the only enqueue
   * in this package sits behind `verified === 'VERIFIED'`, so no code path can enqueue an event we have not
   * checked.
   */
  readonly enqueue: boolean
  /** Why, for the log line. Never contains the raw body. */
  readonly reason: string
  /** The row as it stands **after** this delivery: the new one, or the pre-existing one untouched. */
  readonly row: StoredEvent
}

/**
 * §8.12 steps 3–5 for one delivery.
 *
 * | Stored `verified` | verify | enqueue | Why |
 * |---|---|---|---|
 * | *inserted* (defaults to `PENDING`) | yes | yes, once verified | the normal path |
 * | `VERIFIED` | **no** | **no** | already verified and already queued; a retry is pure cost |
 * | `FAILED` | **no** | no | EC-WH-4 — re-verifying a known forgery only spends a call, and the ack is still 400 |
 * | `PENDING` | **yes** | yes, once verified | EC-WH-7 — this is the retry, arriving for free on the redelivery |
 *
 * The `PENDING` row is the interesting one. EC-WH-7 says "retry verification with backoff", and the
 * scheduled retry has a 30-second floor — but a redelivery arriving now is a better opportunity than a
 * timer, because it costs nothing extra and it is the same event. Re-verifying on it is what makes a verify
 * outage self-healing without the row needing to be actively re-driven.
 *
 * @param row the row **after** the write: the inserted one, or the pre-existing one re-read.
 * @param inserted whether the INSERT returned a row.
 */
export function dedupeDecision(row: StoredEvent, inserted: boolean): DedupeDecision {
  if (inserted) {
    return {
      inserted: true,
      verify: true,
      enqueue: true,
      reason: 'first delivery',
      row,
    }
  }
  switch (row.verified) {
    case 'VERIFIED':
      return {
        inserted: false,
        verify: false,
        enqueue: false,
        reason: `already verified (${row.paypal_event_id}); EC-WH-2 redelivery`,
        row,
      }
    case 'FAILED':
      return {
        inserted: false,
        verify: false,
        enqueue: false,
        reason: `already rejected as forged (${row.paypal_event_id}); EC-WH-4`,
        row,
      }
    case 'PENDING':
      return {
        inserted: false,
        // The retry EC-WH-7 asks for, arriving free on the redelivery.
        verify: true,
        enqueue: true,
        reason: `stored unverified (${row.paypal_event_id}); EC-WH-7 re-verifies on redelivery`,
        row,
      }
  }
}

/**
 * §8.12 step 4's payload, built from the **stored row** and never from the request body.
 *
 * `singletonKey` is `resource_id` — §8.12 step 4 verbatim, and the reason two worker instances cannot
 * process one capture concurrently (EC-IDEM-4). The payload is a pointer: the row is the source of truth,
 * and a payload that carried status or amounts would be a second copy that could disagree with it.
 */
export function processJobFor(row: StoredEvent): {
  readonly webhookEventId: StoredEvent['id']
  readonly resourceId: string
  readonly resourceType: string
  readonly eventType: string
  readonly singletonKey: string
} {
  return {
    webhookEventId: row.id,
    resourceId: row.resource_id,
    resourceType: row.resource_type,
    eventType: row.event_type,
    singletonKey: row.resource_id,
  }
}
