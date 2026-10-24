/**
 * The pre-erasure notice — EC-PRIV-5, DPDP Rule 8(2), spec §8.19.
 *
 * §12.13 is careful about the law here: the 48-hour notice is required for **Third-Schedule classes**
 * and we are not a specified large platform, so we are not obliged to send one. We send it anyway,
 * and the reason is not compliance theatre — it is that a purge is irreversible and the subject is
 * the only person who knows whether the record is still wanted. The notice is the last moment a
 * mistake (a wrong `user_id`, a duplicated request) can be caught by the person it affects.
 *
 * Rendered, not sent. This module produces the subject and body so the demo can show the preview in
 * the UI (EC-PRIV-5's user-facing column is an "Email preview"), and so the wording is asserted in a
 * test rather than being whatever the mailer's template happened to be.
 */
import { isoDate } from './hold'
import { PRE_ERASURE_NOTICE_HOURS } from './policy'

export interface PreErasureNoticeInput {
  /** Shown in the greeting. The digest placeholder is acceptable; the notice never needs the real name. */
  readonly displayName: string
  /** When the purge will run. */
  readonly purgeAtSec: number
  /** Why it is being held, if it is. `null` means the purge proceeds on the normal timetable. */
  readonly holdReason: string | null
  /** The support contact, so the notice is actionable rather than only informational. */
  readonly supportEmail: string
}

export interface RenderedNotice {
  readonly subject: string
  readonly body: string
  /** For the scheduler: when the notice must go out for a purge at `purgeAtSec`. */
  readonly sendAtSec: number
}

export function renderPreErasureNotice(input: PreErasureNoticeInput): RenderedNotice {
  const purgeDate = isoDate(input.purgeAtSec)
  const held = input.holdReason !== null

  const subject = held
    ? `Your erasure request: we must keep this record for now (purge ${purgeDate})`
    : `Your erasure request: we will erase on ${purgeDate}`

  const reason = held
    ? `\nWe have to keep this record until then because ${input.holdReason}. The date above is the ` +
      `earliest it can run; if the reason clears sooner, the purge moves earlier and we will tell you.\n`
    : `\nNothing is holding this request. The delay is the ${PRE_ERASURE_NOTICE_HOURS}-hour notice period.\n`

  const body = `Hello ${input.displayName},

We received your request to erase your Countersign data.
${reason}
What happens now:
  - On ${purgeDate} we replace your name and email with a pseudonym and keep only a one-way hash,
    so records we are legally required to keep stay verifiable but stop identifying you.
  - Your vaulted payment method is deleted at PayPal.
  - Operational logs are kept for their own retention period and are PII-redacted at write time.

If you did not ask for this, reply to this message or write to ${input.supportEmail} before ${purgeDate} and we will cancel it.
`

  return {
    subject,
    body,
    // The notice precedes the purge by its own window; a held request's notice still goes out now, so
    // that the subject has the maximum warning available.
    sendAtSec: input.purgeAtSec - PRE_ERASURE_NOTICE_HOURS * 3_600,
  }
}
