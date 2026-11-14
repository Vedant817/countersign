/**
 * `/merchant/settings` — manage merchant profile and PayPal integration credentials.
 *
 * Server component guarded by requireMerchantPage and merchantIdFor.
 * Shows the merchant display name and the current linked PayPal merchant ID
 * (or the unlinked status notice), along with the form to link/update it.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { forbidden } from 'next/navigation'

import { getMerchantById } from '@countersign/db'

import { requireMerchantPage } from '@/lib/auth-page'
import { merchantIdFor } from '@/lib/merchant-context'
import { LogoutButton } from '@/app/disputes/logout-button'

import { PaypalMerchantIdForm } from './paypal-merchant-id-form'

export const metadata: Metadata = {
  title: 'Merchant Settings',
  description: 'Manage merchant settings and PayPal integration credentials.',
}

export const dynamic = 'force-dynamic'

export default async function MerchantSettingsPage() {
  const user = await requireMerchantPage('/merchant/settings')
  const merchantIdRes = await merchantIdFor(user)
  if (!merchantIdRes.ok) {
    if (merchantIdRes.error.code === 'CS_FORBIDDEN') {
      forbidden()
    }
    throw new Error(
      `the merchant profile could not be read: ${merchantIdRes.error.code} ${merchantIdRes.error.message}`,
    )
  }
  const merchantId = merchantIdRes.value

  const merchantRes = await getMerchantById(merchantId)
  if (!merchantRes.ok || !merchantRes.value) {
    throw new Error('the merchant profile could not be read')
  }
  const merchant = merchantRes.value

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <p className="font-mono text-xs uppercase tracking-widest text-ink-faint">
            {merchant.display_name} · {user.email}
          </p>
          <Link
            className="font-mono text-xs uppercase tracking-widest underline hover:text-ink-soft"
            href="/disputes"
          >
            Disputes
          </Link>
        </div>
        <LogoutButton />
      </div>

      <h1 className="mt-6 text-4xl font-semibold tracking-tight">Merchant Settings</h1>
      <p className="mt-4 text-lg text-ink-soft">
        Configure your merchant profile and link your PayPal merchant account so orders can be
        attributed and paid to your account.
      </p>

      <div className="mt-8 rounded-card border border-rule bg-paper-raised p-6">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-ink-soft">Business Name</dt>
            <dd className="mt-1 font-mono text-base font-semibold">{merchant.display_name}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-soft">Merchant ID</dt>
            <dd className="mt-1 font-mono text-base">{merchant.id}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-sm text-ink-soft">PayPal Merchant ID</dt>
            <dd className="mt-1 font-mono text-base">
              {merchant.paypal_merchant_id !== null && merchant.paypal_merchant_id !== '' ? (
                <span>{merchant.paypal_merchant_id}</span>
              ) : (
                <span className="text-ink-soft">
                  Not linked — orders cannot be taken until you link one
                </span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-8">
        <PaypalMerchantIdForm initialPaypalMerchantId={merchant.paypal_merchant_id} />
      </div>
    </div>
  )
}
