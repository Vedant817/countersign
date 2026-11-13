'use client'

/**
 * The sign-out control.
 *
 * A `POST` through `fetch`, not a link: a logout that any page can trigger with an `<img>` is a logout an
 * attacker can force on a merchant mid-dispute. After the server clears the cookie this does a full
 * navigation, because the page it leaves behind is rendered for a user who no longer exists.
 *
 * Where it lands is a prop, because there are two front doors now (D-060): a merchant returns to
 * `/login`, a buyer to `/buyer-login`. Sending a buyer to the merchant form would be a small lie about
 * which account this is.
 */
import { useState } from 'react'

export function SignOutButton({ to = '/login' }: { to?: string }): React.ReactElement {
  const [pending, setPending] = useState(false)

  async function signOut(): Promise<void> {
    setPending(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      window.location.assign(to)
    }
  }

  return (
    <button
      className="rounded-card border border-rule px-3 py-1 text-sm text-ink-soft"
      disabled={pending}
      onClick={signOut}
      type="button"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  )
}

/** The merchant's sign-out, named so the disputes page does not have to pass a prop it always passes. */
export function LogoutButton(): React.ReactElement {
  return <SignOutButton to="/login" />
}
