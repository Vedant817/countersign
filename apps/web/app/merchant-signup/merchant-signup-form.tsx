'use client'

/**
 * The merchant sign-up form.
 *
 * Three fields: email, business name, and password. Submits to `/api/auth/merchant-signup`
 * and falls back to `/disputes` on success.
 */
import { CredentialForm, FIELD_CLASS } from '@/components/credential-form'

export function MerchantSignupForm({ next }: { next: string }) {
  return (
    <CredentialForm
      action="/api/auth/merchant-signup"
      fallbackNext="/disputes"
      pendingLabel="Creating the account…"
      submitLabel="Create account"
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
        Business name
        <input
          className={FIELD_CLASS}
          autoComplete="organization"
          maxLength={120}
          minLength={2}
          name="businessName"
          required
          type="text"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          className={FIELD_CLASS}
          autoComplete="new-password"
          minLength={10}
          name="password"
          required
          type="password"
        />
        <span className="text-xs text-ink-soft">At least 10 characters.</span>
      </label>
    </CredentialForm>
  )
}
