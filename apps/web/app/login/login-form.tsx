'use client'

/**
 * The merchant sign-in form's client half — D-059.
 *
 * The transport and the rules live in `components/credential-form.tsx`, which the buyer sign-in and the
 * sign-up share: a native form post would render a route handler's `CsError` JSON as a page, and a client
 * transition would render the destination's server components from the request that had no cookie yet. This
 * file is only the merchant's fields and the merchant's copy.
 */
import { CredentialForm, FIELD_CLASS } from '@/components/credential-form'

export function LoginForm({ next }: { next: string }) {
  return (
    <CredentialForm
      action="/api/auth/login"
      fallbackNext="/disputes"
      pendingLabel="Signing in…"
      submitLabel="Sign in"
    >
      <input name="next" type="hidden" value={next} />
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          className={FIELD_CLASS}
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
          className={FIELD_CLASS}
          autoComplete="current-password"
          name="password"
          required
          type="password"
        />
      </label>
    </CredentialForm>
  )
}
