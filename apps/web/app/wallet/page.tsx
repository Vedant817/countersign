/**
 * `/wallet` — buyer wallet page to view and save PayPal payment methods.
 *
 * Shows the signed-in buyer's saved PayPal payment methods and allows saving a new
 * payment method via PayPal Vault setup tokens.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { listWalletsForUser } from '@countersign/db'

import { requireBuyer } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Wallet',
  description: 'Manage your saved PayPal payment methods.',
}

interface WalletPageProps {
  readonly searchParams: Promise<{
    saved?: string | string[]
    cancelled?: string | string[]
    error?: string | string[]
    vault_error?: string | string[]
  }>
}

const VAULT_ERROR_MESSAGES: Record<string, string> = {
  missing_token: 'PayPal approval token was missing or expired. Please try again.',
  forbidden: 'Only buyer accounts can save payment methods.',
  unauthenticated: 'Please sign in to save a payment method.',
  paypal_error: 'PayPal could not save your payment method. Please try again.',
  internal: 'Something went wrong while saving your payment method. Please try again.',
}

const DEFAULT_VAULT_ERROR_MESSAGE = 'Could not save the payment method. Please try again.'

function maskToken(token: string): string {
  const last4 = token.slice(-4)
  return `••••${last4}`
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default async function WalletPage({ searchParams }: WalletPageProps) {
  const buyer = await requireBuyer()
  if (!buyer.ok) {
    redirect('/buyer-login?next=/wallet')
  }

  const walletsRes = await listWalletsForUser(buyer.value.id)
  if (!walletsRes.ok) {
    throw new Error(`Failed to load wallets: ${walletsRes.error.message}`)
  }
  const wallets = walletsRes.value

  const params = await searchParams
  const isSaved =
    params.saved === '1' || (Array.isArray(params.saved) && params.saved.includes('1'))
  const isCancelled =
    params.cancelled === '1' || (Array.isArray(params.cancelled) && params.cancelled.includes('1'))
  const hasError = Boolean(params.error)
  const vaultErrorCode =
    typeof params.vault_error === 'string'
      ? params.vault_error
      : Array.isArray(params.vault_error)
        ? params.vault_error[0]
        : undefined
  const errorMessage = vaultErrorCode
    ? (VAULT_ERROR_MESSAGES[vaultErrorCode] ?? DEFAULT_VAULT_ERROR_MESSAGE)
    : hasError
      ? DEFAULT_VAULT_ERROR_MESSAGE
      : undefined

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Wallet</h1>
        <Link
          className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
          href="/agent"
        >
          Agent chat
        </Link>
      </div>
      <p className="mt-3 text-sm text-ink-soft">
        Manage your saved PayPal payment methods for agent purchases.
      </p>

      {isSaved && (
        <p
          className="mt-6 rounded-card border border-signed bg-signed-soft p-3 text-sm text-signed"
          role="status"
        >
          PayPal payment method saved.
        </p>
      )}

      {isCancelled && (
        <p
          className="mt-6 rounded-card border border-rule bg-paper-raised p-3 text-sm text-ink-soft"
          role="status"
        >
          PayPal approval was cancelled.
        </p>
      )}

      {errorMessage && (
        <p
          className="mt-6 rounded-card border border-blocked bg-blocked-soft p-3 text-sm text-blocked"
          role="alert"
        >
          {errorMessage}
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Saved payment methods</h2>
        {wallets.length === 0 ? (
          <p className="mt-4 text-sm text-ink-soft">No saved PayPal payment method yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-rule rounded-card border border-rule bg-paper-raised">
            {wallets.map((wallet) => (
              <li key={wallet.id} className="flex flex-col gap-1 p-4 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink">
                    PayPal ({maskToken(wallet.payment_token_id)})
                  </span>
                  <span className="rounded border border-rule bg-paper px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-ink-soft">
                    {wallet.status}
                  </span>
                </div>
                {(wallet.payer_email || wallet.payer_id) && (
                  <p className="text-ink-soft">
                    {wallet.payer_email ? wallet.payer_email : wallet.payer_id}
                    {wallet.payer_email && wallet.payer_id ? ` · ${wallet.payer_id}` : ''}
                  </p>
                )}
                <p className="text-xs text-ink-faint">Added on {formatDate(wallet.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action="/api/wallet/vault/start" className="mt-8" method="post">
        <button
          className="cursor-pointer rounded-card border border-ink bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink-soft"
          type="submit"
        >
          Save a PayPal payment method
        </button>
      </form>
    </main>
  )
}
