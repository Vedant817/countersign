'use client'

/**
 * The PayPal merchant ID link form.
 *
 * Submits to `/api/merchant/paypal-merchant-id` and displays success or error.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { FIELD_CLASS } from '@/components/credential-form'

export function PaypalMerchantIdForm({
  initialPaypalMerchantId,
}: {
  readonly initialPaypalMerchantId?: string | null
}) {
  const router = useRouter()
  const [value, setValue] = useState(initialPaypalMerchantId ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setSuccess(null)
    setPending(true)

    const form = new FormData(event.currentTarget)
    const rawId = form.get('paypalMerchantId')
    const paypalMerchantId =
      typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : value.trim()

    try {
      const response = await fetch('/api/merchant/paypal-merchant-id', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paypalMerchantId }),
      })
      const body = (await response.json()) as {
        ok?: boolean
        merchantId?: string
        paypalMerchantId?: string
        error?: { userMessage?: string; message: string }
      }
      if (!response.ok) {
        setError(
          body?.error?.userMessage ??
            body?.error?.message ??
            'Failed to update PayPal merchant ID.',
        )
        return
      }
      setSuccess('PayPal merchant ID linked successfully.')
      setValue(body.paypalMerchantId ?? paypalMerchantId.toUpperCase())
      router.refresh()
    } catch {
      setError('That request did not reach the server. Check your connection and try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="mt-6 flex max-w-md flex-col gap-4" onSubmit={onSubmit}>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        PayPal Merchant ID
        <input
          className={FIELD_CLASS}
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={13}
          minLength={13}
          name="paypalMerchantId"
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 2M8QY2W4P5L79"
          required
          type="text"
          value={value}
        />
        <span className="text-xs font-normal text-ink-soft">
          13-character alphanumeric identifier from PayPal account settings.
        </span>
      </label>

      {error !== null ? (
        <p
          className="rounded-card border border-blocked bg-blocked-soft p-3 text-sm text-blocked"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {success !== null ? (
        <p
          className="rounded-card border border-signed bg-signed-soft p-3 text-sm text-signed"
          role="status"
        >
          {success}
        </p>
      ) : null}

      <button
        className="rounded-card border border-ink bg-ink px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50"
        disabled={pending}
        type="submit"
      >
        {pending ? 'Saving…' : 'Save PayPal Merchant ID'}
      </button>
    </form>
  )
}
