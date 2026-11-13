'use client'

/**
 * The shared credential form — D-059, D-060.
 *
 * ## Why one component for three forms
 *
 * The merchant sign-in, the buyer sign-in and the sign-up differ in exactly two things: where they post and
 * what the button says. Everything else is a rule that must not drift — `fetch` rather than a native post
 * (a route handler answers `CsError` JSON, and a form post would render that JSON as a page), a full
 * navigation after success rather than `router.push` (the cookie is set on that response and the target's
 * server components have to read it), and one error sentence under the fields. A copy per page is three
 * places for the second-best version to survive.
 *
 * The fields are passed in as children rather than branched on, so adding a fourth form does not add a
 * branch here.
 */
import { useState } from 'react'

export interface CredentialResponse {
  ok?: boolean
  next?: string
  error?: { userMessage?: string; message: string }
}

export function CredentialForm(props: {
  /** Where the credentials go. */
  readonly action: string
  /** The button's label, so a screen reader and a person hear what this form does. */
  readonly submitLabel: string
  /** What the button says while the request is in flight. */
  readonly pendingLabel: string
  /** Where a successful sign-in lands when the caller did not name one. */
  readonly fallbackNext: string
  /** The fields, as the form's children. */
  readonly children: React.ReactNode
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setPending(true)
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch(props.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(form.entries())),
      })
      const body = (await response.json()) as CredentialResponse
      if (!response.ok || body.ok !== true) {
        setError(body.error?.userMessage ?? 'That did not work. Try again.')
        return
      }
      // A full navigation, not `router.push`: the session cookie was set on this response, and the target
      // page's server components must read it. A client transition would render them from the old request.
      window.location.assign(body.next ?? props.fallbackNext)
    } catch {
      setError('That request did not reach the server. Check your connection and try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="mt-8 flex flex-col gap-4" onSubmit={onSubmit}>
      {props.children}
      {error === null ? null : (
        <p
          className="rounded-card border border-blocked bg-blocked-soft p-3 text-sm text-blocked"
          role="alert"
        >
          {error}
        </p>
      )}
      <button
        className="rounded-card border border-ink bg-ink px-4 py-2 text-sm font-semibold text-paper"
        disabled={pending}
        type="submit"
      >
        {pending ? props.pendingLabel : props.submitLabel}
      </button>
    </form>
  )
}

/** The one field style, so three forms cannot disagree about how an input looks. */
export const FIELD_CLASS =
  'rounded-card border border-rule bg-paper-raised px-3 py-2 font-mono text-sm'
