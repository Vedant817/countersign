'use client'

/**
 * The sign-in form's client half.
 *
 * It posts JSON to `/api/auth/login` rather than submitting a form, for one reason: the route is a route
 * handler whose contract is a `CsError` body, and a native form post would render that JSON as a page. The
 * form is still a real `<form>` with labels and a submit button, so it works with the keyboard and a
 * password manager; only the transport is `fetch`.
 */
import { useState } from 'react'

interface LoginResponse {
  ok?: boolean
  next?: string
  error?: { userMessage?: string; message: string }
}

export function LoginForm({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setPending(true)
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
          next,
        }),
      })
      const body = (await response.json()) as LoginResponse
      if (!response.ok || body.ok !== true) {
        setError(body.error?.userMessage ?? 'Sign in failed. Try again.')
        return
      }
      // A full navigation, not `router.push`: the session cookie was set on this response, and the target
      // page's server components must read it. A client transition would render them from the old request.
      window.location.assign(body.next ?? '/disputes')
    } catch {
      setError('The sign-in request did not reach the server. Check your connection and try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="mt-8 flex flex-col gap-4" onSubmit={onSubmit}>
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          className="rounded-card border border-rule bg-paper-raised px-3 py-2 font-mono text-sm"
          autoComplete="username"
          inputMode="email"
          name="email"
          required
          type="email"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          className="rounded-card border border-rule bg-paper-raised px-3 py-2 font-mono text-sm"
          autoComplete="current-password"
          name="password"
          required
          type="password"
        />
      </label>
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
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
