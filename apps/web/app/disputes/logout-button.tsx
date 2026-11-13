'use client'

/**
 * The sign-out control.
 *
 * A `POST` through `fetch`, not a link: a logout that any page can trigger with an `<img>` is a logout an
 * attacker can force on a merchant mid-dispute. After the server clears the cookie this does a full
 * navigation, because the page it leaves behind is rendered for a user who no longer exists.
 */
import { useState } from 'react'

export function LogoutButton(): React.ReactElement {
  const [pending, setPending] = useState(false)

  async function signOut(): Promise<void> {
    setPending(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      window.location.assign('/login')
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
