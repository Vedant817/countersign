'use client'

/**
 * The buyer sign-in form — D-060.
 *
 * `components/credential-form.tsx` owns the transport; this file is the buyer's two fields and the buyer's
 * copy. The only buyer-specific rule is `autoComplete="current-password"` on the password, which is what
 * tells a password manager this is a sign-in rather than a new account.
 */
import { CredentialForm, FIELD_CLASS } from '@/components/credential-form'

export function BuyerLoginForm({ next }: { next: string }) {
  return (
    <CredentialForm
      action="/api/auth/buyer-login"
      fallbackNext="/agent"
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
