'use client'

/**
 * The sign-up form — D-060.
 *
 * Three fields, and the third is optional on purpose: a display name is not a credential and not an
 * identity, and demanding one before someone can spend their own money is friction with no security value.
 * The route fills it from the address when the field is left blank.
 *
 * `autoComplete="new-password"` is the one detail worth naming: it is what stops a password manager from
 * offering to fill the *existing* password for this site over the new one.
 */
import { CredentialForm, FIELD_CLASS } from '@/components/credential-form'

export function SignupForm({ next }: { next: string }) {
  return (
    <CredentialForm
      action="/api/auth/signup"
      fallbackNext="/agent"
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
        Display name <span className="text-ink-soft">(optional)</span>
        <input className={FIELD_CLASS} autoComplete="nickname" name="displayName" type="text" />
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
